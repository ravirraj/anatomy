// lib/ai/budget.ts
// CI-8: Unified Prompt Budget Manager
// Implements model context profile resolution, trusted-host matching, validated
// environment configuration, heuristic token estimation, dual-stage budgeting,
// and typed pre-flight / provider overflow errors.

/**
 * Authoritative context window and max output token definitions for known models.
 * Sources:
 * - OpenAI official documentation: https://platform.openai.com/docs/models
 * - OpenRouter official model cards: https://openrouter.ai/models
 */
export const KNOWN_MODEL_LIMITS: Record<
  string,
  { contextWindow: number; maxOutput: number; provider: "openai" | "openrouter" }
> = {
  // Direct OpenAI documented models
  "gpt-4o": { contextWindow: 128_000, maxOutput: 16_384, provider: "openai" },
  "gpt-4o-2024-08-06": { contextWindow: 128_000, maxOutput: 16_384, provider: "openai" },
  "gpt-4o-2024-11-20": { contextWindow: 128_000, maxOutput: 16_384, provider: "openai" },
  "gpt-4o-mini": { contextWindow: 128_000, maxOutput: 16_384, provider: "openai" },
  "gpt-4o-mini-2024-07-18": { contextWindow: 128_000, maxOutput: 16_384, provider: "openai" },
  "gpt-4-turbo": { contextWindow: 128_000, maxOutput: 4_096, provider: "openai" },
  "gpt-4-turbo-2024-04-09": { contextWindow: 128_000, maxOutput: 4_096, provider: "openai" },
  "gpt-4": { contextWindow: 8_192, maxOutput: 4_096, provider: "openai" },
  "gpt-4-0613": { contextWindow: 8_192, maxOutput: 4_096, provider: "openai" },
  "gpt-3.5-turbo": { contextWindow: 16_385, maxOutput: 4_096, provider: "openai" },
  "gpt-3.5-turbo-0125": { contextWindow: 16_385, maxOutput: 4_096, provider: "openai" },

  // OpenRouter documented models
  "openai/gpt-4o-mini": { contextWindow: 128_000, maxOutput: 4_000, provider: "openrouter" },
  "openai/gpt-4o": { contextWindow: 128_000, maxOutput: 4_096, provider: "openrouter" },
};

export const DEFAULT_UNKNOWN_CONTEXT_WINDOW = 8_192;
export const DEFAULT_UNKNOWN_MAX_OUTPUT = 1_500;
export const DEFAULT_UNKNOWN_OPERATIONAL_INPUT_TOKENS = 4_500;
export const DEFAULT_UNKNOWN_SAFETY_HEADROOM_TOKENS = 2_192; // 8,192 - 1,500 - 4,500 = 2,192 (26.8% headroom)
export const DEFAULT_UNKNOWN_MAX_INPUT_CHARACTERS = 13_500; // 4,500 * 3.0 = 13,500 chars (derived from code density)
export const MIN_INPUT_HEADROOM_TOKENS = 1_000;
export const SAFETY_HEADROOM_PERCENT = 0.15; // 15% safety headroom margin for verified large profiles

export type ModelContextProfile = {
  /** Model identifier passed to provider */
  model: string;
  /** Total context window in tokens (prompt + completion) */
  contextWindowTokens: number;
  /** Maximum completion tokens reserved for output */
  maxOutputTokens: number;
  /** Operational target for input tokens (contextWindow - maxOutput - safetyHeadroom) */
  operationalInputTokens: number;
  /** Safety headroom buffer reserved to absorb heuristic variance */
  safetyHeadroomTokens: number;
  /** Hard input character ceiling derived from operational limits */
  maxInputCharacters: number;
  /** Provider classification */
  provider: "openai" | "openrouter" | "custom";
  /** True when the model is not verified and operates under safe fallback */
  isFallback: boolean;
};

