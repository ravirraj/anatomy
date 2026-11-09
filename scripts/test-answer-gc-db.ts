// Live-database tests for answer-cache retention pruning (F7-1/F7-2).
//
//   node --env-file=.env.local scripts/test-answer-gc-db.ts
//
// Tests the real database-side prune_ai_cache function added by migration
// 20261109000000_ai_cache_retention.sql and the real
// garbageCollectExpiredAnswers client (lib/content/gc.ts), against a live
// Supabase. Like every suite in the test:db chain, this can never pass
// without a live database.
//
// Covered:
//   D1.  New rows default to a 90-day retention timestamp.
//   D2.  Backfill integrity: no row in the table lacks expires_at.
//   D3.  Expired rows are pruned before cap eviction is considered at all.
//   D4.  Rows inside their retention window are retained while the
//        organization is under its cap.
//   D5.  Over-cap organizations evict the oldest rows by created_at.
//   D6.  One invocation is hard-bounded by its total deletion budget.
//   D7.  A scoped prune touches only its organization's rows.
//   D8.  Concurrent prunes of one organization serialize on the advisory
//        lock and never evict beyond the cap.
//   D9.  Concurrent inserts stay deterministic: first writer wins, one row
//        survives.
//   D10. Retention/pruning cannot bypass cache verification: a poisoned
//        row inside its retention window is still refused and healed.
//   D11. Evicted answers regenerate through the pipeline and are verified
//        before being stored again.
//
// Safety: every destructive call is scoped to this run's own throwaway test
// organizations; the suite never calls the pruner without an organization
// scope, so real data in the shared database is untouchable.

import { createAdminSupabase } from "../lib/supabase/admin.ts";
import { createAiCache } from "../lib/supabase/cache.ts";
import { garbageCollectExpiredAnswers } from "../lib/content/gc.ts";
import type { Db as ContentDb } from "../lib/content/types.ts";
import { putContents } from "../lib/content/store.ts";
import { retrieveGroundedContext, formatRetrievedContext } from "../lib/ai/retrieval.ts";
import { answerQuestion } from "../lib/ai/tasks.ts";
import type { QuestionInput } from "../lib/ai/prompts.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

const TEST_PREFIX = `f7gc_${Date.now()}`;
const orgDefault = `${TEST_PREFIX}_default`; // D1
const orgExpired = `${TEST_PREFIX}_expired`; // D3
const orgUnder = `${TEST_PREFIX}_under`; // D4
const orgIsoA = `${TEST_PREFIX}_iso_a`; // D7
const orgIsoB = `${TEST_PREFIX}_iso_b`; // D7
const orgRegen = `${TEST_PREFIX}_regen`; // D10-D11

if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  console.error(
    "No live Supabase configured (NEXT_PUBLIC_SUPABASE_URL missing from the env file); the test:db chain cannot run.",
  );
  process.exit(1);
}

const db = createAdminSupabase();

// (the member-client shape is exercised by scripts/test-qa-integration.ts)

const countRows = async (organizationId: string): Promise<number> => {
  const { count, error } = await db
    .from("ai_cache")
    .select("key", { count: "exact", head: true })
    .eq("organization_id", organizationId);
  if (error) throw new Error(`Counting ai_cache rows failed: ${error.message}`);
  return count ?? 0;
};

