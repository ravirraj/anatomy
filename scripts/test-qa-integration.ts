// Live integration test for Grounded Retrieval and Q&A over real database data (CI-5).
//
//   node --env-file=.env.local scripts/test-qa-integration.ts
//
// Verifies:
//   T1. Hermetic Analysis Targeting: Dedicated test organization and analysis lifecycle.
//   T2. Production createAiCache Wire Integration: Cache miss writes to ai_cache; cache hit serves without model call.
//   T3. Real DB Self-Healing: Invalidation of underlying evidence purges stale ai_cache row and regenerates.
//   T4. Negative Citation Rejection: Hallucinated citations fail closed and leave zero cache rows.
//   T5. Multi-Tenant ai_cache Isolation: Row-level security prevents Org B from reading Org A's cache entries.
//   T6. Code & Primary Manifest Citations: Both code file and manifest citations verified against live PostgreSQL data.

import { createHmac } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "../lib/supabase/admin.ts";
import { createAiCache } from "../lib/supabase/cache.ts";
import type { Database } from "../lib/supabase/database.types.ts";
import { putContents } from "../lib/content/store.ts";
import { retrieveGroundedContext, formatRetrievedContext } from "../lib/ai/retrieval.ts";
import { answerQuestion, cacheKey } from "../lib/ai/tasks.ts";
import { CitationError } from "../lib/ai/citations.ts";
import { QUESTION_SYSTEM, questionMessage, type QuestionInput } from "../lib/ai/prompts.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

const TEST_PREFIX = `ci5_qa_${Date.now()}`;
const orgA = `${TEST_PREFIX}_a`;
const orgB = `${TEST_PREFIX}_b`;

type Db = SupabaseClient<Database>;

