# Pipeline content integration — implementation notes

Status: **Implemented on `ravi` (Phase 2 of
[ADR-0001](decisions/0001-source-content-storage.md)).** These notes record
what the design left to the implementer and what the code does. The
authoritative design document is
[file-content-storage.md](file-content-storage.md) (§15 summarizes this one).

## The open questions, and the answers the code gives

### 1. Where the original bytes come from (and how nothing is assumed)

The pipeline already held every eligible file's text once:
`CandidateFile.content`, a **string** — `readCandidate`
(`lib/parser/walk.ts`) reads the raw buffer, hashes the buffer, then keeps
only `buffer.toString("utf8")` and discards the bytes. The candidate's hash
is over the *raw bytes*, and the string is only equal to them for files that
are valid UTF-8.

`run.ts` passes the candidates' texts keyed by path into `storeResult`
(`contents: ReadonlyMap<string, string>`, referencing the strings, not
copying them). `storeFileContents` (`lib/pipeline/store.ts`) then verifies
before it stores, instead of assuming the round trip:

1. `Buffer.from(text, "utf8")` is hashed with the store's `sha256` and
   compared to the parser's `file.hash` (the same hash the walk computed
   over the raw bytes — that is what `files.hash` holds). Equal ⇒ the body
   is byte-for-byte the walk's originals; a mismatch without a sha256
   collision is not possible. No re-read happens for such a file — which is
   almost every file.
2. Not equal ⇒ the text was not the round trip of the bytes (the file
   contains bytes UTF-8 cannot express, so `toString("utf8")` substituted
   and `Buffer.from` cannot restore them): one exact `readFileSync` of
   `path.join(result.root, file.path)` — the workdir still exists through
   the store stage, deleted only in the run's `finally` — hashed and
   verified against `file.hash` a second time.
3. Still not equal ⇒ the file changed under the run: **nothing is written
   under a stale identity.** The file's content stays absent
   (`content_status = 'absent'`), the incident is counted and warned, and
   the run proceeds.

So "the bytes are the parser's bytes" is an *argument the code checks*, not
an assumption. No line-ending normalization, no re-encoding beyond the
verified round trip, no silent fix-ups. The parser's eligibility is the
only gate: `storeResult` stores bodies exactly for `result.files` — the
files the parser indexed — and nothing the parser skipped (declaration,
binary, too large, unreadable, syntax error) is ever offered. No new
inclusion rules were invented, so none needed justification or a
`CandidateFile`/`ParsedFile` change (`SCHEMA_VERSION` stays 5).

### 2. Batching and chunking

Content rides to the database through `putContentsBatch`
(`lib/content/store.ts`): several bodies, **one conflict-safe bulk upsert**
per call (`onConflict: "organization_id,content_hash"`,
`ignoreDuplicates: true` — an existing immutable row is never rewritten),
with hashing, validation and duplicate collapse inside the batch. The
singular `putContents` is now a one-body delegation to it, so the
hashing/validation/insert logic exists once. Results are returned per body,
in order:

```ts
type ContentWriteResult =
  | { stored: true; contentHash: string; size: number }
  | { stored: false; reason: string };
```

The chunk *policy* lives with the pipeline's other chunk constants, as
exported, configurable exports of `lib/pipeline/store.ts`:

```ts
export const CONTENT_CHUNK_FILES = 25;             // files per request
export const CONTENT_CHUNK_BYTES = 4 * 1024 * 1024; // raw bytes per request
```

Payloads travel hex-encoded on the wire (bytea as `\x…`, the PostgREST
form), so the worst chunk is at most ~8 MB of JSON — inside the platform's
request limits, as the row chunks are. A file alone can never exceed the
byte bound: the parser skips anything over 1 MB.

Chunking loops over `result.files` in order: the next file flushes the
current chunk when the count or the aggregate-bytes bound would be crossed,
and `flush()` offers the chunk's distinct, not-yet-confirmed bodies to
`putContentsBatch`. Memory grows by one chunk, not by the repository.

### 3. Deduplication is paid-for-once, run-scoped

- **Across files, across the whole run:** `sent`, a set of hashes whose
  writes were *confirmed stored* by an earlier request of this run. Any
  later file with that hash is neither sent nor counted eligible-to-fail —
  its content is already there — and the run's budget charges it nothing.
- **Within a request:** identical bodies in one chunk collapse to one row
  inside `putContentsBatch` before anything hits the wire.
