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

// Safe retention pruning for the answer cache (ai_cache).
//
// The answer cache grows without bound: prompt-version bumps, model repins
// and source re-analysis re-key everything, leaving dead rows forever. The
// policy (migration 20261109000000) is expiration plus a per-organization
// row cap, enforced database-side by the service-role-only prune_ai_cache
// function.
//
// Cleanup eligibility ONLY: an expiring entry or a cap eviction is never
// evidence validity. Every cache read is verified against the current
// evidence before serving, unchanged; pruning can only cost a regeneration,
// never a stale answer. Ordinary cache reads never write to the table (the
// members' client holds a select-only grant), and there is deliberately no
// per-hit LRU tracking - reads stay read-only.

/** Default retention age before an answer-cache row is cleanup-eligible. */
export const DEFAULT_ANSWER_RETENTION_DAYS = 90;

/** Default batch size for bounded pruning (rows deleted per batch). */
export const DEFAULT_ANSWER_BATCH_SIZE = 500;

/** Default maximum total deletions per pruning invocation. */
export const DEFAULT_ANSWER_MAX_DELETIONS = 5_000;

/** Default maximum rows held per organization before oldest-first eviction. */
export const DEFAULT_ANSWER_CAP_ROWS_PER_ORG = 25_000;

export type AnswerGcOptions = {
  /**
   * Scope to a specific organization. Normal application invocations must
   * always pass an explicit scope; null runs across all organizations and
   * is meant for service-role operators only.
   */
  organizationId?: string | null;

  /** Rows deleted per batch. Default: 500. */
  batchSize?: number;

  /**
   * Maximum total deletions for the invocation. The database function
   * stops early once the budget is spent, so one request can never run an
   * unbounded cleanup loop. Default: 5,000.
   */
  maxDeletions?: number;

  /**
   * Per-organization row cap enforced while pruning, oldest-by-creation
   * evicted first, and only after expired rows are gone. Default: 25,000.
   * The cap is a pruning target, not an instantaneous bound: ordinary
   * inserts never lock or check it and may temporarily exceed it; the next
   * pruning invocation converges the organization back to the cap.
   */
  capRowsPerOrg?: number;

  /**
   * If true, counts eligible rows without deleting anything.
   * Superseded if execute: false.
   */
  dryRun?: boolean;

  /**
   * Explicit confirmation required to perform destructive deletions.
   * Must be explicitly set to `true` to delete data.
   * Default: false (dry-run).
   */
  execute?: boolean;
};

export type AnswerGcStats = {
  /** Scope the run was made under (null = all organizations). */
  organizationId: string | null;
  /** Rows in scope evaluated: deleted rows when active, counted rows when dry. */
  rowsExamined: number;
  /** Rows whose retention age has passed (cleanup-eligible by expires_at). */
  expiredRowsEligible: number;
  /**
   * Rows beyond the per-organization cap in scope. Always exact for an
   * organization-scoped dry run; null for an all-organizations dry run,
   * where the cap can only be judged per organization.
   */
  overCapRowsEligible: number | null;
  /** Deleted expired rows. Active runs only; always 0 in a dry run. */
  expiredRowsDeleted: number;
  /** Deleted top-oldest rows from over-cap organizations. Active runs only. */
  capEvictedRowsDeleted: number;
  /**
   * Exact bytes of deleted answer bodies (postgres octet_length summed over
   * deleted rows). Body bytes only - no estimated row overhead is ever
   * reported. Always 0 in a dry run because nothing was measured dead.
   */
  bodyBytesDeleted: number;
  /** Whether the operation was a dry run (no rows deleted). */
  dryRun: boolean;
  /** Errors encountered during execution, if any. */
  errors: string[];
};

/**
 * Prunes expired answers and enforces the per-organization row cap on
 * ai_cache, mirroring garbageCollectOrphanedContent's safety conventions.
 *
 * Safety guarantees:
 * - Bounded: the database function deletes at most `maxDeletions` rows per
 *   invocation in `batchSize`-sized batches, expired rows first, and caps
 *   each organization at `capRowsPerOrg` (oldest evicted first, never while
 *   at or under the cap). Callers that want to continue may invoke again.
 * - Concurrency-safe: per-organization pruning is serialized by a
 *   transaction-scoped advisory lock, so concurrent runs never double-count
 *   the cap; cache writers never block and keep the documented
 *   first-writer-wins insert semantics.
 * - Correctness-neutral: pruning changes cleanup eligibility only. Serving
 *   verifies every cache hit against current evidence regardless of
 *   freshness or retention state.
 * - Org-isolated: an organization-scoped run can never touch another
 *   organization's rows.
 */
