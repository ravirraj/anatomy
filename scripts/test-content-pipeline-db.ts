// Exercises the batched content write against the LIVE Supabase project —
// the two things no fake can prove: PostgREST accepts the batched bytea
// write and its hex encoding, and ON CONFLICT DO NOTHING collapses duplicates
// inside one bulk request as the store's logic promises.
//
//   node --env-file=.env.local scripts/test-content-pipeline-db.ts
//
// Writes go through the admin client (the pipeline's writer) into a
// throwaway organization; at the end that organization is removed, the
// content follows it out by the foreign key's on delete cascade, and the
// script verifies no row of the failAt prefix remains. Failure paths are the
// fake suite's and the RLS suite's business; this one is about the wire.
//
// Deliberately NOT part of pnpm test: it touches the linked project.

import { existsContent, getContent, putContentsBatch } from "../lib/content/store.ts";
import { createAdminSupabase } from "../lib/supabase/admin.ts";

const TEST_ORG_PREFIX = "pipeline_content_db_test_";

const checks: string[] = [];
const pass = (m: string) => checks.push(`ok    ${m}`);
const fail = (m: string) => checks.push(`FAIL  ${m}`);
const check = (m: string, condition: boolean) => (condition ? pass(m) : fail(m));

// Rows of test content under one of the test organizations.
type TestClient = ReturnType<typeof createAdminSupabase>;

async function contentRowCount(db: TestClient, organizationId: string): Promise<number> {
  const { count, error } = await db.from("file_contents").select("content_hash", { count: "exact" }).eq("organization_id", organizationId);
  if (error) throw new Error(error.message);
  return count!;
}

async function cleaner(db: TestClient): Promise<string[]> {
  const notes: string[] = [];
  const removed = await db.from("organizations").delete().like("id", `${TEST_ORG_PREFIX}%`);
  if (removed.error) notes.push(`note   removing the test organizations failed: ${removed.error.message}`);
  else notes.push("ok    the test organizations are gone, and their content with them");
  const { count, error } = await db.from("file_contents").select("content_hash", { count: "exact" }).like("organization_id", `${TEST_ORG_PREFIX}%`);
  if (error) notes.push(`note   the tidy check itself failed: ${error.message}`);
  else if (count === 0) notes.push("ok    no content row with a test organization id remains");
  else notes.push(`FAIL  ${count} content row(s) with a test organization id remain`);
  return notes;
}

async function main(): Promise<void> {
  const db = createAdminSupabase();
  const organizationId = TEST_ORG_PREFIX + Date.now();
  const otherOrg = organizationId + "_other";

  // Leave nothing behind by a previous run, then begin.
  await db.from("organizations").delete().like("id", `${TEST_ORG_PREFIX}%`);

  const created = await db.from("organizations").insert({ id: organizationId });
  if (created.error) throw new Error(`Creating the test organization failed: ${created.error.message}`);

  // One body twice, one body once — one request.
  const body = Buffer.from("export const shared = 'one batched body on the wire';\n", "utf8");
  const other = Buffer.from("export const single = 'and one distinct body';\n", "utf8");
  const outcomes = await putContentsBatch(db, organizationId, [
    { body },
    { body: other },
    { body }, // duplicate inside the same request
  ]);
  const [shared, single, sharedAgain] = outcomes;
  check("a batched write reports every body stored", outcomes.every((o) => o.stored));
  check("the duplicate collapses to the canonical identity", shared.stored && sharedAgain.stored && shared.contentHash === sharedAgain.contentHash);
  check("two distinct bodies left exactly two rows", (await contentRowCount(db, organizationId)) === 2);
  if (!shared.stored || !single.stored) {
    fail("the write's own reference for reading back is missing");
    return;
  }

  // The bytes are recoverable, exact, and identity-verified on the way out.
  const round = await getContent(db, organizationId, shared.contentHash);
  check("the stored body reads back byte for byte", round !== null && Buffer.from(round).equals(body));
  check("the other body reads back byte for byte", Buffer.from((await getContent(db, organizationId, single.contentHash)) ?? []).equals(other));

  // A second batch over the same bodies writes nothing new and rewrites nothing.
  const again = await putContentsBatch(db, organizationId, [{ body }, { body: other }]);
  check("a second batch over the same bodies is a no-write", again.every((o) => o.stored) && (await contentRowCount(db, organizationId)) === 2);
  check("the identity answers present for what is there", (await existsContent(db, organizationId, shared.contentHash)) === true);

  // Another organization cannot see the first's content.
  const second = await db.from("organizations").insert({ id: otherOrg });
  if (second.error) throw new Error(`Creating the second test organization failed: ${second.error.message}`);
  check("another organization holds nothing from the first's writes", (await contentRowCount(db, otherOrg)) === 0);
}

main()
  .catch((error: unknown) => {
    fail(`the suite itself failed: ${error instanceof Error ? error.message : String(error)}`);
  })
  .finally(async () => {
    try {
      const db = createAdminSupabase();
      const notes = await cleaner(db);
      checks.push(...notes);
    } catch (error) {
      checks.push(`note   the cleaner itself failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const failed = checks.filter((c) => c.startsWith("FAIL")).length;
    console.log("");
    for (const line of checks) console.log(line);
    console.log(failed === 0 ? "\nEvery wire check passed." : `\n${failed} wire check(s) failed.`);
    process.exit(failed === 0 ? 0 : 1);
  });
