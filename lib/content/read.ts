// Reads source-file contents through a live `files` row, so file identity,
// organization isolation and content integrity are checked in one place —
// never from an id or organization a caller just asserted.
//
// A read goes: file row (the caller's own policies filter it) → its hash and
// content_status → the immutable content row by (organization, hash),
// verified hash-and-size before anything is served. A file whose content is
// `absent` is fetched back from GitHub at the commit that was analysed,
// hash-verified against the parsed identity, stored through the same
// immutable store the pipeline writes with, and only then marked `stored` —
// the lazy backfill TODO §3.4 describes. This module imports no Next.js and
// no Clerk, so a script can drive it like lib/content/store.ts can; the
// caller chooses the client and thereby the policies.

import { countLines } from "../parser/walk.ts";
import { fetchFileAt, type Repository } from "../pipeline/github.ts";
import { createAdminSupabase } from "../supabase/admin.ts";
import { cachedGetContent, getContentCache, type ContentCache } from "./cache.ts";
import { ConsistencyError, type Db } from "./types.ts";
import { existsContent, getContent, putContents, sha256 } from "./store.ts";

export { ConsistencyError, IntegrityError } from "./types.ts";

/**
 * The read service's dependencies. Members have no write grant on
 * `files` or `file_contents`, so a backfill's writes go through the
 * pipeline's writer; the read client stays the caller's own so its policies
 * hold. `fetchFile` is injectable for tests; production uses the
 * commit-pinned GitHub fetch every other consumer already uses.
 */
export type BackfillDeps = {
  /** The writer client for content and metadata; defaults to the admin client. */
  writer?: Db;
  /** One file's bytes at one commit; defaults to the pipeline's fetch. */
  fetchFile?: typeof fetchFileAt;
  /** Optional content cache; defaults to the process-wide singleton. Pass null to bypass. */
  cache?: ContentCache | null;
};

/**
 * The whole source of one file, verified. `text` is the file's decoded
 * source text — the exact bytes the parser read, nothing normalized. The
 * `lineCount` is the parser's own convention (`files.lines`), never a new
 * one.
 */
export type FileSource = {
  fileId: string;
  path: string;
  /** sha256 of the bytes, the same value the files row and the content row hold. */
  contentHash: string;
  text: string;
  lineCount: number;
};

/** One row of files, as the read needs it, with its analysis and project resolved to the analysed commit's repository. */
type FileRecord = {
  id: string;
  path: string;
  hash: string | null;
  content_status: string;
  organization_id: string;
  lines: number | null;
  analysis: {
    commit_sha: string | null;
    project: { repo_owner: string; repo_name: string } | null;
  } | null;
};

/**
 * The file's record, under the caller's policies: another organization's
 * file simply isn't there, and nothing undertakes to read it. The record
 * carries the analysed commit and the repository it lives in, for the
 * backfill — with both in hand, content is fetchable from exactly the
 * checkout this analysis parsed, never from a branch someone points at.
 */
async function resolveFile(db: Db, fileId: string): Promise<FileRecord | null> {
  const { data, error } = await db
    .from("files")
    .select(
      "id, path, hash, lines, content_status, organization_id, analysis:analyses(commit_sha, project:projects(repo_owner, repo_name))",
    )
    .eq("id", fileId)
    .maybeSingle();
  if (error) throw new Error(`Reading the file failed: ${error.message}`);
  return data ?? null;
}

/**
 * Everything both read functions share, including the backfill. Returns null
 * when there is genuinely no content to serve — a file that isn't in the
 * caller's organization, a file the parser skipped (no hash), a path that
 * GitHub doesn't have at the analysed commit, or (never silently, see
 * below) null when the row's own identity moved while this was working.
 */
async function loadSource(db: Db, fileId: string, deps: BackfillDeps): Promise<FileSource | null> {
  const file = await resolveFile(db, fileId);
  if (!file) return null;
  // The parser sets hash only on files it indexed (an indexed file is
  // exactly a storeable one); skipped rows carry no hash and no content.
  const { hash } = file;
  if (hash === null) return null;

  const text = await sourceOfCheckedRows(db, { ...file, hash }, deps);
  if (text === null) return null;
  // The decode is the parser's own (bytes → utf8), so line N here is the
  // line N the parser recorded, without inventing a second convention.
  return {
    fileId,
    path: file.path,
    contentHash: hash,
    text,
    lineCount: countLines(text),
  };
}

/**
 * The bytes of `file`'s parsed source as a utf8 string. A `stored` claim is
 * checked against the content table — it is a promise, not proof — and an
 * `absent` one goes to the verified backfill.
 */
