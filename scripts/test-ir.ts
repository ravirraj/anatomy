// Phase 5 Batch 1: canonical IR contract tests.
//
// Proves, over the whole fixture corpus, that the existing JS/TS parser
// produces the canonical IR losslessly: convert → validate → project back →
// strict deep-equality against the parser's own output, field by field, with
// no ignore lists. Plus structural scope tests on real parses, negative
// validator tests, and a deterministic conversion budget.

import { readdirSync } from "node:fs";
import path from "node:path";
import { parseRepository } from "../lib/parser/index.ts";
import type { ParseResult, ParsedSymbol } from "../lib/parser/types.ts";
import { IR_PRODUCER, project, toIr } from "../lib/ir/convert.ts";
import { IrContractError, validateIr } from "../lib/ir/contract.ts";
import { DECLARATION_KINDS, IR_VERSION, RELATIONSHIP_KINDS, type Ir, type IrSymbol } from "../lib/ir/types.ts";
import { FIXTURES } from "./test-fixtures-shared.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

// Deterministic conversion budget: total parsed elements the corpus converts.
// Measured 2026-11-12 over all 14 fixtures: 376 elements, 361 ms. The element
// budget keeps ~2x headroom and catches accidental blow-up (duplicated
// content, quadratic copying) without any wall-clock assertion; the wall-clock
// bound below is a generous smoke bound only.
const CORPUS_ELEMENT_BUDGET = 800;
const CORPUS_WALL_CLOCK_BUDGET_MS = 60_000;

// ---- Strict deep equality: undefined-valued keys count as absent ----

type Diff = { path: string; expected: string; actual: string } | null;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

function deepEqual(expected: unknown, actual: unknown, at: string): Diff {
  if (expected === actual) return null;
  const e = canonical(expected);
  const a = canonical(actual);
  if (e === a) return null;
  if (typeof e !== "object" || e === null || typeof a !== "object" || a === null || Array.isArray(e) !== Array.isArray(a)) {
    return { path: at, expected: JSON.stringify(expected), actual: JSON.stringify(actual) };
  }
  const keys = new Set([...Object.keys(e as object), ...Object.keys(a as object)]);
  for (const key of keys) {
    const diff = deepEqual((e as Record<string, unknown>)[key], (a as Record<string, unknown>)[key], `${at}.${key}`);
    if (diff) return diff;
  }
  return null;
}

function expect(diff: Diff, what: string): void {
  if (!diff) pass(what);
  else fail(`${what}: at ${diff.path} expected ${diff.expected}, got ${diff.actual}`);
}

function throws(fn: () => unknown, what: string, match: string): void {
  try {
    fn();
    fail(`${what}: expected a rejection containing ${JSON.stringify(match)}, got none`);
  } catch (error) {
    if (error instanceof IrContractError && error.message.includes(match)) pass(what);
    else fail(`${what}: wrong rejection: ${String(error)}`);
  }
}

const symbolsNamed = (ir: Ir, name: string): IrSymbol[] => ir.symbols.filter((s) => s.name === name);

// ---- Section 1: fixture equivalence (convert → validate → project → deep-equal) ----

console.log("=== 1. Fixture equivalence (every fixture, every persisted field) ===");

