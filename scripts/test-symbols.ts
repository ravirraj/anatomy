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

// --- Phase 4 Batch 2: class methods, nested functions, qualified identities ---
{
  const found = symbolsOf([
    "class UserRepo {",
    "  save() {",
    "    return true;",
    "  }",
    "",
    "  findById(id: number) {",
    "    return id;",
    "  }",
    "}",
    "",
    "export class AuthService {",
    "  verify() {",
    "    return \"ok\";",
    "  }",
    "",
    "  revoke(token: string) {",
    "    return !token;",
    "  }",
    "}",
  ].join("\n"));

  const pick = (name: string) => found.filter((s) => s.name === name);
  const one = (name: string, kind: string, exported: boolean, line: number, endLine: number) => {
    const hits = pick(name);
    const s = hits[0];
    if (
      hits.length === 1 && s && s.kind === kind && s.exported === exported
      && s.line === line && s.endLine === endLine
    ) {
      pass(`${name} indexed once as ${exported ? "exported " : ""}${kind} at ${line}..${endLine}`);
    } else {
      fail(`${name}: expected one ${exported ? "exported " : ""}${kind} at ${line}..${endLine}, got ${JSON.stringify(hits)}`);
    }
  };

  one("UserRepo", "class", false, 1, 9);
  one("UserRepo.save", "function", false, 2, 4);
  one("UserRepo.findById", "function", false, 6, 8);
  one("AuthService", "class", true, 11, 19);
  one("AuthService.verify", "function", false, 12, 14);
  one("AuthService.revoke", "function", false, 16, 18);
  if (found.every((s) => ["function", "class"].includes(s.kind))) {
    pass("methods are stored under the schema's existing kinds (no kind outside SYMBOL_KINDS)");
  } else {
    fail(`unexpected kinds: ${JSON.stringify([...new Set(found.map((s) => s.kind))])}`);
  }
}

{
  const found = symbolsOf([
    "function outerFunction() {",
    "  function innerFunction() {",
    "    return true;",
    "  }",
    "",
    "  return innerFunction();",
    "}",
  ].join("\n"));
  const names = found.map((s) => s.name).sort();
  if (names.join("/") === "outerFunction/outerFunction.innerFunction") {
    pass("nested function is indexed with a qualified identity under its parent");
  } else {
    fail(`nested function extraction failed: ${JSON.stringify(names)}`);
  }
  const inner = found.find((s) => s.name === "outerFunction.innerFunction");
  if (inner && inner.line === 2 && inner.endLine === 4) {
    pass("nested function keeps accurate source position");
  } else {
    fail(`nested position wrong: ${JSON.stringify(inner)}`);
  }
}

{
  const found = symbolsOf([
    "class PaymentService {",
    "  process(amount: number) {",
    "    function validate() {",
    "      return amount > 0;",
    "    }",
    "",
    "    return validate();",
    "  }",
    "}",
  ].join("\n"));
  const names = found.map((s) => s.name).sort();
  if (names.join("/") === "PaymentService/PaymentService.process/PaymentService.process.validate") {
    pass("a nested function carries its full parent chain as a qualified identity");
  } else {
    fail(`qualified chain wrong: ${JSON.stringify(names)}`);
  }
  const nested = found.find((s) => s.name === "PaymentService.process.validate");
  const method = found.find((s) => s.name === "PaymentService.process");
  if (
    nested && method
    && nested.line === 3 && nested.endLine === 5
    && method.line === 2 && method.endLine === 8
  ) {
    pass("method and its nested function keep accurate, distinct source positions");
  } else {
    fail(`positions wrong: method=${JSON.stringify(method)} nested=${JSON.stringify(nested)}`);
  }
}

