// Entry points: where execution starts, and what a package exposes.
//
// The distinction this module exists to preserve is declared versus inferred.
//
//  - Declared: a manifest names the file. `main`, `exports`, `bin`, Cargo's
//    `[lib] path`, a Python console script. The repository said so.
//  - Inferred: a structural convention says so — a framework route handler, a
//    Go file that declares `package main`, a Rust `src/main.rs` beside a
//    Cargo.toml, an `index` file at a package root.
//
// They are reported separately and never merged, because they carry different
// weight: a declared entry that does not resolve to a file the parser indexed
// is a real fact about the repository (the file is a build output, or outside
// the walked set), while an inferred entry is a convention that may simply be
// wrong for this repository.
//
// Nothing here reads the question being asked. Entry points come from the
// repository's own structure.

import type { Edge, EntryPoint, Manifest, Route } from "./types.ts";
import { resolveManifestPath } from "./manifests.ts";

/** How far a re-export chain is followed from one entry point. */
const MAX_CHAIN_DEPTH = 6;
/** How many files one entry point's re-export chain may name. */
const MAX_CHAIN_FILES = 40;

export type EntryInputs = {
  /** Every manifest read, with its declared entry paths already resolved. */
  declared: { path: string; source: string; manifest: string; detail?: string }[];
  /** Repository-relative paths of every file this parse indexed. */
  files: readonly string[];
  /** Files that exist but are not code this parser indexes. */
  otherFiles: ReadonlySet<string>;
  /** Repository-relative path -> the file's source text, for convention checks. */
  textOf: ReadonlyMap<string, string>;
  /** Routes the framework adapters recognised. */
  routes: readonly Route[];
  /** Every edge, for following re-export chains. */
  edges: readonly Edge[];
  /** Repository-relative directories that hold a manifest. */
  packageDirs: readonly string[];
};

/**
 * Builds the entry-point list. Declared entries come first, then inferred
 * ones, each group sorted so the output is stable.
 */
