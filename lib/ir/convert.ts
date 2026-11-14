// Conversion between the parser's ParseResult and the canonical IR, and back.
//
// `toIr` is pure: it restructures what the parser produced and derives nothing
// the parser did not evidence. `project` is its exact inverse for every field
// the parser persists — the compatibility guarantee is `project(toIr(result))`
// deep-equals `result`, checked over the whole fixture corpus by
// scripts/test-ir.ts.
//
// Scope resolution. The parser emits symbols flat, with nesting encoded in the
// dotted qualified name ("UserRepo.save") and no container record. The IR
// rebuilds the parent chain from that name and resolves each ancestor's
// declaration kind by looking it up among the file's own symbols:
//
//   - an ancestor that exists and agrees on what it is is resolved;
//   - an ancestor that is absent from the file's symbols, or that several
//     disagreeing symbols answer to (legal in JS: `function f(){}` and
//     `var f;` share a name), is left `container: null` — the IR says
//     "unknown" rather than guessing.
//
// A function-kind symbol's own declaration kind follows its container: inside
// a class or an object literal it is a method; anywhere else (top-level,
// inside a function, container unknown) it stays a function. Both cases are
// extraction evidence, not inference:
//
//   - class parent: collectClassMembers (lib/parser/extract.ts) is the only
//     path that appends a class name to a parent chain, and it emits only
//     methods.
//   - variable parent: collectObjectMembers is the only path that appends a
//     variable's name to a parent chain, and it is gated on that variable's
//     initializer being an object literal. A function expression or arrow
//     assigned to a variable produces no function-kind symbol at all — only
//     the binding — so it can never be mistaken for a method. Verified
//     against a live parse 2026-11-12 (const/let function and arrow
//     assignments yield only compatKind const/let symbols).
//
// When a variable and a function share a name (legal JS redeclaration), the
// parent candidates disagree, the container resolves to null, and the child
// conservatively stays a function.

import { IR_VERSION, type DeclarationKind, type Ir, type IrFileCoverage, type IrSymbol, type ScopeSegment, type SymbolCompatKind } from "./types.ts";
import { detectLanguage, languageAdapter } from "./languages.ts";
import { SCHEMA_VERSION } from "../parser/types.ts";
import type { ParseResult, ParsedSymbol } from "../parser/types.ts";

/** The IR producer name recorded in every IR this module builds. */
export const IR_PRODUCER = "anatomy js/ts parser (ts-morph), via lib/ir";

/**
 * Converts a ParseResult into the canonical IR. The input must be a valid
 * ParseResult (the parser's own output always is; test inputs come through
 * the parser contract validator). The result is not validated here — pass it
 * through lib/ir/contract.ts when it crosses a boundary.
 *
 * File coverage (lib/ir/types.ts): one row per parsed file (complete) and per
 * skipped file (unavailable), with the language and adapter the registry
 * resolves for each path. Parser output is always validator-clean here —
 * every extension the walker accepts is registered, so every parsed row
 * resolves to a language with the JS/TS adapter. A hand-built ParseResult
 * whose parsed files carry unregistered extensions would produce a row the
 * validator rejects, loudly.
 */
export function toIr(result: ParseResult): Ir {
  return {
    irVersion: IR_VERSION,
    source: { producer: IR_PRODUCER, derivedFrom: { parserSchema: result.schemaVersion } },
    root: result.root,
    projects: result.projects,
    files: result.files,
    fileCoverage: deriveFileCoverage(result),
    symbols: resolveSymbols(result.symbols),
    relationships: result.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      typeOnly: edge.typeOnly,
      specifier: edge.specifier,
      line: edge.line,
    })),
    routes: result.routes,
    manifests: result.manifests,
    dependencies: result.dependencies,
    configReferences: result.configReferences,
    envDeclarations: result.envDeclarations,
    entryPoints: result.entryPoints,
    coverage: result.coverage,
    configs: result.configs,
    ...(result.nonCodeCandidates === undefined ? {} : { nonCodeCandidates: result.nonCodeCandidates }),
  };
}

/**
 * Reconstructs the ParseResult shape from an IR. For every field the parser
 * persists this is the exact inverse of `toIr`; IR-only structure (scopes,
 * declaration kinds, provenance, per-file coverage) is dropped. The input
 * must be a valid IR.
 */
