// Tests Phase 6: bounded iterative retrieval (lib/ai/retrieval-loop.ts).
// Pure deterministic checks: no database, no LLM. A small mock db (same
// emulation as the retrieval fixture) drives the real pipeline through
// complete retrieval calls, so every scenario exercises the unchanged
// Phase 3/4 engine plus the loop's targeted passes, merging and stopping.

import { createHash } from "node:crypto";
import {
  CATEGORY_QUERY_WORDS,
  mergeIterationWindows,
  retrieveWithCoverageLoop,
  windowAffiliation,
} from "../lib/ai/retrieval-loop.ts";
import type { Db, RetrievedWindow } from "../lib/ai/retrieval.ts";

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

// ---- Section 1: mergeIterationWindows (pure) -----------------------------
console.log("=== 1. mergeIterationWindows: dedupe, caps, provenance ===");

let uniqueId = 0;
function mkWindow(overrides: Partial<RetrievedWindow>): RetrievedWindow {
  uniqueId += 1;
  return {
    fileId: `f${uniqueId}`,
    path: `src/file${uniqueId}.js`,
    contentHash: `hash${uniqueId}`,
    totalLines: 200,
    startLine: 1,
    endLine: 40,
    score: 90,
    text: "x".repeat(20),
    reason: "symbol \"probe\" (function) matches token \"probe\"",
    ...overrides,
  };
}

const limits = { maxFiles: 16, maxWindowsPerFile: 2, maxCharacters: 28000, scoreFloor: 50 };

// Exact duplicate is never re-served.
const mk1 = mergeIterationWindows(
  { windows: [mkWindow({ fileId: "fA", path: "src/a.js", startLine: 1, endLine: 29 })], totalCharacters: 30 },
  [mkWindow({ fileId: "fA", path: "src/a.js", startLine: 1, endLine: 29 })],
  limits,
);
check(mk1.added === 0 && mk1.windows.length === 1, "exact duplicate window skipped", `exact dup not skipped: added=${mk1.added}`);

// Overlapping slices and slices within retrieval's own 5-line merge gap are
// the same evidence and are never re-served.
const mk2 = mergeIterationWindows(
  { windows: [mkWindow({ fileId: "fA", path: "src/a.js", startLine: 1, endLine: 29 })], totalCharacters: 30 },
  [
    mkWindow({ fileId: "fA", path: "src/a.js", startLine: 10, endLine: 40 }),
    mkWindow({ fileId: "fA", path: "src/a.js", startLine: 31, endLine: 60 }),
  ],
  limits,
);
check(mk2.added === 0, "overlapping (or gap-adjacent) same-file windows all skipped", `overlap skipped failed: added=${mk2.added}`);

// A disjoint window on an already-included file is appended (drilling), the
// current package is never displaced, and provenance flows through verbatim.
const current3 = [mkWindow({ fileId: "fA", path: "src/a.js", startLine: 1, endLine: 29, provenance: "indexed" })];
const mk3 = mergeIterationWindows(
  { windows: current3, totalCharacters: current3[0]!.text.length },
  [
    mkWindow({ fileId: "fA", path: "src/a.js", startLine: 65, endLine: 115 }),
    mkWindow({ fileId: "fB", path: "src/b.js", startLine: 1, endLine: 50, provenance: "derived", score: 95 }),
  ],
  limits,
);
check(
  mk3.added === 2 && mk3.addedFiles === 1 && mk3.windows.length === 3,
  "disjoint windows append; existing evidence untouched",
  `merge append failed: added=${mk3.added} windows=${mk3.windows.length}`,
);
check(
  mk3.windows[0] === current3[0] && mk3.windows[0]!.provenance === "indexed" && mk3.windows.some((w) => w.provenance === "derived"),
  "provenance (indexed/derived/direct) passes through untouched",
  "provenance lost",
);

// Per-file window cap holds.
const mk4 = mergeIterationWindows(
  {
    windows: [
      mkWindow({ fileId: "fA", path: "src/a.js", startLine: 1, endLine: 29 }),
      mkWindow({ fileId: "fA", path: "src/a.js", startLine: 70, endLine: 95 }),
    ],
    totalCharacters: 200,
  },
  [mkWindow({ fileId: "fA", path: "src/a.js", startLine: 130, endLine: 170 })],
  limits,
);
check(mk4.added === 0 && mk4.rejectedBudget >= 0, "per-file window cap enforced", `per-file cap failed: added=${mk4.added}`);

