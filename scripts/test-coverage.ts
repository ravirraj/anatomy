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
  evaluateCoverageAdaptive,
  CATEGORY_AFFILIATION,
  UNKNOWN_NOTE,
  type CoverageEvaluation,
  type CoverageStatus,
} from "../lib/ai/coverage.ts";
import {
  buildConceptIndex,
  matchConceptsForQuery,
  type ConceptIndex,
  type QuestionConceptMapping,
} from "../lib/ai/concepts/index.ts";
import type { RepositoryConcept } from "../lib/ai/concepts/types.ts";
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
      (() => {
        const dev = evaluation.concepts.find((c) => c.token === "developer");
        return dev !== undefined && dev.categories.length === 1 && dev.categories[0]!.category === "developer";
      })(),
    "concepts without expected categories evaluate under their own name (Phase 1D, V1)",
    "developer concept should contribute exactly one self-named category",
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

// ---- 15. Adaptive affiliation: a file belongs only to its own role/category ----
{
  // One concept spanning three architectural layers. Discovery must record
  // each file's actual indexed role so affiliation is exact.
  const index: ConceptIndex = buildConceptIndex({
    analysisId: "affiliation_test",
    files: [
      { id: "s1", path: "src/services/authService.js", role: "service" },
      { id: "c1", path: "src/controllers/authController.js", role: "controller" },
      { id: "r1", path: "src/repositories/authRepository.js", role: "repository" },
    ],
    symbols: [
      { fileId: "s1", name: "verifyAuthSession", kind: "function", exported: true },
      { fileId: "c1", name: "submitAuthRequest", kind: "function", exported: true },
      { fileId: "r1", name: "saveAuthRecord", kind: "function", exported: true },
    ],
    routes: [],
    edges: [],
  });
  const spanning = index.concepts.filter(
    (c) => c.fileIds.length === 3 && c.normalizedTerms.includes("auth"),
  );
  const authConcept: RepositoryConcept | undefined = spanning[0];
  check(
    spanning.length === 1 && authConcept !== undefined,
    "the auth concept spans the service/controller/repository files as one concept",
    `spanning: ${JSON.stringify(index.concepts.map((c) => [c.displayName, c.fileIds]))}`,
  );
  check(
    authConcept !== undefined &&
      authConcept.fileRoles["s1"] === "service" &&
      authConcept.fileRoles["c1"] === "controller" &&
      authConcept.fileRoles["r1"] === "repository" &&
      Object.keys(authConcept.fileRoles).length === 3,
    "discovery records each file's indexed role in fileRoles (no filename inference)",
    `fileRoles: ${JSON.stringify(authConcept?.fileRoles)}`,
  );

  // Concept-specific scenario harness: the concept discovery index determines
  // affiliation; windows only contribute evidence.
  const query = "How does the auth layer work?";
  const plan = planQuestion(query, index);
  const mapping: QuestionConceptMapping = {
    query,
    matches: new Map(),
    topConcepts: [authConcept!],
  };
  type FileCraftedWindow = CraftedWindow & { fileId?: string };
  function adaptiveScenario(windows: FileCraftedWindow[]): CoverageEvaluation {
    const retrieved: RetrievedWindow[] = windows.map((w, i) => ({
      fileId: w.fileId ?? `w${i}`,
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
      analysisId: "affiliation_test",
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
    return evaluateCoverageAdaptive(plan, result, mapping, index);
  }
  function adaptiveCategory(evaluation: CoverageEvaluation, category: string) {
    return evaluation.concepts
      .find((c) => c.categories.some((cat) => cat.category === category))
      ?.categories.find((c) => c.category === category);
  }

  // 15a. The service file's concept text must found ONLY the service category.
  {
    const evaluation = adaptiveScenario([
      {
        path: "src/services/authService.js",
        fileId: "s1",
        text: "module.exports.verifyAuthToken = (token) => authDecoded(token);",
      },
    ]);
    const service = adaptiveCategory(evaluation, "service");
    const controller = adaptiveCategory(evaluation, "controller");
    const repository = adaptiveCategory(evaluation, "repository");
    check(
      service?.status === "found" && service.evidence.every((e) => e.path === "src/services/authService.js"),
      "a service file with concept text founds only the service category",
      `service wrong: ${JSON.stringify(service)}`,
    );
    check(
      controller?.status === "unknown" && controller.evidence.length === 0,
      "service source text cannot falsely establish controller coverage",
      `controller wrong: ${JSON.stringify(controller)}`,
    );
    check(
      repository?.status === "unknown" && repository.evidence.length === 0,
      "service source text cannot falsely establish repository coverage",
      `repository wrong: ${JSON.stringify(repository)}`,
    );
  }

  // 15b. The controller file's own concept text founds the controller category.
  {
    const evaluation = adaptiveScenario([
      {
        path: "src/controllers/authController.js",
        fileId: "c1",
        text: "export async function handleSubmit(req) { return authSignup(req.body); }",
      },
    ]);
    const controller = adaptiveCategory(evaluation, "controller");
    const service = adaptiveCategory(evaluation, "service");
    const repository = adaptiveCategory(evaluation, "repository");
    check(
      controller?.status === "found" && controller.evidence.every((e) => e.path === "src/controllers/authController.js"),
      "retrieving the actual controller file with concept source text founds controller coverage",
      `controller wrong: ${JSON.stringify(controller)}`,
    );
    check(
      service?.status === "unknown" && repository?.status === "unknown",
      "controller source text does not leak into service/repository categories",
      `leak: ${JSON.stringify([service, repository])}`,
    );
  }

  // 15c. The repository file must be affiliated with exactly its own category.
  {
    const evaluation = adaptiveScenario([
      {
        path: "src/repositories/authRepository.js",
        fileId: "r1",
        text: "module.exports.saveAuthSession = (row) => authPersist(row);",
      },
    ]);
    const repository = adaptiveCategory(evaluation, "repository");
    const service = adaptiveCategory(evaluation, "service");
    const controller = adaptiveCategory(evaluation, "controller");
    check(
      repository?.status === "found" && repository.evidence.every((e) => e.path === "src/repositories/authRepository.js"),
      "a repository file with concept text founds only the repository category",
      `repository wrong: ${JSON.stringify(repository)}`,
    );
    check(
      service?.status === "unknown" && controller?.status === "unknown",
      "repository source text does not leak into service/controller categories",
      `leak: ${JSON.stringify([service, controller])}`,
    );
  }

  // 15d. The retrieval reason's recorded role keeps affiliating (fallback kept).
  {
    const evaluation = adaptiveScenario([
      {
        path: "src/anything.js",
        fileId: "z9",
        text: "const rate = 5; // slice without concept vocabulary",
        reason: `file holds the "controller" role, which the question's topic names`,
      },
    ]);
    const controller = adaptiveCategory(evaluation, "controller");
    check(
      controller?.status === "partial" && controller.evidence[0]?.signal === "filename-or-role",
      "the role-reason fallback still affiliates its category (partial without text)",
      `controller wrong: ${JSON.stringify(controller)}`,
    );
  }
}

// ---- 16. Non-adaptive role affiliation matches the parser taxonomy (Phase 1C F3) ----
{
  // The taxonomy's frontend roles affiliate the frontend category even when
  // the path carries no conventional UI segment ("components", "hooks", …).
  const { evaluation } = evaluateScenario("How does the profile card component render?", [
    {
      path: "src/panels/ProfileCard.tsx",
      text: "const rate = 5; // slice without concept vocabulary",
      reason: `file holds the "component" role, which the question's topic names`,
    },
    {
      path: "src/panels/Portrait.tsx",
      text: "const rate = 5; // slice without concept vocabulary",
      reason: `file holds the "frontend" role, which the question's topic names`,
    },
  ]);
  const frontend = categoryEval(evaluation, "profile", "frontend")
    ?? evaluation.concepts.flatMap((c) => c.categories).find((c) => c.category === "frontend");
  check(
    frontend?.status === "partial" && frontend.evidence.every((e) => e.signal === "filename-or-role")
      && frontend.evidence.some((e) => e.path === "src/panels/ProfileCard.tsx"),
    "modern frontend roles (component) and the legacy value affiliate the frontend category",
    `frontend wrong: ${JSON.stringify(frontend)}`,
  );
}

{
  // The taxonomy's routable roles affiliate the routes category for endpoint
  // wording, including the persisted legacy "route" value.
  const { evaluation } = evaluateScenario("Which endpoint serves the profile updates?", [
    {
      path: "src/handlers/profileUpdate.ts",
      text: "const rate = 5; // slice without concept vocabulary",
      reason: `file holds the "api-endpoint" role, which the question's topic names`,
    },
    {
      path: "src/handlers/profileRouter.ts",
      text: "const rate = 5; // slice without concept vocabulary",
      reason: `file holds the "route" role, which the question's topic names`,
    },
  ]);
  const routes = evaluation.concepts.flatMap((c) => c.categories).filter((c) => c.category === "routes");
  check(
    routes.length > 0 && routes.every((c) => c.status === "partial" && c.evidence.every((e) => e.signal === "filename-or-role"))
      && routes.some((c) => c.evidence.some((e) => e.path === "src/handlers/profileUpdate.ts")),
    "modern route roles (api-endpoint) and the legacy value affiliate the routes category",
    `routes wrong: ${JSON.stringify(routes)}`,
  );
}

{
  // No CLI role exists in the taxonomy; the legacy value still affiliates and
  // path segments remain the real affiliation for CLI categories.
  const { evaluation } = evaluateScenario("How does the CLI dispatch subcommands?", [
    {
      path: "src/ops/dispatcher.ts",
      text: "const rate = 5; // slice without concept vocabulary",
      reason: `file holds the "cli" role, which the question's topic names`,
    },
  ]);
  const cli = evaluation.concepts.flatMap((c) => c.categories).find((c) => c.category === "cli");
  check(
    cli?.status === "partial" && cli.evidence[0]?.signal === "filename-or-role",
    "the persisted legacy cli role keeps affiliating the cli category",
    `cli wrong: ${JSON.stringify(cli)}`,
  );
}

// ---- 17. Self-named fallback coverage in the base evaluator (Phase 1D, V1) ----
{
  // An out-of-vocabulary concept the planner could not name categories for is
  // no longer vacuously covered: it gets one self-named category ("zorb" of
  // concept "zorb") affiliated with every retrieved window, judged by the
  // same signal rules — so honest unknown, honest partial, and source-text
  // found wherever the file lives.

  // 17a. No window associates with the concept in any real way: unknown,
  // with no evidence items (an unknown category never reports evidence).
  {
    const { evaluation } = evaluateScenario("How does the zorb flux work?", [
      {
        path: "src/utils/hex.js",
        text: "export const toHex = (n) => n.toString(16);",
        reason: `file path matches token "zorb"`,
      },
    ]);
    const zorb = categoryEval(evaluation, "zorb", "zorb");
    const flux = categoryEval(evaluation, "flux", "flux");
    check(
      zorb?.status === "unknown" && zorb.evidence.length === 0,
      "self-named unknown needs no evidence items and is not proof of absence",
      `zorb wrong: ${JSON.stringify(zorb)}`,
    );
    check(
      flux !== undefined && flux.category === "flux",
      "every empty-evidence plan concept contributes its self-named category",
      `flux wrong: ${JSON.stringify(flux)}`,
    );
  }

  // 17b. A symbol-name echo is partial, never found.
  {
    const { evaluation } = evaluateScenario("How does the zorb flux work?", [
      {
        path: "src/render/panel.js",
        text: "const cache = {};",
        reason: `symbol "zorbPanel" (function) matches token "zorb"`,
      },
    ]);
    const zorb = categoryEval(evaluation, "zorb", "zorb");
    check(
      zorb?.status === "partial" && zorb.evidence.every((e) => e.signal === "symbol-name"),
      "self-named concept stays partial on symbol-name evidence alone",
      `zorb wrong: ${JSON.stringify(zorb)}`,
    );
  }

  // 17c. Retrieved text that names the concept's own vocabulary is found,
  // wherever the file lives (any-window affiliation).
  {
    const { evaluation } = evaluateScenario("How does the zorb flux work?", [
      {
        path: "src/anything/elsewhere.js",
        text: "export const handleZorbEvent = (e) => e.zorb;",
      },
    ]);
    const zorb = categoryEval(evaluation, "zorb", "zorb");
    check(
      zorb?.status === "found" && zorb.evidence.some((e) => e.signal === "source-text" && e.matchedVariant === "zorb"),
      "self-named concept is found by concept source text from any retrieved file",
      `zorb wrong: ${JSON.stringify(zorb)}`,
    );
  }
}

// ---- 18. Adaptive coverage keeps unmatched plan concepts (Phase 1D, V1) ----
{
  // When some token matches the repository's concept index, every OTHER plan
  // concept must still appear: previously an unmatched concept vanished
  // whenever one of its siblings DID match — no coverage line, no drill, no
  // abstention signal. Each unmatched concept now gets one self-named
  // category with any-window affiliation.
  const index: ConceptIndex = buildConceptIndex({
    analysisId: "adaptive_unmatched",
    files: [
      { id: "t1", path: "src/telemetry/emit.js", role: "service" },
      { id: "t2", path: "src/telemetry/watch.js", role: "service" },
    ],
    symbols: [
      { fileId: "t1", name: "emitTelemetry", kind: "function", exported: true },
      { fileId: "t2", name: "watchTelemetry", kind: "function", exported: true },
    ],
    routes: [],
    edges: [],
  });
  const query = "How does telemetry handle the widget quota?";
  const plan: QuestionPlan = planQuestion(query, index);
  const tokens = plan.concepts.map((c) => c.token);
  const genericTokens = new Set(
    (plan.unusedTokens ?? []).filter((u) => u.reason === "generic-verb").map((u) => u.word),
  );
  const mapping: QuestionConceptMapping = matchConceptsForQuery(tokens, genericTokens, index);
  check(
    mapping.topConcepts.length === 1 && mapping.matches.has("telemetry") && !mapping.matches.has("widget") && !mapping.matches.has("quota"),
    "fixture precondition: telemetry matches the index, widget/quota do not",
    `matches: ${JSON.stringify([...mapping.matches.keys()])} top: ${JSON.stringify(mapping.topConcepts.map((c) => c.displayName))}`,
  );

  const retrieved: RetrievedWindow[] = [
    {
      fileId: "t1",
      path: "src/telemetry/emit.js",
      contentHash: "hash_t1",
      totalLines: 140,
      startLine: 1,
      endLine: 45,
      score: 80,
      text: "module.exports.emitTelemetry = (event) => exporters.push(event);",
      reason: `symbol "emitTelemetry" (function) matches token "telemetry"`,
    },
    {
      fileId: "w9",
      path: "src/limits/widget.js",
      contentHash: "hash_w9",
      totalLines: 140,
      startLine: 1,
      endLine: 45,
      score: 80,
      text: "export const widgetState = { remaining: 9 };",
      reason: `symbol "quotaMeter" (function) matches token "quota"`,
    },
  ];
  const result: RetrievalResult = {
    analysisId: "adaptive_unmatched",
    query,
    tokens,
    plan,
    windows: retrieved,
    files: retrieved.map((w) => ({
      fileId: w.fileId,
      path: w.path,
      contentHash: w.contentHash,
      totalLines: w.totalLines,
    })),
    totalCharacters: retrieved.reduce((acc, w) => acc + w.text.length, 0),
    insufficientEvidence: false,
  };
  const evaluation = evaluateCoverageAdaptive(plan, result, mapping, index);

  const widgetConcept = evaluation.concepts.find((c) => c.token === "widget");
  check(
    widgetConcept !== undefined &&
      widgetConcept.categories.length === 1 &&
      widgetConcept.categories[0]!.category === "widget" &&
      widgetConcept.categories[0]!.status === "found",
    "an unmatched plan concept is still evaluated under its own name and found by its text",
    `widget wrong: ${JSON.stringify(widgetConcept)}`,
  );
  const quotaConcept = evaluation.concepts.find((c) => c.token === "quota");
  check(
    quotaConcept !== undefined &&
      quotaConcept.categories.length === 1 &&
      quotaConcept.categories[0]!.status === "partial",
    "an unmatched concept with only symbol-name association stays partial (quota)",
    `quota wrong: ${JSON.stringify(quotaConcept)}`,
  );
  check(
    evaluation.summary.found + evaluation.summary.partial + evaluation.summary.unknown ===
      evaluation.concepts.reduce((acc, c) => acc + c.categories.length, 0),
    "the adaptive summary still reconciles after the unmatched append",
    `summary: ${JSON.stringify(evaluation.summary)}`,
  );
}

// ---- 19. Role-less concepts affiliate under their own name (Phase 1D, V7b) ----
{
  // A concept whose files never received an indexed role previously surfaced
  // as a junk "unclassified" layer (which the loop then drilled with the
  // literal query word). It is now reported under the concept's own display
  // name and affiliates by its own fileIds; "unclassified" disappears from
  // the coverage evaluation entirely.
  const index: ConceptIndex = buildConceptIndex({
    analysisId: "roleless_test",
    files: [
      { id: "w1", path: "src/renders/panel.js", role: null },
      { id: "w2", path: "src/renders/dock.js", role: null },
    ],
    symbols: [
      { fileId: "w1", name: "widgetPanel", kind: "function", exported: true },
      { fileId: "w2", name: "widgetDock", kind: "function", exported: true },
    ],
    routes: [],
    edges: [],
  });
  const concept = index.concepts.find((c) => c.fileIds.includes("w1") && c.fileIds.includes("w2"));
  check(
    concept !== undefined && concept.discoveredCategories.length === 0,
    "fixture precondition: the role-less concept carries no discovered categories",
    `concepts: ${JSON.stringify(index.concepts.map((c) => [c.displayName, c.discoveredCategories]))}`,
  );
  const displayName = concept!.displayName;
  const query = `How does ${displayName} render work?`;
  const plan: QuestionPlan = planQuestion(query, index);
  const mapping: QuestionConceptMapping = {
    query,
    matches: new Map(),
    topConcepts: [concept!],
  };
  const retrieved: RetrievedWindow[] = [
    {
      fileId: "w1",
      path: "src/renders/panel.js",
      contentHash: "hash_w1",
      totalLines: 40,
      startLine: 1,
      endLine: 40,
      score: 80,
      text: "export function widgetPanel() { return mount(); }",
      reason: `symbol "widgetPanel" (function) matches token "${displayName}"`,
    },
  ];
  const result: RetrievalResult = {
    analysisId: "roleless_test",
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
    insufficientEvidence: false,
  };
  const evaluation = evaluateCoverageAdaptive(plan, result, mapping, index);
  const conceptEntry = evaluation.concepts.find((c) => c.token === displayName);
  check(
    conceptEntry !== undefined &&
      conceptEntry.categories.length === 1 &&
      conceptEntry.categories[0]!.category === displayName &&
      conceptEntry.categories[0]!.status === "found",
    "a role-less concept is evaluated under its own name and found via its own fileId",
    `concept wrong: ${JSON.stringify(conceptEntry)}`,
  );
  check(
    evaluation.concepts.flatMap((c) => c.categories).every((cat) => cat.category !== "unclassified"),
    "the literal \"unclassified\" category never appears in coverage (Phase 1D, V7b)",
    "unclassified leaked",
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
