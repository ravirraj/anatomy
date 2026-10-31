// Deterministic question planner — Phase 2 of the coverage-driven Q&A plan.
//
// Runs before retrieval with no model call, no database, and no ingestion:
// it reshapes only what the *question* means, not what the repository has.
// Everything it produces is derived from the question plus the same generic
// concept vocabulary the retrieval engine already uses (stop words, stems,
// glossary, onboarding patterns), so the plan and retrieval can never drift
// apart about what a word means.
//
// Output is fully explainable: every concept lists each variant with the
// source that produced it (the asker's own token, an inflection/derived
// variant, a glossary synonym), and the intent names the pattern that fired.

import {
  extractQueryTokens,
  identifierSubtokens,
  isOnboardingQuery,
  tokenVariants,
} from "./retrieval.ts";
import type { ConceptIndex } from "./concepts/types.ts";

export const INTENTS = [
  "explain-architecture",
  "usage-integration",
  "diagnose-behavior",
  "trace-flow",
  "locate-implementation",
  "explain-function",
  "explain-subsystem",
] as const;

export type QuestionIntent = (typeof INTENTS)[number];

export type VariantSource = "direct" | "stem" | "glossary" | "subtoken";

export type PlannedVariant = { text: string; source: VariantSource };

export type PlannedConcept = {
  /** The asker's own word (already stop-filtered by token extraction). */
  token: string;
  variants: PlannedVariant[];
  /** Evidence kinds the coverage evaluator should expect for this concept. */
  expectedEvidence: string[];
};

export type QuestionPlan = {
  query: string;
  isOnboarding: boolean;
  intent: QuestionIntent;
  /** Why this intent fired — a quoted word or the fallback reason. */
  intentReason: string;
  concepts: PlannedConcept[];
  /** Words dropped from concept evidence: stop words and generic action verbs. */
  unusedTokens: { word: string; reason: "stop-word" | "generic-verb" | "filler" }[];
  /** Union of every concept's expected evidence categories. */
  expectedEvidence: string[];
  /**
   * False only when the question contains no concepts at all — the pipeline
   * can then short-circuit into the insufficient-evidence response without
   * paying for retrieval.
   */
  isAnswerable: boolean;
  /** Discovered concepts from repository index when provided to planner. */
  matchedConceptIds?: string[];
};

// Action verbs describing what the asker wants done with the answer, never a
// thing to find evidence about. They are removed from the concept list (and
// recorded as unused) so generic verbs cannot dominate concept matching; the
// generics already carrying retrieval weight via stop words stay there.
const GENERIC_VERBS = new Set([
  "call", "create", "handle", "implement", "learn", "need", "run", "tell",
  "understand", "want", "write",
]);

// Words that talk about the act of asking, not about a concept.
const FILLER_WORDS = new Set([
  "correctly", "easily", "me", "mine", "my", "our", "please", "properly",
  "should", "way", "well", "you", "your",
]);

// Generic engineering vocabulary for *where* a concept's evidence is
// expected to live. Deliberately small and repo-agnostic: these are the
// architectural roles any feature may span, not knowledge of any repository.
const CONCEPT_CATEGORIES: { words: string[]; categories: string[] }[] = [
  {
    words: ["auth", "authentication", "authorization", "authorize", "login",
      "signin", "signup", "register", "session", "token", "jwt", "oauth",
      "permission", "role", "password"],
    categories: ["controllers", "middleware", "models", "frontend"],
  },
  {
    words: ["db", "database", "connection", "migration", "query", "storage",
      "redis", "cache", "model", "schema", "table", "entity"],
    categories: ["models", "services", "config"],
  },
  {
    words: ["upload", "uploads", "multipart", "attachment", "formdata"],
    categories: ["controllers", "services", "models", "config"],
  },
  {
    words: ["error", "errors", "exception", "failure", "throw", "catch",
      "handling", "log", "logger"],
    categories: ["middleware", "services", "frontend"],
  },
  {
    words: ["sdk", "client", "package", "packages", "library", "frontend"],
    categories: ["routes", "controllers", "frontend"],
  },
  {
    words: ["api", "endpoint", "webhook", "webhooks", "queue", "job", "cron",
      "backend", "server", "route", "router", "endpoint"],
    categories: ["routes", "controllers", "services"],
  },
  {
    words: ["config", "configuration", "environment", "env"],
    categories: ["config"],
  },
  {
    words: ["ui", "page", "component", "hook", "store", "state"],
    categories: ["frontend"],
  },
  {
    words: ["cors", "cookie", "cookies"],
    categories: ["middleware", "config"],
  },
];