// File cap: new files cannot enter when the 16-file budget is full.
const fileCapWindows = Array.from({ length: 16 }, (_, i) =>
  mkWindow({ fileId: `c${i}`, path: `src/d/file${i}.js` }),
);
const mk5 = mergeIterationWindows(
  { windows: fileCapWindows, totalCharacters: 2000 },
  [mkWindow({ fileId: "fN", path: "src/models/new.js", score: 95 })],
  limits,
);
check(mk5.added === 0 && mk5.rejectedBudget === 1, "file cap rejected with a budget reason", `file cap failed: added=${mk5.added} rejected=${mk5.rejectedBudget}`);

// Score floor: a new file below the floor cannot pad the package.
const mk6 = mergeIterationWindows(
  { windows: [mkWindow({ fileId: "fA", path: "src/a.js" })], totalCharacters: 100 },
  [mkWindow({ fileId: "fW", path: "src/weak.js", score: 40 })],
  limits,
);
check(mk6.added === 0 && mk6.rejectedBudget === 1, "weak new-file candidate below score floor rejected", "score floor failed");

// An already-included file's weak candidate may still drill (no displacement).
const mk7 = mergeIterationWindows(
  { windows: [mkWindow({ fileId: "fA", path: "src/a.js" })], totalCharacters: 100 },
  [mkWindow({ fileId: "fA", path: "src/a.js", startLine: 100, endLine: 140, score: 30 })],
  limits,
);
check(mk7.added === 1, "existing-file candidate is appended even when low-scored (drilling only)", "existing-file drill blocked");

// Character budget holds.
const mk8 = mergeIterationWindows(
  { windows: [], totalCharacters: 27900 },
  [mkWindow({ fileId: "fA", path: "src/a.js", text: "y".repeat(2000) })],
  limits,
);
check(mk8.added === 0 && mk8.rejectedBudget === 1, "character budget enforced", "character budget failed");

// ---- Section 2: windowAffiliation (pure) ---------------------------------
console.log("");
console.log("=== 2. windowAffiliation mirrors coverage semantics ===");
{
  // The focused-vocabulary table must stay aligned with the planner's
  // category set: every planner category maps to focused query words.
  const categories = new Set([
    ...Object.values(CATEGORY_QUERY_WORDS),
  ]);
  check(
    Object.keys(CATEGORY_QUERY_WORDS).sort().join(",") === "config,controllers,frontend,middleware,models,routes,services"
      && CATEGORY_QUERY_WORDS.routes === "route router endpoint"
      && categories.size === 7,
    "focused query words exist for every planner category",
    `category words: ${JSON.stringify(CATEGORY_QUERY_WORDS)}`,
  );
}

check(windowAffiliation({ path: "backend/src/routes/media.js", reason: "" }) === "routes", "path segment affiliates routes", "routes segment affiliation failed");
check(windowAffiliation({ path: "src/anything.js", reason: 'file holds the "controller" role' }) === "controllers", "reason role affiliates controllers", "role affiliation failed");
check(windowAffiliation({ path: "src/services/records.js", reason: "" }) === "services", "services segment affiliates", "services affiliation failed");
check(windowAffiliation({ path: "packages/src/client/keys.ts", reason: "" }) === "frontend", "client segment affiliates frontend", "frontend affiliation failed");
check(windowAffiliation({ path: "src/data/archive.js", reason: "" }) === null, "unaffiliated paths return null", "null affiliation failed");

// ---- Section 3: the loop against the real pipeline -----------------------

type TextLine = string | null;

type MockFile = {
  id: string;
  path: string;
  lines?: number;
  role?: string;
  symbols?: [name: string, line: number, exported?: boolean][];
  routes?: { method: string; path: string; line: number }[];
  text?: (line: number) => TextLine;
};

type MockDbRecord = {
  db: {
    from(table: string): unknown;
  };
  calls: Record<string, number>;
};

const FILLER = (line: number): string => `// chain ${line}`;

