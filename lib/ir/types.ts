// The canonical, language-neutral intermediate representation (Phase 5).
//
// The IR is an *in-process contract* between parsers and consumers. The
// database remains the storage of record; nothing here creates IR tables, and
// `project` (lib/ir/convert.ts) reconstructs the parser's ParseResult exactly,
// so compatibility with everything stored and served today is checkable, not
// assumed.
//
// Three distinctions this module exists to make, and never conflate:
//
//  1. `compatKind`  — the symbol's kind as the parser persisted it (the closed
//     nine-value TypeScript lexicon in lib/parser/types.ts). Carried verbatim
//     so compatibility with the database and every existing consumer can be
//     verified field by field.
//  2. `declaration` — the language-neutral declaration kind from an explicit
//     registry. A method is a method here even though the persisted kind says
//     "function"; a `const` binding is a `variable` even though the persisted
//     kind says "const".
//  3. `scope`       — the structured parent chain (qualified names as data),
//     instead of dots inside a name string.
//
// The registries below are open across releases but closed within one: a new
// language adapter lands by *registering* its kinds here, not by writing
// unvalidated strings. Version the IR whenever a registry or a field's meaning
// changes.

import type { NonCodeCandidate } from "../parser/screening.ts";
import type {
  ConfigReference,
  ConfigReport,
  Coverage,
  Dependency,
  EdgeKind,
  EntryPoint,
  EnvDeclaration,
  Manifest,
  ParsedFile,
  Project,
  Route,
  SymbolKind,
} from "../parser/types.ts";

export const IR_VERSION = 1;

// ---- Open vocabularies -----------------------------------------------------
//
// Shared declaration kinds. Today's members are exactly what the JS/TS parser
// produces plus the refinement its persisted lexicon cannot carry (method vs
// function). A future language adapter adds entries; it never reuses an entry
// with a different meaning.

export const DECLARATION_KINDS = [
  "function",
  "method",
  "class",
  "interface",
  "type-alias",
  "enum",
  "namespace",
  "variable",
] as const;

export type DeclarationKind = (typeof DECLARATION_KINDS)[number];

/**
 * Shared relationship kinds between files. Starts as the JS/TS parser's edge
 * vocabulary (structurally identical to `EdgeKind`); later adapters register
 * theirs here rather than overloading these.
 */
export const RELATIONSHIP_KINDS: readonly RelationshipKind[] = ["import", "re-export", "dynamic-import", "require", "call"];

export type RelationshipKind = EdgeKind;

// ---- Provenance ------------------------------------------------------------

/**
 * Who produced this IR and from what. Every IR carries one; the validator
 * rejects an IR without it.
 *
 * The provenance contract, precisely:
 *
 *  - Every fact in the IR derives from the same parser run recorded here, so
 *    a consumer may treat Ir.source as the producer of all of them. This is
 *    the only producer claim the IR makes; it does not claim that each fact
 *    independently names its producer.
 *  - Facts with their own source location (file + line): relationships
 *    (specifier and line of first occurrence), routes, omitted routes,
 *    symbols, unresolved imports, unresolved calls, config references.
 *  - Facts with their own source but no line: entry points (path, named by
 *    `source`/`manifest`, reached through `via`), withheld routes (project +
 *    reason), files (path + content hash; `reachedBy` names the convention
 *    that reaches them and `role` the one that classified them), skipped
 *    files (path + reason + detail), manifests (path; `problems` says what
 *    could not be read), config reports (path), env declarations (path),
 *    unresolved entry reasons (`not-indexed`/`not-found`).
 *  - Facts with their own producer beyond the parser: projects carry the
 *    framework adapter that detected them (`adapter`); entry points carry
 *    the manifest or convention that declared them (`source`, `manifest`);
 *    dependencies carry the manifest that declares them (`manifest`).
 *  - No meaningful source location: coverage aggregates, which summarize the
 *    facts above rather than sit anywhere themselves.
 *
 * Per-fact provenance is preserved verbatim from the parser output; this
 * module adds no redundant metadata and no confidence fields.
 */
export type IrSource = {
  /** The pipeline that produced the IR, named so a reader can judge it. */
  producer: string;
  /** The parser output the IR was derived from. */
  derivedFrom: {
    /** The parser contract version of the source ParseResult (SCHEMA_VERSION). */
    parserSchema: number;
  };
};

// ---- Symbols ---------------------------------------------------------------

/** The symbol kind exactly as the parser persisted it. Never remapped. */
export type SymbolCompatKind = SymbolKind;

