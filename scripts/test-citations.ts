// Verifies citation checking: an answer that names a file not in the analysis
// is rejected, and honest answers pass.
//
//   node scripts/test-citations.ts

import {
  pathTokens,
  verifyCitations,
  CitationError,
  parseCitation,
  extractCitations,
  isRouteStylePath,
  findMatchingPath,
  type FileEvidence,
  type ManifestFile,
} from "../lib/ai/citations.ts";
import { explainFile } from "../lib/ai/tasks.ts";
import type { FileInput } from "../lib/ai/prompts.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

const allowed = new Set([
  "lib/ai/tasks.ts",
  "lib/ai/prompts.ts",
  "components/explanation-text.tsx",
  "app/(workspace)/analyses/[id]/actions.ts",
]);

{
  // Code-span mentions of real paths pass.
  const bad = verifyCitations("See `lib/ai/tasks.ts` and `components/explanation-text.tsx`.", allowed);
  if (bad.paths.length === 0) pass("real code-span paths are allowed");
  else fail(`real paths flagged: ${JSON.stringify(bad.paths)}`);
}

{
  // A made-up filename spliced into an honest answer is rejected — the exact
  // acceptance criterion from TODO §3.1.
  const bad = verifyCitations(
    "This file holds one helper. It is used by `does-not-exist.ts`.",
    allowed,
  );
  if (bad.paths.length === 1 && bad.paths[0] === "does-not-exist.ts") {
    pass("an invented path is caught and named");
  } else {
    fail(`invented path not caught: ${JSON.stringify(bad.paths)}`);
  }
}

{
  // Bare (unbackticked) paths are caught too — the renderer links them.
  const bad = verifyCitations("Read lib/ai/prompts.ts for the wording.", allowed);
  if (bad.paths.length === 0) pass("a real bare path is allowed");
  else fail(`real bare path flagged: ${JSON.stringify(bad.paths)}`);
}

{
  const bad = verifyCitations("Read lib/ai/fake.ts for the wording.", allowed);
  if (bad.paths.length === 1 && bad.paths[0] === "lib/ai/fake.ts") {
    pass("an invented bare path is caught");
  } else {
    fail(`invented bare path not caught: ${JSON.stringify(bad.paths)}`);
  }
}

{
  // Punctuation-adjacent mentions are not false positives.
  const bad = verifyCitations("See `lib/ai/tasks.ts`.", allowed);
  if (bad.paths.length === 0) pass("trailing punctuation is stripped");
  else fail(`punctuation-adjacent real path flagged: ${JSON.stringify(bad.paths)}`);
}

{
  // Bold and inline code inside bold are still scanned.
  const bad = verifyCitations("See **`lib/ai/tasks.ts`** and **`lib/ai/ghost.ts`**.", allowed);
  if (bad.paths.length === 1 && bad.paths[0] === "lib/ai/ghost.ts") {
    pass("invented path inside bold code span is caught");
  } else {
    fail(`bold code-span check wrong: ${JSON.stringify(bad.paths)}`);
  }
}

{
  // Italics lose their markers and don't create false positives.
  const bad = verifyCitations("The *lib/ai/tasks.ts* file does the work.", allowed);
  if (bad.paths.length === 0) pass("italic real path allowed");
  else fail(`italic real path flagged: ${JSON.stringify(bad.paths)}`);
}

{
  // Relative forms normalize to stored paths.
  const bad = verifyCitations("See `./lib/ai/tasks.ts`.", allowed);
  if (bad.paths.length === 0) pass("relative form normalizes");
  else fail(`relative form flagged: ${JSON.stringify(bad.paths)}`);
}

{
  // A directory that isn't itself in the allowed set is still flagged.
  const bad = verifyCitations("See `lib/ai/`.", allowed);
  if (bad.paths.length === 1 && bad.paths[0] === "lib/ai/") {
    pass("a directory not in the allowed set is flagged");
  } else {
    fail(`directory check wrong: ${JSON.stringify(bad.paths)}`);
  }
}

{
  // pathTokens collects candidates without the allowed-set gate.
  const tokens = pathTokens("`lib/ai/tasks.ts` and `components/explanation-text.tsx`");
  if (tokens.length === 2 && tokens[0] === "lib/ai/tasks.ts") pass("pathTokens extracts code spans");
  else fail(`pathTokens wrong: ${JSON.stringify(tokens)}`);
}

