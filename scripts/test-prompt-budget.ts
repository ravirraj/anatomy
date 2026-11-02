// scripts/test-prompt-budget.ts
// CI-8B Unit Tests: Prompt Budget Manager
// Tests trusted host matching, profile resolution, configuration validation,
// token estimation, pre-flight budget checks, and typed error contracts.

import {
  DEFAULT_UNKNOWN_CONTEXT_WINDOW,
  DEFAULT_UNKNOWN_MAX_OUTPUT,
  DEFAULT_UNKNOWN_OPERATIONAL_INPUT_TOKENS,
  DEFAULT_UNKNOWN_SAFETY_HEADROOM_TOKENS,
  DEFAULT_UNKNOWN_MAX_INPUT_CHARACTERS,
  isOpenAiDirectHost,
  isOpenRouterHost,
  parseContextLimits,
  resolveModelProfile,
  estimateCodeTokens,
  estimateProseTokens,
  estimatePromptTokens,
  evaluatePromptBudget,
  assertPromptBudget,
  BudgetExhaustedError,
  BudgetOverflowError,
} from "../lib/ai/budget.ts";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`ok    ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` (${detail})` : ""}`);
  }
}

console.log("=== 1. Trusted Host Matching & Edge Cases ===");
// OpenAI Direct Host matching
check("isOpenAiDirectHost(undefined) is true", isOpenAiDirectHost(undefined) === true);
check("isOpenAiDirectHost('') is true", isOpenAiDirectHost("") === true);
check("isOpenAiDirectHost('   ') is true", isOpenAiDirectHost("   ") === true);
check(
  "isOpenAiDirectHost('https://api.openai.com/v1') is true",
  isOpenAiDirectHost("https://api.openai.com/v1") === true,
);
check(
  "isOpenAiDirectHost('http://api.openai.com') is true",
  isOpenAiDirectHost("http://api.openai.com") === true,
);
check(
  "isOpenAiDirectHost case normalization ('HTTPS://API.OPENAI.COM/V1') is true",
  isOpenAiDirectHost("HTTPS://API.OPENAI.COM/V1") === true,
);

// OpenAI Direct Host rejections (deceptive domains, unexpected protocols, malformed)
check(
  "isOpenAiDirectHost deceptive suffix ('https://api.openai.com.attacker.example') is false",
  isOpenAiDirectHost("https://api.openai.com.attacker.example") === false,
);
check(
  "isOpenAiDirectHost unexpected protocol ('ftp://api.openai.com') is false",
  isOpenAiDirectHost("ftp://api.openai.com") === false,
);
check(
  "isOpenAiDirectHost malformed URL ('not-a-url') is false",
  isOpenAiDirectHost("not-a-url") === false,
);
check(
  "isOpenAiDirectHost broken protocol ('://broken') is false",
  isOpenAiDirectHost("://broken") === false,
);
check(
  "isOpenAiDirectHost OpenRouter host ('https://openrouter.ai/api/v1') is false",
  isOpenAiDirectHost("https://openrouter.ai/api/v1") === false,
);
check(
  "isOpenAiDirectHost custom localhost ('http://localhost:8000/v1') is false",
  isOpenAiDirectHost("http://localhost:8000/v1") === false,
);

// OpenRouter Host matching
check("isOpenRouterHost(undefined) is false", isOpenRouterHost(undefined) === false);
check("isOpenRouterHost('') is false", isOpenRouterHost("") === false);
check(
  "isOpenRouterHost('https://openrouter.ai/api/v1') is true",
  isOpenRouterHost("https://openrouter.ai/api/v1") === true,
);
check(
  "isOpenRouterHost valid subdomain ('https://api.openrouter.ai') is true",
  isOpenRouterHost("https://api.openrouter.ai") === true,
);
check(
  "isOpenRouterHost case normalization ('HTTPS://OpenRouter.AI/api/v1') is true",
  isOpenRouterHost("HTTPS://OpenRouter.AI/api/v1") === true,
);