async function sourceOfCheckedRows(db: Db, file: FileRecord & { hash: string }, deps: BackfillDeps): Promise<string | null> {
  if (file.content_status === "stored") {
    // The store verifies the row itself — hash against the identity, length
    // against the row's own record — and throws rather than serve damaged
    // bytes. A stored claim with no row behind it is a database that
    // contradicts itself: reported, never smoothed into a null.
    const bytes = await getCachedOrDb(db, file.organization_id, file.hash, deps);
    if (bytes === null) {
      throw new ConsistencyError(
        `${file.path} claims its content is stored, but the content table holds nothing under ${file.hash}`,
      );
    }
    return bytesToText(bytes);
  }
  if (file.content_status !== "absent") {
    throw new ConsistencyError(
      `content_status of ${file.path} is ${JSON.stringify(file.content_status)}, which the schema does not define`,
    );
  }

  // An `absent` claim, too, is not proof of absence: a backfill that wrote
  // content but died before its metadata update leaves exactly this state,
  // and a concurrent backfill may have landed between our read and now.
  // The content table, not the status, is the record.
  const bytes = await getContent(db, file.organization_id, file.hash);
  if (bytes !== null) {
    // Content is there and verified; the status is bookkeeping. A failure
    // of bookkeeping would not make the read worse, so a failed update is
    // warned about — the next read flips it again — never a reason to
    // reject what was already verified.
    const outcome = await flagStored(deps, { id: file.id, organizationId: file.organization_id, hash: file.hash });
    if (outcome.state === "stale" || outcome.state === "vanished") return null;
    if (deps.cache !== null) {
      (deps.cache ?? fromCacheSingleton()).set(file.organization_id, file.hash, bytes);
    }
    return bytesToText(bytes);
  }
  return backfillFromGitHub(db, file, deps);
}

/**
 * The verified backfill: the file's own bytes, fetched from GitHub at
 * exactly the commit this analysis parsed (never a branch, never HEAD),
 * refused unless they hash to the parsed identity, stored through the
 * immutable store, the store's write confirmed, and the files row marked
 * `stored` only if it is still the row this content belongs to. Nothing in
 * this flow writes before verifying, and nothing is written twice.
 */
async function backfillFromGitHub(db: Db, file: FileRecord & { hash: string }, deps: BackfillDeps): Promise<string | null> {
  const project = file.analysis?.project ?? null;
  const commitSha = file.analysis?.commit_sha ?? null;
  // Without the analysed commit there is nothing verified to fetch from:
  // falling back to a branch would serve code that was never parsed.
  if (project === null || commitSha === null) return null;
  const repository: Repository = { owner: project.repo_owner, name: project.repo_name };

  const bytes = await fetchFor(deps)(repository, commitSha, file.path);
  if (bytes === null) return null; // not at the analysed commit — genuinely unavailable content
  const bytesHash = sha256(bytes);
  if (bytesHash !== file.hash) {
    throw new ConsistencyError(
      `GitHub's copy of ${file.path} at ${commitSha.slice(0, 7)} hashes to ${bytesHash}, not to the parsed ${file.hash}`,
    );
  }

  await putContents(writerFor(deps), file.organization_id, bytes);
  if (!(await existsContent(writerFor(deps), file.organization_id, file.hash))) {
    throw new Error(`putContents reported success but ${file.hash}'s content row is not there`);
  }

  const outcome = await flagStored(deps, { id: file.id, organizationId: file.organization_id, hash: file.hash });
  switch (outcome.state) {
    case "done":
    case "failed":
      // "failed": bookkeeping did not go through; the content did. The text
      // is verified either way, and the next read re-tries the flip.
      if (deps.cache !== null) {
        (deps.cache ?? fromCacheSingleton()).set(file.organization_id, file.hash, bytes);
      }
      return bytesToText(bytes);
    case "stale":
    case "vanished":
      // The row is no longer the one this content belongs to (a re-index
      // replaced it mid-read, or the id died). Its bytes stay in the
      // content-addressed table — harmless, GC's business later — but
      // serving them would answer with code of a previous identity.
      return null;
  }
}

// ---- the conditional metadata update ----

type FlagOutcome = { state: "done" | "failed" | "stale" | "vanished" };

/**
 * Marks the row stored, but only while the row still says what it said when
 * the content was resolved — same id, same hash, still `absent` — so a
 * re-index that replaced the row mid-backfill is never stamped by it. Two
 * losers of that race are still both true writes: the metadata update is
 * idempotent and re-entrant, and the re-check below tells "another worker
 * already marked it", which is fine, from "the identity moved", which is
 * not.
 */