{
  // CitationError names the offending paths.
  try {
    throw new CitationError(["ghost.ts", "phantom.ts"]);
  } catch (error) {
    if (error instanceof CitationError && error.paths.join(",") === "ghost.ts,phantom.ts") {
      pass("CitationError carries its paths");
    } else {
      fail(`CitationError malformed: ${(error as Error).message}`);
    }
  }
}

{
  // A cache hit is verified before being served — no model call happens.
  const question: FileInput = {
    path: "lib/thing.ts",
    hash: "abc123",
    role: null,
    reachedBy: null,
    exports: [],
    imports: [],
    importedBy: [],
  };
  const badCache = {
    async read() {
      return "This answer names `lib/ghost.ts`, which was never parsed.";
    },
    async write() {
      fail("a failing answer must never be written to the cache");
    },
    async delete() {
      // explainFile's verification refuses here without healing, so nothing
      // to delete in this scenario.
    },
  };
  let threw = false;
  try {
    await explainFile(question, { cache: badCache, source: async () => "export const thing = 1;" });
  } catch (error) {
    threw = error instanceof CitationError && error.paths.join(",") === "lib/ghost.ts";
  }
  if (threw) pass("a cached answer with an invented path is refused");
  else fail("a cached bad answer was served");
}

{
  // parseCitation handles all supported line range formats.
  const c1 = parseCitation("lib/ai/tasks.ts#L10-L25");
  if (c1.path === "lib/ai/tasks.ts" && c1.startLine === 10 && c1.endLine === 25) {
    pass("parseCitation parses #L10-L25 format");
  } else {
    fail(`parseCitation #L10-L25 failed: ${JSON.stringify(c1)}`);
  }

  const c2 = parseCitation("lib/ai/tasks.ts:15-30");
  if (c2.path === "lib/ai/tasks.ts" && c2.startLine === 15 && c2.endLine === 30) {
    pass("parseCitation parses :15-30 format");
  } else {
    fail(`parseCitation :15-30 failed: ${JSON.stringify(c2)}`);
  }

  const c3 = parseCitation("lib/ai/tasks.ts#L42");
  if (c3.path === "lib/ai/tasks.ts" && c3.startLine === 42 && c3.endLine === 42) {
    pass("parseCitation parses single line #L42 format");
  } else {
    fail(`parseCitation #L42 failed: ${JSON.stringify(c3)}`);
  }

  const c4 = parseCitation("./lib/ai/tasks.ts");
  if (c4.path === "lib/ai/tasks.ts" && c4.startLine === undefined) {
    pass("parseCitation normalizes bare path without line numbers");
  } else {
    fail(`parseCitation bare path failed: ${JSON.stringify(c4)}`);
  }
}

{
  // extractCitations extracts distinct citations with line ranges from markdown.
  const md = "See `lib/ai/tasks.ts#L10-L25` and also `components/explanation-text.tsx:5-15`. Again `lib/ai/tasks.ts#L10-L25`.";
  const extracted = extractCitations(md);
  if (extracted.length === 2 && extracted[0].startLine === 10 && extracted[1].startLine === 5) {
    pass("extractCitations extracts and deduplicates citations");
  } else {
    fail(`extractCitations failed: ${JSON.stringify(extracted)}`);
  }
}

