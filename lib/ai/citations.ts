// Pure citation extraction and verification, shared by the AI layer and the
// renderer so both agree on what counts as a repository path mention.
//
// Every token here is a *candidate*: a word that looks like it could be a
// citation or path. Whether it is allowed depends on the analysis the model was shown,
// which the caller supplies as the `allowed` set or evidence map.

// Code spans, bold and italic — the same subset the renderer permits.
const MARKUP = /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__/g;

// Suffix for line numbers: #L10-L25, #L10-25, #L10, :10-25, :10
const LINE_SUFFIX = /(?:#(?:L)?(\d+)(?:-(?:L)?(\d+))?|:(\d+)(?:-(\d+))?)$/;

export function stripLineSuffix(token: string): string {
  return token.replace(LINE_SUFFIX, "");
}

export function stripFencedCodeBlocks(text: string): string {
  return text.replace(/(?:```|~~~)[^\r\n]*\r?\n[\s\S]*?(?:\r?\n(?:```|~~~)|$)/g, "");
}

const LATIN_ABBREVIATIONS = new Set([
  "e.g.", "e.g", "i.e.", "i.e", "etc.", "etc", "vs.", "vs",
  "ex.", "ex", "al.", "al", "n.b.", "n.b", "fig.", "fig",
]);

export function isDirectoryReference(token: string): boolean {
  const stripped = stripLineSuffix(token.trim());
  return stripped.endsWith("/") || stripped.endsWith("\\");
}

export function isNpmPackage(token: string): boolean {
  const stripped = stripLineSuffix(token.trim());
  return stripped.startsWith("@") || stripped.startsWith("npm:") || stripped.startsWith("pnpm:");
}

export function isPlaceholderPath(token: string): boolean {
  return /<[^>]+>|\[\.\.\.[^\]]+\]|\*|\.\.\./.test(token);
}

export function isAbbreviation(token: string): boolean {
  const clean = token.trim().toLowerCase();
  return LATIN_ABBREVIATIONS.has(clean);
}

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "sql", "css", "scss",
  "html", "yaml", "yml", "toml", "sh", "py", "go", "rs", "c", "cpp", "h",
  "graphql", "gql", "prisma", "env",
]);

export function hasFileExtension(path: string): boolean {
  const filename = path.split("/").pop() ?? path;
  if (filename === ".env" || filename.startsWith(".env.") || filename === ".gitignore") {
    return true;
  }
  const match = filename.match(/\.([a-zA-Z0-9_\-]+)$/);
  if (!match || !match[1]) return false;
  const ext = match[1].toLowerCase();
  if (/^\d+$/.test(ext)) return false;
  return CODE_EXTENSIONS.has(ext);
}

export function hasLineNumbers(token: string): boolean {
  return LINE_SUFFIX.test(token.trim());
}

export const STANDARD_PROJECT_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "README.md",
  "LICENSE",
  ".gitignore",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  ".env.example",
]);

/**
 * Determines whether a candidate token qualifies as a path or citation to check.
 * Strictly separates actual citations and paths from directory references,
 * npm packages, placeholders, commands, and abbreviations.
 */
export function isCitationCandidate(
  token: string,
  inCodeSpan: boolean,
  isLegacySet = false,
): boolean {
  const raw = token.trim();
  if (!raw || /\s/.test(raw)) return false;
  if (isAbbreviation(raw)) return false;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return false;
  if (isNpmPackage(raw)) return false;
  if (isPlaceholderPath(raw)) return false;

  if (isDirectoryReference(raw)) {
    // In code spans under legacy Set-based checking (explainFolder / explainFile),
    // directories are validated against the allowed set. In Q&A or prose, they are
    // directory references and excluded from code citation verification.
    return isLegacySet && inCodeSpan;
  }

  // If token has explicit line numbers (#L10-L25 or :10-25), it is an explicit citation candidate
  if (hasLineNumbers(raw)) return true;

  const stripped = stripLineSuffix(raw);

  // In code spans (`...`), require either a recognizable file extension or a path separator
  if (inCodeSpan) {
    return hasFileExtension(stripped) || stripped.includes("/");
  }

  // In bare prose (outside backticks), only treat as path candidate if it has
  // BOTH path separators AND a valid file extension, preventing English abbreviations,
  // version numbers, and conversational phrases from entering citation verification.
  return stripped.includes("/") && hasFileExtension(stripped);
}

