import type { SupabaseClient } from "@supabase/supabase-js";
import { getFileLines } from "../content/read.ts";
import type { Database } from "../supabase/database.types.ts";
import { planQuestion, type QuestionPlan } from "./planner.ts";

export type Db = SupabaseClient<Database>;

export type RetrievalBudget = {
  maxCharacters?: number;
  maxFiles?: number;
  /**
   * Soft cap on files from one directory in round 1. A concept that lives in
   * a heavily-matched directory must not claim the whole budget before other
   * matched directories get a slot; deferred files are appended in score
   * order, so a question concentrated in one directory still fills every
   * slot exactly as without the cap.
   */
  maxFilesPerDirectory?: number;
  maxWindowsPerFile?: number;
  seedLimit?: number;
};

export const DEFAULT_BUDGET: Required<RetrievalBudget> = {
  maxCharacters: 28000,
  maxFiles: 16,
  maxFilesPerDirectory: 1,
  maxWindowsPerFile: 2,
  seedLimit: 5,
};

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
};

/**
 * Generic action verbs from the planner ("implement", "handle", …) name what
 * the asker wants done, not something to find evidence about. They still
 * match code, but a window that matched *only* through a generic verb pays
 * this demotion so verb-named files can never outrank concept evidence.
 */
const GENERIC_PENALTY = 25;

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
  files: { fileId: string; path: string; contentHash: string; totalLines: number }[];
  totalCharacters: number;
  insufficientEvidence: boolean;
};

