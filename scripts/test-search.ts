// Verifies search over an analysis: file paths and symbol names, ranked and
// limited, entirely from the data the map already holds.
//
//   node scripts/test-search.ts

import { searchAnalysis, SEARCH_LIMIT } from "../lib/graph/search.ts";
import type { ParsedFile, ParsedSymbol } from "../lib/parser/types.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

const file = (path: string): ParsedFile => ({
  path,
  module: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".",
  lines: 10,
  bytes: 100,
  hash: "hash",
  fanIn: 0,
  fanOut: 0,
  reachedBy: null,
  role: null,
  exports: [],
});

const symbol = (file: string, name: string, kind: ParsedSymbol["kind"] = "function", line = 1, exported = true): ParsedSymbol => ({
  file,
  name,
  kind,
  line,
  exported,
});

const files = [file("lib/auth.ts"), file("lib/auth/session.ts"), file("components/reauthorize.tsx"), file("app/start/page.tsx"), file("lib/authenticate/handler.ts")];
const symbols = [
  symbol("lib/auth.ts", "authenticate"),
  symbol("lib/auth/session.ts", "revokeSession", "function", 12, false),
  symbol("components/reauthorize.tsx", "useAuth", "function", 4),
  symbol("app/start/page.tsx", "default", "function", 1),
];

{
  const hits = searchAnalysis(files, symbols, "  ");
  if (hits.length === 0) pass("a blank query matches nothing");
  else fail(`a blank query matched ${JSON.stringify(hits)}`);
}

{
  const hits = searchAnalysis(files, symbols, "zzz");
  if (hits.length === 0) pass("a query nothing matches matches nothing");
  else fail(`zzz matched ${JSON.stringify(hits)}`);
}

{
  const hits = searchAnalysis(files, symbols, "AUTH");
  if (hits.every((h) => (h.kind === "file" ? h.path.toLowerCase().includes("auth") : h.name.toLowerCase().includes("auth")))) {
    pass("matching is case-insensitive over paths and names");
  } else {
    fail(`AUTH matched ${JSON.stringify(hits.map((h) => (h.kind === "file" ? h.path : h.name)))}`);
  }
}

{
  const hits = searchAnalysis(files, symbols, "useAuth");
  const first = hits[0];
  if (first?.kind === "symbol" && first.name === "useAuth" && first.symbolKind === "function" && first.path === "components/reauthorize.tsx" && first.line === 4) {
    pass("an exact symbol name is the best hit, with its kind, file and line");
  } else {
    fail(`useAuth's best hit was ${JSON.stringify(first)}`);
  }
}

{
  const hits = searchAnalysis(files, symbols, "auth");
  if (hits.some((h) => h.kind === "file" && h.path === "lib/auth.ts")) {
    pass("a path query finds the file");
  } else {
    fail(`auth didn't find lib/auth.ts: ${JSON.stringify(hits.map((h) => (h.kind === "file" ? h.path : h.name)))}`);
  }
  if (hits.some((h) => h.kind === "symbol" && h.name === "authenticate")) {
    pass("the same query also finds symbols whose names match");
  } else {
    fail("no symbol matched alongside the file");
  }
}

{
  // An exact symbol name beats a file whose path merely contains it.
  const hits = searchAnalysis(files, symbols, "authenticate");
  const exact = hits.findIndex((h) => h.kind === "symbol" && h.name === "authenticate");
  const contains = hits.findIndex((h) => h.kind === "file" && h.path === "lib/authenticate/handler.ts");
  if (exact !== -1 && contains !== -1 && exact < contains) {
    pass("an exact symbol name outranks a containing path");
  } else {
    fail(`ranking wrong: ${JSON.stringify(hits.map((h) => (h.kind === "file" ? h.path : h.name)))}`);
  }
}

{
  // On an equal score a symbol comes before a file.
  const hits = searchAnalysis(files, symbols, "session");
  const first = hits[0];
  if (first?.kind === "symbol" && first.name === "revokeSession") {
    pass("on a tie a symbol precedes a file");
  } else {
    fail(`session's best hit was ${JSON.stringify(first)}`);
  }
}

{
  // An internal symbol says so.
  const hits = searchAnalysis(files, symbols, "revoke");
  const hit = hits[0];
  if (hit?.kind === "symbol" && hit.exported === false) {
    pass("an unexported symbol is found and marked");
  } else {
    fail(`revoke's hit was ${JSON.stringify(hit)}`);
  }
}

{
  // The limit holds even when everything matches.
  const many = Array.from({ length: SEARCH_LIMIT + 10 }, (_, i) => file(`lib/generated-${i}.ts`));
  const hits = searchAnalysis(many, [], "generated-");
  if (hits.length === SEARCH_LIMIT) pass(`hits are capped at ${SEARCH_LIMIT}`);
  else fail(`got ${hits.length} hits for a query matching ${many.length} files`);
}

console.log("");
for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

// A module, so the awaits above are allowed.
export {};
