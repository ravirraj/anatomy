// Verifies symbol extraction and its place in the parser contract: the
// declarations a file makes are read from its syntax, and a symbol naming a
// file that isn't in the output is refused.
//
//   node scripts/test-symbols.ts

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Project } from "ts-morph";
import { extractSymbols } from "../lib/parser/extract.ts";
import { deserializeParseResult, serializeParseResult } from "../lib/parser/contract.ts";
import { parseRepository } from "../lib/parser/index.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

function symbolsOf(source: string) {
  const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true, compilerOptions: { allowJs: true, noLib: true, noResolve: true, types: [] } });
  return extractSymbols(project.createSourceFile("fixture.ts", source));
}

{
  const found = symbolsOf([
    "export function alpha() {}",
    "function helper() {}",
    "export class Widget {}",
    "export interface Shape {",
    "  area(): number;",
    "}",
    "export type Kind = 'a' | 'b';",
    "export enum Tone { up, down }",
    "export namespace area { export const pi = 3; }",
    "export const limit = 10;",
    "const hidden = true;",
    "export let counter = 0;",
    "var legacy = null;",
    "export const { a, b: c } = { a: 1, b: 2 };",
    "export default function main() {}",
  ].join("\n"));

  const byName = new Map(found.map((s) => [s.name, s]));
  const expect = (name: string, kind: string, exported: boolean) => {
    const s = byName.get(name);
    if (s && s.kind === kind && s.exported === exported) pass(`${name} is an ${exported ? "exported " : ""}${kind}`);
    else fail(`${name}: expected exported ${kind}, got ${JSON.stringify(s)}`);
  };
  expect("alpha", "function", true);
  expect("helper", "function", false);
  expect("Widget", "class", true);
  expect("Shape", "interface", true);
  expect("Kind", "type", true);
  expect("Tone", "enum", true);
  expect("area", "namespace", true);
  expect("limit", "const", true);
  expect("hidden", "const", false);
  expect("counter", "let", true);
  expect("legacy", "var", false);
  expect("a", "const", true);
  expect("c", "const", true);
  expect("default", "function", true);

  const lines = found.map((s) => s.line);
  if (lines.every((l, i) => i === 0 || l >= lines[i - 1])) pass("symbols come out in source order");
  else fail(`symbols out of order: ${JSON.stringify(lines)}`);
}

{
  // A non-declaration file has no symbols: imports and plain statements
  // aren't declarations.
  const found = symbolsOf("import { x } from './x';\nsideEffect();\n");
  if (found.length === 0) pass("imports and calls make no symbols");
  else fail(`unexpected symbols: ${JSON.stringify(found)}`);
}

{
  // End to end: a tiny repository parses, its symbols land in the result, and
  // the contract round-trip keeps them.
  const dir = mkdtempSync(path.join(tmpdir(), "anatomy-symbols-"));
  try {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
    writeFileSync(path.join(dir, "util.ts"), "export function shared() {}\nconst internal = 1;\n");
    mkdirSync(path.join(dir, "lib"));
    writeFileSync(path.join(dir, "lib", "main.ts"), "import { shared } from '../util';\nexport const start = () => shared();\n");

    const result = parseRepository(dir);
    const util = result.symbols.filter((s) => s.file === "util.ts");
    const main = result.symbols.filter((s) => s.file === "lib/main.ts");
    if (util.length === 2 && util.some((s) => s.name === "shared" && s.exported) && util.some((s) => s.name === "internal" && !s.exported)) {
      pass("a parsed repository's symbols name what it declares");
    } else {
      fail(`util.ts symbols wrong: ${JSON.stringify(util)}`);
    }
    if (main.length === 1 && main[0].name === "start" && main[0].kind === "const") {
      pass("lib/main.ts declares start");
    } else {
      fail(`lib/main.ts symbols wrong: ${JSON.stringify(main)}`);
    }

    const round = deserializeParseResult(serializeParseResult(result));
    if (round.symbols.length === result.symbols.length) pass("the contract round-trip keeps every symbol");
    else fail(`round-trip lost symbols: ${round.symbols.length} of ${result.symbols.length}`);

    // A symbol naming a file that isn't in the output is refused by field.
    const broken = JSON.parse(serializeParseResult(result));
    broken.symbols[0].file = "no-such-file.ts";
    let refused = false;
    try {
      deserializeParseResult(JSON.stringify(broken));
    } catch (error) {
      refused = String((error as Error).message).includes("no-such-file.ts");
    }
    if (refused) pass("a symbol on a missing file is refused");
    else fail("a symbol on a missing file wasn't refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("");
for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

// A module, so the awaits above are allowed.
export {};
