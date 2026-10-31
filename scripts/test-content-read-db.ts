// Exercises the content read service against the LIVE Supabase project —
// the things no fake can prove: the whole read flow against real Postgres,
// the conditional metadata update's row-count semantics (how many rows the
// guarded update actually touched), and the immutable content row round
// trip the service relies on.
//
//   node --env-file=.env.local scripts/test-content-read-db.ts
//
// The admin client plays both the read client and the backfill's writer —
// it bypasses row policies, so this proves the service's own logic and the
// SQL it issues, never the policies: those are scripts/test-content-rls.ts's
// business. GitHub is not touched either: fetchFileAt is injected, so the
// commit-pinned request shape is the fake suite's assertion. Everything
// lands in a throwaway organization; at the end that organization is
// removed, files and analyses and content follow it out by cascade, and the
// script verifies nothing of the test prefix remains.
//
// Deliberately NOT part of pnpm test: it touches the linked project.

import { countLines } from "../lib/parser/walk.ts";
import { sha256 } from "../lib/content/store.ts";
import { ConsistencyError, getFileContent, getFileLines } from "../lib/content/read.ts";
import { createAdminSupabase } from "../lib/supabase/admin.ts";

const TEST_PREFIX = "content_read_db_test_";

const checks: string[] = [];
const pass = (m: string) => checks.push(`ok    ${m}`);
const fail = (m: string) => checks.push(`FAIL  ${m}`);
const check = (m: string, condition: boolean) => (condition ? pass(m) : fail(m));

type TestClient = ReturnType<typeof createAdminSupabase>;

async function cleanup(db: TestClient): Promise<string[]> {
  const notes: string[] = [];
  const removed = await db.from("organizations").delete().like("id", `${TEST_PREFIX}%`);
  if (removed.error) notes.push(`note   removing the test organizations failed: ${removed.error.message}`);
  else notes.push("ok    the test organizations are gone, and their content with them");
  for (const [table, note] of [
    ["file_contents", "content"],
    ["files", "files"],
    ["analyses", "analyses"],
  ] as const) {
    const { count, error } = await db.from(table).select("*", { count: "exact" }).like("organization_id", `${TEST_PREFIX}%`);
    if (error) notes.push(`note   the tidy check of ${table} itself failed: ${error.message}`);
    else if (count === 0) notes.push(`ok    no test ${note} row remains`);
    else notes.push(`FAIL  ${count} test ${note} row(s) remain`);
  }
  return notes;
}

async function rowStatus(db: TestClient, fileId: string): Promise<string | null> {
  const { data, error } = await db.from("files").select("content_status, hash").eq("id", fileId).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.content_status ?? null;
}

