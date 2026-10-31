// Tests Phase 5: coverage evaluation (lib/ai/coverage.ts).
// Pure deterministic checks: no database, no LLM. Scenarios are crafted
// evidence packages shaped like the authsphere and SDK cases, plus
// structural and determinism invariants.

import {
  planQuestion,
  type PlannedConcept,
  type QuestionPlan,
} from "../lib/ai/planner.ts";
import {
  evaluateCoverage,
  CATEGORY_AFFILIATION,
  UNKNOWN_NOTE,
  type CoverageEvaluation,
  type CoverageStatus,
} from "../lib/ai/coverage.ts";
import type { RetrievalResult, RetrievedWindow } from "../lib/ai/retrieval.ts";

const results: string[] = [];
function pass(message: string): void {
  results.push(`ok    ${message}`);
}
function fail(message: string): void {
  results.push(`FAIL  ${message}`);
}
function check(condition: boolean, okMessage: string, failMessage: string): void {
  if (condition) pass(okMessage);
  else fail(failMessage);
}

type CraftedWindow = {
  path: string;
  text: string;
  reason?: string;
  provenance?: "indexed" | "derived";
  startLine?: number;
  endLine?: number;
};

function evaluateScenario(
  query: string,
  windows: CraftedWindow[],
): { plan: QuestionPlan; evaluation: CoverageEvaluation } {
  const plan = planQuestion(query);
  const retrieved: RetrievedWindow[] = windows.map((w, i) => ({
    fileId: `w${i}`,
    path: w.path,
    contentHash: `hash${i}`,
    totalLines: 140,
    startLine: w.startLine ?? 1,
    endLine: w.endLine ?? 45,
    score: 80,
    text: w.text,
    reason: w.reason ?? `file path matches token "x"`,
    ...(w.provenance !== undefined ? { provenance: w.provenance } : {}),
  }));
  const result: RetrievalResult = {
    analysisId: "cov_analysis",
    query,
    tokens: plan.concepts.map((c) => c.token),
    plan,
    windows: retrieved,
    files: retrieved.map((w) => ({
      fileId: w.fileId,
      path: w.path,
      contentHash: w.contentHash,
      totalLines: w.totalLines,
    })),
    totalCharacters: retrieved.reduce((acc, w) => acc + w.text.length, 0),
    insufficientEvidence: retrieved.length === 0,
  };
  return { plan, evaluation: evaluateCoverage(plan, result) };
}

function categoryEval(
  evaluation: CoverageEvaluation,
  token: string,
  category: string,
) {
  return evaluation.concepts
    .find((c) => c.token === token)
    ?.categories.find((c) => c.category === category);
}

// ---- 1. found requires source text, not a matching filename ----
{
  const { evaluation } = evaluateScenario("How does authentication work?", [
    {
      // Real source evidence: the concept vocabulary appears in the code.
      path: "src/controllers/login.controller.js",
      text: "export async function login(request, response) {\n  const token = jwt.sign(user);\n}",
      reason: `symbol "login" (function) matches token "authentication"`,
    },
    {
      // Second affiliated controller whose retrieved slice has no concept
      // vocabulary — it must never flip or inflate the verdict.
      path: "src/controllers/loginController.js",
      text: "const rate = 5; // unrelated slice",
      reason: `file path matches token "authentication"`,
    },
  ]);
  const controllers = categoryEval(evaluation, "authentication", "controllers");
  check(
    controllers?.status === "found" && controllers.evidence[0]?.signal === "source-text" && controllers.evidence[0]?.matchedVariant !== undefined,
    "found is produced by actual source text, with the matched variant recorded",
    `controllers coverage wrong: ${JSON.stringify(controllers)}`,
  );
  const second = controllers?.evidence.find((e) => e.path === "src/controllers/loginController.js");
  check(
    second !== undefined && second.signal === "filename-or-role" && second.matchedVariant === undefined,
    "a concept-free slice of an affiliated file stays weak evidence (filename-or-role)",
    `weak evidence wrong: ${JSON.stringify(second)}`,
  );
}

// ---- 2. A filename echoed inside window text cannot produce found ----
{
  // The route vocabulary in the text comes from a path-like token, which
  // the evaluator scrubs before matching.
  const { evaluation } = evaluateScenario("How does the billing route work?", [
    {
      path: "src/routes/billing.routes.js",
      text: "// line 12 of src/routes/billing.routes.js\n// line 13 of src/routes/billing.routes.js",
      reason: `file path matches token "billing"`,
    },
  ]);
  const routes = evaluation.concepts.flatMap((c) => c.categories).find((c) => c.category === "routes");
  check(
    routes?.status === "partial" && routes.evidence[0]?.signal === "filename-or-role" && routes.evidence[0]?.matchedVariant === undefined,
    "path-like echoes in window text are scrubbed: filename alone can never reach found",
    `routes coverage wrong: ${JSON.stringify(routes)}`,
  );
}

