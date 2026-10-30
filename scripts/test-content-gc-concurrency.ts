// Deterministic PostgreSQL concurrency regression tests verifying that GC and
// indexing cannot race to leave a file marked 'stored' without its content row.
//
// Tests both lock orderings:
//   1. Indexing arrives FIRST, updates last_referenced_at, then GC arrives.
//   2. GC arrives FIRST, holds FOR UPDATE lock, Indexing arrives, then GC commits/aborts.
//
// Also tests:
//   3. Immutability trigger protection on last_referenced_at updates vs payload mutations.
//   4. Multi-worker stress concurrency with simultaneous indexing and GC loops.
//   5. Organization isolation and zero-residue cleanup.
//
// Run:
//   node --env-file=.env.local scripts/test-content-gc-concurrency.ts

import { spawn, type ChildProcess } from "node:child_process";
import { getContent, putContentsBatch, sha256 } from "../lib/content/store.ts";
import { createAdminSupabase } from "../lib/supabase/admin.ts";

const TEST_PREFIX = "gc_concurrency_test_";

const checks: string[] = [];
const pass = (m: string) => checks.push(`ok    ${m}`);
const fail = (m: string) => checks.push(`FAIL  ${m}`);
const check = (m: string, condition: boolean) => (condition ? pass(m) : fail(m));

type TestClient = ReturnType<typeof createAdminSupabase>;

const text = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

function getEnv(): NodeJS.ProcessEnv {
  const currentPath = process.env.PATH ?? "";
  const extra = ["C:\\Program Files\\Docker\\Docker\\resources\\bin"];
  const newPath = [extra.filter((p) => !currentPath.includes(p)).join(";"), currentPath].filter(Boolean).join(";");
  return { ...process.env, PATH: newPath };
}

// Spawns an interactive psql connection inside the local PostgreSQL container
function spawnPsql(): {
  process: ChildProcess;
  query: (sql: string) => Promise<string>;
  close: () => Promise<void>;
} {
  const p = spawn("docker", ["exec", "-i", "supabase_db_cartograph", "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
    env: getEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  let pendingResolve: ((out: string) => void) | null = null;

  p.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    if (buffer.includes("__PSQL_MARKER__")) {
      const parts = buffer.split("__PSQL_MARKER__");
      const result = parts[0];
      buffer = parts.slice(1).join("__PSQL_MARKER__");
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve(result);
      }
    }
  });

  p.stderr!.on("data", (chunk: Buffer) => {
    const err = chunk.toString("utf8");
    if (!err.includes("NOTICE:") && err.trim()) {
      // console.error("psql stderr:", err.trim());
    }
  });

  return {
    process: p,
    async query(sql: string): Promise<string> {
      return new Promise((resolve) => {
        pendingResolve = resolve;
        p.stdin!.write(sql + "\n\\echo __PSQL_MARKER__\n");
      });
    },
    async close(): Promise<void> {
      return new Promise((resolve) => {
        p.on("exit", () => resolve());
        p.stdin!.write("\\q\n");
      });
    },
  };
}

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

async function setupOrg(db: TestClient, orgId: string): Promise<void> {
  const org = await db.from("organizations").upsert({ id: orgId });
  if (org.error) throw new Error(`setupOrg failed: ${org.error.message}`);
}