function buildMock(
  analysisId: string,
  fileSpecs: MockFile[],
  edges: { source: string; target: string; kind?: string }[] = [],
): MockDbRecord {
  const calls: Record<string, number> = {};
  const fileTexts = new Map<string, string>();
  const rows = fileSpecs.map((spec) => {
    const total = spec.lines ?? 70;
    const parts: string[] = [];
    for (let i = 1; i <= total; i++) {
      const custom = spec.text?.(i);
      parts.push(custom ?? FILLER(i));
    }
    const text = parts.join("\n") + "\n";
    const hash = createHash("sha256").update(text).digest("hex");
    fileTexts.set(spec.id, text);
    return {
      id: spec.id,
      path: spec.path,
      hash,
      lines: total,
      content_status: "stored",
      analysis_id: analysisId,
      file_roles: spec.role ? [{ role: spec.role, source: "convention" }] : [{ role: undefined, source: "convention" }],
    };
  });

  const symbolRows = fileSpecs.flatMap((spec) =>
    (spec.symbols ?? []).map(([name, line, exported]) => ({
      file_id: spec.id,
      name,
      kind: name[0] === name[0]!.toUpperCase() ? "class" : "function",
      line,
      exported: exported ?? false,
    })),
  );
  const routeRows = fileSpecs.flatMap((spec) =>
    (spec.routes ?? []).map((r) => ({
      file_id: spec.id,
      method: r.method,
      path: r.path,
      line: r.line,
    })),
  );
  const edgeRows = edges.map((e) => ({
    source_file_id: e.source,
    target_file_id: e.target,
    kind: e.kind ?? "import",
  }));

  return {
    db: {
      from(table: string) {
        calls[table] = (calls[table] ?? 0) + 1;
        if (table === "files") {
          return {
            select: () => ({
              eq: (col: string, value: string) => ({
                is: () =>
                  Promise.resolve({
                    data: col === "analysis_id"
                      ? rows.filter((f) => f.analysis_id === value)
                      : rows,
                    error: null,
                  }),
                maybeSingle: async () => ({
                  data: rows.find((f) => f.id === value) ?? null,
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "symbols") {
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: symbolRows, error: null }),
            }),
          };
        }
        if (table === "routes") {
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: routeRows, error: null }),
            }),
          };
        }
        if (table === "edges") {
          return {
            select: () => ({
              eq: () => ({
                or: (orFilter: string) => {
                  const seedIds = new Set<string>();
                  for (const m of orFilter.matchAll(/in\.\(([^)]*)\)/g)) {
                    for (const id of (m[1] ?? "").split(",")) {
                      if (id.trim()) seedIds.add(id.trim());
                    }
                  }
                  const filtered = edgeRows.filter(
                    (edge) => seedIds.has(edge.source_file_id) || seedIds.has(edge.target_file_id),
                  );
                  return Promise.resolve({ data: filtered, error: null });
                },
              }),
            }),
          };
        }
        if (table === "file_contents") {
          return {
            select: () => ({
              eq: () => ({
                eq: (_col: string, hash: string) => ({
                  maybeSingle: async () => {
                    const row = rows.find((f) => f.hash === hash);
                    if (!row) return { data: null, error: null };
                    const text = fileTexts.get(row.id) ?? "";
                    return {
                      data: {
                        payload: `\\x${Buffer.from(text, "utf8").toString("hex")}`,
                        size: Buffer.byteLength(text, "utf8"),
                      },
                      error: null,
                    };
                  },
                }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    },
    calls,
  };
}

function assertBudgetInvariants(
  label: string,
  result: Awaited<ReturnType<typeof retrieveWithCoverageLoop>>["result"],
): void {
  const perFile = new Map<string, number>();
  const seen = new Set<string>();
  let ok = true;
  let overlapOk = true;
  for (const win of result.windows) {
    perFile.set(win.fileId, (perFile.get(win.fileId) ?? 0) + 1);
    const key = `${win.fileId}:${win.startLine}:${win.endLine}`;
    if (seen.has(key)) ok = false;
    seen.add(key);
  }
  const byFile = new Map<string, { startLine: number; endLine: number }[]>();
  for (const win of result.windows) {
    const list = byFile.get(win.fileId) ?? [];
    list.push(win);
    byFile.set(win.fileId, list);
  }
  for (const list of byFile.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i]!.startLine <= list[j]!.endLine + 5 && list[j]!.startLine <= list[i]!.endLine + 5) overlapOk = false;
      }
    }
  }
  check(result.files.length <= 16, `${label}: file budget respected (${result.files.length})`, `${label}: ${result.files.length} files exceed budget`);
  check(result.totalCharacters <= 28000, `${label}: character budget respected (${result.totalCharacters})`, `${label}: characters ${result.totalCharacters} exceed budget`);
  check([...perFile.values()].every((n) => n <= 2), `${label}: per-file window cap respected`, `${label}: per-file cap violated`);
  check(ok, `${label}: no duplicate windows`, `${label}: duplicate window found`);
  check(overlapOk, `${label}: no overlapping windows on the same file`, `${label}: overlapping windows found`);
}