// Common English question words and stop-words to exclude from seed token matching
const STOP_WORDS = new Set([
  "a", "about", "across", "all", "an", "and", "any", "are", "as", "at",
  "be", "between", "both", "but", "by", "can", "do", "does", "each",
  "file", "files", "for", "from", "get", "has", "have", "how",
  "in", "is", "it", "its", "make", "of", "on", "or", "over",
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
};

const ROLE_HINTS: { words: string[]; role: string }[] = [
  { words: ["model", "schema", "database", "db", "query"], role: "model" },
  { words: ["route", "router", "endpoint", "api"], role: "router" },
  { words: ["middleware"], role: "middleware" },
  { words: ["controller", "handler"], role: "controller" },
  { words: ["service"], role: "service" },
  { words: ["config", "configuration", "env"], role: "config" },
  { words: ["store", "state"], role: "store" },
];

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
    tail.length <= 2 || STEM_SUFFIXES.includes(tail) || DERIVATIONAL_SUFFIXES.has(tail);
  // Both sides keep a tail: each tail must look inflectional on its own.
  if (ra.length > 0 && rb.length > 0) {
    return tailFamily(ra) && tailFamily(rb);
  }
  // One word ends where the other continues: the extension must be a true
  // inflection or derivation of the consumed word, never a loose 2-char
  // tail of an already-consumed stem ("auth" extended with "or"/"orize").
  const rest = ra.length > 0 ? ra : rb;
  return rest.length <= 1 || STEM_SUFFIXES.includes(rest) || DERIVATIONAL_SUFFIXES.has(rest);
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
    tokens.add(m.toLowerCase());
  }

  // Split into whitespace and punctuation separated words
  const words = query
    .replace(/[^\w\s\-./]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  for (const word of words) {
    const lower = word.toLowerCase();
    if (lower.length >= 2 && !STOP_WORDS.has(lower)) {
      tokens.add(lower);
    }

    // Split camelCase and PascalCase identifiers (e.g. "createAdminSupabase" -> "create", "admin", "supabase")
    const camelParts = word.replace(/([a-z])([A-Z])/g, "$1 $2").split(/\s+/);
    if (camelParts.length > 1) {
      for (const part of camelParts) {
        const pLower = part.toLowerCase();
        if (pLower.length >= 2 && !STOP_WORDS.has(pLower)) {
          tokens.add(pLower);
        }
      }
    }

    // Split snake_case and kebab-case identifiers (e.g. "auth_middleware" -> "auth", "middleware")
    const splitParts = word.split(/[-_]/);
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

  // A. Search symbols, matched against both the full identifier and its
  // subtokens ("AuthService" -> ["auth","service"]) for every concept
  // variant the query token expands to.
  const { data: symbolsData, error: symbolsError } = await db
    .from("symbols")
    .select("file_id, name, kind, line, exported")
    .eq("analysis_id", analysisId);

  if (!symbolsError && symbolsData) {
    for (const sym of symbolsData) {
      const file = fileMap.get(sym.file_id);
      if (!file) continue;

      const nameLower = sym.name.toLowerCase();
      const subtokens = identifierSubtokens(sym.name);
      let bestConcept = 0;
      let bestGeneric = 0;
      let matchedToken = "";

      for (const token of tokens) {
        const generic = genericTokens.has(token);
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
            else if (variant.length >= 5 && nameLower.includes(variant)) score = 40;
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

      if (bestScore > 0) {
        if (sym.exported) bestScore += 5;
        const startLine = Math.max(1, sym.line - 15);
        const endLine = Math.min(file.lines, sym.line + 25);
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
        });
      }
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
        const generic = genericTokens.has(token);
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
  for (const file of fileMap.values()) {
    const pathLower = file.path.toLowerCase();
    const filename = pathLower.split("/").pop() ?? pathLower;
    const nameParts = [
      ...identifierSubtokens(filename),
      ...pathLower.split("/").flatMap((seg) => identifierSubtokens(seg)),
    ];
    const filenameParts = new Set(identifierSubtokens(filename));
    const matchedVariants = new Set<string>();
    let bestConcept = 0;
    let bestGeneric = 0;
    let matchedToken = "";
    let genericOnly = false;

    for (const token of tokens) {
      const generic = genericTokens.has(token);
      for (const { text: variant, kind } of tokenVariants(token)) {
        const penalty = KIND_PENALTY[kind];
        let score = 0;
        if (filenameParts.has(variant)) {
          score = 80;
        } else if (nameParts.includes(variant)) {
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

    if (bestScore > 0) {
      if (file.role) bestScore += 10;
      const endLine = Math.min(file.lines, 50);
      seedWindows.push({
        fileId: file.id,
        path: file.path,
        contentHash: file.hash,
        totalLines: file.lines,
        startLine: 1,
        endLine,
        score: bestScore,
        strategies: ["path"],
        reason: `file path matches token "${matchedToken}"${genericOnly ? " (generic verb only, demoted)" : ""}`,
      });
    }
  }

  // C2. Role-aware seeding: the pipe already labels files by architectural
  // role (model, router, middleware, controller, service, ...); a question
  // that names an architecture concept should find those files even when no
  // path or symbol name echoes the wording. Ranks below name matches so it
  // only carries files into the budget that belong to the named concept.
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
  const broadQuery = isOnboardingQuery(rawQuery);
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
      } else if (file.role === "route" || file.role === "entry") {
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
        score: isOutgoing ? 35 : 30,
        strategies: ["expansion"],
        provenance: "indexed",
        reason: `1-hop dependency connected to seed "${seedFile.path}" (indexed ${edge.kind} edge)`,
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
    if (hop1Files.length > 0) {
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
          score: 18,
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
        source = await getFileLines(db, seed.fileId, seed.startLine, seed.endLine);
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
      if ((dirCounts.get(dir) ?? 0) < config.maxFilesPerDirectory) {
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

  const retrievedWindows: RetrievedWindow[] = [];
  const includedFilesMap = new Map<
    string,
    { fileId: string; path: string; contentHash: string; totalLines: number }
  >();
  const fileWindowCounts = new Map<string, number>();
  let currentCharacters = 0;

  for (const win of orderedForBudget) {
    if (currentCharacters >= config.maxCharacters) break;

    const isNewFile = !includedFilesMap.has(win.fileId);
    if (isNewFile && includedFilesMap.size >= config.maxFiles) {
      continue;
    }

    const currentWindowsForFile = fileWindowCounts.get(win.fileId) ?? 0;
    if (currentWindowsForFile >= config.maxWindowsPerFile) {
      continue;
    }

    try {
      const text = await getFileLines(db, win.fileId, win.startLine, win.endLine);
      if (text === null) continue;

      const windowLength = text.length;
      if (currentCharacters + windowLength > config.maxCharacters && retrievedWindows.length > 0) {
        continue;
      }

      currentCharacters += windowLength;
      fileWindowCounts.set(win.fileId, currentWindowsForFile + 1);
      includedFilesMap.set(win.fileId, {
        fileId: win.fileId,
        path: win.path,
        contentHash: win.contentHash,
        totalLines: win.totalLines,
      });

      retrievedWindows.push({
        fileId: win.fileId,
        path: win.path,
        contentHash: win.contentHash,
        totalLines: win.totalLines,
        startLine: win.startLine,
        endLine: win.endLine,
        score: win.score,
        text,
        reason: win.reason,
        provenance: win.provenance,
      });
    } catch {
      // Content unavailable or unreadable, continue to next candidate
      continue;
    }
  }

  return {
    analysisId,
    query: rawQuery,
    tokens,
    plan,
    windows: retrievedWindows,
    files: [...includedFilesMap.values()],
    totalCharacters: currentCharacters,
    insufficientEvidence: retrievedWindows.length === 0,
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
        const corroboration = Math.min(8, Math.max(0, strategies.length - 1) * 4);
        // Provenance stays honest under merging: a window is "derived" only
        // when every input was derived, and treats any undefined input as
        // neither — the moment indexed evidence backs the file it is
        // "indexed"; the derived hint additionally survives in the reason.
        const provenance =
          current.provenance === "indexed" || next.provenance === "indexed"
            ? ("indexed" as const)
            : (current.provenance ?? next.provenance);
        current = {
          fileId: current.fileId,
          path: current.path,
          contentHash: current.contentHash,
          totalLines: current.totalLines,
          startLine: Math.min(current.startLine, next.startLine),
          endLine: Math.max(current.endLine, next.endLine),
          score: Math.max(current.score, next.score) + corroboration,
          strategies,
          provenance,
          reason: next.reason === current.reason
            ? current.reason
            : corroboration > 0
              ? `${current.reason}; ${next.reason} (+${corroboration} from ${strategies.length} strategies)`
              : `${current.reason}; ${next.reason}`,
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
  if (result.windows.length === 0) {
    return "No relevant code snippets were found in the stored analysis for this query.";
  }

  const sections: string[] = [];
  for (const win of result.windows) {
    sections.push(
      `--- File: ${win.path} (lines ${win.startLine}-${win.endLine}) [hash: ${win.contentHash.slice(0, 8)}] ---\n${win.text}`,
    );
  }

  return sections.join("\n\n");
}
