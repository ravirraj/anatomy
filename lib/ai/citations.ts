// Pure citation extraction and verification, shared by the AI layer and the
// renderer so both agree on what counts as a repository path mention.
//
// Every token here is a *candidate*: a word that looks like it could be a
// path. Whether it is allowed depends on the analysis the model was shown,
// which the caller supplies as the `allowed` set or evidence map.

// Code spans, bold and italic — the same subset the renderer permits.
const MARKUP = /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__/g;

// Suffix for line numbers: #L10-L25, #L10-25, #L10, :10-25, :10
const LINE_SUFFIX = /(?:#(?:L)?(\d+)(?:-(?:L)?(\d+))?|:(\d+)(?:-(\d+))?)$/;

export function stripLineSuffix(token: string): string {
  return token.replace(LINE_SUFFIX, "");
}

// A token is path-like only if it contains a separator or an extension, so
// ordinary words ("See", "the", "file") are never treated as mentions. This
// mirrors ExplanationText, which only links a word when `isPath` is true.
function isPathLike(core: string): boolean {
  const stripped = stripLineSuffix(core);
  return stripped.includes("/") || /\.\w+$/.test(stripped);
}

export function pathTokens(body: string): string[] {
  const tokens: string[] = [];
  let last = 0;
  for (const m of body.matchAll(MARKUP)) {
    const at = m.index ?? 0;
    if (at > last) tokens.push(...proseTokens(body.slice(last, at)));
    if (m[1] !== undefined) {
      // A code span: the inner text is a candidate path.
      const inner = m[1].trim();
      if (inner && isPathLike(inner)) tokens.push(inner);
    } else {
      // Bold: recurse so code spans and bare words inside it are found too.
      const inner = m[2] ?? m[3] ?? "";
      tokens.push(...pathTokens(inner));
    }
    last = at + m[0].length;
  }
  if (last < body.length) tokens.push(...proseTokens(body.slice(last)));
  return tokens;
}

// Prose between markup: italics lose their markers, stray backticks and
// asterisks go, then each whitespace-separated word is stripped of its
// surrounding punctuation. This mirrors ExplanationText exactly so the
// verifier and the renderer never disagree about which words are mentions.
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
    if (core && core.length > 2 && isPathLike(core)) out.push(core);
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
export function extractCitations(body: string): ParsedCitation[] {
  const tokens = pathTokens(body);
  const citations: ParsedCitation[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const parsed = parseCitation(token);
    if (!seen.has(parsed.raw)) {
      seen.add(parsed.raw);
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

// Returns the offending mentions (empty when every path-shaped token names a
// file the model was shown and adheres to valid line bounds). The caller decides
// what to do with them — the AI layer refuses and never caches.
export function verifyCitations(body: string, allowed: AllowedCitations): CitationFailure {
  const offending = new Set<string>();
  const details: string[] = [];
  const isMap = allowed instanceof Map;

  for (const token of pathTokens(body)) {
    const parsed = parseCitation(token);
    const normalizedPath = parsed.path;

    const exists = allowed.has(normalizedPath);
    if (!exists) {
      offending.add(token);
      details.push(`Unknown file path: "${token}"`);
      continue;
    }

    if (isMap) {
      const evidence = (allowed as Map<string, FileEvidence>).get(normalizedPath);
      if (evidence) {
        if (parsed.startLine !== undefined && parsed.endLine !== undefined) {
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
