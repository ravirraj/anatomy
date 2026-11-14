// Comprehensive test suite for Repository-Adaptive Concept Discovery.
// Tests concept discovery, clustering, deterministic IDs, question-to-concept mapping,
// false-association prevention, adaptive coverage, and unseen feature names across
// multiple fixture topologies (Authsphere, Monorepo, Path-Aliases).

import {
  buildConceptIndex,
  conceptId,
  matchConceptsForQuery,
} from "../lib/ai/concepts/index.ts";
import { evaluateCoverageAdaptive } from "../lib/ai/coverage.ts";
import { planQuestion } from "../lib/ai/planner.ts";
import type { RetrievalResult } from "../lib/ai/retrieval.ts";

const results: string[] = [];
function pass(msg: string): void {
  results.push(`ok    ${msg}`);
}
function fail(msg: string, detail?: string): void {
  results.push(`FAIL  ${msg}${detail ? ` - ${detail}` : ""}`);
}
function check(condition: boolean, okMsg: string, failMsg: string): void {
  if (condition) pass(okMsg);
  else fail(failMsg);
}

console.log("=== 1. Deterministic Concept IDs across repeated runs ===");
{
  const id1 = conceptId("analysis_12345", "telemetry");
  const id2 = conceptId("analysis_12345", "telemetry");
  const idDiffAnalysis = conceptId("analysis_99999", "telemetry");
  const idDiffConcept = conceptId("analysis_12345", "billing");

  check(id1 === id2, "identical inputs yield identical concept IDs", `got ${id1} vs ${id2}`);
  check(id1.startsWith("cncpt:"), "concept ID starts with cncpt: prefix", `got ${id1}`);
  check(id1 !== idDiffAnalysis, "different analysis IDs produce different concept IDs", `got ${id1}`);
  check(id1 !== idDiffConcept, "different concepts produce different IDs", `got ${id1}`);
}

console.log("");
console.log("=== 2. Discovery on unseen feature names (without hardcoded glossary) ===");
{
  // A hypothetical repository containing completely unfamiliar features:
  // "telemetry-pipeline", "sharding-coordinator", "hyper-ledger"
  const unseenIndex = buildConceptIndex({
    analysisId: "unseen_repo",
    files: [
      { id: "f1", path: "src/telemetry/collector.ts", role: "service" },
      { id: "f2", path: "src/telemetry/exporter.ts", role: "service" },
      { id: "f3", path: "src/telemetry/buffer.ts", role: "model" },
      { id: "f4", path: "src/sharding/coordinator.ts", role: "controller" },
      { id: "f5", path: "src/sharding/partition_map.ts", role: "model" },
      { id: "f6", path: "src/sharding/rebalancer.ts", role: "service" },
    ],
    symbols: [
      { fileId: "f1", name: "TelemetryCollector", kind: "class", exported: true },
      { fileId: "f2", name: "ExportTelemetryMetrics", kind: "function", exported: true },
      { fileId: "f3", name: "TelemetryBufferQueue", kind: "class", exported: true },
      { fileId: "f4", name: "ShardingCoordinator", kind: "class", exported: true },
      { fileId: "f5", name: "PartitionMap", kind: "interface", exported: true },
      { fileId: "f6", name: "RebalanceShards", kind: "function", exported: true },
    ],
    routes: [
      { fileId: "f1", pattern: "/api/v1/telemetry/ingest", method: "POST" },
      { fileId: "f4", pattern: "/cluster/shards/status", method: "GET" },
    ],
    edges: [
      { sourceFileId: "f1", targetFileId: "f2" },
      { sourceFileId: "f1", targetFileId: "f3" },
      { sourceFileId: "f4", targetFileId: "f5" },
      { sourceFileId: "f4", targetFileId: "f6" },
    ],
  });

  const discoveredNames = unseenIndex.concepts.map((c) => c.displayName);
  check(
    discoveredNames.includes("telemetry"),
    "dynamically discovered 'telemetry' concept without any glossary definition",
    `concepts: ${JSON.stringify(discoveredNames)}`,
  );
  check(
    discoveredNames.includes("sharding"),
    "dynamically discovered 'sharding' concept without any glossary definition",
    `concepts: ${JSON.stringify(discoveredNames)}`,
  );

  const telemetryConcept = unseenIndex.concepts.find((c) => c.displayName === "telemetry");
  check(
    telemetryConcept !== undefined && telemetryConcept.filePaths.length === 3,
    "telemetry concept spans exactly its 3 constituent files",
    `files: ${JSON.stringify(telemetryConcept?.filePaths)}`,
  );
  check(
    telemetryConcept !== undefined &&
      telemetryConcept.discoveredCategories.includes("service") &&
      telemetryConcept.discoveredCategories.includes("model"),
    "telemetry concept discovered architectural roles from its member files",
    `roles: ${JSON.stringify(telemetryConcept?.discoveredCategories)}`,
  );
}