// ---- 3. Provenance is preserved on evidence (direct / indexed / derived) ----
{
  const { evaluation } = evaluateScenario("How does authentication work?", [
    {
      path: "src/middlewares/auth.middleware.js",
      text: "function authenticateToken(token) {\n  return jwt.verifyTok(token);\n}",
    },
    {
      path: "backend/src/middlewares/auth.middleware.js",
      text: "function authenticateToken(token) {\n  return jwt.verifyTok(token);\n}",
      provenance: "indexed",
    },
    {
      path: "packages/src/client/session.ts",
      text: "export const fetchWithAuth = (url) => session.get(url);",
      provenance: "derived",
    },
  ]);
  const middleware = categoryEval(evaluation, "authentication", "middleware");
  check(
    middleware?.status === "found" && middleware.evidence.some((e) => e.provenance === "direct") && middleware.evidence.some((e) => e.provenance === "indexed"),
    "source-text evidence keeps both direct and indexed provenance",
    `middleware coverage wrong: ${JSON.stringify(middleware)}`,
  );
  const frontend = categoryEval(evaluation, "authentication", "frontend");
  check(
    frontend?.status === "found" && frontend.evidence.some((e) => e.provenance === "derived"),
    "a derived window with real concept text founds its category and keeps the derived mark",
    `frontend coverage wrong: ${JSON.stringify(frontend)}`,
  );
}

// ---- 4. Symbol-name and relationship support yields partial, not found ----
{
  const { evaluation } = evaluateScenario("How does authentication work?", [
    {
      path: "src/controllers/apiLogin.js",
      text: "const dependencies = require('express');",
      reason: `symbol "apiLoginRoute" (function) matches token "authentication"`,
    },
  ]);
  const controllers = categoryEval(evaluation, "authentication", "controllers");
  check(
    controllers?.status === "partial" && controllers.evidence[0]?.signal === "symbol-name",
    "symbol-name echo support is partial, never found",
    `controllers coverage wrong: ${JSON.stringify(controllers)}`,
  );

  const { evaluation: rel } = evaluateScenario("How does authentication work?", [
    {
      path: "src/models/userSession.model.js",
      text: "module.exports = { tableName: 'users' };",
      reason: `derived import reference to "src/models/userSession.model.js" in inspected window of "x" (derived, not an indexed edge)`,
      provenance: "derived",
    },
  ]);
  const models = categoryEval(rel, "authentication", "models");
  check(
    models?.status === "partial" && models.evidence[0]?.signal === "relationship-derived" && models.evidence[0]?.provenance === "derived",
    "derived relationship support is partial with derived provenance",
    `models coverage wrong: ${JSON.stringify(models)}`,
  );
}

// ---- 5. Missing affiliated files leave the category unknown ----
{
  const { evaluation } = evaluateScenario("How does authentication work?", [
    { path: "src/pages/Login.jsx", text: "export const LoginPage = () => null;" },
  ]);
  const middleware = categoryEval(evaluation, "authentication", "middleware");
  const models = categoryEval(evaluation, "authentication", "models");
  check(
    middleware?.status === "unknown" && models?.status === "unknown" && middleware.evidence.length === 0 && models.evidence.length === 0,
    "categories with no affiliated retrieved files evaluate to unknown",
    `missing-category coverage wrong: ${JSON.stringify([middleware, models])}`,
  );
  check(
    (middleware?.reason ?? "").includes("no retrieved file is affiliated"),
    "unknown verdicts state their epistemic meaning in the reason",
    `unknown reason wrong: ${middleware?.reason}`,
  );
  // frontend has real evidence; summary must line up exactly.
  check(
    evaluation.summary.found === 1 && evaluation.summary.partial === 0 && evaluation.summary.unknown === 3,
    `summary counts match per-category verdicts (${JSON.stringify(evaluation.summary)})`,
    `summary wrong: ${JSON.stringify(evaluation.summary)}`,
  );
  check(
    evaluation.unknownNote === UNKNOWN_NOTE && UNKNOWN_NOTE.includes("never proof"),
    "unknown is never presented as proof of nonexistence (fixed note attached)",
    "unknownNote missing or wrong",
  );
}

