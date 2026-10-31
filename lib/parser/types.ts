// The shape the parser writes. Everything built after the parser reads this,
// so changing it means bumping SCHEMA_VERSION and updating the validator.

import type { Role } from "../roles.ts";

export const SCHEMA_VERSION = 7;

export type EdgeKind = "import" | "re-export" | "dynamic-import" | "require" | "call";

export const EDGE_KINDS: readonly EdgeKind[] = ["import", "re-export", "dynamic-import", "require", "call"];

export type ParsedFile = {
  /** Repository-relative, forward slashes. */
  path: string;
  /** The folder the file sits in, repository-relative. "." for the root. */
  module: string;
  lines: number;
  bytes: number;
  /** sha256 of the raw contents, hex. */
  hash: string;
  /** Distinct files that import this one. */
  fanIn: number;
  /** Distinct files this one imports. */
  fanOut: number;
  /**
   * How something other than an import reaches this file, from the adapter of
   * the project it sits in: "Next.js page", "test file, …". Null when only an
   * import would.
   */
  reachedBy: string | null;
  /** The role a convention of its project's adapter gives it. Null when none does. */
  role: Role | null;
  /**
   * The names this file exports, ESM and CommonJS alike, as written in it, in
   * source order. `export * from` adds nothing here: which names it passes on
   * lives in the other file, and that file is a re-export edge away.
   */
  exports: string[];
};

/** The repository root, and every folder below it whose package.json a framework adapter detected. */
export type Project = {
  path: string;
  /** The adapter that detected it. "none" is the fallback. */
  adapter: string;
};

export type Edge = {
  source: string;
  target: string;
  kind: EdgeKind;
  /** True only when every occurrence of this source→target→kind is type-only. */
  typeOnly: boolean;
  /** The specifier and line of the first occurrence. */
  specifier: string;
  line: number;
};

/** One method on one pattern, both read from the syntax. */
export type Route = {
  /** The file that declares it. */
  file: string;
  /** Upper case, as the framework spells it: GET, POST, ALL. */
  method: string;
  /** The full path pattern in the framework's own syntax: /users/:id, /blog/[slug]. */
  pattern: string;
  /** Where it's declared: the export or the decorator. */
  line: number;
};

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "namespace"
  | "const"
  | "let"
  | "var";

export const SYMBOL_KINDS: readonly SymbolKind[] = [
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "namespace",
  "const",
  "let",
  "var",
];

/**
 * One top-level declaration, read from the file's own syntax. Definitions,
 * not only the exports: an unexported helper is a symbol too, with exported
 * saying which it is.
 */
export type ParsedSymbol = {
  /** The file that declares it. */
  file: string;
  name: string;
  kind: SymbolKind;
  /** Where it's declared. */
  line: number;
  /** Last line of the declaration (inclusive). */
  endLine?: number;
  exported: boolean;
  /** "named" | "default" | "none" (CommonJS whole-module exports are "named" with the exported name). */
  exportKind?: "named" | "default" | "none";
  /** Parameter list as written, e.g. [{ name: "id", type: "string" }]. */
  parameters?: { name: string; type: string }[];
  /** Declared or inferred return type text, when applicable. */
  returnType?: string;
  /** Full signature text, e.g. "foo(a: number): boolean". */
  signature?: string;
  /** JSDoc/TSDoc inner text, when present. */
  documentation?: string;
  /** True when the symbol is part of a package's public API (entry-point export chain). */
  isPublicApi?: boolean;
};

export type OmittedRoute = { file: string; line: number; reason: string };

export type WithheldRoutes = { project: string; reason: string };

export type SkipReason =
  | "declaration-file"
  | "too-large"
  | "binary"
  | "symlink"
  | "syntax-error"
  | "unreadable";

export type SkippedFile = {
  path: string;
  reason: SkipReason;
  detail: string;
};

export type ExcludedDirectory = {
  path: string;
  reason: string;
};

export type ExternalKind = "package" | "builtin" | "outside-root";

export type ExcludedReason =
  | "non-code-file"
  | "declaration-file"
  | "target-skipped"
  | "in-excluded-directory";

