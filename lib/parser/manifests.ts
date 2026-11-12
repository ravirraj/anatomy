// Reading what a repository declares about itself: its manifests, the
// dependencies they name, the commands they publish and the entry points they
// point at.
//
// Two rules run through every reader here.
//
//  1. A declaration is not an installation. A dependency listed in a manifest
//     is recorded as declared, with the manifest that declares it. Nothing here
//     reads a lockfile or a node_modules tree, so nothing here can say a
//     package is installed, resolved or in use.
//
//  2. A reader that cannot understand a manifest says so and returns what it
//     did understand. A malformed Cargo.toml yields a manifest with a problem
//     recorded, not a silent absence — "no dependencies" and "could not read
//     the dependencies" are different answers and stay different.

import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  Dependency,
  DependencyKind,
  Manifest,
  ManifestEcosystem,
  ManifestScript,
} from "./types.ts";

/** A manifest file this module knows how to read, by exact filename. */
const MANIFEST_FILES: Record<string, ManifestEcosystem> = {
  "package.json": "npm",
  "Cargo.toml": "cargo",
  "go.mod": "go",
  "requirements.txt": "python-requirements",
  "pyproject.toml": "python-project",
  "pnpm-workspace.yaml": "pnpm-workspace",
};

/** The filenames worth reading, in the order a directory's manifests are reported. */
export const MANIFEST_NAMES: readonly string[] = Object.keys(MANIFEST_FILES);

export function manifestEcosystemOf(fileName: string): ManifestEcosystem | null {
  return MANIFEST_FILES[fileName] ?? null;
}

/** What one manifest contributed, before the parser resolves anything. */
export type ManifestRead = {
  manifest: Manifest;
  dependencies: Dependency[];
  /** Entry points exactly as declared: paths are manifest-relative and unresolved. */
  declared: { path: string; source: string; detail?: string }[];
};

/**
 * Reads one manifest. `dir` and `project` are repository-relative. A file that
 * cannot be read at all still produces a manifest record carrying the problem,
 * so a repository with a broken manifest is visibly broken rather than empty.
 */
export function readManifest(
  absolutePath: string,
  relativePath: string,
  dir: string,
  project: string,
  ecosystem: ManifestEcosystem,
): ManifestRead {
  let text: string;
  try {
    text = readFileSync(absolutePath, "utf8");
  } catch (error) {
    return {
      manifest: blankManifest(relativePath, dir, project, ecosystem, [
        `unreadable: ${error instanceof Error ? error.message : String(error)}`,
      ]),
      dependencies: [],
      declared: [],
    };
  }
  switch (ecosystem) {
    case "npm":
      return readPackageJson(text, relativePath, dir, project);
    case "cargo":
      return readCargoToml(text, relativePath, dir, project);
    case "go":
      return readGoMod(text, relativePath, dir, project);
    case "python-requirements":
      return readRequirementsTxt(text, relativePath, dir, project);
    case "python-project":
      return readPyprojectToml(text, relativePath, dir, project);
    case "pnpm-workspace":
      return readPnpmWorkspace(text, relativePath, dir, project);
  }
}

function blankManifest(
  relativePath: string,
  dir: string,
  project: string,
  ecosystem: ManifestEcosystem,
  problems: string[],
): Manifest {
  return {
    path: relativePath,
    dir,
    project,
    ecosystem,
    name: null,
    workspaces: [],
    scripts: [],
    problems,
  };
}

function dep(
  name: string,
  version: string | null,
  kind: DependencyKind,
  manifest: string,
  dir: string,
  project: string,
): Dependency {
  return { name, version, kind, manifest, dir, project, importedBy: 0 };
}

// ---- npm: package.json ----------------------------------------------------