// OpenRouter Host rejections (deceptive domains, unexpected protocols, malformed)
check(
  "isOpenRouterHost deceptive suffix ('https://openrouter.ai.attacker.example/v1') is false",
  isOpenRouterHost("https://openrouter.ai.attacker.example/v1") === false,
);
check(
  "isOpenRouterHost fake domain prefix ('https://fake-openrouter.ai') is false",
  isOpenRouterHost("https://fake-openrouter.ai") === false,
);
check(
  "isOpenRouterHost missing subdomain dot ('https://notopenrouter.ai') is false",
  isOpenRouterHost("https://notopenrouter.ai") === false,
);
check(
  "isOpenRouterHost unexpected protocol ('ws://openrouter.ai') is false",
  isOpenRouterHost("ws://openrouter.ai") === false,
);
check(
  "isOpenRouterHost unexpected protocol ('file:///etc/hosts') is false",
  isOpenRouterHost("file:///etc/hosts") === false,
);
check(
  "isOpenRouterHost malformed URL ('javascript:alert(1)') is false",
  isOpenRouterHost("javascript:alert(1)") === false,
);
check(
  "isOpenRouterHost OpenAI host ('https://api.openai.com/v1') is false",
  isOpenRouterHost("https://api.openai.com/v1") === false,
);
check(
  "isOpenRouterHost local Ollama ('http://127.0.0.1:11434') is false",
  isOpenRouterHost("http://127.0.0.1:11434") === false,
);

console.log("\n=== 2. Authoritative Model Profile Resolution & Fallback Constants ===");
// Verified OpenAI model on direct host
const gpt4oMiniProfile = resolveModelProfile("gpt-4o-mini", "https://api.openai.com/v1", {});
check("gpt-4o-mini on direct OpenAI resolves 128k window", gpt4oMiniProfile.contextWindowTokens === 128_000);
check("gpt-4o-mini maxOutputTokens is 16384", gpt4oMiniProfile.maxOutputTokens === 16_384);
check("gpt-4o-mini provider is openai", gpt4oMiniProfile.provider === "openai");
check("gpt-4o-mini isFallback is false", gpt4oMiniProfile.isFallback === false);

// Verified OpenRouter model on OpenRouter host
const orGpt4oMiniProfile = resolveModelProfile(
  "openai/gpt-4o-mini",
  "https://openrouter.ai/api/v1",
  {},
);
check("openai/gpt-4o-mini on OpenRouter resolves 128k window", orGpt4oMiniProfile.contextWindowTokens === 128_000);
check("openai/gpt-4o-mini maxOutputTokens is 4000", orGpt4oMiniProfile.maxOutputTokens === 4_000);
check("openai/gpt-4o-mini provider is openrouter", orGpt4oMiniProfile.provider === "openrouter");
check("openai/gpt-4o-mini isFallback is false", orGpt4oMiniProfile.isFallback === false);

// Verified model on untrusted/custom host -> safe fallback with exact constants
const customGpt4oProfile = resolveModelProfile("gpt-4o-mini", "http://localhost:8000/v1", {});
check("gpt-4o-mini on custom host uses fallback window 8192", customGpt4oProfile.contextWindowTokens === DEFAULT_UNKNOWN_CONTEXT_WINDOW);
check("gpt-4o-mini on custom host uses fallback output 1500", customGpt4oProfile.maxOutputTokens === DEFAULT_UNKNOWN_MAX_OUTPUT);
check("gpt-4o-mini on custom host operational input is 4500", customGpt4oProfile.operationalInputTokens === DEFAULT_UNKNOWN_OPERATIONAL_INPUT_TOKENS);
check("gpt-4o-mini on custom host safety headroom is 2192", customGpt4oProfile.safetyHeadroomTokens === DEFAULT_UNKNOWN_SAFETY_HEADROOM_TOKENS);
check("gpt-4o-mini on custom host max characters is 13500", customGpt4oProfile.maxInputCharacters === DEFAULT_UNKNOWN_MAX_INPUT_CHARACTERS);
check("gpt-4o-mini on custom host provider is custom", customGpt4oProfile.provider === "custom");
check("gpt-4o-mini on custom host isFallback is true", customGpt4oProfile.isFallback === true);

// Unknown model name on direct OpenAI -> safe fallback
const unknownModelProfile = resolveModelProfile("unlisted-custom-model", undefined, {});
check("unlisted model uses fallback window 8192", unknownModelProfile.contextWindowTokens === DEFAULT_UNKNOWN_CONTEXT_WINDOW);
check("unlisted model max characters is 13500", unknownModelProfile.maxInputCharacters === DEFAULT_UNKNOWN_MAX_INPUT_CHARACTERS);
check("unlisted model isFallback is true", unknownModelProfile.isFallback === true);

// Project forward pins without explicit documentation -> safe fallback
const gpt55Profile = resolveModelProfile("gpt-5.5-2026-04-23", undefined, {});
check("gpt-5.5 forward pin without env config uses safe fallback", gpt55Profile.isFallback === true);

console.log("\n=== 3. Environment Configuration Override Combinations ===");
// Combination A: Neither variable supplied
const envNone = parseContextLimits({});
check("Combination A: neither variable -> default context window 8192", envNone.contextWindowTokens === DEFAULT_UNKNOWN_CONTEXT_WINDOW);
check("Combination A: neither variable -> default output 1500", envNone.maxOutputTokens === DEFAULT_UNKNOWN_MAX_OUTPUT);
check("Combination A: neither variable -> isCustomConfigured is false", envNone.isCustomConfigured === false);

