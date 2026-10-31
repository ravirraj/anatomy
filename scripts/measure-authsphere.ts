// Live measurement: end-to-end grounded Q&A for the authsphere analysis.
//   node --env-file=.env.remote.local --env-file=.env.local scripts/measure-authsphere.ts
import { createAdminSupabase } from "file:///C:/Users/thorfinn/projects/cartograph/lib/supabase/admin.ts";
import { retrieveGroundedContext, formatRetrievedContext } from "file:///C:/Users/thorfinn/projects/cartograph/lib/ai/retrieval.ts";
import { answerQuestion, type Cache } from "file:///C:/Users/thorfinn/projects/cartograph/lib/ai/tasks.ts";

const db = createAdminSupabase();

const { data: proj } = await db.from("projects").select("id").or("repo_name.eq.authsphere").maybeSingle();
const { data: an } = await db.from("analyses").select("id, organization_id").eq("project_id", proj.id).order("created_at", { ascending: false }).limit(1);
const analysisId = an[0].id;
console.log("analysis:", analysisId);

const question = "How does authentication work?";
const t0 = performance.now();
const retrieved = await retrieveGroundedContext(db, analysisId, question);
const tRet = Math.round(performance.now() - t0);
console.log(`retrieval: files=${retrieved.files.length} windows=${retrieved.windows.length} chars=${retrieved.totalCharacters} ms=${tRet}`);
console.log("files:", retrieved.files.map((f) => f.path).join(", "));

const t1 = performance.now();
const formatted = formatRetrievedContext(retrieved);
const tFmt = Math.round(performance.now() - t1);

const { data: allFilesData } = await db.from("files").select("path").eq("analysis_id", analysisId).is("skip_reason", null);
const allAnalysisFiles = new Set((allFilesData ?? []).map((f) => f.path));

const memoryCache = new Map<string, string>();
const cache: Cache = {
  async read(key) { return memoryCache.get(key) ?? null; },
  async write({ key, body }) { memoryCache.set(key, body); },
};

const t2 = performance.now();
let body: string;
let citations: unknown;
try {
  const answer = await answerQuestion(
    {
      question,
      contextText: formatted,
      files: retrieved.files.map((f) => ({ path: f.path, contentHash: f.contentHash, totalLines: f.totalLines })),
    },
    { cache, allAnalysisFiles },
  );
  body = answer.body;
  citations = answer.citations;
} catch (error) {
  console.log("ANSWER FAILED:", error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : String(error));
  process.exit(1);
}
const tAnswer = Math.round(performance.now() - t2);
console.log(`answer: ms=${tAnswer} formattingMs=${tFmt} bodyChars=${body.length}`);
console.log("citations:", JSON.stringify(citations));
console.log("--- body ---");
console.log(body.slice(0, 2200));