{
  // Line range checks with Map<string, FileEvidence>
  const evidenceMap = new Map<string, FileEvidence>([
    ["lib/ai/tasks.ts", { lines: 100, contentHash: "hash1" }],
    ["components/explanation-text.tsx", { lines: 50, contentHash: "hash2" }],
  ]);

  // Valid citation within file line bounds
  const valid = verifyCitations("See `lib/ai/tasks.ts#L10-L25` and `components/explanation-text.tsx#L5-L50`.", evidenceMap);
  if (valid.paths.length === 0) {
    pass("valid line ranges within file bounds are accepted");
  } else {
    fail(`valid line ranges flagged: ${JSON.stringify(valid)}`);
  }

  // Out of bounds end line (> maxLines)
  const outOfBounds = verifyCitations("See `lib/ai/tasks.ts#L10-L150`.", evidenceMap);
  if (outOfBounds.paths.length === 1 && outOfBounds.paths[0] === "lib/ai/tasks.ts#L10-L150") {
    pass("out of bounds line range (> file lines) is rejected");
  } else {
    fail(`out of bounds line range not caught: ${JSON.stringify(outOfBounds)}`);
  }

  // Inverted line range (start > end)
  const inverted = verifyCitations("See `lib/ai/tasks.ts#L30-L20`.", evidenceMap);
  if (inverted.paths.length === 1) {
    pass("inverted line range (start > end) is rejected");
  } else {
    fail(`inverted line range not caught: ${JSON.stringify(inverted)}`);
  }

  // Start line < 1
  const zeroLine = verifyCitations("See `lib/ai/tasks.ts#L0-L20`.", evidenceMap);
  if (zeroLine.paths.length === 1) {
    pass("zero line number (start < 1) is rejected");
  } else {
    fail(`zero line number not caught: ${JSON.stringify(zeroLine)}`);
  }

  // Unknown file with line range
  const unknownWithRange = verifyCitations("See `lib/ai/unknown.ts#L10-L20`.", evidenceMap);
  if (unknownWithRange.paths.length === 1 && unknownWithRange.paths[0] === "lib/ai/unknown.ts#L10-L20") {
    pass("unknown file with line range is rejected");
  } else {
    fail(`unknown file with line range not caught: ${JSON.stringify(unknownWithRange)}`);
  }
}

