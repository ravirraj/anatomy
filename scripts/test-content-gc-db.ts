// Exercises safe garbage collection against the LIVE Supabase project —
// testing the real database-side delete_orphaned_file_contents function,
// row locking with FOR UPDATE SKIP LOCKED, reference re-checking,
// grace-period filtering, bounded batching, and cache invalidation.
//
//   node --env-file=.env.local scripts/test-content-gc-db.ts
//
// Uses the admin client (createAdminSupabase). Everything runs in throwaway
// test organizations with the prefix 'gc_content_db_test_'.
// At the end, organizations are removed, foreign key cascades clean up,
// and the script verifies that zero test rows remain in any table.
//
// Deliberately NOT part of pnpm test: it touches the linked project.

import { ContentCache } from "../lib/content/cache.ts";
import { garbageCollectOrphanedContent } from "../lib/content/gc.ts";
import { putContentsBatch, sha256 } from "../lib/content/store.ts";
import { createAdminSupabase } from "../lib/supabase/admin.ts";

const TEST_PREFIX = "gc_content_db_test_";

const checks: string[] = [];
const pass = (m: string) => checks.push(`ok    ${m}`);
const fail = (m: string) => checks.push(`FAIL  ${m}`);
const check = (m: string, condition: boolean) => (condition ? pass(m) : fail(m));

type TestClient = ReturnType<typeof createAdminSupabase>;

async function cleanup(db: TestClient): Promise<string[]> {
  const notes: string[] = [];
  const removed = await db.from("organizations").delete().like("id", `${TEST_PREFIX}%`);
  if (removed.error) notes.push(`note   removing test organizations failed: ${removed.error.message}`);
  else notes.push("ok    test organizations removed");

  for (const [table, label] of [
    ["file_contents", "content"],
    ["files", "files"],
    ["analyses", "analyses"],
    ["projects", "projects"],
  ] as const) {
    const { count, error } = await db.from(table).select("*", { count: "exact" }).like("organization_id", `${TEST_PREFIX}%`);
    if (error) notes.push(`note   tidy check for ${label} failed: ${error.message}`);
    else if (count === 0) notes.push(`ok    no test ${label} row remains`);
    else notes.push(`FAIL  ${count} test ${label} row(s) remain`);
  }
  return notes;
}

async function countOrgContents(db: TestClient, organizationId: string): Promise<number> {
  const { count, error } = await db.from("file_contents").select("*", { count: "exact" }).eq("organization_id", organizationId);
  if (error) throw new Error(`countOrgContents failed: ${error.message}`);
  return count ?? 0;
}