console.log("");
console.log("=== 3. Question-to-Concept Mapping and False-Association Prevention ===");
{
  const index = buildConceptIndex({
    analysisId: "clustering_test",
    files: [
      { id: "a1", path: "src/auth/session.ts", role: "service" },
      { id: "a2", path: "src/auth/login.ts", role: "controller" },
      { id: "b1", path: "src/billing/subscription.ts", role: "service" },
      { id: "b2", path: "src/billing/invoice.ts", role: "model" },
      { id: "b3", path: "src/billing/gateway.ts", role: "service" },
    ],
    symbols: [
      { fileId: "a1", name: "verifySessionToken", kind: "function", exported: true },
      { fileId: "a2", name: "handleLoginRequest", kind: "function", exported: true },
      { fileId: "b1", name: "SubscriptionManager", kind: "class", exported: true },
      { fileId: "b2", name: "InvoiceRecord", kind: "interface", exported: true },
      { fileId: "b3", name: "ChargePaymentGateway", kind: "class", exported: true },
    ],
    routes: [
      { fileId: "a2", pattern: "/api/auth/login", method: "POST" },
      { fileId: "b3", pattern: "/api/billing/charge", method: "POST" },
    ],
    edges: [
      { sourceFileId: "a2", targetFileId: "a1" },
      { sourceFileId: "b1", targetFileId: "b2" },
      { sourceFileId: "b1", targetFileId: "b3" },
    ],
  });

  // Query 1: exact concept match
  const q1Mapping = matchConceptsForQuery(["subscription", "billing"], new Set(), index);
  check(
    q1Mapping.topConcepts.length > 0 && q1Mapping.topConcepts[0]!.displayName === "billing",
    "subscription/billing query maps to 'billing' concept",
    `top: ${q1Mapping.topConcepts.map((c) => c.displayName).join(", ")}`,
  );

  // Query 2: generic verb prevention ("handle", "create", "implement")
  const genericTokens = new Set(["handle", "create", "implement"]);
  const q2Mapping = matchConceptsForQuery(["handle", "create", "login"], genericTokens, index);
  check(
    !q2Mapping.matches.has("handle") && !q2Mapping.matches.has("create"),
    "generic verbs are filtered and do not produce concept matches",
    `matches keys: ${[...q2Mapping.matches.keys()].join(", ")}`,
  );
  check(
    q2Mapping.matches.has("login"),
    "non-generic query token 'login' matches successfully",
    "login not matched",
  );

  // Query 3: unrelated query does not fabricate concept associations
  const q3Mapping = matchConceptsForQuery(["quantum", "teleportation"], new Set(), index);
  check(
    q3Mapping.topConcepts.length === 0,
    "unrelated query terms produce zero concept matches (no hallucinations)",
    `topConcepts count: ${q3Mapping.topConcepts.length}`,
  );
}

console.log("");
console.log("=== 4. Adaptive Coverage Evaluation with Discovered Concepts ===");
{
  const testIndex = buildConceptIndex({
    analysisId: "coverage_test",
    files: [
      { id: "c1", path: "src/payment/processor.ts", role: "service" },
      { id: "c2", path: "src/payment/checkout.ts", role: "controller" },
    ],
    symbols: [
      { fileId: "c1", name: "ProcessPayment", kind: "function", exported: true },
      { fileId: "c2", name: "CheckoutOrder", kind: "function", exported: true },
    ],
    routes: [{ fileId: "c2", pattern: "/checkout/pay", method: "POST" }],
    edges: [{ sourceFileId: "c2", targetFileId: "c1" }],
  });

  const plan = planQuestion("How does the payment processing work?", testIndex);
  const mapping = matchConceptsForQuery(["payment", "processing"], new Set(), testIndex);

  const mockRetrievalResult: RetrievalResult = {
    analysisId: "coverage_test",
    query: "How does the payment processing work?",
    tokens: ["payment", "processing"],
    plan,
    windows: [
      {
        fileId: "c1",
        path: "src/payment/processor.ts",
        contentHash: "hash123",
        totalLines: 80,
        startLine: 1,
        endLine: 40,
        score: 90,
        text: "export function ProcessPayment(paymentPayload: PaymentRequest) { return true; }",
        reason: "symbol ProcessPayment matches",
      },
    ],
    files: [{ fileId: "c1", path: "src/payment/processor.ts", contentHash: "hash123", totalLines: 80 }],
    totalCharacters: 200,
    insufficientEvidence: false,
  };

  const coverage = evaluateCoverageAdaptive(plan, mockRetrievalResult, mapping, testIndex);
  check(
    coverage.concepts.length > 0,
    "adaptive coverage evaluates discovered concept",
    `concepts count: ${coverage.concepts.length}`,
  );
  const paymentConceptCoverage = coverage.concepts.find((c) => c.token === "payment");
  check(
    paymentConceptCoverage !== undefined,
    "payment concept is evaluated",
    `evaluated: ${coverage.concepts.map((c) => c.token).join(", ")}`,
  );
  check(
    paymentConceptCoverage?.categories.some((cat) => cat.category === "service" && cat.status === "found") === true,
    "service category is marked 'found' based on source text match",
    `categories: ${JSON.stringify(paymentConceptCoverage?.categories)}`,
  );
}