function readPackageJson(text: string, relativePath: string, dir: string, project: string): ManifestRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      manifest: blankManifest(relativePath, dir, project, "npm", [
        `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ]),
      dependencies: [],
      declared: [],
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      manifest: blankManifest(relativePath, dir, project, "npm", ["not a JSON object"]),
      dependencies: [],
      declared: [],
    };
  }
  const raw = parsed as Record<string, unknown>;
  const problems: string[] = [];
  const dependencies: Dependency[] = [];

  // Every block npm defines, in the order a reader expects to see them. A
  // package in two blocks is recorded twice: the manifest really does say both,
  // and collapsing them would invent a precedence npm does not document.
  const blocks: [string, DependencyKind][] = [
    ["dependencies", "runtime"],
    ["devDependencies", "dev"],
    ["optionalDependencies", "optional"],
    ["peerDependencies", "peer"],
  ];
  for (const [field, kind] of blocks) {
    const block = raw[field];
    if (block === undefined) continue;
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      problems.push(`${field} is not an object`);
      continue;
    }
    for (const [name, version] of Object.entries(block as Record<string, unknown>)) {
      if (typeof version === "string") dependencies.push(dep(name, version, kind, relativePath, dir, project));
      else problems.push(`${field}.${name} is not a version string`);
    }
  }

  const scripts: ManifestScript[] = [];
  if (typeof raw.scripts === "object" && raw.scripts !== null && !Array.isArray(raw.scripts)) {
    for (const [name, command] of Object.entries(raw.scripts as Record<string, unknown>)) {
      if (typeof command === "string") scripts.push({ name, command });
    }
  }

  const workspaces = readWorkspaceGlobs(raw.workspaces);
  if (raw.workspaces !== undefined && workspaces.length === 0) problems.push("workspaces declared in an unrecognised shape");

  const declared: ManifestRead["declared"] = [];
  // main/module/types/bin/exports all name files, relative to the manifest's
  // own directory. They are recorded as declared whether or not the file is
  // one this parse indexed.
  for (const field of ["main", "module", "types", "typings", "browser"] as const) {
    const value = raw[field];
    if (typeof value === "string" && value.length > 0) {
      declared.push({ path: value, source: `package.json ${field}` });
    }
  }
  const bin = raw.bin;
  if (typeof bin === "string" && bin.length > 0) {
    declared.push({ path: bin, source: "package.json bin" });
  } else if (typeof bin === "object" && bin !== null && !Array.isArray(bin)) {
    for (const [name, target] of Object.entries(bin as Record<string, unknown>)) {
      if (typeof target === "string" && target.length > 0) {
        declared.push({ path: target, source: "package.json bin", detail: name });
      }
    }
  }
  // exports is a tree of conditions; every leaf string is a file the package
  // exposes. `null` leaves are npm's way of blocking a subpath and are skipped.
  if (raw.exports !== undefined) collectExportLeaves(raw.exports, [], (target, trail) => {
    declared.push({ path: target, source: "package.json exports", detail: trail.join(".") || undefined });
  });

  return {
    manifest: {
      path: relativePath,
      dir,
      project,
      ecosystem: "npm",
      name: typeof raw.name === "string" ? raw.name : null,
      workspaces,
      scripts,
      problems,
    },
    dependencies,
    declared,
  };
}

function readWorkspaceGlobs(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "object" && value !== null) {
    const packages = (value as { packages?: unknown }).packages;
    if (Array.isArray(packages)) return packages.filter((v): v is string => typeof v === "string");
  }
  return [];
}

/**
 * Walks an `exports` tree. Leaves are the strings; conditions are the keys on
 * the way down, kept as a trail so a reader can tell which condition a file
 * answers. A bare string `exports` is a single leaf at the root.
 */
function collectExportLeaves(value: unknown, trail: string[], out: (target: string, trail: string[]) => void): void {
  if (typeof value === "string") {
    if (value.length > 0) out(value, trail);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExportLeaves(item, trail, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectExportLeaves(child, [...trail, key], out);
    }
  }
}

// ---- Cargo: Cargo.toml ----------------------------------------------------

function readCargoToml(text: string, relativePath: string, dir: string, project: string): ManifestRead {
  const tables = parseTomlTables(text);
  const problems = tables.problems;
  const dependencies: Dependency[] = [];

  const readCargoDeps = (tableName: string, kind: DependencyKind) => {
    const table = tables.get(tableName);
    if (!table) return;
    for (const [name, entry] of table) {
      // `serde = "1.0"` is a version; `serde = { version = "1.0", ... }` is a
      // table; `serde = { path = "../serde" }` declares no version at all.
      if (typeof entry.scalar === "string") {
        dependencies.push(dep(name, entry.scalar, kind, relativePath, dir, project));
      } else if (entry.table) {
        const version = entry.table.get("version")?.scalar ?? null;
        dependencies.push(dep(name, version, kind, relativePath, dir, project));
      }
    }
  };
  readCargoDeps("dependencies", "runtime");
  readCargoDeps("dev-dependencies", "dev");
  readCargoDeps("build-dependencies", "build");

  const declared: ManifestRead["declared"] = [];
  const lib = tables.get("lib");
  if (lib) {
    const p = lib.get("path")?.scalar;
    if (typeof p === "string" && p.length > 0) declared.push({ path: p, source: "Cargo.toml [lib] path" });
  }
  // Cargo's own default when [lib] names no path.
  if (lib && !declared.some((d) => d.source === "Cargo.toml [lib] path")) {
    declared.push({ path: "src/lib.rs", source: "Cargo.toml [lib] default", detail: "convention" });
  }
  for (const [tableName, source] of [
    ["bin", "Cargo.toml [[bin]] path"],
    ["example", "Cargo.toml [[example]] path"],
  ] as const) {
    for (const entry of tables.arrays.get(tableName) ?? []) {
      const p = entry.get("path")?.scalar;
      if (typeof p === "string" && p.length > 0) declared.push({ path: p, source });
    }
  }

  const pkg = tables.get("package");
  const name = pkg?.get("name")?.scalar ?? null;
  const workspaces = tables.get("workspace")?.get("members") ? readTomlArray(tables.get("workspace")!.get("members")!.scalar) : [];

  return {
    manifest: {
      path: relativePath,
      dir,
      project,
      ecosystem: "cargo",
      name,
      workspaces,
      scripts: [],
      problems,
    },
    dependencies,
    declared,
  };
}

// ---- Go: go.mod -----------------------------------------------------------

function readGoMod(text: string, relativePath: string, dir: string, project: string): ManifestRead {
  const problems: string[] = [];
  const dependencies: Dependency[] = [];
  let moduleName: string | null = null;

  // go.mod is line-oriented: `require x v1.2.3` or a `require ( ... )` block.
  // `// indirect` marks a dependency the module does not import directly.
  let inRequire = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (line === ")" && inRequire) {
      inRequire = false;
      continue;
    }
    if (inRequire) {
      const [name, version] = line.split(/\s+/);
      if (name && version) {
        const indirect = /\/\/\s*indirect/.test(rawLine);
        dependencies.push(dep(name, version, indirect ? "indirect" : "runtime", relativePath, dir, project));
      } else {
        problems.push(`unreadable require line: ${rawLine.trim()}`);
      }
      continue;
    }
    const requireBlock = line.match(/^require\s*\($/);
    if (requireBlock) {
      inRequire = true;
      continue;
    }
    const single = line.match(/^require\s+(\S+)\s+(\S+)$/);
    if (single) {
      const indirect = /\/\/\s*indirect/.test(rawLine);
      dependencies.push(dep(single[1]!, single[2]!, indirect ? "indirect" : "runtime", relativePath, dir, project));
      continue;
    }
    const moduleLine = line.match(/^module\s+(\S+)$/);
    if (moduleLine) moduleName = moduleLine[1]!;
  }

  // A Go main package's entry point is its package main, which go.mod does not
  // name. Nothing is declared here; the convention adapter infers it.
  return {
    manifest: {
      path: relativePath,
      dir,
      project,
      ecosystem: "go",
      name: moduleName,
      workspaces: [],
      scripts: [],
      problems,
    },
    dependencies,
    declared: [],
  };
}

// ---- Python: requirements.txt --------------------------------------------

function readRequirementsTxt(text: string, relativePath: string, dir: string, project: string): ManifestRead {
  const problems: string[] = [];
  const dependencies: Dependency[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    // Strip comments and line continuations, then options (-r, -e, --index-url)
    // which name no package.
    const line = rawLine.replace(/(^|\s)#.*$/, "").replace(/\\$/, "").trim();
    if (!line) continue;
    if (line.startsWith("-")) continue;
    // name[extras]==1.2.3 ; markers, and the same with >=, ~=, <, >, !=.
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*([<>=!~]=?.*)?$/);
    if (!m) {
      problems.push(`unreadable requirement: ${line}`);
      continue;
    }
    const name = m[1]!;
    const constraint = (m[3] ?? "").trim();
    dependencies.push(dep(name, constraint.length > 0 ? constraint : null, "runtime", relativePath, dir, project));
  }
  return {
    manifest: {
      path: relativePath,
      dir,
      project,
      ecosystem: "python-requirements",
      name: null,
      workspaces: [],
      scripts: [],
      problems,
    },
    dependencies,
    declared: [],
  };
}

// ---- Python: pyproject.toml ----------------------------------------------

function readPyprojectToml(text: string, relativePath: string, dir: string, project: string): ManifestRead {
  const tables = parseTomlTables(text);
  const problems = tables.problems;
  const dependencies: Dependency[] = [];

  // PEP 621: dependencies is an array of PEP 508 strings.
  const projectTable = tables.get("project");
  const depsArray = projectTable?.get("dependencies")?.scalar;
  for (const spec of readTomlArray(depsArray)) {
    const parsed = parsePep508(spec);
    if (parsed) dependencies.push(dep(parsed.name, parsed.constraint, "runtime", relativePath, dir, project));
    else problems.push(`unreadable dependency: ${spec}`);
  }
  // Poetry keeps its own tables; read them when present rather than guessing
  // which convention a project uses.
  for (const [tableName, kind] of [
    ["tool.poetry.dependencies", "runtime"],
    ["tool.poetry.dev-dependencies", "dev"],
    ["tool.poetry.group.dev.dependencies", "dev"],
  ] as const) {
    const table = tables.get(tableName);
    if (!table) continue;
    for (const [name, entry] of table) {
      if (name.toLowerCase() === "python") continue;
      const version = typeof entry.scalar === "string" ? entry.scalar : (entry.table?.get("version")?.scalar ?? null);
      dependencies.push(dep(name, version, kind, relativePath, dir, project));
    }
  }

  const declared: ManifestRead["declared"] = [];
  const scripts = tables.get("project.scripts");
  const declaredScripts: ManifestScript[] = [];
  if (scripts) {
    for (const [name, entry] of scripts) {
      if (typeof entry.scalar === "string") {
        declaredScripts.push({ name, command: entry.scalar });
        // `name = "pkg.module:main"` names a module, not a file.
        const modulePath = entry.scalar.split(":")[0];
        if (modulePath) declared.push({ path: modulePath.split(".").join("/") + ".py", source: "pyproject.toml [project.scripts]", detail: name });
      }
    }
  }

  return {
    manifest: {
      path: relativePath,
      dir,
      project,
      ecosystem: "python-project",
      name: projectTable?.get("name")?.scalar ?? null,
      workspaces: [],
      scripts: declaredScripts,
      problems,
    },
    dependencies,
    declared,
  };
}

function parsePep508(spec: string): { name: string; constraint: string | null } | null {
  const m = spec.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*([<>=!~;].*)?$/);
  if (!m) return null;
  const constraint = (m[3] ?? "").trim();
  return { name: m[1]!, constraint: constraint.length > 0 ? constraint : null };
}