export async function garbageCollectExpiredAnswers(
  db: Db,
  options: AnswerGcOptions = {},
): Promise<AnswerGcStats> {
  const {
    organizationId = null,
    batchSize = DEFAULT_ANSWER_BATCH_SIZE,
    maxDeletions = DEFAULT_ANSWER_MAX_DELETIONS,
    capRowsPerOrg = DEFAULT_ANSWER_CAP_ROWS_PER_ORG,
    dryRun: requestedDryRun = false,
    execute = false,
  } = options;

  // Actual deletion requires execute === true AND dryRun !== true, exactly
  // like the orphaned-content GC.
  const isDryRun = requestedDryRun || !execute;

  const stats: AnswerGcStats = {
    organizationId,
    rowsExamined: 0,
    expiredRowsEligible: 0,
    overCapRowsEligible: null,
    expiredRowsDeleted: 0,
    capEvictedRowsDeleted: 0,
    bodyBytesDeleted: 0,
    dryRun: isDryRun,
    errors: [],
  };

  if (isDryRun) {
    try {
      const nowIso = new Date().toISOString();

      // Rows whose retention age has passed, in scope.
      let expiredQuery = db.from("ai_cache").select("key", { count: "exact", head: true }).lt("expires_at", nowIso);
      if (organizationId) {
        expiredQuery = expiredQuery.eq("organization_id", organizationId);
      }
      const { count: expiredCount, error: expiredError } = await expiredQuery;

      if (expiredError) {
        stats.errors.push(`Failed to count expired rows: ${expiredError.message}`);
        return stats;
      }

      // Total rows in scope, to judge the cap against.
      let scopedQuery = db.from("ai_cache").select("key", { count: "exact", head: true });
      if (organizationId) {
        scopedQuery = scopedQuery.eq("organization_id", organizationId);
      }
      const { count: scopedCount, error: scopedError } = await scopedQuery;

      if (scopedError) {
        stats.errors.push(`Failed to count rows in scope: ${scopedError.message}`);
        return stats;
      }

      stats.rowsExamined = scopedCount ?? 0;
      stats.expiredRowsEligible = expiredCount ?? 0;

      if (organizationId) {
        // The cap is per organization, so an organization-scoped count
        // yields an exact over-cap figure. A global dry run leaves it
        // null rather than guessing.
        stats.overCapRowsEligible = Math.max(0, (scopedCount ?? 0) - capRowsPerOrg);
      }

      return stats;
    } catch (err) {
      stats.errors.push(`Dry-run execution failed: ${err instanceof Error ? err.message : String(err)}`);
      return stats;
    }
  }

  // Active mode: one bounded call into the database pruner. The function
  // loops batch by batch inside its own transaction under the per-org
  // advisory lock, spending at most p_max_deletions, so the client adds no
  // loop of its own: more work is one more invocation, possibly with a
  // larger budget, never an unbounded request.
  try {
    const { data, error: rpcError } = await db.rpc("prune_ai_cache", {
      p_organization_id: organizationId ?? undefined,
      p_batch_size: batchSize,
      p_max_deletions: maxDeletions,
      p_cap_rows: capRowsPerOrg,
    });

    if (rpcError) {
      stats.errors.push(`Prune RPC failed: ${rpcError.message}`);
      return stats;
    }

    for (const row of data ?? []) {
      const expired = row.expired_rows_deleted ?? 0;
      const capEvicted = row.cap_evicted_rows_deleted ?? 0;
      stats.expiredRowsDeleted += expired;
      stats.capEvictedRowsDeleted += capEvicted;
      stats.bodyBytesDeleted += Number(row.body_bytes_deleted ?? 0);
    }

    stats.rowsExamined = stats.expiredRowsDeleted + stats.capEvictedRowsDeleted;
    stats.expiredRowsEligible = stats.expiredRowsDeleted;
    stats.overCapRowsEligible = stats.capEvictedRowsDeleted;

    return stats;
  } catch (err) {
    stats.errors.push(`Prune execution failed: ${err instanceof Error ? err.message : String(err)}`);
    return stats;
  }
}