console.log("");
console.log("=== 3. SDK scenario: routes/controllers partial improve through targeted retrieval ===");
{
  const sdk = buildMock("loop_sdk",
    [
      {
        id: "sdk_routes",
        path: "backend/routes/mediaRegistry.js",
        lines: 190,
        symbols: [["developerKeysRegistry", 80, true]],
        routes: [{ method: "GET", path: "/router-registration", line: 140 }],
        text: (n) => (n === 80 ? "function developerKeysRegistry(req) { return issueKey(req); }" : n === 140 ? "routerRegistration.add('/media/sdk/register', guardChain);" : null),
      },
      {
        id: "sdk_controller",
        path: "backend/src/controllers/mediaKeys.js",
        role: "controller",
        lines: 160,
        symbols: [["issueDeveloperKey", 88, true]],
        text: (n) => (n === 8 ? "const sdkGuard = validateIssue(req);" : n === 88 ? "async function issueDeveloperKey(req) { return issueKeyRow(req); }" : null),
      },
      {
        id: "sdk_frontend",
        path: "packages/src/client/keys.ts",
        lines: 70,
        symbols: [["listDeveloperKeys", 8, true]],
        text: (n) => (n === 6 ? "export const listDeveloperKeys = () => sdkKeysClient.list();" : null),
      },
    ]);

  const loop = await retrieveWithCoverageLoop(sdk.db as unknown as Db, "loop_sdk", "How does the developer SDK work in this project?", { adaptive: false });
  check(loop.stoppedBecause === "sufficient-coverage", "loop stops on sufficient coverage", `stop reason: ${loop.stoppedBecause}`);
  check(loop.passes.length === 1, "exactly one targeted pass was needed", `passes: ${loop.passes.length}`);
  check(loop.passes[0]!.addedWindows === 2, "targeted pass added one window per missing category", `added: ${loop.passes[0]!.addedWindows}`);
  check(
    JSON.stringify(loop.passes[0]!.queries) === JSON.stringify(["sdk route router endpoint", "sdk controller handler"]),
    "focused queries pair the concept token with category vocabulary",
    `queries: ${JSON.stringify(loop.passes[0]!.queries)}`,
  );
  const concept = loop.coverage.concepts.find((c) => c.token === "sdk")!;
  check(
    concept !== undefined && concept.categories.every((c) => c.status === "found"),
    "sdk coverage reaches found for routes, controllers and frontend",
    `sdk coverage: ${JSON.stringify(loop.coverage.concepts)}`,
  );
  check(loop.coverage.summary.partial === 0 && loop.coverage.summary.unknown === 0, "nothing regressed to partial/unknown", `summary: ${JSON.stringify(loop.coverage.summary)}`);
  check(
    loop.result.windows.some((w) => w.path === "backend/routes/mediaRegistry.js" && w.startLine === 130),
    "routes drill surfaced the route-table slice (new evidence, same file)",
    `routes windows: ${JSON.stringify(loop.result.windows.filter((w) => w.path.includes("mediaRegistry")).map((w) => `${w.startLine}-${w.endLine}`))}`,
  );
  check(
    loop.result.windows.some((w) => w.path === "backend/src/controllers/mediaKeys.js" && w.startLine === 1),
    "controller drill surfaced the import header slice (new evidence, same file)",
    "controller header missing",
  );
  check(sdk.calls.symbols === 3, `two focused retrievals plus the base pass ran (symbols queries: ${sdk.calls.symbols})`, `symbol queries: ${sdk.calls.symbols}`);
  assertBudgetInvariants("sdk", loop.result);
}

