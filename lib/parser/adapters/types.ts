import type { SourceFile } from "ts-morph";
import type { Framework, Role } from "../../roles.ts";
import type { LanguageId } from "../../ir/languages.ts";
import type { ExternalKind, SymbolKind } from "../types.ts";

// Framework knowledge enters the parser only through this interface. The parser
// asks the adapter questions; it never checks which framework it is looking at.
//
// A project is the repository root or any folder holding a package.json, and
// each project gets its own adapter, so a Next.js example inside a repository
// that isn't Next.js still has its pages recognised. Every path an adapter is
// asked about is relative to its project, not the repository.

export type ProjectInfo = {
  /** Absolute path of the project folder. */
  dir: string;
  /** Every name in the project's dependencies and devDependencies. */
  dependencies: ReadonlySet<string>;
};

/** A file that parsed cleanly, with its syntax tree. */
export type AdapterFile = { path: string; source: SourceFile };

export type ProjectFiles = {
  files: readonly AdapterFile[];
  /** Code files in the project that were skipped, so their syntax is unknown. */
  unparsed: readonly string[];
};

export type AdapterRoute = { path: string; method: string; pattern: string; line: number };

export type RouteReport = {
  routes: AdapterRoute[];
  /** Something the syntax declares as a route, left out because its method or full pattern isn't written there. */
  omitted: { path: string; line: number; reason: string }[];
  /**
   * Set when something project-wide makes every pattern uncertain, such as a
   * prefix computed at runtime. Then no route is listed at all.
   */
  withheld: string | null;
};

export const NO_ROUTES: RouteReport = { routes: [], omitted: [], withheld: null };

export interface FrameworkAdapter {
  name: Framework;
  /** Whether this adapter applies to the project. */
  detect(project: ProjectInfo): boolean;
  /**
   * Called for each directory the walker is about to enter. Return a reason to
   * skip it, or null to walk it. Generic exclusions (node_modules,
   * dot-directories) are applied before this is asked.
   */
  excludeDirectory(projectRelativeDir: string): string | null;
  /**
   * How something other than an import reaches this file — the framework
   * routing to it, a tool loading it by name, a test runner collecting it — or
   * null when only imports would. Answered from the path alone, so it's a
   * convention the file sits in, never a guess about what it does.
   */
  reachedBy(projectRelativePath: string): string | null;
  /**
   * The file's role from a convention: where it sits, what it's named, or a
   * directive or syntax it contains. Null when none applies; the file stays
   * unclassified rather than getting the nearest fit.
   */
  roleOf(file: AdapterFile): Role | null;
  /** Routes whose method and full pattern are both written in the syntax. */
  routes(project: ProjectFiles): RouteReport;
}

// ---- FrameworkView (Phase 5 Batch 3.1) ----
//
// A language-neutral, framework-oriented view of one project's parsed files:
// the syntactic facts the framework adapters read, handed over without the
// language parser's own types. The JS/TS builder lives in view.ts; adapters
// keep their current interfaces this batch, so nothing consumes the view yet.
//
// What the view deliberately does NOT carry: source text, expression values
// (nothing is ever evaluated), raw AST nodes, CommonJS `module.exports`
// export forms, default exports, re-export declarations, `export =`, and any
// ParseResult or canonical-IR duplication. Adapter paths below are relative
// to the view's project; internal import targets are repository-relative,
// because that is the space every other fact in the pipeline speaks.
//
// Every argument, decorator argument and object-property value is a
// `ViewValue`: what the syntax writes, never what it computes. A value the
// syntax doesn't pin down is `kind: "other"` — unknown, but present.

export const FRAMEWORK_VIEW_VERSION = 1;

/**
 * A statically visible value: a string literal, an array of string literals,
 * an identifier binding (including a shorthand property, which binds the name
 * it is written as), a nested object literal, or anything else as `other`.
 * Recursive, with a depth cap in the builder so runaway nesting degrades to
 * `other` instead of unbounded work.
 */