// ---- pnpm-workspace.yaml --------------------------------------------------

function readPnpmWorkspace(text: string, relativePath: string, dir: string, project: string): ManifestRead {
  const problems: string[] = [];
  const workspaces: string[] = [];
  // Deliberately narrow: pnpm-workspace.yaml's only fact this parser needs is
  // its `packages:` list, which is a flat sequence of quoted or bare strings.
  let inPackages = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, "");
    if (!line.trim()) continue;
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      const inline = line.replace(/^packages\s*:/, "").trim();
      if (inline.startsWith("[")) {
        for (const item of inline.replace(/^\[|\]$/g, "").split(",")) {
          const v = item.trim().replace(/^['"]|['"]$/g, "");
          if (v) workspaces.push(v);
        }
        inPackages = false;
      }
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s*-\s*(.+)$/);
      if (m) {
        const v = m[1]!.trim().replace(/^['"]|['"]$/g, "");
        if (v) workspaces.push(v);
        continue;
      }
      inPackages = false;
    }
  }
  // A pnpm-workspace.yaml with no `packages:` key is valid and common: it is
  // used only to hold pnpm settings. That is an empty workspace list, not a
  // file that failed to parse, so it is not reported as a problem.
  return {
    manifest: {
      path: relativePath,
      dir,
      project,
      ecosystem: "pnpm-workspace",
      name: null,
      workspaces,
      scripts: [],
      problems,
    },
    dependencies: [],
    declared: [],
  };
}