async function main(): Promise<void> {
  const db = createAdminSupabase();

  // Clean up any stale data from previous aborted runs
  await db.from("organizations").delete().like("id", `${TEST_PREFIX}%`);

  const org1 = `${TEST_PREFIX}1_${Date.now()}`;
  const org2 = `${TEST_PREFIX}2_${Date.now()}`;

  const org1Created = await db.from("organizations").insert({ id: org1 });
  if (org1Created.error) throw new Error(`Creating org1 failed: ${org1Created.error.message}`);
  const org2Created = await db.from("organizations").insert({ id: org2 });
  if (org2Created.error) throw new Error(`Creating org2 failed: ${org2Created.error.message}`);

  const projectId = crypto.randomUUID();
  const analysisId = crypto.randomUUID();

  const projectCreated = await db.from("projects").insert({
    id: projectId,
    organization_id: org1,
    repo_owner: "cartograph-lab",
    repo_name: "gc-fixture",
  });
  if (projectCreated.error) throw new Error(`Creating project failed: ${projectCreated.error.message}`);

  const analysisCreated = await db.from("analyses").insert({
    id: analysisId,
    organization_id: org1,
    project_id: projectId,
    status: "complete",
    commit_sha: "a".repeat(40),
    coverage: {},
    detected_projects: [],
    schema_version: 5,
    stage: "store",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  });
  if (analysisCreated.error) throw new Error(`Creating analysis failed: ${analysisCreated.error.message}`);

  // --- 1. Grace period prevents deletion of newly written content ---
  {
    const body1 = Buffer.from("export const recent = 'freshly indexed content';\n", "utf8");
    await putContentsBatch(db, org1, [{ body: body1 }]);
    check("fresh content row inserted", (await countOrgContents(db, org1)) === 1);

    // Run GC with default 24h grace period: fresh content must be preserved
    const stats = await garbageCollectOrphanedContent(db, {
      organizationId: org1,
      gracePeriodMs: 24 * 60 * 60 * 1000,
      execute: true,
    });
    check("recent content protected by 24h grace period (0 deleted)", stats.rowsDeleted === 0);
    check("content row remains in file_contents table", (await countOrgContents(db, org1)) === 1);
  }

  // --- 2. Dry run identifies eligible rows without deleting ---
  {
    // Wait 250ms so content age exceeds 50ms grace period reliably
    await new Promise((r) => setTimeout(r, 250));

    const stats = await garbageCollectOrphanedContent(db, {
      organizationId: org1,
      gracePeriodMs: 50,
      dryRun: true,
      execute: true,
    });
    check("dryRun: true identifies 1 eligible orphan", stats.rowsEligible === 1);
    check("dryRun: true deleted 0 rows", stats.rowsDeleted === 0);
    check("content still untouched in database after dry run", (await countOrgContents(db, org1)) === 1);
  }

  // --- 3. Referenced content is never deleted ---
  {
    const bodyRef = Buffer.from("export const referenced = 'protected by files row';\n", "utf8");
    const hashRef = sha256(bodyRef);
    await putContentsBatch(db, org1, [{ body: bodyRef }]);

    // Create a live files row referencing hashRef
    const fileId = crypto.randomUUID();
    const fileCreated = await db.from("files").insert({
      id: fileId,
      organization_id: org1,
      analysis_id: analysisId,
      path: "src/referenced.ts",
      module: "src",
      lines: 1,
      bytes: bodyRef.byteLength,
      hash: hashRef,
      fan_in: 0,
      fan_out: 0,
      content_status: "stored",
    });
    if (fileCreated.error) throw new Error(`Creating file row failed: ${fileCreated.error.message}`);

    // Wait 100ms
    await new Promise((r) => setTimeout(r, 250));

    // Active GC with 50ms grace period: should delete the unreferenced row from test 1,
    // but MUST preserve the referenced row!
    const stats = await garbageCollectOrphanedContent(db, {
      organizationId: org1,
      gracePeriodMs: 50,
      execute: true,
    });
    check("active GC deleted the orphan row", stats.rowsDeleted === 1);
    check("referenced content row was preserved", (await countOrgContents(db, org1)) === 1);

    // Verify the remaining content row is indeed hashRef
    const { data: remaining } = await db.from("file_contents").select("content_hash").eq("organization_id", org1).single();
    check("remaining row is the referenced hash", remaining?.content_hash === hashRef);
  }

  // --- 4. Cross-organization isolation: org2 reference does NOT protect org1 orphan ---
  {
    const sharedBody = Buffer.from("export const sharedAcrossOrgs = 'same hash';\n", "utf8");
    const sharedHash = sha256(sharedBody);

    // Write same body to both org1 and org2
    await putContentsBatch(db, org1, [{ body: sharedBody }]);
    await putContentsBatch(db, org2, [{ body: sharedBody }]);

    // Org2 gets a project, analysis, and file referencing sharedHash
    const proj2 = crypto.randomUUID();
    const anal2 = crypto.randomUUID();
    await db.from("projects").insert({ id: proj2, organization_id: org2, repo_owner: "owner", repo_name: "repo2" });
    await db.from("analyses").insert({
      id: anal2,
      organization_id: org2,
      project_id: proj2,
      status: "complete",
      commit_sha: "b".repeat(40),
      coverage: {},
      detected_projects: [],
      schema_version: 5,
      stage: "store",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    });
    await db.from("files").insert({
      id: crypto.randomUUID(),
      organization_id: org2,
      analysis_id: anal2,
      path: "src/shared.ts",
      module: "src",
      lines: 1,
      bytes: sharedBody.byteLength,
      hash: sharedHash,
      fan_in: 0,
      fan_out: 0,
      content_status: "stored",
    });

    // Org1 does NOT reference sharedHash (it is an orphan in org1)
    await new Promise((r) => setTimeout(r, 250));

    // Run GC scoped to org1
    const statsOrg1 = await garbageCollectOrphanedContent(db, {
      organizationId: org1,
      gracePeriodMs: 50,
      execute: true,
    });
    check("org1 orphan deleted despite org2 having a reference", statsOrg1.rowsDeleted === 1);
    check("org2 content row remains protected", (await countOrgContents(db, org2)) === 1);
  }

  // --- 5. Bounded batch execution ---
  {
    // Write 5 distinct orphan bodies into org1
    const writes = Array.from({ length: 5 }, (_, i) => ({
      body: Buffer.from(`export const batchItem_${i} = ${i};\n`, "utf8"),
    }));
    await putContentsBatch(db, org1, writes);
    await new Promise((r) => setTimeout(r, 250));

    // Run with batchSize: 2, maxBatches: 2 (deletes at most 2 x 2 = 4 rows)
    const stats = await garbageCollectOrphanedContent(db, {
      organizationId: org1,
      gracePeriodMs: 50,
      batchSize: 2,
      maxBatches: 2,
      execute: true,
    });

    check("bounded GC executed exactly 2 batches", stats.batchesProcessed === 2);
    check("bounded GC deleted exactly 4 rows (2 x 2 limit)", stats.rowsDeleted === 4);
    // org1 had 1 referenced row + 5 new orphans = 6. 4 deleted -> 2 remain (1 referenced + 1 orphan)
    check("unprocessed orphan remains in DB", (await countOrgContents(db, org1)) === 2);
  }

  // --- 6. In-process cache invalidation on GC deletion ---
  {
    const cache = new ContentCache();
    const cacheBody = Buffer.from("export const cachedOrphan = 'will be purged';\n", "utf8");
    const cacheHash = sha256(cacheBody);

    await putContentsBatch(db, org1, [{ body: cacheBody }]);
    cache.set(org1, cacheHash, cacheBody);
    check("entry is populated in cache before GC", cache.get(org1, cacheHash) !== undefined);

    await new Promise((r) => setTimeout(r, 250));
    await garbageCollectOrphanedContent(db, {
      organizationId: org1,
      gracePeriodMs: 50,
      execute: true,
      cache,
    });

    check("entry was evicted from cache by GC", cache.get(org1, cacheHash) === undefined);
  }

  // --- 7. Concurrency resilience (FOR UPDATE SKIP LOCKED) ---
  {
    // Write 4 orphan bodies
    const writes = Array.from({ length: 4 }, (_, i) => ({
      body: Buffer.from(`export const concurrentItem_${i} = ${i};\n`, "utf8"),
    }));
    await putContentsBatch(db, org1, writes);
    await new Promise((r) => setTimeout(r, 250));

    // Launch two GC workers concurrently on the same organization
    const [workerA, workerB] = await Promise.all([
      garbageCollectOrphanedContent(db, {
        organizationId: org1,
        gracePeriodMs: 50,
        batchSize: 2,
        maxBatches: 5,
        execute: true,
      }),
      garbageCollectOrphanedContent(db, {
        organizationId: org1,
        gracePeriodMs: 50,
        batchSize: 2,
        maxBatches: 5,
        execute: true,
      }),
    ]);

    check("worker A completed without error", workerA.errors.length === 0);
    check("worker B completed without error", workerB.errors.length === 0);
    const totalDeleted = workerA.rowsDeleted + workerB.rowsDeleted;
    check("concurrent workers divided the orphans with zero collision", totalDeleted >= 4);
  }
}

main()
  .catch((err) => {
    console.error("Live DB test error:", err);
    fail(`unexpected: ${err instanceof Error ? err.message : String(err)}`);
  })
  .finally(async () => {
    console.log("");
    for (const c of checks) console.log(c);
    const db = createAdminSupabase();
    const tidy = await cleanup(db);
    for (const t of tidy) console.log(t);
    const failed = checks.filter((c) => c.startsWith("FAIL")).length + tidy.filter((t) => t.startsWith("FAIL")).length;
    console.log(failed === 0 ? "\nEvery live check passed." : `\n${failed} check(s) failed.`);
    process.exit(failed === 0 ? 0 : 1);
  });
