// Pure citation extraction and verification, shared by the AI layer and the
// renderer so both agree on what counts as a repository path mention.
//
// Every token here is a *candidate*: a word that looks like it could be a
// path. Whether it is allowed depends on the analysis the model was shown,
// which the caller supplies as the `allowed` set.

// Code spans, bold and italic — the same subset the renderer permits.
const MARKUP = /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__/g;

// A token is path-like only if it contains a separator or an extension, so
// ordinary words ("See", "the", "file") are never treated as mentions. This
// mirrors ExplanationText, which only links a word when `isPath` is true.
function isPathLike(core: string): boolean {
  return core.includes("/") || /\.\w+$/.test(core);
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
function normalize(token: string): string {
  let p = token;
  if (p.startsWith("./")) p = p.slice(2);
  if (p.endsWith("/") && p.length > 1) p = p.slice(0, -1);
  return p;
}

export type CitationFailure = { paths: string[] };

// Returns the offending mentions (empty when every path-shaped token names a
// file the model was shown). The caller decides what to do with them — the AI
// layer refuses and never caches; the renderer could degrade gracefully.
export function verifyCitations(body: string, allowed: Set<string>): CitationFailure {
  const offending: string[] = [];
  for (const token of pathTokens(body)) {
    if (!allowed.has(normalize(token))) offending.push(token);
  }
  return { paths: offending };
}

export class CitationError extends Error {
  readonly paths: string[];
  constructor(paths: string[]) {
    super(`The answer names files that are not in this analysis: ${paths.join(", ")}`);
    this.name = "CitationError";
    this.paths = paths;
  }
}