export type ViewValue =
  | { kind: "string"; value: string }
  | { kind: "string-array"; values: readonly string[] }
  | { kind: "identifier"; name: string }
  | { kind: "object"; properties: readonly ViewProperty[] }
  | { kind: "other" };

/** One statically named property of an object literal. Spreads and computed keys are skipped, not guessed. */
export type ViewProperty = { name: string; value: ViewValue; line: number };

/** An argument in a call or a decorator. Same grammar as property values. */
export type ViewArgument = ViewValue;

/** Local binding name → name exported by the source module ("default" for a default or bare-require binding, "*" for a namespace). */
export type ViewImportBinding = { local: string; imported: string };

/**
 * Where an import resolves, from the parser's own resolver. Excluded and
 * unresolved outcomes lose their parser-specific reason here: the adapters
 * need usable-internally vs not, and the reasons live in ParseResult coverage.
 */
export type ViewResolution =
  | { status: "internal"; target: string }
  | { status: "external"; external: ExternalKind }
  | { status: "excluded" }
  | { status: "unresolved" };

export type ViewImport = {
  /** Module specifier exactly as written; only literal specifiers appear here. */
  specifier: string;
  kind: "import" | "require" | "dynamic-import";
  line: number;
  resolution: ViewResolution;
  bindings: readonly ViewImportBinding[];
};

/**
 * An export a route handler can hang its method on, or a route table can
 * forget about. Declaration form covers exported functions and variable
 * bindings (including destructured elements); alias covers `export { x as y }`
 * and `export * as ns`; star is a bare `export *`, which hides every name.
 * Default exports and CommonJS whole-module exports are excluded: the adapter
 * that must skip the first and never reads the second gains nothing from them.
 */
export type ViewExport =
  | { form: "declaration"; name: string; kind: "function" | "variable"; line: number }
  | { form: "alias"; name: string; line: number }
  | { form: "star"; line: number };

/** A decorator: the callee as written, its arguments, and its own line (route decorators report this line, not the member's). */
export type ViewDecorator = { name: string; arguments: readonly ViewArgument[]; line: number };

/**
 * A declaration the framework adapters read: classes with their decorators,
 * class methods under a qualified dotted name, and variable declarations with
 * the callee of their call initializer (`express`, `express.Router`) for
 * app/router recognition. The line is the declaration's start, which for a
 * decorated member is the decorator's line — the same line the parser reports
 * for a route. Methods carry the parser's lexicon kind ("function", as symbols
 * do); the qualified name carries the scope.
 */
export type ViewDeclaration = {
  name: string;
  kind: SymbolKind;
  line: number;
  decorators: readonly ViewDecorator[];
  initializerCall: string | null;
};

/** A `receiver.method(...)` call site, with every argument as written. Occurrences are never deduplicated. */
export type ViewCall = { callee: string; arguments: readonly ViewArgument[]; line: number };

/** Everything the adapters need about one parsed file, scoped to the view's project. */
export type ViewFile = {
  path: string;
  /** From the Phase 5 language registry. Null when no language owns the extension. */
  language: LanguageId | null;
  /** Values of the leading directive prologue ("use server", "use strict"): the run of string-literal statements at the top. */
  directives: readonly string[];
  flags: { jsx: boolean };
  imports: readonly ViewImport[];
  exports: readonly ViewExport[];
  declarations: readonly ViewDeclaration[];
  calls: readonly ViewCall[];
  /**
   * Properties of the file's top-level config-object literals (a variable's
   * initializer, `module.exports = { … }`, `export default { … }`): the shape
   * next.config files take. Decorator and call arguments carry their own
   * object literals separately.
   */
  objectProperties: readonly ViewProperty[];
};

/** A code file in the project whose syntax is unknown, with the reason it was skipped. */
export type ViewSkippedFile = { path: string; reason: string };

/** The whole view for one project: version-stamped, deterministic, in-process only. */
export type FrameworkView = {
  viewVersion: typeof FRAMEWORK_VIEW_VERSION;
  project: string;
  files: readonly ViewFile[];
  skipped: readonly ViewSkippedFile[];
};
