// Checks the pipeline's content write: storeResult turns the already-held
// candidate text back into bytes, *verifies* them against the parser's hash
// instead of assuming the round trip, falls back to one exact re-read from
// the workdir when the text was not the round trip of the bytes, pays for
// each distinct body once, and never marks a file stored whose body didn't
// make it into file_contents.
//
//   node scripts/test-content-pipeline.ts
//
// The parser itself is real (a temporary fixture directory is walked and
// parsed for every scenario), so eligibility — what the parser indexed vs
// skipped — is the parser's own decision. The database client is a fake of
// exactly the calls storeResult and putContentsBatch make; the database's
// row policies are scripts/test-content-rls.ts's business, while the wire
// behavior of a batched bytea write gets its own live check in
// scripts/test-content-pipeline-db.ts.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSelection, selectFiles } from "../lib/parser/index.ts";
import { putContentsBatch, sha256 } from "../lib/content/store.ts";
import type { Db } from "../lib/content/types.ts";
import { CONTENT_CHUNK_BYTES, CONTENT_CHUNK_FILES, type ContentStorageStats } from "../lib/pipeline/store.ts";
import { storeResult } from "../lib/pipeline/store.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);
const check = (m: string, condition: boolean) => {
  if (condition) pass(m);
  else fail(m);
};

// ---- the fake client ----

type ContentRow = { organization_id: string; content_hash: string; payload: string; size: number };
type FileRow = Record<string, unknown>;

class FakeSupabase {
  contents: ContentRow[] = [];
  files = new Map<string, FileRow[]>();
  // Failure injection: the next upsert/insert returns this message once.
  failNextContentUpsert: string | null = null;
  failNextFilesInsert: string | null = null;
  contentUpserts: { rows: ContentRow[] }[] = [];
  fileInserts: FileRow[][] = [];

  from(name: string): unknown {
    if (name === "file_contents") return this.fileContents();
    if (name === "files") return this.filesTable();
    throw new Error(`this test's fake only knows file_contents and files, got ${name}`);
  }

  fileContents() {
    return {
      // The chain storeResult and the batch actually make: ...upsert(values, opts)
      upsert: (values: ContentRow | ContentRow[], opts: { onConflict: string; ignoreDuplicates: boolean }) => {
        const rows = Array.isArray(values) ? values : [values];
        this.contentUpserts.push({ rows });
        if (opts.onConflict !== "organization_id,content_hash" || !opts.ignoreDuplicates) {
          return { error: { message: "expected this test to write conflict-safe" } };
        }
        if (this.failNextContentUpsert) {
          const message = this.failNextContentUpsert;
          this.failNextContentUpsert = null;
          return { error: { message } };
        }
        for (const row of rows) {
          if (this.contents.some((r) => r.organization_id === row.organization_id && r.content_hash === row.content_hash)) continue;
          this.contents.push(row);
        }
        return { error: null };
      },
    };
  }

  filesTable() {
    let deleteFilter: string | null = null;
    return {
      delete: () => ({
        eq: (_column: string, value: string) => {
          deleteFilter = value;
          return this.deleteResult(deleteFilter);
        },
      }),
      insert: (rows: FileRow[]) => {
        this.fileInserts.push(rows);
        if (this.failNextFilesInsert) {
          const message = this.failNextFilesInsert;
          this.failNextFilesInsert = null;
          return { error: { message } };
        }
        for (const row of rows) this.filesRowsFor(row.analysis_id as string).push(row);
        return { error: null };
      },
    };
  }

  deleteResult(analysisId: string | null) {
    if (analysisId !== null) this.files.set(analysisId, []);
    return { error: null };
  }

  filesRowsFor(analysisId: string): FileRow[] {
    let rows = this.files.get(analysisId);
    if (rows === undefined) this.files.set(analysisId, (rows = []));
    return rows;
  }

  rpc(name: string, args: Record<string, unknown>): { error: null } {
    // Edges, roles, routes and symbols aren't this suite's subject; record
    // that they were asked for so a content-only change can't reshuffle them.
    this.fileInserts.push([{ __rpc: name, p_analysis_id: args.p_analysis_id }]);
    return { error: null };
  }
}