const CATEGORIES_BY_WORD = new Map<string, string[]>();
for (const entry of CONCEPT_CATEGORIES) {
  for (const word of entry.words) {
    const merged = CATEGORIES_BY_WORD.get(word) ?? [];
    CATEGORIES_BY_WORD.set(word, [
      ...merged,
      ...entry.categories.filter((c) => !merged.includes(c)),
    ]);
  }
}

// Intent detection: first pattern that fires wins (ordered most-specific to
// least). Each entry carries the vocabulary that signals it.
const INTENT_PATTERNS: { intent: QuestionIntent; patterns: RegExp[] }[] = [
  {
    intent: "explain-architecture",
    patterns: [
      /\barchitectur/i, /\bstructure\b/i, /\borganiz/i, /\borganis/i,
      /\blayout\b/i, /\bmodules\b.*\bfit\b/i, /\blayers\b/i,
    ],
  },
  {
    intent: "usage-integration",
    patterns: [
      /\bhow (?:do|can|should) (?:i|we|one|you) /i,
      /\b(?:integrat|consum|install|implement in)\w*\b/i,
      /\busage\b/i,
    ],
  },
  {
    intent: "diagnose-behavior",
    patterns: [
      /\bwhy\b/i, /\b(?:isn'?t|is not|doesn'?t|does not|won'?t|will not)\b/i,
      /\b(?:not )?work(?:ing|s)?\b.*\b(?:broken|fail|issue|bug|wrong)\b/i,
      /\b(?:fail(?:s|ing|ed)?|broken|crash(?:es|ed)?|bug|issue|wrong)\b/i,
    ],
  },
  {
    intent: "trace-flow",
    patterns: [
      /\bflow\b/i, /\blifecycle\b/i, /\blife[- ]?cycle\b/i, /\btrace\b/i,
      /\bsequence\b/i, /\bsteps?\b/i, /\bend[- ]to[- ]end\b/i,
      /\bfrom .* to .* (?:happen|work)/i,
    ],
  },
  {
    intent: "locate-implementation",
    patterns: [
      /\bwhere\b/i, /\bwhich file\b/i, /\bwhat file\b/i, /\bwhich (?:part|code|module)\b/i,
      /\bfind\b/i, /\blocat/i,
    ],
  },
  {
    intent: "explain-function",
    patterns: [
      /\bwhat does .* (?:do|return)\b/i,
      /\bhow does .* function\b/i,
      /\bwhat (?:does|is) (?:this|the) (?:helper|function|method)\b/i,
    ],
  },
];

/**
 * Identifiers in the *raw* query — camelCase words, SCREAMING_CASE, tokens
 * with function-call parentheses — signal the asker names a specific
 * implementation, which is the explain-function intent.
 */
function looksIdentifier(word: string): boolean {
  return /[a-z][A-Z]/.test(word) || /^[A-Z]+_[A-Z_]+$/.test(word)
    || /^[A-Z][a-z]/.test(word) && /[A-Z]/.test(word.slice(1))
    || /\(/.test(word);
}

export function planQuestion(query: string, conceptIndex?: ConceptIndex): QuestionPlan {
  const isOnboarding = isOnboardingQuery(query);
  const tokens = extractQueryTokens(query);

  const unusedTokens: QuestionPlan["unusedTokens"] = [];
  const words = query
    .replace(/[^A-Za-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const notConcepts = new Set([...GENERIC_VERBS, ...FILLER_WORDS]);
  for (const token of tokens) {
    if (!notConcepts.has(token)) continue;
    unusedTokens.push({
      word: token,
      reason: GENERIC_VERBS.has(token) ? "generic-verb" : "filler",
    });
  }
  const conceptTokens = tokens.filter((token) => !notConcepts.has(token));
  const tokenSet = new Set(tokens);
  for (const word of words) {
    const lower = word.toLowerCase();
    if (tokenSet.has(lower)) continue;
    if (GENERIC_VERBS.has(lower) || notConcepts.has(lower)) {
      unusedTokens.push({
        word: lower,
        reason: GENERIC_VERBS.has(lower) ? "generic-verb" : "filler",
      });
    } else if (lower.length < 2) {
      unusedTokens.push({ word: lower, reason: "filler" });
    } else {
      // Token extraction already stop-words everything else; record the
      // dropped word as a stop-word for the plan's readability.
      unusedTokens.push({ word: lower, reason: "stop-word" });
    }
  }

  const concepts: PlannedConcept[] = conceptTokens.map((token) => {
    const variants: PlannedVariant[] = tokenVariants(token).map(({ text, kind }) => ({
      text,
      source: kind === "original" ? "direct" : kind === "stem" ? "stem" : "glossary",
    }));
    // A concept whose asker wrote it as one identifier ("authservice")
    // should also name its own subtokens, in the asker's own words.
    for (const subtoken of identifierSubtokens(token)) {
      if (subtoken !== token && !variants.some((v) => v.text === subtoken)) {
        variants.push({ text: subtoken, source: "subtoken" });
      }
    }
    const matchedConceptIds: string[] = [];
    if (conceptIndex) {
      for (const v of variants) {
        const hits = conceptIndex.termToConcepts.get(v.text);
        if (hits) {
          for (const hid of hits) {
            if (!matchedConceptIds.includes(hid)) matchedConceptIds.push(hid);
          }
        }
      }
    }

    // Adaptive categories from matched repository concepts take precedence when available
    const adaptiveCategories: string[] = [];
    if (conceptIndex && matchedConceptIds.length > 0) {
      for (const cid of matchedConceptIds) {
        const c = conceptIndex.concepts.find((x) => x.id === cid);
        if (c) {
          for (const cat of c.discoveredCategories) {
            if (!adaptiveCategories.includes(cat)) adaptiveCategories.push(cat);
          }
        }
      }
    }

    return {
      token,
      variants,
      expectedEvidence: adaptiveCategories.length > 0 ? adaptiveCategories : expectedEvidenceFor(variants),
    };
  });

  // Intent: the first firing pattern wins; identifiers promote a residual
  // question to explain-function; onboarding questions are architecture.
  let intent: QuestionIntent = isOnboarding ? "explain-architecture" : "explain-subsystem";
  let intentReason = isOnboarding
    ? "onboarding question (overview/architecture vocabulary)"
    : "no stronger signal — default subsystem explanation";
  if (isOnboarding) {
    intentReason = "onboarding pattern (overview/architecture vocabulary)";
  } else {
    for (const { patterns, intent: candidate } of INTENT_PATTERNS) {
      const hit = patterns.find((p) => p.test(query));
      if (hit) {
        intent = candidate;
        intentReason = `pattern ${hit} fired`;
        break;
      }
    }
    if (intent === "explain-subsystem") {
      const identifier = words.find((w) => w.length >= 3 && looksIdentifier(w));
      if (identifier) {
        intent = "explain-function";
        intentReason = `identifier "${identifier}" names a specific piece of code`;
      }
    }
  }

  const expectedEvidence = [...new Set(concepts.flatMap((c) => c.expectedEvidence))];

  return {
    query,
    isOnboarding,
    intent,
    intentReason,
    concepts,
    unusedTokens,
    expectedEvidence,
    isAnswerable: concepts.length > 0,
  };
}

function expectedEvidenceFor(variants: PlannedVariant[]): string[] {
  const out = new Set<string>();
  for (const { text, source } of variants) {
    if (source === "direct" || source === "glossary") {
      for (const category of CATEGORIES_BY_WORD.get(text) ?? []) out.add(category);
    }
  }
  return [...out];
}