console.log("");
console.log("=== 5. Multi-Repo Structural Generalization: Monorepo & Path-Aliases ===");
{
  // Test across structural monorepo fixture shape: packages/api + packages/web
  const monorepoIndex = buildConceptIndex({
    analysisId: "two-framework-monorepo",
    files: [
      { id: "m1", path: "packages/api/src/users/users.controller.ts", role: "controller" },
      { id: "m2", path: "packages/api/src/users/users.service.ts", role: "service" },
      { id: "m3", path: "packages/web/app/page.tsx", role: "page-route" },
      { id: "m4", path: "packages/web/lib/branding.ts", role: "util" },
    ],
    symbols: [
      { fileId: "m1", name: "UsersController", kind: "class", exported: true },
      { fileId: "m2", name: "UsersService", kind: "class", exported: true },
      { fileId: "m4", name: "getBrandingConfig", kind: "function", exported: true },
    ],
    routes: [
      { fileId: "m1", pattern: "/users", method: "GET" },
      { fileId: "m3", pattern: "/", method: "GET" },
    ],
    edges: [{ sourceFileId: "m1", targetFileId: "m2" }],
  });

  const monorepoConcepts = monorepoIndex.concepts.map((c) => c.displayName);
  check(
    monorepoConcepts.includes("users"),
    "monorepo correctly discovers 'users' subsystem as an isolated concept",
    `concepts: ${JSON.stringify(monorepoConcepts)}`,
  );
  check(
    monorepoIndex.buildMs < 100,
    `concept index build is extremely fast (${monorepoIndex.buildMs}ms)`,
    `took ${monorepoIndex.buildMs}ms`,
  );
}

