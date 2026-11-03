// scripts/test-retrieval-budget.ts
// CI-8C: Deterministic unit tests for budget-aware retrieval and context rendering.
// Verifies dual-stage budgeting (character ceiling + operational token target),
// whole-window line preservation, packaging/API surface accounting, post-retrieval
// compaction synchronization, citation eligibility of dropped windows, iterative loop
// budget sharing, and prompt fit under extreme/Unicode conditions.

import { createHash } from "node:crypto";
import {
  computeEvidenceLimits,
  formatRetrievedContext,
  retrieveGroundedContext,
  type Db,
  type RetrievedWindow,
} from "../lib/ai/retrieval.ts";
import {
  mergeIterationWindows,
  retrieveWithCoverageLoop,
} from "../lib/ai/retrieval-loop.ts";
import {
  evaluatePromptBudget,
  resolveModelProfile,
} from "../lib/ai/budget.ts";
import { QUESTION_SYSTEM, questionMessage } from "../lib/ai/prompts.ts";
import { verifyCitations, type FileEvidence } from "../lib/ai/citations.ts";

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string, detail?: string) {
  if (cond) {
    passed += 1;
    console.log(`ok    ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

// -----------------------------------------------------------------------------
// Test Section 1: computeEvidenceLimits & Prompt Framing Reservations
// -----------------------------------------------------------------------------
console.log("\n=== 1. computeEvidenceLimits: Profile & Reservation Arithmetic ===");
{
  // 1.1 Unconfigured default (no profile)
  const def = computeEvidenceLimits({}, "test query");
  check(def.maxCharacters === 28_000, "default maxCharacters is 28,000", `got ${def.maxCharacters}`);
  check(def.maxTokens === Math.ceil(28_000 / 3.0), "default maxTokens is ceil(28000/3)", `got ${def.maxTokens}`);
  check(def.maxFiles === 16, "default maxFiles is 16");
  check(def.maxWindowsPerFile === 2, "default maxWindowsPerFile is 2");
  check(!def.isProfileBound, "default is not profile-bound");

  // 1.2 Explicit budget overrides without profile
  const custom = computeEvidenceLimits({ maxCharacters: 12_000, maxTokens: 3_500, maxFiles: 8 });
  check(custom.maxCharacters === 12_000, "custom maxCharacters respected (12,000)");
  check(custom.maxTokens === 3_500, "custom maxTokens respected (3,500)");
  check(custom.maxFiles === 8, "custom maxFiles respected (8)");

  // 1.3 Unknown Fallback Profile (8,192 context window, 4,500 operational tokens, 13,500 max chars)
  const fallbackProfile = resolveModelProfile("unknown-custom-model");
  check(fallbackProfile.contextWindowTokens === 8_192, "fallback contextWindowTokens is 8,192");
  check(fallbackProfile.maxOutputTokens === 1_500, "fallback maxOutputTokens is 1,500");
  check(fallbackProfile.operationalInputTokens === 4_500, "fallback operationalInputTokens is 4,500");
  check(fallbackProfile.maxInputCharacters === 13_500, "fallback maxInputCharacters is 13,500");
  check(fallbackProfile.safetyHeadroomTokens === 2_192, "fallback safetyHeadroomTokens is 2,192 (26.8% headroom)");

  const fallbackLimits = computeEvidenceLimits({ profile: fallbackProfile }, "How does authentication work?");
  check(fallbackLimits.isProfileBound, "fallback profile marked profile-bound");
  check(fallbackLimits.reservedTokens > 2_000, "system + query + framing reserves > 2,000 tokens", `got ${fallbackLimits.reservedTokens}`);
  check(fallbackLimits.reservedCharacters > 7_000, "system + query + framing reserves > 7,000 chars", `got ${fallbackLimits.reservedCharacters}`);

  // Invariant: reservedCharacters + maxCharacters <= fallbackProfile.maxInputCharacters
  check(
    fallbackLimits.reservedCharacters + fallbackLimits.maxCharacters <= fallbackProfile.maxInputCharacters,
    "fallback total characters (reserved + evidence) fits within 13,500 ceiling",
    `${fallbackLimits.reservedCharacters} + ${fallbackLimits.maxCharacters} = ${fallbackLimits.reservedCharacters + fallbackLimits.maxCharacters} > ${fallbackProfile.maxInputCharacters}`
  );

  // Invariant: reservedTokens + maxTokens <= fallbackProfile.operationalInputTokens
  check(
    fallbackLimits.reservedTokens + fallbackLimits.maxTokens <= fallbackProfile.operationalInputTokens,
    "fallback total tokens (reserved + evidence) fits within 4,500 operational target",
    `${fallbackLimits.reservedTokens} + ${fallbackLimits.maxTokens} = ${fallbackLimits.reservedTokens + fallbackLimits.maxTokens} > ${fallbackProfile.operationalInputTokens}`
  );

  // 1.4 Verified Large Profile (gpt-4o: 128k context window, 92k operational tokens)
  const gpt4oProfile = resolveModelProfile("gpt-4o");
  const gpt4oLimits = computeEvidenceLimits({ profile: gpt4oProfile }, "Explain repository architecture");
  check(gpt4oLimits.isProfileBound, "gpt-4o marked profile-bound");
  check(gpt4oLimits.maxCharacters === 28_000, "gpt-4o caps evidence characters at default 28,000", `got ${gpt4oLimits.maxCharacters}`);

  const gpt4oWidened = computeEvidenceLimits({ profile: gpt4oProfile, maxCharacters: 50_000 }, "Explain all modules");
  check(gpt4oWidened.maxCharacters === 50_000, "gpt-4o widens evidence characters when explicitly requested (50,000)");

  // 1.5 Unusually long question exhausting available budget
  const hugeQuery = "What is the architecture of this project? ".repeat(500); // ~21,000 characters
  const exhaustedLimits = computeEvidenceLimits({ profile: fallbackProfile }, hugeQuery);
  check(exhaustedLimits.maxCharacters === 0, "excessive question length results in 0 evidence character budget");
  check(exhaustedLimits.maxTokens === 0, "excessive question length results in 0 evidence token budget");

  // 1.6 Unicode & multi-byte content in query
  const unicodeQuery = "How does 🚀 Japanese 日本語 and Swedish åäö characters work in utf8?";
  const unicodeLimits = computeEvidenceLimits({ profile: fallbackProfile }, unicodeQuery);
  check(unicodeLimits.maxCharacters > 0 && unicodeLimits.maxTokens > 0, "Unicode query calculates valid positive evidence limits");
}

// -----------------------------------------------------------------------------
// Helper: Complete Mock Database Emulating Supabase & Read Service
// -----------------------------------------------------------------------------
type MockFileData = {
  id: string;
  path: string;
  text: string;
  role?: string;
};

type MockSymbolData = {
  file_id: string;
  name: string;
  kind: string;
  line: number;
  exported: boolean;
  signature?: string;
  documentation?: string;
};

class ComprehensiveMockDb {
  files: {
    id: string;
    path: string;
    hash: string;
    lines: number;
    content_status: string;
    file_roles: { role: string; source: string }[];
  }[];
  fileTexts = new Map<string, string>();
  symbols: MockSymbolData[];
  edges: { source_file_id: string; target_file_id: string; kind: string }[];
  manifests: Record<string, unknown>[];

  constructor(
    fileSpecs: MockFileData[],
    symbols: MockSymbolData[] = [],
    edges: { source_file_id: string; target_file_id: string; kind: string }[] = [],
    manifests: Record<string, unknown>[] = [],
  ) {
    this.symbols = symbols;
    this.edges = edges;
    this.manifests = manifests;
    this.files = fileSpecs.map((f) => {
      const hash = createHash("sha256").update(f.text).digest("hex");
      this.fileTexts.set(f.id, f.text);
      return {
        id: f.id,
        path: f.path,
        hash,
        lines: f.text.split("\n").length,
        content_status: "stored",
        file_roles: f.role ? [{ role: f.role, source: "convention" }] : [],
      };
    });
  }

  from(table: string) {
    if (table === "files") {
      return {
        select: () => ({
          eq: (_f: string, _val: string) => ({
            is: () => Promise.resolve({ data: this.files, error: null }),
            in: (_inCol: string, paths: string[]) => {
              const matched = this.files.filter((f) => paths.includes(f.path));
              return Promise.resolve({ data: matched, error: null });
            },
            maybeSingle: async () => {
              const file = this.files.find((f) => f.id === _val);
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
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      };
    }
    if (table === "edges" || table === "graph_edges") {
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
    if (table === "manifests") {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: this.manifests, error: null }),
        }),
      };
    }
    if (table === "dependencies" || table === "config_references" || table === "entry_points") {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      };
    }
    throw new Error(`Unexpected table ${table}`);
  }
}

// -----------------------------------------------------------------------------
// Test Section 2: Dual Bounds, Whole-Window Integrity & Zero Budget
// -----------------------------------------------------------------------------
console.log("\n=== 2. retrieveGroundedContext: Dual Bounds & Zero/Insufficient Budget ===");
{
  const textAuth = Array.from({ length: 80 }, (_, i) => `// session.ts line ${i + 1}: export const sessionToken = 'tok';`).join("\n");
  const textUser = Array.from({ length: 60 }, (_, i) => `// user.ts line ${i + 1}: export interface UserRecord { id: string; }`).join("\n");
  const textLogin = Array.from({ length: 50 }, (_, i) => `// login.ts line ${i + 1}: export function handleLogin() { return true; }`).join("\n");
  const textToken = Array.from({ length: 8 }, (_, i) => `// tokenUtil.ts line ${i + 1}: export const parseTok = () => 'tok';`).join("\n");
  const longPath = "src/very/deeply/nested/subsystem/directory/structure/that/has/an/extremely/long/path/name/for/testing/tokenUtil.ts";

  const files: MockFileData[] = [
    { id: "f_auth", path: "src/auth/session.ts", text: textAuth, role: "service" },
    { id: "f_user", path: "src/models/user.ts", text: textUser, role: "model" },
    { id: "f_login", path: "src/api/login.ts", text: textLogin, role: "controller" },
    { id: "f_token", path: longPath, text: textToken, role: "service" },
  ];

  const symbols: MockSymbolData[] = [
    { file_id: "f_auth", name: "sessionToken", kind: "variable", line: 1, exported: true },
    { file_id: "f_user", name: "UserRecord", kind: "interface", line: 1, exported: true },
    { file_id: "f_login", name: "handleLogin", kind: "function", line: 1, exported: true },
    { file_id: "f_token", name: "parseTok", kind: "function", line: 1, exported: true },
  ];

  const edges = [
    { source_file_id: "f_login", target_file_id: "f_auth", kind: "import" },
    { source_file_id: "f_auth", target_file_id: "f_user", kind: "import" },
    { source_file_id: "f_auth", target_file_id: "f_token", kind: "import" },
  ];

  const mockDb = new ComprehensiveMockDb(files, symbols, edges);

  // 2.1 Default unconstrained retrieval
  const defaultRes = await retrieveGroundedContext(
    mockDb as unknown as Db,
    "test_analysis",
    "How does handleLogin verify sessionToken and UserRecord?",
  );
  check(defaultRes.windows.length >= 2, `retrieves candidate windows (${defaultRes.windows.length})`);
  check(defaultRes.totalCharacters > 0, `tracks raw code characters (${defaultRes.totalCharacters})`);
  check(typeof defaultRes.totalTokens === "number" && defaultRes.totalTokens > 0, `tracks estimated tokens (${defaultRes.totalTokens})`);
  check(typeof defaultRes.renderedCharacters === "number" && defaultRes.renderedCharacters > defaultRes.totalCharacters, `tracks rendered characters with headers (${defaultRes.renderedCharacters})`);

  // 2.2 Whole-window integrity verification
  let allWindowsIntact = true;
  for (const win of defaultRes.windows) {
    const raw = mockDb.fileTexts.get(win.fileId) ?? "";
    const rawLines = raw.split("\n");
    const slice = rawLines.slice(win.startLine - 1, win.endLine).join("\n");
    if (win.text.trim() !== slice.trim()) {
      allWindowsIntact = false;
      break;
    }
  }
  check(allWindowsIntact, "every retrieved window preserves exact whole-window line boundaries");

  // 2.3 Constrained character ceiling: whole padded windows are skipped sharp at the
  // cap; every candidate is admitted through its matched evidence core instead, and
  // the long-path candidate's costly header is still accounted for within the cap.
  const constrainedRes = await retrieveGroundedContext(
    mockDb as unknown as Db,
    "test_analysis",
    "How does parseTok verify sessionToken?",
    { maxCharacters: 1_200 },
  );
  check(
    (constrainedRes.renderedCharacters ?? constrainedRes.totalCharacters) <= 1_200,
    `constrained retrieval strictly respects 1,200 character cap (${constrainedRes.renderedCharacters ?? constrainedRes.totalCharacters} chars)`
  );
  check(constrainedRes.windows.length > 0, "compact candidate window admitted under 1,200 cap");
  check(
    constrainedRes.files.some((f) => f.path === longPath),
    "long path candidate admitted with its full header cost within the cap",
  );
  check(
    constrainedRes.files.length >= 2,
    `kernel serving admits multiple competing files under the cap (${constrainedRes.files.length} files)`,
  );

  // 2.4 Zero / Insufficient budget handling: excessive question returns insufficientEvidence without throwing
  const fallbackProfile = resolveModelProfile("unknown-custom-model");
  const hugeQuery = "How does login work? ".repeat(600); // ~13,800 characters, exceeds fallback 13,500
  const zeroBudgetRes = await retrieveGroundedContext(
    mockDb as unknown as Db,
    "test_analysis",
    hugeQuery,
    { profile: fallbackProfile },
  );
  check(zeroBudgetRes.insufficientEvidence, "insufficient remaining budget returns insufficientEvidence: true");
  check(zeroBudgetRes.windows.length === 0, "zero windows retrieved when prompt budget exhausted by question");
  check(zeroBudgetRes.totalCharacters === 0, "zero total characters reported for zero-budget retrieval");
  check(zeroBudgetRes.renderedCharacters === 0, "zero rendered characters reported for zero-budget retrieval");
}

// -----------------------------------------------------------------------------
// Test Section 3: Citation Integrity of Dropped Windows
// -----------------------------------------------------------------------------
console.log("\n=== 3. Citation Integrity: Dropped Windows Ineligible for Citation ===");
{
  const textSrv = Array.from({ length: 60 }, (_, i) => `// apiService line ${i + 1}: export function execService() { return true; }`).join("\n");
  const textCtrl = Array.from({ length: 50 }, (_, i) => `// apiController line ${i + 1}: export function dispatchApi() { return true; }`).join("\n");
  const textHelper = Array.from({ length: 8 }, (_, i) => `// apiHelper line ${i + 1}: export const helperOk = () => true;`).join("\n");

  const files: MockFileData[] = [
    { id: "f_srv", path: "src/services/apiService.ts", text: textSrv, role: "service" },
    { id: "f_ctrl", path: "src/controllers/apiController.ts", text: textCtrl, role: "controller" },
    { id: "f_helper", path: "src/utils/apiHelper.ts", text: textHelper, role: "service" },
    { id: "f_pkg", path: "package.json", text: '{\n  "name": "cartograph-test",\n  "dependencies": { "express": "^4.19.0" }\n}\n' },
  ];

  const symbols: MockSymbolData[] = [
    {
      file_id: "f_helper",
      name: "helperOk",
      kind: "function",
      line: 1,
      exported: true,
      signature: "helperOk(): boolean",
      documentation: "Helper predicate",
    },
    {
      file_id: "f_srv",
      name: "execService",
      kind: "function",
      line: 1,
      exported: true,
      signature: "execService(): Promise<boolean>",
      documentation: "Executes backend service operation with verified auth",
    },
    {
      file_id: "f_ctrl",
      name: "dispatchApi",
      kind: "function",
      line: 1,
      exported: true,
      signature: "dispatchApi(req: Request): Response",
      documentation: "Dispatches incoming API requests to handlers",
    },
  ];

  const manifests = [
    {
      id: "m_pkg",
      analysis_id: "test_analysis_pkg",
      path: "package.json",
      dir: ".",
      ecosystem: "npm",
      name: "cartograph-test",
      workspaces: null,
      scripts: null,
      problems: null,
    },
  ];

  const mockDb = new ComprehensiveMockDb(files, symbols, [], manifests);

  // Unconstrained retrieval: both files retrieved
  const fullRes = await retrieveGroundedContext(
    mockDb as unknown as Db,
    "test_analysis_pkg",
    "What dependencies and packages does execService and dispatchApi use?",
  );
  check(fullRes.files.length >= 2, `full retrieval includes multiple files (${fullRes.files.length})`);

  // Constrained retrieval: tail-drop compaction forces dropping lowest-scoring file/window
  const tightRes = await retrieveGroundedContext(
    mockDb as unknown as Db,
    "test_analysis_pkg",
    "What dependencies and packages does helperOk and execService use?",
    { maxCharacters: 1_200 },
  );

  check(
    (tightRes.renderedCharacters ?? tightRes.totalCharacters) <= 1_200,
    `compacted evidence fits within 1,200 character ceiling (${tightRes.renderedCharacters} chars)`
  );
  check(tightRes.files.length < fullRes.files.length, "compaction dropped one file to fit within budget");

  // Derive allowedEvidence exactly as downstream answerQuestion does:
  const allowedEvidence = new Map<string, FileEvidence>();
  for (const f of tightRes.files) {
    allowedEvidence.set(f.path, {
      lines: f.totalLines,
      contentHash: f.contentHash,
      ...(f.windows ? { windows: f.windows } : {}),
    });
  }

  // 3.1 Surviving window lines: citation verification SUCCEEDS
  const survivingFile = tightRes.files[0]!;
  const survivingWin = survivingFile.windows![0]!;
  const validBody = `The implementation is located at \`${survivingFile.path}#L${survivingWin.startLine}-L${Math.min(survivingWin.endLine, survivingWin.startLine + 5)}\`.`;
  const validFailure = verifyCitations(validBody, allowedEvidence);
  check(validFailure.paths.length === 0, "citation to surviving window lines verifies successfully");

  // 3.2 Dropped file lines: citation verification FAILS (not in allowedEvidence)
  const droppedFile = fullRes.files.find((f) => !tightRes.files.some((tf) => tf.path === f.path))!;
  check(Boolean(droppedFile), `identified dropped file: "${droppedFile.path}"`);
  const invalidBody = `The dropped function is at \`${droppedFile.path}#L1-L15\`.`;
  const invalidFailure = verifyCitations(invalidBody, allowedEvidence);
  check(
    invalidFailure.paths.length > 0,
    "citation to dropped file rejected by verifyCitations as uncited evidence",
    invalidFailure.details?.join("; ")
  );
}

// -----------------------------------------------------------------------------
// Test Section 4: Iterative Loop Budget Sharing & Deduplication
// -----------------------------------------------------------------------------
console.log("\n=== 4. Iterative Loop: Shared Allocation, Non-Reset, & Deduplication ===");
{
  const mockFiles: MockFileData[] = [
    {
      id: "f_ctrl",
      path: "src/controllers/itemController.ts",
      role: "controller",
      text: Array.from({ length: 40 }, (_, i) => `// itemController line ${i + 1}`).join("\n"),
    },
    {
      id: "f_srv",
      path: "src/services/itemService.ts",
      role: "service",
      text: Array.from({ length: 40 }, (_, i) => `// itemService line ${i + 1}`).join("\n"),
    },
    {
      id: "f_route",
      path: "src/routes/itemRoute.ts",
      role: "route",
      text: Array.from({ length: 30 }, (_, i) => `// itemRoute line ${i + 1}`).join("\n"),
    },
  ];

  const mockDb = new ComprehensiveMockDb(mockFiles);

  // 4.1 Repeated and overlapping windows are rejected without double-counting
  const baseWin: RetrievedWindow = {
    fileId: "f_ctrl",
    path: "src/controllers/itemController.ts",
    contentHash: "hashA",
    totalLines: 40,
    startLine: 1,
    endLine: 20,
    score: 80,
    text: "x".repeat(300),
    reason: "controller match",
  };

  const exactDuplicate: RetrievedWindow = { ...baseWin };
  const overlappingWin: RetrievedWindow = { ...baseWin, startLine: 10, endLine: 30 };

  const dedupeResult = mergeIterationWindows(
    { windows: [baseWin], totalCharacters: 300, totalTokens: 100 },
    [exactDuplicate, overlappingWin],
    { maxFiles: 16, maxWindowsPerFile: 2, maxCharacters: 28_000, scoreFloor: 50 },
  );
  check(dedupeResult.added === 0, "exact duplicate and overlapping windows rejected");
  check(dedupeResult.totalCharacters === 300, "totalCharacters untouched by duplicate candidates");
  check(dedupeResult.totalTokens === 100, "totalTokens untouched by duplicate candidates");

  // 4.2 Shared allocation: Pass 0 + iterative passes share single budget
  const fallbackProfile = resolveModelProfile("unknown-custom-model");
  const loopResult = await retrieveWithCoverageLoop(
    mockDb as unknown as Db,
    "test_analysis_loop",
    "How does itemController handle routing and itemService?",
    { profile: fallbackProfile, adaptive: false },
  );

  check(loopResult.result.windows.length > 0, "retrieval loop produces evidence package");
  check(
    (loopResult.result.renderedCharacters ?? loopResult.result.totalCharacters) <= fallbackProfile.maxInputCharacters,
    `total evidence characters across all passes fits within fallback maxInputCharacters (${loopResult.result.renderedCharacters ?? loopResult.result.totalCharacters} <= ${fallbackProfile.maxInputCharacters})`
  );
  check(
    (loopResult.result.totalTokens ?? 0) <= fallbackProfile.operationalInputTokens,
    `total evidence tokens across all passes fits within fallback operationalInputTokens (${loopResult.result.totalTokens} <= ${fallbackProfile.operationalInputTokens})`
  );
}

// -----------------------------------------------------------------------------
// Test Section 5: End-to-End Prompt Budget Pre-flight Verification
// -----------------------------------------------------------------------------
console.log("\n=== 5. End-to-End Prompt Pre-flight Fit (assertPromptBudget) ===");
{
  const fallbackProfile = resolveModelProfile("unknown-custom-model");

  const mockFiles: MockFileData[] = [
    {
      id: "f_auth",
      path: "src/auth/authController.ts",
      role: "controller",
      text: Array.from({ length: 60 }, (_, i) => `// authController line ${i + 1}: export const login = () => true;`).join("\n"),
    },
    {
      id: "f_jwt",
      path: "src/utils/jwt.ts",
      role: "service",
      text: Array.from({ length: 50 }, (_, i) => `// jwt line ${i + 1}: export function signToken() { return 'token'; }`).join("\n"),
    },
  ];

  const symbols: MockSymbolData[] = [
    { file_id: "f_auth", name: "login", kind: "function", line: 1, exported: true },
    { file_id: "f_jwt", name: "signToken", kind: "function", line: 1, exported: true },
  ];

  const mockDb = new ComprehensiveMockDb(mockFiles, symbols);
  const loop = await retrieveWithCoverageLoop(
    mockDb as unknown as Db,
    "test_analysis_e2e",
    "How does login authentication issue tokens with signToken?",
    { profile: fallbackProfile, adaptive: false },
  );

  const retrieved = loop.result;
  const contextText = formatRetrievedContext(retrieved);

  // Assemble the exact user message seen by the model
  const message = questionMessage({
    question: "How does login authentication issue tokens with signToken?",
    contextText,
    files: retrieved.files.map((f) => ({
      path: f.path,
      contentHash: f.contentHash,
      totalLines: f.totalLines,
      windows: f.windows,
    })),
    coverage: {
      verified: ["controllers"],
      partial: ["services"],
      unknown: ["routes"],
      unknownNote: loop.coverage.unknownNote,
    },
  });

  const evaluation = evaluatePromptBudget(fallbackProfile, QUESTION_SYSTEM, message);
  check(
    evaluation.valid,
    `prompt satisfies all pre-flight invariants for fallback profile (chars=${evaluation.totalCharacters}/${evaluation.maxInputCharacters}, tokens=${evaluation.estimatedTokens}/${evaluation.operationalInputTokens})`,
    evaluation.violations.join("; ")
  );
  check(evaluation.violations.length === 0, "zero prompt budget violations");
}

// -----------------------------------------------------------------------------
// Final Summary
// -----------------------------------------------------------------------------
console.log("\n------------------------------------------------------------");
console.log(`Prompt Retrieval Budget Test Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All prompt retrieval budget invariants verified successfully.");
}