export type PromptBudgetEvaluation = {
  valid: boolean;
  model: string;
  totalCharacters: number;
  maxInputCharacters: number;
  estimatedTokens: number;
  operationalInputTokens: number;
  contextWindowTokens: number;
  reservedOutputTokens: number;
  safetyHeadroomTokens: number;
  violations: string[];
};

/**
 * Thrown pre-flight before sending any request when a prompt's estimated tokens
 * or character length exceeds the operational budget, even after compaction.
 * Never retried; never written to cache.
 */
export class BudgetExhaustedError extends Error {
  readonly code = "BUDGET_EXHAUSTED";
  readonly model: string;
  readonly totalCharacters: number;
  readonly estimatedTokens: number;
  readonly operationalInputTokens: number;
  readonly maxInputCharacters: number;
  readonly violations: string[];

  constructor(
    model: string,
    totalCharacters: number,
    estimatedTokens: number,
    operationalInputTokens: number,
    maxInputCharacters: number,
    violations: string[],
  ) {
    super(
      `[Prompt Budget] Prompt exceeds conservative budget for model "${model}": ` +
      `${violations.join("; ")} (chars=${totalCharacters}/${maxInputCharacters}, estTokens=${estimatedTokens}/${operationalInputTokens}). Refusing dispatch pre-flight.`
    );
    this.name = "BudgetExhaustedError";
    this.model = model;
    this.totalCharacters = totalCharacters;
    this.estimatedTokens = estimatedTokens;
    this.operationalInputTokens = operationalInputTokens;
    this.maxInputCharacters = maxInputCharacters;
    this.violations = violations;
  }
}

/**
 * Thrown when an upstream provider returns an HTTP 400 context length exceeded error.
 * Excluded from transient retry loops; never written to cache.
 */
export class BudgetOverflowError extends Error {
  readonly code = "BUDGET_OVERFLOW";
  readonly model: string;
  readonly providerMessage: string;

  constructor(model: string, providerMessage: string) {
    super(
      `[Prompt Budget] Provider rejected request for model "${model}": context length exceeded. ` +
      `Details: ${providerMessage}`
    );
    this.name = "BudgetOverflowError";
    this.model = model;
    this.providerMessage = providerMessage;
  }
}

/**
 * Validates and parses environment variables `AI_CONTEXT_WINDOW_TOKENS` and `AI_MAX_OUTPUT_TOKENS`.
 * Fail-fast policy: Unset variables use documented defaults; explicitly invalid values throw immediately.
 */
export function parseContextLimits(env: Record<string, string | undefined> = process.env): {
  contextWindowTokens: number;
  maxOutputTokens: number;
  isCustomConfigured: boolean;
} {
  let contextWindowTokens: number | undefined;
  let maxOutputTokens: number | undefined;
  let isCustomConfigured = false;

  const rawWindow = env.AI_CONTEXT_WINDOW_TOKENS?.trim();
  if (rawWindow !== undefined && rawWindow !== "") {
    const parsed = Number(rawWindow);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `[AI Configuration Error] Invalid AI_CONTEXT_WINDOW_TOKENS="${env.AI_CONTEXT_WINDOW_TOKENS}". Must be a positive integer.`
      );
    }
    contextWindowTokens = parsed;
    isCustomConfigured = true;
  }

  const rawOutput = env.AI_MAX_OUTPUT_TOKENS?.trim();
  if (rawOutput !== undefined && rawOutput !== "") {
    const parsed = Number(rawOutput);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `[AI Configuration Error] Invalid AI_MAX_OUTPUT_TOKENS="${env.AI_MAX_OUTPUT_TOKENS}". Must be a positive integer.`
      );
    }
    maxOutputTokens = parsed;
    isCustomConfigured = true;
  }

  // Derive defaults when only one or neither is set:
  if (contextWindowTokens === undefined) {
    contextWindowTokens = DEFAULT_UNKNOWN_CONTEXT_WINDOW;
  }

  if (maxOutputTokens === undefined) {
    maxOutputTokens = Math.min(DEFAULT_UNKNOWN_MAX_OUTPUT, Math.floor(contextWindowTokens * 0.25));
  }

  // Enforce mutual invariant: output cannot starve input headroom
  if (maxOutputTokens > contextWindowTokens - MIN_INPUT_HEADROOM_TOKENS) {
    throw new Error(
      `[AI Configuration Error] Invariant violation: AI_MAX_OUTPUT_TOKENS (${maxOutputTokens}) leaves insufficient headroom for AI_CONTEXT_WINDOW_TOKENS (${contextWindowTokens}). Must leave at least ${MIN_INPUT_HEADROOM_TOKENS} tokens for prompt input.`
    );
  }

  return { contextWindowTokens, maxOutputTokens, isCustomConfigured };
}

