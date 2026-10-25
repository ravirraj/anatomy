import type { ParsedFile, ParsedSymbol } from "../parser/types.ts";

// Search over an analysis, entirely in memory: the map already holds every
// file path and every symbol, so searching makes no request. Full-text search
// is not possible here — the database stores a file's hash, never its
// contents — so a query matches paths and symbol names only.

export type SearchHit =
  | { kind: "file"; path: string; score: number }
  | {
      kind: "symbol";
      path: string;
      name: string;
      symbolKind: ParsedSymbol["kind"];
      line: number;
      exported: boolean;
      score: number;
    };

// How many hits are worth showing. A query that broad is the rail's job.
export const SEARCH_LIMIT = 20;

export function searchAnalysis(
  files: readonly ParsedFile[],
  symbols: readonly ParsedSymbol[],
  rawQuery: string,
): SearchHit[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];

  const hits: SearchHit[] = [];
  for (const file of files) {
    const score = rank(file.path, query);
    if (score !== null) hits.push({ kind: "file", path: file.path, score });
  }
  for (const symbol of symbols) {
    const score = rank(symbol.name, query);
    if (score !== null) {
      hits.push({
        kind: "symbol",
        path: symbol.file,
        name: symbol.name,
        symbolKind: symbol.kind,
        line: symbol.line,
        exported: symbol.exported,
        score,
      });
    }
  }

  // Best match first; a symbol named for the query beats a file whose path
  // merely contains it; then alphabetical as the stable order.
  return hits
    .sort(
      (a, b) =>
        a.score - b.score ||
        (a.kind === "symbol" ? 0 : 1) - (b.kind === "symbol" ? 0 : 1) ||
        a.path.localeCompare(b.path) ||
        (a.kind === "symbol" && b.kind === "symbol" ? a.line - b.line : 0),
    )
    .slice(0, SEARCH_LIMIT);
}

// Exact is best, a prefix next, a substring anywhere last. Null: no match.
function rank(text: string, query: string): number | null {
  const lower = text.toLowerCase();
  if (lower === query) return 0;
  if (lower.startsWith(query)) return 1;
  return lower.includes(query) ? 2 : null;
}
