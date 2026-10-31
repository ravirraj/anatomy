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
  type TargetWindow,
} from "../lib/ai/retrieval.ts";

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
};

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
    imports: ["fx_auth_routes", "fx_error_middleware", "fx_db"],
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
    })),
  );

  edges = fixtureFiles.flatMap((f) =>
    f.imports.map((target) => ({ source_file_id: f.id, target_file_id: target, kind: "import" })),
  );

  routes = [
    { file_id: "fx_auth_routes", method: "POST", path: "/auth/login", line: 8 },
  ];

  files = fixtureFiles.map((f) => {
    // 70 lines of filler content ending in a final newline.
    const text = Array.from({ length: 70 }, (_, i) => `// line ${i + 1} of ${f.path}\n`).join("");
    const hash = createHash("sha256").update(text).digest("hex");
    fxTexts.set(f.id, text);
    fxHashes.set(f.id, hash);
    return {
      id: f.id,
      path: f.path,
      hash,
      lines: 70,
      content_status: "stored",
      file_roles: f.role ? [{ role: f.role, source: "convention" }] : [],
    };
  });

  from(table: string) {
    if (table === "files") {
      return {
        select: () => ({
          eq: (_col: string, value: string) => ({
            is: () => Promise.resolve({ data: this.files, error: null }),
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

// Concept-expansion unit checks: plain vocabulary, no repo knowledge.
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

// Summary
console.log("");
for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
if (failed > 0) process.exit(1);