/**
 * Checks whether baseUrl points directly to OpenAI's public API.
 * Protocol must be https: or http:, and hostname must be exactly api.openai.com (case-insensitive).
 * Empty or undefined baseUrl defaults to OpenAI direct.
 */
export function isOpenAiDirectHost(baseUrl: string | undefined): boolean {
  if (!baseUrl || baseUrl.trim() === "") return true;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    return url.hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * Checks whether baseUrl points to OpenRouter.
 * Protocol must be https: or http:, and hostname must be exactly openrouter.ai
 * or end with a valid subdomain (.openrouter.ai).
 * Deceptive suffixes (e.g. openrouter.ai.attacker.example) and malformed URLs return false.
 */
export function isOpenRouterHost(baseUrl: string | undefined): boolean {
  if (!baseUrl || baseUrl.trim() === "") return false;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

/**
 * Resolves model profile from model name, base URL, and environment overrides.
 * Enforces trusted-host matching: custom endpoints never inherit assumed limits.
 */
export function resolveModelProfile(
  model: string,
  baseUrl?: string,
  env: Record<string, string | undefined> = process.env,
): ModelContextProfile {
  const isDirectOpenAi = isOpenAiDirectHost(baseUrl);
  const isOpenRouter = isOpenRouterHost(baseUrl);

  // Check env configuration overrides first
  const { contextWindowTokens: envWindow, maxOutputTokens: envOutput, isCustomConfigured } = parseContextLimits(env);

  let verified = false;
  let contextWindow = envWindow;
  let maxOutput = envOutput;
  let provider: "openai" | "openrouter" | "custom" = "custom";

  if (!isCustomConfigured) {
    const known = KNOWN_MODEL_LIMITS[model];
    if (known) {
      if (known.provider === "openai" && isDirectOpenAi) {
        contextWindow = known.contextWindow;
        maxOutput = known.maxOutput;
        provider = "openai";
        verified = true;
      } else if (known.provider === "openrouter" && isOpenRouter) {
        contextWindow = known.contextWindow;
        maxOutput = known.maxOutput;
        provider = "openrouter";
        verified = true;
      }
    }
  } else {
    // Custom configured via explicit environment variables
    if (isDirectOpenAi) provider = "openai";
    else if (isOpenRouter) provider = "openrouter";
    verified = true;
  }

  if (!verified) {
    return {
      model,
      contextWindowTokens: DEFAULT_UNKNOWN_CONTEXT_WINDOW,
      maxOutputTokens: DEFAULT_UNKNOWN_MAX_OUTPUT,
      operationalInputTokens: DEFAULT_UNKNOWN_OPERATIONAL_INPUT_TOKENS,
      safetyHeadroomTokens: DEFAULT_UNKNOWN_SAFETY_HEADROOM_TOKENS,
      maxInputCharacters: DEFAULT_UNKNOWN_MAX_INPUT_CHARACTERS,
      provider,
      isFallback: true,
    };
  }

  // Calculate headroom and operational targets for verified profiles
  const safetyHeadroomTokens = Math.max(100, Math.floor(contextWindow * SAFETY_HEADROOM_PERCENT));
  const availableInputTokens = Math.max(0, contextWindow - maxOutput);
  const operationalInputTokens = Math.max(0, availableInputTokens - safetyHeadroomTokens);

  // Hard character ceiling:
  // For verified 128k models, cap at 90,000 characters (standard bounded input).
  // For smaller models (e.g. 16k/32k), scale character ceiling to min(90000, operationalInputTokens * 3.0)
  const maxInputCharacters = Math.min(90_000, Math.floor(operationalInputTokens * 3.0));

  return {
    model,
    contextWindowTokens: contextWindow,
    maxOutputTokens: maxOutput,
    operationalInputTokens,
    safetyHeadroomTokens,
    maxInputCharacters,
    provider,
    isFallback: false,
  };
}

/**
 * Conservative statistical heuristic for code snippets (identifiers, punctuation, indentation).
 * Note: Heuristics are operational approximations, not mathematical upper bounds.
 */
export function estimateCodeTokens(code: string): number {
  if (!code) return 0;
  return Math.ceil(code.length / 3.0);
}

/**
 * Conservative statistical heuristic for English prose and prompt instructions.
 */
export function estimateProseTokens(prose: string): number {
  if (!prose) return 0;
  return Math.ceil(prose.length / 3.5);
}

/**
 * Composite prompt token estimation.
 */
export function estimatePromptTokens(system: string, user: string): number {
  return estimateProseTokens(system) + estimateCodeTokens(user);
}

/**
 * Evaluates whether an assembled prompt satisfies the model profile's pre-flight budget invariants.
 */
export function evaluatePromptBudget(
  profile: ModelContextProfile,
  systemPrompt: string,
  userMessage: string,
): PromptBudgetEvaluation {
  const totalCharacters = systemPrompt.length + userMessage.length;
  const estimatedTokens = estimatePromptTokens(systemPrompt, userMessage);
  const violations: string[] = [];

  // Check 1: Hard character ceiling
  if (totalCharacters > profile.maxInputCharacters) {
    violations.push(`Total characters (${totalCharacters}) exceeds hard ceiling (${profile.maxInputCharacters})`);
  }

  // Check 2: Operational input token target
  if (estimatedTokens > profile.operationalInputTokens) {
    violations.push(`Estimated tokens (${estimatedTokens}) exceeds operational target (${profile.operationalInputTokens})`);
  }

  // Check 3: Context headroom invariant
  const totalEstimatedLoad = estimatedTokens + profile.maxOutputTokens + profile.safetyHeadroomTokens;
  if (totalEstimatedLoad > profile.contextWindowTokens) {
    violations.push(
      `Total estimated load (${totalEstimatedLoad} = ${estimatedTokens} prompt + ${profile.maxOutputTokens} output + ${profile.safetyHeadroomTokens} headroom) exceeds context window (${profile.contextWindowTokens})`
    );
  }

  return {
    valid: violations.length === 0,
    model: profile.model,
    totalCharacters,
    maxInputCharacters: profile.maxInputCharacters,
    estimatedTokens,
    operationalInputTokens: profile.operationalInputTokens,
    contextWindowTokens: profile.contextWindowTokens,
    reservedOutputTokens: profile.maxOutputTokens,
    safetyHeadroomTokens: profile.safetyHeadroomTokens,
    violations,
  };
}

/**
 * Asserts that a prompt fits within the model profile's pre-flight budget.
 * Throws BudgetExhaustedError if any invariant is violated.
 */
export function assertPromptBudget(
  profile: ModelContextProfile,
  systemPrompt: string,
  userMessage: string,
): void {
  const evaluation = evaluatePromptBudget(profile, systemPrompt, userMessage);
  if (!evaluation.valid) {
    throw new BudgetExhaustedError(
      profile.model,
      evaluation.totalCharacters,
      evaluation.estimatedTokens,
      evaluation.operationalInputTokens,
      evaluation.maxInputCharacters,
      evaluation.violations,
    );
  }
}