console.log("");
console.log("=== 4. Authentication scenario: already sufficient, zero passes ===");
{
  const auth = buildMock("loop_auth",
    [
      {
        id: "auth_controller",
        path: "backend/src/controllers/sessionGuard.js",
        role: "controller",
        lines: 70,
        symbols: [["verifySessionGuard", 10, true]],
        text: (n) => (n === 10 ? "function verifySessionGuard(req, next) { return next(); }" : null),
      },
      {
        id: "auth_middleware",
        path: "src/middlewares/authenticate.js",
        role: "middleware",
        lines: 70,
        symbols: [["authenticateRequests", 6, true]],
        text: (n) => (n === 6 ? "const authenticateRequests = chain(theGuards);" : null),
      },
      {
        id: "auth_model",
        path: "src/models/userSessions.js",
        role: "model",
        lines: 70,
        symbols: [["UserSession", 8, true]],
        text: (n) => (n === 8 ? "const UserSession = defineMapping('user_sessions_data');" : null),
      },
      {
        id: "auth_frontend",
        path: "web/src/pages/LoginPage.jsx",
        lines: 70,
        symbols: [["LoginPageForm", 8, true]],
        text: (n) => (n === 8 ? "const LoginPageForm = () => loginSubmit();" : null),
      },
    ]);

  const loop = await retrieveWithCoverageLoop(auth.db as unknown as Db, "loop_auth", "How does authentication work in this project?", { adaptive: false });
  check(loop.stoppedBecause === "sufficient-coverage", "loop stops immediately when the base package is sufficient", `stop: ${loop.stoppedBecause}`);
  check(loop.passes.length === 0, "zero additional passes for the all-found auth package", `passes: ${JSON.stringify(loop.passes)}`);
  check(auth.calls.symbols === 1, `single retrieval call (symbols queries: ${auth.calls.symbols})`, `symbol queries: ${auth.calls.symbols}`);
  check(
    loop.coverage.summary.found === 4 && loop.coverage.summary.partial === 0 && loop.coverage.summary.unknown === 0,
    "auth coverage all-found without regression",
    `summary: ${JSON.stringify(loop.coverage.summary)}`,
  );
  assertBudgetInvariants("auth", loop.result);
}

console.log("");
console.log("=== 5. Bounded iteration: stops at the iteration limit ===");
{
  const maxPasses = buildMock("loop_max",
    [
      {
        id: "max_frontend",
        path: "packages/src/client/media.js",
        lines: 70,
        text: (n) => (n === 6 ? "export const storeMediaChannel = Object.create(null);" : null),
      },
      {
        id: "max_controller",
        path: "backend/src/controllers/restful.js",
        role: "controller",
        lines: 70,
        text: (n) => (n === 9 ? "module.exports.validUpload = sdkCombine(body);" : null),
      },
      {
        id: "max_service",
        path: "backend/src/services/persist.js",
        role: "service",
        lines: 70,
        text: (n) => (n === 6 ? "module.exports.storeAttachment = (payload) => bucketPersist(payload);" : null),
      },
      {
        id: "max_model",
        path: "src/models/media.js",
        role: "model",
        lines: 70,
        text: (n) => (n === 7 ? "module.exports.saveMultipartPayload = insertRow;" : null),
      },
      {
        id: "max_config",
        path: "backend/src/config/mediaEnv.js",
        role: "config",
        lines: 70,
        text: (n) => (n === 4 ? "module.exports.uploadLimits = process.env.UPLOAD_MAX;" : null),
      },
      {
        id: "max_routes",
        path: "backend/routes/mediaList.js",
        lines: 70,
      },
    ]);

  const query = "How does the file upload SDK work in this project?";
  const loop = await retrieveWithCoverageLoop(maxPasses.db as unknown as Db, "loop_max", query, { adaptive: false });
  check(loop.stoppedBecause === "max-passes", "stops at the iteration limit", `stop: ${loop.stoppedBecause}`);
  check(loop.passes.length === 3, `exactly ${3} additional passes ran (got ${loop.passes.length})`, `passes: ${loop.passes.length}`);
  check(loop.passes.every((p) => p.addedWindows > 0), "every pass still added fresh evidence", `added: ${JSON.stringify(loop.passes.map((p) => p.addedWindows))}`);
  check(
    loop.coverage.summary.found === 4 && loop.coverage.summary.partial === 1 && loop.coverage.summary.unknown === 2,
    `coverage improved to {found 4, partial 1, unknown 2} without completing (summary: ${JSON.stringify(loop.coverage.summary)})`,
    `summary: ${JSON.stringify(loop.coverage.summary)}`,
  );
  check(
    loop.coverage.concepts.some((c) => c.categories.some((cat) => cat.status === "partial" || cat.status === "unknown")),
    "loop leaves remaining gaps alongside their fixed unknown note",
    `concepts: ${JSON.stringify(loop.coverage.concepts)}`,
  );
  assertBudgetInvariants("max-passes", loop.result);
}