// Combination B: Only AI_CONTEXT_WINDOW_TOKENS supplied
const envOnlyWindow = parseContextLimits({ AI_CONTEXT_WINDOW_TOKENS: "16384" });
check("Combination B: only window -> contextWindowTokens is 16384", envOnlyWindow.contextWindowTokens === 16_384);
check("Combination B: only window -> maxOutputTokens scaled to 1500", envOnlyWindow.maxOutputTokens === 1_500);
check("Combination B: only window -> isCustomConfigured is true", envOnlyWindow.isCustomConfigured === true);

// Combination C: Only AI_MAX_OUTPUT_TOKENS supplied
const envOnlyOutput = parseContextLimits({ AI_MAX_OUTPUT_TOKENS: "2000" });
check("Combination C: only output -> contextWindowTokens is default 8192", envOnlyOutput.contextWindowTokens === DEFAULT_UNKNOWN_CONTEXT_WINDOW);
check("Combination C: only output -> maxOutputTokens is 2000", envOnlyOutput.maxOutputTokens === 2_000);
check("Combination C: only output -> isCustomConfigured is true", envOnlyOutput.isCustomConfigured === true);

// Combination D: Both variables supplied
const envBoth = parseContextLimits({
  AI_CONTEXT_WINDOW_TOKENS: "32768",
  AI_MAX_OUTPUT_TOKENS: "4096",
});
check("Combination D: both -> contextWindowTokens is 32768", envBoth.contextWindowTokens === 32_768);
check("Combination D: both -> maxOutputTokens is 4096", envBoth.maxOutputTokens === 4_096);
check("Combination D: both -> isCustomConfigured is true", envBoth.isCustomConfigured === true);

// Combination E: Fail-fast on invalid values & insufficient headroom
let threwNonIntWindow = false;
try {
  parseContextLimits({ AI_CONTEXT_WINDOW_TOKENS: "thirty-two-k" });
} catch (e) {
  threwNonIntWindow = (e as Error).message.includes("Invalid AI_CONTEXT_WINDOW_TOKENS");
}
check("fail-fast: non-integer AI_CONTEXT_WINDOW_TOKENS throws immediately", threwNonIntWindow);

let threwZeroWindow = false;
try {
  parseContextLimits({ AI_CONTEXT_WINDOW_TOKENS: "0" });
} catch (e) {
  threwZeroWindow = (e as Error).message.includes("Invalid AI_CONTEXT_WINDOW_TOKENS");
}
check("fail-fast: zero AI_CONTEXT_WINDOW_TOKENS throws immediately", threwZeroWindow);

let threwNegativeWindow = false;
try {
  parseContextLimits({ AI_CONTEXT_WINDOW_TOKENS: "-8192" });
} catch (e) {
  threwNegativeWindow = (e as Error).message.includes("Invalid AI_CONTEXT_WINDOW_TOKENS");
}
check("fail-fast: negative AI_CONTEXT_WINDOW_TOKENS throws immediately", threwNegativeWindow);

let threwNonIntOutput = false;
try {
  parseContextLimits({ AI_MAX_OUTPUT_TOKENS: "123.45" });
} catch (e) {
  threwNonIntOutput = (e as Error).message.includes("Invalid AI_MAX_OUTPUT_TOKENS");
}
check("fail-fast: non-integer AI_MAX_OUTPUT_TOKENS throws immediately", threwNonIntOutput);

let threwZeroOutput = false;
try {
  parseContextLimits({ AI_MAX_OUTPUT_TOKENS: "0" });
} catch (e) {
  threwZeroOutput = (e as Error).message.includes("Invalid AI_MAX_OUTPUT_TOKENS");
}
check("fail-fast: zero AI_MAX_OUTPUT_TOKENS throws immediately", threwZeroOutput);

let threwNegativeOutput = false;
try {
  parseContextLimits({ AI_MAX_OUTPUT_TOKENS: "-500" });
} catch (e) {
  threwNegativeOutput = (e as Error).message.includes("Invalid AI_MAX_OUTPUT_TOKENS");
}
check("fail-fast: negative AI_MAX_OUTPUT_TOKENS throws immediately", threwNegativeOutput);

let threwHeadroomViolation = false;
try {
  parseContextLimits({
    AI_CONTEXT_WINDOW_TOKENS: "8192",
    AI_MAX_OUTPUT_TOKENS: "7500", // Leaves only 692 tokens headroom (< 1000)
  });
} catch (e) {
  threwHeadroomViolation = (e as Error).message.includes("Invariant violation");
}
check("fail-fast: output reservation leaving < 1000 headroom throws immediately", threwHeadroomViolation);