{
  // Regression test suite for Phase 5 citation extraction and verification hardening
  const evidenceMap = new Map<string, FileEvidence>([
    ["lib/ai/tasks.ts", { lines: 100, contentHash: "hash-tasks" }],
    ["components/explanation-text.tsx", { lines: 50, contentHash: "hash-expl" }],
  ]);
  const allAnalysisFiles = new Set<string>([
    "lib/ai/tasks.ts",
    "components/explanation-text.tsx",
    "package.json",
    "src/App.tsx",
  ]);

  // 1. Valid file citation
  const v1 = verifyCitations("See `lib/ai/tasks.ts`.", evidenceMap, { allAnalysisFiles });
  if (v1.paths.length === 0) pass("valid file citation passes");
  else fail(`valid file citation failed: ${JSON.stringify(v1)}`);

  // 2. Valid citation with line range
  const v2 = verifyCitations("See `lib/ai/tasks.ts#L10-L25`.", evidenceMap, { allAnalysisFiles });
  if (v2.paths.length === 0) pass("valid citation with line range passes");
  else fail(`valid citation with line range failed: ${JSON.stringify(v2)}`);

  // 3. Unknown explicit citation
  const v3 = verifyCitations("See `lib/ai/unknown-file.ts`.", evidenceMap, { allAnalysisFiles });
  if (v3.paths.length === 1 && v3.paths[0] === "lib/ai/unknown-file.ts") {
    pass("unknown explicit citation is rejected");
  } else {
    fail(`unknown explicit citation not caught: ${JSON.stringify(v3)}`);
  }

  // 4. Directory mentioned in prose
  const v4 = verifyCitations(
    "The code is structured into src/components/ui/ and src/tests/ directories.",
    evidenceMap,
    { allAnalysisFiles },
  );
  if (v4.paths.length === 0) pass("directory mentioned in prose is not flagged");
  else fail(`directory mentioned in prose flagged: ${JSON.stringify(v4)}`);

  // 5. npm package mentioned in prose
  const v5 = verifyCitations(
    "We use @testing-library/react and @supabase/supabase-js for testing.",
    evidenceMap,
    { allAnalysisFiles },
  );
  if (v5.paths.length === 0) pass("npm package mentioned in prose is not flagged");
  else fail(`npm package mentioned in prose flagged: ${JSON.stringify(v5)}`);

  // 6. Placeholder path
  const v6 = verifyCitations(
    "Documentation is stored at `src/docs/examples/<component>/` for each item.",
    evidenceMap,
    { allAnalysisFiles },
  );
  if (v6.paths.length === 0) pass("placeholder path is not flagged");
  else fail(`placeholder path flagged: ${JSON.stringify(v6)}`);

  // 7. package.json mentioned in prose
  const v7 = verifyCitations(
    "Check package.json for npm scripts and dependencies.",
    evidenceMap,
    { allAnalysisFiles },
  );
  if (v7.paths.length === 0) pass("package.json mentioned in prose is not flagged");
  else fail(`package.json mentioned in prose flagged: ${JSON.stringify(v7)}`);

  // 8. Paths inside code blocks
  const v8 = verifyCitations(
    "Run tests:\n```bash\npnpm test\ncat src/fake/path.ts\nnpm install @testing-library/react\n```\nDone.",
    evidenceMap,
    { allAnalysisFiles },
  );
  if (v8.paths.length === 0) pass("paths inside fenced code blocks are not flagged");
  else fail(`paths inside code blocks flagged: ${JSON.stringify(v8)}`);

  // 9. Multiple citations
  const v9 = verifyCitations(
    "See `lib/ai/tasks.ts#L10-L25` and `components/explanation-text.tsx#L5-L30`.",
    evidenceMap,
    { allAnalysisFiles },
  );
  if (v9.paths.length === 0) pass("multiple valid citations pass");
  else fail(`multiple valid citations failed: ${JSON.stringify(v9)}`);

  // 10. Malformed citation with invalid line bounds
  const v10 = verifyCitations("Check `lib/ai/tasks.ts#L0-L10`.", evidenceMap, { allAnalysisFiles });
  if (v10.paths.length === 1) pass("malformed line bound citation is caught");
  else fail(`malformed line bound citation not caught: ${JSON.stringify(v10)}`);

  // 11. Citation outside retrieved evidence (file exists in analysis but not in retrieved evidence for line ranges)
  const v11 = verifyCitations(
    "See `src/App.tsx#L10-L20`.",
    evidenceMap,
    { allAnalysisFiles },
  );
  if (v11.paths.length === 1 && v11.paths[0] === "src/App.tsx#L10-L20") {
    pass("line-range citation outside retrieved evidence is rejected");
  } else {
    fail(`citation outside retrieved evidence not caught: ${JSON.stringify(v11)}`);
  }

  // 12. Model-generated fabricated citation
  const v12 = verifyCitations(
    "Look at `src/auth/jwt-phantom.ts#L1-L20` for token validation.",
    evidenceMap,
    { allAnalysisFiles },
  );
  if (v12.paths.length === 1 && v12.paths[0] === "src/auth/jwt-phantom.ts#L1-L20") {
    pass("model-generated fabricated citation is rejected");
  } else {
    fail(`fabricated citation not caught: ${JSON.stringify(v12)}`);
  }

  // 13. EXACT FAILURE REPRODUCTION: The production-like failure from onboarding query
  const failingAnswer = `
The repository is organized as follows:
- \`src/components/ui/\` contains reusable UI components.
- \`src/docs/examples/\` contains example documentation.
- \`src/components/blocks/\` contains block layout items.
- \`src/docs/examples/<component>/\` is a template directory.
- \`src/tests/\` contains integration tests.
- \`@testing-library/react\` is used for component assertions.
- \`package.json\` lists the development dependencies and scripts.
You can run tests (e.g. pnpm test) to verify changes.
Check \`lib/ai/tasks.ts#L10-L25\` for task execution.
`;
  const manifestsByPath = new Map<string, ManifestFile>([
    ["package.json", { path: "package.json", content_status: "stored", analysis_id: "test-analysis", rendered: true }],
  ]);
  const repro = verifyCitations(failingAnswer, evidenceMap, {
    allAnalysisFiles,
    manifestsByPath,
    analysisId: "test-analysis",
  });
  if (repro.paths.length === 0) {
    pass("exact onboarding failure text passes cleanly without false positives");
  } else {
    fail(`exact onboarding failure text still flagged: ${JSON.stringify(repro.paths)}`);
  }
}

// --- Route/api endpoints are not file citations (live Q&A regression) ---
console.log("");
console.log("=== route paths are not file citations ===");