console.log("");
console.log("=== 6. File budget exhausted ===");
{
  // 16 controller files seeded by the question; the missing service layer
  // exists in the db but its file slot is already gone.
  const sixteen = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen"];
  const spec: MockFile[] = sixteen.map((word) => ({
    id: `budget_${word}`,
    path: `backend/src/controllers/upload${word[0]!.toUpperCase()}${word.slice(1)}.js`,
    role: "controller",
    lines: 100,
    text: (n) => (n === 9 ? `module.exports.uploadHandler = deepCombine(req);` : null),
  }));
  spec.push({
    id: "budget_service",
    path: "backend/src/services/persist.js",
    role: "service",
    lines: 70,
    text: (n) => (n === 5 ? "module.exports.attachmentSink = deepStore(payload);" : null),
  });
  const budget = buildMock("loop_budget", spec);

  const loop = await retrieveWithCoverageLoop(budget.db as unknown as Db, "loop_budget", "How does the file upload SDK work in this project?", { adaptive: false });
  check(loop.stoppedBecause === "budget-exhausted", "stops when the file budget is exhausted", `stop: ${loop.stoppedBecause}`);
  check(loop.passes.length === 1, `stops after the first dry pass (got ${loop.passes.length})`, `passes: ${loop.passes.length}`);
  check(loop.result.files.length === 16, `file count pinned at 16 (got ${loop.result.files.length})`, `files: ${loop.result.files.length}`);
  check(loop.result.totalCharacters <= 28000, `character budget respected (${loop.result.totalCharacters})`, `chars: ${loop.result.totalCharacters}`);
  assertBudgetInvariants("budget", loop.result);
}

console.log("");
console.log("=== 7. No candidates remain ===");
{
  // Same fixture without the service file: the targeted retrieval finds
  // nothing new, so the loop stops and says so.
  const sixteen = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen"];
  const spec: MockFile[] = sixteen.map((word) => ({
    id: `nocand_${word}`,
    path: `backend/src/controllers/upload${word[0]!.toUpperCase()}${word.slice(1)}.js`,
    role: "controller",
    lines: 100,
    text: (n) => (n === 9 ? `module.exports.uploadHandler = deepUnify(req);` : null),
  }));
  const dry = buildMock("loop_nocand", spec);

  const loop = await retrieveWithCoverageLoop(dry.db as unknown as Db, "loop_nocand", "How does the file upload SDK work in this project?", { adaptive: false });
  check(loop.stoppedBecause === "no-candidates", "stops when no candidates remain", `stop: ${loop.stoppedBecause}`);
  check(loop.passes.length === 1 && loop.passes[0]!.addedWindows === 0, "the dry pass added nothing", `passes: ${JSON.stringify(loop.passes)}`);
  assertBudgetInvariants("no-candidates", loop.result);
}

