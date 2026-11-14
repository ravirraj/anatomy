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

/**
 * A file that parsed cleanly, with its syntax tree. Compatibility-oracle
 * surface only (Batch 3.3d.1): the legacy routes() readers take these, and
 * the route migration tests hand them over directly. The production
 * orchestration builds and consumes no AdapterFile.
 */
export type AdapterFile = { path: string; source: SourceFile };

/** The same shape, oracle-facing: only a legacy routes() reader takes it. */
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
   * directive or syntax it contains. Answered over the project's FrameworkView
   * (Batch 3.2): the path, the directive prologue and the syntax flags a role
   * reads are the view's, never the language parser's types. Null when none
   * applies; the file stays unclassified rather than getting the nearest fit.
   */
  roleOf(file: ViewFile): Role | null;
  /**
   * The pre-view route spelling, kept ONLY as the compatibility oracle the
   * route migration tests deep-equal against routesFromView (Batches
   * 3.3a–3.3c). Never invoked in production: the orchestration reads
   * routesFromView, or nothing at all for an adapter with no route logic
   * (Batch 3.3d.1). An adapter with route logic MUST implement
   * routesFromView; this member is optional so the no-route adapters carry
   * neither method.
   */
  routes?(project: ProjectFiles): RouteReport;
  /**
   * The same question answered over the project's FrameworkView (Batch 3.3a):
   * adapters migrate from routes() one at a time, and the parser prefers this
   * when present. `unparsed` carries the same project-relative skipped-code
   * paths routes() receives today; the view is the same instance roleOf reads,
   * so one build per project serves both.
   */
  routesFromView?(view: FrameworkView, unparsed: readonly string[]): RouteReport;
}

// ---- FrameworkView (Phase 5 Batch 3.1) ----
//
// A language-neutral, framework-oriented view of one project's parsed files:
// the syntactic facts the framework adapters read, handed over without the
// language parser's own types. The JS/TS builder lives in view.ts. Role
// detection consumes the view (Batch 3.2): roleOf answers over ViewFile.
// Route detection does too (Batch 3.3d.1): routesFromView is the production
// route interface, and the legacy routes() spelling with the AdapterFile
// types it reads is compatibility-oracle surface the orchestration never
// touches.
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

/**
 * One property assignment anywhere in the file — every `PropertyAssignment`
 * and `ShorthandPropertyAssignment` in document order, however deeply nested
 * (inside call arguments, function returns, arrays): the surface Next.js's
 * legacy config scan reads, which is deliberately file-wide ("a property
 * anywhere in the file could be the one Next.js reads"). Same name
 * normalization and value semantics as `ViewProperty`; computed keys and
 * spreads are skipped just the same. The `shorthand` marker keeps the
 * spelling itself a fact — `{ basePath }` and `{ basePath: basePath }` carry
 * the same value but are different spellings, and Next.js's legacy scan
 * separates them into two passes with different outcomes — so a consumer
 * reproducing that order filters on the marker, which preserves relative
 * order either way.
 */
export type ViewPropertyAssignment = {
  name: string;
  value: ViewValue;
  line: number;
  /** True only for the shorthand spelling (`{ basePath }`); an explicit `{ basePath: basePath }` is not shorthand. */
  shorthand?: boolean;
};

/** An argument in a call or a decorator. Same grammar as property values. */
export type ViewArgument = ViewValue;

/**
 * Local binding name → name exported by the source module ("default" for a
 * default or bare-require binding, "*" for a namespace). Null when the
 * exported name isn't statically written (a computed key in a destructured
 * require): the local binding itself is still written, and it is the fact the
 * Express adapter traces mounts through.
 */
export type ViewImportBinding = {
  local: string;
  imported: string | null;
  /**
   * True only for the import clause's default slot (`import x from "m"`): a
   * named `default` binding (`import { default as x } from "m"`) carries the
   * same imported name but is not the slot, and consumers that read the
   * default slot must not read that spelling as one.
   */
  defaultSlot?: boolean;
};

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
  /**
   * True only for TypeScript's `import x = require(...)` spelling: its "*"
   * binding is not a namespace import, and consumers that read namespace
   * imports must not read it as one.
   */
  importEquals?: boolean;
  line: number;
  resolution: ViewResolution;
  bindings: readonly ViewImportBinding[];
};

/**
 * An export a route handler can hang its method on, or a route table can
 * forget about. Declaration form covers exported functions and variable
 * bindings (including destructured elements); alias covers `export { x as y }`
 * and `export * as ns` — the latter marked `namespace`, since its name is a
 * whole module object, not a member some consumer exported, so a reader that
 * resolves exported names by alias must never read it as one; star is a bare
 * `export *`, which hides every name. Default exports and CommonJS
 * whole-module exports are excluded: the adapter that must skip the first and
 * never reads the second gains nothing from them.
 */