// ---- 6. Whole-segment affiliation (no substring leakage) ----
{
  const { evaluation } = evaluateScenario("How does authentication work?", [
    { path: "src/modeling/sculpts.js", text: "export function sculpt() {}" },
  ]);
  const models = categoryEval(evaluation, "authentication", "models");
  check(
    models?.status === "unknown",
    "affiliation matches whole path segments only (\"modeling\" is not \"models\")",
    `models coverage wrong: ${JSON.stringify(models)}`,
  );
}

// ---- 7. Architectural role recorded in the reason affiliates too ----
{
  const { evaluation } = evaluateScenario("How does the database connection work?", [
    {
      path: "src/core/usePool.js",
      text: "export function withPool(fn) { return fn; }",
      reason: `file holds the "service" role, which the question's topic names`,
    },
  ]);
  const serviceCategories = evaluation.concepts
    .flatMap((c) => c.categories)
    .filter((c) => c.category === "services");
  check(
    serviceCategories.length > 0 && serviceCategories.every((c) => c.status === "partial" && c.evidence[0]?.signal === "filename-or-role"),
    "role-labelled retrieval evidence affiliates its category (partial without text)",
    `services coverage wrong: ${JSON.stringify(serviceCategories)}`,
  );
}

// ---- 8. Authsphere-shaped scenario: status pattern + per-concept structure ----
{
  const { evaluation } = evaluateScenario("How does authentication work?", [
    {
      path: "backend/src/controllers/session.controller.js",
      text: "export const getDeveloperSessions = async (req) => sessionStore.verifyToken(req.user);",
      reason: `symbol "getDeveloperSessions" (const) matches token "authentication"`,
    },
    {
      path: "backend/src/middlewares/auth.middleware.js",
      text: "const token = jwt.decode(req.headers.authorization);",
      provenance: "indexed",
      reason: `1-hop dependency connected to seed "backend/src/routes" (indexed import edge)`,
    },
    {
      path: "backend/src/models/session.model.js",
      text: "module.exports = { region: 'eu-west' };",
      reason: `file path matches token "authentication"`,
    },
    {
      path: "frontend/src/pages/auth/Login.jsx",
      text: "const Login = () => { const token = useAuthStore(); return <form />; };",
    },
  ]);
  const statuses = new Map(
    evaluation.concepts[0]!.categories.map((c) => [c.category, c.status] as const),
  );
  const everyCategoryCovered =
    evaluation.concepts[0]!.categories.map((c) => c.category).join(",") ===
    ["controllers", "middleware", "models", "frontend"].join(",");
  check(
    everyCategoryCovered,
    "every expected category is evaluated exactly once per concept",
    `category structure wrong: ${JSON.stringify(evaluation.concepts[0]!.categories.map((c) => c.category))}`,
  );
  check(
    statuses.get("controllers") === "found" && statuses.get("middleware") === "found" && statuses.get("models") === "partial" && statuses.get("frontend") === "found",
    `authsphere-shaped pattern: controllers/middleware/frontend found, models partial (${JSON.stringify([...statuses])})`,
    `authsphere pattern wrong: ${JSON.stringify([...statuses])}`,
  );
  const findingReason = evaluation.concepts[0]!.categories.find((c) => c.status === "found")!.reason;
  check(
    findingReason.includes("source text in") && findingReason.includes(`establishes the "`),
    "found reasons name the files and provenance that establish the category",
    `found reason wrong: ${findingReason}`,
  );
}

// ---- 9. SDK-shaped scenario: dual concepts, empty-category concept ----
{
  const { plan, evaluation } = evaluateScenario("How does the SDK work, and how does a developer use the SDK?", [
    {
      path: "backend/src/routes/developer.routes.js",
      text: "router.get('/developer/sdk/keys', validate, issueDeveloperKey);",
      provenance: "indexed",
      reason: `1-hop dependency connected to seed "backend" (indexed import edge)`,
    },
    {
      path: "backend/src/controllers/developer.controller.js",
      text: "export async function issueDeveloperKey(req) {}",
      reason: `symbol "issueDeveloperKey" (function) matches token "sdk"`,
    },
    {
      path: "packages/src/client/keys.ts",
      text: "export const listKeys = async () => fetch('/developer/sdk/keys');",
      provenance: "derived",
      reason: `derived import reference to "packages/src/client/keys.ts" in inspected window of "packages" (derived, not an indexed edge)`,
    },
  ]);
  const sdkConcept = evaluation.concepts.find((c) => c.token === "sdk")!;
  check(
    plan.concepts.some((c) => c.token === "developer" && c.expectedEvidence.length === 0) &&
      evaluation.concepts.find((c) => c.token === "developer")!.categories.length === 0,
    "concepts without expected categories evaluate to nothing (vacuously covered)",
    "developer concept should contribute no categories",
  );
  const statuses = new Map(sdkConcept.categories.map((c) => [c.category, c.status] as const));
  check(
    statuses.get("routes") === "found" && statuses.get("controllers") === "partial" && statuses.get("frontend") === "found",
    `sdk pattern: routes/frontend found (indexed + derived), controllers partial on symbol name (${JSON.stringify([...statuses])})`,
    `sdk pattern wrong: ${JSON.stringify([...statuses])}`,
  );
}