async function main(): Promise<void> {
  const db = createAdminSupabase();
  // Leave nothing behind by a previous run, then begin.
  await db.from("organizations").delete().like("id", `${TEST_PREFIX}%`);

  const organizationId = `${TEST_PREFIX}${Date.now()}`;
  const created = await db.from("organizations").insert({ id: organizationId });
  if (created.error) throw new Error(`Creating the test organization failed: ${created.error.message}`);

  const projectId = crypto.randomUUID();
  const analysisId = crypto.randomUUID();
  const fileId = crypto.randomUUID();

  const project = await db.from("projects").insert({ id: projectId, organization_id: organizationId, repo_owner: "cartograph-lab", repo_name: "fixture" });
  if (project.error) throw new Error(`Creating the test project failed: ${project.error.message}`);
  const analysis = await db.from("analyses").insert({
    id: analysisId,
    organization_id: organizationId,
    project_id: projectId,
    status: "complete",
    commit_sha: "a".repeat(40),
    // any complete analysis carries its coverage report and the stage it
    // finished in; the check constraints ask
    coverage: {},
    detected_projects: [],
    schema_version: 5,
    stage: "store",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  });
  if (analysis.error) throw new Error(`Creating the test analysis failed: ${analysis.error.message}`);

  const source = "export const live = 'read back over the wire';\nexport function value(): number {\n  return 1;\n}\n";
  const bytes = Buffer.from(source, "utf8");
  const hash = sha256(bytes);
  const file = await db.from("files").insert({
    id: fileId,
    organization_id: organizationId,
    analysis_id: analysisId,
    path: "lib/live.ts",
    module: "lib",
    lines: countLines(source),
    bytes: bytes.byteLength,
    hash,
    fan_in: 0,
    fan_out: 0,
    // content_status left at the schema's own 'absent' default
  });
  if (file.error) throw new Error(`Creating the test file failed: ${file.error.message}`);

  // ---- the happy backfill ----
  const fetches: string[] = [];
  const fetchFile = async (_repository: { owner: string; name: string }, sha: string, filePath: string) => {
    fetches.push(`${sha.slice(0, 7)} ${filePath}`);
    return bytes;
  };

  const served = await getFileContent(db, fileId, { writer: db, fetchFile });
  check("a backfilled file serves its exact source", served === source);
  check("the fetch was at the analysed commit and the exact path", fetches.length === 1 && fetches[0] === `${"a".repeat(7)} lib/live.ts`);
  check("the row was flagged stored in the real database", (await rowStatus(db, fileId)) === "stored");
  const stored = await db.from("file_contents").select("size").eq("organization_id", organizationId).eq("content_hash", hash).maybeSingle();
  check("the content landed under the parsed identity", stored.data !== null && stored.data.size === bytes.byteLength);

  const servedAgain = await getFileContent(db, fileId, { writer: db, fetchFile });
  check("a second read serves from the store without fetching", servedAgain === source && fetches.length === 1);

  const firstLines = await getFileLines(db, fileId, 1, 3, { writer: db, fetchFile });
  check("lines read back in the parser's numbering, exactly", firstLines === "export const live = 'read back over the wire';\nexport function value(): number {\n  return 1;");
  const past = await getFileLines(db, fileId, 1, countLines(source) + 1, { writer: db, fetchFile });
  check("a range past the real EOF reads null", past === null);

  // ---- the metadata lost, the content stored: an outdated 'absent' heals ----
  const flip = await db.from("files").update({ content_status: "absent" }).eq("id", fileId);
  if (flip.error) throw new Error(`Resetting the status failed: ${flip.error.message}`);
  const healed = await getFileContent(db, fileId, { writer: db, fetchFile });
  check("content beats an outdated absent status over the wire too", healed === source && fetches.length === 1);
  check("the outdated status was flipped by the read", (await rowStatus(db, fileId)) === "stored");

  // ---- a re-index moves the row mid-backfill: nothing is stamped ----
  await db.from("files").update({ content_status: "absent" }).eq("id", fileId);
  // A re-index replaces this identity: its old content row stops being
  // referenced. Remove it so the mid-flight fetch goes through the backfill
  // path instead of finding what is already stored.
  await db.from("file_contents").delete().eq("organization_id", organizationId).eq("content_hash", hash);
  const movedHash = "b".repeat(64);
  const midflight = async (_repository: { owner: string; name: string }, _sha: string, _filePath: string) => {
    await db.from("files").update({ hash: movedHash }).eq("id", fileId);
    return bytes;
  };
  const stale = await getFileContent(db, fileId, { writer: db, fetchFile: midflight });
  check("a backfill racing a re-index serves nothing stale (null)", stale === null);
  check("the moved row is never stamped, and the new identity has no content row", (await rowStatus(db, fileId)) === "absent");
  const underMoved = await db.from("file_contents").select("size").eq("organization_id", organizationId).eq("content_hash", movedHash).maybeSingle();
  check("no content row was written under the moved identity", underMoved.data === null);

  // ---- the remote disagrees with the parsed identity: refused ----
  await db.from("file_contents").delete().eq("organization_id", organizationId).eq("content_hash", hash);
  await db.from("files").update({ hash, content_status: "absent" }).eq("id", fileId);
  const mismatch = async () => Buffer.from("export const substituted = 9;\n", "utf8");
  let refused: unknown = null;
  try {
    await getFileContent(db, fileId, { writer: db, fetchFile: mismatch });
  } catch (error) {
    refused = error;
  }
  check("GitHub bytes that hash elsewhere are refused as a ConsistencyError", refused instanceof ConsistencyError);
  check("a refused body stores nothing under the parsed identity", (await rowStatus(db, fileId)) === "absent");

  // ---- the path is gone at the analysed commit ----
  const deleted = await getFileContent(db, fileId, { writer: db, fetchFile: async () => null });
  check("a path missing at the analysed commit reads null, truthfully", deleted === null);
  check("a 404 at the analysed commit stores and flips nothing", (await rowStatus(db, fileId)) === "absent");
}

main()
  .catch((error: unknown) => {
    fail(`the suite itself failed: ${error instanceof Error ? error.message : String(error)}`);
  })
  .finally(async () => {
    try {
      const db = createAdminSupabase();
      checks.push(...(await cleanup(db)));
    } catch (error) {
      checks.push(`note   the cleaner itself failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const failed = checks.filter((c) => c.startsWith("FAIL")).length;
    console.log("");
    for (const line of checks) console.log(line);
    console.log(failed === 0 ? "\nEvery live check passed." : `\n${failed} live check(s) failed.`);
    process.exit(failed === 0 ? 0 : 1);
  });