/**
 * One ancestor in a symbol's qualified name, outermost first. `container` is
 * resolved when the ancestor symbol exists in the same file and the evidence
 * agrees on what it is; null when it does not — the IR says "unknown" rather
 * than guessing.
 */
export type ScopeSegment = {
  /** The ancestor's own name segment (an identifier, never a dotted name). */
  name: string;
  container: {
    /** What the ancestor declares, from the declaration registry. */
    declaration: DeclarationKind;
    /** The ancestor's persisted kind, for compatibility verification. */
    compatKind: SymbolCompatKind;
  } | null;
};

/**
 * Controlled extension mechanism for language-specific detail. Namespaces are
 * lowercase slug keys (e.g. "ts"); values are plain JSON. Nothing in the core
 * reads them; the validator only enforces their shape. Detail a language
 * adapter extracts goes here instead of being silently discarded or invented
 * into core fields.
 */
export type IrExtensions = { [namespace: string]: { [key: string]: IrExtensionValue } };

export type IrExtensionValue = string | number | boolean | null | IrExtensionValue[] | { [key: string]: IrExtensionValue };

/**
 * One declaration, carrying the parser's fields verbatim plus the structure
 * the persisted model cannot express. Optional fields keep the parser's
 * presence/absence exactly: a field absent in the ParseResult is absent here,
 * and `project` restores that shape bit for bit.
 */
export type IrSymbol = {
  /** The file that declares it (repository-relative). */
  file: string;
  /** The full qualified name, exactly as the parser wrote it. */
  name: string;
  /** The final segment of `name` — the declaration's own identifier. */
  leafName: string;
  /** The persisted kind, verbatim. */
  compatKind: SymbolCompatKind;
  /** The language-neutral declaration kind. */
  declaration: DeclarationKind;
  /** Ancestors of this declaration, outermost first; [] for top-level. */
  scope: ScopeSegment[];
  /** 1-based line where the declaration starts. */
  line: number;
  /** Last line of the declaration (inclusive), as the parser recorded it. */
  endLine?: number;
  exported: boolean;
  /** "named" | "default" | "none", as the parser recorded it. */
  exportKind?: "named" | "default" | "none";
  /** Parameter list as written, as the parser recorded it. */
  parameters?: { name: string; type: string }[];
  /** Declared or inferred return type text, as the parser recorded it. */
  returnType?: string;
  /** Full signature text, as the parser recorded it. */
  signature?: string;
  /** JSDoc/TSDoc inner text, as the parser recorded it. */
  documentation?: string;
  /**
   * Deprecated parser field, carried only so an IR round-trips whatever a
   * ParseResult contains. Nothing sets it today and nothing persists it; it
   * stays deferred (see docs/PROJECT_STATE.md) and must not be populated by
   * IR code.
   */
  isPublicApi?: boolean;
  /** Language-specific detail, by controlled namespace. */
  extensions?: IrExtensions;
};

// ---- Relationships ---------------------------------------------------------

/**
 * One dependency between two files: an import, a re-export, a dynamic import,
 * a require, or a statically recovered call. Shape-identical to the parser's
 * Edge so the projection is a field-for-field copy.
 */
export type IrRelationship = {
  source: string;
  target: string;
  kind: RelationshipKind;
  /** True only when every occurrence of this source→target→kind is type-only. */
  typeOnly: boolean;
  specifier: string;
  line: number;
};

// ---- The canonical model ---------------------------------------------------
//
// Sections the parser already expresses in a language-neutral shape (files,
// routes, manifests, dependencies, config references, env declarations, entry
// points, coverage, configs, projects) are carried as-is, reusing the parser's
// types. They are already canonical: reshaping them would add drift risk with
// no consumer. The IR validator still checks them, so an IR is never weaker
// than the parser contract it came from.

export type Ir = {
  irVersion: typeof IR_VERSION;
  /** Provenance: who produced this and from what parser contract. */
  source: IrSource;
  /** Absolute path the parser was pointed at. */
  root: string;
  /** Root first, then in walk order. */
  projects: Project[];
  /** Files, verbatim from the parser (already language-neutral). */
  files: ParsedFile[];
  /** Declarations, restructured (see IrSymbol). Sorted by file, then line. */
  symbols: IrSymbol[];
  /** File-level dependency facts. */
  relationships: IrRelationship[];
  /** Routes, verbatim (method/pattern/line are framework-syntax facts). */
  routes: Route[];
  manifests: Manifest[];
  dependencies: Dependency[];
  configReferences: ConfigReference[];
  envDeclarations: EnvDeclaration[];
  entryPoints: EntryPoint[];
  coverage: Coverage;
  configs: ConfigReport[];
  nonCodeCandidates?: NonCodeCandidate[];
};