export type UnresolvedReason =
  | "non-literal-dynamic-import"
  | "non-literal-require"
  | "file-not-found"
  | "directory-without-index"
  | "alias-target-not-found"
  | "workspace-package-not-linked"
  | "subpath-import-not-found";

export type ImportStatus =
  | { status: "internal"; target: string }
  | { status: "external"; external: ExternalKind }
  | { status: "excluded"; reason: ExcludedReason; detail: string }
  | { status: "unresolved"; reason: UnresolvedReason; detail: string };

export type UnresolvedImport = {
  from: string;
  /** The literal text; for a non-literal dynamic import, the expression source. */
  specifier: string;
  kind: EdgeKind;
  line: number;
  reason: UnresolvedReason;
  detail: string;
};

export type StatusCounts = {
  seen: number;
  internal: number;
  external: number;
  excluded: number;
  unresolved: number;
};

export type Coverage = {
  files: {
    found: number;
    parsed: number;
    skipped: number;
    skippedFiles: SkippedFile[];
    excludedDirectories: ExcludedDirectory[];
  };
  imports: {
    total: StatusCounts;
    byKind: Record<EdgeKind, StatusCounts>;
    external: Record<ExternalKind, number>;
    excluded: Partial<Record<ExcludedReason, number>>;
    unresolvedByReason: Partial<Record<UnresolvedReason, number>>;
    /** Every failure, not a sample. */
    unresolved: UnresolvedImport[];
  };
  routes: {
    /** Route declarations left out because the method or the full pattern isn't written in the syntax. */
    omitted: OmittedRoute[];
    /** Projects where something sets every pattern at runtime, so none of their routes is listed. */
    withheld: WithheldRoutes[];
  };
  calls: {
    total: number;
    resolved: number;
    unresolved: number;
    /** Every unresolved call site. */
    unresolvedCalls: { from: string; callee: string; line: number; reason: string }[];
  };
};

export type ConfigReport = {
  /** Repository-relative tsconfig/jsconfig path. */
  path: string;
  /** Problems TypeScript reported reading it. Resolution still used what it could read. */
  errors: string[];
};

// ---- Packaging, configuration and entry points (Phase 4) ----
//
// Everything below is read from a manifest, a source file or a convention file.
// The distinction the rest of the app depends on: a *declared* fact is written
// down in the repository; an *inferred* one is a structural convention the
// parser recognised. Neither is ever a claim that something is installed,
// running or used — that would need evidence this parser does not have.

export type DependencyKind = "runtime" | "dev" | "optional" | "peer" | "build" | "indirect";

export const DEPENDENCY_KINDS: readonly DependencyKind[] = ["runtime", "dev", "optional", "peer", "build", "indirect"];

/**
 * One dependency as declared in one manifest. A dependency is a *declaration*:
 * its presence says the manifest asks for it, never that it is installed or
 * that any code imports it.
 */
export type Dependency = {
  /** Package name as declared. */
  name: string;
  /** Version or constraint exactly as declared; null when the manifest names none. */
  version: string | null;
  kind: DependencyKind;
  /** Repository-relative manifest that declares it. */
  manifest: string;
  /** Repository-relative directory of that manifest (the package it belongs to). */
  dir: string;
  /** The parser project the manifest sits in. */
  project: string;
  /**
   * How many parsed files import this package by bare specifier. Evidence that
   * the dependency is reached from indexed source — never proof it is
   * installed, and a zero never proves it is unused (a CLI, a config file or a
   * file the parser skipped could still use it).
   */
  importedBy: number;
};

export type ConfigReferenceKind =
  | "process.env"
  | "import.meta.env"
  | "env-bracket"
  | "env-example"
  | "config-object";

export const CONFIG_REFERENCE_KINDS: readonly ConfigReferenceKind[] = [
  "process.env",
  "import.meta.env",
  "env-bracket",
  "env-example",
  "config-object",
];

/**
 * A reference to a configuration value. Only the *name* is ever recorded: no
 * value from a source file, an environment declaration or a config object is
 * read into this type, so a secret cannot reach the store through it.
 */
