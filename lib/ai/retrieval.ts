import type { SupabaseClient } from "@supabase/supabase-js";
import { getFileLines, type BackfillDeps } from "../content/read.ts";
import type { Database } from "../supabase/database.types.ts";
import { planQuestion, type QuestionPlan } from "./planner.ts";
import { formatPackagingEvidence, loadPackagingEvidence } from "./packaging.ts";
import type { ManifestFile } from "./citations.ts";
import { PRIMARY_MANIFEST_NAMES } from "../parser/screening.ts";
import { isCodeFile } from "../parser/walk.ts";
import { QUESTION_SYSTEM } from "./prompts.ts";
import { resolveBaseUrl } from "./client.ts";
import {
  estimateCodeTokens,
  estimateProseTokens,
  resolveModelProfile,
  type ModelContextProfile,
} from "./budget.ts";

export type Db = SupabaseClient<Database>;

export type CoreRetrievalBudget = {
  maxCharacters: number;
  maxFiles: number;
  /**
   * Soft cap on files from one directory in round 1. A concept that lives in
   * a heavily-matched directory must not claim the whole budget before other
   * matched directories get a slot; deferred files are appended in score
   * order, so a question concentrated in one directory still fills every
   * slot exactly as without the cap.
   */
  maxFilesPerDirectory: number;
  maxWindowsPerFile: number;
  seedLimit: number;
};

export type RetrievalBudget = Partial<CoreRetrievalBudget> & {
  /** Operational target for evidence tokens */
  maxTokens?: number;
  /** Model context profile resolving context limits and token targets */
  profile?: ModelContextProfile;
  /** Model identifier used to resolve profile if profile is not directly supplied */
  model?: string;
  /** Explicit token reservation for prompt framing and system instructions */
  reservedTokens?: number;
  /** Explicit character reservation for prompt framing and system instructions */
  reservedCharacters?: number;
  /** Whether this retrieval is an internal iterative category drill pass */
  isIterativePass?: boolean;
};

export const DEFAULT_BUDGET: CoreRetrievalBudget = {
  maxCharacters: 28000,
  maxFiles: 16,
  maxFilesPerDirectory: 1,
  maxWindowsPerFile: 2,
  seedLimit: 5,
};

/**
 * Shapes one raw `symbols` row (generated typings omit `end_line` and
 * enrichment columns, so every read is guarded) for retrieval consumption.
 * Stage A matching, the API-surface appendix, and the Phase-2 symbol listing
 * all share this coercion so they can never drift apart.
 */
function mapSymbolCandidateRow(row: Record<string, unknown>, path: string): NonNullable<RetrievalResult["symbols"]>[number] {
  return {
    fileId: row.file_id as string,
    path,
    name: row.name as string,
    kind: row.kind as string,
    line: row.line as number,
    ...(typeof row.end_line === "number" ? { endLine: row.end_line as number } : {}),
    exported: row.exported as boolean,
    ...(row.export_kind ? { exportKind: row.export_kind as string } : {}),
    ...(row.signature ? { signature: row.signature as string } : {}),
    ...(row.return_type ? { returnType: row.return_type as string } : {}),
    ...(row.documentation ? { documentation: row.documentation as string } : {}),
  };
}

/**
 * The `[API surface]` appendix a prompt attaches under a file's line-1
 * window: exported symbols of that file. Shared by the post-serving block,
 * the serving-phase budget checks (which must reserve the same text), and
 * the iterative merge's appendix accounting, which must reserve what the
 * final prompt renders.
 */
export function formatApiSurfaceFor(syms: NonNullable<RetrievalResult["symbols"]>): string {
  const api = syms
    .filter((s) => s.exported)
    .map((s) => {
      const sig = s.signature ?? s.name;
      const doc = s.documentation ? ` — ${s.documentation.split("\n")[0]}` : "";
      return `- ${s.name} (${s.kind})${s.exportKind && s.exportKind !== "named" ? ` [${s.exportKind}]` : ""}: ${sig}${doc}`;
    })
    .join("\n");
  return api ? `\n\n[API surface]\n${api}` : "";
}


/**
 * Computes net evidence limits (characters, tokens, files) accounting for prompt framing,
 * system instructions, question length, and model context profile.
 */
export function computeEvidenceLimits(
  budget: RetrievalBudget = {},
  rawQuery: string = "",
  packagingText: string = "",
): {
  maxCharacters: number;
  maxTokens: number;
  maxFiles: number;
  maxFilesPerDirectory: number;
  maxWindowsPerFile: number;
  seedLimit: number;
  reservedCharacters: number;
  reservedTokens: number;
  isProfileBound: boolean;
} {
  const profile = budget.profile ?? (budget.model ? resolveModelProfile(budget.model, resolveBaseUrl()) : undefined);

  const maxFiles = budget.maxFiles ?? DEFAULT_BUDGET.maxFiles;
  const maxFilesPerDirectory = budget.maxFilesPerDirectory ?? DEFAULT_BUDGET.maxFilesPerDirectory;
  const maxWindowsPerFile = budget.maxWindowsPerFile ?? DEFAULT_BUDGET.maxWindowsPerFile;
  const seedLimit = budget.seedLimit ?? DEFAULT_BUDGET.seedLimit;

  const systemPrompt = QUESTION_SYSTEM;
  const systemTokens = estimateProseTokens(systemPrompt);
  const systemChars = systemPrompt.length;

  const questionTokens = estimateProseTokens(rawQuery);
  const questionChars = rawQuery.length;

  const framingTokens = 500;
  const framingChars = 1500;

  const packagingTokens = packagingText ? estimateCodeTokens(packagingText) : 0;
  const packagingChars = packagingText ? packagingText.length : 0;

  const defaultReservedTokens = budget.reservedTokens ?? (systemTokens + questionTokens + framingTokens + packagingTokens);
  const defaultReservedCharacters = budget.reservedCharacters ?? (systemChars + questionChars + framingChars + packagingChars);

  if (profile) {
    const promptOverheadTokens = systemTokens + questionTokens + framingTokens;
    const promptOverheadChars = systemChars + questionChars + framingChars;

    const totalAvailableTokens = Math.max(0, profile.operationalInputTokens - promptOverheadTokens);
    const totalAvailableChars = Math.max(0, profile.maxInputCharacters - promptOverheadChars);

    const hasExplicitCodeTarget = /[a-zA-Z0-9_\-./]+\.(?:tsx?|jsx?|mjs|cjs|py|rs|go)\b/i.test(rawQuery);

    const minCodeChars = hasExplicitCodeTarget
      ? Math.min(3600, Math.floor(totalAvailableChars * 0.75))
      : Math.min(3200, Math.floor(totalAvailableChars * 0.65));
    const minCodeTokens = hasExplicitCodeTarget
      ? Math.min(1200, Math.floor(totalAvailableTokens * 0.75))
      : Math.min(1000, Math.floor(totalAvailableTokens * 0.65));

    const maxAllowedPackagingChars = Math.max(0, totalAvailableChars - minCodeChars);
    const maxAllowedPackagingTokens = Math.max(0, totalAvailableTokens - minCodeTokens);

    const effectivePkgChars = Math.min(packagingChars, maxAllowedPackagingChars);
    const effectivePkgTokens = Math.min(packagingTokens, maxAllowedPackagingTokens);

    const reservedTokens = budget.reservedTokens ?? (promptOverheadTokens + effectivePkgTokens);
    const reservedCharacters = budget.reservedCharacters ?? (promptOverheadChars + effectivePkgChars);

    const availableTokens = Math.max(0, profile.operationalInputTokens - reservedTokens);
    const availableCharsCeiling = Math.max(0, profile.maxInputCharacters - reservedCharacters);
    const availableCharsTokens = Math.floor(availableTokens * 3.0);
    const availableChars = Math.min(availableCharsCeiling, availableCharsTokens);

    const targetCharCap = budget.maxCharacters !== undefined
      ? budget.maxCharacters
      : Math.min(availableChars, DEFAULT_BUDGET.maxCharacters);
    const targetTokenCap = budget.maxTokens !== undefined
      ? budget.maxTokens
      : Math.min(availableTokens, Math.ceil(targetCharCap / 3.0));

    const maxCharacters = Math.min(availableChars, targetCharCap);
    const maxTokens = Math.min(availableTokens, targetTokenCap);

    return {
      maxCharacters,
      maxTokens,
      maxFiles,
      maxFilesPerDirectory,
      maxWindowsPerFile,
      seedLimit,
      reservedCharacters,
      reservedTokens,
      isProfileBound: true,
    };
  }

  const maxCharacters = budget.maxCharacters ?? DEFAULT_BUDGET.maxCharacters;
  const maxTokens = budget.maxTokens ?? Math.ceil(maxCharacters / 3.0);

  return {
    maxCharacters,
    maxTokens,
    maxFiles,
    maxFilesPerDirectory,
    maxWindowsPerFile,
    seedLimit,
    reservedCharacters: defaultReservedCharacters,
    reservedTokens: defaultReservedTokens,
    isProfileBound: false,
  };
}

/**
 * General, vocabulary-free penalty for files that are unlikely to carry the
 * primary implementation evidence for a question: test harnesses, specs,
 * documentation, configuration and setup files. These still enter the package
 * when nothing better is available, but they never crowd out a same-or-lower
 * scored source file. Repository-adaptive: the patterns are file kinds, not
 * repository-specific words.
 */
export function supportFilePenalty(path: string): number {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  const filename = segments[segments.length - 1] ?? lower;
  let penalty = 0;
  if (segments.some((s) => s === "test" || s === "tests" || s === "__tests__" || s === "spec" || s === "specs" || s === "docs" || s === "doc")) penalty += 15;
  if (/\.(test|spec)\.[a-z]+$/.test(filename)) penalty += 15;
  if (/\.(config|conf)\.[a-z]+$/.test(filename)) penalty += 10;
  if (/(^|\.)(eslint|prettier|babel|jest|vitest|setup|mocks?|fixtures?)\b/.test(filename)) penalty += 10;
  return penalty;
}

/** Effective ranking score: raw score minus the support-file penalty. */
export function effectiveScore(win: { score: number; path: string }): number {
  return win.score - supportFilePenalty(win.path);
}

export type TargetWindow = {
  fileId: string;
  path: string;
  contentHash: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  score: number;
  reason: string;
  /**
   * Which retrieval strategies produced this window ("symbol", "route",
   * "path", "role", "entry", "expansion", "derive"). Set individually by
   * every seed stage and unioned when windows merge: evidence a file earned
   * through two independent strategies outranks single-strategy evidence.
   */
  strategies?: string[];
  /**
   * Provenance of the relationship that pulled this window in: "indexed"
   * means an existing edge row in the analysis's edges table; "derived"
   * means the relationship was inferred at query time from inspected,
   * hash-verified source text. A derived window is a hint, never an
   * indexed fact, and is ranked below all indexed evidence.
   */
  provenance?: "indexed" | "derived";
  /**
   * The matched evidence core inside this candidate: the matched symbol's
   * own line span. The candidate's startLine/endLine pad that span
   * generously for serving context. When budget-constrained serving cannot
   * fit the whole padded window, serving compacts toward the core — the
   * core's own lines are always served whole (never split, never omitted),
   * recorded bounds stay inside the candidate's original bounds, so
   * citation line ranges and slice content can never diverge.
   * Candidates seeded without a symbol anchor have no core and are never
   * compacted.
   */
  coreStart?: number;
  coreEnd?: number;
};

/**
 * Generic action verbs from the planner ("implement", "handle", …) name what
 * the asker wants done, not something to find evidence about. They still
 * match code, but a window that matched *only* through a generic verb pays
 * this demotion so verb-named files can never outrank concept evidence.
 */
const GENERIC_PENALTY = 25;

/**
 * Serving-layer displacement margin. Within-margin score differences are
 * dominated by corroboration bonuses (+4/+8 per corroborating strategy,
 * +8/+12 for multiple query concepts) — badges the ranking layer itself
 * treats as a tie. When the post-serving rescue needs budget to admit a
 * starved candidate, it may therefore also displace a served window whose
 * effective score sits within this margin of the candidate's, in addition
 * to every strictly weaker one. Serving-only policy: ranking, ordering and
 * explicit-path priority are untouched.
 */