export type ViewExport =
  | { form: "declaration"; name: string; kind: "function" | "variable"; line: number }
  | { form: "alias"; name: string; line: number; namespace?: boolean }
  | { form: "star"; line: number };

/**
 * A decorator: the callee as written, its arguments, and its own line (route
 * decorators report this line, not the member's). `bare` marks the spelling
 * without a call: `@Controller` is bare, `@Controller()` is not — even at
 * zero arguments the call form carries no flag, so the two stay structurally
 * distinct and a consumer that requires the call form never reads the bare
 * spelling as one.
 */
export type ViewDecorator = { name: string; arguments: readonly ViewArgument[]; line: number; bare?: boolean };

/**
 * A declaration the framework adapters read: classes with their decorators,
 * class methods under a qualified dotted name, and variable declarations with
 * the callee of their call initializer (`express`, `express.Router`) for
 * app/router recognition. The line is the declaration's start, which for a
 * decorated member is the decorator's line — the same line the parser reports
 * for a route. Methods carry the parser's lexicon kind ("function", as symbols
 * do); the qualified name carries the scope. A class with no written name (an
 * anonymous class, which the legacy route readers still process) is recorded
 * with `name: ""` — nothing is written there, and no written name is ever "",
 * so the empty string is the fact, not a synthetic name.
 */
export type ViewDeclaration = {
  name: string;
  kind: SymbolKind;
  line: number;
  decorators: readonly ViewDecorator[];
  initializerCall: string | null;
  /**
   * The owning class of a method declaration: the 1-based ordinal of that
   * class among the file's class declarations in document order — the same
   * order the declarations array carries them in, so counting the
   * `kind: "class"` entries recovers the class. Present only when the
   * declaration's name cannot identify its owner within the file: a method
   * of an anonymous class (no class name to qualify with), a computed-name
   * method (no written method name), or a method of a class whose written
   * name another class in the same file also writes (the name would group
   * both). A named class whose name is unique keeps the `Cls.method`
   * qualified name and no field; distinct ordinals keep same-named classes'
   * method groups apart.
   */
  ownerClass?: number;
  /**
   * True only for a method whose name is a computed property name: nothing
   * static is written, the expression is never evaluated, and `name` is "".
   * The flag — not the empty string — is the fact, so the named/computed
   * distinction survives even though both spell the name as "".
   */
  nameComputed?: boolean;
  /**
   * The initializer's callee in the same structural shape ViewCall carries:
   * `receiver` is the plain-identifier callee name (or the object of a
   * `receiver.member` / `receiver?.member` access), `member` the accessed
   * name — null for a bare-identifier callee. A callee of any other shape
   * (chained, parenthesised, element access, a call result) is
   * `{ receiver: null, member: null }`. Comment trivia between the parts
   * never survives here: these are node names, not source text. Absent when
   * the initializer is not a call.
   */
  initializerCallee?: { receiver: string | null; member: string | null };
};

/** A `receiver.method(...)` call site, with every argument as written. Occurrences are never deduplicated. */
export type ViewCall = {
  /** The callee as written (e.g. `app.use`, `a.b.use`); consumers that need the AST shape read `receiver`/`member`. */
  callee: string;
  /**
   * The receiver as the AST writes it, normalized: the receiver identifier's
   * name when the callee is `identifier.member` or `identifier?.member`,
   * else null — a chained receiver (`a.b.use`), a parenthesised or
   * element-access receiver, or anything the legacy identifier check
   * rejected. Comment trivia between the parts never survives here: these
   * are node names, not source text.
   */
  receiver: string | null;
  /** The accessed member name (`use`, `get`, …). */
  member: string;
  arguments: readonly ViewArgument[];
  line: number;
};

/** Everything the adapters need about one parsed file, scoped to the view's project. */
export type ViewFile = {
  path: string;
  /**
   * The file's rank in the original repository walk order (0-based, counted
   * over the project's parsed files in the order the walker produced them),
   * when the caller tracked it. `files` itself stays sorted by path; a
   * consumer that must iterate in the walker's own order — e.g. to name the
   * first offending file in a withhold reason exactly as the legacy route
   * readers did — sorts a copy by this field. Absent when the caller didn't
   * carry the walk order, in which case the path-sorted order is all there is.
   */
  walkOrder?: number;
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
  /**
   * Every property assignment in the file, however deeply nested or scoped —
   * the file-wide surface the legacy Next.js config scan reads. A separate
   * stream from `objectProperties` on purpose: the two answer different
   * questions (the config-object shape vs the file-wide scan), and the
   * config-object surface keeps its exact existing meaning.
   */
  propertyAssignments: readonly ViewPropertyAssignment[];
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
