// Checks the content store: lib/content/store.ts against a fake Supabase
// client, so the store's own logic — hashing, idempotent writes, integrity
// verification on read — is tested without a database.
//
//   node scripts/test-content-store.ts
//
// This suite proves the module's client contract, nothing more: it cannot
// prove the database's row policies. What only a real database can prove —
// that a member of one organization cannot read another's content — is the
// scripts/test-content-rls.ts integration test, which needs a real
// Postgres. Nothing here claims RLS; the fake's organization filtering is
// the client's own query, not a security boundary.

import { MAX_CONTENT_BYTES, existsContent, getContent, putContents, sha256 } from "../lib/content/store.ts";
import { IntegrityError, type Db } from "../lib/content/types.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);
const check = (message: string, condition: boolean) => {
  if (condition) pass(message);
  else fail(message);
};

// A fake of exactly the calls store.ts makes: upsert with ignoreDuplicates,
// and select(...).eq(...).eq(...).maybeSingle(). Rows mirror the real row's
// shape, with the payload held in the bytea wire form ("\x…"), as PostgREST
// would send it.
class FakeContentsTable {
  rows: { organization_id: string; content_hash: string; payload: string; size: number }[] = [];
  failNextWith: string | null = null;

  async upsert(values: { organization_id: string; content_hash: string; payload: string; size: number }[], opts: { onConflict: string; ignoreDuplicates: boolean }) {
    if (opts.onConflict !== "organization_id,content_hash" || !opts.ignoreDuplicates) {
      return { error: { message: "expected this test to write conflict-safe" } };
    }
    if (this.failNextWith) {
      const error = this.failNextWith;
      this.failNextWith = null;
      return { error: { message: error } };
    }
    for (const row of values) {
      if (this.rows.some((r) => r.organization_id === row.organization_id && r.content_hash === row.content_hash)) continue;
      this.rows.push(row);
    }
    return { error: null };
  }

  // The columns argument selects which fields come back; the fake keeps
  // every field of its rows, so the argument has nothing to do here.
  // The columns mirror the real client: the fake picks only the fields the
  // caller asked for from each matching row, so content never reaches a read
  // that did not ask for the payload.
  select(columns: string) {
    const wanted = columns.split(",").map((c) => c.trim());
    const eqs: [string, string][] = [];
    const builder = {
      eq(column: string, value: string) {
        eqs.push([column, value]);
        return builder;
      },
      // The first matching row, as the real client's maybeSingle gives back.
      maybeSingle() {
        const row = table.rows.find((r) => eqs.every(([c, v]) => (r as Record<string, unknown>)[c] === v));
        return { data: row === undefined ? null : Object.fromEntries(wanted.map((c) => [c, (row as Record<string, unknown>)[c]])), error: null };
      },
    };
    return builder;
  }
}

const table = new FakeContentsTable();
const db = {
  from(name: string) {
    if (name !== "file_contents") throw new Error(`this test only knows file_contents, got ${name}`);
    return table;
  },
} as unknown as Db;

const A = "org_a";
const B = "org_b";

const text = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

