// Checks the content read service: lib/content/read.ts resolves a file
// through the database's own rows (never an org a caller asserts), verifies
// stored bytes before serving them, refuses to smooth a self-contradicting
// database into a typed null, slices lines by the parser's own convention
// (files.lines), and lazily backfills an absent file from GitHub at exactly
// the commit that was analysed — hash-verified, stored through the immutable
// store, metadata updated conditionally.
//
//   node scripts/test-content-read.ts
//
// The parser itself is real (a temporary fixture is walked and parsed for
// the agreement test, so line numbers are the parser's own decisions). The
// database client is a fake of exactly the calls the read path makes —
// files select/update with the conditional filters, file_contents
// select/upsert through the store. What the fake cannot prove — that the
// row policies really isolate another member, and how bytea travels over
// the wire — is the live suites' business (scripts/test-content-rls.ts,
// scripts/test-content-read-db.ts), never this one's.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSelection, selectFiles } from "../lib/parser/index.ts";
import { countLines } from "../lib/parser/walk.ts";
import { sha256 } from "../lib/content/store.ts";
import { PipelineError, fetchFileAt, type Repository } from "../lib/pipeline/github.ts";
import {
  ConsistencyError,
  IntegrityError,
  getFileContent,
  getFileLines,
  sliceLines,
  type BackfillDeps,
} from "../lib/content/read.ts";
import type { Db } from "../lib/content/types.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);
const check = (m: string, condition: boolean) => {
  if (condition) pass(m);
  else fail(m);
};

// ---- the fake client ----

type FileRow = {
  id: string;
  path: string;
  hash: string | null;
  lines: number | null;
  content_status: string;
  organization_id: string;
  analysis: { commit_sha: string | null; project: { repo_owner: string; repo_name: string } | null } | null;
};
type ContentRow = { organization_id: string; content_hash: string; payload: string; size: number };
type ContentRead = { columns: string; organization_id: unknown; content_hash: unknown };
type FileUpdate = { changes: Partial<FileRow>; filters: Record<string, unknown>; applied?: number };

class FakeSupabase {
  files = new Map<string, FileRow>();
  contents: ContentRow[] = [];
  // Failure injection: the next call of its kind fails once.
  failNextContentUpsert: string | null = null;
  failNextFilesUpdate: string | null = null;
  // The next existsContent reports the row missing once, though the upsert succeeded.
  loseOneConfirmation = false;
  // What the fake saw.
  contentReads: ContentRead[] = [];
  contentUpserts: { rows: ContentRow[] }[] = [];
  fileUpdates: FileUpdate[] = [];

  from(name: string): unknown {
    if (name === "files") return this.filesChain(this);
    if (name === "file_contents") return this.contentsChain(this);
    throw new Error(`this test's fake only knows files and file_contents, got ${name}`);
  }