const SERVING_DISPLACEMENT_MARGIN = 15;

// Phase 4 relationship-expansion bounds. No ingestion and no schema
// involvement: expansion stays over the analysis's existing edges, and
// derivation only reads source that the pipeline has already verified.
/** Hard cap on transitive (2-hop) expansion windows per retrieval. */
export const MAX_TRANSITIVE_WINDOWS = 6;
/** Hard cap on windows derived from inspected source imports per retrieval. */
export const MAX_DERIVED_WINDOWS = 8;

export type DerivedReference = {
  specifier: string;
  kind: "import" | "require" | "dynamic-import" | "re-export";
};

const RELATIVE_SPECIFIER = /^\.{1,2}\//;

/**
 * Parses import-family statements out of inspected source text and returns
 * the project-relative specifiers they reference. Purely textual and
 * deterministic — it says nothing about whether a corresponding file exists;
 * the caller resolves candidates against the analysis's own file table.
 * Bare package specifiers ("react") are ignored: relationships are only
 * derived to files of the same analysis.
 */
export function deriveReferences(source: string): DerivedReference[] {
  const out: DerivedReference[] = [];
  const seen = new Set<string>();
  const push = (specifier: string, kind: DerivedReference["kind"]) => {
    if (!RELATIVE_SPECIFIER.test(specifier)) return;
    const key = `${kind}:${specifier}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ specifier, kind });
  };
  // import … from "x" and export … from "x" (re-exports)
  for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;"'\n]*from\s*["']([^"']+)["']/g)) {
    push(m[1]!, m[0]!.trimStart().startsWith("export") ? "re-export" : "import");
  }
  for (const m of source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    push(m[1]!, "require");
  }
  for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    push(m[1]!, "dynamic-import");
  }
  return out;
}

/**
 * Candidate repository paths a relative specifier may resolve to, tried in
 * order: the specifier itself, common source extensions, then index files.
 */
export function specifierCandidates(specifier: string, sourcePath: string): string[] {
  const at = sourcePath.lastIndexOf("/");
  const dir = at === -1 ? "" : sourcePath.slice(0, at + 1);
  const parts = (dir + specifier).split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  const normalized = stack.join("/");
  return [
    normalized,
    `${normalized}.js`,
    `${normalized}.ts`,
    `${normalized}.jsx`,
    `${normalized}.tsx`,
    `${normalized}/index.js`,
    `${normalized}/index.ts`,
  ];
};

export type RetrievedWindow = {
  fileId: string;
  path: string;
  contentHash: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
  reason: string;
  /** Relationship provenance of the window ("indexed" | "derived"). */
  provenance?: "indexed" | "derived";
};

export type RetrievalResult = {
  analysisId: string;
  query: string;
  tokens: string[];
  /** The deterministic planner output behind this retrieval (explainable). */
  plan: QuestionPlan;
  windows: RetrievedWindow[];
  files: { fileId: string; path: string; contentHash: string; totalLines: number; windows?: { startLine: number; endLine: number }[] }[];
  /**
   * Enriched symbol/API surface for the retrieved files, when available.
   * Optional and additive: older callers and tests may omit it.
   */
  symbols?: {
    fileId: string;
    path: string;
    name: string;
    kind: string;
    line: number;
    endLine?: number;
    exported: boolean;
    exportKind?: string;
    signature?: string;
    returnType?: string;
    documentation?: string;
  }[];
  totalCharacters: number;
  totalTokens?: number;
  renderedCharacters?: number;
  insufficientEvidence: boolean;
  /**
   * Packaging, configuration and entry-point evidence, rendered for the model.
   * Additive and optional: it is present only when the query touched packaging
   * vocabulary and the analysis has such facts stored. Its absence means "not
   * asked about", never "the repository has none".
   */
  packaging?: string;
  manifests?: ManifestFile[];
};

// Common English question words and stop-words to exclude from seed token matching
const STOP_WORDS = new Set([
  "a", "about", "across", "all", "an", "and", "any", "are", "as", "at",
  "be", "between", "both", "but", "by", "can", "do", "does", "each",
  "file", "files", "for", "from", "get", "has", "have", "how",
  "in", "is", "it", "its", "locate", "located", "make", "of", "on", "or", "over",
  "show", "tell", "that", "the", "their", "there", "this", "through",
  "to", "under", "up", "use", "used", "uses", "using",
  "what", "when", "where", "which", "who", "why",
  "with", "work", "works",
]);

const ONBOARDING_PATTERNS = [
  /\bexplain\b/i,
  /\boverview\b/i,
  /\barchitecture\b/i,
  /\bunderstand(?:ing)?\b/i,
  /\bcontribut(?:e|ing)\b/i,
  /\bonboard(?:ing)?\b/i,
  /\bhow to start\b/i,
  /\bget started\b/i,
  /\bwalkthrough\b/i,
  /\bstructure\b/i,
  /\bcodebase\b/i,
  /\brepository\b/i,
  /\brepo\b/i,
];

export function isOnboardingQuery(query: string): boolean {
  return ONBOARDING_PATTERNS.some((p) => p.test(query));
}

// --- Concept-aware query expansion ---------------------------------------
// A question names a *concept* ("authentication", "errors", "the database");
// the code names *implementations* ("AuthService", "verifyJWT", "connectDB").
// Retrieval closes that gap with three general mechanisms, in this order of
// strength: light suffix stemming, bidirectional subtoken matching against
// symbol names and path segments, and one small glossary of generic
// engineering vocabulary (abbreviations and concept clusters). None of it is
// question-specific: the same table serves "how are errors handled?" as
// "how does authentication work?".

// Longest-first so "authentication" strips "ication", not "ation".
const STEM_SUFFIXES = [
  "ication", "ization", "isation", "ation", "ition", "tion", "sion", "ion",
  "ities", "ility", "ing", "ies", "ied", "ed", "es", "s",
];

// Verbal derivations that form distinct-but-related words ("-ate", "-ize",
// "-ise"): "authenticate" ~ "authentication", "authorize" ~ "authorization".
// Used only in word-family checks, never for stemming.
const DERIVATIONAL_SUFFIXES = new Set(["ate", "ize", "ise"]);

const COMMON_INFLECTIONS = new Set([
  ...STEM_SUFFIXES,
  ...DERIVATIONAL_SUFFIXES,
  "d", "s", "r", "e", "ed", "es", "er", "ing", "ly", "al", "en", "or",
]);

// Glossary values are alternative names for the same concept, read
// symmetrically at lookup time. Kept deliberately small and generic —
// it is vocabulary the *concept space* provides, not repository knowledge.
const GLOSSARY: Record<string, string[]> = {
  auth: ["authentication", "authorization", "login", "register", "session", "token", "signup", "oauth", "permission", "password"],
  authentication: ["auth", "login", "register", "session", "token", "jwt", "oauth", "password"],
  authorization: ["auth", "permission", "role", "authorize"],
  authorize: ["authorization", "permission", "role"],
  login: ["auth", "signin", "session"],
  signin: ["login", "auth"],
  logout: ["login", "auth", "session"],
  logged: ["login", "session", "auth"],
  signup: ["auth", "register"],
  register: ["auth", "signup"],
  error: ["exception", "failure", "throw", "catch"],
  errors: ["error", "exception", "failure", "throw", "catch"],
  exception: ["error", "throw", "catch"],
  handling: ["handler", "catch", "middleware"],
  upload: ["multipart", "attachment", "formdata", "storage"],
  uploads: ["upload", "multipart"],
  database: ["db", "connection", "migration"],
  db: ["database"],
  model: ["schema", "entity", "table"],
  schema: ["model", "migration"],
  config: ["configuration", "environment", "env"],
  configuration: ["config", "env"],
  cors: ["origin", "policy"],
  client: ["frontend", "browser", "ui"],
  frontend: ["client", "ui"],
  backend: ["server", "api"],
  server: ["backend", "api"],
  token: ["jwt", "session"],
  jwt: ["token", "auth"],
  cookie: ["session", "token"],
  cookies: ["cookie", "session"],
  redis: ["cache", "store"],
  cache: ["redis", "store"],
  queue: ["job", "worker", "background"],
  webhooks: ["webhook", "event"],
  sdk: ["client", "package", "packages", "library"],
  dependencies: ["dependency", "manifest", "package"],
  dependency: ["dependencies", "manifest", "package"],
  package: ["packages", "manifest"],
  packages: ["package", "workspace"],
  manifest: ["manifests", "cargo", "pyproject", "dependencies"],
  manifests: ["manifest", "cargo", "pyproject", "dependencies"],
  requirements: ["requirement", "manifest"],
  requirement: ["requirements", "manifest"],
  workspace: ["workspaces", "pnpm", "packages", "monorepo"],
  workspaces: ["workspace", "pnpm", "packages", "monorepo"],
};

// Role seeding hints: a query word that names an architecture concept maps to
// the pipe's recorded role for it. Every role listed here is one the parser
// can actually produce (lib/roles.ts) or a persisted legacy value legacy
// stored analyses may still carry (see FRONTEND_ROLES). One entry per role:
// the same file must never be pushed twice for the same hint words. Words are
// kept conservative — only words that name the architecture concept itself,
// so unrelated files cannot be seeded by accident.
const ROLE_HINTS: { words: string[]; role: string }[] = [
  { words: ["model", "schema", "database", "db", "query"], role: "model" },
  { words: ["route", "router", "endpoint", "api"], role: "router" },
  { words: ["page", "route"], role: "page-route" },
  { words: ["endpoint", "api"], role: "api-endpoint" },
  { words: ["action"], role: "server-action" },
  { words: ["middleware"], role: "middleware" },
  { words: ["controller", "handler"], role: "controller" },
  { words: ["resolver"], role: "resolver" },
  { words: ["gateway"], role: "gateway" },
  { words: ["guard", "authorization"], role: "guard" },
  { words: ["interceptor"], role: "interceptor" },
  { words: ["service"], role: "service" },
  { words: ["module"], role: "module" },
  { words: ["entity"], role: "entity" },
  { words: ["dto"], role: "dto" },
  { words: ["repository"], role: "repository" },
  { words: ["component", "widget"], role: "component" },
  // The client-side state words ("store", "state") name the hook layer in the
  // taxonomy — the taxonomy has no "store" role.
  { words: ["hook", "state", "store"], role: "hook" },
  { words: ["layout"], role: "layout" },
  { words: ["config", "configuration", "env"], role: "config" },
];

// Roles whose carriers behave like frontend files for the CLI-execution decay:
// rule-based UI and presentation code, plus the persisted legacy value for
// analyses stored under an older taxonomy ("frontend" is no longer producible).
const FRONTEND_ROLES = new Set(["component", "hook", "layout", "route-ui", "frontend"]);

/**
 * Splits an identifier into case/separator subtokens:
 * "verifyJWT" -> ["verify","jwt"], "AuthService" -> ["auth","service"],
 * "error_handler" -> ["error","handler"].
 */
export function identifierSubtokens(name: string): string[] {
  const spaced = name
    .replace(/[^A-Za-z0-9]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  return spaced.split(/\s+/).filter((p) => p.length > 0);
}

const stemOf = (word: string): string | undefined => {
  for (const suffix of STEM_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      return word.slice(0, -suffix.length);
    }
  }
  return undefined;
};

export type TokenVariant = { text: string; kind: "original" | "stem" | "glossary" };

/**
 * Expands one query token into its concept variants: the token itself first
 * (exact matches score highest), then its stem, then glossary synonyms.
 * Each variant carries its kind so matches can be penalised by how far the
 * variant had to travel from the user's own wording.
 */
export function tokenVariants(token: string): TokenVariant[] {
  const out: TokenVariant[] = [{ text: token, kind: "original" }];
  const seen = new Set([token]);
  const stem = stemOf(token);
  if (stem !== undefined && !seen.has(stem)) {
    out.push({ text: stem, kind: "stem" });
    seen.add(stem);
  }
  for (const syn of GLOSSARY[token] ?? []) {
    if (!seen.has(syn)) {
      out.push({ text: syn, kind: "glossary" });
      seen.add(syn);
    }
  }
  return out;
}

export const KIND_PENALTY: Record<TokenVariant["kind"], number> = {
  original: 0,
  stem: 6,
  glossary: 14,
};

/**
 * Two words may match through a shared prefix only when the leftover of the
 * longer word looks like an inflection of the same word — a stem suffix or a
 * 1-2 character tail (plural, truncation). This keeps word-family matching
 * while killing cross-concept leaks that plain "starts with" allowed:
 *
 *   "authentication" ~ "authenticate"  (remainder "ation")   ✓ same word
 *   "authorized"     ~ "authorize"     (remainder "d")       ✓ same word
 *   "authorize"      ~ "auth"          (remainder "orize")   ✗ different word
 *   "configuration"  ~ "config"        (remainder "uration") ✗ abbreviation —
 *      matched by the explicit glossary pair instead, so short forms stay
 *      deliberate vocabulary.
 */
/**
 * Word-family check through the shared stem. Two words relate when the text
 * they share is long enough to be a real stem and the leftovers on both
 * sides are inflectional shapes (stem suffixes in either language style,
 * verbal derivations like -ate/-ize, or a 1-2 character tail such as a
 * plural). What plain "starts with" allowed but this rejects:
 *
 *   "authentication" ~ "authenticate"  ("ation" / "ate")   ✓ one word family
 *   "authorized"     ~ "authorize"     ("d" / "")          ✓ one word family
 *   "authorize"      ~ "auth"          ("orize" / "")      ✗ different word
 *   "author"         ~ "auth"          ("or" / "")         ✗ different word
 *   "configuration"  ~ "config"        ("uration" / "")    ✗ abbreviation —
 *      handled by the explicit glossary pair, so short forms stay
 *      deliberate vocabulary, never accidental substrings.
 */
export function sameFamily(a: string, b: string): boolean {
  if (a === b) return true;
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  if (shared < 4) return false;
  const ra = a.slice(shared);
  const rb = b.slice(shared);
  const tailFamily = (tail: string): boolean =>
    tail.length === 0 ||
    COMMON_INFLECTIONS.has(tail) ||
    (tail.length >= 3 && COMMON_INFLECTIONS.has(tail.slice(1)));
  // Both sides keep a tail: each tail must look inflectional on its own.
  if (ra.length > 0 && rb.length > 0) {
    return tailFamily(ra) && tailFamily(rb);
  }
  // One word ends where the other continues: the extension must be a true
  // inflection or derivation of the consumed word, never a loose 2-char
  // tail of an already-consumed stem ("auth" extended with "or"/"orize").
  const rest = ra.length > 0 ? ra : rb;
  return rest === "s" || rest === "d" || COMMON_INFLECTIONS.has(rest);
}

const ENTRY_POINT_PATTERNS = [
  /(?:^|\/)(?:index|main|app|entry|cli|root|server)\.(?:tsx?|jsx?|mjs|cjs)$/i,
  /(?:^|\/)(?:page|layout)\.(?:tsx?|jsx?)$/i,
  /(?:^|\/)(?:route|router)\.(?:tsx?|jsx?)$/i,
  /(?:^|\/)(?:config|setup)\.(?:tsx?|jsx?|mjs|cjs)$/i,
];

/**
 * Normalizes query string and extracts candidate identifier tokens, path fragments,
 * and keywords across camelCase, snake_case, and kebab-case.
 */
export function extractQueryTokens(rawQuery: string): string[] {
  const query = rawQuery.trim();
  if (!query) return [];

  const tokens = new Set<string>();

  // Extract explicit path-like or dot-like tokens (e.g. "auth/session.ts", "lib/ai", "route.ts")
  const pathMatches = query.match(/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+/g) ?? [];
  for (const m of pathMatches) {
    const cleanPath = m.replace(/[.,:;!?]+$/, "");
    if (cleanPath) tokens.add(cleanPath.toLowerCase());
  }

  // Split into whitespace and punctuation separated words
  const words = query
    .replace(/[^\w\s\-./]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  for (const word of words) {
    const cleanWord = word.replace(/[.\-]+$/, "");
    const lower = cleanWord.toLowerCase();
    if (lower.length >= 2 && !STOP_WORDS.has(lower)) {
      tokens.add(lower);
    }

    // Split camelCase and PascalCase identifiers (e.g. "createAdminSupabase" -> "create", "admin", "supabase")
    const camelParts = cleanWord.replace(/([a-z])([A-Z])/g, "$1 $2").split(/\s+/);
    if (camelParts.length > 1) {
      for (const part of camelParts) {
        const pLower = part.toLowerCase();
        if (pLower.length >= 2 && !STOP_WORDS.has(pLower)) {
          tokens.add(pLower);
        }
      }
    }

    // Split snake_case and kebab-case identifiers (e.g. "auth_middleware" -> "auth", "middleware")
    const splitParts = cleanWord.split(/[-_]/);
    if (splitParts.length > 1) {
      for (const part of splitParts) {
        const pLower = part.toLowerCase();
        if (pLower.length >= 2 && !STOP_WORDS.has(pLower)) {
          tokens.add(pLower);
        }
      }
    }
  }

  return [...tokens];
}

/**
 * Core deterministic retrieval engine:
 * 1. Discovers seeds across symbols, routes, and file paths.
 * 2. Ranks candidates by evidence match strength.
 * 3. Expands seeds through 1-hop dependency relationships.
 * 4. Merges overlapping windows.
 * 5. Retrieves bounded source code windows using the content read service.
 */
export async function retrieveGroundedContext(
  db: Db,
  analysisId: string,
  rawQuery: string,
  budget: RetrievalBudget = {},
  conceptIndex?: import("./concepts/index.ts").ConceptIndex | null,
  /**
   * Backfill dependencies for the window reads. An `absent` row's verified
   * content may still be served (and the row flipped to `stored`) through
   * this read; production uses the defaults (admin writer, commit-pinned
   * fetch, process cache). Tests inject a stub; every existing caller keeps
   * today's behavior untouched.
   */
  backfillDeps: BackfillDeps = {},
): Promise<RetrievalResult> {
  const config = { ...DEFAULT_BUDGET, ...budget };
  const tokens = extractQueryTokens(rawQuery);
  const plan = planQuestion(rawQuery, conceptIndex ?? undefined);
  // The planner separates generic action verbs ("implement", "handle", …)
  // from concepts; retrieval keeps them eligible but demoted (§ stages).
  const genericTokens = new Set(
    plan.unusedTokens
      .filter((u) => u.reason === "generic-verb")
      .map((u) => u.word),
  );

  if (tokens.length === 0) {
    return {
      analysisId,
      query: rawQuery,
      tokens: [],
      plan,
      windows: [],
      files: [],
      totalCharacters: 0,
      totalTokens: 0,
      renderedCharacters: 0,
      insufficientEvidence: true,
    };
  }

  // Stage 1: Load indexed files for this analysis
  const { data: filesData, error: filesError } = await db
    .from("files")
    .select("id, path, hash, lines, content_status, file_roles(role, source)")
    .eq("analysis_id", analysisId)
    .is("skip_reason", null);

  if (filesError) {
    throw new Error(`Failed to load files for analysis ${analysisId}: ${filesError.message}`);
  }

  const fileMap = new Map<
    string,
    {
      id: string;
      path: string;
      hash: string;
      lines: number;
      role: string | null;
    }
  >();

  for (const f of filesData ?? []) {
    // CI-4 security gate: only field-trusted content may become retrieval
    // evidence. Excluded and legacy-unclassified files never enter the
    // candidate map at construction, so no later stage — symbol/route/path
    // seeding, graph expansion or derived-reference resolution, which all
    // resolve neighbours strictly against this map — can reintroduce them.
    // `stored` and `absent` stay candidates: an absent file's window is only
    // served after the content read service authorizes its verified backfill.
    // For code files, `stored` and `absent` stay candidates (lazy backfill).
    // For non-code files, strictly allow only eligible primary manifests that
    // are already securely stored. Absent, excluded, legacy-unclassified, or
    // unrecognized non-code files are never retrieval candidates.
    if (f.content_status === "excluded" || f.content_status === "legacy_unclassified") {
      continue;
    }

    const isCode = isCodeFile(f.path);
    const filename = f.path.split("/").pop() ?? f.path;
    const isPrimaryManifest = PRIMARY_MANIFEST_NAMES.has(filename);

    if (!isCode) {
      if (!isPrimaryManifest || f.content_status !== "stored") {
        continue;
      }
    }
    if (f.hash && typeof f.lines === "number") {
      const roleRow = f.file_roles?.[0];
      fileMap.set(f.id, {
        id: f.id,
        path: f.path,
        hash: f.hash,
        lines: f.lines,
        role: roleRow?.role ?? null,
      });
    }
  }

  if (fileMap.size === 0) {
    return {
      analysisId,
      query: rawQuery,
      tokens,
      plan,
      windows: [],
      files: [],
      totalCharacters: 0,
      insufficientEvidence: true,
    };
  }

  // Stage 2: Discover candidate seeds from symbols, routes, and files
  const seedWindows: TargetWindow[] = [];

  const GENERIC_QUERY_WORDS = new Set([
    "controller", "controllers", "handler", "handlers", "service", "services",
    "middleware", "middlewares", "model", "models", "schema", "schemas",
    "route", "routes", "router", "routers", "endpoint", "endpoints",
    "component", "components", "store", "stores",
    "file", "files", "function", "functions", "method", "methods",
    "class", "classes", "module", "modules", "type", "types",
    "code", "config", "configuration",
    "call", "create", "handle", "implement", "learn", "need", "run", "tell",
    "understand", "want", "write", "locate", "located", "find", "get", "use",
  ]);

  const repoTokens = new Set<string>();
  try {
    const { data: analysisData } = await db
      .from("analyses")
      .select("projects(repo_name, repo_owner)")
      .eq("id", analysisId)
      .single();
    if (analysisData?.projects) {
      const p = analysisData.projects as { repo_name?: string; repo_owner?: string };
      if (p.repo_name) {
        for (const st of identifierSubtokens(p.repo_name)) repoTokens.add(st.toLowerCase());
      }
      if (p.repo_owner) {
        for (const st of identifierSubtokens(p.repo_owner)) repoTokens.add(st.toLowerCase());
      }
    }
  } catch {
    // Offline fixtures or stub dbs may not have projects relation
  }

  const domainTokens = new Set(
    tokens.filter(
      (t) => !GENERIC_QUERY_WORDS.has(t) && !STOP_WORDS.has(t) && !repoTokens.has(t) && t.length >= 3,
    ),
  );
  const matchedDomainTokens = new Set<string>();

  // A. Search symbols, matched against both the full identifier and its
  // subtokens ("AuthService" -> ["auth","service"]) for every concept
  // variant the query token expands to.
  // The core span (end_line) is served from the same row when the runtime
  // schema exposes it (production does); the typed fallback keeps older
  // generated typings and mock rows readable, mirroring the Phase-2 read.
  let symbolRows: Record<string, unknown>[] = [];
  {
    try {
      const full = await (db as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (k: string, v: string) => Promise<{ data: unknown; error: unknown }>;
          };
        };
      })
        .from("symbols")
        .select("file_id, name, kind, line, end_line, exported")
        .eq("analysis_id", analysisId);
      if (!full.error && Array.isArray(full.data)) symbolRows = full.data as Record<string, unknown>[];
    } catch {
      symbolRows = [];
    }
    if (symbolRows.length === 0) {
      const { data, error } = await db
        .from("symbols")
        .select("file_id, name, kind, line, exported")
        .eq("analysis_id", analysisId);
      if (!error && data) symbolRows = data as unknown as Record<string, unknown>[];
    }
  }

  if (symbolRows.length > 0) {
    for (const row of symbolRows) {
      const sym = {
        file_id: row.file_id as string,
        name: row.name as string,
        kind: row.kind as string,
        line: row.line as number,
        exported: row.exported as boolean,
        ...(typeof row.end_line === "number" ? { end_line: row.end_line } : {}),
      };
      const file = fileMap.get(sym.file_id);
      if (!file) continue;

      const nameLower = sym.name.toLowerCase();
      const subtokens = identifierSubtokens(sym.name);
      let bestConcept = 0;
      let bestGeneric = 0;
      let matchedToken = "";

      const matchedConceptTokens = new Set<string>();
      for (const token of tokens) {
        const generic = genericTokens.has(token) || repoTokens.has(token);
        for (const { text: variant, kind } of tokenVariants(token)) {
          const penalty = KIND_PENALTY[kind];
          let score = 0;
          if (nameLower === variant) {
            score = 100;
          } else if (subtokens.includes(variant)) {
            score = 95;
          } else {
            // Word-family prefixes only (see sameFamily): "authentication"
            // still matches "authenticate", but unrelated words that merely
            // share the beginning ("authorize"/"author" vs "auth") no longer
            // leak into the concept.
            const fullName = sameFamily(nameLower, variant);
            const sub = subtokens.some((st) => sameFamily(st, variant));
            if (fullName) score = 75;
            else if (sub) score = 55;
            else if (variant.length >= 5 && subtokens.some((st) => st.includes(variant))) score = 40;
          }
          if (score > 0 && !generic) {
            matchedConceptTokens.add(token);
          }
          const scored = score - penalty;
          // Concept evidence always outranks generic-verb evidence.
          if (generic) {
            if (scored > bestGeneric) {
              bestGeneric = scored;
              matchedToken = token;
            }
          } else if (scored > bestConcept) {
            bestConcept = scored;
            matchedToken = token;
          }
        }
      }
      // A window matched only through generic verbs ("implement", "handle"…)
      // is demoted so verb-named code cannot drown concept-named code.
      const genericOnly = bestConcept === 0 && bestGeneric > 0;
      let bestScore = genericOnly ? bestGeneric - GENERIC_PENALTY : bestConcept;
      if (bestScore > 0 && matchedConceptTokens.size >= 2) {
        bestScore += 12;
      }
      if (bestScore > 0 && plan.intent === "cli-execution") {
        const pLower = file.path.toLowerCase();
        const fn = pLower.split("/").pop() ?? pLower;
        const isExplicit = rawQuery.toLowerCase().includes(fn) || rawQuery.toLowerCase().includes(pLower);
        if (!isExplicit) {
          const isCli = pLower.includes("/cli/") || pLower.startsWith("cli/") || file.role === "cli" || pLower.includes("/bin/") || pLower.startsWith("bin/") || pLower.includes("/commands/") || pLower.includes("/cmd/");
          if (isCli) {
            bestScore += 20;
          } else if (pLower.includes("/components/") || pLower.includes("/ui/") || pLower.includes("/docs/") || pLower.includes("/examples/") || (file.role !== null && FRONTEND_ROLES.has(file.role))) {
            bestScore = 0;
          } else {
            bestScore = Math.min(bestScore, 40);
          }
        }
      }

      if (bestScore > 0) {
        if (domainTokens.has(matchedToken)) {
          matchedDomainTokens.add(matchedToken);
        }
        if (sym.exported) bestScore += 5;
        const isCliFile = plan.intent === "cli-execution" && (file.path.startsWith("cli/") || file.path.includes("/cli/") || file.role === "cli" || file.path.includes("/bin/"));
        const padBefore = isCliFile ? 5 : 15;
        const padAfter = isCliFile ? 20 : 25;
        const startLine = Math.max(1, sym.line - padBefore);
        const endLine = Math.min(file.lines, sym.line + padAfter);
        // The matched evidence core: the symbol's own span, clamped to the
        // file. Whole-span conservation is a serving invariant — a window
        // can compact toward the core but never split or omit it.
        const coreEnd =
          typeof sym.end_line === "number" && sym.end_line > sym.line
            ? Math.min(sym.end_line, file.lines)
            : Math.min(file.lines, sym.line);
        seedWindows.push({
          fileId: file.id,
          path: file.path,
          contentHash: file.hash,
          totalLines: file.lines,
          startLine,
          endLine,
          score: bestScore,
          strategies: ["symbol"],
          reason: `symbol "${sym.name}" (${sym.kind}) matches token "${matchedToken}"${genericOnly ? " (generic verb only, demoted)" : ""}`,
          coreStart: sym.line,
          coreEnd,
        });
      }
    }
  }

  // API-surface appendix per file path, prebuilt from the same symbol rows
  // Stage A already read. Every new serving phase below includes this block
  // cost in its budget check, so a full package never has to give up a whole
  // window just to make room for the appendix the prompt was always going to
  // attach to its line-1 windows.
  const apiBlockByPath = new Map<string, string>();
  {
    const symbolsByPathAll = new Map<string, NonNullable<RetrievalResult["symbols"]>>();
    for (const row of symbolRows) {
      const file = fileMap.get(row.file_id as string);
      if (!file) continue;
      const list = symbolsByPathAll.get(file.path) ?? [];
      list.push(mapSymbolCandidateRow(row, file.path));
      symbolsByPathAll.set(file.path, list);
    }
    for (const [path, syms] of symbolsByPathAll) {
      apiBlockByPath.set(path, formatApiSurfaceFor(syms));
    }
  }

  // B. Search routes
  const { data: routesData, error: routesError } = await db
    .from("routes")
    .select("file_id, method, path, line")
    .eq("analysis_id", analysisId);

  if (!routesError && routesData) {
    for (const route of routesData) {
      const file = fileMap.get(route.file_id);
      if (!file) continue;

      const routeLower = route.path.toLowerCase();
      const methodLower = route.method.toLowerCase();
      const segments = routeLower.split(/[^a-z0-9]+/).filter(Boolean);
      let bestConcept = 0;
      let bestGeneric = 0;
      let matchedToken = "";

      for (const token of tokens) {
        const generic = genericTokens.has(token) || repoTokens.has(token);
        for (const { text: variant, kind } of tokenVariants(token)) {
          const penalty = KIND_PENALTY[kind];
          let score = 0;
          if (segments.some((s) => s === variant)) {
            score = 100;
          } else if (variant.length >= 3 && routeLower.includes(variant)) {
            score = 65;
          } else if (methodLower === variant) {
            score = 50;
          } else continue;
          const scored = score - penalty;
          if (generic) {
            if (scored > bestGeneric) { bestGeneric = scored; matchedToken = token; }
          } else if (scored > bestConcept) {
            bestConcept = scored; matchedToken = token;
          }
        }
      }
      const genericOnly = bestConcept === 0 && bestGeneric > 0;
      const bestScore = genericOnly ? bestGeneric - GENERIC_PENALTY : bestConcept;

      if (bestScore > 0) {
        if (domainTokens.has(matchedToken)) {
          matchedDomainTokens.add(matchedToken);
        }
        const startLine = Math.max(1, route.line - 10);
        const endLine = Math.min(file.lines, route.line + 30);
        seedWindows.push({
          fileId: file.id,
          path: file.path,
          contentHash: file.hash,
          totalLines: file.lines,
          startLine,
          endLine,
          score: bestScore,
          strategies: ["route"],
          reason: `route "${route.method} ${route.path}" matches token "${matchedToken}"${genericOnly ? " (generic verb only, demoted)" : ""}`,
        });
      }
    }
  }

  // C. Search file paths: matched against the filename (strongest), then any
  // path segment, using the same concept variants and identifier subtokens,
  // so "authentication" finds src/middlewares/auth.middleware.js and
  // "database" finds src/database/connectDB.js without substring noise.
  const explicitNamedPaths = new Set(
    (rawQuery.match(/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+/g) ?? []).map((p) => p.toLowerCase()),
  );
  const hasExplicitFileMatch = [...fileMap.values()].some((f) => {
    const p = f.path.toLowerCase();
    const fn = p.split("/").pop() ?? p;
    return explicitNamedPaths.has(p) || explicitNamedPaths.has(fn);
  });

  for (const file of fileMap.values()) {
    const pathLower = file.path.toLowerCase();
    const filename = pathLower.split("/").pop() ?? pathLower;
    const nameParts = [
      ...identifierSubtokens(filename),
      ...pathLower.split("/").flatMap((seg) => identifierSubtokens(seg)),
    ];
    const filenameParts = new Set([filename, ...identifierSubtokens(filename)]);
    const matchedVariants = new Set<string>();
    let bestConcept = 0;
    let bestGeneric = 0;
    let matchedToken = "";
    let matchedKind: TokenVariant["kind"] = "original";
    let genericOnly = false;

    for (const token of tokens) {
      const generic = genericTokens.has(token);
      for (const { text: variant, kind } of tokenVariants(token)) {
        const penalty = KIND_PENALTY[kind];
        let score = 0;
        if (filename === variant || pathLower === variant) {
          score = 85;
        } else if (filenameParts.has(variant)) {
          score = 80;
        } else if (variant.length >= 3 && nameParts.includes(variant)) {
          score = 70;
        } else if (variant.length >= 5 && pathLower.includes(variant)) {
          score = 45;
        }
        const scored = score - penalty;
        if (scored > (generic ? bestGeneric : bestConcept)) {
          if (generic) bestGeneric = scored;
          else {
            bestConcept = scored;
            genericOnly = false;
          }
          matchedToken = token;
          matchedKind = kind;
        }
        if (score > 0) matchedVariants.add(variant);
      }
      genericOnly = bestConcept === 0 && bestGeneric > 0;
    }
    let bestScore = genericOnly ? bestGeneric - GENERIC_PENALTY : bestConcept;
    // Corroboration: two distinct concept variants in one path (e.g. an SDK
    // client package matching both "packages" and "client") confirm the same
    // idea from different segments — a single segment hit alone does not.
    // Ranks the public client surface into the same band as weaker exact
    // matches rather than below every loosely-related support file.
    if (bestScore > 0 && matchedVariants.size >= 2) bestScore += 14;

    const isExplicitlyNamed = explicitNamedPaths.has(pathLower) || explicitNamedPaths.has(filename);
    if (isExplicitlyNamed) {
      bestScore = 120;
      matchedToken = filename;
    } else if (plan.intent === "cli-execution" && bestScore > 0) {
      const isCli = pathLower.includes("/cli/") || pathLower.startsWith("cli/") || file.role === "cli" || pathLower.includes("/bin/") || pathLower.startsWith("bin/") || pathLower.includes("/commands/") || pathLower.includes("/cmd/");
      if (isCli) {
        bestScore += 25;
      } else if (pathLower.includes("/components/") || pathLower.includes("/ui/") || pathLower.includes("/docs/") || pathLower.includes("/examples/") || (file.role !== null && FRONTEND_ROLES.has(file.role))) {
        bestScore = 0;
      } else {
        bestScore = Math.min(bestScore, 40);
      }
    }
    if (hasExplicitFileMatch && !isExplicitlyNamed && matchedKind === "glossary") {
      bestScore = 0;
    }

    if (bestScore > 0) {
      if (isExplicitlyNamed) {
        for (const dt of domainTokens) matchedDomainTokens.add(dt);
      } else if (domainTokens.has(matchedToken)) {
        matchedDomainTokens.add(matchedToken);
      }
      if (file.role) bestScore += 10;
      const existingSymbol = plan.intent === "cli-execution" && seedWindows.find((s) => s.fileId === file.id && s.strategies?.includes("symbol"));
      if (existingSymbol && !isExplicitlyNamed) {
        if (!existingSymbol.strategies?.includes("path")) {
          existingSymbol.strategies = [...(existingSymbol.strategies ?? []), "path"];
        }
        existingSymbol.score = Math.max(existingSymbol.score, bestScore);
        existingSymbol.reason += `; file path matches token "${matchedToken}"`;
      } else {
        const endLine = Math.min(file.lines, 50);
        seedWindows.push({
          fileId: file.id,
          path: file.path,
          contentHash: file.hash,
          totalLines: file.lines,
          startLine: 1,
          endLine,
          score: bestScore,
          strategies: isExplicitlyNamed ? ["explicit-path", "path"] : ["path"],
          reason: isExplicitlyNamed
            ? `file explicitly named in query ("${filename}")`
            : `file path matches token "${matchedToken}"${genericOnly ? " (generic verb only, demoted)" : ""}`,
        });
      }
    }
  }

  // C2. Role-aware seeding: the pipe already labels files by architectural
  // role (model, router, middleware, controller, service, ...); a question
  // that names an architecture concept should find those files even when no
  // path or symbol name echoes the wording. Ranks below name matches so it
  // only carries files into the budget that belong to the named concept.
  const broadQuery = isOnboardingQuery(rawQuery);
  const hasDirectSeeds = seedWindows.some((s) => !s.strategies?.includes("role"));
  if (broadQuery || hasDirectSeeds || budget.isIterativePass) {
  for (const hint of ROLE_HINTS) {
    const tokensForRole = tokens.filter(
      (token) => tokenVariants(token).some((v) => hint.words.includes(v.text)),
    );
    if (tokensForRole.length === 0) continue;

    for (const file of fileMap.values()) {
      if (file.role !== hint.role) continue;
      const endLine = Math.min(file.lines, 50);
      seedWindows.push({
        fileId: file.id,
        path: file.path,
        contentHash: file.hash,
        totalLines: file.lines,
        startLine: 1,
        endLine,
        score: 55,
        strategies: ["role"],
        reason: `file holds the "${hint.role}" role, which the question's topic names`,
      });
    }
  }

  // D. For broad repository or onboarding queries, prioritize foundational
  // entry points and hubs. These are *generic* seeds — they never displace
  // real concept matches. A specific question that matches no concept
  // vocabulary instead short-circuits to insufficient evidence rather than
  // being papered over with bootstrap files.
  }
  if (broadQuery) {
    type FileRecord = { id: string; path: string; hash: string; lines: number; role: string | null };
    const scoredFiles: { file: FileRecord; score: number; reason: string; strategy: string }[] = [];
    for (const file of fileMap.values()) {
      let score = 0;
      let reason = "";
      let strategy = "entry";

      const isEntry = ENTRY_POINT_PATTERNS.some((p) => p.test(file.path));
      if (isEntry) {
        score = 30;
        strategy = "entry";
        reason = "primary application entry point / core module";
      // Modern taxonomy roles name the repository's routable surfaces; they
      // seed like entry points for broad queries. "route"/"entry" stay for
      // analyses stored under an older taxonomy.
      } else if (
        file.role === "router" || file.role === "page-route" || file.role === "api-endpoint" ||
        file.role === "route" || file.role === "entry"
      ) {
        score = 28;
        strategy = "entry";
        reason = `core role "${file.role}"`;
      } else if (file.path.split("/").length <= 2) {
        score = 24;
        strategy = "entry";
        reason = "shallow repository structure file";
      }

      if (score > 0) {
        scoredFiles.push({ file, score, reason, strategy });
      }
    }

    scoredFiles.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));

    const maxEntrySeeds = broadQuery ? 4 : 2;
    for (const item of scoredFiles.slice(0, maxEntrySeeds)) {
      const endLine = Math.min(item.file.lines, 40);
      seedWindows.push({
        fileId: item.file.id,
        path: item.file.path,
        contentHash: item.file.hash,
        totalLines: item.file.lines,
        startLine: 1,
        endLine,
        score: item.score,
        strategies: [item.strategy],
        reason: item.reason,
      });
    }
  }

  // For specific (non-broad) queries: verify that the matched seeds actually
  // ground the question's specific domain concepts, rather than matching
  // only generic architecture vocabulary (e.g. "controller", "handler", "service")
  // or generic verbs when the core subject is absent from the repository.
  if (!broadQuery && !budget.isIterativePass && domainTokens.size > 0) {
    if (matchedDomainTokens.size === 0) {
      seedWindows.length = 0;
    }
  }

  // If no seeds found at all, return insufficient evidence early
  if (seedWindows.length === 0) {
    return {
      analysisId,
      query: rawQuery,
      tokens,
      plan,
      windows: [],
      files: [],
      totalCharacters: 0,
      insufficientEvidence: true,
    };
  }

  // Sort seed windows by score descending, then path ascending
  seedWindows.sort((a, b) => effectiveScore(b) - effectiveScore(a) || a.path.localeCompare(b.path));

  // Stage 3: Dependency Graph Expansion (indexed relationships only)
  // Expand the top seed files to their 1-hop neighbours over the analysis's
  // existing import/re-export/dynamic-import/require edges, plus a bounded
  // transitive second hop. Every expansion window is labelled provenance
  // "indexed" — backed by an edge row in this analysis's edges table (the
  // queries filter by analysis_id, so other organizations' graphs are
  // unreachable) — and never claims a relationship kind the schema does
  // not store.
  const topSeedFiles = [
    ...new Set(seedWindows.slice(0, config.seedLimit).map((s) => s.fileId)),
  ];

  const loadEdgeRows = async (focus: string[]) => {
    if (focus.length === 0) return [];
    const { data, error } = await db
      .from("edges")
      .select("source_file_id, target_file_id, kind")
      .eq("analysis_id", analysisId)
      .or(
        `source_file_id.in.(${focus.join(",")}),target_file_id.in.(${focus.join(",")})`,
      );
    if (error) return [];
    return data ?? [];
  };

  const expandedWindows: TargetWindow[] = [];
  const seenIds = new Set(topSeedFiles);
  if (process.env.RETRIEVAL_DEBUG) {
    console.error(`roots: ${topSeedFiles.map((id) => fileMap.get(id)?.path).join("; ")}`);
  }
  if (topSeedFiles.length > 0) {
    const topSeedSet = new Set(topSeedFiles);
    const hop1Files: string[] = [];

    for (const edge of await loadEdgeRows(topSeedFiles)) {
      const isOutgoing = topSeedSet.has(edge.source_file_id);
      const seedId = isOutgoing ? edge.source_file_id : edge.target_file_id;
      const neighbourId = isOutgoing ? edge.target_file_id : edge.source_file_id;

      // Self-loops, duplicate edge rows and fan-in deduplicate here; edges
      // naming a file of another analysis (or a deleted file) resolve to no
      // local record and are skipped — a missing target can never crash or
      // leak into the window list.
      if (neighbourId === seedId || topSeedSet.has(neighbourId) || seenIds.has(neighbourId)) {
        continue;
      }
      const neighbour = fileMap.get(neighbourId);
      const seedFile = fileMap.get(seedId);
      if (!neighbour || !seedFile) continue;
      seenIds.add(neighbourId);
      hop1Files.push(neighbourId);

      expandedWindows.push({
        fileId: neighbour.id,
        path: neighbour.path,
        contentHash: neighbour.hash,
        totalLines: neighbour.lines,
        startLine: 1,
        endLine: Math.min(neighbour.lines, 45),
        score:
          (edge.kind === "call" ? (isOutgoing ? 42 : 37) : isOutgoing ? 35 : 30) +
          (plan.intent === "cli-execution" && (neighbour.path.startsWith("cli/") || neighbour.path.includes("/cli/") || neighbour.role === "cli" || neighbour.path.includes("/bin/")) ? 80 : 0),
        strategies: ["expansion"],
        provenance: "indexed",
        reason: `1-hop dependency connected to seed "${seedFile.path}" (indexed ${edge.kind} edge)`,
        coreStart: 1,
        coreEnd: Math.min(neighbour.lines, 20),
      });
    }

    // Bounded transitive expansion: exactly one extra hop out of the
    // reached neighbourhood, hard-capped at MAX_TRANSITIVE_WINDOWS windows.
    // Within the cap the planner's expected evidence categories come first
    // (a question that expects "controllers"/"routes"/... evidence prefers
    // relationship targets that live in such paths), then plain path order
    // keeps the choice deterministic. Score 18 keeps every transitive
    // window below all direct and 1-hop evidence; deeper hops are never
    // followed.
    if (hop1Files.length > 0 && plan.intent !== "locate-implementation") {
      const focus = [...topSeedFiles, ...hop1Files].slice(0, 60);
      const hop2IdSeen = new Set(seenIds);
      const hop2Candidates: {
        neighbour: { id: string; path: string; hash: string; lines: number };
        seedFile: { path: string };
        kind: string;
        relevant: boolean;
      }[] = [];
      for (const edge of await loadEdgeRows(focus)) {
        const left = fileMap.get(edge.source_file_id);
        const right = fileMap.get(edge.target_file_id);
        if (!left || !right) continue;
        const seedIsLeft = topSeedSet.has(edge.source_file_id) || hop1Files.includes(edge.source_file_id);
        const seedId = seedIsLeft ? edge.source_file_id : edge.target_file_id;
        const neighbour = seedIsLeft ? right : left;
        const seedFile = seedIsLeft ? left : right;
        if (seedId === neighbour.id || hop2IdSeen.has(neighbour.id)) continue;
        const lower = neighbour.path.toLowerCase();
        hop2Candidates.push({
          neighbour,
          seedFile,
          kind: edge.kind,
          relevant: plan.expectedEvidence.some((c) => lower.includes(c.toLowerCase())),
        });
        hop2IdSeen.add(neighbour.id);
      }
      hop2Candidates.sort(
        (a, b) =>
          Number(b.relevant) - Number(a.relevant) ||
          a.neighbour.path.localeCompare(b.neighbour.path),
      );
      for (const { neighbour, seedFile, kind, relevant } of hop2Candidates.slice(
        0,
        MAX_TRANSITIVE_WINDOWS,
      )) {
        seenIds.add(neighbour.id);
        expandedWindows.push({
          fileId: neighbour.id,
          path: neighbour.path,
          contentHash: neighbour.hash,
          totalLines: neighbour.lines,
          startLine: 1,
          endLine: Math.min(neighbour.lines, 45),
          score: kind === "call" ? 22 : 18,
          strategies: ["expansion"],
          provenance: "indexed",
          reason: `2-hop dependency connected to seed "${seedFile.path}" (indexed ${kind} edge, transitive${relevant ? ", expected-evidence priority" : ""})`,
        });
      }
    }
  }

  // Stage 3.5: relationship hints derived from inspected windows.
  // Sources are the top seed windows whose text the pipeline reads through
  // the hash- and size-verified content read service; each contributes at
  // most its own import-family statements. Candidates resolve strictly
  // against this analysis's own file table — specifiers naming files the
  // analysis does not index (packages, missing files, other organizations)
  // produce nothing. Every derived window carries provenance "derived",
  // is worded as a hint ("derived, not an indexed edge"), and is ranked at
  // score 20, below all indexed evidence; presenting a derived
  // relationship as an indexed fact is impossible by construction.
  const derivedWindows: TargetWindow[] = [];
  {
    const inspectedIds = new Set<string>();
    const pathToFile = new Map([...fileMap.values()].map((f) => [f.path, f.id]));
    const derivedSeen = new Set<string>();
    let derivedUsed = 0;
    const inspected = [...seedWindows].sort(
      (a, b) => b.score - a.score || a.path.localeCompare(b.path),
    );
    for (const seed of inspected) {
      if (derivedUsed >= MAX_DERIVED_WINDOWS || inspectedIds.size >= config.seedLimit) break;
      if (inspectedIds.has(seed.fileId)) continue;
      inspectedIds.add(seed.fileId);
      let source: string | null = null;
      try {
        source = await getFileLines(db, seed.fileId, seed.startLine, seed.endLine, backfillDeps);
      } catch {
        source = null;
      }
      if (!source) continue;
      for (const ref of deriveReferences(source)) {
        if (derivedUsed >= MAX_DERIVED_WINDOWS) break;
        const targetId = specifierCandidates(ref.specifier, seed.path)
          .map((p) => pathToFile.get(p) ?? "")
          .find((id) => id && id !== seed.fileId && !derivedSeen.has(id));
        const target = targetId ? fileMap.get(targetId) : undefined;
        if (!target) continue;
        derivedSeen.add(target.id);
        derivedUsed += 1;
        derivedWindows.push({
          fileId: target.id,
          path: target.path,
          contentHash: target.hash,
          totalLines: target.lines,
          startLine: 1,
          endLine: Math.min(target.lines, 45),
          score: 20,
          strategies: ["derive"],
          provenance: "derived",
          reason: `derived ${ref.kind} reference to "${target.path}" in inspected window of "${seed.path}" (derived, not an indexed edge)`,
        });
      }
    }
  }

  // Stage 4: Deduplicate and merge overlapping line ranges per file
  const allWindows = [...seedWindows, ...expandedWindows, ...derivedWindows];
  const mergedWindows = mergeCandidateWindows(allWindows);

  // Sort merged windows by effective score descending (support files demoted)
  mergedWindows.sort((a, b) => effectiveScore(b) - effectiveScore(a) || a.path.localeCompare(b.path));

  // Stage 5: Retrieve actual source text and enforce budget.
  // Breadth first: every file gets its best window served before any file
  // claims a second one, so one dense file cannot eat the character budget —
  // a spread of related files grounds answers better than one deep file.
  const order = [...mergedWindows].sort(
    (a, b) => effectiveScore(b) - effectiveScore(a) || a.path.localeCompare(b.path),
  );
  const rounds: TargetWindow[][] = [];
  const grouped = new Map<string, { windows: TargetWindow[]; best: TargetWindow }>();
  for (const win of order) {
    const entry = grouped.get(win.fileId);
    if (!entry) {
      grouped.set(win.fileId, { windows: [win], best: win });
      rounds.push([win]);
    } else {
      entry.windows.push(win);
    }
  }
  // Round 1: one window per file in best-score order.
  const allBest = rounds
    .map((group) => group[0]!)
    .sort((a, b) => effectiveScore(b) - effectiveScore(a) || a.path.localeCompare(b.path));
  // Remaining rounds: extra windows per file, interleaved by score so the
  // strongest leftovers land before weaker extras.
  const extras: TargetWindow[] = [];
  {
    const leftovers = order.filter((w) => w !== (grouped.get(w.fileId)?.best ?? w));
    const perFile = new Map<string, TargetWindow[]>();
    for (const w of leftovers) {
      const list = perFile.get(w.fileId) ?? [];
      list.push(w);
      perFile.set(w.fileId, list);
    }
    const queues = [...perFile.values()].map((ws) =>
      ws.sort((a, b) => effectiveScore(b) - effectiveScore(a) || a.startLine - b.startLine),
    );
    let rest = true;
    while (rest) {
      rest = false;
      for (const q of queues) {
        const next = q.shift();
        if (next !== undefined) {
          extras.push(next);
          rest = true;
        }
      }
    }
  }

  // Per-directory breadth rule, applied greedily in score order: the highest
  // remaining candidate wins the next slot unless its directory already holds
  // its round-1 share. A heavily-matched directory cannot claim the budget
  // before other matched directories get in (a cross-file question wants
  // spread over the whole feature — the server side AND the client package
  // side), while a question concentrated in one directory fills every slot
  // with the same files the plain score order would pick. Skipped candidates
  // resume score order right after.
  const orderedForBudget: TargetWindow[] = [];
  const dirCounts = new Map<string, number>();
  const available = [...allBest];
  while (available.length > 0) {
    let picked = -1;
    for (let i = 0; i < available.length; i++) {
      const slash = available[i].path.lastIndexOf("/");
      const dir = slash === -1 ? "" : available[i].path.slice(0, slash);
      const isExplicit = available[i].strategies?.includes("explicit-path");
      const isCliDir = plan.intent === "cli-execution" && (dir === "cli" || dir.endsWith("/cli") || dir.includes("/cli/") || dir.includes("/bin"));
      const maxDir = isCliDir ? 4 : config.maxFilesPerDirectory;
      if (isExplicit || (dirCounts.get(dir) ?? 0) < maxDir) {
        picked = i;
        break;
      }
    }
    if (picked === -1) break;
    const [win] = available.splice(picked, 1);
    const slash = win.path.lastIndexOf("/");
    const dir = slash === -1 ? "" : win.path.slice(0, slash);
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    orderedForBudget.push(win);
  }
  orderedForBudget.push(...available, ...extras);
  if (process.env.RETRIEVAL_DEBUG) {
    for (const [i, win] of orderedForBudget.slice(0, Number(process.env.RETRIEVAL_DEBUG) || 30).entries()) {
      console.error(`budget[${i}] ${win.score} ${win.provenance ?? "-"} ${win.path} ${win.startLine}-${win.endLine} :: ${win.reason.slice(0, 160)}`);
    }
  }

  // Packaging facts ride alongside the code windows. Loaded upfront so the evidence
  // budget accounts for packaging text before candidate window selection.
  const packagingEvidence = await loadPackagingEvidence(db, analysisId, rawQuery);
  let packagingText = formatPackagingEvidence(packagingEvidence);

  const hasExplicitCodeTarget = /[a-zA-Z0-9_\-./]+\.(?:tsx?|jsx?|mjs|cjs|py|rs|go)\b/i.test(rawQuery) || hasExplicitFileMatch;
  const profile = budget.profile ?? (budget.model ? resolveModelProfile(budget.model, resolveBaseUrl()) : undefined);
  if (profile) {
    const promptOverhead = QUESTION_SYSTEM.length + rawQuery.length + 1500;
    const totalEvidenceBudget = Math.max(0, profile.maxInputCharacters - promptOverhead);
    const minCodeReserved = hasExplicitCodeTarget
      ? Math.min(3600, Math.floor(totalEvidenceBudget * 0.75))
      : Math.min(3200, Math.floor(totalEvidenceBudget * 0.65));
    const maxPkgAllowance = Math.max(0, totalEvidenceBudget - minCodeReserved);
    if (packagingText.length > maxPkgAllowance) {
      if (maxPkgAllowance >= 400) {
        const slice = packagingText.slice(0, maxPkgAllowance);
        const lastNewline = slice.lastIndexOf("\n");
        packagingText = lastNewline > 0 ? slice.slice(0, lastNewline) : "";
      } else {
        packagingText = "";
      }
    }
  }

  const limits = computeEvidenceLimits(budget, rawQuery, packagingText);

  // Explicit handling of zero or insufficient remaining evidence budget:
  if (limits.maxCharacters <= 0 || limits.maxTokens <= 0) {
    return {
      analysisId,
      query: rawQuery,
      tokens,
      plan,
      windows: [],
      files: [],
      symbols: [],
      totalCharacters: 0,
      totalTokens: 0,
      renderedCharacters: 0,
      insufficientEvidence: true,
    };
  }

  // Packaging only enters the package if it fits cleanly within the available evidence budget.
  const pkgChars = packagingText.length;
  const pkgTokens = estimateCodeTokens(packagingText);
  const includePackaging = packagingText !== "" && (profile ? limits.reservedCharacters <= profile.maxInputCharacters : true);
  const effectivePackagingText = includePackaging ? packagingText : "";

  const retrievedWindows: RetrievedWindow[] = [];
  const includedFilesMap = new Map<
    string,
    { fileId: string; path: string; contentHash: string; totalLines: number; windows: { startLine: number; endLine: number }[] }
  >();
  const fileWindowCounts = new Map<string, number>();
  // Exact per-window serving costs (character header included). Every phase
  // below adds and removes windows through these figures, so character,
  // token and raw-code accounting can never drift between phases.
  const servedCosts = new Map<string, { chars: number; tokens: number }>();
  const servedExplicit = new Set<string>();
  // Per-served-window serving context: the candidate's original bounds and
  // its full already-fetched text. Compacted kernels grow back inside those
  // bounds only, so pad expansion never needs another source read.
  const servedContext = new Map<string, { candidate: TargetWindow; candidateText: string }>();
  const windowKey = (w: { fileId: string; startLine: number; endLine: number }): string =>
    `${w.fileId}|${w.startLine}|${w.endLine}`;
  const headerCostOf = (path: string, contentHash: string, startLine: number, endLine: number): number =>
    `--- File: ${path} (lines ${startLine}-${endLine}) [hash: ${contentHash.slice(0, 8)}] ---\n`.length + 2;
  const windowCostOf = (
    path: string,
    contentHash: string,
    startLine: number,
    endLine: number,
    text: string,
  ): { chars: number; tokens: number } => ({
    chars: text.length + headerCostOf(path, contentHash, startLine, endLine),
    tokens: estimateCodeTokens(text) + estimateProseTokens(path) + 15,
  });
  // Appendix overhead the final prompt attaches to any window containing
  // line 1. Ledger costs count window text and header only; fit checks
  // charge this overhead on top, so the total the prompt sees is exactly
  // what every serving phase respects.
  const apiBlockCostOf = (path: string, startLine: number): { chars: number; tokens: number } => {
    if (startLine !== 1) return { chars: 0, tokens: 0 };
    const block = apiBlockByPath.get(path) ?? "";
    return block ? { chars: block.length, tokens: estimateCodeTokens(block) } : { chars: 0, tokens: 0 };
  };
  let currentCharacters = 0;
  let currentTokens = 0;
  let rawCodeCharacters = 0;

  const serveWindow = (
    candidate: TargetWindow,
    startLine: number,
    endLine: number,
    text: string,
    candidateText: string,
  ): void => {
    const cost = windowCostOf(candidate.path, candidate.contentHash, startLine, endLine, text);
    const key = windowKey({ fileId: candidate.fileId, startLine, endLine });
    servedCosts.set(key, cost);
    if (candidate.strategies?.includes("explicit-path")) servedExplicit.add(key);
    servedContext.set(key, { candidate, candidateText });
    currentCharacters += cost.chars;
    currentTokens += cost.tokens;
    rawCodeCharacters += text.length;
    fileWindowCounts.set(candidate.fileId, (fileWindowCounts.get(candidate.fileId) ?? 0) + 1);
    const existingFile = includedFilesMap.get(candidate.fileId);
    if (existingFile) {
      existingFile.windows.push({ startLine, endLine });
    } else {
      includedFilesMap.set(candidate.fileId, {
        fileId: candidate.fileId,
        path: candidate.path,
        contentHash: candidate.contentHash,
        totalLines: candidate.totalLines,
        windows: [{ startLine, endLine }],
      });
    }
    retrievedWindows.push({
      fileId: candidate.fileId,
      path: candidate.path,
      contentHash: candidate.contentHash,
      totalLines: candidate.totalLines,
      startLine,
      endLine,
      score: candidate.score,
      text,
      reason: candidate.reason,
      provenance: candidate.provenance,
    });
  };

  // Phase B — bounded core compaction (single window, no budget change):
  // the whole padded candidate does not fit, so serve the matched evidence
  // core instead. The core — the matched symbol's whole line span — is
  // served without splitting or omission, and the recorded bounds stay
  // inside the already-fetched slice, so citation ranges and slice content
  // always agree. Core-less candidates keep today's atomic rejection and
  // become a rescue candidate instead.
  const coreWindowWithin = (
    candidate: TargetWindow,
    candidateText: string,
  ): { startLine: number; endLine: number; text: string } | null => {
    if (
      candidate.coreStart === undefined ||
      candidate.coreEnd === undefined ||
      candidate.coreStart < candidate.startLine ||
      candidate.coreEnd > candidate.endLine ||
      candidate.coreStart > candidate.coreEnd
    ) {
      return null;
    }
    const lines = candidateText.split("\n");
    return {
      startLine: candidate.coreStart,
      endLine: candidate.coreEnd,
      text: lines.slice(candidate.coreStart - candidate.startLine, candidate.coreEnd - candidate.startLine + 1).join("\n"),
    };
  };

  // The single most valuable candidate that could not fit at all (compact
  // kernel included). First-in-order candidate wins score ties, keeping the
  // walk fully deterministic.
  const missState: { best: { candidate: TargetWindow; text: string } | null } = { best: null };
  const noteMiss = (candidate: TargetWindow, text: string): void => {
    if (
      missState.best === null ||
      effectiveScore({ score: candidate.score, path: candidate.path }) >
        effectiveScore({ score: missState.best.candidate.score, path: missState.best.candidate.path })
    ) {
      missState.best = { candidate, text };
    }
  };

  // Round 1 — same walk as before: full windows in serve priority order.
  for (const win of orderedForBudget) {
    if (currentCharacters >= limits.maxCharacters || currentTokens >= limits.maxTokens) break;

    const isNewFile = !includedFilesMap.has(win.fileId);
    if (isNewFile && includedFilesMap.size >= limits.maxFiles) {
      continue;
    }

    const currentWindowsForFile = fileWindowCounts.get(win.fileId) ?? 0;
    if (currentWindowsForFile >= limits.maxWindowsPerFile) {
      continue;
    }

    try {
      const text = await getFileLines(db, win.fileId, win.startLine, win.endLine, backfillDeps);
      if (text === null) continue;

      const candidateCost = windowCostOf(win.path, win.contentHash, win.startLine, win.endLine, text);
      if (
        currentCharacters + candidateCost.chars <= limits.maxCharacters &&
        currentTokens + candidateCost.tokens <= limits.maxTokens
      ) {
        serveWindow(win, win.startLine, win.endLine, text, text);
        continue;
      }

      const remainingChars = limits.maxCharacters - currentCharacters;
      const remainingTokens = limits.maxTokens - currentTokens;
      const core = coreWindowWithin(win, text);
      if (core) {
        const coreCost = windowCostOf(win.path, win.contentHash, core.startLine, core.endLine, core.text);
        const blockOverhead = apiBlockCostOf(win.path, core.startLine);
        if (
          coreCost.chars + blockOverhead.chars <= remainingChars &&
          coreCost.tokens + blockOverhead.tokens <= remainingTokens
        ) {
          serveWindow(win, core.startLine, core.endLine, core.text, text);
          continue;
        }
      }
      noteMiss(win, text);
    } catch {
      // Content unavailable or unreadable, continue to next candidate
      continue;
    }
  }

  // Phase C — pad expansion: leftover budget flows back into the served
  // windows round-robin (serve order), one line at a time, always inside the
  // candidate's original bounds. A window grows only while each added line
  // still fits the remaining budget, so the leftover is shared by all served
  // files instead of one large file claiming it. Stops when a full round
  // grows nothing.
  const expandServedPads = (): void => {
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < retrievedWindows.length; i++) {
        if (currentCharacters >= limits.maxCharacters || currentTokens >= limits.maxTokens) return;
        const served = retrievedWindows[i]!;
        const key = windowKey(served);
        const contextEntry = servedContext.get(key);
        if (!contextEntry) continue;
        const candidate = contextEntry.candidate;
        if (served.startLine <= candidate.startLine && served.endLine >= candidate.endLine) continue;
        for (const side of ["before", "after"] as const) {
          if (side === "before" ? served.startLine <= candidate.startLine : served.endLine >= candidate.endLine) {
            continue;
          }
          const nextStart = side === "before" ? served.startLine - 1 : served.startLine;
          const nextEnd = side === "after" ? served.endLine + 1 : served.endLine;
          const candidateLines = contextEntry.candidateText.split("\n");
          const nextText = candidateLines
            .slice(nextStart - candidate.startLine, nextEnd - candidate.startLine + 1)
            .join("\n");
          const nextCost = windowCostOf(served.path, served.contentHash, nextStart, nextEnd, nextText);
          const prevCost = servedCosts.get(key)!;
          const deltaChars = nextCost.chars - prevCost.chars;
          const deltaTokens = nextCost.tokens - prevCost.tokens;
          // The window's appendix (if grown bounds cover line 1) counts on
          // top of the window cost, mirroring the final prompt total.
          let blockChars = 0;
          let blockTokens = 0;
          for (const w of retrievedWindows) {
            const block = apiBlockCostOf(w.path, w === served ? nextStart : w.startLine);
            blockChars += block.chars;
            blockTokens += block.tokens;
          }
          if (
            currentCharacters + deltaChars + blockChars > limits.maxCharacters ||
            currentTokens + deltaTokens + blockTokens > limits.maxTokens
          ) {
            continue;
          }
          // Apply the one-line growth atomically across the ledgers.
          const nextKey = windowKey({ fileId: served.fileId, startLine: nextStart, endLine: nextEnd });
          servedCosts.delete(key);
          servedCosts.set(nextKey, nextCost);
          if (servedExplicit.has(key)) {
            servedExplicit.delete(key);
            servedExplicit.add(nextKey);
          }
          servedContext.delete(key);
          servedContext.set(nextKey, contextEntry);
          currentCharacters += deltaChars;
          currentTokens += deltaTokens;
          rawCodeCharacters += nextText.length - served.text.length;
          const record = includedFilesMap.get(served.fileId)!;
          record.windows = record.windows.map((w) =>
            w.startLine === served.startLine && w.endLine === served.endLine
              ? { startLine: nextStart, endLine: nextEnd }
              : w,
          );
          served.startLine = nextStart;
          served.endLine = nextEnd;
          served.text = nextText;
          grew = true;
          break;
        }
      }
    }
  };
  expandServedPads();

  // Phase D — bounded displacement rescue, simulated transactionally before
  // any mutation: serve the single most valuable starved candidate by
  // dropping a minimal set of strictly weaker served windows (or, within
  // SERVING_DISPLACEMENT_MARGIN, windows whose corroboration-inflated score
  // the ranking layer itself treats as a tie). Cross-file coverage is
  // preserved by construction: a file's last window is dropped only when the
  // rescued candidate introduces a new file (net file count preserved, at
  // most one such swap), and explicit-path windows are never displaced. If
  // no plan is feasible, nothing changes — the package is exactly as the
  // walk left it.
  if (missState.best) {
    const miss = missState.best.candidate;
    const missText = missState.best.text;
    const missEff = effectiveScore({ score: miss.score, path: miss.path });
    const missIsNewFile = !includedFilesMap.has(miss.fileId);
    const capsAllow = missIsNewFile
      ? includedFilesMap.size < limits.maxFiles
      : (fileWindowCounts.get(miss.fileId) ?? 0) < limits.maxWindowsPerFile;
    if (capsAllow) {
      let rescueSucceeded = false;
      const droppedInRescue = new Set<string>();
      const dropPool = retrievedWindows
        .map((w, index) => ({ w, index }))
        .filter(({ w }) => {
          if (servedExplicit.has(windowKey(w))) return false;
          if (plan.intent === "cli-execution" && (w.path.startsWith("cli/") || w.path.includes("/cli/") || w.path.includes("/bin/"))) {
            return false;
          }
          const wEff = effectiveScore({ score: w.score, path: w.path });
          return wEff < missEff || wEff - missEff <= SERVING_DISPLACEMENT_MARGIN;
        })
        // Substitute the costliest evidence first: fewer, larger drops keep
        // the many small files in the package and free budget fastest.
        .sort(
          (a, b) =>
            b.w.text.length - a.w.text.length ||
            effectiveScore({ score: b.w.score, path: b.w.path }) -
              effectiveScore({ score: a.w.score, path: a.w.path }) ||
            a.w.path.localeCompare(b.w.path) ||
            a.w.startLine - b.w.startLine,
        );

      // Serving variants, most complete first: the full candidate window,
      // then (when available) the compacted evidence core.
      const missLines = missText.split("\n");
      const variants: { startLine: number; endLine: number; text: string; cost: { chars: number; tokens: number } }[] = [
        {
          startLine: miss.startLine,
          endLine: miss.endLine,
          text: missText,
          cost: windowCostOf(miss.path, miss.contentHash, miss.startLine, miss.endLine, missText),
        },
      ];
      if (miss.coreStart !== undefined && miss.coreEnd !== undefined && miss.coreStart >= miss.startLine && miss.coreEnd <= miss.endLine) {
        const coreText = missLines
          .slice(miss.coreStart - miss.startLine, miss.coreEnd - miss.startLine + 1)
          .join("\n");
        variants.push({
          startLine: miss.coreStart,
          endLine: miss.coreEnd,
          text: coreText,
          cost: windowCostOf(miss.path, miss.contentHash, miss.coreStart, miss.coreEnd, coreText),
        });
      } else if (miss.coreStart !== undefined && miss.coreEnd !== undefined) {
        const coreText = await getFileLines(db, miss.fileId, miss.coreStart, miss.coreEnd, backfillDeps);
        if (coreText !== null) {
          variants.push({
            startLine: miss.coreStart,
            endLine: miss.coreEnd,
            text: coreText,
            cost: windowCostOf(miss.path, miss.contentHash, miss.coreStart, miss.coreEnd, coreText),
          });
        }
      }

      for (const variant of variants) {
        // Simulation over a copied ledger: no mutation happens until a plan
        // is feasible, so an infeasible rescue restores the exact original
        // package (nothing was ever changed). Figures include the appendix
        // overhead of every final line-1 window.
        const liveCounts = new Map(fileWindowCounts);
        const variantBlock = apiBlockCostOf(miss.path, variant.startLine);
        let projectedChars = currentCharacters + variant.cost.chars;
        let projectedTokens = currentTokens + variant.cost.tokens;
        let blockChars = variantBlock.chars;
        let blockTokens = variantBlock.tokens;
        const chosen: RetrievedWindow[] = [];
        let emptiedFiles = 0;
        for (const w of retrievedWindows) {
          if (w.startLine === 1) {
            const block = apiBlockCostOf(w.path, 1);
            blockChars += block.chars;
            blockTokens += block.tokens;
          }
        }
        if (
          projectedChars + blockChars > limits.maxCharacters ||
          projectedTokens + blockTokens > limits.maxTokens
        ) {
          for (const entry of dropPool) {
            if (
              projectedChars + blockChars <= limits.maxCharacters &&
              projectedTokens + blockTokens <= limits.maxTokens
            ) {
              break;
            }
            const w = entry.w;
            const live = liveCounts.get(w.fileId) ?? 1;
            const isFileEmptying = live <= 1;
            if (isFileEmptying && (!missIsNewFile || emptiedFiles >= 1)) continue;
            const cost = servedCosts.get(windowKey(w));
            if (!cost) continue;
            liveCounts.set(w.fileId, live - 1);
            if (isFileEmptying) emptiedFiles += 1;
            chosen.push(w);
            projectedChars -= cost.chars;
            projectedTokens -= cost.tokens;
            if (w.startLine === 1) {
              const block = apiBlockCostOf(w.path, 1);
              blockChars -= block.chars;
              blockTokens -= block.tokens;
            }
          }
        }
        if (
          projectedChars + blockChars <= limits.maxCharacters &&
          projectedTokens + blockTokens <= limits.maxTokens
        ) {
          // Apply the whole plan atomically: every drop and the add together.
          for (const w of chosen) {
            const key = windowKey(w);
            droppedInRescue.add(key);
            const cost = servedCosts.get(key)!;
            servedCosts.delete(key);
            servedExplicit.delete(key);
            servedContext.delete(key);
            currentCharacters -= cost.chars;
            currentTokens -= cost.tokens;
            rawCodeCharacters -= w.text.length;
            fileWindowCounts.set(w.fileId, Math.max(0, (fileWindowCounts.get(w.fileId) ?? 1) - 1));
            const index = retrievedWindows.indexOf(w);
            retrievedWindows.splice(index, 1);
            const record = includedFilesMap.get(w.fileId);
            if (record) {
              record.windows = record.windows.filter(
                (r) => !(r.startLine === w.startLine && r.endLine === w.endLine),
              );
              if (record.windows.length === 0) includedFilesMap.delete(w.fileId);
            }
          }
          serveWindow(miss, variant.startLine, variant.endLine, variant.text, missText);
          rescueSucceeded = true;
          break;
        }
      }
      // The rescued window takes its effective-score position in the serve
      // order, so later low-value compaction still pops strictly weaker
      // windows before it ever reaches the rescue.
      const last = retrievedWindows[retrievedWindows.length - 1];
      if (retrievedWindows.length > 1 && last && last.fileId === miss.fileId) {
        const servedEff = effectiveScore({ score: last.score, path: last.path });
        let insertAfter = -1;
        for (let i = 0; i < retrievedWindows.length - 1; i++) {
          const w = retrievedWindows[i]!;
          if (effectiveScore({ score: w.score, path: w.path }) >= servedEff) insertAfter = i;
        }
        // -1 means the rescue outranks everything still served: it belongs
        // at the front of the serve order instead of the pop-tail.
        const insertAt = insertAfter === -1 ? 0 : insertAfter + 1;
        if (insertAt !== retrievedWindows.length - 1) {
          retrievedWindows.splice(retrievedWindows.length - 1, 1);
          retrievedWindows.splice(insertAt === 0 ? 0 : insertAt, 0, last);
        }
      }

      // Stage 5 second-chance sweep: after successful R2 rescue frees budget,
      // candidates that were skipped earlier in the walk get a second chance
      // to fit into the remaining budget before pad expansion.
      if (rescueSucceeded && currentCharacters < limits.maxCharacters && currentTokens < limits.maxTokens) {
        for (const win of orderedForBudget) {
          if (currentCharacters >= limits.maxCharacters || currentTokens >= limits.maxTokens) break;
          const key = windowKey(win);
          if (droppedInRescue.has(key)) continue;
          if (includedFilesMap.has(win.fileId)) continue;

          const isNewFile = !includedFilesMap.has(win.fileId);
          if (isNewFile && includedFilesMap.size >= limits.maxFiles) continue;

          try {
            const text = await getFileLines(db, win.fileId, win.startLine, win.endLine, backfillDeps);
            if (text === null) continue;

            const candidateCost = windowCostOf(win.path, win.contentHash, win.startLine, win.endLine, text);
            if (
              currentCharacters + candidateCost.chars <= limits.maxCharacters &&
              currentTokens + candidateCost.tokens <= limits.maxTokens
            ) {
              serveWindow(win, win.startLine, win.endLine, text, text);
              continue;
            }

            const remainingChars = limits.maxCharacters - currentCharacters;
            const remainingTokens = limits.maxTokens - currentTokens;
            const core = coreWindowWithin(win, text);
            if (core) {
              const coreCost = windowCostOf(win.path, win.contentHash, core.startLine, core.endLine, core.text);
              const blockOverhead = apiBlockCostOf(win.path, core.startLine);
              if (
                coreCost.chars + blockOverhead.chars <= remainingChars &&
                coreCost.tokens + blockOverhead.tokens <= remainingTokens
              ) {
                serveWindow(win, core.startLine, core.endLine, core.text, text);
                continue;
              }
            }
          } catch {
            continue;
          }
        }
      }
    }
  }
  expandServedPads();

  // Enriched symbol/API surface for the retrieved files (Phase 2). Loaded
  // after budget selection so only retrieved files pay the query cost.
  let retrievedSymbols: RetrievalResult["symbols"] = [];
  const retrievedFileIds = [...includedFilesMap.keys()];
  if (retrievedFileIds.length > 0) {
    let symData: Record<string, unknown>[] = [];
    try {
      const { data, error } = await (db as unknown as { from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => Promise<{ data: unknown; error: unknown }> } } })
        .from("symbols")
        .select("file_id, name, kind, line, end_line, exported, export_kind, signature, return_type, documentation")
        .eq("analysis_id", analysisId);
      if (!error && data) symData = data as Record<string, unknown>[];
    } catch {
      const { data } = await db
        .from("symbols")
        .select("file_id, name, kind, line, exported")
        .eq("analysis_id", analysisId);
      symData = (data ?? []) as Record<string, unknown>[];
    }
    if (symData) {
      const retrievedSet = new Set(retrievedFileIds);
      const pathById = new Map([...includedFilesMap.values()].map((f) => [f.fileId, f.path]));
      retrievedSymbols = symData
        .filter((s: Record<string, unknown>) => retrievedSet.has(s.file_id as string))
        .map((s: Record<string, unknown>) => mapSymbolCandidateRow(s, pathById.get(s.file_id as string) ?? ""))
        .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.name.localeCompare(b.name));
    }
  }

  // Calculate API surface footprint and verify total evidence bounds.
  // The per-file appendix itself is precomputed above (apiBlockByPath) from
  // the same symbol rows; here it is attached to line-1 windows of the final
  // package, which is why every serving-phase budget check reserves it.

  const getApiSurfaceBlock = (path: string): string => apiBlockByPath.get(path) ?? "";

  let totalEvidenceChars = currentCharacters;
  let totalEvidenceTokens = currentTokens;
  for (const win of retrievedWindows) {
    if (win.startLine === 1) {
      const block = getApiSurfaceBlock(win.path);
      if (block) {
        totalEvidenceChars += block.length;
        totalEvidenceTokens += estimateCodeTokens(block);
      }
    }
  }

  // Post-retrieval compaction: If API surface pushes total evidence beyond the operational budget,
  // atomically drop lowest-scoring candidate windows from the tail until the prompt budget is satisfied.
  // Original whole-window line bounds are strictly preserved (no partial line truncations).
  while (
    retrievedWindows.length > 1 &&
    (totalEvidenceChars > limits.maxCharacters || totalEvidenceTokens > limits.maxTokens)
  ) {
    const dropped = retrievedWindows.pop()!;
    const headerCost = `--- File: ${dropped.path} (lines ${dropped.startLine}-${dropped.endLine}) [hash: ${dropped.contentHash.slice(0, 8)}] ---\n`.length + 2;
    const droppedChars = dropped.text.length + headerCost;
    const droppedTokens = estimateCodeTokens(dropped.text) + estimateProseTokens(dropped.path) + 15;
    totalEvidenceChars -= droppedChars;
    totalEvidenceTokens -= droppedTokens;
    rawCodeCharacters -= dropped.text.length;

    if (dropped.startLine === 1) {
      const block = getApiSurfaceBlock(dropped.path);
      if (block) {
        totalEvidenceChars -= block.length;
        totalEvidenceTokens -= estimateCodeTokens(block);
      }
    }

    // Synchronize includedFilesMap and symbols
    const fileRecord = includedFilesMap.get(dropped.fileId);
    if (fileRecord) {
      fileRecord.windows = fileRecord.windows.filter(
        (w) => !(w.startLine === dropped.startLine && w.endLine === dropped.endLine),
      );
      if (fileRecord.windows.length === 0) {
        includedFilesMap.delete(dropped.fileId);
        apiBlockByPath.delete(dropped.path);
        retrievedSymbols = retrievedSymbols.filter((s) => s.fileId !== dropped.fileId);
      }
    }
  }

  return {
    analysisId,
    query: rawQuery,
    tokens,
    plan,
    windows: retrievedWindows,
    files: [...includedFilesMap.values()],
    symbols: retrievedSymbols,
    totalCharacters: rawCodeCharacters,
    totalTokens: totalEvidenceTokens,
    renderedCharacters: totalEvidenceChars,
    insufficientEvidence: retrievedWindows.length === 0 && effectivePackagingText === "",
    ...(effectivePackagingText ? { packaging: effectivePackagingText } : {}),
    ...(includePackaging && packagingEvidence.manifests ? { manifests: packagingEvidence.manifests } : {}),
  };
}