// ---- 10. Affiliation table covers exactly the planner's categories ----
{
  const planned = new Set<string>();
  for (const word of ["auth", "db", "upload", "error", "sdk", "api", "config", "ui", "cors"]) {
    planQuestion(`How does the ${word} layer fit together?`).concepts.forEach((c) =>
      c.expectedEvidence.forEach((cat) => planned.add(cat)),
    );
  }
  const tableKeys = new Set(Object.keys(CATEGORY_AFFILIATION));
  const missing = [...planned].filter((c) => !tableKeys.has(c));
  check(
    missing.length === 0 && planned.size > 0,
    `every planner category has an affiliation rule (${planned.size} categories)`,
    `unaffiliated planner categories: ${missing.join(", ")}`,
  );
}

// ---- 11. Determinism ----
{
  const windows: CraftedWindow[] = [
    { path: "src/controllers/login.controller.js", text: "const token = jwt.sign(user);" },
    { path: "src/models/session.model.js", text: "module.exports = {};", provenance: "indexed" },
  ];
  const first = JSON.stringify(evaluateScenario("How does authentication work?", windows).evaluation);
  const second = JSON.stringify(evaluateScenario("How does authentication work?", windows).evaluation);
  check(first === second, "coverage evaluation is deterministic (identical output twice)", "coverage evaluation is not deterministic");
}

// ---- 12. Structural invariants over a larger mixed scenario ----
{
  const { evaluation } = evaluateScenario("How do uploads and database storage work together?", [
    { path: "src/controllers/uploadController.js", text: "export const uploadAvatar = async (req) => storage.save(req.file);" },
    { path: "src/services/storage.js", text: "module.exports = { bucket: 'avatar' };", provenance: "indexed" },
    { path: "src/models/userModel.js", text: "const userSchema = new Schema({});" },
    { path: "src/config/storage.config.js", text: "module.exports = { rate: 10 };" },
  ]);
  const allCats = evaluation.concepts.flatMap((c) => c.categories);
  const invalid = allCats.filter(
    (c) =>
      !(["found", "partial", "unknown"] as CoverageStatus[]).includes(c.status) ||
      (c.status === "found") !== c.evidence.some((e) => e.signal === "source-text"),
  );
  check(
    invalid.length === 0 && allCats.length > 0,
    `invariant holds: found iff source-text evidence exists (${allCats.length} categories evaluated)`,
    `invariant violations: ${JSON.stringify(invalid.map((c) => [c.category, c.status]))}`,
  );
  const unknownNoEvidence = allCats.filter((c) => c.status === "unknown" && c.evidence.length > 0);
  check(unknownNoEvidence.length === 0, "unknown categories never report evidence items", "unknown category reported evidence");
  const summariesMatch =
    evaluation.summary.found + evaluation.summary.partial + evaluation.summary.unknown === allCats.length;
  check(summariesMatch, "summary counts reconcile with the evaluated category total", "summary does not reconcile");
}

// ---- 13. Empty evidence package ----
{
  const { evaluation } = evaluateScenario("How does authentication work?", []);
  check(
    evaluation.summary.unknown === evaluation.summary.found + evaluation.summary.partial + evaluation.summary.unknown && evaluation.summary.found === 0,
    "an empty evidence package evaluates every category unknown",
    `empty package wrong: ${JSON.stringify(evaluation.summary)}`,
  );
}

// ---- 14. Concept types stay compatible with the planner ----
{
  const probe: PlannedConcept = planQuestion("How does authentication work?").concepts[0]!;
  check(
    probe.variants.length > 0 && probe.expectedEvidence.length > 0,
    "planner output types flow into the evaluator unchanged",
    "planner types broken",
  );
}

// Summary
console.log("");
for (const line of results) console.log(line);
console.log("");
const fails = results.filter((r) => r.startsWith("FAIL"));
if (fails.length === 0) {
  console.log("Every check passed.");
} else {
  console.log(`${fails.length} check(s) failed.`);
  process.exitCode = 1;
}