  filesChain(fake: FakeSupabase) {
    return {
      select: (_columns: string) => {
        const filters: Record<string, unknown> = {};
        const after = {
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return after;
          },
          maybeSingle: () => {
            const rows = [...fake.files.values()].filter((row) =>
              Object.entries(filters).every(([c, v]) => row[c as keyof FileRow] === v),
            );
            return { data: rows[0] ?? null, error: null };
          },
        };
        return after;
      },
      update: (changes: Partial<FileRow>) => {
        const filters: Record<string, unknown> = {};
        const after = {
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return after;
          },
          select: (_columns: string) => {
            if (fake.failNextFilesUpdate !== null) {
              const message = fake.failNextFilesUpdate;
              fake.failNextFilesUpdate = null;
              fake.fileUpdates.push({ changes, filters });
              return { data: null, error: { message } };
            }
            const touched: string[] = [];
            for (const row of fake.files.values()) {
              if (Object.entries(filters).every(([c, v]) => row[c as keyof FileRow] === v)) {
                Object.assign(row, changes);
                touched.push(row.id);
              }
            }
            fake.fileUpdates.push({ changes, filters, applied: touched.length });
            return { data: touched.map((id) => ({ id })), error: null };
          },
        };
        return after;
      },
    } as never;
  }

  contentsChain(fake: FakeSupabase) {
    return {
      select: (columns: string) => {
        const filters: Record<string, unknown> = {};
        const after = {
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return after;
          },
          maybeSingle: () => {
            fake.contentReads.push({ columns, organization_id: filters["organization_id"], content_hash: filters["content_hash"] });
            if (fake.loseOneConfirmation && columns === "size") {
              // existsContent (the size-only select) reports the row missing once,
              // though the upsert that preceded it succeeded.
              fake.loseOneConfirmation = false;
              return { data: null, error: null };
            }
            const rows = fake.contents.filter((row) =>
              Object.entries(filters).every(([c, v]) => row[c as keyof ContentRow] === v),
            );
            return { data: rows[0] ?? null, error: null };
          },
        };
        return after;
      },
      upsert: (values: ContentRow | ContentRow[], opts: { onConflict: string; ignoreDuplicates?: boolean }) => {
        const rows = Array.isArray(values) ? values : [values];
        fake.contentUpserts.push({ rows });
        if (opts.onConflict !== "organization_id,content_hash") {
          return { error: { message: "expected this test to write conflict-safe" } };
        }
        if (fake.failNextContentUpsert) {
          const message = fake.failNextContentUpsert;
          fake.failNextContentUpsert = null;
          return { error: { message } };
        }
        for (const row of rows) {
          if (fake.contents.some((r) => r.organization_id === row.organization_id && r.content_hash === row.content_hash)) continue;
          fake.contents.push(row);
        }
        return { error: null };
      },
    } as never;
  }
}

function fakeDb(fake: FakeSupabase): Db {
  return { from: (name: string) => fake.from(name) } as unknown as Db;
}

// ---- seeding ----

const payloadOf = (bytes: Uint8Array): string => `\\x${Buffer.from(bytes).toString("hex")}`;

const asBytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));

const COMMIT = "abcdef1234567890abcdef1234567890abcdef12";
/** The repository as the files select's embed returns it. */
const ROW_PROJECT = { repo_owner: "octo", repo_name: "lab" };

/** One files row plus its verified content, as a stored file looks to the service. */
function seedStored(fake: FakeSupabase, row: Partial<FileRow> & { id: string; path: string }, body: string): FileRow {
  const bytes = asBytes(body);
  const hash = sha256(bytes);
  const full: FileRow = {
    lines: countLines(body),
    content_status: "stored",
    organization_id: "org-a",
    analysis: { commit_sha: COMMIT, project: ROW_PROJECT },
    hash,
    ...row,
  };
  fake.files.set(full.id, full);
  fake.contents.push({ organization_id: full.organization_id, content_hash: hash, payload: payloadOf(bytes), size: bytes.byteLength });
  return full;
}

function seedAbsent(fake: FakeSupabase, row: Partial<FileRow> & { id: string; path: string }, source: string): FileRow {
  const bytes = asBytes(source);
  const full: FileRow = {
    lines: countLines(source),
    content_status: "absent",
    organization_id: "org-a",
    analysis: { commit_sha: COMMIT, project: ROW_PROJECT },
    hash: sha256(bytes),
    ...row,
  };
  fake.files.set(full.id, full);
  return full;
}

// ---- the injected fetcher ----

type FetchCall = { repository: Repository; sha: string; path: string };

type Source = (call: FetchCall, nth: number) => Buffer | null | Promise<Buffer | null>;

function fetchStub(source: Source, onCall?: () => void): { fetchFile: typeof fetchFileAt; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: typeof fetchFileAt = async (repository, sha, filePath) => {
    const call = { repository, sha, path: filePath };
    calls.push(call);
    onCall?.();
    return (await source(call, calls.length)) as Buffer | null;
  };
  return { fetchFile: fetch, calls };
}