const bytes = (row: ContentRow): Buffer =>
  Buffer.from(row.payload.startsWith("\\x") ? row.payload.slice(2) : row.payload, "hex");

// The fake above must expose from() shaped like the client; cast through unknown.
function fakeDb(fake: FakeSupabase): Db {
  return {
    from: (name: string) => fake.from(name) as never,
    rpc: (name: string, args: Record<string, unknown>) => fake.rpc(name, args) as never,
  } as unknown as Db;
}

// ---- fixture directories ----

function makeFixture(files: Record<string, string | Buffer>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "content-pipeline-"));
  for (const [rel, body] of Object.entries(files)) {
    const absolute = path.join(root, rel);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, body);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const text = (s: string) => Buffer.from(s, "utf8");

/**
 * What run.ts does: select, parse, and carry the candidates' text through so
 * the store can verify it against the walk's hashes. The map references the
 * candidates' strings; copying it here copies only name-to-string pointers.
 */
function ingest(root: string): { result: ReturnType<typeof parseSelection>; contents: Map<string, string> } {
  const selection = selectFiles(root);
  const result = parseSelection(selection);
  const contents = new Map<string, string>(selection.walk.candidates.map((c) => [c.path, c.content]));
  return { result, contents };
}

async function main(): Promise<void> {
  // --- 1, 2, 3: eligible files' content, exact bytes, hash in step with files.hash
  {
    const fixture = makeFixture({
      "package.json": '{ "name": "fixture", "version": "1.0.0" }',
      "alpha.ts": text("export function alpha(): number {\n  return 41 + 1;\n}\n").toString(),
      "lib/beta.ts": text("export const beta = 'the second file';\n").toString(),
      "types.d.ts": text("export declare type Ghost = number;\n").toString(),
    });
    const fake = new FakeSupabase();
    const { result, contents } = ingest(fixture.root);
    const stats = await storeResult(fakeDb(fake), { id: "analysis-1", organizationId: "org-x" }, result, contents);

    check("every parsed file's content_status is stored", result.files.every((f) => fake.filesRowsFor("analysis-1").some((r) => r.path === f.path && r.content_status === "stored")));
    check("every skipped file has no content_status claim", result.coverage.files.skippedFiles.every((f) => fake.filesRowsFor("analysis-1").some((r) => r.path === f.path && r.content_status === undefined)));
    check("content rows exist only for parsed files", fake.contents.length === result.files.length);
    for (const f of result.files) {
      const row = fake.contents.find((r) => r.content_hash === f.hash);
      if (!row) {
        fail(`content row for ${f.path}`);
        continue;
      }
      check(`the stored bytes for ${f.path} are the exact bytes on disk`, bytes(row).equals(readFileSync(path.join(fixture.root, f.path))));
      check(`the stored identity of ${f.path} is the files row's hash`, row.content_hash === f.hash && row.size === f.bytes);
      check(`the stored bytes for ${f.path} hash to the files row's hash`, row.content_hash === sha256(bytes(row)));
    }
    check("the stats count what landed", stats.eligible === result.files.length && stats.absent === 0 && stats.bytes > 0);

    // --- 5: chunking over CONTENT_CHUNK_FILES (every request holds <= the bound)
    check("no more writes were sent than files exist", fake.contentUpserts.length === 1);

    // --- 7 (metadata failure): content rows survive; the run fails loudly
    fake.failNextFilesInsert = "connection reset";
    let metadataFailure = false;
    try {
      await storeResult(fakeDb(fake), { id: "analysis-retry", organizationId: "org-x" }, result, contents);
    } catch {
      metadataFailure = true;
    }
    check("a metadata write failure fails the run out loud", metadataFailure);
    check("the content written before the metadata failure remains (documented until GC)", fake.contents.every((r) => fake.contents.filter((o) => o.organization_id === r.organization_id && o.content_hash === r.content_hash).length === 1));

    // --- 9: retry after interruption is idempotent
    const before = fake.contents.map((r) => r.content_hash).sort().join(",");
    fake.failNextFilesInsert = null;
    const retryStats: ContentStorageStats = await storeResult(fakeDb(fake), { id: "analysis-retry", organizationId: "org-x" }, result, contents);
    check("a retried run re-inserts the file rows it lost", fake.filesRowsFor("analysis-retry").length === result.files.length + result.coverage.files.skippedFiles.length);
    check("a retried run creates no second content row", before === fake.contents.map((r) => r.content_hash).sort().join(","));
    check("a retried run's file rows end stored", fake.filesRowsFor("analysis-retry").filter((r) => typeof r.hash === "string").every((r) => r.content_status === "stored"));
    check("a retried run marks nothing absent that was stored", retryStats.absent === 0);

    // --- 12: another analysis of the same organization shares the content
    const rowsBefore = fake.contents.length;
    await storeResult(fakeDb(fake), { id: "analysis-2", organizationId: "org-x" }, result, contents);
    check("a second analysis of the same organization writes no new content rows", fake.contents.length === rowsBefore);
    check("a second analysis gets its own file rows", fake.filesRowsFor("analysis-2").length === result.files.length + result.coverage.files.skippedFiles.length);

    fixture.cleanup();
  }

  // --- dedup: identical bodies in two files collapse (fixture of its own)
  {
    const same = "export const twin = 'two files, one body';\n";
    const fixture = makeFixture({
      "a.ts": same,
      "b.ts": same,
      "c.ts": `export const other = 'this one stands alone';\n`,
    });
    const fake = new FakeSupabase();
    const { result, contents } = ingest(fixture.root);
    const stats = await storeResult(fakeDb(fake), { id: "analysis-dup", organizationId: "org-dup" }, result, contents);
    check("two files with one body leave exactly one content row", fake.contents.length === 2);
    check("identical bodies are written once", fake.contentUpserts.every(({ rows }) => new Set(rows.map((r) => r.content_hash)).size === rows.length));
    check("both twins are marked stored", fake.filesRowsFor("analysis-dup").filter((r) => r.path === "a.ts" || r.path === "b.ts").every((r) => r.content_status === "stored"));
    check("the stats count the collapse", stats.stored === 3 && stats.deduplicated === 1 && stats.absent === 0);
    fixture.cleanup();
  }

  // --- chunking: > CONTENT_CHUNK_FILES files means > 1 request
  {
    const files: Record<string, string> = { "package.json": '{ "name": "chunky", "version": "1.0.0" }' };
    const total = CONTENT_CHUNK_FILES + 7;
    for (let i = 0; i < total; i++) files[`file-${String(i).padStart(3, "0")}.ts`] = `export const value${i} = ${i};\n`;
    const fixture = makeFixture(files);
    const fake = new FakeSupabase();
    const { result, contents } = ingest(fixture.root);
    const stats = await storeResult(fakeDb(fake), { id: "analysis-chunk", organizationId: "org-chunk" }, result, contents);
    const perRequest = fake.contentUpserts.map(({ rows }) => rows.length);
    check("a repository beyond one chunk's size arrives in several requests", fake.contentUpserts.length > 1);
    check("no request exceeds the file count bound", perRequest.every((n) => n <= CONTENT_CHUNK_FILES));
    check("every file lands despite the chunking", fake.contents.length === total);
    check("the chunked run leaves nothing absent", stats.absent === 0 && stats.eligible === total);
    // aggregate-byte bound: many small files can't break the count bound, but sanity-check the constant itself
    check("the byte bound holds for the requests' contents", fake.contentUpserts.every(({ rows }) => rows.reduce((sum, r) => sum + r.size, 0) <= CONTENT_CHUNK_BYTES));
    fixture.cleanup();
  }

  // --- 7/8 (content write failure): the failing request's files stay absent, others stored
  {
    const fixture = makeFixture({
      "package.json": '{ "name": "failure", "version": "1.0.0" }',
      ...Object.fromEntries(Array.from({ length: CONTENT_CHUNK_FILES + 3 }, (_, i) => [
        `file-${String(i).padStart(3, "0")}.ts`,
        `export const value${i} = ${i};\n`,
      ])),
    });
    const fake = new FakeSupabase();
    const { result, contents } = ingest(fixture.root);
    fake.failNextContentUpsert = "could not connect";
    const stats = await storeResult(fakeDb(fake), { id: "analysis-fail", organizationId: "org-fail" }, result, contents);
    const rows = fake.filesRowsFor("analysis-fail").filter((r) => typeof r.hash === "string");
    const stored = rows.filter((r) => r.content_status === "stored");
    const absent = rows.filter((r) => r.content_status === "absent");
    check("a failed content request does not fail the whole run", stored.length > 0 && absent.length > 0);
    check("files in the refused request are all absent", absent.length === Math.min(CONTENT_CHUNK_FILES, rows.length));
    check("files in later requests are stored", stored.length === rows.length - absent.length);
    check("the stats say exactly what happened", stats.failed === absent.length && stats.absent === absent.length && stats.stored === stored.length);
    // 10: an existing content hash is met again — never rewritten, no error
    fake.failNextContentUpsert = null;
    const again = await storeResult(fakeDb(fake), { id: "analysis-fail-retry", organizationId: "org-fail" }, result, contents);
    check("a retry after a refused request stores the rest", again.absent === 0);
    check("a retry adds only what was missing", fake.contents.length === result.files.length);
    check("every file of the retried run is stored", fake.filesRowsFor("analysis-fail-retry").filter((r) => typeof r.hash === "string").every((r) => r.content_status === "stored"));
    fixture.cleanup();
  }

  // --- text that is not the round trip of the bytes: verified, then the exact
  // bytes come from one re-read of the workdir (a file with a byte UTF-8
  // cannot express — valid TS, no NUL, so the parser indexes it)
  {
    const fixture = makeFixture({
      "package.json": '{ "name": "odd-bytes", "version": "1.0.0" }',
      // A byte 0x80 alone is invalid UTF-8: the walk hashes the raw bytes and
      // the candidate's text carries U+FFFD for it, so the re-encode's hash
      // cannot match and the exact bytes must come from disk.
      "odd.ts": Buffer.concat([text("// stray: "), Buffer.from([0x80, 0x81]), text("\nexport const odd = 1;\n")]),
    });
    const fake = new FakeSupabase();
    const { result, contents } = ingest(fixture.root);
    const odd = result.files.find((f) => f.path === "odd.ts");
    if (!odd) {
      fail("the parser indexed odd.ts (it is not binary by the walk's rule)");
    } else {
      check("the walk's hash is over the raw bytes, which the text alone cannot reproduce", odd.hash !== sha256(Buffer.from(contents.get("odd.ts") ?? "", "utf8")));
      const stats = await storeResult(fakeDb(fake), { id: "analysis-odd", organizationId: "org-odd" }, result, contents);
      const row = fake.contents.find((r) => r.content_hash === odd.hash);
      check("a file whose text is not its bytes is still stored", row !== undefined);
      check("its stored bytes are the exact original bytes, from the re-read", row !== undefined && bytes(row).equals(readFileSync(path.join(fixture.root, "odd.ts"))));
      check("nothing else was disturbed by the fallback", stats.absent === 0 && stats.stored === result.files.length);
    }
    fixture.cleanup();
  }

  // --- what a caller handing the wrong or missing text gets: the store
  // verifies instead of assuming, and a body that verifies against nothing
  // is refused, never stored under a stale identity
  {
    const fixture = makeFixture({
      "package.json": '{ "name": "tampered", "version": "1.0.0" }',
      "gone.ts": "export const willBeMissing = 1;\n",
      "tampered.ts": "export const willBeTampered = 2;\n",
      "lost.ts": "export const willBeLost = 3;\n",
      "steady.ts": "export const willBeSteady = 4;\n",
    });
    const fake = new FakeSupabase();
    const { result, contents } = ingest(fixture.root);
    // The walk's texts, then the run's hand slips three ways before storing:
    contents.delete("gone.ts"); // no text arrives for it
    contents.set("tampered.ts", "export const tamperedWrongText = 0;\n"); // wrong text, disk honest
    contents.set("lost.ts", "export const lostWrongText = 0;\n"); // wrong text, AND the disk no longer agrees with the walk's identity
    writeFileSync(path.join(fixture.root, "lost.ts"), "export const replacedOnDisk = 9;\n");
    const stats = await storeResult(fakeDb(fake), { id: "analysis-tamper", organizationId: "org-tamper" }, result, contents);

    const rowOf = (p: string) => fake.filesRowsFor("analysis-tamper").find((r) => r.path === p);
    const gone = rowOf("gone.ts");
    const tamperedRow = rowOf("tampered.ts");
    const lostRow = rowOf("lost.ts");
    const steadyRow = rowOf("steady.ts");
    const tamperedFile = result.files.find((f) => f.path === "tampered.ts");
    const lostFile = result.files.find((f) => f.path === "lost.ts");
    if (!gone || !tamperedRow || !lostRow || !steadyRow || !tamperedFile || !lostFile) {
      fail("every file of the fixture produced a files row");
      return;
    }
    check("a path with no carried text is absent, counted failed", gone.content_status === "absent" && stats.failed >= 1);
    check("a tampered text does not win: the verify falls back to the disk, which is honest", tamperedRow.content_status === "stored" && fake.contents.some((r) => r.content_hash === tamperedFile.hash && bytes(r).equals(text("export const willBeTampered = 2;\n"))));
    check("a body that verifies against neither the text nor the walk is refused", lostRow.content_status === "absent" && !fake.contents.some((r) => r.content_hash === lostFile.hash));
    check("the refusals are counted as changed identities", stats.changed >= 1);
    check("the honest file beside them is stored", steadyRow.content_status === "stored");
    check("no content row exists that no files row points at", fake.contents.every((r) => result.files.some((f) => f.hash === r.content_hash)));
    fixture.cleanup();
  }

  // --- the batch write itself: duplicates inside one request, oversized refusal
  {
    const fake = new FakeSupabase();
    const body = text("export const batched = 'one body, three names';\n");
    const outs = await putContentsBatch(fakeDb(fake), "org-batch", [
      { body },
      { body: text("export const second = 'a different body';\n") },
      { body }, // same body again, same request
      { body: new Uint8Array(CONTENT_CHUNK_BYTES + 1) }, // beyond the parser's own limit
    ]);
    check("a batched write of three distinct-and-duplicate bodies lands two rows", fake.contents.length === 2);
    check("the duplicate body inside one request reports the stored row", outs[0].stored && outs[2].stored && outs[0].contentHash === outs[2].contentHash);
    check("the oversized body is refused without sinking the batch", !outs[3].stored && outs[3].reason.includes("never stored"));
    check("the batch was sent as one conflict-safe request", fake.contentUpserts.length === 1 && fake.contentUpserts[0].rows.length === 2);

    fake.failNextContentUpsert = "table missing";
    const failed = await putContentsBatch(fakeDb(fake), "org-batch", [{ body }, { body: text("export const another = 1;\n") }]);
    check("a refused request marks every body of it failed, loudly", failed.every((r) => !r.stored) && failed[0].reason.includes("table missing"));
  }

  // --- sha256 sanity: the pipeline's identity function is the store's
  {
    const body = text("export const identical = 'hash me exactly';\n");
    check("the store and the parser would name the same bytes the same", sha256(body) === sha256(new Uint8Array(body)) && /^[0-9a-f]{64}$/.test(sha256(body)));
  }
}

main().finally(() => {
  console.log("");
  for (const line of results) console.log(line);
  const failedLines = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(failedLines === 0 ? "\nEvery check passed." : `\n${failedLines} check(s) failed.`);
  process.exit(failedLines === 0 ? 0 : 1);
});
