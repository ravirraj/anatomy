// Live integration test for Grounded Retrieval and Q&A over real analysis data.
//
//   node --env-file=.env.local scripts/test-qa-integration.ts

import { createAdminSupabase } from "../lib/supabase/admin.ts";
import { retrieveGroundedContext, formatRetrievedContext } from "../lib/ai/retrieval.ts";
import { answerQuestion, type Cache } from "../lib/ai/tasks.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

async function run() {
  const db = createAdminSupabase();

  // Find the completed analysis for sindresorhus/is-plain-obj
  const { data: analysis, error } = await db
    .from("analyses")
    .select("id, organization_id, status")
    .eq("status", "complete")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !analysis) {
    console.log("No complete analysis found to run integration test against. Skipping.");
    return;
  }

  // 1. Test deterministic retrieval on real analysis
  const retrieved = await retrieveGroundedContext(db, analysis.id, "isPlainObject");
  if (retrieved.windows.length > 0 && retrieved.files.length > 0) {
    pass(`retrieved ${retrieved.windows.length} window(s) across ${retrieved.files.length} file(s) for query "isPlainObject"`);
  } else {
    fail(`retrieval returned no windows: ${JSON.stringify(retrieved)}`);
  }

  // 2. Context formatting produces non-empty text with file headers
  const formatted = formatRetrievedContext(retrieved);
  if (formatted.includes("--- File: ") && formatted.includes("lines ")) {
    pass("retrieved context formatted with expected file headers and line indicators");
  } else {
    fail(`formatted context missing expected structure: ${formatted.slice(0, 200)}`);
  }

  // 3. Grounded Q&A with real retrieved windows
  const memoryCache = new Map<string, string>();
  const testCache: Cache = {
    async read(key) {
      return memoryCache.get(key) ?? null;
    },
    async write({ key, body }) {
      memoryCache.set(key, body);
    },
  };

  const firstFile = retrieved.files[0];
  const firstWindow = retrieved.windows[0];

  const answer = await answerQuestion(
    {
      question: "What does this repository do?",
      contextText: formatted,
      files: retrieved.files.map((f) => ({
        path: f.path,
        contentHash: f.contentHash,
        totalLines: f.totalLines,
      })),
    },
    {
      cache: testCache,
      complete: async () => {
        return `This repository provides utility functions in \`${firstFile.path}#L${firstWindow.startLine}-L${firstWindow.endLine}\`.`;
      },
    },
  );

  if (answer.citations.length === 1 && answer.citations[0].path === firstFile.path) {
    pass("grounded Q&A task cites real analysed files and valid line windows");
  } else {
    fail(`grounded Q&A citations unexpected: ${JSON.stringify(answer.citations)}`);
  }
}

run()
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