const fixtureNames = readdirSync(FIXTURES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const corpus = new Map<string, { result: ParseResult; ir: Ir }>();
let corpusElements = 0;
const corpusStart = Date.now();

for (const name of fixtureNames) {
  const result = parseRepository(path.join(FIXTURES, name, "repo"));
  const ir = validateIr(toIr(result));
  corpus.set(name, { result, ir });

  // Every IR collection must hold exactly the parser's elements — conversion
  // is O(n) with no duplication, so the element counts are the budget.
  const counts: [string, number, number][] = [
    ["files", result.files.length, ir.files.length],
    ["edges", result.edges.length, ir.relationships.length],
    ["symbols", result.symbols.length, ir.symbols.length],
    ["routes", result.routes.length, ir.routes.length],
    ["manifests", result.manifests.length, ir.manifests.length],
    ["dependencies", result.dependencies.length, ir.dependencies.length],
    ["configReferences", result.configReferences.length, ir.configReferences.length],
    ["envDeclarations", result.envDeclarations.length, ir.envDeclarations.length],
    ["entryPoints", result.entryPoints.length, ir.entryPoints.length],
    ["configs", result.configs.length, ir.configs.length],
    ["nonCodeCandidates", result.nonCodeCandidates?.length ?? 0, ir.nonCodeCandidates?.length ?? 0],
  ];
  const mismatch = counts.find(([, parser, canonical]) => parser !== canonical);
  if (mismatch) fail(`${name}: ${mismatch[0]} count ${mismatch[1]} became ${mismatch[2]}`);
  corpusElements += counts.reduce((sum, [, parser]) => sum + parser, 0);

  expect(deepEqual(result, project(ir), "$"), `${name}: full round-trip equality (${result.files.length} files, ${result.edges.length} edges, ${result.symbols.length} symbols, ${result.routes.length} routes)`);
}

// ---- Section 2: provenance on every IR ----

console.log("=== 2. Provenance and version on every IR ===");

let provenanceBad = 0;
for (const { ir } of corpus.values()) {
  if (ir.irVersion !== IR_VERSION || ir.source.producer !== IR_PRODUCER || ir.source.derivedFrom.parserSchema !== 7) provenanceBad += 1;
}
if (provenanceBad === 0) pass(`all ${corpus.size} IRs carry irVersion ${IR_VERSION}, producer and parser schema 7`);
else fail(`${provenanceBad} IRs have broken provenance`);
if ((DECLARATION_KINDS as readonly string[]).includes("method") && (DECLARATION_KINDS as readonly string[]).includes("variable") && (DECLARATION_KINDS as readonly string[]).includes("function")) {
  pass("declaration registry separates method/variable/function from the persisted lexicon");
} else {
  fail("declaration registry is missing the conflation guards");
}

// ---- Section 3: structure on real parses (methods, nesting, qualified names) ----

console.log("=== 3. Scope structure on the class-methods fixture ===");

const classMethods = corpus.get("class-methods");
if (!classMethods) fail("class-methods fixture missing");
else {
  const { ir } = classMethods;

  // A class method: identifiable as a method even though the persisted kind is "function".
  const verify = symbolsNamed(ir, "AuthService.verify");
  if (verify.length === 1) {
    const s = verify[0];
    if (s.compatKind === "function" && s.declaration === "method") pass("AuthService.verify is declaration \"method\" while compatKind stays \"function\"");
    else fail(`AuthService.verify: compatKind ${s.compatKind}, declaration ${s.declaration}`);
    const container = s.scope[0]?.container;
    if (s.scope.length === 1 && s.scope[0].name === "AuthService" && container?.declaration === "class" && container.compatKind === "class") {
      pass("AuthService.verify sits in class scope AuthService(class)");
    } else {
      fail(`AuthService.verify: unexpected scope ${JSON.stringify(s.scope)}`);
    }
  } else fail(`AuthService.verify: expected exactly one symbol, got ${verify.length}`);

  // A nested function inside a top-level function: outerFunction.innerFunction.
  const inner = symbolsNamed(ir, "outerFunction.innerFunction");
  if (inner.length === 1 && inner[0].declaration === "function" && inner[0].scope.length === 1 && inner[0].scope[0].name === "outerFunction" && inner[0].scope[0].container?.declaration === "function") {
    pass("outerFunction.innerFunction is a function nested in function scope");
  } else fail(`outerFunction.innerFunction: unexpected shape ${JSON.stringify(inner[0]?.scope)}`);

  // Three-deep nesting through a method: PaymentService.process.validate.
  const validate = symbolsNamed(ir, "PaymentService.process.validate");
  if (validate.length === 1 && validate[0].leafName === "validate" && validate[0].declaration === "function" && validate[0].scope.length === 2 && validate[0].scope[0].name === "PaymentService" && validate[0].scope[1].name === "process") {
    pass("PaymentService.process.validate decomposes into a 2-segment scope with leaf \"validate\"");
  } else fail(`PaymentService.process.validate: unexpected shape ${JSON.stringify(validate[0]?.scope)}`);

  // An object-literal member: a method whose container is a variable.
  const register = symbolsNamed(ir, "registry.register");
  if (register.length === 1 && register[0].declaration === "method" && register[0].scope[0]?.container?.declaration === "variable" && register[0].scope[0]?.container?.compatKind === "const") {
    pass("registry.register is a method on object scope registry(const)");
  } else fail(`registry.register: unexpected shape ${JSON.stringify(register[0]?.scope)}`);

  // Overloads share a qualified name and resolve to the same container.
  const save = symbolsNamed(ir, "Store.save");
  if (save.length >= 2 && save.every((s) => s.declaration === "method" && s.scope[0]?.container?.declaration === "class")) {
    pass(`Store.save: ${save.length} overload entries share one resolved class container`);
  } else fail(`Store.save: unexpected overload resolution (${save.length} symbols)`);

  // A top-level exported function keeps the flat shape.
  const run = symbolsNamed(ir, "run");
  if (run.length === 1 && run[0].declaration === "function" && run[0].scope.length === 0 && run[0].exported && run[0].exportKind === "named") {
    pass("run is a top-level named-export function with empty scope");
  } else fail("run: unexpected shape");

  // Corpus-wide: every symbol's scope decomposes exactly into its name.
  let scopeBad = 0;
  for (const { ir: candidate } of corpus.values()) {
    for (const s of candidate.symbols) {
      const segments = s.name.split(".");
      if (s.leafName !== segments[segments.length - 1] || s.scope.length !== segments.length - 1 || s.scope.some((seg, i) => seg.name !== segments[i])) scopeBad += 1;
    }
  }
  if (scopeBad === 0) pass("every symbol in the corpus decomposes name = scope segments + leafName");
  else fail(`${scopeBad} symbols have inconsistent scope decomposition`);

  // Corpus-wide: a function-kind symbol in class or object scope is a method.
  let methodBad = 0;
  for (const { ir: candidate } of corpus.values()) {
    for (const s of candidate.symbols) {
      if (s.compatKind !== "function") continue;
      const container = s.scope.length === 0 ? null : (s.scope[s.scope.length - 1]?.container ?? null);
      const expected = container === null || container.declaration === "function" || container.declaration === "method" ? "function" : "method";
      if (s.declaration !== expected) methodBad += 1;
    }
  }
  if (methodBad === 0) pass("every function-kind symbol's declaration agrees with its resolved container");
  else fail(`${methodBad} function-kind symbols disagree with their container`);
}

// ---- Section 4: import / export / re-export preservation ----

console.log("=== 4. Relationship preservation ===");

const barrel = corpus.get("barrel-index");
if (!barrel) fail("barrel-index fixture missing");
else {
  const parserReExports = barrel.result.edges.filter((e) => e.kind === "re-export");
  const irReExports = barrel.ir.relationships.filter((r) => r.kind === "re-export");
  if (parserReExports.length > 0 && parserReExports.length === irReExports.length) {
    pass(`barrel-index: ${irReExports.length} re-export relationships preserved`);
  } else fail(`barrel-index: re-export count ${parserReExports.length} vs ${irReExports.length}`);
  const unknownKinds = barrel.ir.relationships.filter((r) => !(RELATIONSHIP_KINDS as readonly string[]).includes(r.kind));
  if (unknownKinds.length === 0) pass("barrel-index: every relationship kind is in the registry");
  else fail(`${unknownKinds.length} relationships have unregistered kinds`);
}
const polyglot = corpus.get("polyglot-manifests");
if (!polyglot) fail("polyglot-manifests fixture missing");
else {
  const ecosystems = new Set(polyglot.ir.manifests.map((m) => m.ecosystem));
  if (ecosystems.size >= 2) pass(`polyglot-manifests: ${ecosystems.size} ecosystems carried verbatim (${[...ecosystems].sort().join(", ")})`);
  else fail(`polyglot-manifests: expected several ecosystems, got ${ecosystems.size}`);
}

// ---- Section 5: validator negative tests ----

console.log("=== 5. Validator negative tests ===");

const baseResult = parseRepository(path.join(FIXTURES, "class-methods", "repo"));
const baseIr = validateIr(toIr(baseResult));
// A symbol with a non-empty scope, for scope-structure mutations.
const scopedName = baseIr.symbols.find((s) => s.scope.length > 0)!.name;
// A fixture with entry points, for the resolved/unresolved contradiction.
const entryBase = validateIr(toIr(parseRepository(path.join(FIXTURES, "express-routes", "repo"))));
// A fixture with relationships, for relationship mutations (class-methods has none).
const edgeBase = validateIr(toIr(parseRepository(path.join(FIXTURES, "barrel-index", "repo"))));

const mutate = (fn: (ir: Ir) => void): Ir => {
  const clone = JSON.parse(JSON.stringify(baseIr)) as Ir;
  fn(clone);
  return clone;
};
const scoped = (ir: Ir) => ir.symbols.find((s) => s.name === scopedName)!;

throws(() => validateIr(mutate((ir) => { ir.irVersion = 2 as typeof IR_VERSION; })), "unsupported IR version is rejected", "unsupported IR version");
throws(() => validateIr(mutate((ir) => { ir.source.derivedFrom.parserSchema = 8; })), "unsupported parser schema is rejected", "unsupported parser schema");
throws(() => validateIr(mutate((ir) => { delete (ir as unknown as Record<string, unknown>).source; })), "missing provenance is rejected", "$.source");
throws(() => validateIr(mutate((ir) => { ir.source.producer = ""; })), "empty producer is rejected", "producer");
throws(() => validateIr(mutate((ir) => { ir.symbols[0].declaration = "struct" as never; })), "unknown declaration kind is rejected", "declaration");
throws(() => validateIr(mutate((ir) => { ir.symbols[0].compatKind = "method" as never; })), "unknown compatibility kind is rejected", "compatKind");
throws(() => validateIr((() => {
  const clone = JSON.parse(JSON.stringify(edgeBase)) as Ir;
  clone.relationships[0].kind = "extends" as never;
  return clone;
})()), "unknown relationship kind is rejected", "kind");
throws(() => validateIr(mutate((ir) => { scoped(ir).scope = []; })), "scope that does not decompose the name is rejected", "scope");
throws(() => validateIr(mutate((ir) => { scoped(ir).leafName = "wrong"; })), "leafName mismatch is rejected", "leafName");
throws(() => validateIr(mutate((ir) => { scoped(ir).scope[0].name = "wrong"; })), "scope segment mismatch is rejected", "scope[0].name");
throws(() => validateIr(mutate((ir) => { ir.symbols[0].name = "bad-name.x"; })), "non-identifier name segment is rejected", "identifier");
throws(() => validateIr(mutate((ir) => { ir.symbols[0].file = "no/such/file.ts"; })), "symbol in a missing file is rejected", "not a file in the IR");
throws(() => validateIr(mutate((ir) => { (ir.symbols[0] as IrSymbol).extensions = { TS: { visibility: "private" } }; })), "uppercase extension namespace is rejected", "lowercase slugs");
throws(() => validateIr(mutate((ir) => { (ir.symbols[0] as IrSymbol).extensions = { ir: { note: 1 } }; })), "reserved extension namespace is rejected", "reserved");
throws(() => validateIr(mutate((ir) => { (ir.symbols[0] as IrSymbol).extensions = { ts: { bad: Number.NaN } }; })), "non-finite extension value is rejected", "finite");
throws(() => validateIr(mutate((ir) => { ir.coverage.files.found += 1; })), "broken coverage invariant is rejected", "found");
throws(() => validateIr((() => {
  const clone = JSON.parse(JSON.stringify(entryBase)) as Ir;
  const entry = clone.entryPoints[0];
  if (entry.resolved) entry.unresolvedReason = "not-found";
  else entry.resolved = true;
  return clone;
})()), "entry-point resolved contradiction is rejected", "entry point");
throws(() => validateIr(mutate((ir) => { ir.projects[0].path = "/elsewhere"; })), "root-not-first project is rejected", "root must be the first project");

// A controlled extension is accepted when it follows the rules.
{
  const clone = JSON.parse(JSON.stringify(baseIr)) as Ir;
  clone.symbols[0].extensions = { ts: { visibility: "private", flags: ["static"], depth: 2, note: null } };
  try {
    validateIr(clone);
    pass("well-formed extension metadata is accepted");
  } catch (error) {
    fail(`well-formed extension metadata rejected: ${String(error)}`);
  }
}

// ---- Section 6: serialization round-trip ----

console.log("=== 6. JSON serialization round-trip ===");

for (const name of ["class-methods", "polyglot-manifests", "express-routes"]) {
  const entry = corpus.get(name);
  if (!entry) {
    fail(`${name} fixture missing`);
    continue;
  }
  const ir = entry.ir;
  const revived = validateIr(JSON.parse(JSON.stringify(ir)) as Ir);
  expect(deepEqual(entry.result, project(revived), "$"), `${name}: JSON round-trip preserves every persisted field`);
}

// ---- Section 7: conversion budget ----

console.log("=== 7. Conversion budget ===");

const elapsed = Date.now() - corpusStart;
if (corpusElements <= CORPUS_ELEMENT_BUDGET) pass(`corpus converts ${corpusElements} elements, within the deterministic budget ${CORPUS_ELEMENT_BUDGET}`);
else fail(`corpus elements ${corpusElements} exceed the budget ${CORPUS_ELEMENT_BUDGET}`);
if (elapsed <= CORPUS_WALL_CLOCK_BUDGET_MS) pass(`corpus conversion took ${elapsed}ms (generous smoke bound ${CORPUS_WALL_CLOCK_BUDGET_MS}ms, not a precision assertion)`);
else fail(`corpus conversion took ${elapsed}ms, over the smoke bound ${CORPUS_WALL_CLOCK_BUDGET_MS}ms`);

// ---- Section 8: declaration-kind classification (synthetic ParseResults) ----
//
// Unit-level pins for every inference rule, built on minimal contract-valid
// ParseResults so the rules are tested directly, not only through the
// fixtures. Grounded in the audited extraction paths of lib/parser/extract.ts.

console.log("=== 8. Declaration-kind classification (synthetic ParseResults) ===");

const zeroCounts = { seen: 0, internal: 0, external: 0, excluded: 0, unresolved: 0 };

const syntheticResult = (symbols: ParsedSymbol[]): ParseResult => ({
  schemaVersion: 7,
  root: ".",
  projects: [{ path: ".", adapter: "none" }],
  files: [{ path: "src/a.ts", module: "src", lines: 40, bytes: 800, hash: "hash", fanIn: 0, fanOut: 0, reachedBy: null, role: null, exports: [] }],
  edges: [],
  routes: [],
  symbols,
  manifests: [],
  dependencies: [],
  configReferences: [],
  envDeclarations: [],
  entryPoints: [],
  coverage: {
    files: { found: 1, parsed: 1, skipped: 0, skippedFiles: [], excludedDirectories: [] },
    imports: {
      total: zeroCounts,
      byKind: { import: zeroCounts, "re-export": zeroCounts, "dynamic-import": zeroCounts, require: zeroCounts, call: zeroCounts },
      external: { package: 0, builtin: 0, "outside-root": 0 },
      excluded: {},
      unresolvedByReason: {},
      unresolved: [],
    },
    routes: { omitted: [], withheld: [] },
    calls: { total: 0, resolved: 0, unresolved: 0, unresolvedCalls: [] },
  },
  configs: [],
  nonCodeCandidates: [],
});

const sym = (over: Partial<ParsedSymbol> & Pick<ParsedSymbol, "name" | "kind" | "line">): ParsedSymbol => ({
  file: "src/a.ts",
  exported: false,
  exportKind: "none",
  endLine: over.line,
  ...over,
});

const classify = (symbols: ParsedSymbol[]) => validateIr(toIr(syntheticResult(symbols)));

// Function expressions and arrows assigned to variables: the parser emits
// only the binding, so these are variables and can never become methods.
{
  const ir = classify([
    sym({ name: "handler", kind: "const", line: 1 }),
    sym({ name: "arrow", kind: "const", line: 5 }),
    sym({ name: "lazy", kind: "let", line: 9 }),
  ]);
  const bad = ir.symbols.filter((s) => s.declaration !== "variable" || s.scope.length !== 0);
  if (bad.length === 0 && ir.symbols.every((s) => s.compatKind === "const" || s.compatKind === "let")) {
    pass("function/arrow expressions assigned to variables classify as variable, never method");
  } else {
    fail(`variable assignments misclassified: ${JSON.stringify(bad.map((s) => [s.name, s.declaration]))}`);
  }
}

// Binding kinds survive verbatim as compatibility kinds.
{
  const s = classify([sym({ name: "count", kind: "var", line: 1 })]).symbols[0];
  if (s.declaration === "variable" && s.compatKind === "var") pass("a var binding is declaration variable with compatKind var preserved");
  else fail(`var binding: declaration ${s.declaration}, compatKind ${s.compatKind}`);
}

// Object-literal members are methods on a variable container.
{
  const ir = classify([
    sym({ name: "registry", kind: "var", line: 1 }),
    sym({ name: "registry.register", kind: "function", line: 2 }),
  ]);
  const s = ir.symbols.find((x) => x.name === "registry.register")!;
  const container = s.scope[0]?.container;
  if (s.declaration === "method" && s.compatKind === "function" && container?.declaration === "variable" && container.compatKind === "var") {
    pass("an object-literal member on a var is a method with a variable container");
  } else {
    fail(`registry.register: declaration ${s.declaration}, container ${JSON.stringify(container)}`);
  }
}

// A variable and a function sharing one name (legal JS redeclaration):
// disagreeing parent candidates resolve conservatively.
{
  const ir = classify([
    sym({ name: "dual", kind: "var", line: 1 }),
    sym({ name: "dual", kind: "function", line: 6 }),
    sym({ name: "dual.ping", kind: "function", line: 2 }),
  ]);
  const s = ir.symbols.find((x) => x.name === "dual.ping")!;
  if (s.declaration === "function" && s.scope[0]?.container === null) {
    pass("disagreeing parent candidates (var + function of one name) stay function with an unknown container");
  } else {
    fail(`dual.ping: declaration ${s.declaration}, container ${JSON.stringify(s.scope[0]?.container)}`);
  }
}

// Nesting through a method: the method stays a method, the inner function
// stays a function, and optional fields keep their presence.
{
  const symbols = [
    sym({ name: "C", kind: "class", line: 1, exported: true, exportKind: "named" }),
    sym({ name: "C.m", kind: "function", line: 2 }),
    sym({
      name: "C.m.inner",
      kind: "function",
      line: 3,
      parameters: [{ name: "x", type: "number" }],
      returnType: "boolean",
      signature: "inner(x: number): boolean",
      documentation: "doc",
    }),
  ];
  const ir = classify(symbols);
  const m = ir.symbols.find((x) => x.name === "C.m")!;
  const inner = ir.symbols.find((x) => x.name === "C.m.inner")!;
  if (m.declaration === "method" && inner.declaration === "function" && inner.scope[1]?.container?.declaration === "method") {
    pass("a function nested in a method stays function while the method stays method");
  } else {
    fail(`C.m / C.m.inner: ${m.declaration} / ${inner.declaration}`);
  }
  expect(deepEqual(syntheticResult(symbols), project(ir), "$"), "synthetic ParseResult with optional-field variety round-trips exactly");
}

// The deprecated isPublicApi field round-trips verbatim when present.
{
  const result = syntheticResult([sym({ name: "pub", kind: "function", line: 1, isPublicApi: true })]);
  expect(deepEqual(result, project(validateIr(toIr(result))), "$"), "isPublicApi passthrough round-trips verbatim");
}

// ---- Summary ----

console.log(`\n${results.join("\n")}`);
const failedCount = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\nIR contract tests: ${results.filter((r) => r.startsWith("ok")).length} passed, ${failedCount} failed`);
if (failedCount > 0) process.exitCode = 1;