/**
 * Merges overlapping or close line windows on the same file. The merged
 * window keeps the strongest score and unions the retrieval strategies that
 * produced it — evidence confirmed by two independent strategies (say, a
 * symbol match *and* a path match) gets a small corroboration bonus, which
 * is what lifts cross strategy-confirmed files above generic setup files
 * at comparable scores.
 */
export function mergeCandidateWindows(windows: TargetWindow[]): TargetWindow[] {
  const byFile = new Map<string, TargetWindow[]>();

  for (const win of windows) {
    const list = byFile.get(win.fileId) ?? [];
    list.push(win);
    byFile.set(win.fileId, list);
  }

  const merged: TargetWindow[] = [];

  for (const list of byFile.values()) {
    // Sort by start line ascending
    list.sort((a, b) => a.startLine - b.startLine);

    let current = list[0]!;
    for (let i = 1; i < list.length; i++) {
      const next = list[i]!;
      // If windows overlap or are within 5 lines of each other, merge them
      if (next.startLine <= current.endLine + 5) {
        const strategies = [...new Set([...(current.strategies ?? []), ...(next.strategies ?? [])])];
        // The merged window must keep every input core whole: union of the
        // spans (candidates carry at most one core each; a core-less input
        // contributes nothing).
        const cores = [current, next].filter(
          (w) => w.coreStart !== undefined && w.coreEnd !== undefined,
        );
        const core =
          cores.length === 0
            ? {}
            : {
                coreStart: Math.min(...cores.map((w) => w.coreStart!)),
                coreEnd: Math.max(...cores.map((w) => w.coreEnd!)),
              };
        const corroboration = Math.min(8, Math.max(0, strategies.length - 1) * 4);
        // Provenance stays honest under merging: a window is "derived" only
        // when every input was derived, and treats any undefined input as
        // neither — the moment indexed evidence backs the file it is
        // "indexed"; the derived hint additionally survives in the reason.
        const provenance =
          current.provenance === "indexed" || next.provenance === "indexed"
            ? ("indexed" as const)
            : (current.provenance ?? next.provenance);
        const tokensMatched = new Set(
          Array.from(`${current.reason}; ${next.reason}`.matchAll(/matches token "([^"]+)"/g)).map((m) => m[1]),
        );
        const multiTokenBonus = tokensMatched.size >= 2 ? 8 : 0;
        current = {
          fileId: current.fileId,
          path: current.path,
          contentHash: current.contentHash,
          totalLines: current.totalLines,
          startLine: Math.min(current.startLine, next.startLine),
          endLine: Math.max(current.endLine, next.endLine),
          score: Math.max(current.score, next.score) + corroboration + multiTokenBonus,
          strategies,
          provenance,
          ...core,
          reason: next.reason === current.reason
            ? current.reason
            : `${current.reason}; ${next.reason}${corroboration > 0 ? ` (+${corroboration} from ${strategies.length} strategies)` : ""}${multiTokenBonus > 0 ? ` (+${multiTokenBonus} from multiple query concepts)` : ""}`,
        };
      } else {
        merged.push(current);
        current = next;
      }
    }
    merged.push(current);
  }

  return merged;
}