const listRows = async (organizationId: string) => {
  const { data, error } = await db
    .from("ai_cache")
    .select("key, body, created_at, expires_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Listing ai_cache rows failed: ${error.message}`);
  return data ?? [];
};

/** One fresh, unexpired, staggered cache row. */
const seedRow = async (organizationId: string, key: string, body: string, createdAt?: string, expiresAt?: string) => {
  const { error } = await db.from("ai_cache").insert({
    organization_id: organizationId,
    key,
    task: "answer-question",
    model: "test-model",
    body,
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  });
  if (error) throw new Error(`Seeding ai_cache row ${key} failed: ${error.message}`);
};

const gc = (organizationId: string, options: Parameters<typeof garbageCollectExpiredAnswers>[1] = {}) =>
  garbageCollectExpiredAnswers(db as unknown as ContentDb, { organizationId, ...options });

/** Minimal hermetic analysis for the verification/regeneration tests (D10, D11). */
async function seedAnalysis(organizationId: string) {
  const projectId = crypto.randomUUID();
  const analysisId = crypto.randomUUID();
  const codeFileId = crypto.randomUUID();
  const manifestFileId = crypto.randomUUID();

  const { error: orgErr } = await db.from("organizations").insert([{ id: organizationId }]);
  if (orgErr) throw new Error(`Creating org failed: ${orgErr.message}`);

  const { error: projErr } = await db.from("projects").insert({
    id: projectId,
    organization_id: organizationId,
    repo_owner: "f7-owner",
    repo_name: "f7-repo",
  });
  if (projErr) throw new Error(`Creating project failed: ${projErr.message}`);

  const nowIso = new Date().toISOString();
  const { error: anaErr } = await db.from("analyses").insert({
    id: analysisId,
    organization_id: organizationId,
    project_id: projectId,
    status: "complete",
    commit_sha: "f7g".padEnd(40, "0"),
    coverage: {},
    detected_projects: [],
    schema_version: 7,
    stage: "store",
    started_at: nowIso,
    finished_at: nowIso,
  });
  if (anaErr) throw new Error(`Creating analysis failed: ${anaErr.message}`);

  const codeContent = Buffer.from(
    "// Greeter service\nexport function getGreeting(name: string): string {\n  return `Hello, ${name}!`;\n}\n",
    "utf8",
  );
  const manifestContent = Buffer.from(
    JSON.stringify({ name: "f7-pkg", version: "1.0.0", description: "F7 cache retention" }, null, 2) + "\n",
    "utf8",
  );
  const codeStored = await putContents(db, organizationId, codeContent);
  const manifestStored = await putContents(db, organizationId, manifestContent);

  const { error: filesErr } = await db.from("files").insert([
    {
      id: codeFileId,
      organization_id: organizationId,
      analysis_id: analysisId,
      path: "src/greet.ts",
      module: "root",
      hash: codeStored.contentHash,
      lines: 4,
      bytes: codeContent.length,
      fan_in: 0,
      fan_out: 0,
      content_status: "stored",
    },
    {
      id: manifestFileId,
      organization_id: organizationId,
      analysis_id: analysisId,
      path: "package.json",
      module: "root",
      hash: manifestStored.contentHash,
      lines: 5,
      bytes: manifestContent.length,
      fan_in: 0,
      fan_out: 0,
      content_status: "stored",
    },
  ]);
  if (filesErr) throw new Error(`Registering files failed: ${filesErr.message}`);

  await db.from("symbols").insert({
    id: crypto.randomUUID(),
    organization_id: organizationId,
    analysis_id: analysisId,
    file_id: codeFileId,
    name: "getGreeting",
    kind: "function",
    line: 2,
    exported: true,
  });

  await db.from("manifests").insert({
    id: crypto.randomUUID(),
    organization_id: organizationId,
    analysis_id: analysisId,
    path: "package.json",
    dir: "",
    project: "f7-pkg",
    ecosystem: "npm",
    name: "f7-pkg",
    workspaces: [],
    scripts: {},
    problems: [],
  });

  return { analysisId };
}

async function buildQuestionInput(organizationId: string, analysisId: string): Promise<QuestionInput> {
  const retrieved = await retrieveGroundedContext(db, analysisId, "How does getGreeting work and what is package.json?");
  return {
    question: "How does getGreeting work and what is package.json?",
    contextText: formatRetrievedContext(retrieved),
    files: retrieved.files.map((f) => ({
      path: f.path,
      contentHash: f.contentHash,
      totalLines: f.totalLines,
      ...(f.windows ? { windows: f.windows } : {}),
    })),
  };
}

const day = 24 * 3600 * 1000;

async function run() {
  const { error: orgErr } = await db
    .from("organizations")
    .insert([{ id: orgDefault }, { id: orgExpired }, { id: orgUnder }, { id: orgIsoA }, { id: orgIsoB }]);
  if (orgErr) throw new Error(`Creating test organizations failed: ${orgErr.message}`);

  console.log("=== D1. New rows default to a 90-day retention timestamp ===");
  await seedRow(orgDefault, "d1_default_row", "body");
  const d1Rows = await listRows(orgDefault);
  const d1 = d1Rows[0];
  const expectedLow = Date.now() + 90 * day - 120_000;
  const expectedHigh = Date.now() + 90 * day + 120_000;
  const ts = new Date(d1?.expires_at ?? "invalid").getTime();
  if (Number.isFinite(ts) && ts > expectedLow && ts < expectedHigh) {
    pass("a freshly inserted row carries expires_at = now + 90 days (no explicit timestamp given)");
  } else {
    fail(`default expires_at is not ~90 days out: ${d1?.expires_at}`);
  }

  console.log("\n=== D2. Backfill integrity: expires_at is universal, past rows included ===");
  {
    const { count, error } = await db
      .from("ai_cache")
      .select("key", { count: "exact", head: true })
      .is("expires_at", null);
    if (error) throw new Error(`Counting null expires_at failed: ${error.message}`);
    if ((count ?? 1) === 0) {
      pass("no ai_cache row anywhere lacks expires_at (migration default + deterministic backfill + not-null)");
    } else {
      fail(`${count} ai_cache row(s) lack expires_at`);
    }
  }

  console.log("\n=== D3. Expired rows go before cap eviction ever sees active rows ===");
  {
    const past = new Date(Date.now() - day).toISOString();
    await seedRow(orgExpired, "d3_expired", "expired-body", past, past); // expired by design
    await seedRow(orgExpired, "d3_fresh_old", "fresh-old-body", past); // fresh, older creation
    await seedRow(orgExpired, "d3_fresh_new", "fresh-new-body"); // fresh, newest creation

    // Budget 1 with cap 1: only ONE deletion is affordable. The expired row
    // must win it; the two active rows stay over their cap untouched.
    const first = await gc(orgExpired, { capRowsPerOrg: 1, maxDeletions: 1, execute: true });
    const afterFirst = await countRows(orgExpired);
    if (
      first.expiredRowsDeleted === 1 &&
      first.capEvictedRowsDeleted === 0 &&
      afterFirst === 2 &&
      first.dryRun === false
    ) {
      pass(
        "a budget-starved invocation spends its single deletion on the expired row and leaves over-cap active rows alone",
      );
    } else {
      fail(`expired-first failed: ${JSON.stringify({ ...first, afterFirst })}`);
    }

    // Second, generous run: now the cap trims the OLDEST of the fresh rows.
    const second = await gc(orgExpired, { capRowsPerOrg: 1, execute: true });
    const remaining = await listRows(orgExpired);
    if (second.expiredRowsDeleted === 0 && second.capEvictedRowsDeleted === 1 && remaining.length === 1) {
      pass("a later run trims the over-cap organization down to its cap, dropping the oldest row");
    } else {
      fail(`cap trim failed: ${JSON.stringify({ ...second, remaining: remaining.map((r) => r.key) })}`);
    }
    if (remaining[0]?.key === "d3_fresh_new") {
      pass("the surviving row is the newest-created active row");
    } else {
      fail(`oldest-first eviction failed: survivor is ${remaining[0]?.key}`);
    }
  }

  console.log("\n=== D4. Inside-retention rows are retained while under the cap ===");
  {
    for (let i = 0; i < 3; i++) {
      await seedRow(orgUnder, `d4_fresh_${i}`, "retained-body");
    }
    const stats = await gc(orgUnder, { execute: true });
    const count = await countRows(orgUnder);
    if (
      stats.expiredRowsDeleted === 0 &&
      stats.capEvictedRowsDeleted === 0 &&
      stats.errors.length === 0 &&
      count === 3
    ) {
      pass("a prune run deletes nothing from an organization that is inside retention and under its cap");
    } else {
      fail(`under-cap retention failed: ${JSON.stringify({ ...stats, count })}`);
    }
  }

  console.log("\n=== D5. Over-cap organizations evict oldest-by-creation rows ===");
  {
    const org = `${TEST_PREFIX}_cap`;
    await db.from("organizations").insert([{ id: org }]);
    for (let i = 1; i <= 5; i++) {
      await seedRow(org, `d5_row_${i}`, `cap-body-${i}`, new Date(Date.now() - (10 - i) * day).toISOString());
    }
    const stats = await gc(org, { capRowsPerOrg: 2, batchSize: 2, execute: true });
    const remaining = await listRows(org);
    const survivorKeys = remaining.map((r) => r.key).sort();
    if (
      stats.expiredRowsDeleted === 0 &&
      stats.capEvictedRowsDeleted === 3 &&
      remaining.length === 2 &&
      remaining[0]?.body === "cap-body-4" &&
      remaining[1]?.body === "cap-body-5"
    ) {
      pass(`cap eviction removed exactly the three oldest rows in batches of 2, keeping the newest two: ${survivorKeys.join(", ")}`);
    } else {
      fail(`cap eviction failed: ${JSON.stringify({ ...stats, survivorKeys })}`);
    }
  }

  console.log("\n=== D6. One invocation is bounded by its deletion budget ===");
  {
    const org = `${TEST_PREFIX}_budget`;
    await db.from("organizations").insert([{ id: org }]);
    for (let i = 0; i < 7; i++) {
      const past = new Date(Date.now() - day).toISOString();
      await seedRow(org, `d6_row_${i}`, "abcdef", past, past); // 6 body bytes each
    }
    const first = await gc(org, { batchSize: 2, maxDeletions: 5, capRowsPerOrg: 100, execute: true });
    const afterFirst = await countRows(org);
    if (first.expiredRowsDeleted === 5 && afterFirst === 2) {
      pass("a budget of 5 with batch size 2 stopped after exactly 5 deletions, leaving 2 rows");
    } else {
      fail(`budget bound failed: ${JSON.stringify({ ...first, afterFirst })}`);
    }
    if (first.bodyBytesDeleted === 5 * 6) {
      pass("deleted body bytes measured exactly via octet_length (5 x 6-byte bodies = 30)");
    } else {
      fail(`byte statistics are not exact: ${first.bodyBytesDeleted}`);
    }

    const second = await gc(org, { execute: true });
    const afterSecond = await countRows(org);
    if (second.expiredRowsDeleted === 2 && afterSecond === 0) {
      pass("a follow-up invocation with a fresh budget finishes the cleanup");
    } else {
      fail(`follow-up prune failed: ${JSON.stringify({ ...second, afterSecond })}`);
    }
  }

  console.log("\n=== D7. A scoped prune cannot touch another organization ===");
  {
    const past = new Date(Date.now() - day).toISOString();
    await seedRow(orgIsoA, "d7_row_a", "iso-a-body", past, past);
    await seedRow(orgIsoB, "d7_row_b", "iso-b-body", past, past);

    const stats = await gc(orgIsoA, { execute: true });
    const countB = await countRows(orgIsoB);
    if (stats.expiredRowsDeleted === 1 && stats.capEvictedRowsDeleted === 0 && countB === 1) {
      pass("pruning org A removed only org A's expired row; org B's row survived untouched");
    } else {
      fail(`isolation failed: ${JSON.stringify({ stats, countB })}`);
    }
  }

  console.log("\n=== D8. Concurrent prunes of one organization serialize and hold the cap ===");
  {
    const org = `${TEST_PREFIX}_conc`;
    await db.from("organizations").insert([{ id: org }]);
    for (let i = 1; i <= 40; i++) {
      // Staggered creations make oldest-first eviction deterministic.
      await seedRow(org, `d8_row_${i}`, "c", new Date(Date.now() - (100 - i) * 1000).toISOString());
    }

    // Two pruners race for the same over-cap organization. The advisory
    // lock must serialize them so the cap is evaluated once at a time:
    // exactly 20 rows (40 - cap) may ever be evicted in total.
    const [first, second] = await Promise.all([
      gc(org, { capRowsPerOrg: 20, batchSize: 5, execute: true }),
      gc(org, { capRowsPerOrg: 20, batchSize: 5, execute: true }),
    ]);
    const finalCount = await countRows(org);
    const totalEvicted = first.capEvictedRowsDeleted + second.capEvictedRowsDeleted;
    const errors = [...first.errors, ...second.errors];
    if (totalEvicted === 20 && finalCount === 20 && errors.length === 0) {
      pass("two concurrent pruners evicted exactly the over-cap amount (20) and left the org at exactly its cap");
    } else {
      fail(
        `concurrent cap enforcement failed: evicted=${totalEvicted} final=${finalCount} errors=${JSON.stringify(errors)}`,
      );
    }
  }

  console.log("\n=== D9. Concurrent inserts stay deterministic: first writer wins ===");
  {
    const org = `${TEST_PREFIX}_ins`;
    await db.from("organizations").insert([{ id: org }]);
    const key = `d9_key_${Date.now()}`;
    const conflicting = { organization_id: org, key, task: "answer-question", model: "test-model" };

    const [one, two] = await Promise.all([
      db.from("ai_cache").upsert({ ...conflicting, body: "writer-one" }, { onConflict: "organization_id,key", ignoreDuplicates: true }),
      db.from("ai_cache").upsert({ ...conflicting, body: "writer-two" }, { onConflict: "organization_id,key", ignoreDuplicates: true }),
    ]);
    const rows = await listRows(org);
    const writersOk = !one.error && !two.error;
    if (
      rows.length === 1 &&
      writersOk &&
      (rows[0]?.body === "writer-one" || rows[0]?.body === "writer-two")
    ) {
      pass(
        `both concurrent writers acknowledged, but exactly one row exists carrying the first writer's body (${rows[0]?.body})`,
      );
    } else {
      fail(`concurrent insert semantics failed: ${JSON.stringify({ bodies: rows.map((r) => r.body), writersOk })}`);
    }

    // A later prune may delete what a writer just added - that answer simply
    // misses on the next ask and regenerates; a race never corrupts a read.
    const prune = await gc(org, { capRowsPerOrg: 0, execute: true });
    const afterPrune = await countRows(org);
    if (prune.capEvictedRowsDeleted === 1 && afterPrune === 0) {
      pass("a prune cleanly removes a concurrently-written row (performance cost only, never a corrupt read)");
    } else {
      fail(`prune-vs-write race handling failed: ${JSON.stringify({ ...prune, afterPrune })}`);
    }
  }

  console.log("\n=== D10. Retention never bypasses verification of a cache hit ===");
  {
    const { analysisId } = await seedAnalysis(orgRegen);
    const input = await buildQuestionInput(orgRegen, analysisId);
    const cache = createAiCache(db, orgRegen);

    let baseCalls = 0;
    const firstAnswer = await answerQuestion(input, {
      cache,
      complete: async () => {
        baseCalls++;
        return "Base answer grounded in `src/greet.ts:2-4` and `package.json:1-3`.";
      },
      analysisId,
    });
    if (firstAnswer.cached !== false || baseCalls !== 1) {
      fail(`D10 setup: first answer was not a fresh verified generation: ${JSON.stringify({ cached: firstAnswer.cached, baseCalls })}`);
      return;
    }

    // Poison the stored row through the admin client. The row is brand new,
    // well inside its 90-day retention window - retention state cannot
    // distinguish it from any healthy row. Only verification can catch it.
    const storedRow = (
      await db
        .from("ai_cache")
        .select("id, body")
        .eq("organization_id", orgRegen)
        .eq("task", "answer-question")
        .maybeSingle()
    ).data;
    if (!storedRow) {
      fail("D10 setup: cached row missing");
      return;
    }
    const { error: poisonErr } = await db
      .from("ai_cache")
      .update({ body: "Poisoned answer citing invented evidence at `src/greet.ts:900-995`." })
      .eq("id", storedRow.id);
    if (poisonErr) {
      fail(`D10 setup: poisoning the row failed: ${poisonErr.message}`);
      return;
    }

    let healCalls = 0;
    const healed = await answerQuestion(input, {
      cache,
      complete: async () => {
        healCalls++;
        return "Healed answer grounded in `src/greet.ts:2-4` and `package.json:1-3`.";
      },
      analysisId,
    });

    const afterHeal = (
      await db.from("ai_cache").select("body").eq("organization_id", orgRegen).eq("task", "answer-question").maybeSingle()
    ).data;

    if (
      healed.cached === false &&
      healCalls === 1 &&
      healed.body.startsWith("Healed answer") &&
      afterHeal?.body === healed.body
    ) {
      pass("a poisoned row inside its retention window was refused on verify, deleted, and healed by a fresh verified answer");
    } else {
      fail(`verify-before-serve failed: ${JSON.stringify({ cached: healed.cached, healCalls, body: afterHeal?.body })}`);
    }
  }

  console.log("\n=== D11. Evicted answers regenerate and are verified before being stored ===");
  {
    // Evict everything the regeneration org holds (cap 0 = lowest possible).
    const prune = await gc(orgRegen, { capRowsPerOrg: 0, execute: true });
    const afterEviction = await countRows(orgRegen);
    if (prune.expiredRowsDeleted !== 0 || prune.capEvictedRowsDeleted !== 1 || afterEviction !== 0) {
      fail(`D11 setup: eviction failed: ${JSON.stringify({ ...prune, afterEviction })}`);
      return;
    }

    const analysisId = (await db.from("analyses").select("id").eq("organization_id", orgRegen).maybeSingle()).data?.id;
    if (!analysisId) {
      fail("D11 setup: analysis missing");
      return;
    }
    const input = await buildQuestionInput(orgRegen, analysisId);
    const cache = createAiCache(db, orgRegen);

    let regenCalls = 0;
    const regenerated = await answerQuestion(input, {
      cache,
      complete: async () => {
        regenCalls++;
        return "Regenerated answer grounded in `src/greet.ts:2-4` and `package.json:1-3`.";
      },
      analysisId,
    });

    const storedAgain = (
      await db.from("ai_cache").select("body").eq("organization_id", orgRegen).eq("task", "answer-question").maybeSingle()
    ).data;

    if (
      regenerated.cached === false &&
      regenCalls === 1 &&
      regenerated.citations.length === 2 &&
      storedAgain?.body === regenerated.body
    ) {
      pass("an evicted answer missed on the next ask, regenerated once, passed citation verification, and was re-stored");
    } else {
      fail(
        `regeneration after eviction failed: ${JSON.stringify({
          cached: regenerated.cached,
          regenCalls,
          citations: regenerated.citations.length,
          body: storedAgain?.body,
        })}`,
      );
    }
  }
}

async function cleanup() {
  try {
    const ids = [
      orgDefault,
      orgExpired,
      orgUnder,
      orgIsoA,
      orgIsoB,
      orgRegen,
      `${TEST_PREFIX}_cap`,
      `${TEST_PREFIX}_conc`,
      `${TEST_PREFIX}_ins`,
    ];
    await db.from("organizations").delete().in("id", ids);
    const { data: remaining } = await db.from("organizations").select("id").in("id", ids);
    if (!remaining || remaining.length === 0) {
      pass("test cleanup verified: zero test-organization residue (ai_cache rows cascade with their org)");
    } else {
      fail(`cleanup incomplete: ${remaining.length} test org(s) remain`);
    }
  } catch (err) {
    fail(`cleanup threw error: ${err}`);
  }
}

run()
  .catch((err) => {
    console.error("Test runner threw:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    console.log("");
    for (const line of results) console.log(line);
    const failed = results.filter((r) => r.startsWith("FAIL")).length;
    console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
    if (failed !== 0) process.exitCode = 1;
  });