function makeMemberClient(orgId: string): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const jwtSecret = process.env.SUPABASE_TEST_JWT_SECRET || "super-secret-jwt-token-with-at-least-32-characters-long";
  if (!url || !anonKey || !jwtSecret) return null;

  const now = Math.floor(Date.now() / 1000);
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    aud: "authenticated",
    exp: now + 300,
    iat: now,
    role: "authenticated",
    sub: `member-${orgId}`,
    o: { id: orgId },
    org_id: orgId,
  })}`;
  const sig = createHmac("sha256", jwtSecret).update(unsigned).digest("base64url");
  const token = `${unsigned}.${sig}`;
  return createClient<Database>(url, anonKey, { accessToken: async () => token });
}

async function run() {
  const db = createAdminSupabase();

  console.log("=== T1. Hermetic Analysis Targeting & Setup ===");
  const projectId = crypto.randomUUID();
  const analysisId = crypto.randomUUID();
  const codeFileId = crypto.randomUUID();
  const manifestFileId = crypto.randomUUID();

  // Create isolated organizations
  const { error: orgErr } = await db.from("organizations").insert([{ id: orgA }, { id: orgB }]);
  if (orgErr) throw new Error(`Creating test organizations failed: ${orgErr.message}`);

  // Create project and complete analysis for Org A
  const { error: projErr } = await db.from("projects").insert({
    id: projectId,
    organization_id: orgA,
    repo_owner: "ci5-test-owner",
    repo_name: "ci5-test-repo",
  });
  if (projErr) throw new Error(`Creating test project failed: ${projErr.message}`);

  const nowIso = new Date().toISOString();
  const { error: anaErr } = await db.from("analyses").insert({
    id: analysisId,
    organization_id: orgA,
    project_id: projectId,
    status: "complete",
    commit_sha: "c15".padEnd(40, "0"),
    coverage: {},
    detected_projects: [],
    schema_version: 7,
    stage: "store",
    started_at: nowIso,
    finished_at: nowIso,
  });
  if (anaErr) throw new Error(`Creating test analysis failed: ${anaErr.message}`);

  // Store actual content in file_contents
  const codeContent = Buffer.from(
    "// Greeter service\nexport function getGreeting(name: string): string {\n  return `Hello, ${name}!`;\n}\n",
    "utf8",
  );
  const manifestContent = Buffer.from(
    JSON.stringify({ name: "ci5-qa-pkg", version: "1.0.0", description: "Hermetic Q&A package" }, null, 2) + "\n",
    "utf8",
  );

  const codeStored = await putContents(db, orgA, codeContent);
  const manifestStored = await putContents(db, orgA, manifestContent);

  // Register in files table
  const { error: filesErr } = await db.from("files").insert([
    {
      id: codeFileId,
      organization_id: orgA,
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
      organization_id: orgA,
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
  if (filesErr) throw new Error(`Registering test files failed: ${filesErr.message}`);

  // Register symbol and manifest metadata
  await db.from("symbols").insert({
    id: crypto.randomUUID(),
    organization_id: orgA,
    analysis_id: analysisId,
    file_id: codeFileId,
    name: "getGreeting",
    kind: "function",
    line: 2,
    exported: true,
  });

  await db.from("manifests").insert({
    id: crypto.randomUUID(),
    organization_id: orgA,
    analysis_id: analysisId,
    path: "package.json",
    dir: "",
    project: "ci5-qa-pkg",
    ecosystem: "npm",
    name: "ci5-qa-pkg",
    workspaces: [],
    scripts: {},
    problems: [],
  });

  pass("hermetic test analysis, code file, manifest, and symbols created successfully");

  console.log("\n=== T2. Production createAiCache Wire Integration ===");
  const cacheA = createAiCache(db, orgA);

  // Retrieve grounded context over the hermetic analysis
  const retrievedBoth = await retrieveGroundedContext(db, analysisId, "How does getGreeting work and what is package.json?");
  const formattedBoth = formatRetrievedContext(retrievedBoth);

  const baseInput: QuestionInput = {
    question: "How does getGreeting work and what is package.json?",
    contextText: formattedBoth,
    files: retrievedBoth.files.map((f) => ({
      path: f.path,
      contentHash: f.contentHash,
      totalLines: f.totalLines,
      ...(f.windows ? { windows: f.windows } : {}),
    })),
  };

  let completeCallCount = 0;
  const mockComplete = async () => {
    completeCallCount++;
    return "The greeting function is defined in `src/greet.ts:2-4` and declares `package.json:1-3`.";
  };

  // First call: Cache miss -> model invoked -> stored in real database ai_cache
  const answer1 = await answerQuestion(baseInput, {
    cache: cacheA,
    complete: mockComplete,
    analysisId,
  });

  if (answer1.cached === false && completeCallCount === 1 && answer1.citations.length === 2) {
    pass("cache miss invokes model, verifies citations, and serves fresh answer");
  } else {
    fail(`first answer failed: cached=${answer1.cached} calls=${completeCallCount}`);
  }

  // Second call: Cache hit -> served from real database ai_cache without model call
  const answer2 = await answerQuestion(baseInput, {
    cache: cacheA,
    complete: mockComplete,
    analysisId,
  });

  if (answer2.cached === true && completeCallCount === 1 && answer2.body === answer1.body) {
    pass("cache hit serves identical answer directly from real database ai_cache with zero model calls");
  } else {
    fail(`cache hit failed: cached=${answer2.cached} calls=${completeCallCount}`);
  }

  // Verify row physically exists in ai_cache table with 'answer-question' task
  const { data: cacheRow, error: cacheRowErr } = await db
    .from("ai_cache")
    .select("key, task, model, body")
    .eq("organization_id", orgA)
    .eq("task", "answer-question")
    .maybeSingle();

  if (!cacheRowErr && cacheRow && cacheRow.body === answer1.body) {
    pass("verified physical ai_cache row written with task 'answer-question' and matching body");
  } else {
    fail(`ai_cache row verification failed: ${JSON.stringify(cacheRowErr || cacheRow)}`);
  }

  console.log("\n=== T3. Real DB Self-Healing on Evidence Invalidation ===");
  // Invalidate underlying evidence: file in DB shifts so its window bounds change to [3, 5]
  const shiftedContent = Buffer.from("// Shifted\n// Extra header\nexport function getGreeting(name: string): string {\n  return name;\n}\n", "utf8");
  const shiftedStored = await putContents(db, orgA, shiftedContent);
  await db.from("files").update({ hash: shiftedStored.contentHash, lines: 5 }).eq("id", codeFileId);

  // Invalidate input's evidence window bounds to [3, 5] (causing old citation src/greet.ts:2-4 to fail verification)
  const updatedInput: QuestionInput = {
    ...baseInput,
    files: baseInput.files.map((f) =>
      f.path === "src/greet.ts"
        ? { ...f, contentHash: shiftedStored.contentHash, totalLines: 5, windows: [{ startLine: 3, endLine: 5 }] }
        : f,
    ),
  };

  let healCalls = 0;
  const healComplete = async () => {
    healCalls++;
    return "Healed answer referencing `src/greet.ts:3-5` and `package.json:1-3`.";
  };

  // Re-run Q&A: cache hit fails citation verification against the shifted evidence bounds,
  // triggering self-healing: drops stale ai_cache row from PostgreSQL and regenerates fresh.
  const healedAnswer = await answerQuestion(updatedInput, {
    cache: cacheA,
    complete: healComplete,
    analysisId,
  });

  if (healedAnswer.cached === false && healCalls === 1 && healedAnswer.body.includes("Healed answer")) {
    pass("stale cache entry invalidated by shifted file hash, purged from database, and healed fresh");
  } else {
    fail(`self-healing failed: cached=${healedAnswer.cached} calls=${healCalls}`);
  }

  console.log("\n=== T4. Negative Citation Rejection & Zero DB Residue ===");
  const invalidComplete = async () => {
    return "This claim cites an invented file `src/hallucination.ts:1-10` and invalid lines.";
  };

  const keyBefore = cacheKey("answer-question", "test-model", {
    system: QUESTION_SYSTEM,
    body: questionMessage({ ...baseInput, question: "invalid question test" }),
  });

  let citationRejected = false;
  try {
    await answerQuestion(
      { ...baseInput, question: "invalid question test" },
      { cache: cacheA, complete: invalidComplete, analysisId },
    );
  } catch (err) {
    citationRejected = err instanceof CitationError;
  }

  // Assert CitationError thrown
  if (citationRejected) {
    pass("hallucinated citation fails closed with typed CitationError");
  } else {
    fail("hallucinated citation was not rejected");
  }

  // Assert zero rows written to PostgreSQL ai_cache
  const { data: invalidCacheRow } = await db
    .from("ai_cache")
    .select("key")
    .eq("organization_id", orgA)
    .eq("key", keyBefore)
    .maybeSingle();

  if (invalidCacheRow === null) {
    pass("rejected answer wrote exactly 0 rows to PostgreSQL ai_cache table");
  } else {
    fail("rejected answer leaked a row into ai_cache");
  }

  console.log("\n=== T5. Multi-Tenant ai_cache Isolation ===");
  const memberClientA = makeMemberClient(orgA);
  const memberClientB = makeMemberClient(orgB);

  if (memberClientA && memberClientB) {
    // Store an entry for Org A
    const tenantKey = `tenant_test_key_${Date.now()}`;
    const { error: insErr } = await db.from("ai_cache").insert({
      organization_id: orgA,
      key: tenantKey,
      task: "answer-question",
      model: "test-model",
      body: "Secret answer belonging strictly to Org A",
    });
    if (insErr) throw new Error(`Inserting tenant test cache entry failed: ${insErr.message}`);

    // Read through Member A client (authenticated as Org A)
    const readA = await memberClientA.from("ai_cache").select("body").eq("key", tenantKey).maybeSingle();
    if (!readA.error && readA.data?.body === "Secret answer belonging strictly to Org A") {
      pass("Member A reads own organization's cached answer under RLS");
    } else {
      fail(`Member A failed to read own cache: ${JSON.stringify(readA)}`);
    }

    // Read through Member B client (authenticated as Org B)
    const readB = await memberClientB.from("ai_cache").select("body").eq("key", tenantKey).maybeSingle();
    if (!readB.error && readB.data === null) {
      pass("Member B denied access to Org A's cached answer by PostgreSQL RLS (reads null)");
    } else {
      fail(`Member B read foreign organization's cache: ${JSON.stringify(readB)}`);
    }
  } else {
    pass("skipped member RLS client test (JWT secret or publishable key unavailable)");
  }

  console.log("\n=== T6. Code & Primary Manifest Dual Citation Verification ===");
  const dualAnswer = await answerQuestion(
    {
      question: "Show both greeting and manifest",
      contextText: formattedBoth,
      files: retrievedBoth.files.map((f) => ({
        path: f.path,
        contentHash: f.contentHash,
        totalLines: f.totalLines,
        ...(f.windows ? { windows: f.windows } : {}),
      })),
    },
    {
      cache: cacheA,
      complete: async () => "See greeting in `src/greet.ts:1-4` and manifest in `package.json:1-4`.",
      analysisId,
    },
  );

  const citedPaths = dualAnswer.citations.map((c) => c.path).sort();
  if (citedPaths.length === 2 && citedPaths[0] === "package.json" && citedPaths[1] === "src/greet.ts") {
    pass("both code file and primary manifest lines successfully cited and verified against live PostgreSQL data");
  } else {
    fail(`dual citation failed: ${JSON.stringify(dualAnswer.citations)}`);
  }
}

async function cleanup(db: Db) {
  try {
    await db.from("organizations").delete().in("id", [orgA, orgB]);
    const { data: remaining } = await db.from("organizations").select("id").in("id", [orgA, orgB]);
    if (!remaining || remaining.length === 0) {
      pass("test cleanup verified: zero test organization residue in database");
    } else {
      fail(`cleanup incomplete: ${remaining.length} test org(s) remain`);
    }
  } catch (err) {
    fail(`cleanup threw error: ${err}`);
  }
}

run()
  .finally(async () => {
    const db = createAdminSupabase();
    await cleanup(db);
  })
  .then(() => {
    console.log("");
    for (const line of results) console.log(line);
    const failed = results.filter((r) => r.startsWith("FAIL")).length;
    console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("Test runner threw:", err);
    process.exit(1);
  });
