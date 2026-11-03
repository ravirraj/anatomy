// Tests Cartograph Minimal Production Stabilization Invariants:
// 1. Explicit file retrieval priority and directory-cap exemption.
// 2. Precise word-family inflection rejection (no false accidental substrings).
// 3. Domain concept grounding requirement (generic words cannot manufacture evidence).
// 4. Budget consistency in UI actions.
// 5. Iterative coverage passes correctly handle category drills.

import { createHash } from "node:crypto";
import {
  sameFamily,
  retrieveGroundedContext,
  type Db,
  computeEvidenceLimits,
  DEFAULT_BUDGET,
} from "../lib/ai/retrieval.ts";
import { MODELS } from "../lib/ai/client.ts";
import { retrieveWithCoverageLoop } from "../lib/ai/retrieval-loop.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

function check(cond: boolean, okMsg: string, failMsg: string) {
  if (cond) pass(okMsg);
  else fail(failMsg);
}

const FILLER = (line: number): string => `// line ${line}`;

function buildMockDb(files: { id: string; path: string; lines?: number; role?: string }[]) {
  const rows = files.map((f) => {
    const total = f.lines ?? 60;
    const text = Array.from({ length: total }, (_, i) => FILLER(i + 1)).join("\n") + "\n";
    const hash = createHash("sha256").update(text).digest("hex");
    return {
      id: f.id,
      path: f.path,
      hash,
      lines: total,
      content_status: "stored",
      analysis_id: "analysis_stab",
      file_roles: f.role ? [{ role: f.role, source: "convention" }] : [],
    };
  });

  return {
    from(table: string) {
      if (table === "files") {
        return {
          select: () => ({
            eq: (_f: string, val: string) => ({
              is: () => Promise.resolve({ data: rows, error: null }),
              maybeSingle: async () => {
                const file = rows.find((f) => f.id === val);
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
      if (table === "symbols" || table === "routes" || table === "manifests" || table === "dependencies" || table === "config_references" || table === "entry_points") {
        return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
      }
      if (table === "edges") {
        return { select: () => ({ eq: () => ({ or: () => Promise.resolve({ data: [], error: null }) }) }) };
      }
      if (table === "file_contents") {
        return {
          select: () => ({
            eq: () => ({
              eq: (_col: string, hash: string) => ({
                maybeSingle: async () => {
                  const r = rows.find((row) => row.hash === hash);
                  if (!r) return { data: null, error: null };
                  const text = Array.from({ length: r.lines }, (_, i) => FILLER(i + 1)).join("\n") + "\n";
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
      if (table === "analyses") {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({
                data: { projects: { repo_name: "lithos_ui", repo_owner: "lithosui" } },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`Unhandled table: ${table}`);
    },
  } as unknown as Db;
}

console.log("=== 1. Word Family Inflection Precision ===");
{
  check(sameFamily("user", "users"), "user ~ users accepted (plural)", "user ~ users rejected");
  check(sameFamily("authorize", "authorized"), "authorize ~ authorized accepted (-d)", "authorize ~ authorized rejected");
  check(sameFamily("authenticate", "authentication"), "authenticate ~ authentication accepted (-ation)", "authenticate ~ authentication rejected");
  check(!sameFamily("stripe", "string"), "stripe ~ string strictly rejected", "stripe ~ string incorrectly accepted");
  check(!sameFamily("stripe", "stripExt"), "stripe ~ stripExt strictly rejected", "stripe ~ stripExt incorrectly accepted");
  check(!sameFamily("billing", "billboard"), "billing ~ billboard strictly rejected", "billing ~ billboard incorrectly accepted");
}

console.log("");
console.log("=== 2. Explicit File Retrieval Boost & Directory Cap Exemption ===");
{
  // Set up 15 files in src/components/ui/ that match generic tokens, plus 1 explicit cli file
  const testFiles = [
    { id: "cli_add", path: "src/cli/add.ts", lines: 50 },
    ...Array.from({ length: 15 }, (_, i) => ({
      id: `ui_${i}`,
      path: `src/components/ui/Button${i}.tsx`,
      lines: 50,
    })),
  ];
  const db = buildMockDb(testFiles);

  const res = await retrieveGroundedContext(
    db,
    "analysis_stab",
    "Where is the CLI command defined in src/cli/add.ts?",
    { maxFilesPerDirectory: 4 },
  );

  check(res.windows.length > 0, "retrieved windows for explicit query", "no windows retrieved");
  check(
    res.windows[0]?.path === "src/cli/add.ts",
    "explicitly named src/cli/add.ts is ranked first",
    `first window was ${res.windows[0]?.path}`,
  );
  check(
    res.windows[0]?.reason?.includes("explicitly named") === true,
    "explicitly named file carries 'explicitly named' reason",
    `reason: ${res.windows[0]?.reason}`,
  );
}

console.log("");
console.log("=== 3. Generic Keyword Abstention (Feature Absence) ===");
{
  // Repository with only generic controller/service files, but NO billing or stripe
  const testFiles = [
    { id: "f1", path: "src/controllers/userController.ts", role: "controller", lines: 50 },
    { id: "f2", path: "src/services/dataService.ts", role: "service", lines: 50 },
    { id: "f3", path: "src/middleware/authMiddleware.ts", role: "middleware", lines: 50 },
  ];
  const db = buildMockDb(testFiles);

  const resBilling = await retrieveGroundedContext(
    db,
    "analysis_stab",
    "How is billing and invoice generation handled?",
  );
  check(
    resBilling.windows.length === 0 && resBilling.insufficientEvidence,
    "billing query with no domain matches abstains cleanly with 0 windows",
    `billing returned ${resBilling.windows.length} windows (insufficient: ${resBilling.insufficientEvidence})`,
  );

  const resStripe = await retrieveGroundedContext(
    db,
    "analysis_stab",
    "Where is the webhook receiver for Stripe events defined?",
  );
  check(
    resStripe.windows.length === 0 && resStripe.insufficientEvidence,
    "stripe query with no domain matches abstains cleanly with 0 windows",
    `stripe returned ${resStripe.windows.length} windows (insufficient: ${resStripe.insufficientEvidence})`,
  );

  // Repo name tokens ("lithos", "ui") do not count as domain matches
  const resRepo = await retrieveGroundedContext(
    db,
    "analysis_stab",
    "How does lithos ui manage subscription billing?",
  );
  check(
    resRepo.windows.length === 0 && resRepo.insufficientEvidence,
    "repo brand tokens filtered from domain matching; absent feature still abstains",
    `repo query returned ${resRepo.windows.length} windows (insufficient: ${resRepo.insufficientEvidence})`,
  );
}

console.log("");
console.log("=== 4. Budget Consistency for Models ===");
{
  const limitsDefault = computeEvidenceLimits({}, "query");
  const limitsModel = computeEvidenceLimits({ model: MODELS.question }, "query");
  check(
    limitsModel.isProfileBound,
    `computeEvidenceLimits with model=${MODELS.question} is profile-bound`,
    "limits not profile bound",
  );
  check(
    limitsModel.maxTokens > 0 && limitsModel.maxCharacters > 0,
    `limits computed positive allocations (chars=${limitsModel.maxCharacters}, tokens=${limitsModel.maxTokens})`,
    "zero or negative limits",
  );
}

console.log("");
console.log("=== 5. Iterative Coverage Drill Invariants ===");
{
  const testFiles = [
    {
      id: "auth_ctl",
      path: "backend/src/controllers/sessionGuard.js",
      role: "controller",
      lines: 70,
    },
    {
      id: "auth_mid",
      path: "src/middlewares/authenticate.js",
      role: "middleware",
      lines: 70,
    },
  ];
  const db = buildMockDb(testFiles);
  const loop = await retrieveWithCoverageLoop(
    db,
    "analysis_stab",
    "How does authentication middleware work in this project?",
    { adaptive: false },
  );
  check(
    loop.result.windows.length > 0,
    "coverage loop retrieves evidence without false abstention on valid concepts",
    `loop windows: ${loop.result.windows.length}`,
  );
}

console.log("");
console.log("=== 6. Q2 Packaging Budget Starvation Protection ===");
{
  const testFiles = [
    { id: "cli_add", path: "src/cli/add.ts", lines: 60 },
  ];
  const db = buildMockDb(testFiles);
  const oversizedPkg = "### Dependencies:\n" + Array.from({ length: 150 }, (_, i) => `- package-${i}@1.0.0 (direct)\n`).join("");
  const limits = computeEvidenceLimits(
    { model: MODELS.question },
    "How does src/cli/add.ts resolve transitive dependencies?",
    oversizedPkg,
  );

  check(
    limits.maxCharacters >= 3000,
    `code evidence capacity is reserved despite oversized packaging (maxCharacters=${limits.maxCharacters})`,
    `code capacity starved: maxCharacters=${limits.maxCharacters}`,
  );
  check(
    limits.reservedCharacters + limits.maxCharacters <= 13500,
    `prompt budget ceiling is strictly preserved (reserved=${limits.reservedCharacters}, maxCode=${limits.maxCharacters})`,
    `prompt budget overflow: sum=${limits.reservedCharacters + limits.maxCharacters}`,
  );

  const res = await retrieveGroundedContext(
    db,
    "analysis_stab",
    "How does src/cli/add.ts resolve transitive dependencies?",
    { model: MODELS.question },
  );
  check(
    res.windows.length > 0 && res.windows[0]?.path === "src/cli/add.ts",
    "explicitly named file is retrieved without packaging budget starvation",
    `retrieval failed: windows=${res.windows.length}`,
  );
}

console.log("");
console.log("=== 7. Q3 Configuration Defaults Retrieval ===");
{
  const testFiles = [
    { id: "cli_utils", path: "src/cli/utils.ts", lines: 80 },
    { id: "logo", path: "src/components/ui/LithosLogo.tsx", lines: 100 },
  ];
  // Custom mock db with DEFAULT_CONFIG in utils.ts and LithosLogo in LithosLogo.tsx
  const rows = testFiles.map((f) => {
    const text = Array.from({ length: f.lines }, (_, i) => FILLER(i + 1)).join("\n") + "\n";
    const hash = createHash("sha256").update(text).digest("hex");
    return {
      id: f.id,
      path: f.path,
      hash,
      lines: f.lines,
      content_status: "stored",
      analysis_id: "analysis_stab",
      file_roles: [],
    };
  });
  const symbols = [
    { file_id: "cli_utils", name: "DEFAULT_CONFIG", kind: "const", line: 33, exported: true },
    { file_id: "cli_utils", name: "getConfig", kind: "const", line: 44, exported: true },
    { file_id: "logo", name: "LithosLogo", kind: "const", line: 20, exported: true },
  ];
  const dbCustom = {
    from(table: string) {
      if (table === "files") {
        return {
          select: () => ({
            eq: (_f: string, val: string) => ({
              is: () => Promise.resolve({ data: rows, error: null }),
              maybeSingle: async () => {
                const file = rows.find((f) => f.id === val);
                return {
                  data: file ? { ...file, organization_id: "org_test", analysis: { commit_sha: "sha1", project: { repo_owner: "lithosui", repo_name: "lithos_ui" } } } : null,
                  error: null,
                };
              },
            }),
          }),
        };
      }
      if (table === "symbols") {
        return { select: () => ({ eq: () => Promise.resolve({ data: symbols, error: null }) }) };
      }
      if (table === "routes" || table === "manifests" || table === "dependencies" || table === "config_references" || table === "entry_points") {
        return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
      }
      if (table === "edges") {
        return { select: () => ({ eq: () => ({ or: () => Promise.resolve({ data: [], error: null }) }) }) };
      }
      if (table === "file_contents") {
        return {
          select: () => ({
            eq: () => ({
              eq: (_col: string, hash: string) => ({
                maybeSingle: async () => {
                  const r = rows.find((row) => row.hash === hash);
                  if (!r) return { data: null, error: null };
                  const text = Array.from({ length: r.lines }, (_, i) => FILLER(i + 1)).join("\n") + "\n";
                  return {
                    data: { payload: `\\x${Buffer.from(text, "utf8").toString("hex")}`, size: Buffer.byteLength(text, "utf8") },
                    error: null,
                  };
                },
              }),
            }),
          }),
        };
      }
      if (table === "analyses") {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { projects: { repo_name: "lithos_ui", repo_owner: "lithosui" } }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`Unhandled table: ${table}`);
    },
  } as unknown as Db;

  const res = await retrieveGroundedContext(
    dbCustom,
    "analysis_stab",
    "What configuration defaults are used by Lithos?",
    { model: MODELS.question },
  );

  check(
    res.windows.length > 0 && res.windows[0]?.path === "src/cli/utils.ts",
    "configuration defaults query retrieves src/cli/utils.ts as the top result",
    `top result was: ${res.windows[0]?.path} (count=${res.windows.length})`,
  );
  check(
    res.windows[0]?.score > (res.windows.find((w) => w.path.includes("Logo"))?.score ?? 0),
    "technical configuration symbols outrank repo brand logo matches",
    `scores: utils=${res.windows[0]?.score}, logo=${res.windows.find((w) => w.path.includes("Logo"))?.score}`,
  );
}

console.log("");
console.log("=== 8. Verification of Behaviors 1-8 ===");
{
  const { planQuestion } = await import("../lib/ai/planner.ts");
  const { verifyCitations } = await import("../lib/ai/citations.ts");

  // 1. Multi-file CLI execution-flow question retrieves CLI implementation evidence rather than UI command components
  const testFiles = [
    { id: "cli_index", path: "src/cli/index.ts", lines: 40 },
    { id: "cli_add", path: "src/cli/add.ts", lines: 140 },
    { id: "cli_init", path: "src/cli/init.ts", lines: 70 },
    { id: "cli_utils", path: "src/cli/utils.ts", lines: 80 },
    { id: "ui_command", path: "src/components/ui/command/Command.tsx", lines: 120 },
    { id: "ui_button", path: "src/components/ui/Button.tsx", lines: 60 },
  ];
  const rows = testFiles.map((f) => {
    const text = Array.from({ length: f.lines }, (_, i) => FILLER(i + 1)).join("\n") + "\n";
    const hash = createHash("sha256").update(text).digest("hex");
    return {
      id: f.id,
      path: f.path,
      hash,
      lines: f.lines,
      content_status: "stored",
      analysis_id: "analysis_stab",
      file_roles: [],
    };
  });
  const symbols = [
    { file_id: "ui_command", name: "Command", kind: "const", line: 20, exported: true },
    { file_id: "ui_command", name: "CommandInput", kind: "const", line: 40, exported: true },
    { file_id: "ui_command", name: "CommandList", kind: "const", line: 60, exported: true },
    { file_id: "cli_index", name: "main", kind: "function", line: 10, exported: true },
    { file_id: "cli_add", name: "add", kind: "const", line: 25, exported: true },
    { file_id: "cli_init", name: "init", kind: "const", line: 15, exported: true },
    { file_id: "cli_utils", name: "getConfig", kind: "const", line: 30, exported: true },
  ];
  const dbCli = {
    from(table: string) {
      if (table === "files") {
        return {
          select: () => ({
            eq: (_f: string, val: string) => ({
              is: () => Promise.resolve({ data: rows, error: null }),
              maybeSingle: async () => {
                const file = rows.find((f) => f.id === val);
                return {
                  data: file ? { ...file, organization_id: "org_test", analysis: { commit_sha: "sha1", project: { repo_owner: "lithosui", repo_name: "lithos_ui" } } } : null,
                  error: null,
                };
              },
            }),
          }),
        };
      }
      if (table === "symbols") {
        return { select: () => ({ eq: () => Promise.resolve({ data: symbols, error: null }) }) };
      }
      if (table === "routes" || table === "manifests" || table === "dependencies" || table === "config_references" || table === "entry_points") {
        return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
      }
      if (table === "edges") {
        return { select: () => ({ eq: () => ({ or: () => Promise.resolve({ data: [], error: null }) }) }) };
      }
      if (table === "file_contents") {
        return {
          select: () => ({
            eq: () => ({
              eq: (_col: string, hash: string) => ({
                maybeSingle: async () => {
                  const r = rows.find((row) => row.hash === hash);
                  if (!r) return { data: null, error: null };
                  const text = Array.from({ length: r.lines }, (_, i) => FILLER(i + 1)).join("\n") + "\n";
                  return {
                    data: { payload: `\\x${Buffer.from(text, "utf8").toString("hex")}`, size: Buffer.byteLength(text, "utf8") },
                    error: null,
                  };
                },
              }),
            }),
          }),
        };
      }
      if (table === "analyses") {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { projects: { repo_name: "lithos_ui", repo_owner: "lithosui" } }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`Unhandled table: ${table}`);
    },
  } as unknown as Db;

  const resCliFlow = await retrieveGroundedContext(
    dbCli,
    "analysis_stab",
    "How does the CLI execute commands across modules?",
    { model: MODELS.question },
  );

  check(
    resCliFlow.windows.length > 0 &&
      resCliFlow.windows[0]?.path.startsWith("src/cli/") &&
      !resCliFlow.windows.some((w) => w.path.includes("Command.tsx")),
    "Behavior 1: CLI execution-flow question retrieves CLI implementation evidence rather than UI command components",
    `top file was: ${resCliFlow.windows[0]?.path}, files: ${resCliFlow.windows.map((w) => w.path).join(", ")}`,
  );

  // 2. Direct file/path question retrieves the requested file
  const resDirectPath = await retrieveGroundedContext(
    dbCli,
    "analysis_stab",
    "Where is src/components/ui/command/Command.tsx defined?",
    { model: MODELS.question },
  );
  check(
    resDirectPath.windows.length > 0 && resDirectPath.windows[0]?.path === "src/components/ui/command/Command.tsx",
    "Behavior 2: Direct file/path question retrieves the requested file",
    `retrieved: ${resDirectPath.windows[0]?.path}`,
  );

  // 3. Normal frontend component question does not unnecessarily trigger CLI coverage
  const planButton = planQuestion("How does the Button component work?");
  check(
    planButton.expectedEvidence.includes("frontend") && !planButton.expectedEvidence.includes("cli"),
    "Behavior 3: Normal frontend component question does not unnecessarily trigger CLI coverage",
    `expected: ${JSON.stringify(planButton.expectedEvidence)}`,
  );

  // 4. Component installation question does not get misclassified as a CLI command
  const planInstall = planQuestion("How do I install a component?");
  check(
    planInstall.intent === "usage-integration",
    "Behavior 4: Component installation question classified as usage-integration, not cli-execution",
    `intent: ${planInstall.intent}`,
  );

  // 5. Safe trailing punctuation normalization
  const { extractQueryTokens } = await import("../lib/ai/retrieval.ts");
  const pTokens = extractQueryTokens("What configuration defaults are used by Lithos.");
  check(
    pTokens.includes("lithos") && !pTokens.includes("lithos."),
    "Fix C: Safe trailing punctuation normalization removes trailing dot without corrupting word",
    `tokens: ${JSON.stringify(pTokens)}`,
  );
  const pathWithDot = extractQueryTokens("Where is src/cli/add.ts.");
  check(
    pathWithDot.includes("src/cli/add.ts"),
    "Fix C: Path ending with period is normalized to exact path",
    `tokens: ${JSON.stringify(pathWithDot)}`,
  );

  // Behavior 5: Unsupported question abstains instead of inventing an answer
  const { INSUFFICIENT_EVIDENCE_ANSWER } = await import("../lib/ai/tasks.ts");
  const resUnsupported = await retrieveGroundedContext(
    dbCli,
    "analysis_stab",
    "Where is the Stripe payment webhook handler and billing checkout session controller located?",
    { model: MODELS.question },
  );
  check(
    resUnsupported.windows.length === 0 && resUnsupported.insufficientEvidence === true,
    "Behavior 5: Unsupported question abstains cleanly with 0 windows and insufficientEvidence: true",
    `windows=${resUnsupported.windows.length}, insufficientEvidence=${resUnsupported.insufficientEvidence}`,
  );

  // Behavior 6: Citation validation rejects unsupported claims and accepts grounded citations
  const allowedMap = new Map([
    ["src/cli/add.ts", { lines: 50, contentHash: "hash1" }],
  ]);
  const validCit = verifyCitations("Defined in `src/cli/add.ts#L10-L20`.", allowedMap);
  check(validCit.paths.length === 0, "Behavior 6: Citation validation accepts properly grounded citation", "Citation validation rejected valid citation");
  const invalidCit = verifyCitations("Defined in `src/cli/fake.ts#L1-L10`.", allowedMap);
  check(invalidCit.paths.length === 1, "Behavior 6: Citation validation rejects unsupported citation", "Citation validation accepted unsupported citation");

  // Behavior 7: Manifest quarantine and tenant isolation remain intact
  type ManifestFile = { path: string; content_status: "stored" | "absent" | "excluded" | "legacy_unclassified"; analysis_id: string; rendered?: boolean };
  const quarantinedManifests = new Map<string, ManifestFile>([
    ["Cargo.toml", { path: "Cargo.toml", content_status: "excluded", analysis_id: "analysis_stab", rendered: true }],
  ]);
  const mRes = verifyCitations("Reference: `Cargo.toml:1-10`", allowedMap, {
    manifestsByPath: quarantinedManifests,
    analysisId: "analysis_stab",
  });
  check(mRes.paths.length === 1, "Behavior 7: Manifest quarantine strictly rejects citation to excluded manifest", "Quarantined manifest was accepted");

  const foreignManifests = new Map<string, ManifestFile>([
    ["package.json", { path: "package.json", content_status: "stored", analysis_id: "other_org_analysis", rendered: true }],
  ]);
  const tRes = verifyCitations("Reference: `package.json`", allowedMap, {
    manifestsByPath: foreignManifests,
    analysisId: "analysis_stab",
  });
  check(tRes.paths.length === 1, "Behavior 7: Tenant isolation strictly rejects cross-analysis manifest citation", "Cross-analysis manifest was accepted");

  // Behavior 8: Prompt budgets remain within both character and token limits
  const rendChars = resCliFlow.renderedCharacters ?? resCliFlow.totalCharacters;
  const totTokens = resCliFlow.totalTokens ?? 0;
  check(
    rendChars <= 13500 && totTokens <= 4500,
    `Behavior 8: Prompt budgets strictly within limits (renderedChars=${rendChars} <= 13500, tokens=${totTokens} <= 4500)`,
    `budget exceeded: chars=${rendChars}, tokens=${totTokens}`,
  );
}

console.log("");
let failed = 0;
for (const r of results) {
  console.log(r);
  if (r.startsWith("FAIL")) failed++;
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll stabilization invariants passed cleanly.");
}