{
  // Regression: the verified Q&A answer for the authsphere analysis cited the
  // SDK REST endpoints `/sdk/register` and `/sdk/authorize`, which live in the
  // retrieved controller source but are not files. Endpoint mentions must not
  // enter file verification; invented extension-bearing paths still must.
  const evidenceMap = new Map<string, FileEvidence>([
    ["backend/src/controllers/sdk.controller.js", { lines: 180, contentHash: "hash-sdk" }],
  ]);
  const allAnalysisFiles = new Set<string>(["backend/src/controllers/sdk.controller.js"]);

  const ok = verifyCitations(
    "Registering starts at the SDK endpoints `POST /sdk/register` and `/sdk/authorize`, handled in `backend/src/controllers/sdk.controller.js#L10-L40`.",
    evidenceMap,
    { allAnalysisFiles },
  );
  if (ok.paths.length === 0) {
    pass("endpoint mentions in code spans pass verification");
  } else {
    fail(`endpoint mentions still flagged: ${JSON.stringify(ok.paths)}`);
  }

  // A route shape paired with line numbers is an explicit citation attempt and stays bound.
  const ranged = verifyCitations(
    "See `/sdk/register#L10-L20` and `backend/src/controllers/sdk.controller.js#L10-L20`.",
    evidenceMap,
    { allAnalysisFiles },
  );
  if (ranged.paths.length === 1 && ranged.paths[0] === "/sdk/register#L10-L20") {
    pass("route token with line numbers is still verified");
  } else {
    fail(`route token with line numbers not verified: ${JSON.stringify(ranged.paths)}`);
  }

  // No broad disablement: an extensionless separator path without a leading
  // slash is still a file-citation candidate and is caught when invented.
  const phantom = verifyCitations("The logic lives in `backend/src/phantom`.", evidenceMap, { allAnalysisFiles });
  if (phantom.paths.length === 1 && phantom.paths[0] === "backend/src/phantom") {
    pass("invented extensionless separator path is still caught");
  } else {
    fail(`invented extensionless path not caught: ${JSON.stringify(phantom.paths)}`);
  }

  // Guards still bind for extension-bearing invented paths (see block 3
  // above); here the extractor keeps endpoints out of candidate extraction.
  const tokens = pathTokens("`/sdk/register` and `lib/ai/tasks.ts`");
  if (tokens.length === 1 && tokens[0] === "lib/ai/tasks.ts") {
    pass("pathTokens skips endpoint spans");
  } else {
    fail(`pathTokens endpoint filtering wrong: ${JSON.stringify(tokens)}`);
  }

  // Unit predicates.
  const cases: [string, boolean][] = [
    ["/api/login", true],
    ["/sdk/authorize", true],
    ["/api/v2/users/:id/edit", true],
    ["/lib/auth.ts", false],
    ["sdk/register", false],
    ["lib/ai/tasks.ts", false],
  ];
  const wrong = cases.filter(([token, want]) => isRouteStylePath(token) !== want);
  if (wrong.length === 0) {
    pass("isRouteStylePath recognizes endpoints and not file paths");
  } else {
    fail(`isRouteStylePath wrong on: ${JSON.stringify(wrong)}`);
  }
}

  // Relative import specifiers must never be treated as citations: the model
  // quoting an import line must not turn into a verification failure, and an
  // unknown relative path must never be silently resolved to a canonical file.
  {
    const cases: [string, string][] = [
      ["`../services/auth/discord.service.js`", "../services/auth/discord.service.js"],
      ["`./auth.middleware.js`", "./auth.middleware.js"],
      ["`../../utils/helpers.ts`", "../../utils/helpers.ts"],
      ["`..\\services\\auth\\discord.service.js`", "..\\services\\auth\\discord.service.js"],
      ["`.\\auth.middleware.js`", ".\\auth.middleware.js"],
    ];
    let allOk = true;
    for (const [mention, specifier] of cases) {
      const tokens = pathTokens(`See ${mention}.`);
      if (tokens.includes(specifier)) { allOk = false; break; }
    }
    if (allOk) pass("relative import specifiers are excluded from citation candidates");
    else fail("a relative import specifier leaked into citation candidates");
  }

  // Cross-directory relative imports are excluded too.
  {
    const tokens = pathTokens("Imports `../shared/lib/foo.ts` and `./bar/baz.js`.");
    if (tokens.length === 0) pass("cross-directory relative imports excluded");
    else fail(`cross-directory relative leaked: ${JSON.stringify(tokens)}`);
  }

  // Valid canonical paths still verify normally.
  {
    const bad = verifyCitations("See `lib/ai/tasks.ts#L10-L25` and `components/explanation-text.tsx`.", allowed);
    if (bad.paths.length === 0) pass("valid canonical paths still verify");
    else fail(`valid canonical paths flagged: ${JSON.stringify(bad.paths)}`);
  }

  // Unknown relative paths are not silently converted to a valid canonical path.
  {
    const resolved = findMatchingPath("../services/auth/discord.service.js", (p) => allowed.has(p), allowed);
    if (resolved === null) pass("unknown relative path is not silently resolved");
    else fail(`relative path silently resolved to ${resolved}`);
  }

  // findMatchingPath still resolves legitimate canonical-ish suffixes.
  {
    const resolved = findMatchingPath("lib/ai/tasks.ts", (p) => allowed.has(p), allowed);
    if (resolved === "lib/ai/tasks.ts") pass("canonical path resolves exactly");
    else fail(`canonical path resolution broken: ${resolved}`);
  }