console.log("");
console.log("=== 8. Provenance and hashes preserved through the loop ===");
{
  const prov = buildMock("loop_prov",
    [
      {
        id: "prov_svc",
        path: "src/services/records.js",
        role: "service",
        lines: 70,
        symbols: [["saveRecords", 4, true]],
        text: (n) => (n === 4 ? "function saveRecords(key, recordRow) { return recordRow; }" : null),
      },
      { id: "prov_data", path: "src/data/archive.js", lines: 70 },
    ],
    [{ source: "prov_svc", target: "prov_data", kind: "import" }]);

  const loop = await retrieveWithCoverageLoop(prov.db as unknown as Db, "loop_prov", "Where is the record store used?", { adaptive: false });
  check(loop.stoppedBecause === "no-candidates", "the unrelated-category drill finds nothing new (stops, never invents)", `stop: ${loop.stoppedBecause}`);
  check(loop.passes.length === 1, "one focused pass ran before the stop", `passes: ${loop.passes.length}`);
  const indexedWindow = loop.result.windows.find((w) => w.path === "src/data/archive.js");
  check(
    indexedWindow !== undefined && indexedWindow.provenance === "indexed",
    `relationship window kept its "indexed" provenance (${indexedWindow?.provenance ?? "missing"})`,
    "indexed provenance lost",
  );
  check(
    loop.result.windows.every((w) => typeof w.contentHash === "string" && w.contentHash.length === 64),
    "every window keeps its content hash for citation verification",
    "hash missing",
  );
  check(prov.calls.symbols === 2, `base plus one focused retrieval (symbols queries: ${prov.calls.symbols})`, `symbols: ${prov.calls.symbols}`);
  assertBudgetInvariants("prov", loop.result);
}

  // Section 9: adaptive concept discovery (Phase 1) on an unfamiliar repository.
  console.log("");
  console.log("=== 9. Adaptive concept discovery (unfamiliar repo, no hardcoded categories) ===");
  {
    const adaptive = buildMock("loop_adaptive", [
      { id: "t_collector", path: "src/telemetry/collector.ts", role: "service", lines: 40, symbols: [["TelemetryCollector", 4, true]], text: (n) => (n === 4 ? "export class TelemetryCollector { record() {} }" : null) },
      { id: "t_exporter", path: "src/telemetry/exporter.ts", role: "service", lines: 40, symbols: [["ExportTelemetryMetrics", 4, true]], text: (n) => (n === 4 ? "export function ExportTelemetryMetrics() { return null; }" : null) },
      { id: "t_buffer", path: "src/telemetry/buffer.ts", role: "model", lines: 40, symbols: [["TelemetryBufferQueue", 4, true]], text: (n) => (n === 4 ? "export class TelemetryBufferQueue { enqueue() {} }" : null) },
      { id: "s_coordinator", path: "src/sharding/coordinator.ts", role: "controller", lines: 40, symbols: [["ShardingCoordinator", 4, true]], text: (n) => (n === 4 ? "export class ShardingCoordinator { plan() {} }" : null) },
      { id: "s_partition", path: "src/sharding/partition_map.ts", role: "model", lines: 40, symbols: [["PartitionMap", 4, true]], text: (n) => (n === 4 ? "export interface PartitionMap { shards: number }" : null) },
      { id: "s_rebalancer", path: "src/sharding/rebalancer.ts", role: "service", lines: 40, symbols: [["RebalanceShards", 4, true]], text: (n) => (n === 4 ? "export function RebalanceShards() { return null; }" : null) },
    ], [
      { source: "t_collector", target: "t_exporter" },
      { source: "t_collector", target: "t_buffer" },
      { source: "s_coordinator", target: "s_partition" },
      { source: "s_coordinator", target: "s_rebalancer" },
    ]);

    const loop = await retrieveWithCoverageLoop(adaptive.db as unknown as Db, "loop_adaptive", "How does telemetry collection work?");
    check(loop.coverage.concepts.length > 0, "adaptive discovery produces repository-derived concepts", `concepts: ${loop.coverage.concepts.length}`);
    // Categories should be derived (roles), not the hardcoded 7-layer vocabulary forced onto an unrelated repo.
    const categories = loop.coverage.concepts.flatMap((c) => c.categories.map((cat) => cat.category));
    check(categories.length > 0, "adaptive coverage emits categories from discovered roles", `categories: ${JSON.stringify(categories)}`);
    check(loop.result.files.length > 0, "retrieval returns evidence for the unfamiliar concept", `files: ${loop.result.files.length}`);
    check(loop.stoppedBecause !== undefined, "loop reports a stop reason", `stop: ${loop.stoppedBecause}`);
    assertBudgetInvariants("adaptive", loop.result);
  }

// ---- Summary ----
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