async function flagStored(deps: BackfillDeps, file: { id: string; organizationId: string; hash: string }): Promise<FlagOutcome> {
  const { data: flipped, error } = await writerFor(deps)
    .from("files")
    .update({ content_status: "stored" })
    .eq("id", file.id)
    .eq("organization_id", file.organizationId)
    .eq("hash", file.hash)
    .eq("content_status", "absent")
    .select("id");
  if (error) {
    // A failed bookkeeping write: content stays verified, the row still
    // says absent, the next read re-tries. Warned, not swallowed.
    console.warn(`flagging ${file.id} as stored failed (${error.message}); content is stored and the next read re-tries`);
    return { state: "failed" };
  }
  if (flipped.length > 0) return { state: "done" };
  const { data: row, error: rereadError } = await writerFor(deps)
    .from("files")
    .select("hash")
    .eq("id", file.id)
    .eq("organization_id", file.organizationId)
    .maybeSingle();
  if (rereadError) throw new Error(`The recheck after the metadata update failed: ${rereadError.message}`);
  if (row === null) return { state: "vanished" };
  if (row.hash !== file.hash) return { state: "stale" };
  // The row is still the file, still with the hash the content backs: it was
  // flipped already (a concurrent backfill won the identical race), or it
  // was stored all along. Both are the same finished state.
  return { state: "done" };
}

// ---- the service surface ----

/**
 * The file's complete source text, or null when there is none. The text is
 * the exact parsed bytes, decoded the parser's way — line endings kept as
 * they are, trailing whitespace kept, an empty file returned as "" (never
 * mistaken for missing content), never truncated.
 */
export async function getFileContent(db: Db, fileId: string, deps: BackfillDeps = {}): Promise<string | null> {
  const source = await loadSource(db, fileId, deps);
  return source === null ? null : source.text;
}

/**
 * Lines 1-based inclusive, in the parser's own numbering (files.lines). The
 * returned text joins the lines with \n; a line that ends in \r (a CRLF
 * file) is returned without it, the way the parser reads a line's own text.
 * Strict bounds: a range that runs past the file's last line is null, not a
 * clamped prefix, and never silently truncated. Invalid numbers — not
 * integers, zero or negative, start after end — are the caller's bug and
 * rejected loudly.
 */
export async function getFileLines(
  db: Db,
  fileId: string,
  startLine: number,
  endLine: number,
  deps: BackfillDeps = {},
): Promise<string | null> {
  requireRange(startLine, endLine);
  const source = await loadSource(db, fileId, deps);
  if (source === null) return null;
  return sliceLines(source.text, startLine, endLine);
}

// ---- the line view ----

function requireRange(startLine: number, endLine: number): void {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    throw new RangeError(`lines are whole numbers, not ${startLine} and ${endLine}`);
  }
  if (startLine < 1 || endLine < 1) {
    throw new RangeError(`lines are 1-based, not ${startLine} and ${endLine}`);
  }
  if (startLine > endLine) {
    throw new RangeError(`the range ${startLine}..${endLine} ends before it starts`);
  }
}

/**
 * The source line view. The split is the parser's own: content breaks on \n,
 * and the trailing "" a final newline leaves in its own split is not a line,
 * exactly the adjustment `countLines` in lib/parser/walk.ts (files.lines)
 * makes. A line's text is what separates it from the next; its terminator is
 * not the text. Returns null when either end of the range lies past the
 * file's last line.
 */
export function sliceLines(content: string, startLine: number, endLine: number): string | null {
  requireRange(startLine, endLine);
  const parts = content.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  if (startLine > parts.length || endLine > parts.length) return null;
  const lines: string[] = [];
  for (let at = startLine - 1; at < endLine; at++) {
    const line = parts[at]!;
    lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
  return lines.join("\n");
}

// ---- dependency resolution ----

function writerFor(deps: BackfillDeps): Db {
  return deps.writer ?? createAdminSupabase();
}

function fetchFor(deps: BackfillDeps): typeof fetchFileAt {
  return deps.fetchFile ?? fetchFileAt;
}

function fromCacheSingleton(): ContentCache {
  return getContentCache();
}

/**
 * Read content through the cache, falling back to the database.
 * The cache is keyed by (organization_id, content_hash), so a re-index
 * that changes the hash naturally produces a miss — no purge needed.
 * When deps.cache is null, no caching is used.
 */
async function getCachedOrDb(db: Db, organizationId: string, contentHash: string, deps: BackfillDeps): Promise<Uint8Array | null> {
  // cache === null means explicitly bypass caching for this call
  if (deps.cache === null) {
    return getContent(db, organizationId, contentHash);
  }
  return cachedGetContent(organizationId, contentHash, () => getContent(db, organizationId, contentHash), deps.cache ?? undefined);
}

function bytesToText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}