// --- CI-4: the general allowlist tier is a stored-content allowlist ---
console.log("");
console.log("=== CI-4 allowlist tier: quarantined, absent and stored paths ===");

{
  // allowedAnalysisPaths(db, analysisId) returns exactly the analysis's
  // `stored`, non-skipped paths. These sets model its output next to the
  // evidence map the retrieved windows supply:
  const evidenceMap = new Map<string, FileEvidence>([
    ["lib/stored/served.ts", { lines: 40, contentHash: "hash-served" }],
    // The absent file was successfully read into tier-1 evidence: its
    // authorized backfill completed in the same request, so its bytes are
    // verified and its mention is citable.
    ["lib/absent/verified.ts", { lines: 30, contentHash: "hash-absent-read" }],
  ]);
  const allAnalysisFiles = new Set([
    "lib/stored/served.ts",
    // A stored file that retrieval did not reach stays citable through the
    // general allowlist.
    "lib/stored/not-retrieved.ts",
    // Excluded, legacy-unclassified and not-yet-read absent paths never
    // enter the set allowedAnalysisPaths builds.
  ]);

  // Bare mentions of quarantined paths fail — they are neither evidence nor
  // allowlisted — while the absent mention that was successfully read passes
  // on tier 1.
  const bad = verifyCitations(
    "Quarantine caught `lib/excluded/secret.ts` and `lib/legacy/old.ts`; the verified read of `lib/absent/verified.ts` stands.",
    evidenceMap,
    { allAnalysisFiles },
  );
  if (bad.paths.length === 2 && bad.paths.includes("lib/excluded/secret.ts") && bad.paths.includes("lib/legacy/old.ts")) {
    pass("excluded and legacy bare mentions fail; the absent path read into evidence passes");
  } else {
    fail(`CI-4 tier-1/tier-2 boundary wrong: ${JSON.stringify(bad.paths)}`);
  }

  // Bare mentions of the still-absent (unread) path fail, exactly the way an
  // invented path does, unless the answer's evidence map holds a successful
  // read of it.
  const unreadAbsent = verifyCitations("Pending a backfill: `lib/absent/unread.ts`.", evidenceMap, { allAnalysisFiles });
  if (unreadAbsent.paths.length === 1 && unreadAbsent.paths[0] === "lib/absent/unread.ts") {
    pass("an absent path absent from the evidence map fails like any uncovered path");
  } else {
    fail(`unread absent mismatch: ${JSON.stringify(unreadAbsent.paths)}`);
  }
  const readAbsent = verifyCitations("Backfilled in this ask: `lib/absent/verified.ts`.", evidenceMap, { allAnalysisFiles });
  if (readAbsent.paths.length === 0) {
    pass("an absent path that was read into evidence verifies through tier 1");
  } else {
    fail(`read absent flagged: ${JSON.stringify(readAbsent.paths)}`);
  }

  // CI-9D: Stored-but-unretrieved files are strictly rejected as unretrieved evidence.
  const storedUnretrieved = verifyCitations("Set up in `lib/stored/not-retrieved.ts`.", evidenceMap, { allAnalysisFiles });
  if (
    storedUnretrieved.paths.length === 1 &&
    storedUnretrieved.paths[0] === "lib/stored/not-retrieved.ts" &&
    storedUnretrieved.details?.[0]?.includes("Unretrieved repository file")
  ) {
    pass("a stored path that retrieval did not reach is strictly rejected as unretrieved evidence");
  } else {
    fail(`stored-not-retrieved rejection wrong: ${JSON.stringify(storedUnretrieved)}`);
  }
}

// --- Focused regression tests: Directory configs and in-code quoted literals ---
console.log("");
console.log("=== Quoted directory configs and in-code string literals ===");