{
  const found = symbolsOf([
    "class UserService {",
    "  public validate() {",
    "    return true;",
    "  }",
    "",
    "  private normalize() {",
    "    return 1;",
    "  }",
    "",
    "  protected check() {",
    "    return 2;",
    "  }",
    "",
    "  static create() {",
    "    return new UserService();",
    "  }",
    "}",
  ].join("\n"));
  const methodNames = found.filter((s) => s.name.startsWith("UserService.")).map((s) => s.name).sort();
  if (methodNames.join("/") === "UserService.check/UserService.create/UserService.normalize/UserService.validate") {
    pass("modifier keywords (public/private/protected/static) never prevent extraction");
  } else {
    fail(`modified methods wrong: ${JSON.stringify(methodNames)}`);
  }
  const sig = found.find((s) => s.name === "UserService.create");
  if (sig && typeof sig.signature === "string" && sig.signature.startsWith("UserService.create(")) {
    pass("method signatures are recorded through the shared enrichment path");
  } else {
    fail(`signature wrong: ${JSON.stringify(sig)}`);
  }
}

{
  const found = symbolsOf([
    "export const registry = {",
    "  register() {",
    "    return true;",
    "  },",
    "",
    "  lookup: function (key: string) {",
    "    return key;",
    "  },",
    "",
    "  count: () => 0,",
    "};",
  ].join("\n"));
  const names = found.filter((s) => s.name.startsWith("registry.")).map((s) => s.name).sort();
  if (names.join("/") === "registry.count/registry.lookup/registry.register") {
    pass("object-literal methods (shorthand, function value, arrow value) are indexed");
  } else {
    fail(`object methods wrong: ${JSON.stringify(names)}`);
  }
  const reg = found.find((s) => s.name === "registry");
  const regMethod = found.find((s) => s.name === "registry.register");
  if (reg && reg.exported && regMethod && regMethod.exported === false && regMethod.exportKind === "none") {
    pass("object methods are members, not module exports: exported=false, exportKind=none");
  } else {
    fail(`object method export flags wrong: ${JSON.stringify(regMethod)} container=${JSON.stringify(reg)}`);
  }
}

{
  const found = symbolsOf([
    "class Store {",
    "  save(value: string): string;",
    "  save(value: number): number;",
    "  save(value: unknown) {",
    "    return value;",
    "  }",
    "}",
    "",
    "class Other {",
    "  save() {",
    "    return \"other\";",
    "  }",
    "}",
  ].join("\n"));
  const storeSaves = found.filter((s) => s.name === "Store.save").map((s) => s.line);
  if (storeSaves.join("/") === "2/3/4") {
    pass("overload signatures and implementation each keep a distinct, stable identity (name + line)");
  } else {
    fail(`overloads wrong: ${JSON.stringify(found.filter((s) => s.name.includes("save")))}`);
  }
  const other = found.find((s) => s.name === "Other.save");
  if (other && other.line === 10) {
    pass("same method name in a different class is a distinct qualified symbol");
  } else {
    fail(`same-name method collision: ${JSON.stringify(found.filter((s) => s.name === "Other.save"))}`);
  }
  const identity = new Set(found.map((s) => `${s.name}@${s.line}`));
  if (identity.size === found.length) {
    pass("no two symbols in one file share a (name, line) identity");
  } else {
    fail(`identity collision: ${found.length} symbols, ${identity.size} identities`);
  }
}

{
  const found = symbolsOf([
    "export async function load() {",
    "  const direct = await import(\"./lazy\");",
    "  return direct.go();",
    "}",
  ].join("\n"));
  if (found.every((s) => s.name !== "load.direct")) {
    pass("local const bindings inside a function stay out of the symbol list");
  } else {
    fail(`local bindings leaked into symbols: ${JSON.stringify(found.map((s) => s.name))}`);
  }
}

{
  const found = symbolsOf([
    "function first() {",
    "  function helper() {",
    "    return 1;",
    "  }",
    "  return helper();",
    "}",
    "",
    "function second() {",
    "  function helper() {",
    "    return 2;",
    "  }",
    "  return helper();",
    "}",
  ].join("\n"));
  const helpers = found.filter((s) => s.name.endsWith(".helper")).map((s) => s.name).sort();
  if (helpers.join("/") === "first.helper/second.helper") {
    pass("same-name nested functions in different parents stay distinct through the parent chain");
  } else {
    fail(`nested twins collapsed: ${JSON.stringify(found.map((s) => s.name))}`);
  }
}

console.log("");
for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

// A module, so the awaits above are allowed.
export {};