/**
 * Formats retrieved code windows into structured markdown context for the prompt.
 */
export function formatRetrievedContext(result: RetrievalResult): string {
  if (result.windows.length === 0 && !result.packaging) {
    return "No relevant code snippets were found in the stored analysis for this query.";
  }

  const sections: string[] = [];
  // Packaging facts come first: they are statements the repository makes about
  // itself, and a code window is easier to read once you know what the project
  // declares it depends on and where it starts.
  if (result.packaging) sections.push(result.packaging);
  // Group symbols by file for an API-surface appendix (Phase 2 enrichment).
  const symbolsByFile = new Map<string, NonNullable<RetrievalResult["symbols"]>>();
  const sortedSymbols = [...(result.symbols ?? [])].sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.name.localeCompare(b.name),
  );
  for (const sym of sortedSymbols) {
    const list = symbolsByFile.get(sym.path) ?? [];
    list.push(sym);
    symbolsByFile.set(sym.path, list);
  }

  for (const win of result.windows) {
    let section = `--- File: ${win.path} (lines ${win.startLine}-${win.endLine}) [hash: ${win.contentHash.slice(0, 8)}] ---\n${win.text}`;
    const syms = symbolsByFile.get(win.path);
    if (syms && syms.length > 0 && win.startLine === 1) {
      // Append the API surface once, on the first window of the file.
      const api = syms
        .filter((s) => s.exported)
        .map((s) => {
          const sig = s.signature ?? s.name;
          const doc = s.documentation ? ` — ${s.documentation.split("\n")[0]}` : "";
          return `- ${s.name} (${s.kind})${s.exportKind && s.exportKind !== "named" ? ` [${s.exportKind}]` : ""}: ${sig}${doc}`;
        })
        .join("\n");
      if (api) section += `\n\n[API surface]\n${api}`;
    }
    sections.push(section);
  }

  return sections.join("\n\n");
}