- **Across runs:** irrelevant — `ON CONFLICT DO NOTHING` against the
  `(organization_id, content_hash)` primary key is the database's dedup;
  a re-run of unchanged files sends bodies that the database accepts as
  no-ops, and a *failed* hash from earlier in the run is retried by any
  later chunk that holds a copy of it, for free.

Deduplicated writes are counted (`stats.deduplicated`) and the confirmed
write's bytes accrue once per distinct body (`stats.bytes`).

### 4. Transactionality, sequencing and the invariant

The Supabase client has no transaction API; separate requests are separate
requests everywhere in this pipeline (files, edges, roles, routes, symbols
are all chunked, unfenced-by-transaction writes today). The design does not
pretend otherwise. Instead the *order* carries the invariant:

```text
delete this analysis's old files rows
  → write ALL content chunks (each verified before it is offered)
    → insert files rows, content_status = 'stored' only if the body was
      confirmed in file_contents during this run, else 'absent'
```

So a `files` row is marked `stored` only when its content record already
exists — the invariant holds by construction, not by a transaction nobody
has.

Failure behaviour, precisely:

| Failure | Consequence |
|---|---|
| A content chunk's request is refused | That chunk's files end `'absent'`; later chunks still write; the run completes and the stats distinguish `failed` (database refused, or no text arrived) from `changed` (hash refused the identity) and `unreadable` (the fallback re-read failed). **The run does not fail.** |
| The `files` rows insert fails | The run fails loudly (as it always did). Content already confirmed stays — temporarily unreferenced; content-addressed rows are harmless orphans until the GC phase, and a retried run will reference them with no second write. |
| The run dies between content and metadata | Same as above; recovery is the retry, which re-uses the content it left. |
| Existing content hash encountered | `ignoreDuplicates` no-ops it; nothing is rewritten (the schema refuses updates outright). |

Fencing and ownership are untouched: content rows are
organization-and-hash scoped, so a superseded run's content writes are the
same rows the newer run deduplicates — they cannot corrupt anything, and
the analysis claim (`started_at`) fencing on metadata writes is exactly as
it was.

### 5. Observability

`storeResult` returns a `ContentStorageStats`:

```ts
{ eligible, stored, bytes, deduplicated, absent, failed, changed, unreadable }
```

- `eligible`: files the parser indexed — every one a candidate for storing.
- `stored`: confirmed in `file_contents` (their `files` rows end `'stored'`).
- `bytes`: raw bytes of confirmed writes, each distinct body once.
- `deduplicated`: writes skipped as already-confirmed or collapsed in-batch.
- `absent`: eligible files left `'absent'` = `failed + changed + unreadable`.
- `failed`: a database request refused (retry-able), or no text arrived
  for a path.
- `changed`: neither the text nor a fresh read hashed to the identity.
- `unreadable`: the fallback re-read itself failed.

`run.ts` folds the counts into the completion stage message —
`…; content stored for N files, M files without content` — and a
`console.warn` line is emitted per refused chunk. That is the whole
observability surface: counts and identities, never per-file noise, never
source text, credentials or payloads.

### 6. Tests and where the guarantees are proven

- **`scripts/test-content-pipeline.ts`** (in `pnpm test`) — fake client,
  real parser, real fixture directories: the stored bytes are byte-for-byte
  the disk's bytes and hash to the `files` row's hash; `content_status` is
  set only for confirmed content; skipped files carry no claim; chunking
  respects both bounds; in-batch and cross-run duplicates collapse with
  stats counting them; a refused chunk fails only its own files; a metadata
  failure fails loudly while confirmed content stays; retries repeat
  nothing; the invalid-UTF-8 file is stored via the exact re-read; a
  tampered or missing text is verified-then-refused, never stored under a
  stale identity.
- **`scripts/test-content-pipeline-db.ts`** — against the live linked
  project (not in `pnpm test`): PostgREST accepts the batched hex bytea
  write, duplicates collapse inside one bulk request, reads return the
  exact bytes, a second batch is a no-write, organizations are isolated,
  and the cleanup deletes its throwaway organizations with cascade and
  verifies nothing test-named remains.

### 7. Deferred (still true after this phase)

The content read service and its lazy backfill are implemented
(`lib/content/read.ts`, recorded in
[file-content-storage.md §16](file-content-storage.md#16-phase-3-the-read-side-and-lazy-backfill-as-implemented-october-2026));
still deferred: the LRU cache, garbage collection, full-text search,
retrieval/Q&A, citation hash-binding, object storage, background jobs.
`files` rows created before this phase belong to past analyses whose re-run
will backfill their content naturally; no migration of old rows is
attempted.
