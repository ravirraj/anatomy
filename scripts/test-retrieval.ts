// Tests Milestone 2: Deterministic Retrieval Engine
// Exercises query normalization, entity extraction, multi-index discovery,
// graph expansion, window merging, and context budgeting.

import { createHash } from "node:crypto";
import {
  extractQueryTokens,
  formatRetrievedContext,
  mergeCandidateWindows,
  retrieveGroundedContext,
  DEFAULT_BUDGET,
  type Db,
  tokenVariants,
  identifierSubtokens,
  deriveReferences,
  specifierCandidates,
  type TargetWindow,
} from "../lib/ai/retrieval.ts";
import type { BackfillDeps } from "../lib/content/read.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

// --- Section 1: Query token normalization ---
console.log("=== 1. Query token normalization ===");

const tokens1 = extractQueryTokens("How does authentication and session work in this repository?");
if (tokens1.includes("authentication") && tokens1.includes("session") && !tokens1.includes("how") && !tokens1.includes("work")) {
  pass("stop words are filtered and keywords extracted");
} else {
  fail(`unexpected tokens: ${JSON.stringify(tokens1)}`);
}

const tokens2 = extractQueryTokens("Where is createAdminSupabase client configured?");
if (tokens2.includes("createadminsupabase") && tokens2.includes("admin") && tokens2.includes("supabase")) {
  pass("camelCase identifiers are expanded and indexed");
} else {
  fail(`camelCase expansion failed: ${JSON.stringify(tokens2)}`);
}

const tokens3 = extractQueryTokens("Inspect app/(workspace)/analyses/[id]/actions.ts router");
if (tokens3.some((t) => t.includes("actions.ts"))) {
  pass("explicit file paths with extensions are extracted");
} else {
  fail(`file path extraction failed: ${JSON.stringify(tokens3)}`);
}

// --- Section 2: Window merging and deduplication ---
console.log("");
console.log("=== 2. Window merging and deduplication ===");

const sampleWindows: TargetWindow[] = [
  {
    fileId: "f1",
    path: "src/auth.ts",
    contentHash: "hash1",
    totalLines: 100,
    startLine: 10,
    endLine: 30,
    score: 80,
    reason: "match 1",
  },
  {
    fileId: "f1",
    path: "src/auth.ts",
    contentHash: "hash1",
    totalLines: 100,
    startLine: 25,
    endLine: 50,
    score: 90,
    reason: "match 2",
  },
  {
    fileId: "f1",
    path: "src/auth.ts",
    contentHash: "hash1",
    totalLines: 100,
    startLine: 70,
    endLine: 90,
    score: 60,
    reason: "match 3",
  },
  {
    fileId: "f2",
    path: "src/user.ts",
    contentHash: "hash2",
    totalLines: 50,
    startLine: 1,
    endLine: 40,
    score: 75,
    reason: "user match",
  },
];

const merged = mergeCandidateWindows(sampleWindows);
const f1Merged = merged.filter((m) => m.fileId === "f1");
const f2Merged = merged.filter((m) => m.fileId === "f2");

if (f1Merged.length === 2) {
  pass("overlapping windows on same file merged into 2 disjoint regions");
} else {
  fail(`expected 2 merged windows for f1, got ${f1Merged.length}`);
}

const firstWindow = f1Merged.find((m) => m.startLine === 10);
if (firstWindow && firstWindow.endLine === 50 && firstWindow.score === 90) {
  pass("merged window expands to cover [10, 50] with highest score");
} else {
  fail(`merged window bounds incorrect: start=${firstWindow?.startLine}, end=${firstWindow?.endLine}`);
}

if (f2Merged.length === 1 && f2Merged[0]!.path === "src/user.ts") {
  pass("independent file windows are preserved");
} else {
  fail("independent file window failed");
}

// --- Section 3: Multi-stage retrieval with Fake Database ---
console.log("");
console.log("=== 3. Multi-stage retrieval with mock DB ===");

const textAuth = Array.from({ length: 80 }, (_, i) => `// line ${i + 1} of session.ts\n`).join("");
const hashAuth = createHash("sha256").update(textAuth).digest("hex");

const textUser = Array.from({ length: 60 }, (_, i) => `// line ${i + 1} of user.ts\n`).join("");
const hashUser = createHash("sha256").update(textUser).digest("hex");

const textRoute = Array.from({ length: 40 }, (_, i) => `// line ${i + 1} of login.ts\n`).join("");
const hashRoute = createHash("sha256").update(textRoute).digest("hex");

class MockDb {
  files = [
    {
      id: "f_auth",
      path: "src/auth/session.ts",
      hash: hashAuth,
      lines: 80,
      content_status: "stored",
      file_roles: [{ role: "service", source: "convention" }],
    },
    {
      id: "f_user",
      path: "src/models/user.ts",
      hash: hashUser,
      lines: 60,
      content_status: "stored",
      file_roles: [{ role: "model", source: "convention" }],
    },
    {
      id: "f_route",
      path: "src/api/login.ts",
      hash: hashRoute,
      lines: 40,
      content_status: "stored",
      file_roles: [{ role: "endpoint", source: "convention" }],
    },
  ];

  symbols = [
    { file_id: "f_auth", name: "validateSession", kind: "function", line: 25, exported: true },
    { file_id: "f_auth", name: "createToken", kind: "function", line: 55, exported: true },
    { file_id: "f_user", name: "UserRecord", kind: "interface", line: 10, exported: true },
  ];

  routes = [
    { file_id: "f_route", method: "POST", path: "/api/login", line: 15 },
  ];

  edges = [
    { source_file_id: "f_route", target_file_id: "f_auth", kind: "import" },
  ];

  fileTexts = new Map<string, string>([
    ["f_auth", textAuth],
    ["f_user", textUser],
    ["f_route", textRoute],
  ]);