async function main(): Promise<void> {
  // Store new content.
  const bytes = text("const greeting = 'hello world';\n");
  const first = await putContents(db, A, bytes);
  check("storing new content records the identity the bytes hash to", first.contentHash === sha256(bytes) && first.size === bytes.byteLength);
  check("storing new content inserts a row", table.rows.length === 1);

  // Retrieve stored content.
  const back = await getContent(db, A, first.contentHash);
  check("the stored bytes come back exactly", back !== null && Buffer.from(back).equals(Buffer.from(bytes)));

  // Binary data survives: bytes that are not valid UTF-8 must round-trip.
  const binary = new Uint8Array([0x66, 0xff, 0x0a, 0xfe, 0x00, 0x01, 0x68, 0x69]);
  const binaryRef = await putContents(db, A, binary);
  const binaryBack = await getContent(db, A, binaryRef.contentHash);
  check("binary content survives byte for byte", binaryBack !== null && Buffer.from(binaryBack).equals(Buffer.from(binary)));

  // Empty content is a real body with a real hash.
  const empty = await putContents(db, A, new Uint8Array(0));
  check("empty content is stored under the empty string's hash", empty.size === 0 && empty.contentHash === sha256(new Uint8Array(0)));

  // Store identical content twice: one row.
  const again = await putContents(db, A, bytes);
  check("storing the same body again returns the same identity", again.contentHash === first.contentHash && again.size === first.size);

  const before = table.rows.length;
  await putContents(db, A, bytes);
  await putContents(db, A, bytes);
  check("storing the same body repeatedly stays one row", table.rows.length === before);

  // The hash is never whatever a caller says: only the bytes have a voice.
  // (putContents takes no hash argument at all; a forged identity has to be
  // planted in the store directly, which the next case does.)

  // Identical content in two organizations: separate rows, isolated reads.
  const toB = await putContents(db, B, bytes);
  check("another organization gets its own row", table.rows.length === before + 1);
  const fromB = await getContent(db, B, toB.contentHash);
  check("the other organization reads its own copy", fromB !== null && Buffer.from(fromB).equals(Buffer.from(bytes)));

  // The fake filters by organization in the query, as the real policy does
  // over the wire. This is the client contract, NOT proof of RLS.
  const otherOrgRead = await getContent(db, "org_someone_else", toB.contentHash);
  check("a query for an organization with no row returns null (application-level)", otherOrgRead === null);

  // Retrieve missing content: null, not an error.
  const absent = sha256(text("a body that was never stored"));
  check("content that does not exist reads as null", (await getContent(db, A, absent)) === null);
  check("existence of content that does not exist is false", (await existsContent(db, A, absent)) === false);
  check("existence of stored content is true", (await existsContent(db, A, first.contentHash)) === true);

  // Invalid hashes are rejected before the database is asked.
  for (const bad of ["nothash", "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855", "abc,def".repeat(9)]) {
    let rejected = false;
    try {
      await getContent(db, A, bad);
    } catch (error) {
      rejected = error instanceof IntegrityError;
    }
    check(`a malformed hash (${bad.slice(0, 8)}…) is rejected`, rejected);
  }

  // A corrupted payload is an integrity failure, not damaged content:
  // flip one byte of the stored text.
  const victim = table.rows.find((r) => r.organization_id === A && r.content_hash === first.contentHash)!;
  const original = victim.payload;
  victim.payload = "\\x" + "ff" + original.slice(4);
  let integrity = false;
  try {
    await getContent(db, A, first.contentHash);
  } catch (error) {
    integrity = error instanceof IntegrityError;
  }
  check("corrupted stored bytes are refused, not served", integrity);
  victim.payload = original;

  // A wrong size is an integrity failure too.
  victim.size += 1;
  integrity = false;
  try {
    await getContent(db, A, first.contentHash);
  } catch (error) {
    integrity = error instanceof IntegrityError;
  }
  check("a stored size that disagrees with the bytes is refused", integrity);
  victim.size -= 1;

  // Immutable content is never overwritten: plant a different body under an
  // identity, and storing the body that identity belongs to must leave the
  // first write standing.
  const planted = text("the first thing ever stored under this identity");
  const forged = sha256(text("the body that would have replaced it, if overwrites existed"));
  table.rows.push({ organization_id: A, content_hash: forged, payload: "\\x" + Buffer.from(planted).toString("hex"), size: planted.byteLength });
  const collision = await putContents(db, A, text("the body that would have replaced it, if overwrites existed"));
  const kept = await getContent(db, A, forged);
  check("a body already under an identity is never rewritten", Buffer.from(kept!).equals(Buffer.from(planted)));
  check("the second write reports the same identity, unchanged", collision.contentHash === forged);

  // A database failure surfaces as an error, and nothing is returned.
  table.failNextWith = "connection refused";
  let surfaced = false;
  try {
    await putContents(db, A, text("unstored because the database refused"));
  } catch (error) {
    surfaced = error instanceof Error && error.message.startsWith("Storing content failed:");
  }
  check("a database failure on write surfaces as an error", surfaced);

  // Anything the parser would refuse is refused here too: storage only
  // holds what the parser parsed.
  let oversized = false;
  try {
    await putContents(db, A, new Uint8Array(MAX_CONTENT_BYTES + 1));
  } catch (error) {
    oversized = error instanceof Error && error.message.includes("never stored");
  }
  check("content beyond the parser's own limit is refused", oversized);

  // Grammar check: the exact bytes at the moment of storage.
  const known = text("anatomy");
  const ref = await putContents(db, B, known);
  check("the stored hash is the sha256 of the exact bytes", ref.contentHash === "dd54b40a55209f36b045f833d6f8e1390b60ff12a59b41ce23fec8bde75f91f5");
}

main().finally(() => {
  console.log("");
  for (const line of results) console.log(line);
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
});
