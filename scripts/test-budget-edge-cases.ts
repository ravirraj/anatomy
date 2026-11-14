// scripts/test-budget-edge-cases.ts
// CI-8E: Comprehensive Deterministic Unit & Edge Case Test Suite for Prompt Budget Accounting.
// Audits CI-8B (Budget Manager), CI-8C (Retrieval & Loop), and CI-8D (Tasks & Provider).
// Tests boundary values, empty inputs, Unicode, long paths, compaction, citation authorization,
// custom endpoint resolution, and failure isolation.

import {
  DEFAULT_UNKNOWN_CONTEXT_WINDOW,
  DEFAULT_UNKNOWN_MAX_OUTPUT,
  DEFAULT_UNKNOWN_MAX_INPUT_CHARACTERS,
  DEFAULT_UNKNOWN_OPERATIONAL_INPUT_TOKENS,
  fallbackProfileNotice,
  isOpenAiDirectHost,
  isOpenRouterHost,
  resolveModelProfile,
  estimateCodeTokens,
  estimateProseTokens,
  estimatePromptTokens,
  evaluatePromptBudget,
  assertPromptBudget,
  BudgetExhaustedError,
  BudgetOverflowError,
  type ModelContextProfile,
} from "../lib/ai/budget.ts";

import {
  computeEvidenceLimits,
  formatRetrievedContext,
  type RetrievalResult,
  type RetrievedWindow,
} from "../lib/ai/retrieval.ts";

import {
  mergeIterationWindows,
} from "../lib/ai/retrieval-loop.ts";