/** A fetcher that must never run: the stored paths and no-content paths take no fetch. */
const neverFetch = fetchStub(() => {
  throw new Error("this scenario must not fetch");
});

function depsOf(fake: FakeSupabase, fetch?: typeof fetchFileAt): BackfillDeps {
  return { writer: fakeDb(fake), fetchFile: fetch ?? neverFetch.fetchFile };
}

const read = (fake: FakeSupabase, id: string, fetch?: typeof fetchFileAt) => getFileContent(fakeDb(fake), id, depsOf(fake, fetch));
const readLines = (fake: FakeSupabase, id: string, start: number, end: number, fetch?: typeof fetchFileAt) =>
  getFileLines(fakeDb(fake), id, start, end, depsOf(fake, fetch));

const throws = (error: unknown, name: string, messagePart?: string): boolean =>
  error instanceof Error && error.name === name && (messagePart === undefined || error.message.includes(messagePart));

async function main(): Promise<void> {
  // --- read service: the stored path ---
  {
    const fake = new FakeSupabase();
    seedStored(fake, { id: "f-crlf", path: "src/alpha.ts" }, "const a = 1;\nconst b = 2;\r\nlast = 'kept';\r\n");
    const out = await read(fake, "f-crlf");
    check("a stored file's exact text is served, line endings untouched", out === "const a = 1;\nconst b = 2;\r\nlast = 'kept';\r\n");
    check("the content read was asked by the row's organization and hash, not the caller's say-so", fake.contentReads.length > 0 && fake.contentReads.every((r) => r.organization_id === "org-a" && typeof r.content_hash === "string"));
    check("no files update happened on a stored read", fake.fileUpdates.length === 0);

    check("a missing file id reads out of nothing", (await read(fake, "not-there")) === null);

    // an empty file is content: "" is served, not null, and no lines exist
    seedStored(fake, { id: "f-empty", path: "empty.ts" }, "");
    check("an empty stored file reads as an empty string, never null", (await read(fake, "f-empty")) === "");
    check("an empty stored file has no lines to serve", (await readLines(fake, "f-empty", 1, 1)) === null);

    seedStored(fake, { id: "f-skipped", path: "skipped.d.ts", hash: null }, "");
    check("a file the parser skipped (no hash) has no content, by any route", (await read(fake, "f-skipped")) === null);
  }

  // --- read service: the database contradicting itself ---
  {
    const fake = new FakeSupabase();
    // stored status, but the content row holds other bytes than the hash names: refused, loudly
    fake.files.set("f-bad", { id: "f-bad", path: "bad.ts", hash: "a".repeat(64), lines: 1, content_status: "stored", organization_id: "org-a", analysis: null });
    fake.contents.push({ organization_id: "org-a", content_hash: "a".repeat(64), payload: payloadOf(asBytes("tampered body")), size: asBytes("tampered body").byteLength });
    let corrupted: unknown = null;
    try {
      await read(fake, "f-bad");
    } catch (error) {
      corrupted = error;
    }
    check("stored bytes that hash differently than their identity are refused as an IntegrityError", corrupted instanceof IntegrityError);

    // a payload that is not a bytea hex literal is refused the same way
    fake.files.set("f-hex", { id: "f-hex", path: "hex.ts", hash: "b".repeat(64), lines: 1, content_status: "stored", organization_id: "org-a", analysis: null });
    fake.contents.push({ organization_id: "org-a", content_hash: "b".repeat(64), payload: "definitely-not-hex", size: 4 });
    let badHex: unknown = null;
    try {
      await read(fake, "f-hex");
    } catch (error) {
      badHex = error;
    }
    check("a payload that cannot be bytes at all is refused as an IntegrityError", throws(badHex, "IntegrityError"));

    // stored claim with nothing behind it: a consistency error, never a null
    const spare = new FakeSupabase();
    seedStored(spare, { id: "f-lying", path: "lying.ts", organization_id: "org-lying" }, "const kept = true;\n");
    spare.contents = []; // the metadata says stored; the storage contradicts it
    let missing: unknown = null;
    try {
      await read(spare, "f-lying");
    } catch (error) {
      missing = error;
    }
    check("a stored claim with no content row is a ConsistencyError, not a null", missing instanceof ConsistencyError && (missing as Error).message.includes("claims its content is stored"));

    // an unknown content_status is the schema failing its own contract
    seedStored(fake, { id: "f-weird", path: "weird.ts" }, "const weird = 1;\n");
    fake.files.set("f-weird", { ...fake.files.get("f-weird")!, content_status: "almost" });
    let weird: unknown = null;
    try {
      await read(fake, "f-weird");
    } catch (error) {
      weird = error;
    }
    check("an unknown content_status is a ConsistencyError", throws(weird, "ConsistencyError", "the schema does not define"));
  }

  // --- absent-but-content: the metadata update lost, the storage won ---
  {
    const fake = new FakeSupabase();
    seedStored(fake, { id: "f-recover", path: "recover.ts", content_status: "absent" }, "const recovered = 1;\n");
    const fetch = fetchStub(() => {
      throw new Error("this scenario must not fetch — the content table is the record");
    });
    const out = await read(fake, "f-recover", fetch.fetchFile);
    check("content beats an outdated absent status: the verified bytes are served", out === "const recovered = 1;\n");
    check("no fetch happened for content the storage already holds", fetch.calls.length === 0);
    check("the lost metadata update is repeated by the read", fake.files.get("f-recover")!.content_status === "stored" && fake.fileUpdates.length === 1);

    // and when the bookkeeping update itself fails, the verified read survives it
    const sad = new FakeSupabase();
    seedStored(sad, { id: "f-retry", path: "retry.ts", content_status: "absent" }, "const retried = 2;\n");
    sad.failNextFilesUpdate = "connection reset";
    const kept = await read(sad, "f-retry");
    check("a failed metadata update never rejects a verified read", kept === "const retried = 2;\n");
    check("the row keeps saying absent after the failed update", sad.files.get("f-retry")!.content_status === "absent");
    const again = await read(sad, "f-retry");
    check("the next read flips the status (idempotent recovery)", again === "const retried = 2;\n" && sad.files.get("f-retry")!.content_status === "stored");
  }

  // --- the parser's line convention, against the parser itself ---
  check("sliceLines: first line of a LF file", sliceLines("one\ntwo\nthree", 1, 1) === "one");
  check("sliceLines: last line (no trailing newline)", sliceLines("one\ntwo\nthree", 3, 3) === "three");
  check("sliceLines: a multi-line window joins with LF", sliceLines("one\ntwo\nthree", 2, 3) === "two\nthree");
  check("sliceLines: a trailing newline ends the last line, not a new one", sliceLines("one\ntwo\n", 2, 2) === "two" && sliceLines("one\ntwo\n", 3, 3) === null);
  check("sliceLines: blank lines are lines of their own", sliceLines("a\n\n\nb", 2, 3) === "\n" && countLines("a\n\n\nb") === 4);
  check("sliceLines: a CRLF line is served without its terminator", sliceLines("one\r\ntwo\r\n", 1, 2) === "one\ntwo");
  check("sliceLines: a single-line file is its one line", sliceLines("only", 1, 1) === "only");
  check("sliceLines: an empty file has no line 1", sliceLines("", 1, 1) === null);
  check("sliceLines: the whole file equals its content-without-terminators", sliceLines("a\nb\nc", 1, 3) === "a\nb\nc");
  {
    let caught = 0;
    for (const [start, end] of [[0, 1], [1, 0], [-1, 1], [2, 1], [1.5, 2]]) {
      try {
        sliceLines("a\nb", start, end);
      } catch (error) {
        if (error instanceof RangeError) caught++;
      }
    }
    check("sliceLines rejects zero, negative, reversed and non-integer ranges out loud", caught === 5);
  }
  {
    const fake = new FakeSupabase();
    seedStored(fake, { id: "f-range", path: "ranged.ts" }, "one\ntwo\n");
    let past = null as unknown;
    try {
      await readLines(fake, "f-range", 0, 1);
    } catch (error) {
      past = error;
    }
    check("invalid line numbers fail before any database work", past instanceof RangeError);
    check("a range past the file's last line is null, not a clamp", (await readLines(fake, "f-range", 1, 3)) === null && (await readLines(fake, "f-range", 3, 3)) === null);
  }

  // --- read lines through the service, from real stored content ---
  {
    const fake = new FakeSupabase();
    seedStored(fake, { id: "f-lines", path: "lines.ts" }, "export const alpha = 1;\n\n  const spaced = '  kept  ';\nexport const omega = 3;\n");
    const first = await readLines(fake, "f-lines", 1, 1);
    const last = await readLines(fake, "f-lines", 4, 4);
    const middle = await readLines(fake, "f-lines", 2, 3);
    const whole = await readLines(fake, "f-lines", 1, 4);
    check("the first line is the first line", first === "export const alpha = 1;");
    check("the last line is the last line", last === "export const omega = 3;");
    check("a window keeps interior lines and interior whitespace", middle === "\n  const spaced = '  kept  ';");
    check("the whole file through lines is the text without the final newline", whole === "export const alpha = 1;\n\n  const spaced = '  kept  ';\nexport const omega = 3;");
  }

  // --- lazy backfill: the happy path ---
  {
    const fake = new FakeSupabase();
    const source = "export const fetched = 'by commit';\nexport function value(): number { return 1; }\n";
    seedAbsent(fake, { id: "f-backfill", path: "lib/fetched.ts" }, source);
    const fetch = fetchStub(() => Buffer.from(source, "utf8"));
    const out = await read(fake, "f-backfill", fetch.fetchFile);
    check("a backfilled file serves its exact source", out === source);
    check("the fetch was to the analysed repository, commit and path", fetch.calls.length === 1 && fetch.calls[0]!.repository.owner === "octo" && fetch.calls[0]!.repository.name === "lab" && fetch.calls[0]!.sha === COMMIT && fetch.calls[0]!.path === "lib/fetched.ts");
    check("the fetched bytes were stored under the parsed hash", fake.contents.length === 1 && fake.contents[0]!.content_hash === sha256(asBytes(source)) && Buffer.from(fake.contents[0]!.payload.slice(2), "hex").toString("utf8") === source);
    check("content was written conflict-safe and idempotent", fake.contentUpserts.length === 1 && fake.contentUpserts[0]!.rows.length === 1);
    check("the metadata update carried the whole guard — id, organization, hash, absent", fake.fileUpdates.length === 1 && fake.fileUpdates[0]!.filters["id"] === "f-backfill" && fake.fileUpdates[0]!.filters["organization_id"] === "org-a" && fake.fileUpdates[0]!.filters["hash"] === sha256(asBytes(source)) && fake.fileUpdates[0]!.filters["content_status"] === "absent");
    check("the row ends stored", fake.files.get("f-backfill")!.content_status === "stored");

    const second = await read(fake, "f-backfill", fetch.fetchFile);
    check("a second read serves from the store without fetching again", second === source && fetch.calls.length === 1);
    const line = await readLines(fake, "f-backfill", 2, 2);
    check("lines of the backfilled file are the parser's numbering", line === "export function value(): number { return 1; }");
  }

  // --- backfill: the sources of unavailability ---
  {
    // no analysis embed (nothing points at a repository) — never fetch a branch
    const orphan = new FakeSupabase();
    seedAbsent(orphan, { id: "f-orphan", path: "orphan.ts", analysis: null }, "const orphan = 1;\n");
    const nofa = fetchStub(() => Buffer.from("never", "utf8"));
    check("a file whose analysis is missing reads null, with no fetch at all", (await read(orphan, "f-orphan", nofa.fetchFile)) === null && nofa.calls.length === 0);

    // the analysed commit is not recorded — same refusal
    const noCommit = new FakeSupabase();
    seedAbsent(noCommit, { id: "f-nocommit", path: "nocommit.ts", analysis: { commit_sha: null, project: ROW_PROJECT } }, "const noCommit = 1;\n");
    const nofc = fetchStub(() => Buffer.from("never", "utf8"));
    check("a file whose analysed commit is missing reads null, never defaulting to a branch", (await read(noCommit, "f-nocommit", nofc.fetchFile)) === null && nofc.calls.length === 0);

    // the file is not at the analysed commit anymore
    const gone = new FakeSupabase();
    seedAbsent(gone, { id: "f-gone", path: "removed.ts" }, "const removed = 1;\n");
    const goneF = fetchStub(() => null);
    const goneOut = await read(gone, "f-gone", goneF.fetchFile);
    check("a path GitHub does not have at the analysed commit reads null", goneOut === null);
    check("a 404 at the analysed commit stores nothing and flips nothing", gone.contents.length === 0 && gone.files.get("f-gone")!.content_status === "absent");

    // GitHub is rate limited / the network is down: the transport error carries
    for (const [width, id, thrown] of [
      ["rate limit", "f-rate", new PipelineError("rate limit exceeded")],
      ["network", "f-net", new Error("connect ECONNRESET")],
    ] as const) {
      const bad = new FakeSupabase();
      seedAbsent(bad, { id, path: `${id}.ts` }, "const net = 1;\n");
      const badF = fetchStub(() => {
        throw thrown;
      });
      let error: unknown = null;
      try {
        await read(bad, id, badF.fetchFile);
      } catch (e) {
        error = e;
      }
      check(`an unavailable GitHub (${width}) is a truthful transport error, not a null`, error === thrown && bad.contents.length === 0 && bad.files.get(id)!.content_status === "absent");
    }
  }

  // --- backfill: refused and failed writes ---
  {
    // the remote disagrees with what the parser indexed: refused before any write
    const wrong = new FakeSupabase();
    const truth = "const truth = 1;\n";
    seedAbsent(wrong, { id: "f-mismatch", path: "mismatch.ts" }, truth);
    const wrongF = fetchStub(() => Buffer.from("const substituted = 9;\n", "utf8"));
    let mismatch: unknown = null;
    try {
      await read(wrong, "f-mismatch", wrongF.fetchFile);
    } catch (error) {
      mismatch = error;
    }
    check("GitHub bytes that do not hash to the parsed identity are refused as a ConsistencyError", mismatch instanceof ConsistencyError && (mismatch as Error).message.includes("hashes to"));
    check("a refused body is never stored, never marked", wrong.contents.length === 0 && wrong.files.get("f-mismatch")!.content_status === "absent");

    // the storage write fails: loud, nothing flipped
    const sad = new FakeSupabase();
    seedAbsent(sad, { id: "f-storefail", path: "storefail.ts" }, truth);
    const storeFailF = fetchStub(() => Buffer.from(truth, "utf8"));
    sad.failNextContentUpsert = "could not connect";
    let storage: unknown = null;
    try {
      await read(sad, "f-storefail", storeFailF.fetchFile);
    } catch (error) {
      storage = error;
    }
    check("a failed content write is an error, not a null", storage instanceof Error && storage.message.includes("could not connect") && sad.files.get("f-storefail")!.content_status === "absent" && sad.contents.length === 0);

    // the store's own confirmation of its write is refused once: loud, nothing flipped
    const liar = new FakeSupabase();
    seedAbsent(liar, { id: "f-lyingwrite", path: "lyingwrite.ts" }, truth);
    liar.loseOneConfirmation = true;
    let unconfirmed: unknown = null;
    try {
      await read(liar, "f-lyingwrite", fetchStub(() => Buffer.from(truth, "utf8")).fetchFile);
    } catch (error) {
      unconfirmed = error;
    }
    check("a write the store cannot confirm afterwards is an error, not a flip", unconfirmed instanceof Error && unconfirmed.message.includes("content row is not there"));
    check("the row keeps saying absent when the confirmation fails", liar.files.get("f-lyingwrite")!.content_status === "absent");

    // retry after that partial state: the content is there, absent saying so, and flips
    const retried = await read(liar, "f-lyingwrite");
    check("a retry after the unconfirmed write heals to stored", retried === truth && liar.files.get("f-lyingwrite")!.content_status === "stored" && liar.contents.length === 1);
  }

  // --- backfill: racing --- 
  {
    // two simultaneous reads of one absent file: both fetch (documented race), both land one row
    const fake = new FakeSupabase();
    const source = "const concurrent = true;\n";
    seedAbsent(fake, { id: "f-race", path: "race.ts" }, source);
    const fetch = fetchStub(() => Buffer.from(source, "utf8"));
    const [a, b] = await Promise.all([
      read(fake, "f-race", fetch.fetchFile),
      read(fake, "f-race", fetch.fetchFile),
    ]);
    check("two simultaneous backfills both serve the exact source", a === source && b === source);
    check("two simultaneous backfills fetch twice (documented: no distributed lock in this phase)", fetch.calls.length === 2);
    check("two simultaneous backfills land one content row and end stored", fake.contents.length === 1 && fake.files.get("f-race")!.content_status === "stored");
    check("the second metadata update was the no-op of the race both already won", fake.fileUpdates.filter((u) => u.applied === 1).length === 1 && fake.fileUpdates.filter((u) => u.applied === 0).length === 1);

    // a re-index replaces the row mid-backfill: the identity moved, nothing is stamped
    const replaced = new FakeSupabase();
    seedAbsent(replaced, { id: "f-moved", path: "moved.ts" }, source);
    const movedF = fetchStub(() => {
      replaced.files.set("f-moved", { ...replaced.files.get("f-moved")!, hash: "c".repeat(64) });
      return Buffer.from(source, "utf8");
    });
    const movedOut = await read(replaced, "f-moved", movedF.fetchFile);
    check("a backfill racing a re-index serves nothing stale (null)", movedOut === null);
    check("the moved row is never stamped stored, and its new hash has no content row", replaced.files.get("f-moved")!.content_status === "absent" && !replaced.contents.some((r) => r.content_hash === "c".repeat(64)));
    check("the verified bytes of the old identity stay in the content-addressed table (GC's business later)", replaced.contents.length === 1 && replaced.contents[0]!.content_hash === sha256(asBytes(source)));

    // the row vanished mid-backfill: same truthful null
    const vanished = new FakeSupabase();
    seedAbsent(vanished, { id: "f-vanish", path: "vanish.ts" }, source);
    const vanishF = fetchStub(() => {
      vanished.files.delete("f-vanish");
      return Buffer.from(source, "utf8");
    });
    const vanishOut = await read(vanished, "f-vanish", vanishF.fetchFile);
    check("a backfill whose file row died mid-flight reads null", vanishOut === null);
    check("a vanished row's content stays stored, addressed and harmless", vanished.contents.length === 1 && vanished.fileUpdates.every((u) => u.applied === 0));

    // a concurrent backfill wins the flip first: this one follows, not breaks
    const following = new FakeSupabase();
    seedAbsent(following, { id: "f-follow", path: "follow.ts" }, source);
    const followF = fetchStub(() => {
      following.files.set("f-follow", { ...following.files.get("f-follow")!, content_status: "stored" });
      return Buffer.from(source, "utf8");
    });
    const followOut = await read(following, "f-follow", followF.fetchFile);
    check("a backfill that lost the flag race still serves its verified bytes", followOut === source);
    check("the winner's flip stands, no double write, no error", following.contents.length === 1 && following.fileUpdates.every((u) => u.applied === 0));
  }

  // --- the parser's line numbers, read back from the service ---
  {
    const fixture = makeFixture({
      "package.json": '{ "name": "fixture", "version": "1.0.0", "dependencies": { "next": "16.0.0" } }',
      "app/api/ping/route.ts": "export async function GET() {\n  return Response.json({ ok: true });\n}\n",
      "lib/alpha.ts": 'import { betaValue } from "./beta";\n\nexport function alphaCalc(): number {\n  return betaValue * 2;\n}\n\nfunction hidden(): string {\n  return "internal";\n}\n',
      "lib/beta.ts": "export const betaValue = 5;\n",
    });
    const selection = selectFiles(fixture.root);
    const parsed = parseSelection(selection);
    const contents = new Map<string, string>(selection.walk.candidates.map((c) => [c.path, c.content]));

    const fake = new FakeSupabase();
    const rowOf = new Map<string, string>();
    for (const file of parsed.files) {
      const text = contents.get(file.path);
      if (text === undefined) {
        fail(`the fixture text of ${file.path}`);
        continue;
      }
      const row = seedStored(fake, { id: `f-${hashOf(file.path)}`, path: file.path }, text);
      rowOf.set(file.path, row.id);
    }

    let agreed = 0;
    let disputed = 0;
    for (const routes of parsed.routes.filter((r) => rowOf.has(r.file))) {
      const line = await readLines(fake, rowOf.get(routes.file)!, routes.line, routes.line);
      const ok = line !== null && line.includes(routes.method);
      if (ok) agreed++;
      else {
        disputed++;
        fail(`route ${routes.method} on ${routes.file}:${routes.line} reads back as ${JSON.stringify(line)}`);
      }
    }
    for (const symbol of parsed.symbols.filter((s) => rowOf.has(s.file))) {
      const line = await readLines(fake, rowOf.get(symbol.file)!, symbol.line, symbol.line);
      const ok = line !== null && line.includes(symbol.name);
      if (ok) agreed++;
      else {
        disputed++;
        fail(`symbol ${symbol.name} on ${symbol.file}:${symbol.line} reads back as ${JSON.stringify(line)}`);
      }
    }
    for (const edge of parsed.edges.filter((e) => rowOf.has(e.source) && rowOf.has(e.target))) {
      const line = await readLines(fake, rowOf.get(edge.source)!, edge.line, edge.line);
      const ok = line !== null && line.includes(edge.specifier);
      if (ok) agreed++;
      else {
        disputed++;
        fail(`edge ${edge.source} -> ${edge.target}:${edge.line} reads back as ${JSON.stringify(line)}`);
      }
    }
    check(`every route, symbol and import line the parser recorded reads back to its own text (${agreed} positions)`, disputed === 0 && agreed > 0);

    let spanning = 0;
    for (const file of parsed.files) {
      const whole = await readLines(fake, rowOf.get(file.path)!, 1, file.lines);
      const penult = await readLines(fake, rowOf.get(file.path)!, 1, file.lines + 1);
      if (whole !== null && penult === null) spanning++;
      else fail(`the line bounds of ${file.path} (lines=${file.lines}) disagree: 1..lines=${JSON.stringify(whole)}, 1..lines+1=${JSON.stringify(penult)}`);
    }
    check("files.lines, the parser's count, is exactly the read service's EOF boundary", spanning === parsed.files.length);

    fixture.cleanup();
  }
}

// ---- fixture helpers ----

function makeFixture(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "content-read-"));
  for (const [rel, body] of Object.entries(files)) {
    const absolute = path.join(root, rel);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, body);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const hashOf = (s: string): string =>
  [...s].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 2147483647, 7).toString(36);

main()
  .catch((error: unknown) => {
    console.error("\nThe suite did not finish:", error);
    results.push(`FAIL  the suite did not finish: ${error instanceof Error ? error.message : String(error)}`);
  })
  .finally(() => {
    console.log("");
    for (const line of results) console.log(line);
    const failedLines = results.filter((r) => r.startsWith("FAIL")).length;
    console.log(failedLines === 0 ? "\nEvery check passed." : `\n${failedLines} check(s) failed.`);
    process.exit(failedLines === 0 ? 0 : 1);
  });