export function pathTokens(body: string, isLegacySet = false): string[] {
  const cleanedBody = stripFencedCodeBlocks(body);
  const tokens: string[] = [];
  let last = 0;
  for (const m of cleanedBody.matchAll(MARKUP)) {
    const at = m.index ?? 0;
    if (at > last) tokens.push(...proseTokens(cleanedBody.slice(last, at)));
    if (m[1] !== undefined) {
      // A code span: check if the inner text is a valid citation candidate
      const inner = m[1].trim();
      if (inner && isCitationCandidate(inner, true, isLegacySet)) tokens.push(inner);
    } else {
      // Bold: recurse so code spans and bare words inside it are found too
      const inner = m[2] ?? m[3] ?? "";
      tokens.push(...pathTokens(inner, isLegacySet));
    }
    last = at + m[0].length;
  }
  if (last < cleanedBody.length) tokens.push(...proseTokens(cleanedBody.slice(last)));
  return tokens;
}

// Prose between markup: italics lose their markers, stray backticks and
// asterisks go, then each whitespace-separated word is stripped of its
// surrounding punctuation.
function proseTokens(text: string): string[] {
  const cleaned = text
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)\*(?!\w)/g, "$1$2")
    .replace(/(^|[\w])_(?=\S)([^_]+?)_(?!\w)/g, "$1$2")
    .replace(/[`*]/g, "");
  const out: string[] = [];
  for (const word of cleaned.split(/\s+/)) {
    if (!word) continue;
    const match = word.match(/^([("'[]*)(.*?)([)"'\].,;:!?]*)$/);
    const core = match?.[2] ?? word;
    if (core && core.length > 2 && isCitationCandidate(core, false, false)) out.push(core);
  }
  return out;
}

// A caller-normalized form: `./lib/ai/tasks.ts` and `lib/ai/tasks.ts` name the
// same file; `src/` and `src` name the same directory. Exact match otherwise.
// Stored paths (from the parser) are already clean, so only the token side is
// normalized.
export function normalize(token: string): string {
  let p = stripLineSuffix(token);
  if (p.startsWith("./")) p = p.slice(2);
  if (p.endsWith("/") && p.length > 1) p = p.slice(0, -1);
  return p;
}

export type ParsedCitation = {
  raw: string;
  path: string;
  startLine?: number;
  endLine?: number;
};

/**
 * Parses a citation token into its normalized path and optional line ranges.
 * Supports:
 * - `path/to/file.ts#L10-L25`
 * - `path/to/file.ts#L10-25`
 * - `path/to/file.ts#L10`
 * - `path/to/file.ts:10-25`
 * - `path/to/file.ts:10`
 * - `path/to/file.ts`
 */
export function parseCitation(token: string): ParsedCitation {
  const raw = token.trim();
  const match = raw.match(/^(.*?)(?:#(?:L)?(\d+)(?:-(?:L)?(\d+))?|:(\d+)(?:-(\d+))?)$/);
  if (!match || !match[1]) {
    return { raw, path: normalize(raw) };
  }

  const basePath = normalize(match[1]);
  const s1 = match[2] ? parseInt(match[2], 10) : undefined;
  const e1 = match[3] ? parseInt(match[3], 10) : s1;

  const s2 = match[4] ? parseInt(match[4], 10) : undefined;
  const e2 = match[5] ? parseInt(match[5], 10) : s2;

  const startLine = s1 ?? s2;
  const endLine = e1 ?? e2;

  return {
    raw,
    path: basePath,
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
  };
}

/**
 * Extracts and deduplicates parsed citations from markdown body text.
 */
export function extractCitations(body: string, options?: CitationOptions): ParsedCitation[] {
  const tokens = pathTokens(body);
  const citations: ParsedCitation[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const parsed = parseCitation(token);
    if (!seen.has(parsed.raw)) {
      seen.add(parsed.raw);
      if (options?.allAnalysisFiles) {
        const resolved = findMatchingPath(
          parsed.path,
          (p) => options.allAnalysisFiles!.has(p),
          options.allAnalysisFiles,
        );
        if (resolved) {
          parsed.path = resolved;
        }
      }
      citations.push(parsed);
    }
  }
  return citations;
}

export type FileEvidence = {
  lines?: number;
  contentHash?: string;
};

export type AllowedCitations = Set<string> | Map<string, FileEvidence>;

export type CitationFailure = {
  paths: string[];
  details?: string[];
};

export type CitationOptions = {
  allAnalysisFiles?: Set<string>;
};

const RESOLVE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  "/index.ts", "/index.tsx", "/index.js",
];

export function findMatchingPath(
  path: string,
  checker: (p: string) => boolean,
  allFiles?: Set<string>,
): string | null {
  const norm = normalize(path);
  if (checker(norm)) return norm;

  // Candidate path variants to check
  const variants: string[] = [norm];

  // If path ends in .js / .mjs / .cjs, TS ESM uses .js imports for .ts source files
  if (norm.endsWith(".js")) {
    const base = norm.slice(0, -3);
    variants.push(`${base}.ts`, `${base}.tsx`);
  } else if (norm.endsWith(".mjs")) {
    const base = norm.slice(0, -4);
    variants.push(`${base}.mts`, `${base}.ts`);
  } else if (norm.endsWith(".cjs")) {
    const base = norm.slice(0, -4);
    variants.push(`${base}.cts`, `${base}.ts`);
  } else if (!hasFileExtension(norm)) {
    for (const ext of RESOLVE_EXTENSIONS) {
      variants.push(`${norm}${ext}`);
    }
  }

  // 1. Check direct variants against checker
  for (const v of variants) {
    if (checker(v)) return v;
  }

  // 2. If allFiles set is available, check relative / suffix matches
  // e.g. "init.ts" or "cli/init.ts" matching "src/cli/init.ts"
  if (allFiles) {
    for (const v of variants) {
      const suffix = v.startsWith("/") ? v : `/${v}`;
      for (const filePath of allFiles) {
        if (filePath.endsWith(suffix) || filePath === v) {
          if (checker(filePath)) return filePath;
        }
      }
    }
  }

  return null;
}

// Returns the offending mentions (empty when every path-shaped token names a
// file the model was shown and adheres to valid line bounds). The caller decides
// what to do with them — the AI layer refuses and never caches.
export function verifyCitations(
  body: string,
  allowed: AllowedCitations,
  options?: CitationOptions,
): CitationFailure {
  const offending = new Set<string>();
  const details: string[] = [];
  const isMap = allowed instanceof Map;
  const isLegacySet = !isMap && !options;

  for (const token of pathTokens(body, isLegacySet)) {
    const parsed = parseCitation(token);
    const normalizedPath = parsed.path;

    // Line-bound citations (#L10-L25 or :10-25) cite specific source lines and
    // must strictly be present in the allowed retrieved evidence
    if (parsed.startLine !== undefined && parsed.endLine !== undefined) {
      const allowedFiles = new Set(allowed instanceof Map ? Array.from(allowed.keys()) : Array.from(allowed));
      const matchedEvidencePath = findMatchingPath(normalizedPath, (p) => allowed.has(p), allowedFiles);
      if (!matchedEvidencePath) {
        offending.add(token);
        details.push(`Unknown file path or uncited evidence in "${token}": "${normalizedPath}" is not in retrieved evidence`);
        continue;
      }

      if (isMap) {
        const evidence = (allowed as Map<string, FileEvidence>).get(matchedEvidencePath);
        if (evidence) {
          if (parsed.startLine < 1) {
            offending.add(token);
            details.push(`Invalid line range in "${token}": start line ${parsed.startLine} must be >= 1`);
          } else if (parsed.startLine > parsed.endLine) {
            offending.add(token);
            details.push(`Invalid line range in "${token}": start line ${parsed.startLine} exceeds end line ${parsed.endLine}`);
          } else if (evidence.lines !== undefined && parsed.endLine > evidence.lines) {
            offending.add(token);
            details.push(`Invalid line range in "${token}": end line ${parsed.endLine} exceeds file length of ${evidence.lines} lines`);
          }
        }
      }
      continue;
    }

    // Bare file mentions without line numbers: check against allowed evidence,
    // all analysis files (including extensionless TS import paths and relative suffixes),
    // or standard root manifest files
    const allowedFiles = new Set(allowed instanceof Map ? Array.from(allowed.keys()) : Array.from(allowed));
    const existsInAllowed = findMatchingPath(normalizedPath, (p) => allowed.has(p), allowedFiles);
    const existsInAllFiles = options?.allAnalysisFiles
      ? findMatchingPath(normalizedPath, (p) => options.allAnalysisFiles!.has(p), options.allAnalysisFiles)
      : null;
    const isStandard = STANDARD_PROJECT_FILES.has(normalizedPath);

    if (!existsInAllowed && !existsInAllFiles && !isStandard) {
      offending.add(token);
      details.push(`Unknown file path: "${token}"`);
    }
  }

  return {
    paths: Array.from(offending),
    ...(details.length > 0 ? { details } : {}),
  };
}

export class CitationError extends Error {
  readonly paths: string[];
  readonly details?: string[];
  constructor(paths: string[], details?: string[]) {
    const message = details && details.length > 0
      ? `Citation verification failed: ${details.join("; ")}`
      : `The answer names files that are not in this analysis: ${paths.join(", ")}`;
    super(message);
    this.name = "CitationError";
    this.paths = paths;
    this.details = details;
  }
}
