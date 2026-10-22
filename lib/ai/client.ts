import OpenAI from "openai";
import { wrapOpenAI } from "langsmith/wrappers/openai";

// The one place the AI client is constructed. A client built anywhere else
// would work and silently go untraced, so nothing else imports "openai".

// Exact snapshots, never a moving alias: an alias changes the model under a
// cached answer without changing its key. Each model is part of its own
// tasks' cache keys, so re-pinning one invalidates only its own answers.
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY?.trim();

// Unset means OpenAI's own API. Set, it's any OpenAI-compatible endpoint:
// Google's compatibility layer for Gemini, or OpenRouter.
const BASE_URL = process.env.AI_BASE_URL?.trim() || (OPENROUTER_KEY ? "https://openrouter.ai/api/v1" : undefined);
const isOpenRouter = Boolean(OPENROUTER_KEY || BASE_URL?.includes("openrouter.ai"));

// The defaults are OpenAI's, or OpenRouter's when using OpenRouter. Any OpenAI-compatible
// endpoint works by setting AI_BASE_URL and these two names. The model is still pinned,
// and still part of the key, so switching provider invalidates only the answers that
// provider wrote.
export const MODELS = {
  explain: process.env.AI_MODEL_EXPLAIN?.trim() || (isOpenRouter ? "openai/gpt-4o-mini" : "gpt-5.5-2026-04-23"),
  classify: process.env.AI_MODEL_CLASSIFY?.trim() || (isOpenRouter ? "openai/gpt-4o-mini" : "gpt-5.4-mini-2026-03-17"),
} as const;

export type TracingStatus = { on: true; project: string } | { on: false; reason: string };

// An absent key looks exactly like a working setup with no traffic, so the
// state is reported with every answer instead of being inferred.
export function tracingStatus(): TracingStatus {
  if (process.env.LANGSMITH_TRACING?.trim() !== "true") return { on: false, reason: "LANGSMITH_TRACING isn't \"true\"" };
  if (!process.env.LANGSMITH_API_KEY?.trim()) return { on: false, reason: "LANGSMITH_API_KEY isn't set" };
  return { on: true, project: process.env.LANGSMITH_PROJECT?.trim() || "default" };
}

// Only OpenAI's own API takes this one. The others either ignore it or
// refuse the request, and a refusal is a failed explanation.
export function openAIOnly(): { verbosity?: "low" } {
  return BASE_URL ? {} : { verbosity: "low" };
}

let client: OpenAI | null = null;

// Built on first use rather than at import, so a missing key fails the call
// that needed it with a message saying so, not the server's boot.
export function ai(): OpenAI {
  if (client) return client;
  const apiKey =
    process.env.AI_API_KEY?.trim() ||
    process.env.OPENROUTER_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Neither OPENROUTER_API_KEY, AI_API_KEY, nor OPENAI_API_KEY is set in .env.local, so nothing can be explained",
    );
  }
  const defaultHeaders: Record<string, string> = {};
  if (isOpenRouter) {
    defaultHeaders["HTTP-Referer"] = process.env.OPENROUTER_HTTP_REFERER?.trim() || "http://localhost:3000";
    defaultHeaders["X-Title"] = "Anatomy";
  }
  client = wrapOpenAI(
    new OpenAI({
      apiKey,
      baseURL: BASE_URL,
      ...(Object.keys(defaultHeaders).length > 0 ? { defaultHeaders } : {}),
    }),
    { tracingEnabled: tracingStatus().on },
  );
  return client;
}

/**
 * How every traced step is recorded. Whatever runs inside it, the cache read
 * included, is one run, so a cache hit shows up as a run with no model call
 * under it. With tracing off the function runs exactly the same, untraced.
 */
export function traceConfig(name: string) {
  return { name, run_type: "chain", tracingEnabled: tracingStatus().on } as const;
}