{
  const evidenceMap = new Map<string, FileEvidence>([
    ["src/cli/utils.ts", { lines: 70, contentHash: "hash-utils" }],
    ["src/cli/add.ts", { lines: 50, contentHash: "hash-add" }],
  ]);
  const allAnalysisFiles = new Set([
    "src/cli/utils.ts",
    "src/cli/add.ts",
    "core/AccentColorContext.ts",
    "core/useAccentColor.tsx",
    "components/ui/icons/IconBase.tsx",
  ]);
  const contextText = `
--- File: src/cli/utils.ts (lines 1-70) [hash: hash-utils] ---
export const DEFAULT_CONFIG = {
  components: './src/components/ui',
  utils: './src/utils',
  css: './src/index.css',
};
const configPath = path.join(root, 'lithos.json');

--- File: src/cli/add.ts (lines 1-50) [hash: hash-add] ---
if (req.includes('components/ui/icons/') && req !== 'components/ui/icons/IconBase.tsx') {
  deps.add('components/ui/icons/IconBase.tsx');
}
if (req === 'core/useAccentColor.tsx' || req === 'core/useAccentColor.ts') {
  deps.add('core/AccentColorContext.ts');
}
`;

  // 1. Quoted directory/config paths (e.g. './src/components/ui') are not misclassified as citations
  const dirTokens = pathTokens("Defaults to `'./src/components/ui'` and `'./src/utils'`.");
  if (dirTokens.length === 0) {
    pass("quoted directory config paths are not misclassified as file citations");
  } else {
    fail(`quoted directory configs misclassified as citations: ${JSON.stringify(dirTokens)}`);
  }

  // 2. lithos.json discussed as a downstream config filename present in evidence text
  const configRes = verifyCitations(
    "Defaults are configured in `src/cli/utils.ts#L33-L42` which checks for `lithos.json`.",
    evidenceMap,
    { allAnalysisFiles, contextText },
  );
  if (configRes.paths.length === 0) {
    pass("downstream config file mentioned verbatim in evidence text passes");
  } else {
    fail(`downstream config file rejected: ${JSON.stringify(configRes)}`);
  }

  // 3. String literals in retrieved source code discussed without unretrieved-file error
  const literalRes = verifyCitations(
    "In `src/cli/add.ts#L16-L42`, dependencies on `components/ui/icons/IconBase.tsx` and `core/AccentColorContext.ts` are injected.",
    evidenceMap,
    { allAnalysisFiles, contextText },
  );
  if (literalRes.paths.length === 0) {
    pass("bare path string literal quoted from evidence text passes without unretrieved-file error");
  } else {
    fail(`in-code string literal rejected: ${JSON.stringify(literalRes)}`);
  }

  // 4. An explicit citation to an unretrieved file remains strictly rejected
  const explicitUnretrieved = verifyCitations(
    "See `core/AccentColorContext.ts#L10-L20` for implementation.",
    evidenceMap,
    { allAnalysisFiles, contextText },
  );
  if (
    explicitUnretrieved.paths.length === 1 &&
    explicitUnretrieved.paths[0] === "core/AccentColorContext.ts#L10-L20" &&
    explicitUnretrieved.details?.[0]?.includes("not in retrieved evidence")
  ) {
    pass("explicit citation to unretrieved file remains strictly rejected");
  } else {
    fail(`explicit unretrieved citation not rejected properly: ${JSON.stringify(explicitUnretrieved)}`);
  }

  // 5. Invented unretrieved paths not in evidence text remain strictly rejected
  const inventedRes = verifyCitations(
    "See `lib/fake/nonexistent.ts` for details.",
    evidenceMap,
    { allAnalysisFiles, contextText },
  );
  if (inventedRes.paths.length === 1 && inventedRes.paths[0] === "lib/fake/nonexistent.ts") {
    pass("invented unretrieved path not in evidence text remains strictly rejected");
  } else {
    fail(`invented unretrieved path not rejected: ${JSON.stringify(inventedRes)}`);
  }

  // 6. Existing valid citations and line-range checks remain strict
  const validStrict = verifyCitations(
    "Defined in `src/cli/utils.ts#L10-L25`.",
    evidenceMap,
    { allAnalysisFiles, contextText },
  );
  if (validStrict.paths.length === 0) {
    pass("valid line-range citation remains accepted");
  } else {
    fail(`valid line-range citation rejected: ${JSON.stringify(validStrict)}`);
  }
}