export type ConfigReference = {
  /** Repository-relative file the reference sits in. */
  file: string;
  /** Variable or configuration key name. Never a value. */
  variable: string;
  /** 1-based line; 0 for a declaration file whose lines are not indexed. */
  line: number;
  kind: ConfigReferenceKind;
  /** Provenance detail: the declaring object for "config-object", the group for "env-example". */
  detail?: string;
};

export type EntryPointKind = "declared" | "inferred";

/**
 * Why a declared entry did not resolve to an indexed file. The two cases are
 * different facts and are never collapsed:
 *  - "not-indexed": the file is on disk but is not a code file this parser
 *    indexes (a Rust source, a Python module, a build output the walk skipped).
 *  - "not-found": nothing is at that path at all — the declaration points at
 *    something that has not been built, or is simply wrong.
 */
export type EntryUnresolvedReason = "not-indexed" | "not-found";

/**
 * A place execution or consumption starts. "declared" means a manifest names
 * it; "inferred" means a structural convention does. The two are never merged:
 * a reader is entitled to know which one they are looking at.
 */
export type EntryPoint = {
  /** Repository-relative file path, as declared or as found. */
  path: string;
  kind: EntryPointKind;
  /** What named it: "package.json main", "Cargo.toml [lib]", "framework route", "index file". */
  source: string;
  /** Repository-relative manifest that declared it; null for inferred entries. */
  manifest: string | null;
  /** Sub-path, bin name or other qualifier the declaration carried. */
  detail?: string;
  /**
   * True when `path` is one of the files this parse actually indexed. A
   * declared entry that does not resolve stays listed and stays false — it is
   * not silently dropped.
   */
  resolved: boolean;
  /** Set only when resolved is false, and only for a declared entry. */
  unresolvedReason?: EntryUnresolvedReason;
  /**
   * Files reachable from this entry by re-export edges alone, in breadth-first
   * order. This is what a package actually exposes beyond its entry file.
   */
  via?: string[];
};

export type ManifestEcosystem =
  | "npm"
  | "pnpm-workspace"
  | "cargo"
  | "go"
  | "python-requirements"
  | "python-project";

export const MANIFEST_ECOSYSTEMS: readonly ManifestEcosystem[] = [
  "npm",
  "pnpm-workspace",
  "cargo",
  "go",
  "python-requirements",
  "python-project",
];

/** A command a manifest declares, e.g. a package.json script. */
export type ManifestScript = { name: string; command: string };

/** One manifest found in the repository, with the facts only it can state. */
export type Manifest = {
  /** Repository-relative manifest path. */
  path: string;
  /** Repository-relative directory it sits in; "." for the repository root. */
  dir: string;
  /** The parser project it belongs to. */
  project: string;
  ecosystem: ManifestEcosystem;
  /** The package/module name the manifest declares, when it declares one. */
  name: string | null;
  /** Workspace globs the manifest declares. */
  workspaces: string[];
  /** Commands it declares. */
  scripts: ManifestScript[];
  /** What could not be read, by field. A manifest that half-parses says so. */
  problems: string[];
};

/** Keys declared by an environment template file (.env.example and friends). */
export type EnvDeclaration = { path: string; keys: string[] };

export type ParseResult = {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Absolute path the parser was pointed at. */
  root: string;
  /** Root first, then in walk order. */
  projects: Project[];
  files: ParsedFile[];
  edges: Edge[];
  /** Sorted by pattern, then method. */
  routes: Route[];
  /** Sorted by file, then line. */
  symbols: ParsedSymbol[];
  /** Every manifest found, with its own declared facts. */
  manifests: Manifest[];
  /** Every dependency every manifest declares. Declarations, not installations. */
  dependencies: Dependency[];
  /** Configuration and environment references. Names only, never values. */
  configReferences: ConfigReference[];
  /** Environment template files and the keys they declare. */
  envDeclarations: EnvDeclaration[];
  /** Entry points, declared and inferred, sorted by path then source. */
  entryPoints: EntryPoint[];
  coverage: Coverage;
  configs: ConfigReport[];
};
