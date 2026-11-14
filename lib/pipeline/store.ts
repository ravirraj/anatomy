import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { putContentsBatch, sha256, type ContentWrite } from "../content/store.ts";
import type { Coverage, ParseResult } from "../parser/index.ts";
import {
  classifyManifestBuffer,
  MAX_NON_CODE_BYTES,
  PRIMARY_MANIFEST_NAMES,
  type NonCodeCandidate,
} from "../parser/screening.ts";
import type { Database, Json } from "../supabase/database.types.ts";

type Db = SupabaseClient<Database>;

// Each request stays well inside PostgREST's statement timeout. Chunks aren't
// one transaction, but nothing reads as complete until the final update, and a
// failure part-way marks the run failed.
const FILE_CHUNK = 1000;
const EDGE_CHUNK = 2000;
const ROLE_CHUNK = 2000;
const ROUTE_CHUNK = 2000;
const SYMBOL_CHUNK = 2000;
const MANIFEST_CHUNK = 500;
const DEPENDENCY_CHUNK = 2000;
const CONFIG_CHUNK = 2000;
const ENTRY_CHUNK = 1000;

// Contents are weightier than rows: at most these many source files, or this
// many of their bytes, in one request. Payloads travel hex-encoded on the
// wire (the client's bytea form), so 4 MiB of raw source is at most 8 MiB of
// JSON — well inside the platform's request limits, same as the row chunks
// are. A file alone can't exceed this: the parser skips anything over 1 MB.
export const CONTENT_CHUNK_FILES = 25;
export const CONTENT_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * What content storage did during the run, for the stage message and for
 * anyone measuring it. Counts, never per-file noise; no source ever appears.
 */
export type ContentStorageStats = {
  /** Files the parser indexed — every one of them was eligible for storing. */
  eligible: number;
  /** Eligible files whose content is confirmed stored (their `files` row ends `content_status = 'stored'`). */
  stored: number;
  /** Bytes sent in confirmed writes; bodies deduplicated against an earlier write of this run count once. */
  bytes: number;
  /** Writes not sent because the identical body was confirmed stored earlier this run, or collapsed within the same request. */
  deduplicated: number;
  /** Eligible files left `content_status = 'absent'`. */
  absent: number;
  /** Of the absent ones: the database refused a whole request, and a retry would store them. */
  failed: number;
  /** Of the absent ones: the bytes on disk no longer hash to the parsed identity — the file changed since the walk. */
  changed: number;
  /** Of the absent ones: unreadable at storing time. */
  unreadable: number;
};

// The skipped-file list lives in the files table; storing it twice would let
// the two disagree.
export type StoredCoverage = Omit<Coverage, "files"> & { files: Omit<Coverage["files"], "skippedFiles"> };

/**
 * Stores a parsed result, including its files' original contents.
 *
 * `contents` maps each indexed file's path to the text the walk still holds
 * for it (the candidate's `content`). It is an argument, not an assumption:
 * the bytes this stores are derived from it and hash-verified against the
 * parser's record before anything is written, so a caller that hands the
 * wrong text for a path gets that file's content refused, not a mismatched
 * row.
 */