export function project(ir: Ir): ParseResult {
  return {
    // validateIr guarantees parserSchema equals the parser contract version,
    // so this is the literal the ParseResult type demands.
    schemaVersion: ir.source.derivedFrom.parserSchema as typeof SCHEMA_VERSION,
    root: ir.root,
    projects: ir.projects,
    files: ir.files,
    edges: ir.relationships.map((r) => ({
      source: r.source,
      target: r.target,
      kind: r.kind,
      typeOnly: r.typeOnly,
      specifier: r.specifier,
      line: r.line,
    })),
    routes: ir.routes,
    symbols: ir.symbols.map(projectSymbol),
    manifests: ir.manifests,
    dependencies: ir.dependencies,
    configReferences: ir.configReferences,
    envDeclarations: ir.envDeclarations,
    entryPoints: ir.entryPoints,
    coverage: ir.coverage,
    configs: ir.configs,
    ...(ir.nonCodeCandidates === undefined ? {} : { nonCodeCandidates: ir.nonCodeCandidates }),
  };
}

function projectSymbol(symbol: IrSymbol): ParsedSymbol {
  const out: ParsedSymbol = {
    file: symbol.file,
    name: symbol.name,
    kind: symbol.compatKind,
    line: symbol.line,
    exported: symbol.exported,
  };
  if (symbol.endLine !== undefined) out.endLine = symbol.endLine;
  if (symbol.exportKind !== undefined) out.exportKind = symbol.exportKind;
  if (symbol.parameters !== undefined) out.parameters = symbol.parameters;
  if (symbol.returnType !== undefined) out.returnType = symbol.returnType;
  if (symbol.signature !== undefined) out.signature = symbol.signature;
  if (symbol.documentation !== undefined) out.documentation = symbol.documentation;
  if (symbol.isPublicApi !== undefined) out.isPublicApi = symbol.isPublicApi;
  return out;
}

// ---- Per-file coverage ----

/**
 * One coverage row per file the pipeline recorded: parsed files report
 * `complete`, skipped files `unavailable` (the reason itself stays in
 * `coverage.files.skippedFiles`). Language and adapter come from the
 * registry's pure path classification — no content is read, so derivation is
 * deterministic and O(1) per file.
 */
function deriveFileCoverage(result: ParseResult): IrFileCoverage[] {
  const rows: IrFileCoverage[] = [];
  for (const file of result.files) {
    const language = detectLanguage(file.path);
    rows.push({ path: file.path, language, adapter: languageAdapter(language), extraction: "complete" });
  }
  for (const skipped of result.coverage.files.skippedFiles) {
    const language = detectLanguage(skipped.path);
    rows.push({ path: skipped.path, language, adapter: languageAdapter(language), extraction: "unavailable" });
  }
  return rows;
}

// ---- Scope resolution ----

/** Groups symbols per file and resolves nesting, in one pass per file. */
function resolveSymbols(symbols: readonly ParsedSymbol[]): IrSymbol[] {
  const files = new Map<string, ParsedSymbol[]>();
  for (const symbol of symbols) {
    let group = files.get(symbol.file);
    if (!group) files.set(symbol.file, (group = []));
    group.push(symbol);
  }
  const out: IrSymbol[] = [];
  for (const [file, group] of files) out.push(...resolveFileSymbols(file, group));
  return out;
}

function resolveFileSymbols(file: string, group: readonly ParsedSymbol[]): IrSymbol[] {
  // Every qualified name in the file, including duplicates: overloads share a
  // name, and legal JS redeclarations share a name with disagreeing kinds.
  const byName = new Map<string, ParsedSymbol[]>();
  for (const symbol of group) {
    let list = byName.get(symbol.name);
    if (!list) byName.set(symbol.name, (list = []));
    list.push(symbol);
  }

  // Declaration kinds resolve innermost-last: a symbol's declaration follows
  // its container's, so symbols are resolved in order of scope depth.
  const byDepth = [...group].sort((a, b) => a.name.split(".").length - b.name.split(".").length);
  const declaration = new Map<ParsedSymbol, DeclarationKind>();
  for (const symbol of byDepth) declaration.set(symbol, deriveDeclaration(symbol, byName, declaration));

  return group.map((symbol) => toIrSymbol(file, symbol, byName, declaration));
}

