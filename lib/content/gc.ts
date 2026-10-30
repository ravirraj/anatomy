// Safe garbage collection for unreferenced file_contents rows.
//
// Content rows are written before files metadata and across chunked requests;
// therefore, unreferenced content can legitimately be in-flight indexing data.
// Safety rules:
// 1. Only content older than a configurable grace period (default: 24h) is eligible.
// 2. References are re-checked inside an atomic SQL operation with row locking.
// 3. Batches are bounded (default: 500 rows per batch, max 10 batches per invocation).
// 4. Scoped by organization or system-wide for service role.
// 5. Destructive execution requires explicit `execute: true` confirmation; defaults to dry-run.
// 6. Evicts invalidated items from the process cache.

import { getContentCache, type ContentCache } from "./cache.ts";
import type { Db } from "./types.ts";

/** Default grace period: 24 hours in milliseconds. */
export const DEFAULT_GC_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

/** Default batch size for bounded deletion. */
export const DEFAULT_GC_BATCH_SIZE = 500;

/** Default maximum number of batches to run per GC invocation. */
export const DEFAULT_GC_MAX_BATCHES = 10;

export type GcOptions = {
  /**
   * Scope to a specific organization. If omitted/null, runs across all
   * organizations (requires service role).
   */
  organizationId?: string | null;

  /**
   * Minimum age of content before it is eligible for collection.
   * Content newer than this is assumed to be potential in-flight indexing data.
   * Default: 24 hours.
   */
  gracePeriodMs?: number;

  /**
   * Number of rows to evaluate and delete per database batch.
   * Default: 500.
   */
  batchSize?: number;

  /**
   * Maximum number of batches to execute in one run.
   * Prevents long-running runaway execution. Default: 10.
   */
  maxBatches?: number;

  /**
   * If true, scans and counts eligible rows without deleting them.
   * Superceded if execute: false.
   */
  dryRun?: boolean;

  /**
   * Explicit confirmation required to perform destructive deletions.
   * Must be explicitly set to `true` to delete data.
   * Default: false (dry-run).
   */
  execute?: boolean;

  /**
   * In-process cache to invalidate when rows are deleted.
   * Defaults to the singleton cache.
   */
  cache?: ContentCache | null;
};

export type GcStats = {
  /** Total content rows inspected / evaluated across all batches. */
  rowsExamined: number;
  /** Rows eligible for collection (older than grace period with zero references). */
  rowsEligible: number;
  /** Rows permanently deleted from the database. */
  rowsDeleted: number;
  /** Total bytes reclaimed from deleted content payloads. */
  bytesReclaimed: number;
  /** Rows skipped because a live reference exists. */
  rowsSkippedReferenced: number;
  /** Number of batches processed. */
  batchesProcessed: number;
  /** Whether the operation was a dry run (no rows deleted). */
  dryRun: boolean;
  /** Errors encountered during execution, if any. */
  errors: string[];
};

/** Convert milliseconds to a Postgres interval string. */
function msToInterval(ms: number): string {
  const safeMs = Math.max(1, Math.floor(ms));
  if (safeMs % 1000 === 0) {
    return `${safeMs / 1000} seconds`;
  }
  return `${safeMs} milliseconds`;
}

/**
 * Runs garbage collection of orphaned file contents.
 *
 * Safety guarantees:
 * - Operates in bounded batches to avoid exhausting memory or database locks.
 * - Enforces a grace period to protect active indexing operations.
 * - Database-side atomic check-and-delete prevents the indexing-vs-GC race condition.
 * - Idempotent and safe to retry on failure.
 * - Invalidates affected entries in the process-local cache.
 */
export async function garbageCollectOrphanedContent(
  db: Db,
  options: GcOptions = {},
): Promise<GcStats> {
  const {
    organizationId = null,
    gracePeriodMs = DEFAULT_GC_GRACE_PERIOD_MS,
    batchSize = DEFAULT_GC_BATCH_SIZE,
    maxBatches = DEFAULT_GC_MAX_BATCHES,
    dryRun: requestedDryRun = false,
    execute = false,
    cache = getContentCache(),
  } = options;

  // Actual deletion requires execute === true AND dryRun !== true
  const isDryRun = requestedDryRun || !execute;

  const stats: GcStats = {
    rowsExamined: 0,
    rowsEligible: 0,
    rowsDeleted: 0,
    bytesReclaimed: 0,
    rowsSkippedReferenced: 0,
    batchesProcessed: 0,
    dryRun: isDryRun,
    errors: [],
  };

  const graceInterval = msToInterval(gracePeriodMs);
  const cutoffDate = new Date(Date.now() - gracePeriodMs).toISOString();

  // If dry-run mode, query candidates without deleting
  if (isDryRun) {
    try {
      // Find eligible candidates older than grace period that lack file references
      let query = db
        .from("file_contents")
        .select("organization_id, content_hash, size, created_at")
        .lt("created_at", cutoffDate);

      if (organizationId) {
        query = query.eq("organization_id", organizationId);
      }

      // Order by created_at and limit to total evaluation budget (batchSize * maxBatches)
      const maxRowsToInspect = batchSize * maxBatches;
      const { data: candidates, error: candidateError } = await query
        .order("created_at", { ascending: true })
        .limit(maxRowsToInspect);

      if (candidateError) {
        stats.errors.push(`Failed to inspect candidates: ${candidateError.message}`);
        return stats;
      }

      if (!candidates || candidates.length === 0) {
        return stats;
      }

      stats.rowsExamined = candidates.length;
      stats.batchesProcessed = 1;

      // For each candidate, check if any files row references it
      for (const candidate of candidates) {
        const { count, error: refError } = await db
          .from("files")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", candidate.organization_id)
          .eq("hash", candidate.content_hash);

        if (refError) {
          stats.errors.push(`Failed to check reference for ${candidate.content_hash}: ${refError.message}`);
          continue;
        }

        if (count === 0 || count === null) {
          stats.rowsEligible++;
          stats.bytesReclaimed += candidate.size;
        } else {
          stats.rowsSkippedReferenced++;
        }
      }

      return stats;
    } catch (err) {
      stats.errors.push(`Dry-run execution failed: ${err instanceof Error ? err.message : String(err)}`);
      return stats;
    }
  }

  // Active deletion mode: invoke the atomic database RPC in batches
  for (let batch = 0; batch < maxBatches; batch++) {
    try {
      const { data: deletedRows, error: rpcError } = await db.rpc(
        "delete_orphaned_file_contents",
        {
          p_organization_id: organizationId ?? undefined,
          p_grace_period: graceInterval,
          p_batch_size: batchSize,
        },
      );

      if (rpcError) {
        stats.errors.push(`Batch ${batch + 1} RPC failed: ${rpcError.message}`);
        break;
      }

      stats.batchesProcessed++;

      if (!deletedRows || deletedRows.length === 0) {
        // No more eligible orphans to collect
        break;
      }

      stats.rowsDeleted += deletedRows.length;
      stats.rowsEligible += deletedRows.length;
      stats.rowsExamined += deletedRows.length;

      for (const row of deletedRows) {
        stats.bytesReclaimed += Number(row.size);
        // Invalidate in-process cache for this deleted content
        if (cache) {
          cache.delete(row.organization_id, row.content_hash);
        }
      }

      // If fewer rows returned than batchSize, we reached the end of orphans
      if (deletedRows.length < batchSize) {
        break;
      }
    } catch (err) {
      stats.errors.push(`Batch ${batch + 1} execution failed: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  return stats;
}
