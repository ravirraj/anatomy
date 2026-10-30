# ADR-0001: Store source-file contents in content-addressed Postgres rows

## Status

Proposed — design accepted in principle; implementation is tasked in
[TODO.md](../../../TODO.md) §3.4. No code, schema or migration exists yet.

## Date

2026-10-30

## Context

Cartograph analyzes a GitHub repository into files, edges, routes and
symbols, and stores those in Postgres (Supabase). The **file contents are
discarded** during ingestion — verified in code, not inferred: the extracted
archive lives in an `mkdtemp` workdir deleted in `finally`
(`lib/pipeline/run.ts`), the in-memory copies die when `parseSelection`
returns (`ParsedFile` has no `content`), and no content column exists in any
migration.

Consequently the only consumer that today needs source — the AI explanation
path — **borrows it back from GitHub**, one file per cache miss, at the
analysed commit, refusing to proceed unless `sha256(bytes) === file.hash`
(`sourceAtAnalysedCommit` in `app/(workspace)/analyses/[id]/actions.ts`).
This makes GitHub availability a dependency of the answer path, makes
repository-wide Q&A structurally infeasible (N live fetches per answer), and
fails permanently when the analysed commit disappears.

The parser fixture corpus and accuracy evaluation now in place
(20 hand-verified dependency pairs, `pnpm accuracy` floor 1.0) provide the
regression protection for a safe change of this scale; see
[fixtures/README.md][fixtures-readme] and the design document
[docs/architecture/file-content-storage.md][design].

## Decision

Store source content **immutably and content-addressed** in a dedicated
Postgres table living inside the existing Supabase database, accessed
only through a module boundary, with a bounded per-process LRU cache at the
answer path:

1. **`file_contents`** — `(organization_id, content_hash)` primary key,
   `payload bytea`, `size` (≤ 1 MB, matching the parser's existing
   `MAX_FILE_BYTES`), RLS'd like every other table. Content rows are
   insert-only (`ON CONFLICT DO NOTHING`): identical bytes across analyses,
   re-runs and files of the same organization collapse to one row. Nothing
   ever rewrites a payload.
2. **`files.content_status`** — `absent` | `stored`, indicating whether the
   hash-identified payload exists for the row.
3. **`lib/content`** module — `putContents`, `getContent`, `existsContent`,
   `deleteOrphaned`; read-side service `getFileContent(fileId)` and
   `getFileLines(fileId, start, end)` (1-based, parser-coincident
   numbering). Spec'd so a future Supabase Storage / S3 backend implements
   the same calls.
4. **Garbage collection** — a scheduled job deletes content rows with zero
   referencing `files` rows, at 24 h cadence.
5. **Bounded cache** — LRU keyed `(fileId, hash)`, budget 32 MB, ~1 MB max
   entry (exactly the parser's limit). Hash-in-key makes invalidation a
   miss, not a purge.
6. **Migration** — lazy backfill through the existing hash-verified
   `fetchFileAt` path only; no forced re-index.

## Alternatives considered

### A. Contents on the existing rows (payload column on `files`)

Rejected: re-run delete-and-reinsert churn on a TOAST-heavy column, no
dedup across files, no clean `content absent` state to model skipped files.

### B. Content-addressed local filesystem (shard tree of `hash` payloads)

Rejected: cannot be read by whatever pod serves the next request (no shared
volume primitive exists; deployments replace machines); separate backup
target; largest implementation complexity for the weakest consistency story.

### C. abstraction now (ContentStore layer over a future backend)

Not adopted *alone*: without a shipping second backend, an interface would
be designed from imagination (violating the "no abstraction without a clear
use case" constraint). Its single-buffer point — a module boundary that
keeps the object-storage door open — **is** adopted.

### D. (Chosen above)

## Consequences

- The answer path stops depending on GitHub rate limits and availability.
- Repository-wide Q&A becomes an engineering matter, not a blocker: line-
  precise retrieval windows with hash-verifiable binding.
- The DB grows cumulatively (capped per-run by `MAX_ARCHIVE_BYTES = 100 MB`),
  and dedup relies on identical-code identification *across* analyses of one
  org.
- Content identity, staleness-detection-on-citations, and cache coherence all
  reduce to **the same primitive**: `(fileId, content_hash)` binding.
- The `parser fixture + accuracy` infrastructure will validate the write
  path's behavior against the parser's own file/edge decisions; skipped-file
  policy is inherited from the parser, not re-specified.

## Risks and openings

Recorded in the design document §12. Two decisions are explicitly deferred:
cross-organization content deduplication, and the trigger to move payloads to
Supabase Storage/S3.

[fixtures-readme]: ../../fixtures/README.md
[design]: ../file-content-storage.md
