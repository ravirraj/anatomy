import { statSync } from "node:fs";
import path from "node:path";
import { Project, ts } from "ts-morph";
import { extractCalls, extractExports, extractImportBindings, extractImports, extractSymbols } from "./extract.ts";
import { dedupeEdges, fanCounts } from "./graph.ts";
import { createResolver } from "./resolve.ts";
import { dedupeConfigReferences, scanConfigObjects, scanEnvTemplates, scanSourceConfig } from "./config.ts";
import { discoverEntryPoints, resolveDeclaredEntries } from "./entries.ts";
import {
  SCHEMA_VERSION,
  type Coverage,
  type Dependency,
  type Edge,
  type ImportStatus,
  type ParseResult,
  type ParsedFile,
  type ParsedSymbol,
  type Route,
  type SkippedFile,
  type StatusCounts,
} from "./types.ts";
import type { Role } from "../roles.ts";
import type { AdapterFile } from "./adapters/types.ts";
import { buildFrameworkView, type ViewSourceEntry } from "./adapters/view.ts";
import { walkRepository, withinProject, type WalkResult } from "./walk.ts";

export type Selection = { root: string; walk: WalkResult };

export function parseRepository(directory: string): ParseResult {
  return parseSelection(selectFiles(directory));
}

// Selecting and parsing are separate calls so a caller can report which one
// it's in; together they are exactly parseRepository.
export function selectFiles(directory: string): Selection {
  const root = path.resolve(directory);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Not a directory: ${root}`);
  }
  return { root, walk: walkRepository(root) };
}

export function parseSelection({ root, walk }: Selection): ParseResult {

  // Parsing only: no lib, no type resolution. Imports are resolved separately
  // so every outcome can be classified rather than left to the compiler.
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, noLib: true, noResolve: true, types: [] },
  });
  const sourceFiles = walk.candidates.map((candidate) => ({
    candidate,
    sourceFile: project.createSourceFile(candidate.absolutePath, candidate.content, { overwrite: true }),
  }));
  const program = project.getProgram();

  const skipped: SkippedFile[] = [...walk.skipped];
  const parsed: typeof sourceFiles = [];
  for (const entry of sourceFiles) {
    const [first, ...rest] = program.getSyntacticDiagnostics(entry.sourceFile);
    if (!first) {
      parsed.push(entry);
      continue;
    }
    // A file that doesn't parse cleanly would give a partial import list. Absent beats approximate.
    const message = ts.flattenDiagnosticMessageText(first.compilerObject.messageText, " ");
    skipped.push({
      path: entry.candidate.path,
      reason: "syntax-error",
      detail: `line ${first.getLineNumber() ?? "?"}: ${message}${rest.length ? ` (+${rest.length} more)` : ""}`,
    });
  }
  skipped.sort((a, b) => a.path.localeCompare(b.path));

  const resolver = createResolver({
    root,
    nodes: new Set(parsed.map((entry) => entry.candidate.path)),
    skipped: new Map(skipped.map((file) => [file.path, file])),
    excludedDirectories: walk.excludedDirectories,
    workspacePackages: walk.workspacePackages,
  });

  const coverage: Coverage["imports"] = {
    total: emptyCounts(),
    byKind: { import: emptyCounts(), "re-export": emptyCounts(), "dynamic-import": emptyCounts(), require: emptyCounts(), call: emptyCounts() },
    external: { package: 0, builtin: 0, "outside-root": 0 },
    excluded: {},
    unresolvedByReason: {},
    unresolved: [],
  };
  const rawEdges: Edge[] = [];
  const exportsOf = new Map<string, string[]>();
  const symbolsOf = new Map<string, Omit<ParsedSymbol, "file">[]>();
  // local binding name -> { target file, imported name } for internal imports
  const importMaps = new Map<string, Map<string, { target: string; imported: string }>>();

  for (const { candidate, sourceFile } of parsed) {
    exportsOf.set(candidate.path, extractExports(sourceFile));
    symbolsOf.set(candidate.path, extractSymbols(sourceFile));

    // Resolve imported binding names to their target files (for call resolution).
    const imap = new Map<string, { target: string; imported: string }>();
    for (const b of extractImportBindings(sourceFile)) {
      const outcome = resolver.resolve(candidate.absolutePath, b.specifier, "import");
      if (outcome.status === "internal") {
        imap.set(b.local, { target: outcome.target, imported: b.imported });
      }
    }
    importMaps.set(candidate.path, imap);

    for (const found of extractImports(sourceFile)) {
      const specifier = found.literal ? found.specifier : found.expression;
      const outcome: ImportStatus = found.literal
        ? resolver.resolve(candidate.absolutePath, found.specifier, found.kind)
        : {
            status: "unresolved",
            reason: found.kind === "require" ? "non-literal-require" : "non-literal-dynamic-import",
            detail: "the path is computed at runtime",
          };

      coverage.total.seen++;
      coverage.byKind[found.kind].seen++;
      coverage.total[outcome.status]++;
      coverage.byKind[found.kind][outcome.status]++;

      switch (outcome.status) {
        case "internal":
          rawEdges.push({
            source: candidate.path,
            target: outcome.target,
            kind: found.kind,
            typeOnly: found.typeOnly,
            specifier,
            line: found.line,
          });
          break;
        case "external":
          coverage.external[outcome.external]++;
          break;
        case "excluded":
          coverage.excluded[outcome.reason] = (coverage.excluded[outcome.reason] ?? 0) + 1;
          break;
        case "unresolved":
          coverage.unresolvedByReason[outcome.reason] = (coverage.unresolvedByReason[outcome.reason] ?? 0) + 1;
          coverage.unresolved.push({
            from: candidate.path,
            specifier,
            kind: found.kind,
            line: found.line,
            reason: outcome.reason,
            detail: outcome.detail,
          });
          break;
      }
    }
  }

  // ---- Call relationships (Phase 3) ----
  const callCoverage: { total: number; resolved: number; unresolved: number; unresolvedCalls: { from: string; callee: string; line: number; reason: string }[] } = {
    total: 0,
    resolved: 0,
    unresolved: 0,
    unresolvedCalls: [],
  };

  for (const { candidate, sourceFile } of parsed) {
    const callSites = extractCalls(sourceFile);
    const symbols = symbolsOf.get(candidate.path) ?? [];
    const imap = importMaps.get(candidate.path) ?? new Map();
    // Helper: find the enclosing symbol for a line.
    const enclosingSymbol = (line: number): (typeof symbols)[number] | undefined =>
      symbols.find((s) => s.line <= line && (s.endLine ?? s.line) >= line);

    for (const site of callSites) {
      callCoverage.total++;
      const callee = site.callee.trim();
      // Resolve callee to a target file.
      let targetFile: string | null = null;
      let resolvedSymbolName: string | null = null;

      // Constructor / simple identifier / member expression base.
      const isMember = callee.includes(".");
      const baseName = isMember ? callee.split(".")[0]! : callee;
      const memberName = isMember ? callee.split(".").slice(1).join(".") : null;

      // 1. Local symbol in the same file.
      if (!isMember && symbols.some((s) => s.name === baseName)) {
        targetFile = candidate.path;
        resolvedSymbolName = baseName;
      }

      // 2. Imported binding.
      if (!targetFile) {
        const imp = imap.get(baseName);
        if (imp) {
          targetFile = imp.target;
          // Determine the exported name in the target.
          const targetExports = exportsOf.get(targetFile as string) ?? [];
          if (memberName) {
            if (targetExports.includes(memberName)) resolvedSymbolName = memberName;
            else resolvedSymbolName = memberName; // best-effort
          } else {
            const importedName = imp.imported;
            resolvedSymbolName = importedName === "default" ? "default" : importedName;
            // If target doesn't export it, mark unresolved.
            if (importedName !== "*" && importedName !== "default" && !targetExports.includes(importedName)) {
              targetFile = null;
            }
          }
        }
      }

      // 3. Namespace import member: ns.method()
      if (!targetFile && isMember) {
        const imp = imap.get(baseName);
        if (imp && imp.imported === "*") {
          targetFile = imp.target;
          const targetExports = exportsOf.get(targetFile as string) ?? [];
          if (memberName && targetExports.includes(memberName)) {
            resolvedSymbolName = memberName;
          } else if (memberName) {
            resolvedSymbolName = memberName;
          } else {
            targetFile = null;
          }
        }
      }

      if (targetFile && targetFile !== candidate.path) {
        // cross-file: ensure target exists in parsed files
        if (!exportsOf.has(targetFile as string)) targetFile = null;
      }

      if (targetFile) {
        callCoverage.resolved++;
        // Only cross-file calls become graph edges; intra-file calls are
        // recorded in coverage but do not create a file-level edge.
        if (targetFile !== candidate.path) {
          rawEdges.push({
            source: candidate.path,
            target: targetFile,
            kind: "call",
            typeOnly: false,
            specifier: callee,
            line: site.line,
          });
        }
      } else {
        callCoverage.unresolved++;
        callCoverage.unresolvedCalls.push({
          from: candidate.path,
          callee,
          line: site.line,
          reason: "unresolved-call",
        });
      }
    }
  }

  const edges = dedupeEdges(rawEdges);
  const paths = parsed.map((entry) => entry.candidate.path);
  const fan = fanCounts(paths, edges);

  // ---- Phase 4: packaging, configuration and entry points ----
  // Everything below is read from what the walk already collected plus the
  // parsed text. No second filesystem pass, no question text, no model.
  const conventions = applyAdapters(walk, parsed, skipped, resolver);

  const manifests = walk.manifests.map((m) => m.manifest);
  const dependencies = countDependencyImports(
    walk.manifests.flatMap((m) => m.dependencies),
    bareSpecifiersByFile(parsed, resolver),
    walk.projectOf,
  );

  const declaredEntries = walk.manifests.flatMap((m) => resolveDeclaredEntries(m.manifest, m.declared));
  const textOf = new Map(parsed.map(({ candidate, sourceFile }) => [candidate.path, sourceFile.getFullText()]));
  const entryPoints = discoverEntryPoints({
    declared: declaredEntries,
    files: paths,
    otherFiles: walk.otherFiles,
    textOf,
    routes: conventions.routes,
    edges,
    packageDirs: walk.manifestDirs,
  });

  const configReferences = dedupeConfigReferences([
    ...parsed.flatMap(({ candidate, sourceFile }) => {
      const text = sourceFile.getFullText();
      return [...scanSourceConfig(candidate.path, text), ...scanConfigObjects(candidate.path, text)];
    }),
    ...scanEnvTemplates(root).references,
  ]);
  const envDeclarations = scanEnvTemplates(root).declarations;

  const symbols = paths
    .flatMap((file) => (symbolsOf.get(file) ?? []).map((s) => ({ ...s, file })))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const files: ParsedFile[] = parsed
    .map(({ candidate }) => ({
      path: candidate.path,
      module: candidate.module,
      lines: candidate.lines,
      bytes: candidate.bytes,
      hash: candidate.hash,
      fanIn: fan.get(candidate.path)?.fanIn ?? 0,
      fanOut: fan.get(candidate.path)?.fanOut ?? 0,
      reachedBy: candidate.reachedBy,
      role: conventions.roles.get(candidate.path) ?? null,
      exports: exportsOf.get(candidate.path) ?? [],
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (files.length + skipped.length !== walk.found) {
    throw new Error(`Coverage doesn't add up: found ${walk.found}, parsed ${files.length}, skipped ${skipped.length}`);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    root,
    projects: walk.projects,
    files,
    edges,
    routes: conventions.routes,
    symbols,
    manifests,
    dependencies,
    configReferences,
    envDeclarations,
    entryPoints,
    coverage: {
      files: {
        found: walk.found,
        parsed: files.length,
        skipped: skipped.length,
        skippedFiles: skipped,
        excludedDirectories: walk.excludedDirectories,
      },
      imports: coverage,
      routes: { omitted: conventions.omitted, withheld: conventions.withheld },
      calls: callCoverage,
    },
    configs: resolver.configs(),
    nonCodeCandidates: walk.nonCodeCandidates,
  };
}