  from(table: string) {
    if (table === "files") {
      return {
        select: () => ({
          eq: (_f: string, val: string) => ({
            is: () => Promise.resolve({ data: this.files, error: null }),
            maybeSingle: async () => {
              const file = this.files.find((f) => f.id === val);
              if (!file) return { data: null, error: null };
              return {
                data: {
                  ...file,
                  organization_id: "org_test",
                  analysis: { commit_sha: "sha1", project: { repo_owner: "o", repo_name: "r" } },
                },
                error: null,
              };
            },
          }),
        }),
      };
    }
    if (table === "symbols") {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: this.symbols, error: null }),
        }),
      };
    }
    if (table === "routes") {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: this.routes, error: null }),
        }),
      };
    }
    if (table === "edges") {
      return {
        select: () => ({
          eq: () => ({
            or: (orFilter: string) => {
              // Emulate PostgREST's `.or("source_file_id.in.(a,b),target_file_id.in.(a,b)")`
              // — only edges actually touching one of the listed ids come back.
              const seedIds = new Set<string>();
              for (const m of orFilter.matchAll(/in\.\(([^)]*)\)/g)) {
                for (const id of (m[1] ?? "").split(",")) {
                  if (id.trim()) seedIds.add(id.trim());
                }
              }
              const filtered = this.edges.filter(
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
            eq: (_f2: string, hash: string) => ({
              maybeSingle: async () => {
                const f = this.files.find((file) => file.hash === hash);
                if (!f) return { data: null, error: null };
                const text = this.fileTexts.get(f.id) ?? "";
                const hex = Buffer.from(text, "utf8").toString("hex");
                return {
                  data: {
                    payload: `\\x${hex}`,
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
    if (table === "manifests" || table === "dependencies" || table === "config_references" || table === "entry_points") {
      // This fixture repository declares no packaging metadata, which is the
      // common case for an analysis stored before Phase 4. Returning an empty
      // set is what the real client does for such an analysis, and it
      // exercises the path where the packaging blocks are simply absent.
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      };
    }
    throw new Error(`Unexpected table ${table}`);
  }
}

const mockDb = new MockDb();

// Test symbol-driven query
const resultA = await retrieveGroundedContext(mockDb as unknown as Db, "test_analysis", "How does validateSession verify users?");
if (!resultA.insufficientEvidence && resultA.windows.length > 0) {
  pass("symbol query retrieves candidate windows");
} else {
  fail("symbol query returned no evidence");
}

const authWin = resultA.windows.find((w) => w.path.includes("session.ts"));
if (authWin && authWin.reason.includes("validateSession")) {
  pass("matched window contains expected symbol validation reason");
} else {
  fail(`symbol window missing: ${JSON.stringify(resultA.windows)}`);
}

// Test route-driven query + 1-hop graph expansion
const resultB = await retrieveGroundedContext(mockDb as unknown as Db, "test_analysis", "Explain the login endpoint POST /api/login");
if (resultB.windows.some((w) => w.path.includes("login.ts"))) {
  pass("route query identifies seed file login.ts");
} else {
  fail("route query failed to identify login.ts");
}
if (resultB.windows.some((w) => w.path.includes("session.ts"))) {
  const reason = resultB.windows.find((w) => w.path.includes("session.ts"))!.reason;
  // Session.ts may arrive as a direct concept seed ("login" -> "session") or
  // as 1-hop dependency of the login route; both ground it in evidence.
  if (reason.includes("1-hop dependency") || reason.includes("file path") || reason.includes("symbol")) {
    pass("login route query grounds session.ts (concept seed or graph expansion)");
  } else {
    fail(`session.ts grounded with unexpected reason: ${reason}`);
  }
} else {
  fail(`login route query failed to reach session.ts: ${JSON.stringify(resultB.windows.map((w) => ({ path: w.path, reason: w.reason })))}`);
}

// Test insufficient evidence query
const resultC = await retrieveGroundedContext(mockDb as unknown as Db, "test_analysis", "Where is the billing stripe webhook processed?");
if (resultC.insufficientEvidence && resultC.windows.length === 0) {
  pass("query with no matching evidence sets insufficientEvidence: true");
} else {
  fail("expected insufficientEvidence for unrelated query");
}

// Test formatting context for prompt
const formatted = formatRetrievedContext(resultB);
if (formatted.includes("--- File: src/api/login.ts") && formatted.includes("line 1 of login.ts")) {
  pass("context formatted cleanly with file headers and line indicators");
} else {
  fail(`formatted context failed: ${formatted}`);
}

// --- Section 4: Concept-aware retrieval on a realistic auth fixture ---
// A fixture repository with a real authentication flow (routes, controllers,
// middleware, a user model, JWT + password hashing) plus unrelated setup
// files. Verifies the general failure mode reported for the authsphere
// analysis: "How does authentication work?" must reach the whole flow, not
// bootstrap files, and the same must hold for the other question categories.

console.log("");
console.log("=== 4. Concept-aware retrieval (auth fixture) ===");

type FixtureFile = {
  id: string;
  path: string;
  role?: string;
  symbolNames: [name: string, line: number, exported?: boolean][];
  imports: string[]; // file ids
  /** Defaults to "fx_analysis"; other values model foreign organizations. */
  analysisId?: string;
  /** Overrides the default filler content (needed for import-derivation). */
  text?: string;
  /** CI-4: the row's content_status, defaulting to "stored". */
  status?: string;
};

const DERIVE_SOURCE_TEXT = [
  "import { targetUtil } from \"./target.js\";",
  "const shared = require(\"./shared.js\");",
  "export async function lazyLoad() {",
  "  return import(\"./lazy.js\");",
  "}",
  "export const duplicateTarget = import(\"./target.js\");",
  "import ghostModule from \"./missing/ghost.js\";",
  "import quarLeak from \"./quarantined.js\";",
  "import react from \"react\";",
  "",
  ...Array.from({ length: 62 }, (_, i) => `// line ${i + 1} of src/glean/source.js`),
  "",
].join("\n");

const fixtureFiles: FixtureFile[] = [
  {
    id: "fx_server",
    path: "src/server.js",
    symbolNames: [["startServer", 4], ["ensureEnv", 12]],
    imports: ["fx_app"],
  },
  {
    id: "fx_app",
    path: "src/app.js",
    symbolNames: [["createApp", 6]],
    // CI-4 probe: the stored app file indexes edges into both quarantined
    // files. Allowing these edges in means quarantine can be reached through
    // the graph; the candidate filter must make them dead ends.
    imports: ["fx_status_quar", "fx_status_legacy", "fx_auth_routes", "fx_error_middleware", "fx_db"],
  },
  {
    id: "fx_auth_routes",
    path: "src/routes/auth.routes.js",
    role: "router",
    symbolNames: [["apiLoginRoute", 4, true], ["apiRegisterRoute", 9, true]],
    imports: ["fx_auth_controller"],
  },
  {
    id: "fx_auth_controller",
    path: "src/controllers/authController.js",
    role: "controller",
    symbolNames: [["login", 10, true], ["register", 24, true], ["logout", 40], ["refreshTokenPair", 52]],
    imports: ["fx_user_model", "fx_jwt", "fx_bcrypt"],
  },
  {
    id: "fx_auth_middleware",
    path: "src/middlewares/authMiddleware.js",
    role: "middleware",
    symbolNames: [["verifyJWT", 5, true], ["authenticateUser", 18]],
    imports: ["fx_jwt"],
  },
  {
    id: "fx_error_middleware",
    path: "src/middlewares/errorMiddleware.js",
    role: "middleware",
    symbolNames: [["errorHandler", 6, true], ["notFoundHandler", 20]],
    imports: ["fx_app_error"],
  },
  {
    id: "fx_upload_middleware",
    path: "src/middlewares/uploadMiddleware.js",
    role: "middleware",
    symbolNames: [["multerUpload", 5, true], ["acceptAvatar", 14]],
    imports: ["fx_storage"],
  },
  {
    id: "fx_user_model",
    path: "src/models/userModel.js",
    role: "model",
    symbolNames: [["User", 8, true], ["findByEmail", 20], ["userSchema", 4]],
    imports: ["fx_db"],
  },
  {
    id: "fx_jwt",
    path: "src/utils/jwt.js",
    symbolNames: [["generateTokenPair", 3, true], ["validateSignedToken", 15, true]],
    imports: [],
  },
  {
    id: "fx_bcrypt",
    path: "src/utils/bcrypt.js",
    symbolNames: [["hashPassword", 4, true], ["comparePassword", 12, true]],
    imports: [],
  },
  {
    id: "fx_app_error",
    path: "src/utils/AppError.js",
    role: "service",
    symbolNames: [["AppError", 2, true], ["throwBadRequest", 11, true]],
    imports: [],
  },
  {
    id: "fx_upload_controller",
    path: "src/controllers/uploadController.js",
    role: "controller",
    symbolNames: [["uploadAvatar", 6, true], ["removeStoredFile", 22]],
    imports: ["fx_upload_middleware", "fx_storage"],
  },
  {
    id: "fx_storage",
    path: "src/services/storage.js",
    role: "service",
    symbolNames: [["saveToDisk", 4, true], ["readStoredFile", 16]],
    imports: ["fx_db"],
  },
  {
    id: "fx_db",
    path: "src/database/connectDB.js",
    role: "model", // db bootstrap classified with the data layer in this fixture
    symbolNames: [["connectDatabase", 5, true], ["disconnectDatabase", 14]],
    imports: [],
  },
  {
    id: "fx_logger",
    path: "src/logger.js",
    symbolNames: [["logDebug", 3, true], ["rotateLog", 14]],
    imports: [],
  },
  {
    // A backend file claiming the same concept by name: the competition case.
    id: "fx_sdk_routes",
    path: "backend/src/routes/sdk.routes.js",
    role: "router",
    symbolNames: [["sdkAuthorizeRoute", 4, true], ["sdkTokenRoute", 16, true]],
    imports: [],
  },
  {
    // The client SDK package: a graph island (nothing imports into it), like
    // real front-end packages. Discovery must come from concept vocabulary,
    // not from edges or roles.
    id: "fx_sdk_index",
    path: "packages/src/index.ts",
    symbolNames: [["AuthSphere", 40, true], ["initAuth", 52, true]],
    imports: [],
  },
  {
    id: "fx_sdk_api",
    path: "packages/src/client/api.ts",
    symbolNames: [["fetchWithAuth", 8, true]],
    imports: [],
  },
  // ---- Phase 4 relationship-expansion fixtures ----
  // A bounded transitive chain: root seeds, mid is reached by 1-hop, leaf
  // only by the capped 2-hop, and tip would require a never-taken 3rd hop.
  // Root also imports a ghost target id (missing file) and is referenced
  // under a foreign analysis id (organization-isolation probe). Paths and
  // symbols deliberately avoid the question's vocabulary — only mid/leaf/
  // tip's filenames ("src/meridian/mid.js"...) never match the query, so
  // edge expansion is their only route into the window list.
  {
    id: "fx_hop_root",
    path: "src/meridian/root.js",
    symbolNames: [["zephyrQuill", 4, true]],
    imports: ["fx_hop_mid", "fx_ghost_id"],
  },
  {
    id: "fx_hop_mid",
    path: "src/meridian/mid.js",
    symbolNames: [],
    imports: ["fx_hop_leaf"],
  },
  {
    id: "fx_hop_leaf",
    path: "src/meridian/leaf.js",
    symbolNames: [],
    imports: ["fx_hop_tip"],
  },
  {
    id: "fx_hop_tip",
    path: "src/meridian/tip.js",
    symbolNames: [],
    imports: [],
  },
  // Cycle with duplicate edge rows: alpha -> bravo (twice) -> alpha.
  {
    id: "fx_cycle_alpha",
    path: "src/cycle/alpha.js",
    symbolNames: [["alphaAnchor", 4, true]],
    imports: ["fx_cycle_bravo", "fx_cycle_bravo"],
  },
  {
    id: "fx_cycle_bravo",
    path: "src/cycle/bravo.js",
    symbolNames: [["bravoMark", 4, true]],
    imports: ["fx_cycle_alpha"],
  },
  // Derivation group: source has NO indexed edge to its neighbours — they
  // are only reachable through relative imports inside its inspected text.
  // Directory "glean" avoids the "derive(sink)" query token entirely, so
  // path seeding cannot pre-empt derivation.
  {
    id: "fx_derive_source",
    path: "src/glean/source.js",
    symbolNames: [["deriveSink", 4, true]],
    imports: [],
    text: DERIVE_SOURCE_TEXT,
  },
  { id: "fx_derive_target", path: "src/glean/target.js", symbolNames: [["targetUtil", 4, true]], imports: [] },
  { id: "fx_derive_lazy", path: "src/glean/lazy.js", symbolNames: [["lazyLoad", 4, true]], imports: [] },
  { id: "fx_derive_shared", path: "src/glean/shared.js", symbolNames: [["sharedCost", 4, true]], imports: [] },
  // CI-4 probe for derived references: source.js imports "./quarantined.js"
  // (see DERIVE_SOURCE_TEXT), so derivation resolves into a excluded row.
  { id: "fx_derive_quar", path: "src/glean/quarantined.js", symbolNames: [], imports: [], status: "excluded" },
  // CI-4 candidate-filter probes. All carry hashes, line counts, symbols and
  // (for the excluded/legacy pair) incoming indexed edges from the stored app
  // file — nothing but content_status distinguishes them from retrievable
  // files. An absent row must stay eligible; the other two must not exist
  // for retrieval at all.
  {
    id: "fx_status_quar",
    path: "src/quarantine/excludedFlow.js",
    symbolNames: [["excludedFlowProbe", 4, true]],
    imports: [],
    status: "excluded",
  },
  {
    id: "fx_status_legacy",
    path: "src/quarantine/legacyProbe.js",
    symbolNames: [["legacyFlowProbe", 4, true]],
    imports: [],
    status: "legacy_unclassified",
  },
  {
    id: "fx_status_absent",
    path: "src/quarantine/absentFlow.js",
    symbolNames: [["absentFlowProbe", 4, true]],
    imports: [],
    status: "absent",
  },
  // Foreign-organization file: same db, other analysis id. Its edges and
  // rows must be invisible to retrieval filtered by analysis_id. The hop
  // chain registers a foreign edge src/hop/root.js -> leak.js below.
  {
    id: "fx_foreign_leak",
    path: "src/foreign/leak.js",
    symbolNames: [["leakProbe", 4, true]],
    imports: [],
    analysisId: "other_analysis",
  },
];

const fxTexts = new Map<string, string>();
const fxHashes = new Map<string, string>();
class FixtureDb {
  symbols = fixtureFiles.flatMap((f) =>
    f.symbolNames.map(([name, line, exported]) => ({
      file_id: f.id,
      name,
      kind: name[0] === name[0]!.toUpperCase() ? "class" : "function",
      line,
      exported: exported ?? false,
      analysis_id: f.analysisId ?? "fx_analysis",
    })),
  );

  edges = [
    ...fixtureFiles.flatMap((f) =>
      f.imports.map((target) => ({
        source_file_id: f.id,
        target_file_id: target,
        kind: "import",
        analysis_id: f.analysisId ?? "fx_analysis",
      })),
    ),
    // Same file pair, wrong analysis: must be invisible to fx_analysis
    // retrieval even though it touches a local file id.
    {
      source_file_id: "fx_hop_root",
      target_file_id: "fx_foreign_leak",
      kind: "import",
      analysis_id: "other_analysis",
    },
  ];

  routes = [
    { file_id: "fx_auth_routes", method: "POST", path: "/auth/login", line: 8 },
  ];

  files = fixtureFiles.map((f) => {
    // 70 lines of filler content ending in a final newline.
    const text = f.text ?? Array.from({ length: 70 }, (_, i) => `// line ${i + 1} of ${f.path}\n`).join("");
    const hash = createHash("sha256").update(text).digest("hex");
    fxTexts.set(f.id, text);
    fxHashes.set(f.id, hash);
    return {
      id: f.id,
      path: f.path,
      hash,
      lines: 70,
      content_status: f.status ?? "stored",
      analysis_id: f.analysisId ?? "fx_analysis",
      file_roles: f.role ? [{ role: f.role, source: "convention" }] : [{ role: undefined, source: "convention" }],
    };
  });

  from(table: string) {
    if (table === "files") {
      return {
        select: () => ({
          eq: (col: string, value: string) => ({
            is: () =>
              Promise.resolve({
                data: col === "analysis_id" ? this.files.filter((f) => f.analysis_id === value) : this.files,
                error: null,
              }),
            maybeSingle: async () => ({
              data: this.files.find((f) => f.id === value) ?? null,
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === "symbols") {
      return {
        select: () => ({
          eq: (col: string, value: string) =>
            Promise.resolve({
              data: col === "analysis_id" ? this.symbols.filter((s) => s.analysis_id === value) : this.symbols,
              error: null,
            }),
        }),
      };
    }
    if (table === "routes") {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: this.routes, error: null }),
        }),
      };
    }
    if (table === "edges") {
      return {
        select: () => ({
          eq: (col: string, value: string) => {
            // analysis filtering happens here, exactly where the real
            // PostgREST query chain applies it: only rows visible to this
            // analysis can ever enter the `.or(...)` neighbor lookup.
            const visible = col === "analysis_id" ? this.edges.filter((e) => e.analysis_id === value) : this.edges;
            return {
              or: (orFilter: string) => {
                // Emulate PostgREST's `.or("source_file_id.in.(a,b),target_file_id.in.(a,b)")`
                // — only edges actually touching one of the listed ids come back.
                const seedIds = new Set<string>();
                for (const m of orFilter.matchAll(/in\.\(([^)]*)\)/g)) {
                  for (const id of (m[1] ?? "").split(",")) {
                    if (id.trim()) seedIds.add(id.trim());
                  }
                }
                const filtered = visible.filter(
                  (edge) => seedIds.has(edge.source_file_id) || seedIds.has(edge.target_file_id),
                );
                return Promise.resolve({ data: filtered, error: null });
              },
            };
          },
        }),
      };
    }
    if (table === "file_contents") {
      return {
        select: () => ({
          eq: (col: string, value: string) => ({
            eq: (_col2: string, hash: string) => ({
              maybeSingle: async () => {
                void col;
                const f = this.files.find((x) => x.hash === hash);
                if (!f) return { data: null, error: null };
                const text = fxTexts.get(f.id) ?? "";
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
    if (table === "manifests" || table === "dependencies" || table === "config_references" || table === "entry_points") {
      // This fixture repository declares no packaging metadata, which is the
      // common case for an analysis stored before Phase 4. Returning an empty
      // set is what the real client does for such an analysis, and it
      // exercises the path where the packaging blocks are simply absent.
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      };
    }
    throw new Error(`Unexpected table ${table}`);
  }
}

const UNRELATED = new Set(["src/server.js", "src/logger.js"]);
const fixtureDb = new FixtureDb();
async function fixtureAsk(question: string): Promise<ReturnType<typeof retrieveGroundedContext>> {
  return retrieveGroundedContext(fixtureDb as unknown as Db, "fx_analysis", question);
}

// The reported failure: authentication questions reach the whole flow.
const fxAuth = await fixtureAsk("How does authentication work?");
{
  const paths = new Set(fxAuth.files.map((f) => f.path));
  const needed = [
    ["routes", "src/routes/auth.routes.js"],
    ["controller", "src/controllers/authController.js"],
    ["middleware", "src/middlewares/authMiddleware.js"],
    ["jwt util", "src/utils/jwt.js"],
    ["user model", "src/models/userModel.js"],
  ] as const;
  const missing = needed.filter(([, p]) => !paths.has(p));
  if (missing.length === 0) {
    pass("auth question discovers routes, controller, middleware, jwt util and user model");
  } else {
    fail(`auth question missed: ${missing.map(([l]) => l).join(", ")}`);
  }
  const passwordReachable = paths.has("src/utils/bcrypt.js");
  if (passwordReachable) {
    pass("password hashing reachable through the auth cluster or graph expansion");
  } else {
    fail("password hashing not discovered for the auth question");
  }
  if (![...paths].some((p) => UNRELATED.has(p))) {
    pass("unrelated setup files do not appear for the auth question");
  } else {
    fail(`unrelated setup files leaked in: ${[...paths].filter((p) => UNRELATED.has(p)).join(", ")}`);
  }
  // bcrypt's names never echo "authentication": discovery must come from the
  // dependency graph (the auth controller imports it).
  const bcryptWin = fxAuth.windows.find((w) => w.path === "src/utils/bcrypt.js");
  if (bcryptWin && bcryptWin.reason.includes("1-hop dependency")) {
    pass("graph expansion connects bcrypt password hashing to the auth flow");
  } else {
    fail(`bcrypt discovered outside graph expansion or not at all: ${JSON.stringify(bcryptWin)}`);
  }
  if (fxAuth.files.length <= DEFAULT_BUDGET.maxFiles && fxAuth.totalCharacters <= 24000) {
    pass(`retrieval bounded: ${fxAuth.files.length} files, ${fxAuth.totalCharacters} chars, ${Math.round(fxAuth.totalCharacters / Math.max(1, fxAuth.windows.length))} chars/window`);
  } else {
    fail(`budget breach: ${fxAuth.files.length} files, ${fxAuth.totalCharacters} chars`);
  }
}

// Errors category.
const fxErrors = await fixtureAsk("How are errors handled?");
{
  const paths = new Set(fxErrors.files.map((f) => f.path));
  if (paths.has("src/middlewares/errorMiddleware.js") && paths.has("src/utils/AppError.js")) {
    pass("errors question finds error middleware and the error factory");
  } else {
    fail(`errors question missed: ${[...paths].join(", ")}`);
  }
}

// Upload category.
const fxUpload = await fixtureAsk("How does file upload work?");
{
  const paths = new Set(fxUpload.files.map((f) => f.path));
  if (paths.has("src/controllers/uploadController.js") && paths.has("src/middlewares/uploadMiddleware.js") && paths.has("src/services/storage.js")) {
    pass("upload question finds upload controller, middleware and storage service");
  } else {
    fail(`upload question missed: ${[...paths].join(", ")}`);
  }
}

// Database category.
const fxDatabase = await fixtureAsk("How does the database work?");
{
  const paths = new Set(fxDatabase.files.map((f) => f.path));
  if (paths.has("src/database/connectDB.js") && paths.has("src/models/userModel.js")) {
    pass("database question finds connection bootstrap and the data models");
  } else {
    fail(`database question missed: ${[...paths].join(", ")}`);
  }
}

// SDK category: must reach both sides — the backend route that claims the
// name, and the client package island that carries the public interface.
const fxSdk = await fixtureAsk("How does the SDK work, and how does a developer use the SDK?");
{
  const paths = new Set(fxSdk.files.map((f) => f.path));
  if (paths.has("backend/src/routes/sdk.routes.js") && paths.has("packages/src/client/api.ts") && paths.has("packages/src/index.ts")) {
    pass("sdk question reaches the named backend route and the client package island");
  } else {
    fail(`sdk question missed: ${[...paths].join(", ")}`);
  }
  if (![...paths].some((p) => UNRELATED.has(p))) {
    pass("unrelated setup files do not appear for the sdk question");
  } else {
    fail(`unrelated setup files leaked in: ${[...paths].filter((p) => UNRELATED.has(p)).join(", ")}`);
  }
}

// Phase 3 — planner wiring: generic verbs, cross-strategy corroboration,
// plan attachment, first-window relevance, unrelated-question behaviour.
{
  const generic = await fixtureAsk("How do you implement and handle errors properly in this project?");
  const first = generic.files[0]?.path ?? "";
  if (first.includes("error")) {
    pass(`generic-verb question ranks the concept file first (${first})`);
  } else {
    fail(`generic-verb question ranked "${first}" first — concept evidence did not outrank verb evidence`);
  }
  const errPaths = new Set(generic.files.map((f) => f.path));
  const errNeeded = errPaths.has("src/middlewares/errorMiddleware.js") || errPaths.has("src/utils/AppError.js");
  if (errNeeded) {
    pass("generic-verb question still satisfies error-handling category coverage");
  } else {
    fail(`generic-verb question missed both error files: ${[...errPaths].join(", ")}`);
  }
  const serverFirst = generic.files.slice(0, 3).map((f) => f.path);
  if (!serverFirst.some((p) => UNRELATED.has(p))) {
    pass("generic setup files stay out of the top 3 for a generic-verb question");
  } else {
    fail(`setup files in top 3: ${serverFirst.join(", ")}`);
  }

  const withVerb = await fixtureAsk("How do you handle authentication in this project?");
  const verbPaths = withVerb.files.map((f) => f.path);
  const authNeeded = ["src/controllers/authController.js", "src/middlewares/authMiddleware.js"];
  if (authNeeded.every((p) => verbPaths.includes(p))) {
    pass("generic verb in the question does not displace authentication concept files");
  } else {
    fail(`handle+auth missed core files: ${verbPaths.join(", ")}`);
  }

  const unrelated = await fixtureAsk("What color is the sky?");
  if (unrelated.insufficientEvidence && unrelated.windows.length === 0 && unrelated.files.length === 0) {
    pass("unrelated question short-circuits to insufficient evidence");
  } else {
    fail(`unrelated question retrieved ${unrelated.files.length} files: ${unrelated.files.map((f) => f.path).join(", ")}`);
  }

  if (fxAuth.plan.intent === "explain-subsystem" && fxAuth.plan.concepts[0]?.token === "authentication") {
    pass("retrieval result carries the explainable planner plan");
  } else {
    fail(`plan not attached correctly: ${fxAuth.plan.intent}, ${JSON.stringify(fxAuth.plan.concepts.map((c) => c.token))}`);
  }

  const multiStrategy = mergeCandidateWindows([
    { fileId: "s1", path: "src/service.ts", contentHash: "h", totalLines: 100, startLine: 10, endLine: 40, score: 95, reason: "symbol hit", strategies: ["symbol"] },
    { fileId: "s1", path: "src/service.ts", contentHash: "h", totalLines: 100, startLine: 20, endLine: 45, score: 80, reason: "path hit", strategies: ["path"] },
  ]);
  if (multiStrategy.length === 1 && multiStrategy[0].score === 99 && multiStrategy[0].strategies?.length === 2) {
    pass("merged window corroborates two strategies (+4: 95 -> 99)");
  } else {
    fail(`strategy corroboration wrong: score=${multiStrategy[0]?.score}, strategies=${JSON.stringify(multiStrategy[0]?.strategies)}`);
  }
  const singleStrategy = mergeCandidateWindows([
    { fileId: "s2", path: "src/other.ts", contentHash: "h", totalLines: 100, startLine: 10, endLine: 40, score: 95, reason: "symbol hit", strategies: ["symbol"] },
    { fileId: "s2", path: "src/other.ts", contentHash: "h", totalLines: 100, startLine: 20, endLine: 45, score: 80, reason: "symbol hit", strategies: ["symbol"] },
  ]);
  if (singleStrategy.length === 1 && singleStrategy[0].score === 95 && singleStrategy[0].strategies?.length === 1) {
    pass("single-strategy merge keeps the plain max score (no bonus)");
  } else {
    fail(`single-strategy merge wrong: score=${singleStrategy[0]?.score}, strategies=${JSON.stringify(singleStrategy[0]?.strategies)}`);
  }
}

// Phase 4 — relationship expansion: bounded indexed-edge traversal, capped
// transitivity, derived-provenance honesty, invalid targets, cycles,
// organization isolation, budget caps.
{
  // Unit: import-family parsing (provenance-agnostic, textual only).
  const refs = deriveReferences(
    [
      "import { a } from \"./a.js\";",
      "import x from \"../parent/b.js\";",
      "export { c } from \"./c.js\";",
      "const d = require(\"./d.js\");",
      "await import(\"./e.js\");",
      "const again = import(\"./e.js\");",
      "import react from \"react\";",
      "import loop from \"./a.js\";",
    ].join("\n"),
  );
  const specOf = (s: string) => refs.filter((r) => r.specifier === s).map((r) => r.kind);
  if (refs.length === 5) {
    pass(
      "deriveReferences parses import/require/dynamic/re-export relative specifiers with dedupe " +
        `(${refs.map((r) => `${r.specifier} as ${r.kind}`).join("; ")})`,
    );
  } else {
    fail(`deriveReferences wrong count/kinds: ${JSON.stringify(refs)}`);
  }
  if (specOf("react").length === 0 && specOf("./a.js").length === 1 && specOf("./e.js").length === 1) {
    pass("bare package specifiers are never derived; duplicate kinds collapse");
  } else {
    fail(`specifier filtering wrong: ${JSON.stringify(refs)}`);
  }

  // Unit: relative specifier resolution candidates.
  const resolved = specifierCandidates("../parent/b.js", "src/deep/inner/file.js");
  if (resolved[0] === "src/deep/parent/b.js" && resolved.some((p) => p === "src/deep/parent/b.js/index.ts")) {
    pass("specifier candidates normalize dot-dot traversal and offer extension/index fallbacks");
  } else {
    fail(`specifier candidates wrong: ${JSON.stringify(resolved)}`);
  }

  // Existing import-edge expansion + transitive limit + invalid targets.
  const fxHop = await fixtureAsk("How does zephyrQuill work?");
  {
    const paths = new Set(fxHop.files.map((f) => f.path));
    const hopWin = fxHop.windows.find((w) => w.path === "src/meridian/mid.js");
    const leafWin = fxHop.windows.find((w) => w.path === "src/meridian/leaf.js");
    if (paths.has("src/meridian/root.js") && paths.has("src/meridian/mid.js")) {
      pass("existing indexed import edge expands a 1-hop neighbour (mid.js)");
    } else {
      fail(`1-hop expansion broken: ${[...paths].join(", ")}`);
    }
    if (leafWin && hopWin) {
      pass("bounded transitive expansion reaches the 2-hop neighbour (leaf.js)");
    } else {
      fail(`transitive expansion missing: ${[...paths].join(", ")}`);
    }
    if (leafWin?.provenance === "indexed" && hopWin?.provenance === "indexed") {
      pass("edge-expanded windows carry provenance \"indexed\"");
    } else {
      fail(`provenance not indexed: ${hopWin?.provenance} / ${leafWin?.provenance}`);
    }
    const transitiveReason = leafWin?.reason ?? "";
    if (transitiveReason.includes("2-hop") && transitiveReason.includes("indexed import edge")) {
      pass("transitive window names its hop, edge kind and indexed provenance in the reason");
    } else {
      fail(`transitive reason wording wrong: "${transitiveReason}"`);
    }
    const ghostPath = "src/meridian/missing.js";
    if (!paths.has("src/meridian/tip.js") && ![...paths].some((p) => p === ghostPath)) {
      pass("expansion stops at the hop bound; missing edge targets produce no window");
    } else {
      fail(`3-hop tip.js or ghost target leaked: ${[...paths].join(", ")}`);
    }
    if (paths.has("src/meridian/root.js") && fxHop.windows.filter((w) => w.path === "src/meridian/root.js").length === 1) {
      pass("seed file is not duplicated by cycle-back expansion");
    } else {
      const count = fxHop.windows.filter((w) => w.path === "src/meridian/root.js").length;
      fail(`root windows duplicated: ${count}`);
    }
  }

  // Cycles and duplicate edge rows.
  const fxCycle = await fixtureAsk("How does alphaAnchor work?");
  {
    const paths = new Set(fxCycle.files.map((f) => f.path));
    const alphaWins = fxCycle.windows.filter((w) => w.path === "src/cycle/alpha.js");
    const bravoWins = fxCycle.windows.filter((w) => w.path === "src/cycle/bravo.js");
    if (paths.has("src/cycle/alpha.js") && paths.has("src/cycle/bravo.js") && alphaWins.length === 1 && bravoWins.length === 1) {
      pass("cycle edges and duplicate edge rows produce exactly one window per file");
    } else {
      fail(`cycle/dedupe wrong: paths=${[...paths].join(", ")} alpha=${alphaWins.length} bravo=${bravoWins.length}`);
    }
  }

  // Derived provenance: neighbours reachable ONLY through imports inside
  // inspected hash-verified source, never claiming indexed status.
  const fxDerived = await fixtureAsk("How does deriveSink work?");
  {
    const paths = new Set(fxDerived.files.map((f) => f.path));
    const derivedTargets = ["src/glean/target.js", "src/glean/lazy.js", "src/glean/shared.js"];
    if (derivedTargets.every((p) => paths.has(p))) {
      pass("derived import references pull in files with no indexed edge (target/lazy/shared)");
    } else {
      fail(`derived targets missing: ${[...paths].join(", ")}`);
    }
    const targetWins = fxDerived.windows.filter((w) => w.path === "src/glean/target.js");
    if (targetWins.length === 1) {
      pass("derived references to the same target (import + dynamic import) deduplicate to one window");
    } else {
      fail(`target windows not deduped: ${targetWins.length}`);
    }
    const withBadProvenance = fxDerived.windows.filter(
      (w) =>
        derivedTargets.includes(w.path) &&
        (w.provenance !== "derived" || !w.reason.includes("derived, not an indexed edge") || /\(indexed [a-z-]+ edge\)/.test(w.reason)),
    );
    if (withBadProvenance.length === 0) {
      pass("derived windows are labelled provenance \"derived\" and state \"derived, not an indexed edge\"");
    } else {
      fail(`derived windows mislabelled: ${withBadProvenance.map((w) => `${w.path} ${w.provenance} :: ${w.reason}`).join(" | ")}`);
    }
    if (!paths.has("src/glean/missing/ghost.js") && !paths.has("react") && !paths.has("src/foreign/leak.js")) {
      pass("missing specifier targets and bare packages produce nothing derived");
    } else {
      fail(`phantom derived targets leaked: ${[...paths].join(", ")}`);
    }
    if (fxDerived.files.length <= 16 && fxDerived.totalCharacters <= 28000) {
      pass(`derived windows respect the budget ceiling (${fxDerived.files.length} files, ${fxDerived.totalCharacters} chars)`);
    } else {
      fail(`budget breached: ${fxDerived.files.length} files, ${fxDerived.totalCharacters} chars`);
    }
  }

  // Organization isolation: the fixture db bundles a foreign-analysis edge
  // (src/meridian/root.js -> src/foreign/leak.js) and a foreign file;
  // retrieval filters by analysis_id exactly where the real query chain
  // does.
  {
    const edgesEmulator = fixtureDb.from("edges") as unknown as {
      select: () => {
        eq: (
          col: string,
          value: string,
        ) => {
          or: (filterArg: string) => Promise<{ data: { target_file_id: string }[] | null; error: unknown }>;
        };
      };
    };
    const foreignRows = await edgesEmulator
      .select()
      .eq("analysis_id", "other_analysis")
      .or("source_file_id.in.(fx_hop_root)");
    if (foreignRows.data?.length === 1 && foreignRows.data[0].target_file_id === "fx_foreign_leak") {
      pass("isolation probe is real: the foreign edge exists under other_analysis");
    } else {
      fail(`isolation probe broken: ${JSON.stringify(foreignRows.data)}`);
    }
    const leakQueries = [fxHop, fxCycle, fxDerived];
    if (leakQueries.every((r) => !r.files.some((f) => f.path === "src/foreign/leak.js"))) {
      pass("foreign-analysis edges and files never leak into another organization's retrieval");
    } else {
      fail(`foreign leak reached retrieval: ${[...leakQueries.flatMap((r) => r.files.map((f) => f.path))].join(", ")}`);
    }
  }
}

// CI-4 — quarantined content can never become candidates or windows: rows
// with content_status "excluded" or "legacy_unclassified" are invisible to
// retrieval even with hashes, lines, symbols and incoming edges, including
// through graph expansion and derived references. "absent" rows remain
// ordinary candidates (they may be backfilled and read).
console.log("");
console.log("=== 5. CI-4 quarantined content never becomes evidence ===");

const CRS = ["src/quarantine/excludedFlow.js", "src/quarantine/legacyProbe.js", "src/glean/quarantined.js"];
{
  // Direct symbol hits: the symbols table holds rows for the excluded and
  // legacy files, but their rows are filtered out before seeding.
  const sevAsk = await fixtureAsk("How does excludedFlowProbe work?");
  if (!sevAsk.files.some((f) => CRS.includes(f.path)) && !sevAsk.windows.some((w) => CRS.includes(w.path))) {
    pass("excluded and legacy-unclassified symbol hits are not candidates or windows");
  } else {
    fail(`quarantined symbol hit leaked: ${sevAsk.files.map((f) => f.path).join(", ")}`);
  }
  const legAsk = await fixtureAsk("How does legacyFlowProbe work?");
  if (!legAsk.files.some((f) => CRS.includes(f.path)) && !legAsk.windows.some((w) => CRS.includes(w.path))) {
    pass("the legacy-unclassified probe question returns no quarantined evidence");
  } else {
    fail(`legacy probe leaked: ${legAsk.files.map((f) => f.path).join(", ")}`);
  }

  // Graph edges: the stored app file indexes edges into the excluded and
  // legacy files; expansion resolves targets against the filtered map.
  const appAsk = await fixtureAsk("How does createApp work?");
  if (appAsk.windows.length > 0 && !appAsk.files.some((f) => CRS.includes(f.path))) {
    pass("graph edges cannot reintroduce excluded or legacy-unclassified files");
  } else {
    fail(`edge expansion leaked quarantined files: ${appAsk.files.map((f) => f.path).join(", ")}`);
  }

  // Derived references: the inspected derivative source imports
  // "./quarantined.js"; its resolution finds no candidate in the map.
  const derivedAsk = await fixtureAsk("How does deriveSink work?");
  if (derivedAsk.files.some((f) => f.path === "src/glean/target.js") && !derivedAsk.files.some((f) => CRS.includes(f.path))) {
    pass("derived references cannot reintroduce excluded files");
  } else {
    fail(`derived expansion leaked: ${derivedAsk.files.map((f) => f.path).join(", ")}`);
  }

  // Absent stays eligible: the row is a fresh candidate with a real read.
  // The fixture's absent file has verified content under its own hash, so the
  // window read only needs the row's metadata flip to succeed: a stub writer
  // reports the flip (done), and fetching from GitHub would be a bug.
  const absentBackfillDeps: BackfillDeps = {
    writer: {
      from: () => {
        const chain = {
          eq: () => chain,
          select: () => Promise.resolve({ data: [{ id: "fx_status_absent" }], error: null }),
        };
        return { update: () => chain };
      },
    },
    fetchFile: () => {
      throw new Error("the fixture never backfills from GitHub");
    },
    cache: null,
  } as unknown as NonNullable<Parameters<typeof retrieveGroundedContext>[5]>;
  const absentAsk = await retrieveGroundedContext(
    fixtureDb as unknown as Db,
    "fx_analysis",
    "How does absentFlowProbe work?",
    {},
    null,
    absentBackfillDeps,
  );
  if (absentAsk.windows.find((w) => w.path === "src/quarantine/absentFlow.js")) {
    pass("absent files remain retrieval candidates with readable windows");
  } else {
    fail(`absent candidate missing: ${absentAsk.files.map((f) => f.path).join(", ")}`);
  }
}

// --- Section 6: Role taxonomy consistency (Phase 1C F1/F2) ---------------
console.log("");
console.log("=== 6. Role taxonomy hints: seeding, entry routing, CLI decay ===");

// A pristine single-analysis database per scenario, mirroring the section 3
// mock: enough tables for a complete retrieveGroundedContext pass.
type RoleSpec = {
  id: string;
  path: string;
  role?: string;
  symbols?: [name: string, line: number, exported?: boolean][];
};

class RoleFixtureDb {
  files: {
    id: string;
    path: string;
    hash: string;
    lines: number;
    content_status: string;
    analysis_id: string;
    file_roles: { role: string; source: string }[];
  }[];
  symbols: { file_id: string; name: string; kind: string; line: number; exported: boolean }[];
  routes: { file_id: string; method: string; path: string; line: number }[] = [];
  edges: { source_file_id: string; target_file_id: string; kind: string }[] = [];
  fileTexts = new Map<string, string>();

  constructor(specs: RoleSpec[]) {
    this.files = specs.map((f) => {
      const text = Array.from({ length: 70 }, (_, i) => `// line ${i + 1} of ${f.path}\n`).join("");
      const hash = createHash("sha256").update(text).digest("hex");
      this.fileTexts.set(f.id, text);
      return {
        id: f.id,
        path: f.path,
        hash,
        lines: 70,
        content_status: "stored",
        analysis_id: "role_analysis",
        file_roles: f.role ? [{ role: f.role, source: "convention" }] : [],
      };
    });
    this.symbols = specs.flatMap((f) =>
      (f.symbols ?? []).map(([name, line, exported]) => ({
        file_id: f.id,
        name,
        kind: name[0] === name[0]!.toUpperCase() ? "class" : "function",
        line,
        exported: exported ?? false,
      })),
    );
  }

  from(table: string) {
    if (table === "files") {
      return {
        select: () => ({
          eq: (_f: string, val: string) => ({
            is: () => Promise.resolve({ data: this.files.filter((f) => f.analysis_id === val), error: null }),
            maybeSingle: async () => {
              const file = this.files.find((f) => f.id === val);
              if (!file) return { data: null, error: null };
              return {
                data: {
                  ...file,
                  organization_id: "org_test",
                  analysis: { commit_sha: "sha1", project: { repo_owner: "o", repo_name: "r" } },
                },
                error: null,
              };
            },
          }),
        }),
      };
    }
    if (table === "symbols") {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: this.symbols, error: null }),
        }),
      };
    }
    if (table === "routes") {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: this.routes, error: null }),
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
              const filtered = this.edges.filter(
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
            eq: (_f2: string, hash: string) => ({
              maybeSingle: async () => {
                const f = this.files.find((file) => file.hash === hash);
                if (!f) return { data: null, error: null };
                const text = this.fileTexts.get(f.id) ?? "";
                const hex = Buffer.from(text, "utf8").toString("hex");
                return {
                  data: {
                    payload: `\\x${hex}`,
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
    if (table === "manifests" || table === "dependencies" || table === "config_references" || table === "entry_points") {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      };
    }
    throw new Error(`Unexpected table ${table}`);
  }
}

async function roleAsk(db: RoleFixtureDb, question: string) {
  return retrieveGroundedContext(db as unknown as Db, "role_analysis", question);
}

// F1: a repository-role file is role-seeded even though nothing in its path
// or symbol names echoes the question's wording. The anchor file carries the
// query's concept on its path so role seeding has a direct seed to ride on.
const repoDb = new RoleFixtureDb([
  { id: "repo_anchor", path: "src/users/userService.ts", role: "service", symbols: [["saveUser", 6, true]] },
  { id: "repo_target", path: "src/access/keeper.ts", role: "repository", symbols: [["AccountKeeper", 8, true]] },
]);
const repoAsk = await roleAsk(repoDb, "Where does the user repository persist data?");
{
  const win = repoAsk.windows.find((w) => w.path === "src/access/keeper.ts");
  if (win && win.reason.includes(`holds the "repository" role`) && repoAsk.files.some((f) => f.path === "src/access/keeper.ts")) {
    pass("repository-role file is found via role seeding with the recorded reason");
  } else {
    fail(`repository role seeding failed: ${JSON.stringify(repoAsk.windows.map((w) => ({ path: w.path, reason: w.reason })))}`);
  }
  if (win && win.score === 55) {
    pass("role seeding keeps the existing score (55), no inflation");
  } else if (win) {
    fail(`role seed score changed: ${win.score}`);
  }
}

// F1: an api-endpoint-role file is role-seeded for endpoint/api wording. Both
// hint words match the same single hint, so the file must appear exactly once
// at the role score — multiple matching words must not duplicate or stack.
const apiDb = new RoleFixtureDb([
  { id: "api_anchor", path: "src/api/shipping.ts", role: "controller", symbols: [["shipParcel", 6, true]] },
  { id: "api_target", path: "src/transport/lorry.ts", role: "api-endpoint", symbols: [["LorryService", 8, true]] },
]);
const apiAsk = await roleAsk(apiDb, "Which api endpoint ships a parcel?");
{
  const roleWins = apiAsk.windows.filter(
    (w) => w.path === "src/transport/lorry.ts" && w.reason.includes(`holds the "api-endpoint" role`),
  );
  if (roleWins.length === 1 && roleWins[0]!.score === 55) {
    pass("api-endpoint file seeds exactly once at score 55 across both hint words");
  } else {
    fail(`api-endpoint seeding wrong: ${JSON.stringify(apiAsk.windows.filter((w) => w.path === "src/transport/lorry.ts"))}`);
  }
}

// F1: the hook role carries the state-layer wording ("state"/"store") that the
// dead "store" hint used to claim; a persisted legacy "store" role must NOT be
// seeded by any hint (it is not producible and the dead hint was removed).
const hookDb = new RoleFixtureDb([
  { id: "hook_anchor", path: "src/session/state.ts" },
  { id: "hook_target", path: "src/session/providers.ts", role: "hook", symbols: [["hydrateProviders", 8, true]] },
  { id: "legacy_store", path: "src/legacy/bin.ts", role: "store" },
]);
const hookAsk = await roleAsk(hookDb, "How does the live state work?");
{
  const win = hookAsk.windows.find((w) => w.path === "src/session/providers.ts");
  if (win && win.reason.includes(`holds the "hook" role`)) {
    pass("hook role seeds for state-layer wording");
  } else {
    fail(`hook role seeding failed: ${JSON.stringify(hookAsk.windows.map((w) => ({ path: w.path, reason: w.reason })))}`);
  }
  const storeWin = hookAsk.windows.find((w) => w.reason.includes(`holds the "store" role`));
  if (!storeWin && !hookAsk.windows.some((w) => w.path === "src/legacy/bin.ts")) {
    pass("the dead \"store\" hint is removed: no legacy store-role seed");
  } else {
    fail(`dead store hint fired: ${storeWin ? storeWin.reason : "window present"}`);
  }
}

// F1: the component role seeds for component wording.
const compDb = new RoleFixtureDb([
  { id: "comp_anchor", path: "src/widgets/meters.tsx" },
  { id: "comp_target", path: "src/widgets/gauge.tsx", role: "component", symbols: [["GaugeView", 8, true]] },
]);
const compAsk = await roleAsk(compDb, "Which component draws the meter?");
{
  const win = compAsk.windows.find((w) => w.path === "src/widgets/gauge.tsx");
  if (win && win.reason.includes(`holds the "component" role`)) {
    pass("component role seeds for component wording");
  } else {
    fail(`component role seeding failed: ${JSON.stringify(compAsk.windows.map((w) => ({ path: w.path, reason: w.reason })))}`);
  }
}

// F2: broad/onboarding queries seed the taxonomy's routable surfaces as entry
// points. Each file's path and filename deliberately avoid the entry-point
// patterns and the depth cutoff so the role branch is the only route in.
const entryDb = new RoleFixtureDb([
  { id: "entry_modern", path: "app/dashboard/Overview.tsx", role: "page-route" },
  { id: "entry_router", path: "routes/v1/Routes.js", role: "router" },
  { id: "entry_legacy", path: "routes/legacy/Legacy.js", role: "route" },
]);
const entryAsk = await roleAsk(entryDb, "Give me a repository walkthrough");
{
  const modern = entryAsk.windows.find((w) => w.path === "app/dashboard/Overview.tsx");
  if (modern && modern.reason.includes(`core role "page-route"`) && modern.score === 28) {
    pass("page-route file enters via the broad-query role seed (modern taxonomy)");
  } else {
    fail(`page-route entry seeding failed: ${JSON.stringify(entryAsk.windows.map((w) => ({ path: w.path, reason: w.reason })))}`);
  }
  const router = entryAsk.windows.find((w) => w.path === "routes/v1/Routes.js");
  if (router && router.reason.includes(`core role "router"`)) {
    pass("router file enters via the broad-query role seed");
  } else {
    fail("router entry seeding failed");
  }
  // Legacy compatibility: "route" kept for stored analyses under the old
  // taxonomy (and "entry" the same way — exercised by the role name below).
  const legacy = entryAsk.windows.find((w) => w.path === "routes/legacy/Legacy.js");
  if (legacy && legacy.reason.includes(`core role "route"`)) {
    pass("legacy route role still enters (backward compatibility)");
  } else {
    fail("legacy route role entry seeding failed");
  }
}

// F2: for CLI-execution intent, hook/component/layout files are demoted like
// frontend UI even when they live outside conventional UI directories; the
// persisted legacy "frontend" role keeps the same behavior it always had.
const cliDb = new RoleFixtureDb([
  { id: "cli_hook", path: "src/features/useSubcommandBus.ts", role: "hook", symbols: [["useSubcommandDispatch", 4, true]] },
  { id: "cli_component", path: "src/features/SubcommandPanel.tsx", role: "component", symbols: [["SubcommandPanel", 4, true]] },
  { id: "cli_legacy_fe", path: "src/legacy/FrontendThing.ts", role: "frontend", symbols: [["FrontendSubcommand", 4, true]] },
  { id: "cli_real", path: "src/cli/dispatchCli.ts", role: "cli", symbols: [["dispatchSubcommand", 4, true]] },
]);
const cliAsk = await roleAsk(cliDb, "How does the CLI dispatch subcommands?");
{
  const demoted = !cliAsk.windows.some((w) => w.path === "src/features/useSubcommandBus.ts")
    && !cliAsk.windows.some((w) => w.path === "src/features/SubcommandPanel.tsx")
    && !cliAsk.windows.some((w) => w.path === "src/legacy/FrontendThing.ts");
  if (demoted) {
    pass("hook and component (and legacy-frontend) files decay for CLI-execution intent outside conventional UI dirs");
  } else {
    fail(`CLI decay failed: ${JSON.stringify(cliAsk.windows.map((w) => w.path))}`);
  }
  const real = cliAsk.windows.find((w) => w.path === "src/cli/dispatchCli.ts");
  if (real && real.score > 50) {
    pass("the real CLI file stays strongly seeded for CLI-execution intent");
  } else {
    fail(`CLI positive control failed: ${JSON.stringify(cliAsk.windows.find((w) => w.path === "src/cli/dispatchCli.ts"))}`);
  }
}

// --- Concept-expansion unit checks: plain vocabulary, no repo knowledge. ---
{
  const t = tokenVariants("authentication");
  const auth = t.map((v) => v.text);
  if (auth.includes("auth") && auth.includes("login") && auth.includes("jwt") && t[0]!.kind === "original") {
    pass(`"authentication" expands to auth/login/jwt with the original wording first (${auth.length} variants)`);
  } else {
    fail(`bad auth variants: ${JSON.stringify(t)}`);
  }
  if (identifierSubtokens("verifyJWT").join("/") === "verify/jwt" && identifierSubtokens("AuthService").join("/") === "auth/service") {
    pass("identifier subtokens split camel case and acronym runs");
  } else {
    fail(`bad subtokens: ${JSON.stringify(identifierSubtokens("verifyJWT"))}`);
  }
  const sdkPatch = tokenVariants("sdk").map((v) => v.text);
  if (sdkPatch[0] === "sdk" && sdkPatch.includes("client") && sdkPatch.includes("packages") && sdkPatch.includes("library")) {
    pass("\"sdk\" expands to its generic client/package/library vocabulary");
  } else {
    fail(`bad sdk variants: ${JSON.stringify(sdkPatch)}`);
  }
}

// Expanded seeds outrank generic entry points: with the auth fixture, every
// window above the last must be a concept file, while the entry fallback
// stays below all real matches if it ever fires.

// --- Section 7: Qualified-name (dotted/slash identifier) matching ---
console.log("");
console.log("=== 7. Qualified-name (dotted/slash identifier) matching ===");

// Tokenizer: qualified identifiers decompose into separator-delimited parts as
// *component* variants; real file-path tokens (extension last segment) stay
// whole because explicit path matching already handles them.
{
  const dotted = tokenVariants("auth.service.verify");
  const dottedParts = dotted.filter((v) => v.kind === "qualified-part").map((v) => v.text);
  if (
    dotted[0]!.text === "auth.service.verify" && dotted[0]!.kind === "original"
    && dottedParts.join("/") === "auth/service/verify"
    && new Set(dotted.map((v) => v.text)).size === dotted.length
  ) {
    pass(`"auth.service.verify" keeps the exact token first and adds component variants (${dottedParts.join("/")})`);
  } else {
    fail(`bad qualified variants: ${JSON.stringify(dotted)}`);
  }

  const camelQualified = tokenVariants("AuthService.verify")
    .filter((v) => v.kind === "qualified-part").map((v) => v.text);
  if (camelQualified.join("/") === "auth/service/verify") {
    pass(`"AuthService.verify" decomposes through camel and dot boundaries (${camelQualified.join("/")})`);
  } else {
    fail(`bad camel qualified variants: ${JSON.stringify(camelQualified)}`);
  }

  const userRepo = tokenVariants("UserRepo.save")
    .filter((v) => v.kind === "qualified-part").map((v) => v.text);
  if (userRepo.join("/") === "user/repo/save") {
    pass(`"UserRepo.save" decomposes to ${userRepo.join("/")}`);
  } else {
    fail(`bad UserRepo.save variants: ${JSON.stringify(userRepo)}`);
  }

  const nsMod = tokenVariants("namespace.module.function")
    .filter((v) => v.kind === "qualified-part").map((v) => v.text);
  if (nsMod.join("/") === "namespace/module/function") {
    pass(`"namespace.module.function" decomposes to ${nsMod.join("/")}`);
  } else {
    fail(`bad namespace variants: ${JSON.stringify(nsMod)}`);
  }

  const slashQualified = tokenVariants("auth/service");
  if (
    slashQualified[0]!.text === "auth/service" && slashQualified[0]!.kind === "original"
    && slashQualified.every((v) => v.kind !== "qualified-part")
  ) {
    pass("slash tokens stay whole: slash-qualified lookups ride the path machinery, not component variants");
  } else {
    fail(`slash token wrongly decomposed: ${JSON.stringify(slashQualified)}`);
  }

  const filePath = tokenVariants("route.ts");
  if (
    filePath[0]!.text === "route.ts" && filePath[0]!.kind === "original"
    && filePath.every((v) => v.kind !== "qualified-part")
  ) {
    pass("file-path tokens with a known extension stay whole (no generic \"route\"/\"ts\" parts)");
  } else {
    fail(`file-path token wrongly decomposed: ${JSON.stringify(filePath)}`);
  }
  const manifestPath = tokenVariants("package.json");
  if (manifestPath[0]!.text === "package.json" && manifestPath.every((v) => v.kind !== "qualified-part")) {
    pass("manifest tokens with a known extension stay whole");
  } else {
    fail(`manifest token wrongly decomposed: ${JSON.stringify(manifestPath)}`);
  }
  const cargoPath = tokenVariants("core/Cargo.toml");
  if (cargoPath[0]!.text === "core/Cargo.toml" && cargoPath.every((v) => v.kind !== "qualified-part")) {
    pass("slash path tokens with a known extension stay whole");
  } else {
    fail(`cargo path token wrongly decomposed: ${JSON.stringify(cargoPath)}`);
  }

  if (extractQueryTokens("auth.service.verify").includes("auth.service.verify")) {
    pass("extractQueryTokens still returns the whole qualified token (exact matching preserved)");
  } else {
    fail("whole qualified token lost from extractQueryTokens");
  }

  const plain = tokenVariants("verify");
  if (plain.every((v) => v.kind !== "qualified-part")) {
    pass("unqualified tokens gain no component variants (existing behavior unchanged)");
  } else {
    fail(`unqualified token gained parts: ${JSON.stringify(plain)}`);
  }
}

// Seeding: qualified queries must reach the real seeding path. The target
// symbol lives in a file whose path contains none of the query's component
// words and has no role, so symbol matching is the only route in — the pass-0
// domain gate must be satisfied by the component match itself.
const textQualified = Array.from({ length: 60 }, (_, i) => `// line ${i + 1} of operations.ts\n`).join("");
const hashQualified = createHash("sha256").update(textQualified).digest("hex");
const textQualifiedMethod = Array.from({ length: 40 }, (_, i) => `// line ${i + 1} of users.ts\n`).join("");
const hashQualifiedMethod = createHash("sha256").update(textQualifiedMethod).digest("hex");
const textNoiseA = Array.from({ length: 30 }, (_, i) => `// line ${i + 1} of misc.ts\n`).join("");
const hashNoiseA = createHash("sha256").update(textNoiseA).digest("hex");
const textNoiseB = Array.from({ length: 30 }, (_, i) => `// line ${i + 1} of other.ts\n`).join("");
const hashNoiseB = createHash("sha256").update(textNoiseB).digest("hex");
const textSave = Array.from({ length: 30 }, (_, i) => `// line ${i + 1} of persist.ts\n`).join("");
const hashSave = createHash("sha256").update(textSave).digest("hex");

class QualifiedDb extends MockDb {
  files = [
    {
      id: "f_target",
      path: "src/core/operations.ts",
      hash: hashQualified,
      lines: 60,
      content_status: "stored",
      file_roles: [],
    },
    {
      id: "f_qualified_method",
      path: "src/repo/users.ts",
      hash: hashQualifiedMethod,
      lines: 40,
      content_status: "stored",
      file_roles: [],
    },
    {
      id: "f_noise_a",
      path: "src/lib/misc.ts",
      hash: hashNoiseA,
      lines: 30,
      content_status: "stored",
      file_roles: [],
    },
    {
      id: "f_noise_b",
      path: "src/lib/other.ts",
      hash: hashNoiseB,
      lines: 30,
      content_status: "stored",
      file_roles: [],
    },
    {
      id: "f_save",
      path: "src/core/persist.ts",
      hash: hashSave,
      lines: 30,
      content_status: "stored",
      file_roles: [],
    },
  ];
  symbols = [
    { file_id: "f_target", name: "verify", kind: "function", line: 20, exported: true },
    { file_id: "f_qualified_method", name: "UserRepo.save", kind: "method", line: 12, exported: true },
    { file_id: "f_noise_a", name: "serviceRegistry", kind: "function", line: 8, exported: true },
    { file_id: "f_noise_b", name: "userService", kind: "function", line: 14, exported: true },
    { file_id: "f_save", name: "save", kind: "function", line: 5, exported: true },
  ];
  fileTexts = new Map<string, string>([
    ["f_target", textQualified],
    ["f_qualified_method", textQualifiedMethod],
    ["f_noise_a", textNoiseA],
    ["f_noise_b", textNoiseB],
    ["f_save", textSave],
  ]);
}
const qualifiedDb = new QualifiedDb();
const qualifiedAsk = async (q: string) =>
  retrieveGroundedContext(qualifiedDb as unknown as Db, "qual_analysis", q);

// A dotted query finds the target symbol through a component match, satisfies
// the domain gate without any path or role seed, and ranks the specific target
// above symbols that merely contain a generic component ("service").
{
  const result = await qualifiedAsk("auth.service.verify");
  const targetWins = result.windows.filter((w) => w.path === "src/core/operations.ts");
  const target = targetWins[0];
  const noiseWins = result.windows.filter(
    (w) => w.path === "src/lib/misc.ts" || w.path === "src/lib/other.ts",
  );
  if (!result.insufficientEvidence && target) {
    pass(`"auth.service.verify" seeds the verify symbol via component matching (${target.reason.slice(0, 70)}...)`);
  } else {
    fail(`qualified query failed to seed: ${JSON.stringify(result.windows.map((w) => w.path))} insufficient=${result.insufficientEvidence}`);
  }
  if (target && targetWins.length === 1) {
    pass("qualified matching produces exactly one window for the target file (no duplicate candidates)");
  } else if (target) {
    fail(`duplicate target windows: ${JSON.stringify(targetWins.map((w) => [w.startLine, w.endLine]))}`);
  }
  if (
    target && result.windows[0]!.path === "src/core/operations.ts"
    && noiseWins.every((w) => (w.score ?? 0) < (target.score ?? 0))
  ) {
    pass(`specific target outranks generic "service" symbols (target ${target.score} vs noise ${noiseWins.map((w) => w.score).join(",")})`);
  } else if (target) {
    fail(`generic component matches not outranked: ${JSON.stringify(result.windows.map((w) => ({ p: w.path, s: w.score })))}`);
  }
}

// The same file queried by its exact name scores strictly higher than the
// qualified spelling of the same lookup — exact matching keeps priority.
{
  const exact = await qualifiedAsk("verify");
  const qualified = await qualifiedAsk("auth.service.verify");
  const exactWin = exact.windows.find((w) => w.path === "src/core/operations.ts");
  const qualifiedWin = qualified.windows.find((w) => w.path === "src/core/operations.ts");
  if (
    exactWin && qualifiedWin
    && (exactWin.score ?? 0) > (qualifiedWin.score ?? 0)
  ) {
    pass(`exact query keeps priority over qualified decomposition (${exactWin.score} > ${qualifiedWin.score})`);
  } else {
    fail(`exact vs qualified priority failed: exact=${exactWin?.score} qualified=${qualifiedWin?.score}`);
  }
}

// A class/method query matches a fully-qualified symbol row at exact strength
// and outranks a standalone helper that shares only the final component.
{
  const result = await qualifiedAsk("UserRepo.save");
  const methodWin = result.windows.find((w) => w.path === "src/repo/users.ts");
  const helperWin = result.windows.find((w) => w.path === "src/core/persist.ts");
  if (
    !result.insufficientEvidence && methodWin
    && result.windows[0]!.path === "src/repo/users.ts"
    && helperWin && (methodWin.score ?? 0) > (helperWin.score ?? 0)
  ) {
    pass(`"UserRepo.save" exact-matches the qualified symbol above the bare "save" helper (${methodWin.score} > ${helperWin.score})`);
  } else {
    fail(`qualified method lookup failed: ${JSON.stringify(result.windows.map((w) => ({ p: w.path, s: w.score })))}`);
  }
}

// Camel-qualified spelling of the same lookup reaches the same symbol through
// decomposition (tokens "authservice.verify", "service.verify").
{
  const result = await qualifiedAsk("AuthService.verify");
  const target = result.windows.find((w) => w.path === "src/core/operations.ts");
  if (!result.insufficientEvidence && target) {
    pass(`"AuthService.verify" reaches the verify symbol through decomposition`);
  } else {
    fail(`camel qualified lookup failed: ${JSON.stringify(result.windows.map((w) => w.path))} insufficient=${result.insufficientEvidence}`);
  }
}

// --- Section 8: Parser-to-retrieval integration for qualified declarations ---
// Uses the real parser through the fixture adapter: the symbols retrieved here
// are actual parse output, not mocked rows.
console.log("");
console.log("=== 8. Parser-to-retrieval integration (real parser, qualified declarations) ===");
{
  const { createFixtureContext } = await import("./eval-fixture-adapter.ts");
  const ctx = createFixtureContext("class-methods");
  const ask = (q: string) => retrieveGroundedContext(ctx.db, ctx.analysisId, q);

  // A qualified method query reaches the method's own file and window.
  const save = await ask("UserRepo.save");
  const saveWin = save.windows.find((w) => w.path === "src/user-repo.ts");
  if (!save.insufficientEvidence && saveWin) {
    pass(`"UserRepo.save" retrieves the real parsed method declaration (${saveWin.reason.slice(0, 60)}...)`);
  } else {
    fail(`qualified method retrieval failed: ${JSON.stringify(save.windows.map((w) => w.path))} insufficient=${save.insufficientEvidence}`);
  }
  if (saveWin && saveWin.startLine <= 2 && saveWin.endLine >= 4) {
    pass(`the retrieved window covers the save declaration (${saveWin.startLine}..${saveWin.endLine})`);
  } else if (saveWin) {
    fail(`window misses the method span: ${saveWin.startLine}..${saveWin.endLine}`);
  }

  const verify = await ask("AuthService.verify");
  const verifyWin = verify.windows.find((w) => w.path === "src/auth-service.ts");
  if (!verify.insufficientEvidence && verifyWin) {
    pass(`"AuthService.verify" retrieves the exported class's method`);
  } else {
    fail(`exported method retrieval failed: ${JSON.stringify(verify.windows.map((w) => w.path))}`);
  }

  const nested = await ask("outerFunction.innerFunction");
  const nestedWin = nested.windows.find((w) => w.path === "src/outer.ts");
  if (!nested.insufficientEvidence && nestedWin) {
    pass(`"outerFunction.innerFunction" retrieves the nested declaration`);
  } else {
    fail(`nested retrieval failed: ${JSON.stringify(nested.windows.map((w) => w.path))} insufficient=${nested.insufficientEvidence}`);
  }

  // Unqualified queries keep working against the same parsed symbols.
  const unqualified = await ask("verify");
  if (unqualified.windows.some((w) => w.path === "src/auth-service.ts")) {
    pass("unqualified \"verify\" still finds AuthService.verify");
  } else {
    fail(`unqualified query regressed: ${JSON.stringify(unqualified.windows.map((w) => w.path))}`);
  }
  const cls = await ask("UserRepo");
  if (cls.windows.some((w) => w.path === "src/user-repo.ts")) {
    pass("the class itself stays retrievable by its own name");
  } else {
    fail(`class query regressed: ${JSON.stringify(cls.windows.map((w) => w.path))}`);
  }

  // Specificity: the exact method query ranks its target first.
  if (save.windows[0]?.path === "src/user-repo.ts") {
    pass("the qualified method's own file is the top-ranked window");
  } else {
    fail(`ranking off: ${JSON.stringify(save.windows.map((w) => ({ p: w.path, s: w.score })))}`);
  }
}

// --- Section 9: Parser-to-retrieval integration for Express routes ---
// Uses the real parser through the fixture adapter: the routes retrieved here
// are actual parse output stored in the routes table, not mocked rows.
console.log("");
console.log("=== 9. Parser-to-retrieval integration (real parser, Express routes) ===");
{
  const { createFixtureContext } = await import("./eval-fixture-adapter.ts");
  const ctx = createFixtureContext("express-routes");
  const ask = (q: string) => retrieveGroundedContext(ctx.db, ctx.analysisId, q);
  const lineOf = (file: string, needle: string): number => {
    const text = ctx.fileTexts.get(file)!;
    return text.slice(0, text.indexOf(needle)).split("\n").length;
  };

  const routeWindows = (windows: TargetWindow[]) =>
    windows.filter((w) => w.strategies?.includes("route"));

  // "Where is the POST endpoint for creating users?" — the route strategy
  // matches POST + the "users" segment and seeds the registration's window,
  // which covers the createUser handler below it.
  const create = await ask("Where is the POST endpoint for creating users?");
  const createWin = routeWindows(create.windows).find((w) => w.path === "routes/users.js");
  if (!create.insufficientEvidence && createWin) {
    pass(`the POST-for-users query retrieves a route window in routes/users.js (${createWin.reason.slice(0, 60)}...)`);
  } else {
    fail(`create-users route retrieval failed: ${JSON.stringify(routeWindows(create.windows).map((w) => w.path))} insufficient=${create.insufficientEvidence}`);
  }
  const createUserLine = lineOf("routes/users.js", "async function createUser");
  if (createWin && createWin.startLine <= createUserLine && createWin.endLine >= createUserLine) {
    pass(`the create-users route window covers the createUser handler (${createWin.startLine}..${createWin.endLine})`);
  } else if (createWin) {
    fail(`create-users window misses createUser: ${createWin.startLine}..${createWin.endLine}`);
  }

  // "Which handler serves the GET users route?" — method + segment together.
  const serve = await ask("Which handler serves the GET users route?");
  const serveWin = routeWindows(serve.windows).find((w) => w.path === "routes/users.js");
  if (!serve.insufficientEvidence && serveWin) {
    pass(`the GET-users query retrieves a route window in routes/users.js (${serveWin.reason.slice(0, 60)}...)`);
  } else {
    fail(`get-users route retrieval failed: ${JSON.stringify(routeWindows(serve.windows).map((w) => w.path))} insufficient=${serve.insufficientEvidence}`);
  }

  // "Where is the user deletion endpoint defined?" — the DELETE route.
  const del = await ask("Where is the user deletion endpoint defined?");
  const delWin = routeWindows(del.windows).find((w) => w.path === "routes/users.js");
  if (!del.insufficientEvidence && delWin) {
    pass(`the deletion query retrieves a route window in routes/users.js (${delWin.reason.slice(0, 60)}...)`);
  } else {
    fail(`delete-users route retrieval failed: ${JSON.stringify(routeWindows(del.windows).map((w) => w.path))} insufficient=${del.insufficientEvidence}`);
  }
  const deleteUserLine = lineOf("routes/users.js", "async function deleteUser");
  if (delWin && delWin.startLine <= deleteUserLine && delWin.endLine >= deleteUserLine) {
    pass(`the deletion route window covers the deleteUser handler (${delWin.startLine}..${delWin.endLine})`);
  } else if (delWin) {
    fail(`deletion window misses deleteUser: ${delWin.startLine}..${delWin.endLine}`);
  }

  // Method matching: same path segment, different method, different handler.
  const patch = await ask("the PATCH route for posts");
  const patchWin = routeWindows(patch.windows).find((w) => w.path === "routes/posts.js");
  const patchLine = lineOf("routes/posts.js", "function patchPost");
  if (patchWin && patchWin.startLine <= patchLine && patchWin.endLine >= patchLine) {
    pass("the PATCH-posts query seeds the window covering patchPost");
  } else {
    fail(`PATCH-posts retrieval failed: ${JSON.stringify(routeWindows(patch.windows).map((w) => w.path))} insufficient=${patch.insufficientEvidence}`);
  }
  const post = await ask("the POST route for posts");
  const postWin = routeWindows(post.windows).find((w) => w.path === "routes/posts.js");
  const createPostLine = lineOf("routes/posts.js", "function createPost");
  if (postWin && postWin.startLine <= createPostLine && postWin.endLine >= createPostLine) {
    pass("the POST-posts query seeds the window covering createPost");
  } else {
    fail(`POST-posts retrieval failed: ${JSON.stringify(routeWindows(post.windows).map((w) => w.path))} insufficient=${post.insufficientEvidence}`);
  }

  // Exact beats generic: the fully spelled route outranks a vague segment hit.
  const exact = await ask("GET /api/users/:userId");
  const exactWin = exact.windows.find((w) => w.path === "routes/users.js");
  if (!exact.insufficientEvidence && exactWin) {
    pass(`the fully spelled route retrieves its file (${exactWin.reason.slice(0, 60)}...)`);
  } else {
    fail(`exact route retrieval failed: ${JSON.stringify(exact.windows.map((w) => w.path))} insufficient=${exact.insufficientEvidence}`);
  }

  // Symbol strategies still work over the same fixture: the handler is
  // reachable by name as well as by route.
  const symbol = await ask("deleteUser");
  if (symbol.windows.some((w) => w.path === "routes/users.js")) {
    pass("the route handlers remain retrievable through the symbol strategy");
  } else {
    fail(`symbol coexistence regressed: ${JSON.stringify(symbol.windows.map((w) => w.path))}`);
  }

  // Unsupported routes degrade gracefully: the never-mounted orphan router is
  // indexed as code but serves no route windows that outrank its file's own
  // content; the important part is that retrieval never claims a route that
  // was omitted. The omission lives in parse output (test-express-routes.ts).
}

// --- Explicit HTTP methods in the query ---
// A method spelled in upper case ("GET /users") is part of what is asked for:
// routes whose method differs must not receive the same path-match evidence
// the right method gets. The tokenizer can't carry this signal — "get" is a
// stop-word it drops, and lowercase "get"/"post" are ordinary words — so the
// explicitness lives in the raw query's casing. Each seed's reason segment is
// checked individually, because merged windows concatenate every seed.
const METHOD_MISMATCH_MARKER = "(explicit method mismatch, demoted)";
const reasonSegments = (result: { windows: TargetWindow[] }, filePath: string): string[] =>
  result.windows.filter((w) => w.path === filePath).flatMap((w) => w.reason.split(";").map((s) => s.trim()));
const cited = (segments: string[], citation: string) =>
  segments.find((s) => s.startsWith(`route "${citation}" matches`));
{
  const { createFixtureContext } = await import("./eval-fixture-adapter.ts");
  const ctx = createFixtureContext("express-routes");
  const ask = (q: string) => retrieveGroundedContext(ctx.db, ctx.analysisId, q);

  // Same path, both methods exist: the explicit method picks its own route.
  const methodCases: { query: string; file: string; right: string; wrong: string[] }[] = [
    { query: "GET /users", file: "routes/users.js", right: "GET /api/users", wrong: ["POST /api/users"] },
    { query: "POST /users", file: "routes/users.js", right: "POST /api/users", wrong: ["GET /api/users"] },
    {
      query: "DELETE /users/:id",
      file: "routes/users.js",
      right: "DELETE /api/users/:userId",
      wrong: ["GET /api/users/:userId", "PUT /api/users/:userId"],
    },
  ];
  for (const { query, file, right, wrong } of methodCases) {
    const segments = reasonSegments(await ask(query), file);
    const rightSeed = cited(segments, right);
    if (rightSeed !== undefined && !rightSeed.includes(METHOD_MISMATCH_MARKER)) {
      pass(`"${query}" cites route "${right}" as a full match`);
    } else {
      fail(`"${query}" full-match citation for "${right}" wrong: ${rightSeed ?? "(missing)"}`);
    }
    for (const wrongRoute of wrong) {
      const wrongSeed = cited(segments, wrongRoute);
      if (wrongSeed !== undefined && wrongSeed.includes(METHOD_MISMATCH_MARKER)) {
        pass(`"${query}" demotes the wrong-method route "${wrongRoute}"`);
      } else {
        fail(`"${query}" demotion of "${wrongRoute}" wrong: ${wrongSeed ?? "(missing)"}`);
      }
    }
  }

  // A path where only DELETE exists: a GET query must not treat it as a full
  // match; the DELETE query does.
  const rightSession = cited(reasonSegments(await ask("DELETE /sessions/:sessionId"), "app.js"), "DELETE /sessions/:sessionId");
  if (rightSession !== undefined && !rightSession.includes(METHOD_MISMATCH_MARKER)) {
    pass('"DELETE /sessions/:sessionId" cites its route as a full match');
  } else {
    fail(`"DELETE /sessions/:sessionId" full-match citation wrong: ${rightSession ?? "(missing)"}`);
  }
  const wrongSession = cited(reasonSegments(await ask("GET /sessions/:sessionId"), "app.js"), "DELETE /sessions/:sessionId");
  if (wrongSession !== undefined && wrongSession.includes(METHOD_MISMATCH_MARKER)) {
    pass('"GET /sessions/:sessionId" demotes the DELETE-only route it names');
  } else {
    fail(`"GET /sessions/:sessionId" demotion wrong: ${wrongSession ?? "(missing)"}`);
  }

  // A path where only GET exists (/api/archive): a POST query demotes it; a
  // GET query does not.
  const wrongArchive = cited(reasonSegments(await ask("POST /archive"), "routes/posts.js"), "GET /api/archive");
  if (wrongArchive !== undefined && wrongArchive.includes(METHOD_MISMATCH_MARKER)) {
    pass('"POST /archive" demotes the GET-only archive route');
  } else {
    fail(`"POST /archive" demotion wrong: ${wrongArchive ?? "(missing)"}`);
  }
  const rightArchive = cited(reasonSegments(await ask("GET /archive"), "routes/posts.js"), "GET /api/archive");
  if (rightArchive !== undefined && !rightArchive.includes(METHOD_MISMATCH_MARKER)) {
    pass('"GET /archive" cites the archive route as a full match');
  } else {
    fail(`"GET /archive" full-match citation wrong: ${rightArchive ?? "(missing)"}`);
  }

  // A path-only query carries no method signal: nothing is demoted.
  const pathOnly = reasonSegments(await ask("Where is the user deletion endpoint defined?"), "routes/users.js");
  if (pathOnly.every((s) => !s.includes(METHOD_MISMATCH_MARKER))) {
    pass("a path-only query without an explicit method demotes nothing");
  } else {
    fail(`path-only query wrongly demoted: ${pathOnly.filter((s) => s.includes(METHOD_MISMATCH_MARKER)).join(" | ")}`);
  }
}

// Summary
console.log("");
for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
if (failed > 0) process.exit(1);