async function setupProjectAndAnalysis(db: TestClient, orgId: string): Promise<{ projectId: string; analysisId: string }> {
  const { data: proj, error: pErr } = await db
    .from("projects")
    .insert({ organization_id: orgId, repo_owner: "testowner", repo_name: "testrepo" })
    .select("id")
    .single();
  if (pErr) throw new Error(`setupProject failed: ${pErr.message}`);

  const { data: ana, error: aErr } = await db
    .from("analyses")
    .insert({
      organization_id: orgId,
      project_id: proj.id,
      status: "complete",
      commit_sha: "abcd1234abcd1234abcd1234abcd1234abcd1234",
      coverage: {},
      detected_projects: [],
      schema_version: 5,
      stage: "store",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (aErr) throw new Error(`setupAnalysis failed: ${aErr.message}`);

  return { projectId: proj.id, analysisId: ana.id };
}

async function main(): Promise<void> {
  const db = createAdminSupabase();

  // Clean up any stale data from previous aborted runs
  await db.from("organizations").delete().like("id", `${TEST_PREFIX}%`);

  console.log("=== 1. Content Immutability & last_referenced_at Refresh ===");
  {
    const org = `${TEST_PREFIX}immutability_${Date.now()}`;
    await setupOrg(db, org);

    const body = text("export const testImmutability = true;\n");
    const hash = sha256(body);

    // Seed row as an old orphan (created 5 days ago, last_referenced 5 days ago)
    const psql = spawnPsql();
    await psql.query(`
      insert into public.file_contents (organization_id, content_hash, payload, size, created_at, last_referenced_at)
      values ('${org}', '${hash}', '\\x${Buffer.from(body).toString("hex")}', ${body.byteLength}, now() - interval '5 days', now() - interval '5 days');
    `);
    await psql.close();

    const { data: before } = await db
      .from("file_contents")
      .select("created_at, last_referenced_at")
      .eq("organization_id", org)
      .eq("content_hash", hash)
      .single();

    const beforeCreated = new Date(before!.created_at).getTime();
    const beforeRef = new Date(before!.last_referenced_at).getTime();
    const fiveDaysAgo = Date.now() - 4 * 86400 * 1000;

    check("orphan row seeded with created_at in the past", beforeCreated < fiveDaysAgo);
    check("orphan row seeded with last_referenced_at in the past", beforeRef < fiveDaysAgo);

    // Re-index: putContentsBatch writes the same body
    const writeRes = await putContentsBatch(db, org, [{ body }]);
    check("putContentsBatch on existing orphan succeeds", writeRes[0].stored);

    const { data: after } = await db
      .from("file_contents")
      .select("created_at, last_referenced_at")
      .eq("organization_id", org)
      .eq("content_hash", hash)
      .single();

    const afterCreated = new Date(after!.created_at).getTime();
    const afterRef = new Date(after!.last_referenced_at).getTime();

    check("created_at is strictly preserved on re-index (immutable)", afterCreated === beforeCreated);
    check("last_referenced_at is refreshed to current time", afterRef > Date.now() - 10000);

    // Verify row count remains exactly 1 (no duplicate row)
    const { count } = await db.from("file_contents").select("*", { count: "exact" }).eq("organization_id", org);
    check("re-indexing deduplicates to single row", count === 1);

    // Verify trigger blocks payload modification
    const { error: mutErr } = await db
      .from("file_contents")
      .update({ payload: "\\x616263" })
      .eq("organization_id", org)
      .eq("content_hash", hash);
    check("trigger blocks payload modification under existing hash", mutErr !== null && mutErr.message.includes("file_contents is immutable"));
  }

  console.log("\n=== 2. Lock Ordering 1: Indexing arrives FIRST, then GC arrives ===");
  {
    const org = `${TEST_PREFIX}order1_${Date.now()}`;
    await setupOrg(db, org);
    const { analysisId } = await setupProjectAndAnalysis(db, org);

    const body = text("export const ordering1 = 'indexing_first';\n");
    const hash = sha256(body);

    // Seed old orphan (>24h old, no file references)
    const psql = spawnPsql();
    await psql.query(`
      insert into public.file_contents (organization_id, content_hash, payload, size, created_at, last_referenced_at)
      values ('${org}', '${hash}', '\\x${Buffer.from(body).toString("hex")}', ${body.byteLength}, now() - interval '5 days', now() - interval '5 days');
    `);
    await psql.close();

    // Step 1: Indexing arrives and touches the content (updating last_referenced_at)
    const [write] = await putContentsBatch(db, org, [{ body }]);
    check("indexing worker touches old orphan", write.stored);

    // Step 2: GC worker executes concurrently with 24h grace period BEFORE files row is inserted
    const { data: gcDeleted, error: gcErr } = await db.rpc("delete_orphaned_file_contents", {
      p_organization_id: org,
      p_grace_period: "24 hours",
      p_batch_size: 100,
    });
    check("GC execution succeeds without error", !gcErr);
    check("GC skipped the refreshed orphan (0 deleted)", (gcDeleted ?? []).length === 0);

    // Step 3: Indexing completes by inserting files metadata
    const { error: fErr } = await db.from("files").insert({
      organization_id: org,
      analysis_id: analysisId,
      path: "src/order1.ts",
      module: "src/order1",
      lines: 1,
      bytes: body.byteLength,
      hash,
      fan_in: 0,
      fan_out: 0,
      content_status: "stored",
    });
    check("indexing inserts files row with content_status = 'stored'", !fErr);

    // Step 4: Verify content is intact and read back matches byte for byte
    const readBack = await getContent(db, org, hash);
    check("content row exists and reads back byte-for-byte", readBack !== null && Buffer.from(readBack).equals(Buffer.from(body)));
  }

  console.log("\n=== 3. Lock Ordering 2A: GC arrives FIRST with row lock, Indexing arrives, GC commits ===");
  {
    const org = `${TEST_PREFIX}order2a_${Date.now()}`;
    await setupOrg(db, org);
    const { analysisId } = await setupProjectAndAnalysis(db, org);

    const body = text("export const ordering2a = 'gc_lock_then_delete';\n");
    const hash = sha256(body);

    // Seed old orphan (>24h old)
    const psqlSetup = spawnPsql();
    await psqlSetup.query(`
      insert into public.file_contents (organization_id, content_hash, payload, size, created_at, last_referenced_at)
      values ('${org}', '${hash}', '\\x${Buffer.from(body).toString("hex")}', ${body.byteLength}, now() - interval '5 days', now() - interval '5 days');
    `);
    await psqlSetup.close();

    // Step 1: GC worker opens transaction and acquires exclusive lock on the row
    const psqlGc = spawnPsql();
    await psqlGc.query("begin;");
    const lockResult = await psqlGc.query(`
      select content_hash from public.file_contents
      where organization_id = '${org}' and content_hash = '${hash}'
      for update;
    `);
    check("GC worker acquires FOR UPDATE row lock on orphan", lockResult.includes(hash));

    // Step 2: Indexing worker initiates putContentsBatch concurrently.
    // It will block waiting for GC worker's lock!
    let indexingCompleted = false;
    let indexingResult: unknown = null;

    const indexingPromise = putContentsBatch(db, org, [{ body }]).then((res) => {
      indexingCompleted = true;
      indexingResult = res;
    });

    // Wait 150ms to verify indexing is truly blocked by the lock
    await new Promise((r) => setTimeout(r, 150));
    check("indexing worker blocks while GC holds row lock", !indexingCompleted);

    // Step 3: GC worker deletes the row and commits
    await psqlGc.query(`
      delete from public.file_contents where organization_id = '${org}' and content_hash = '${hash}';
      commit;
    `);
    await psqlGc.close();

    // Step 4: Indexing worker unblocks.
    // Postgres ON CONFLICT DO UPDATE handles the concurrently deleted row by
    // inserting fresh row instead of failing!
    await indexingPromise;
    check("indexing unblocks and completes after GC commit", indexingCompleted);
    check("indexing reports content stored", Array.isArray(indexingResult) && indexingResult[0]?.stored === true);

    // Step 5: Indexing inserts file row
    await db.from("files").insert({
      organization_id: org,
      analysis_id: analysisId,
      path: "src/order2a.ts",
      module: "src/order2a",
      lines: 1,
      bytes: body.byteLength,
      hash,
      fan_in: 0,
      fan_out: 0,
      content_status: "stored",
    });

    // Step 6: Verify content exists in database and reads back cleanly
    const readBack = await getContent(db, org, hash);
    check("content row is preserved/re-created and matches exactly", readBack !== null && Buffer.from(readBack).equals(Buffer.from(body)));
  }

  console.log("\n=== 4. Lock Ordering 2B: GC arrives FIRST with row lock, Indexing arrives, GC rolls back ===");
  {
    const org = `${TEST_PREFIX}order2b_${Date.now()}`;
    await setupOrg(db, org);
    await setupProjectAndAnalysis(db, org);

    const body = text("export const ordering2b = 'gc_lock_then_rollback';\n");
    const hash = sha256(body);

    // Seed old orphan (>24h old)
    const psqlSetup = spawnPsql();
    await psqlSetup.query(`
      insert into public.file_contents (organization_id, content_hash, payload, size, created_at, last_referenced_at)
      values ('${org}', '${hash}', '\\x${Buffer.from(body).toString("hex")}', ${body.byteLength}, now() - interval '5 days', now() - interval '5 days');
    `);
    await psqlSetup.close();

    // Step 1: GC worker opens transaction and acquires exclusive lock on the row
    const psqlGc = spawnPsql();
    await psqlGc.query("begin;");
    const lockResult = await psqlGc.query(`
      select content_hash from public.file_contents
      where organization_id = '${org}' and content_hash = '${hash}'
      for update;
    `);
    check("GC worker acquires lock on orphan", lockResult.includes(hash));

    // Step 2: Indexing worker attempts putContentsBatch, blocks on lock
    let indexingCompleted = false;
    let indexingResult: unknown = null;

    const indexingPromise = putContentsBatch(db, org, [{ body }]).then((res) => {
      indexingCompleted = true;
      indexingResult = res;
    });

    await new Promise((r) => setTimeout(r, 150));
    check("indexing worker blocks on lock", !indexingCompleted);

    // Step 3: GC worker rolls back without deleting
    await psqlGc.query("rollback;");
    await psqlGc.close();

    // Step 4: Indexing unblocks, updates last_referenced_at
    await indexingPromise;
    check("indexing unblocks on GC rollback", indexingCompleted);
    check("indexing reports stored = true", Array.isArray(indexingResult) && indexingResult[0]?.stored === true);

    const { data: row } = await db
      .from("file_contents")
      .select("last_referenced_at")
      .eq("organization_id", org)
      .eq("content_hash", hash)
      .single();

    const refTime = new Date(row!.last_referenced_at).getTime();
    check("row last_referenced_at was refreshed on unblock", refTime > Date.now() - 10000);
  }

  console.log("\n=== 5. Multi-Worker Stress Concurrency (Concurrent Indexing & GC Loops) ===");
  {
    const org = `${TEST_PREFIX}stress_${Date.now()}`;
    await setupOrg(db, org);
    const { analysisId } = await setupProjectAndAnalysis(db, org);

    // Seed 10 distinct old orphan content bodies (5 days old)
    const bodies = Array.from({ length: 10 }, (_, i) => text(`// stress content item #${i}\nexport const item${i} = ${i};\n`));
    const hashes = bodies.map((b) => sha256(b));

    const psqlSeed = spawnPsql();
    for (let i = 0; i < bodies.length; i++) {
      await psqlSeed.query(`
        insert into public.file_contents (organization_id, content_hash, payload, size, created_at, last_referenced_at)
        values ('${org}', '${hashes[i]}', '\\x${Buffer.from(bodies[i]).toString("hex")}', ${bodies[i].byteLength}, now() - interval '5 days', now() - interval '5 days');
      `);
    }
    await psqlSeed.close();

    // Worker 1: indexes items 0..4
    const worker1 = async () => {
      const writes = bodies.slice(0, 5).map((b) => ({ body: b }));
      await putContentsBatch(db, org, writes);
      for (let i = 0; i < 5; i++) {
        await db.from("files").insert({
          organization_id: org,
          analysis_id: analysisId,
          path: `src/stress_${i}.ts`,
          module: `src/stress_${i}`,
          lines: 2,
          bytes: bodies[i].byteLength,
          hash: hashes[i],
          fan_in: 0,
          fan_out: 0,
          content_status: "stored",
        });
      }
    };

    // Worker 2: indexes items 5..9
    const worker2 = async () => {
      const writes = bodies.slice(5, 10).map((b) => ({ body: b }));
      await putContentsBatch(db, org, writes);
      for (let i = 5; i < 10; i++) {
        await db.from("files").insert({
          organization_id: org,
          analysis_id: analysisId,
          path: `src/stress_${i}.ts`,
          module: `src/stress_${i}`,
          lines: 2,
          bytes: bodies[i].byteLength,
          hash: hashes[i],
          fan_in: 0,
          fan_out: 0,
          content_status: "stored",
        });
      }
    };

    // Worker 3: runs GC in tight loop
    const worker3 = async () => {
      for (let j = 0; j < 5; j++) {
        await db.rpc("delete_orphaned_file_contents", {
          p_organization_id: org,
          p_grace_period: "24 hours",
          p_batch_size: 5,
        });
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    // Worker 4: runs GC in tight loop with sub-batching
    const worker4 = async () => {
      for (let j = 0; j < 5; j++) {
        await db.rpc("delete_orphaned_file_contents", {
          p_organization_id: org,
          p_grace_period: "24 hours",
          p_batch_size: 2,
        });
        await new Promise((r) => setTimeout(r, 30));
      }
    };

    // Run all 4 workers concurrently
    const results = await Promise.allSettled([worker1(), worker2(), worker3(), worker4()]);
    check("all 4 concurrent workers completed without rejection", results.every((r) => r.status === "fulfilled"));

    // Verify: Every one of the 10 indexed files still has its content row! Zero content lost!
    let allContentPreserved = true;
    for (let i = 0; i < 10; i++) {
      const read = await getContent(db, org, hashes[i]);
      if (read === null || !Buffer.from(read).equals(Buffer.from(bodies[i]))) {
        allContentPreserved = false;
        break;
      }
    }
    check("every indexed file preserved its content row with zero loss under heavy GC race", allContentPreserved);
  }

  console.log("\n=== 6. Organization Isolation & Cleanup Verification ===");
  {
    const orgA = `${TEST_PREFIX}iso_a_${Date.now()}`;
    const orgB = `${TEST_PREFIX}iso_b_${Date.now()}`;
    await setupOrg(db, orgA);
    await setupOrg(db, orgB);

    const body = text("export const isolated = 'org_safe';\n");
    const hash = sha256(body);

    const psqlSeed = spawnPsql();
    await psqlSeed.query(`
      insert into public.file_contents (organization_id, content_hash, payload, size, created_at, last_referenced_at)
      values ('${orgA}', '${hash}', '\\x${Buffer.from(body).toString("hex")}', ${body.byteLength}, now() - interval '5 days', now() - interval '5 days'),
             ('${orgB}', '${hash}', '\\x${Buffer.from(body).toString("hex")}', ${body.byteLength}, now() - interval '5 days', now() - interval '5 days');
    `);
    await psqlSeed.close();

    // GC org A
    await db.rpc("delete_orphaned_file_contents", {
      p_organization_id: orgA,
      p_grace_period: "1 hour",
      p_batch_size: 100,
    });

    const readA = await getContent(db, orgA, hash);
    const readB = await getContent(db, orgB, hash);

    check("org A orphan was collected", readA === null);
    check("org B content was protected from cross-tenant GC", readB !== null);
  }

  console.log("\n=== 7. Zero-Residue Cleanup ===");
  const cleanupNotes = await cleanup(db);
  for (const note of cleanupNotes) console.log(note);

  const failed = checks.filter((c) => c.startsWith("FAIL"));
  console.log(`\nConcurrency suite: ${checks.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    for (const f of failed) console.error(f);
    process.exit(1);
  }

  console.log("\nEvery PostgreSQL concurrency guarantee held.");
}

main().catch((err) => {
  console.error("Unhandled concurrency test error:", err);
  process.exit(1);
});