/**
 * Bare package specifiers each parsed file imports, keyed by file path. Built
 * from the resolver's own classification so a specifier counts as a package
 * only when the resolver said it was one: a relative path, an alias, a
 * workspace link and a Node builtin are all excluded by construction.
 */
function bareSpecifiersByFile(
  parsed: readonly { candidate: { path: string; absolutePath: string }; sourceFile: AdapterFile["source"] }[],
  resolver: ReturnType<typeof createResolver>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { candidate, sourceFile } of parsed) {
    const packages = new Set<string>();
    for (const found of extractImports(sourceFile)) {
      if (!found.literal) continue;
      const outcome = resolver.resolve(candidate.absolutePath, found.specifier, found.kind);
      if (outcome.status !== "external" || outcome.external !== "package") continue;
      const name = packageNameOf(found.specifier);
      if (name) packages.add(name);
    }
    if (packages.size > 0) out.set(candidate.path, packages);
  }
  return out;
}

/**
 * The package a bare specifier names: "@scope/pkg/sub/path" -> "@scope/pkg",
 * "pkg/sub" -> "pkg". A specifier that names no package (an empty string, a
 * bare "@scope") yields null rather than a guess.
 */
export function packageNameOf(specifier: string): string | null {
  const clean = specifier.split("?")[0]!.trim();
  if (!clean || clean.startsWith(".") || clean.startsWith("/")) return null;
  const parts = clean.split("/");
  if (clean.startsWith("@")) {
    return parts.length >= 2 && parts[0] && parts[1] ? `${parts[0]}/${parts[1]}` : null;
  }
  return parts[0] || null;
}