let threwOutputExceedsWindow = false;
try {
  parseContextLimits({
    AI_CONTEXT_WINDOW_TOKENS: "8192",
    AI_MAX_OUTPUT_TOKENS: "9000", // Output exceeds window
  });
} catch (e) {
  threwOutputExceedsWindow = (e as Error).message.includes("Invariant violation");
}
check("fail-fast: output reservation exceeding window throws immediately", threwOutputExceedsWindow);

console.log("\n=== 4. Token Estimation Heuristics ===");
check("estimateCodeTokens('') is 0", estimateCodeTokens("") === 0);
check("estimateCodeTokens(30 chars) is 10", estimateCodeTokens("123456789012345678901234567890") === 10);
check("estimateCodeTokens(31 chars) is 11", estimateCodeTokens("1234567890123456789012345678901") === 11);

check("estimateProseTokens('') is 0", estimateProseTokens("") === 0);
check("estimateProseTokens(35 chars) is 10", estimateProseTokens("12345678901234567890123456789012345") === 10);
check("estimateProseTokens(36 chars) is 11", estimateProseTokens("123456789012345678901234567890123456") === 11);

const compositeEst = estimatePromptTokens("System instruction", "const x = 1;");
check("composite estimate sums prose system and code user", compositeEst > 0);

console.log("\n=== 5. Pre-Flight Budget Evaluation & Invariants ===");
const smallSystem = "You are a coding assistant.";
const smallUser = "const a = 1;";
const validEval = evaluatePromptBudget(customGpt4oProfile, smallSystem, smallUser);
check("small prompt evaluates as valid under fallback profile", validEval.valid === true);
check("violations list is empty for valid prompt", validEval.violations.length === 0);

// Asserting valid prompt does not throw
let assertThrew = false;
try {
  assertPromptBudget(customGpt4oProfile, smallSystem, smallUser);
} catch {
  assertThrew = true;
}
check("assertPromptBudget passes silently for valid prompt", !assertThrew);

// Excessive character prompt
const hugeChars = "x".repeat(customGpt4oProfile.maxInputCharacters + 500);
const charOverEval = evaluatePromptBudget(customGpt4oProfile, smallSystem, hugeChars);
check("excessive character prompt evaluates as invalid", charOverEval.valid === false);
check("character ceiling violation reported", charOverEval.violations.some((v) => v.includes("hard ceiling")));

// Excessive token prompt (exceeds operationalInputTokens)
const syntheticHighTokens = "x".repeat(Math.floor(customGpt4oProfile.operationalInputTokens * 3.5) + 1000);
const tokenOverEval = evaluatePromptBudget(customGpt4oProfile, smallSystem, syntheticHighTokens);
check("excessive estimated tokens evaluates as invalid", tokenOverEval.valid === false);
check("operational target violation reported", tokenOverEval.violations.some((v) => v.includes("operational target")));

// assertPromptBudget throws BudgetExhaustedError
let exhaustedThrew = false;
try {
  assertPromptBudget(customGpt4oProfile, smallSystem, hugeChars);
} catch (e) {
  exhaustedThrew = e instanceof BudgetExhaustedError && (e as BudgetExhaustedError).code === "BUDGET_EXHAUSTED";
}
check("assertPromptBudget throws typed BudgetExhaustedError on overflow", exhaustedThrew);

console.log("\n=== 6. Error Taxonomy & Contracts ===");
const exhaustedErr = new BudgetExhaustedError("test-model", 20000, 7000, 4500, 16000, ["Over token budget"]);
check("BudgetExhaustedError name is BudgetExhaustedError", exhaustedErr.name === "BudgetExhaustedError");
check("BudgetExhaustedError code is BUDGET_EXHAUSTED", exhaustedErr.code === "BUDGET_EXHAUSTED");
check("BudgetExhaustedError contains model name", exhaustedErr.model === "test-model");
check("BudgetExhaustedError message mentions pre-flight refusal", exhaustedErr.message.includes("Refusing dispatch pre-flight"));

const overflowErr = new BudgetOverflowError("test-model", "maximum context length is 8192");
check("BudgetOverflowError name is BudgetOverflowError", overflowErr.name === "BudgetOverflowError");
check("BudgetOverflowError code is BUDGET_OVERFLOW", overflowErr.code === "BUDGET_OVERFLOW");
check("BudgetOverflowError contains model name", overflowErr.model === "test-model");
check("BudgetOverflowError message mentions provider context length", overflowErr.message.includes("context length exceeded"));

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}, Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("All prompt budget manager checks passed cleanly.");
}