export async function storeResult(
  db: Db,
  analysis: { id: string; organizationId: string },
  result: ParseResult,
  contents: ReadonlyMap<string, string>,
  nonCodeCandidates?: readonly NonCodeCandidate[],
): Promise<ContentStorageStats> {
  // A re-run replaces what the last run stored. Edges, roles, routes and
  // symbols cascade from files; dependencies cascade from manifests.
  const [clearedFiles, clearedManifests, clearedConfigs, clearedEntries] = await Promise.all([
    db.from("files").delete().eq("analysis_id", analysis.id),
    db.from("manifests").delete().eq("analysis_id", analysis.id),
    db.from("config_references").delete().eq("analysis_id", analysis.id),
    db.from("entry_points").delete().eq("analysis_id", analysis.id),
  ]);
  if (clearedFiles.error) throw new Error(`Clearing the previous run's files failed: ${clearedFiles.error.message}`);
  if (clearedManifests.error) throw new Error(`Clearing the previous run's manifests failed: ${clearedManifests.error.message}`);
  if (clearedConfigs.error) throw new Error(`Clearing the previous run's config references failed: ${clearedConfigs.error.message}`);
  if (clearedEntries.error) throw new Error(`Clearing the previous run's entry points failed: ${clearedEntries.error.message}`);

  // Content first, and confirmed: a file is marked stored only when its body
  // is already in file_contents. A body that fails to verify against its
  // parsed identity, or a request the database refuses, leaves the file's
  // content absent — never silently pretending.
  const rawNonCode = nonCodeCandidates ?? [];
  const validNonCode = Array.from(
    new Map(
      rawNonCode
        .filter(
          (c) =>
            PRIMARY_MANIFEST_NAMES.has(path.basename(c.path)) &&
            c.bytes <= MAX_NON_CODE_BYTES &&
            c.category === "primary_manifest",
        )
        .map((c) => [c.path, c]),
    ).values(),
  );

  const { storedHashes, stats } = await storeFileContents(db, analysis, result, contents, validNonCode);

  const parsedRows: Database["public"]["Tables"]["files"]["Insert"][] = result.files.map((f) => ({
    organization_id: analysis.organizationId,
    analysis_id: analysis.id,
    path: f.path,
    module: f.module,
    lines: f.lines,
    bytes: f.bytes,
    hash: f.hash,
    fan_in: f.fanIn,
    fan_out: f.fanOut,
    reached_by: f.reachedBy,
    exports: f.exports,
    content_status: storedHashes.has(f.hash) ? "stored" : "absent",
  }));
  const nonCodeRows: Database["public"]["Tables"]["files"]["Insert"][] = validNonCode.map((c) => ({
    organization_id: analysis.organizationId,
    analysis_id: analysis.id,
    path: c.path,
    module: c.module,
    lines: c.lines,
    bytes: c.bytes,
    hash: c.hash,
    fan_in: 0,
    fan_out: 0,
    reached_by: null,
    exports: [],
    content_status: storedHashes.has(c.hash) ? "stored" : "absent",
  }));
  const allFileRows = [...parsedRows, ...nonCodeRows];
  for (let i = 0; i < allFileRows.length; i += FILE_CHUNK) {
    const { error } = await db.from("files").insert(allFileRows.slice(i, i + FILE_CHUNK));
    if (error) throw new Error(`Storing files failed: ${error.message}`);
  }

  const skippedRows: Database["public"]["Tables"]["files"]["Insert"][] = result.coverage.files.skippedFiles.map((f) => ({
    organization_id: analysis.organizationId,
    analysis_id: analysis.id,
    path: f.path,
    skip_reason: f.reason,
    skip_detail: f.detail,
  }));
  for (let i = 0; i < skippedRows.length; i += FILE_CHUNK) {
    const { error } = await db.from("files").insert(skippedRows.slice(i, i + FILE_CHUNK));
    if (error) throw new Error(`Storing skipped files failed: ${error.message}`);
  }

  // Ends are matched to stored files by path in the database, which refuses
  // the whole chunk if any edge doesn't match.
  const edges = result.edges.map((e) => ({
    source: e.source,
    target: e.target,
    kind: e.kind,
    specifier: e.specifier,
    type_only: e.typeOnly,
    line: e.line,
  }));
  for (let i = 0; i < edges.length; i += EDGE_CHUNK) {
    const { error } = await db.rpc("insert_edges", { p_analysis_id: analysis.id, p_edges: edges.slice(i, i + EDGE_CHUNK) });
    if (error) throw new Error(`Storing edges failed: ${error.message}`);
  }

  // Roles and routes go with their files too, and are matched to them by path the same way.
  const roles = result.files.flatMap((f) => (f.role === null ? [] : [{ path: f.path, role: f.role }]));
  for (let i = 0; i < roles.length; i += ROLE_CHUNK) {
    const { error } = await db.rpc("insert_file_roles", { p_analysis_id: analysis.id, p_roles: roles.slice(i, i + ROLE_CHUNK) });
    if (error) throw new Error(`Storing roles failed: ${error.message}`);
  }
  for (let i = 0; i < result.routes.length; i += ROUTE_CHUNK) {
    const { error } = await db.rpc("insert_routes", { p_analysis_id: analysis.id, p_routes: result.routes.slice(i, i + ROUTE_CHUNK) });
    if (error) throw new Error(`Storing routes failed: ${error.message}`);
  }
  for (let i = 0; i < result.symbols.length; i += SYMBOL_CHUNK) {
    const { error } = await db.rpc("insert_symbols", { p_analysis_id: analysis.id, p_symbols: result.symbols.slice(i, i + SYMBOL_CHUNK) });
    if (error) throw new Error(`Storing symbols failed: ${error.message}`);
  }

  // Phase 4: manifests first, because dependencies reference them by path;
  // then the two tables that resolve against stored files.
  const uniqueManifests = Array.from(new Map(result.manifests.map((m) => [m.path, m])).values());
  for (let i = 0; i < uniqueManifests.length; i += MANIFEST_CHUNK) {
    const { error } = await db.rpc("insert_manifests", { p_analysis_id: analysis.id, p_manifests: uniqueManifests.slice(i, i + MANIFEST_CHUNK) });
    if (error) throw new Error(`Storing manifests failed: ${error.message}`);
  }
  const dependencies = result.dependencies.map((d) => ({
    manifest: d.manifest,
    dir: d.dir,
    name: d.name,
    version: d.version,
    kind: d.kind,
    imported_by: d.importedBy,
  }));
  for (let i = 0; i < dependencies.length; i += DEPENDENCY_CHUNK) {
    const { error } = await db.rpc("insert_dependencies", { p_analysis_id: analysis.id, p_dependencies: dependencies.slice(i, i + DEPENDENCY_CHUNK) });
    if (error) throw new Error(`Storing dependencies failed: ${error.message}`);
  }
  for (let i = 0; i < result.configReferences.length; i += CONFIG_CHUNK) {
    const { error } = await db.rpc("insert_config_references", { p_analysis_id: analysis.id, p_references: result.configReferences.slice(i, i + CONFIG_CHUNK) });
    if (error) throw new Error(`Storing configuration references failed: ${error.message}`);
  }
  const entryPoints = result.entryPoints.map((e) => ({
    path: e.path,
    kind: e.kind,
    source: e.source,
    manifest: e.manifest,
    detail: e.detail ?? null,
    resolved: e.resolved,
    unresolved_reason: e.unresolvedReason ?? null,
    via: e.via ?? [],
  }));
  for (let i = 0; i < entryPoints.length; i += ENTRY_CHUNK) {
    const { error } = await db.rpc("insert_entry_points", { p_analysis_id: analysis.id, p_entries: entryPoints.slice(i, i + ENTRY_CHUNK) });
    if (error) throw new Error(`Storing entry points failed: ${error.message}`);
  }

  return stats;
}