/**
 * Records, for each declared dependency, how many parsed files import that
 * package by bare specifier. This is reachability from indexed source, not
 * usage proof: a dependency nothing imports may still be used by a config
 * file, a CLI, a script or a file the parser skipped.
 *
 * Counts are per project, so a monorepo's two packages never borrow each
 * other's imports: a dependency declared by packages/web is counted against
 * packages/web's files only.
 */
function countDependencyImports(
  dependencies: readonly Dependency[],
  importsByFile: ReadonlyMap<string, Set<string>>,
  projectOfFile: ReadonlyMap<string, string>,
): Dependency[] {
  const byProject = new Map<string, Map<string, number>>();
  for (const [file, packages] of importsByFile) {
    const project = projectOfFile.get(file) ?? ".";
    const forProject = byProject.get(project) ?? new Map<string, number>();
    for (const pkg of packages) forProject.set(pkg, (forProject.get(pkg) ?? 0) + 1);
    byProject.set(project, forProject);
  }
  return dependencies.map((d) => ({
    ...d,
    importedBy: byProject.get(d.project)?.get(d.name) ?? 0,
  }));
}

// Each project's adapter is asked about its own files, by project-relative
// path, and what it answers is mapped back to repository paths. Roles are read
// off the project's FrameworkView, built once per project and handed to
// roleOf; routes still receive the AdapterFile syntax trees, which route
// detection reads until it migrates to the view.
function applyAdapters(
  walk: WalkResult,
  parsed: readonly { candidate: { path: string; project: string; absolutePath: string }; sourceFile: AdapterFile["source"] }[],
  skipped: readonly SkippedFile[],
  resolver: ReturnType<typeof createResolver>,
) {
  const roles = new Map<string, Role>();
  const routes: Route[] = [];
  const omitted: Coverage["routes"]["omitted"] = [];
  const withheld: Coverage["routes"]["withheld"] = [];

  for (const [project, adapter] of walk.adapters) {
    const toRepo = (p: string) => (project === "." ? p : `${project}/${p}`);
    const files: AdapterFile[] = [];
    const entries: ViewSourceEntry[] = [];
    for (const { candidate, sourceFile } of parsed) {
      if (candidate.project !== project) continue;
      files.push({ path: withinProject(project, candidate.path), source: sourceFile });
      // `parsed` is in the walker's own order (walk.candidates), so the rank
      // this project's files reach here IS the original walk order — recorded
      // on the view entry, whose files array is sorted by path.
      entries.push({
        path: candidate.path,
        absolutePath: candidate.absolutePath,
        source: sourceFile,
        walkOrder: entries.length,
      });
    }
    const view = buildFrameworkView({
      project,
      files: entries,
      skipped: skipped.filter((f) => walk.projectOf.get(f.path) === project),
      resolveSpecifier: resolver.resolve,
    });
    for (const file of view.files) {
      const role = adapter.roleOf(file);
      if (role) roles.set(toRepo(file.path), role);
    }
    // A declaration file has no runtime code, so it can't hold anything an adapter reads.
    const unparsed = skipped
      .filter((f) => f.reason !== "declaration-file" && walk.projectOf.get(f.path) === project)
      .map((f) => withinProject(project, f.path));

    // Adapters migrate to the view one at a time: when an adapter answers over
    // the view it reads the same instance roleOf read, so one build per
    // project serves both; the rest still read the source trees until their
    // migration batches land (NestJS 3.3b, Next.js 3.3c).
    const report = adapter.routesFromView
      ? adapter.routesFromView(view, unparsed)
      : adapter.routes({ files, unparsed });
    if (report.withheld !== null) {
      withheld.push({ project, reason: report.withheld });
      continue;
    }
    for (const r of report.routes) routes.push({ file: toRepo(r.path), method: r.method, pattern: r.pattern, line: r.line });
    for (const o of report.omitted) omitted.push({ file: toRepo(o.path), line: o.line, reason: o.reason });
  }

  // An array of paths on a decorator can name the same one twice.
  const unique = new Map(routes.map((r) => [`${r.method} ${r.pattern} ${r.file}`, r]));
  return {
    roles,
    routes: [...unique.values()].sort(
      (a, b) => a.pattern.localeCompare(b.pattern) || a.method.localeCompare(b.method) || a.file.localeCompare(b.file),
    ),
    omitted: omitted.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    withheld,
  };
}

function emptyCounts(): StatusCounts {
  return { seen: 0, internal: 0, external: 0, excluded: 0, unresolved: 0 };
}

export type * from "./types.ts";