import { verifyCitations, type FileEvidence } from "../lib/ai/citations.ts";
import {
  answerQuestion,
  isContextLengthExceededError,
  type Cache,
} from "../lib/ai/tasks.ts";
import { MODELS, resolveBaseUrl } from "../lib/ai/client.ts";
import type { QuestionInput } from "../lib/ai/prompts.ts";

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string, detail?: string) {
  if (cond) {
    passed++;
    console.log(`ok    ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

// =============================================================================
// Section 1: Token Estimation & Boundary Arithmetic
// =============================================================================
console.log("=== 1. Token Estimation & Boundary Arithmetic ===");
{
  // 1.1 Empty & Whitespace strings
  check(estimateCodeTokens("") === 0, "estimateCodeTokens('') is 0");
  check(estimateProseTokens("") === 0, "estimateProseTokens('') is 0");
  check(estimatePromptTokens("", "") === 0, "estimatePromptTokens('', '') is 0");
  check(estimateCodeTokens(" ") === 1, "estimateCodeTokens single space is 1 (ceil(1/3.0))");
  check(estimateProseTokens(" ") === 1, "estimateProseTokens single space is 1 (ceil(1/3.5))");
  check(estimateCodeTokens("   ") === 1, "estimateCodeTokens 3 spaces is 1 (ceil(3/3.0))");
  check(estimateCodeTokens("    ") === 2, "estimateCodeTokens 4 spaces is 2 (ceil(4/3.0))");
  check(estimateCodeTokens("\n\n\n") === 1, "estimateCodeTokens 3 newlines is 1");

  // 1.2 Mathematical ceiling boundaries
  // Code: ceil(length / 3.0)
  check(estimateCodeTokens("abc") === 1, "estimateCodeTokens 3 chars is 1");
  check(estimateCodeTokens("abcd") === 2, "estimateCodeTokens 4 chars is 2");
  check(estimateCodeTokens("a".repeat(300)) === 100, "estimateCodeTokens 300 chars is 100");
  check(estimateCodeTokens("a".repeat(301)) === 101, "estimateCodeTokens 301 chars is 101");

  // Prose: ceil(length / 3.5)
  check(estimateProseTokens("a".repeat(7)) === 2, "estimateProseTokens 7 chars is 2");
  check(estimateProseTokens("a".repeat(8)) === 3, "estimateProseTokens 8 chars is 3");
  check(estimateProseTokens("a".repeat(350)) === 100, "estimateProseTokens 350 chars is 100");
  check(estimateProseTokens("a".repeat(351)) === 101, "estimateProseTokens 351 chars is 101");

  // 1.3 Dense Multi-byte Unicode & Emoji
  // JavaScript .length counts UTF-16 code units.
  const unicodeString = "🚀✨🔥 日本語 中文 русский язык";
  const unicodeLength = unicodeString.length;
  check(
    estimateCodeTokens(unicodeString) === Math.ceil(unicodeLength / 3.0),
    "estimateCodeTokens correctly handles multi-byte unicode code units",
  );
  check(
    estimateProseTokens(unicodeString) === Math.ceil(unicodeLength / 3.5),
    "estimateProseTokens correctly handles multi-byte unicode code units",
  );

  // 1.4 Complex ZWJ (Zero-Width Joiner) Emoji Sequences
  const familyEmoji = "👨‍👩‍👧‍👦"; // Family emoji: 4 emojis + 3 ZWJs = 11 UTF-16 code units
  check(familyEmoji.length === 11, "family emoji is 11 UTF-16 code units");
  check(
    estimateCodeTokens(familyEmoji) === Math.ceil(11 / 3.0),
    "estimateCodeTokens family emoji uses length / 3.0",
  );
}

// =============================================================================
// Section 2: Exact Pre-flight Budget Invariants & Boundary Overflow
// =============================================================================
console.log("\n=== 2. Exact Pre-flight Budget Invariants & Boundary Overflow ===");
{
  const profile: ModelContextProfile = {
    model: "test-boundary-model",
    contextWindowTokens: 8192,
    maxOutputTokens: 1500,
    operationalInputTokens: 4500,
    safetyHeadroomTokens: 2192,
    maxInputCharacters: 13500,
    provider: "custom",
    isFallback: true,
  };

  // 2.1 Exact character boundary fit
  // Prose system = 0 chars, code user = 13,500 chars -> 13,500 chars (<= 13500), 4,500 tokens (<= 4500)
  const exactFitUser = "x".repeat(13500);
  const evalExact = evaluatePromptBudget(profile, "", exactFitUser);
  check(evalExact.valid === true, "exact boundary 13,500 chars and 4,500 tokens fits budget");
  check(evalExact.violations.length === 0, "exact boundary produces zero violations");
  check(
    (() => {
      assertPromptBudget(profile, "", exactFitUser);
      return true;
    })(),
    "assertPromptBudget passes silently on exact boundary fit",
  );

  // 2.2 Boundary character overflow (+1 char)
  const overflowCharUser = "x".repeat(13501);
  const evalCharOverflow = evaluatePromptBudget(profile, "", overflowCharUser);
  check(evalCharOverflow.valid === false, "13,501 characters violates character ceiling");
  check(
    evalCharOverflow.violations.some((v) => v.includes("exceeds hard ceiling")),
    "character ceiling violation message reported",
  );

  let caughtBudgetError: BudgetExhaustedError | null = null;
  try {
    assertPromptBudget(profile, "", overflowCharUser);
  } catch (err) {
    if (err instanceof BudgetExhaustedError) caughtBudgetError = err;
  }
  check(caughtBudgetError !== null, "assertPromptBudget throws BudgetExhaustedError on 1 char overflow");
  check(caughtBudgetError?.code === "BUDGET_EXHAUSTED", "error code is BUDGET_EXHAUSTED");
  check(caughtBudgetError?.totalCharacters === 13501, "error totalCharacters reflects exact count");

  // 2.3 Boundary token overflow (prose system estimation produces higher token density)
  const tightProfile: ModelContextProfile = {
    ...profile,
    operationalInputTokens: 3000,
    maxInputCharacters: 13500,
  };
  const tokenOverflowUser = "x".repeat(10000); // 10000 chars (<= 13500), ceil(10000 / 3.0) = 3334 tokens (> 3000)
  const evalTokenOverflow = evaluatePromptBudget(tightProfile, "", tokenOverflowUser);
  check(evalTokenOverflow.valid === false, "token limit exceeded while character ceiling respected");
  check(
    evalTokenOverflow.violations.some((v) => v.includes("exceeds operational target")),
    "operational token target violation message reported",
  );

  // 2.4 Simultaneous character and token violation
  const massiveUser = "x".repeat(20000); // 20000 chars (> 13500), 6667 tokens (> 4500)
  const evalMassive = evaluatePromptBudget(profile, "", massiveUser);
  check(evalMassive.valid === false, "massive input produces invalid evaluation");
  check(evalMassive.violations.length >= 2, "both character ceiling and token target violations reported");
}

// =============================================================================
// Section 3: Model & Provider Resolution Under Edge Case URLs
// =============================================================================
console.log("\n=== 3. Model & Provider Resolution Under Edge Case URLs ===");
{
  // 3.1 Host resolution with ports, IP addresses, paths, trailing slashes
  check(isOpenAiDirectHost("https://api.openai.com/v1") === true, "OpenAI host is true");
  check(isOpenAiDirectHost("https://api.openai.com/v1/") === true, "OpenAI host with trailing slash");
  check(isOpenAiDirectHost("http://192.168.1.1:8000/v1") === false, "Private IP address host is false");
  check(isOpenAiDirectHost("http://127.0.0.1:11434") === false, "Ollama localhost is false");

  check(isOpenRouterHost("https://openrouter.ai/api/v1") === true, "OpenRouter host is true");
  check(isOpenRouterHost("https://openrouter.ai/api/v1/") === true, "OpenRouter with trailing slash is true");
  check(isOpenRouterHost("https://openrouter.ai.attacker.example/v1") === false, "Deceptive domain suffix is false");
  check(isOpenRouterHost("https://fake-openrouter.ai") === false, "Fake domain prefix is false");

  // 3.2 Known models on untrusted or custom host MUST resolve to fallback profile
  const gpt4oCustom = resolveModelProfile("gpt-4o", "http://my-custom-proxy.internal:8080/v1");
  check(gpt4oCustom.isFallback === true, "gpt-4o on custom proxy is marked isFallback: true");
  check(gpt4oCustom.provider === "custom", "gpt-4o on custom proxy provider is 'custom'");
  check(
    gpt4oCustom.contextWindowTokens === DEFAULT_UNKNOWN_CONTEXT_WINDOW,
    "gpt-4o on custom proxy does NOT inherit 128k context window",
  );
  check(
    gpt4oCustom.maxOutputTokens === DEFAULT_UNKNOWN_MAX_OUTPUT,
    "gpt-4o on custom proxy does NOT inherit 16k output tokens",
  );

  // 3.3 OpenRouter model prefix on direct OpenAI host resolves to fallback
  const orModelOnOpenAi = resolveModelProfile("openai/gpt-4o-mini", "https://api.openai.com/v1");
  check(orModelOnOpenAi.isFallback === true, "OpenRouter prefixed model on OpenAI direct host resolves fallback");

  // 3.4 Direct OpenAI model on OpenRouter host resolves to fallback unless prefixed
  const directModelOnOr = resolveModelProfile("gpt-4o-mini", "https://openrouter.ai/api/v1");
  check(directModelOnOr.isFallback === true, "Unprefixed model on OpenRouter host resolves fallback");
}

// =============================================================================
// Section 4: Retrieval Evidence Budget, Unicode, and Deep Paths
// =============================================================================
console.log("\n=== 4. Retrieval Evidence Budget, Unicode, and Deep Paths ===");
{
  // 4.1 Empty / whitespace query calculation
  const limitsEmptyQuery = computeEvidenceLimits({}, "");
  check(limitsEmptyQuery.maxCharacters === 28000, "empty query receives default character allocation");
  check(limitsEmptyQuery.maxTokens === Math.ceil(28000 / 3.0), "empty query receives default token allocation");

  const limitsWhitespaceQuery = computeEvidenceLimits({}, "   \t\n   ");
  check(limitsWhitespaceQuery.maxCharacters === 28000, "whitespace query trimmed and receives default allocation");

  // 4.2 Query with dense emojis & CJK
  const unicodeQuery = "🔍 何が問題ですか？ 🚀 " + "データ ".repeat(50);
  const limitsUnicode = computeEvidenceLimits({}, unicodeQuery);
  check(limitsUnicode.maxCharacters === 28000, "unicode query computes valid positive limits");
  check(limitsUnicode.maxTokens > 0, "unicode query computes positive token limits");

  // 4.3 Deeply nested repository paths formatRetrievedContext accounting
  const deepPath = "packages/frontend/src/components/common/data-table/nested/handlers/very/deeply/nested/tableDataHandler.tsx";
  const mockWindow: RetrievedWindow = {
    fileId: "f-deep",
    path: deepPath,
    contentHash: "hash-deep",
    totalLines: 200,
    startLine: 100,
    endLine: 105,
    text: "const a = 1;\nconst b = 2;\n",
    score: 1.0,
    reason: "deep path test",
  };

  const mockPlan = {
    query: "test query",
    isOnboarding: false,
    intent: "explain-architecture" as const,
    intentReason: "test",
    concepts: [],
    unusedTokens: [],
    expectedEvidence: [],
    isAnswerable: true,
  };

  const mockResult: RetrievalResult = {
    analysisId: "test-analysis",
    query: "test query",
    tokens: ["a", "b"],
    plan: mockPlan,
    windows: [mockWindow],
    files: [{ fileId: "f-deep", path: deepPath, contentHash: "hash-deep", totalLines: 200, windows: [{ startLine: 100, endLine: 105 }] }],
    totalCharacters: 26,
    totalTokens: 9,
    renderedCharacters: 120,
    insufficientEvidence: false,
  };

  const rendered = formatRetrievedContext(mockResult);
  check(rendered.includes(deepPath), "formatRetrievedContext renders full deep path header");
  check(rendered.includes("lines 100-105"), "formatRetrievedContext preserves line boundaries");

  // 4.4 formatRetrievedContext with empty windows
  const emptyResult: RetrievalResult = {
    analysisId: "test-analysis",
    query: "test query",
    tokens: [],
    plan: mockPlan,
    windows: [],
    files: [],
    totalCharacters: 0,
    totalTokens: 0,
    renderedCharacters: 0,
    insufficientEvidence: true,
  };
  check(
    formatRetrievedContext(emptyResult) === "No relevant code snippets were found in the stored analysis for this query.",
    "formatRetrievedContext with 0 windows returns standard fallback message",
  );
}

// =============================================================================
// Section 5: Multi-Window Compaction & Citation Authorization
// =============================================================================
console.log("\n=== 5. Multi-Window Compaction & Citation Authorization ===");
{
  const allowedEvidence = new Map<string, FileEvidence>();
  allowedEvidence.set("src/fileA.ts", {
    contentHash: "hashA",
    lines: 100,
    windows: [
      { startLine: 1, endLine: 10 },
      { startLine: 50, endLine: 60 },
    ],
  });

  // 5.1 Citation to surviving window A1 line 5 -> valid
  const answerValidA1 = "Module A defines `src/fileA.ts#L5`.";
  const verifiedA1 = verifyCitations(answerValidA1, allowedEvidence);
  check(verifiedA1.paths.length === 0, "citation to surviving window A1 passes verification");

  // 5.2 Citation to surviving window A2 line 55 -> valid
  const answerValidA2 = "Module A defines `src/fileA.ts#L55`.";
  const verifiedA2 = verifyCitations(answerValidA2, allowedEvidence);
  check(verifiedA2.paths.length === 0, "citation to surviving window A2 passes verification");

  // 5.3 Citation to line in unretrieved gap of file A (line 30) -> FAILS closed!
  const answerGapA = "Module A defines `src/fileA.ts#L30`.";
  const verifiedGapA = verifyCitations(answerGapA, allowedEvidence);
  check(verifiedGapA.paths.length === 1, "citation to unretrieved line 30 between windows is rejected");

  // 5.4 Citation to dropped file B line 5 -> FAILS closed as hallucination!
  const answerDroppedB = "Module B defines `src/fileB.ts#L5`.";
  const verifiedDroppedB = verifyCitations(answerDroppedB, allowedEvidence);
  check(verifiedDroppedB.paths.length === 1, "citation to dropped file B is strictly rejected");
  check(verifiedDroppedB.paths[0] === "src/fileB.ts#L5", "rejection identifies dropped file B citation token");
}

// =============================================================================
// Section 6: Iterative Loop Shared Budget & Deduplication Edge Cases
// =============================================================================
console.log("\n=== 6. Iterative Loop Shared Budget & Deduplication Edge Cases ===");
{
  const windowPass0: RetrievedWindow = {
    fileId: "f-idx",
    path: "src/index.ts",
    contentHash: "hashIdx",
    totalLines: 100,
    startLine: 1,
    endLine: 20,
    text: "import { a } from './a';\n",
    score: 1.0,
    reason: "seed",
  };

  const defaultLimits = {
    maxFiles: 5,
    maxWindowsPerFile: 3,
    maxCharacters: 10000,
    maxTokens: 3000,
    scoreFloor: 0.1,
  };

  const currentResult = {
    windows: [windowPass0],
    totalCharacters: windowPass0.text.length,
    totalTokens: estimateCodeTokens(windowPass0.text),
  };

  // 6.1 Pass 1 returns exact duplicate window
  const duplicateWindow: RetrievedWindow = {
    fileId: "f-idx",
    path: "src/index.ts",
    contentHash: "hashIdx",
    totalLines: 100,
    startLine: 1,
    endLine: 20,
    text: "import { a } from './a';\n",
    score: 0.8,
    reason: "seed-dup",
  };

  const mergedDup = mergeIterationWindows(currentResult, [duplicateWindow], defaultLimits);
  check(mergedDup.windows.length === 1, "mergeIterationWindows rejects exact duplicate candidate window");
  check(mergedDup.added === 0, "mergeIterationWindows records 0 additions for duplicate");

  // 6.2 Pass 1 returns overlapping window (lines 10-30 overlapping 1-20)
  const overlappingWindow: RetrievedWindow = {
    fileId: "f-idx",
    path: "src/index.ts",
    contentHash: "hashIdx",
    totalLines: 100,
    startLine: 10,
    endLine: 30,
    text: "import { a } from './a';\n",
    score: 0.9,
    reason: "seed-overlap",
  };

  const mergedOverlap = mergeIterationWindows(currentResult, [overlappingWindow], defaultLimits);
  check(mergedOverlap.windows.length === 1, "mergeIterationWindows rejects overlapping candidate window");
  check(mergedOverlap.added === 0, "mergeIterationWindows records 0 additions for overlap");

  // 6.3 Pass 1 returns disjoint new window
  const disjointWindow: RetrievedWindow = {
    fileId: "f-idx",
    path: "src/index.ts",
    contentHash: "hashIdx",
    totalLines: 100,
    startLine: 50,
    endLine: 70,
    text: "export function run() {}\n",
    score: 0.7,
    reason: "seed-disjoint",
  };

  const mergedDisjoint = mergeIterationWindows(currentResult, [disjointWindow], defaultLimits);
  check(mergedDisjoint.windows.length === 2, "mergeIterationWindows admits non-overlapping disjoint window");
  check(mergedDisjoint.added === 1, "mergeIterationWindows records 1 addition");
  check(mergedDisjoint.windows[0].startLine === 1, "first window preserved in sort order");
  check(mergedDisjoint.windows[1].startLine === 50, "second window sorted in ascending line order");
}

// =============================================================================
// Section 7: Context Overflow Pattern Matching & Error Taxonomy
// =============================================================================
console.log("\n=== 7. Context Overflow Pattern Matching & Error Taxonomy ===");
{
  // 7.1 Provider status 400 error shapes
  check(
    isContextLengthExceededError({ status: 400, code: "context_length_exceeded" }),
    "code: context_length_exceeded is recognized",
  );
  check(
    isContextLengthExceededError({ status: 400, error: { code: "context_length_exceeded" } }),
    "nested error.code: context_length_exceeded is recognized",
  );
  check(
    isContextLengthExceededError({ status: 400, message: "Prompt is too long for model context window" }),
    "message: 'Prompt is too long' is recognized",
  );
  check(
    isContextLengthExceededError({ status: 400, message: "This model's maximum context length is 8192 tokens" }),
    "message: 'maximum context length' is recognized",
  );
  check(
    isContextLengthExceededError({ status: 400, message: "Please reduce the length of the messages" }),
    "message: 'reduce the length of the messages' is recognized",
  );
  check(
    isContextLengthExceededError({ status: 422, message: "request exceeds context window" }),
    "status 422 with 'exceeds context' is recognized",
  );

  // 7.2 Non-overflow errors must NOT match
  check(
    isContextLengthExceededError({ status: 400, message: "Invalid JSON in request body" }) === false,
    "generic 400 invalid JSON is NOT recognized as context overflow",
  );
  check(
    isContextLengthExceededError({ status: 404, message: "Model not found" }) === false,
    "404 model not found is NOT recognized as context overflow",
  );
  check(
    isContextLengthExceededError({ status: 500, message: "Internal server error" }) === false,
    "500 internal server error is NOT recognized as context overflow",
  );
  check(
    isContextLengthExceededError(null) === false,
    "null error returns false",
  );
  check(
    isContextLengthExceededError(undefined) === false,
    "undefined error returns false",
  );

  // 7.3 BudgetOverflowError typed contracts
  const overflowErr = new BudgetOverflowError("gpt-4o", "context length exceeded 8192");
  check(overflowErr instanceof BudgetOverflowError, "overflow error is instance of BudgetOverflowError");
  check(overflowErr.name === "BudgetOverflowError", "overflow error name is BudgetOverflowError");
  check(overflowErr.code === "BUDGET_OVERFLOW", "overflow error code is BUDGET_OVERFLOW");
  check(overflowErr.model === "gpt-4o", "overflow error contains model identifier");
  check(isContextLengthExceededError(overflowErr), "isContextLengthExceededError returns true for BudgetOverflowError");
}

// =============================================================================
// Section 8: Fallback Profile Visibility (Phase 1D, V4)
// =============================================================================
{
  console.log("\n=== 8. Fallback Profile Visibility ===");

  // 8.1 A verified profile yields no notice (pure helper).
  const verified = resolveModelProfile("gpt-4o", undefined);
  check(verified.isFallback === false, "gpt-4o resolves as a verified profile");
  check(
    fallbackProfileNotice(verified) === null,
    "verified profile yields no fallback notice",
  );

  // 8.2 A fallback profile yields an actionable notice.
  const fallback = resolveModelProfile("unverified-model-x", undefined);
  check(fallback.isFallback === true, "unverified model resolves as fallback profile");
  const notice = fallbackProfileNotice(fallback);
  check(notice !== null, "fallback profile yields a notice");
  if (notice !== null) {
    check(notice.includes("unverified-model-x"), "notice names the model");
    check(
      notice.includes("AI_CONTEXT_WINDOW_TOKENS") && notice.includes("AI_MAX_OUTPUT_TOKENS"),
      "notice names both lift-out env vars",
    );
    check(
      notice.replace(/,/g, "").includes(String(DEFAULT_UNKNOWN_MAX_INPUT_CHARACTERS)),
      "notice states the hard input character ceiling",
    );
    check(
      notice.replace(/,/g, "").includes(String(DEFAULT_UNKNOWN_OPERATIONAL_INPUT_TOKENS)),
      "notice states the operational input token ceiling",
    );
  }

  // 8.3 End to end: the ask path warns exactly once, only where the budget is
  // applied (fresh generation). The expectation follows the profile this
  // process actually resolves for the pinned question model (MODELS.question
  // is read from env at module load), so the test is deterministic in every
  // environment: a verified pin stays silent, a fallback warns once.
  const warnLines: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg?: unknown) => {
    warnLines.push(String(msg));
  };
  try {
    const store = new Map<string, string>();
    const mockCache: Cache = {
      async read(key: string) {
        return store.get(key) ?? null;
      },
      async write({ key, body }: { key: string; body: string }) {
        store.set(key, body);
      },
      async delete(key: string) {
        store.delete(key);
      },
    };
    const input: QuestionInput = {
      question: "How does authentication establish a session?",
      contextText: "function createSession() { return db.query(); }",
      files: [
        {
          path: "lib/auth/session.ts",
          contentHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
          totalLines: 120,
        },
      ],
    };
    const first = await answerQuestion(input, {
      cache: mockCache,
      complete: async () =>
        "Authentication creates a session via `lib/auth/session.ts#L10-L40`.",
    });
    const second = await answerQuestion(input, {
      cache: mockCache,
      complete: async () => "SHOULD NOT BE CALLED",
    });
    const liveProfile = resolveModelProfile(MODELS.question, resolveBaseUrl());
    const expectedWarnCount = liveProfile.isFallback ? 1 : 0;
    check(
      warnLines.length === expectedWarnCount,
      expectedWarnCount === 1
        ? "fallback ask warns exactly once; the cached serve adds no second warn"
        : "verified ask stays silent",
      `warnLines=${JSON.stringify(warnLines)}`,
    );
    if (expectedWarnCount === 1 && warnLines.length === 1) {
      check(warnLines[0].includes(first.model), "warn names the pinned question model");
    }
    check(second.cached === true, "cache-serve path returns the cached answer");
    check(second.citations.length === 1, "cached answer re-verifies its citations");
  } finally {
    console.warn = originalWarn;
  }
}

console.log("\n========================================================");
console.log(`CI-8E Edge Case Results: ${passed} passed, ${failed} failed`);
console.log("========================================================");

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