console.log("");
console.log("=== 6. Glue-term breadth cap (Phase 1D, V7a) ===");
{
  // A repository where a structural directory term is shared by nearly every
  // path: pre-cap, the co-occurrence union produced one franken-concept
  // ("packages") swallowing every domain, whose category list spans many
  // roles — a question mentioning it then expected evidence "everywhere"
  // (audit §7.1). Post-cap the glue term is dropped before clustering.
  const glueIndex = buildConceptIndex({
    analysisId: "glue_repo",
    files: [
      { id: "g1", path: "packages/auth/session.ts", role: "service" },
      { id: "g2", path: "packages/auth/login.ts", role: "controller" },
      { id: "g3", path: "packages/billing/subscription.ts", role: "service" },
      { id: "g4", path: "packages/billing/invoice.ts", role: "model" },
      { id: "g5", path: "packages/data/store.ts", role: "util" },
      { id: "g6", path: "packages/data/query.ts", role: "util" },
      { id: "g7", path: "packages/data/serialize.ts", role: "util" },
      { id: "g8", path: "packages/data/decode.ts", role: "util" },
      { id: "g9", path: "packages/data/backup.ts", role: "util" },
      { id: "g10", path: "packages/web/app/page.tsx", role: "page-route" },
      { id: "g11", path: "packages/web/lib/branding.ts", role: "util" },
    ],
    symbols: [
      { fileId: "g1", name: "UserSession", kind: "class", exported: true },
      { fileId: "g3", name: "Subscription", kind: "class", exported: true },
      { fileId: "g5", name: "DataStore", kind: "class", exported: true },
    ],
    routes: [],
    edges: [],
  });

  const allTerms = glueIndex.concepts.flatMap((c) => c.normalizedTerms);
  check(
    !glueIndex.concepts.some((c) => c.displayName === "data") && !allTerms.includes("data"),
    "a term spanning >40% of the indexed files is dropped; no 'data' concept exists",
    `concepts: ${JSON.stringify(glueIndex.concepts.map((c) => [c.displayName, c.normalizedTerms]))}`,
  );
  check(
    !glueIndex.concepts.some((c) => c.displayName === "packages") && !allTerms.includes("packages"),
    "a term spanning every file is dropped; no 'packages' franken-concept exists",
    `concepts: ${JSON.stringify(glueIndex.concepts.map((c) => c.displayName))}`,
  );
  const authConcept = glueIndex.concepts.find((c) => c.displayName === "auth");
  const billingConcept = glueIndex.concepts.find((c) => c.displayName === "billing");
  check(
    authConcept !== undefined &&
      billingConcept !== undefined &&
      authConcept.fileIds.every((f) => f === "g1" || f === "g2") &&
      billingConcept.fileIds.every((f) => f === "g3" || f === "g4"),
    "real domain concepts still form exactly across their own files",
    `auth=${JSON.stringify(authConcept?.fileIds)} billing=${JSON.stringify(billingConcept?.fileIds)}`,
  );
  const dataMapping = matchConceptsForQuery(["data"], new Set(), glueIndex);
  check(
    dataMapping.topConcepts.length === 0,
    "a dropped glue term no longer matches any concept for question tokens",
    `top: ${dataMapping.topConcepts.map((c) => c.displayName).join(", ")}`,
  );
}
{
  // Small-repository floor: a term spanning the whole of a tiny repository
  // is as likely to be its one real domain concept as noise; the breadth cap
  // does not apply below GLUE_TERM_MIN_FILES files.
  const smallIndex = buildConceptIndex({
    analysisId: "small_repo",
    files: [
      { id: "s1", path: "src/telemetry/collector.ts", role: "service" },
      { id: "s2", path: "src/telemetry/exporter.ts", role: "service" },
      { id: "s3", path: "src/telemetry/buffer.ts", role: "model" },
    ],
    symbols: [
      { fileId: "s1", name: "TelemetryCollector", kind: "class", exported: true },
      { fileId: "s2", name: "ExportTelemetry", kind: "function", exported: true },
    ],
    routes: [],
    edges: [],
  });
  check(
    smallIndex.concepts.some(
      (c) => c.displayName === "telemetry" || c.normalizedTerms.includes("telemetry"),
    ),
    "in a 3-file repository a whole-span term still forms its real concept",
    `concepts: ${JSON.stringify(smallIndex.concepts.map((c) => c.displayName))}`,
  );
}
{
  // QA-07 guard (two-framework-monorepo): the monorepo's structural "packages"
  // term created a repo-wide concept that drills controller/service files for
  // manifest questions. After the cap the query token must match nothing.
  const monorepoIndex = buildConceptIndex({
    analysisId: "two-framework-monorepo",
    files: [
      { id: "m1", path: "packages/api/src/users/users.controller.ts", role: "controller" },
      { id: "m2", path: "packages/api/src/users/users.service.ts", role: "service" },
      { id: "m3", path: "packages/web/app/page.tsx", role: "page-route" },
      { id: "m4", path: "packages/web/lib/branding.ts", role: "util" },
    ],
    symbols: [
      { fileId: "m1", name: "UsersController", kind: "class", exported: true },
      { fileId: "m2", name: "UsersService", kind: "class", exported: true },
      { fileId: "m4", name: "getBrandingConfig", kind: "function", exported: true },
    ],
    routes: [
      { fileId: "m1", pattern: "/users", method: "GET" },
      { fileId: "m3", pattern: "/", method: "GET" },
    ],
    edges: [{ sourceFileId: "m1", targetFileId: "m2" }],
  });
  check(
    !monorepoIndex.concepts.some(
      (c) => c.displayName === "packages" || c.normalizedTerms.includes("packages"),
    ),
    "monorepo regression guard: no 'packages' concept survives the cap",
    `concepts: ${JSON.stringify(monorepoIndex.concepts.map((c) => c.displayName))}`,
  );
  const packagesMapping = matchConceptsForQuery(["packages"], new Set(), monorepoIndex);
  check(
    packagesMapping.topConcepts.length === 0,
    "monorepo regression guard: the 'packages' question token matches no concept",
    `top: ${packagesMapping.topConcepts.map((c) => c.displayName).join(", ")}`,
  );
  const usersConcept = monorepoIndex.concepts.find((c) => c.displayName === "users");
  check(
    usersConcept !== undefined,
    "monorepo regression guard: the real 'users' concept still forms",
    `concepts: ${JSON.stringify(monorepoIndex.concepts.map((c) => c.displayName))}`,
  );
}

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