console.log("");
console.log("=== multi-window union coverage (Phase 1D, V5) ===");
{
  // Two served windows on the same file. With maxWindowsPerFile=2 this is the
  // ordinary production shape; the model may legitimately cite a range that
  // spans both windows as long as no retrieved line is missing in between.
  const evidenceMap = new Map<string, FileEvidence>([
    [
      "lib/seam.ts",
      {
        lines: 100,
        contentHash: "hash-seam",
        windows: [
          { startLine: 10, endLine: 25 },
          { startLine: 26, endLine: 40 },
        ],
      },
    ],
    [
      "lib/gap.ts",
      {
        lines: 100,
        contentHash: "hash-gap",
        windows: [
          { startLine: 10, endLine: 25 },
          { startLine: 27, endLine: 40 },
        ],
      },
    ],
    [
      "lib/three.ts",
      {
        lines: 120,
        contentHash: "hash-three",
        windows: [
          { startLine: 1, endLine: 20 },
          { startLine: 15, endLine: 30 },
          { startLine: 31, endLine: 45 },
        ],
      },
    ],
    ["lib/one.ts", { lines: 100, contentHash: "hash-one", windows: [{ startLine: 10, endLine: 30 }] }],
  ]);
  const options = { allAnalysisFiles: new Set(["lib/seam.ts", "lib/gap.ts", "lib/three.ts", "lib/one.ts"]) };

  // 1. Adjacent windows: the union is continuous, so a citation across the
  //    seam covers only served lines and must be accepted.
  const seam = verifyCitations("See `lib/seam.ts#L12-L38`.", evidenceMap, options);
  if (seam.paths.length === 0) pass("citation spanning two adjacent windows is accepted");
  else fail(`citation spanning adjacent windows rejected: ${JSON.stringify(seam)}`);

  // 2. A real gap between windows: line 26 was never served. The citation
  //    claims it, so it must fail closed — unchanged behavior — and the
  //    failure detail must name the unretrieved gap lines.
  const gap = verifyCitations("See `lib/gap.ts#L12-L38`.", evidenceMap, options);
  if (gap.paths.length === 1) {
    const detail = (gap.details ?? []).join(" ");
    if (detail.includes("26")) pass("gap-spanning citation is rejected and names the uncovered gap line 26");
    else fail(`gap-spanning rejection does not name the gap: ${JSON.stringify(gap)}`);
  } else {
    fail(`gap-spanning citation was not rejected: ${JSON.stringify(gap)}`);
  }

  // 3. Overlapping windows collapse into one interval; a citation inside the
  //    overlap behaves exactly as before.
  const overlap = verifyCitations("See `lib/three.ts#L18-L44`.", evidenceMap, options);
  if (overlap.paths.length === 0) pass("citation inside merged overlapping windows is accepted");
  else fail(`citation inside overlapping windows rejected: ${JSON.stringify(overlap)}`);

  // 4. A range genuinely outside every window is still rejected (regression
  //    of the strict baseline).
  const outside = verifyCitations("See `lib/one.ts#L31-L99`.", evidenceMap, options);
  if (outside.paths.length === 1) pass("citation fully outside the windows remains rejected");
  else fail(`citation outside windows was accepted: ${JSON.stringify(outside)}`);

  // 5. Subset of a single window stays accepted (regression).
  const subset = verifyCitations("See `lib/one.ts#L15-L25`.", evidenceMap, options);
  if (subset.paths.length === 0) pass("citation fully inside a single window remains accepted");
  else fail(`citation inside single window rejected: ${JSON.stringify(subset)}`);

  // 6. End line exactly at the seam-adjacent boundary edge: citing
  //    [10..40] across adjacent windows ends on served line 40 — accepted.
  const fullSpan = verifyCitations("See `lib/seam.ts#L10-L40`.", evidenceMap, options);
  if (fullSpan.paths.length === 0) pass("citation spanning the entire adjacent pair is accepted");
  else fail(`citation spanning full adjacent pair rejected: ${JSON.stringify(fullSpan)}`);

  // 7. The gap file rejects the same full span because line 26 is missing.
  const gapFull = verifyCitations("See `lib/gap.ts#L10-L40`.", evidenceMap, options);
  if (gapFull.paths.length === 1) pass("full span over a real gap remains rejected");
  else fail(`full span over gap was accepted: ${JSON.stringify(gapFull)}`);
}

console.log("");
for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

// A module, so the awaits above are allowed.
export {};