// ---- A small TOML reader --------------------------------------------------
//
// Enough TOML to read dependency tables, package names and path declarations
// out of Cargo.toml and pyproject.toml. It is not a full TOML implementation:
// it reads tables, array-of-tables headers, dotted keys, and scalar values,
// and it records what it could not parse instead of guessing. Values are kept
// as their raw text — nothing here needs to interpret a TOML value, only to
// carry it.

type TomlEntry = { scalar?: string; table?: Map<string, TomlEntry> };

type TomlTables = {
  /** Table name -> its entries. Nested tables are flattened to dotted names. */
  get: (name: string) => Map<string, TomlEntry> | undefined;
  /** Array-of-tables name -> each element's entries, in file order. */
  arrays: Map<string, Map<string, TomlEntry>[]>;
  problems: string[];
};

function parseTomlTables(text: string): TomlTables {
  const tables = new Map<string, Map<string, TomlEntry>>();
  const arrays = new Map<string, Map<string, TomlEntry>[]>();
  const problems: string[] = [];
  let current: Map<string, TomlEntry> | null = null;
  let currentName = "";

  const ensure = (name: string): Map<string, TomlEntry> => {
    const existing = tables.get(name);
    if (existing) return existing;
    const created = new Map<string, TomlEntry>();
    tables.set(name, created);
    return created;
  };

  for (const line of logicalLines(text, problems)) {
    const arrayHeader = line.match(/^\[\[(.+)\]\]$/);
    if (arrayHeader) {
      currentName = arrayHeader[1]!.trim();
      current = new Map<string, TomlEntry>();
      const list = arrays.get(currentName) ?? [];
      list.push(current);
      arrays.set(currentName, list);
      continue;
    }
    const tableHeader = line.match(/^\[(.+)\]$/);
    if (tableHeader) {
      currentName = tableHeader[1]!.trim();
      current = ensure(currentName);
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) {
      problems.push(`unreadable line: ${line}`);
      continue;
    }
    const key = line.slice(0, eq).trim().replace(/^['"]|['"]$/g, "");
    const rawValue = line.slice(eq + 1).trim();
    if (!key) {
      problems.push(`unreadable line: ${line}`);
      continue;
    }
    if (!current) {
      // A key before any table header belongs to the root table.
      currentName = "";
      current = ensure("");
    }

    if (rawValue.startsWith("{")) {
      // An inline table: `serde = { version = "1", features = [...] }`.
      const inner = rawValue.replace(/^\{|\}$/g, "");
      const table = new Map<string, TomlEntry>();
      for (const part of splitTopLevel(inner, ",")) {
        const at = part.indexOf("=");
        if (at === -1) continue;
        const k = part.slice(0, at).trim().replace(/^['"]|['"]$/g, "");
        const v = part.slice(at + 1).trim();
        if (k) table.set(k, { scalar: unquoteToml(v) });
      }
      current.set(key, { table });
      continue;
    }
    current.set(key, { scalar: unquoteToml(rawValue) });
  }

  return {
    get: (name) => tables.get(name),
    arrays,
    problems,
  };
}

/**
 * Joins a TOML document into logical lines: a value that opens a bracket, brace
 * or quote and does not close it on the same line continues onto the next.
 * Without this a multi-line array (`dependencies = [` … `]`) reads as one
 * broken line and every item in it is lost — which is exactly the shape PEP 621
 * dependency lists take.
 */
function logicalLines(text: string, problems: string[]): string[] {
  const out: string[] = [];
  let buffer: string | null = null;
  let depth = 0;
  let quote: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    // A comment ends the line, but only outside a string.
    const line = stripTomlComment(rawLine);
    const trimmed = line.trim();
    if (buffer === null) {
      if (!trimmed) continue;
      buffer = trimmed;
      depth = 0;
      quote = null;
    } else {
      if (!trimmed) continue;
      buffer += ` ${trimmed}`;
    }

    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quote) {
        if (ch === "\\" && quote === '"') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "[" || ch === "{" || ch === "(") depth++;
      else if (ch === "]" || ch === "}" || ch === ")") depth--;
    }

    // A table header is a complete line even though it is bracketed.
    const isHeader = /^\[\[?.+\]\]?$/.test(buffer);
    if (isHeader || (depth <= 0 && quote === null)) {
      out.push(buffer);
      buffer = null;
      depth = 0;
      quote = null;
    }
  }
  if (buffer !== null) {
    problems.push(`unterminated value: ${buffer.slice(0, 60)}`);
    out.push(buffer);
  }
  return out;
}

/** Removes a `#` comment, leaving `#` characters inside a quoted string alone. */
function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/** Splits on a separator that is not inside brackets, braces or quotes. */
function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{" || ch === "(") depth++;
    else if (ch === "]" || ch === "}" || ch === ")") depth--;
    else if (ch === separator && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

function unquoteToml(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Reads a TOML array literal such as `["a", "b"]` into its string items. */
function readTomlArray(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return [];
  return splitTopLevel(trimmed.replace(/^\[|\]$/g, ""), ",").map(unquoteToml).filter((s) => s.length > 0);
}

/**
 * Resolves a manifest-relative declared path to a repository-relative one.
 * `./dist/index.js` from a manifest in `packages/core` becomes
 * `packages/core/dist/index.js`. Paths that climb out of the repository are
 * kept as written with `..` collapsed, never silently rewritten to something
 * inside it.
 */
export function resolveManifestPath(dir: string, declared: string): string {
  const base = dir === "." ? "" : dir;
  const parts = `${base}/${declared}`.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0) stack.pop();
      else stack.push("..");
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
}

/**
 * Resolves a workspace glob to the directories it matches, given the set of
 * directories that actually hold a manifest. Only literal and single-star
 * segments are matched; anything more elaborate is left unmatched rather than
 * approximated. A glob prefixed with "!" negates: its matches are removed
 * from the result instead of added, so a manifest's exclusion list excludes.
 */
export function matchWorkspaceGlobs(globs: readonly string[], manifestDirs: readonly string[]): string[] {
  const out = new Set<string>();
  const negated = new Set<string>();
  for (const glob of globs) {
    const normalized = glob.replace(/^\.\//, "").replace(/\/$/, "");
    const negate = normalized.startsWith("!");
    const pattern = negate ? normalized.slice(1) : normalized;
    if (!pattern.includes("*")) {
      if (manifestDirs.includes(pattern)) (negate ? negated : out).add(pattern);
      continue;
    }
    const regex = new RegExp(
      `^${pattern
        .split("/")
        .map((segment) => (segment === "**" ? ".*" : segment === "*" ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("/")}$`,
    );
    for (const dir of manifestDirs) {
      if (regex.test(dir)) (negate ? negated : out).add(dir);
    }
  }
  for (const dir of negated) out.delete(dir);
  return [...out].sort();
}

/** The directory a repository-relative path sits in, "." for the root. */
export function dirOf(relativePath: string): string {
  const dir = path.posix.dirname(relativePath);
  return dir === "" ? "." : dir;
}