export function discoverEntryPoints(input: EntryInputs): EntryPoint[] {
  const fileSet = new Set(input.files);
  const entries: EntryPoint[] = [];

  // ---- Declared ----
  const declaredSeen = new Set<string>();
  for (const d of input.declared) {
    const key = `${d.path}\0${d.source}\0${d.detail ?? ""}`;
    if (declaredSeen.has(key)) continue;
    declaredSeen.add(key);
    const resolved = fileSet.has(d.path);
    entries.push({
      path: d.path,
      kind: "declared",
      source: d.source,
      manifest: d.manifest,
      ...(d.detail !== undefined ? { detail: d.detail } : {}),
      resolved,
      // An entry pointing at a file that exists but is not indexed is a
      // different fact from one pointing at nothing. Neither is dropped.
      ...(resolved ? {} : { unresolvedReason: input.otherFiles.has(d.path) ? ("not-indexed" as const) : ("not-found" as const) }),
    });
  }

  // ---- Inferred ----
  const inferred: EntryPoint[] = [];
  const inferredSeen = new Set<string>();
  const addInferred = (path: string, source: string, detail?: string) => {
    // A file a manifest already declared is not also an inference: the
    // stronger fact wins and the weaker one would only add noise.
    if (declaredSeen.has(`${path}\0${source}\0${detail ?? ""}`)) return;
    if (entries.some((e) => e.path === path && e.kind === "declared")) return;
    const key = `${path}\0${source}`;
    if (inferredSeen.has(key)) return;
    inferredSeen.add(key);
    inferred.push({
      path,
      kind: "inferred",
      source,
      manifest: null,
      ...(detail !== undefined ? { detail } : {}),
      resolved: fileSet.has(path),
    });
  };

  // Framework route handlers: a file the adapter gave a route to is a place
  // the framework reaches, whatever its name.
  for (const route of input.routes) {
    addInferred(route.file, "framework route", `${route.method} ${route.pattern}`);
  }

  // Go: a file whose package clause is `main` is an executable entry point.
  // This is the language's own rule, not a repository's convention.
  for (const file of input.files) {
    if (!file.endsWith(".go")) continue;
    const text = input.textOf.get(file);
    if (text === undefined) continue;
    if (/^\s*package\s+main\b/m.test(text)) addInferred(file, "go package main");
  }

  // Rust: beside a Cargo.toml, src/main.rs is the binary and src/lib.rs the
  // library. Both are Cargo's documented defaults.
  for (const dir of input.packageDirs) {
    const base = dir === "." ? "" : `${dir}/`;
    for (const [name, source] of [
      ["src/main.rs", "cargo default binary"],
      ["src/lib.rs", "cargo default library"],
    ] as const) {
      const candidate = `${base}${name}`;
      if (fileSet.has(candidate)) addInferred(candidate, source);
    }
  }

  // Python: `__main__.py` makes a package runnable; `manage.py` and `app.py`
  // are not inferred here — they are names, not rules.
  for (const file of input.files) {
    if (file === "__main__.py" || file.endsWith("/__main__.py")) addInferred(file, "python __main__ module");
  }

  // Package roots: an index/main file at the top of a package directory is
  // what a consumer of that package reaches first. Only at a package root —
  // an index file deep inside a folder is a barrel, not an entry point.
  for (const dir of input.packageDirs) {
    const base = dir === "." ? "" : `${dir}/`;
    for (const stem of ["index", "main", "mod"]) {
      for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go"]) {
        const candidate = `${base}${stem}${ext}`;
        if (fileSet.has(candidate)) addInferred(candidate, "package root module");
      }
    }
  }

  // ---- Re-export chains ----
  // What a package exposes is its entry file plus everything that entry file
  // re-exports, transitively. Only re-export edges are followed: an ordinary
  // import is a dependency, not part of the public surface.
  const reExports = new Map<string, string[]>();
  for (const edge of input.edges) {
    if (edge.kind !== "re-export") continue;
    const list = reExports.get(edge.source) ?? [];
    if (!list.includes(edge.target)) list.push(edge.target);
    reExports.set(edge.source, list);
  }
  const withChains = [...entries, ...inferred].map((entry) => {
    const via = reExportChain(entry.path, reExports, fileSet);
    return via.length > 0 ? { ...entry, via } : entry;
  });

  const order = (a: EntryPoint, b: EntryPoint) =>
    a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind) || a.source.localeCompare(b.source) || (a.detail ?? "").localeCompare(b.detail ?? "");
  return withChains.sort(order);
}

/**
 * Breadth-first walk of re-export edges from one file, bounded in both depth
 * and size. The entry file itself is not included: `via` is what the entry
 * passes on, not the entry.
 */
function reExportChain(start: string, reExports: ReadonlyMap<string, string[]>, fileSet: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let depth = 0; depth < MAX_CHAIN_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const target of reExports.get(file) ?? []) {
        if (seen.has(target) || !fileSet.has(target)) continue;
        seen.add(target);
        out.push(target);
        next.push(target);
        if (out.length >= MAX_CHAIN_FILES) return out;
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Turns a manifest's declared entry paths into repository-relative ones, and
 * drops the ones that name no file at all (a bare module specifier, a URL).
 * A path that resolves to a file the parser did not index is kept: it is a
 * declaration that did not resolve, which is itself worth knowing.
 */
export function resolveDeclaredEntries(
  manifest: Manifest,
  declared: readonly { path: string; source: string; detail?: string }[],
): { path: string; source: string; manifest: string; detail?: string }[] {
  const out: { path: string; source: string; manifest: string; detail?: string }[] = [];
  for (const d of declared) {
    const raw = d.path.trim();
    if (!raw) continue;
    // A URL or a bare specifier is not a path in this repository.
    if (/^[a-z]+:\/\//i.test(raw)) continue;
    // Python console scripts name a module ("pkg.module:main"), which the
    // reader has already turned into a path; anything still carrying a colon
    // is not a file path.
    if (raw.includes(":")) continue;
    const resolved = resolveManifestPath(manifest.dir, raw);
    if (!resolved) continue;
    out.push({
      path: resolved,
      source: d.source,
      manifest: manifest.path,
      ...(d.detail !== undefined ? { detail: d.detail } : {}),
    });
  }
  return out;
}