function deriveDeclaration(
  symbol: ParsedSymbol,
  byName: ReadonlyMap<string, ParsedSymbol[]>,
  declaration: ReadonlyMap<ParsedSymbol, DeclarationKind>,
): DeclarationKind {
  switch (symbol.kind) {
    case "class":
      return "class";
    case "interface":
      return "interface";
    case "type":
      return "type-alias";
    case "enum":
      return "enum";
    case "namespace":
      return "namespace";
    case "const":
    case "let":
    case "var":
      return "variable";
    case "function": {
      const parent = containerDeclaration(symbol, byName, declaration);
      return parent === "class" || parent === "variable" ? "method" : "function";
    }
  }
}

/**
 * The resolved declaration of the symbol's immediate parent, or null when the
 * parent is absent from the file's symbols or ambiguous. Recursion is safe:
 * a parent always has a strictly shorter qualified name, so it is already
 * resolved when its child asks.
 *
 * Name-based lookup is sound here because qualified names are built by the
 * parser's own parent chains, which never cross scope boundaries: a nested
 * function's name carries every enclosing declaration, so two same-named
 * declarations in different scopes produce different qualified names. A bare
 * name collision among candidates can only come from top-level JS
 * redeclaration, which is exactly the ambiguity this null records.
 */
function containerDeclaration(
  symbol: ParsedSymbol,
  byName: ReadonlyMap<string, ParsedSymbol[]>,
  declaration: ReadonlyMap<ParsedSymbol, DeclarationKind>,
): DeclarationKind | null {
  const segments = symbol.name.split(".");
  if (segments.length === 1) return null;
  const candidates = byName.get(segments.slice(0, -1).join(".")) ?? [];
  if (candidates.length === 0) return null;
  const resolved = new Set(candidates.map((candidate) => declaration.get(candidate)));
  return resolved.size === 1 ? (resolved.values().next().value ?? null) : null;
}

function toIrSymbol(
  file: string,
  symbol: ParsedSymbol,
  byName: ReadonlyMap<string, ParsedSymbol[]>,
  declaration: ReadonlyMap<ParsedSymbol, DeclarationKind>,
): IrSymbol {
  const segments = symbol.name.split(".");
  const scope: ScopeSegment[] = [];
  for (let i = 1; i < segments.length; i += 1) {
    const candidates = byName.get(segments.slice(0, i).join(".")) ?? [];
    scope.push({ name: segments[i - 1], container: resolveContainer(candidates, declaration) });
  }
  const ir: IrSymbol = {
    file,
    name: symbol.name,
    leafName: segments[segments.length - 1],
    compatKind: symbol.kind,
    declaration: declaration.get(symbol) ?? "function",
    scope,
    line: symbol.line,
    exported: symbol.exported,
  };
  if (symbol.endLine !== undefined) ir.endLine = symbol.endLine;
  if (symbol.exportKind !== undefined) ir.exportKind = symbol.exportKind;
  if (symbol.parameters !== undefined) ir.parameters = symbol.parameters;
  if (symbol.returnType !== undefined) ir.returnType = symbol.returnType;
  if (symbol.signature !== undefined) ir.signature = symbol.signature;
  if (symbol.documentation !== undefined) ir.documentation = symbol.documentation;
  if (symbol.isPublicApi !== undefined) ir.isPublicApi = symbol.isPublicApi;
  return ir;
}

function resolveContainer(
  candidates: readonly ParsedSymbol[],
  declaration: ReadonlyMap<ParsedSymbol, DeclarationKind>,
): ScopeSegment["container"] {
  if (candidates.length === 0) return null;
  const declarations = new Set(candidates.map((candidate) => declaration.get(candidate)));
  const kinds = new Set<SymbolCompatKind>(candidates.map((candidate) => candidate.kind));
  if (declarations.size !== 1 || kinds.size !== 1) return null;
  return { declaration: declarations.values().next().value ?? "function", compatKind: kinds.values().next().value ?? "function" };
}