/**
 * Turns each indexed file's already-held text back into bytes and verifies
 * the result against the parser's hash — never assuming the text is the
 * bytes. `Buffer.from(content, 'utf8')` is the inverse of the walk's
 * `buffer.toString('utf8')` only for valid UTF-8, so the round trip is
 * *verified*: a body whose hash disagrees with the walk's is re-read once
 * from the workdir (still on disk at this stage) and verified again; if even
 * the fresh bytes disagree, the file changed under the run and nothing is
 * written under the stale identity. Candidates' contents are referenced, not
 * copied, so beyond the request's own chunk this adds no memory.
 */
async function storeFileContents(
  db: Db,
  analysis: { id: string; organizationId: string },
  result: ParseResult,
  contents: ReadonlyMap<string, string>,
  nonCode: readonly NonCodeCandidate[] = [],
): Promise<{ storedHashes: Set<string>; stats: ContentStorageStats }> {
  const stats: ContentStorageStats = {
    eligible: result.files.length + nonCode.length,
    stored: 0,
    bytes: 0,
    deduplicated: 0,
    absent: 0,
    failed: 0,
    changed: 0,
    unreadable: 0,
  };
  const storedHashes = new Set<string>();
  // Bodies confirmed by a request that succeeded; anything matching is never
  // sent again, and a failed request's hashes are not here, so a later chunk
  // offers its copies again — the run retries its own tail for free.
  const sent = new Set<string>();

  type Prepared = { contentHash: string; body: Uint8Array };
  let chunk: Prepared[] = [];
  let chunkBytes = 0;

  const flush = async (): Promise<void> => {
    if (chunk.length === 0) return;
    const offered: ContentWrite[] = [];
    const indexOfRequest = new Map<string, number>();
    for (const { contentHash, body } of chunk) {
      if (sent.has(contentHash)) {
        stats.deduplicated++;
        continue;
      }
      const at = indexOfRequest.get(contentHash);
      if (at === undefined) {
        indexOfRequest.set(contentHash, offered.length);
        offered.push({ body });
      } else {
        stats.deduplicated++;
      }
    }
    let refused: string | null = null;
    if (offered.length > 0) {
      const outcomes = await putContentsBatch(db, analysis.organizationId, offered);
      for (const outcome of outcomes) {
        if (outcome.stored) {
          sent.add(outcome.contentHash);
          storedHashes.add(outcome.contentHash);
          stats.bytes += outcome.size;
        } else {
          refused = outcome.reason;
        }
      }
    }
    if (refused) {
      stats.failed += chunk.length;
      console.warn(`${analysis.id}: storing content failed (${refused}); ${chunk.length} file(s) left with their content absent`);
    }
    chunk = [];
    chunkBytes = 0;
  };

  for (const file of result.files) {
    if (chunk.length >= CONTENT_CHUNK_FILES || chunkBytes + file.bytes > CONTENT_CHUNK_BYTES) await flush();
    const text = contents.get(file.path);
    if (text === undefined) {
      stats.failed++;
      console.warn(`${analysis.id}: no held content arrived for ${file.path}; its content stays absent`);
      continue;
    }
    // The identity must be the exact bytes on offer: verify the text's UTF-8
    // form against the hash the walk computed over the raw bytes, and never
    // write under an identity the body does not hash to. No normalization happens.
    let body = Buffer.from(text, "utf8");
    if (sha256(body) !== file.hash) {
      // The text was not the round trip of the bytes (the file has bytes
      // UTF-8 cannot express): the exact original bytes are on the workdir.
      try {
        body = readFileSync(path.join(result.root, file.path));
      } catch (error) {
        stats.unreadable++;
        console.warn(`${analysis.id}: reading ${file.path} to store its content failed (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      if (sha256(body) !== file.hash) {
        stats.changed++;
        console.warn(`${analysis.id}: ${file.path} changed between the walk and the store; its content stays absent`);
        continue;
      }
    }
    chunk.push({ contentHash: file.hash, body });
    chunkBytes += body.byteLength;
  }
  for (const file of nonCode) {
    if (chunk.length >= CONTENT_CHUNK_FILES || chunkBytes + file.bytes > CONTENT_CHUNK_BYTES) await flush();
    const text = contents.get(file.path) ?? file.content;
    if (text === undefined) {
      stats.failed++;
      console.warn(`${analysis.id}: no held content arrived for ${file.path}; its content stays absent`);
      continue;
    }
    let body = Buffer.from(text, "utf8");
    if (sha256(body) !== file.hash) {
      try {
        body = readFileSync(path.join(result.root, file.path));
      } catch (error) {
        stats.unreadable++;
        console.warn(`${analysis.id}: reading ${file.path} to store its content failed (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      if (sha256(body) !== file.hash) {
        stats.changed++;
        console.warn(`${analysis.id}: ${file.path} changed between the walk and the store; its content stays absent`);
        continue;
      }
    }
    const screening = classifyManifestBuffer(body, file.path);
    if (screening.status !== "eligible") {
      stats.failed++;
      console.warn(`${analysis.id}: manifest ${file.path} failed defense screening before storage; its content stays absent`);
      continue;
    }
    chunk.push({ contentHash: file.hash, body });
    chunkBytes += body.byteLength;
  }
  if (chunk.length > 0) await flush();

  stats.stored = stats.eligible - stats.failed - stats.changed - stats.unreadable;
  stats.absent = stats.failed + stats.changed + stats.unreadable;
  return { storedHashes, stats };
}

export function storedCoverage(coverage: Coverage): Json {
  const { found, parsed, skipped, excludedDirectories } = coverage.files;
  const stored: StoredCoverage = { ...coverage, files: { found, parsed, skipped, excludedDirectories } };
  return stored;
}
