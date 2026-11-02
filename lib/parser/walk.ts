import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fallbackAdapter } from "./adapters/fallback.ts";
import { selectAdapter, type FrameworkAdapter } from "./adapters/index.ts";
import { manifestEcosystemOf, readManifest, type ManifestRead } from "./manifests.ts";
import {
  classifyNonCodeFile,
  PRIMARY_MANIFEST_NAMES,
  type CandidateClassification,
  type NonCodeCandidate,
} from "./screening.ts";
import type { ExcludedDirectory, Project, SkippedFile } from "./types.ts";

export {
  classifyManifestBuffer,
  classifyNonCodeFile,
  PRIMARY_MANIFEST_NAMES,
  type CandidateClassification,
  type NonCodeCandidate,
  type NonCodeRejectReason,
  type NonCodeSkipReason,
} from "./screening.ts";

export const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const DECLARATION = /\.d\.(ts|mts|cts)$|\.d\.[^/.]+\.ts$/;

// Generated bundles and vendored blobs run past this; hand-written modules don't.
// A file over it is skipped and counted, never partially read.
export const MAX_FILE_BYTES = 1024 * 1024;

// Extensions a manifest can plausibly declare as an entry point but this
// parser does not index. Recording that these files exist is what lets an
// unresolved entry point say "not indexed" instead of "not found".
const DECLARABLE_EXTENSIONS = new Set([
  ".rs", ".go", ".py", ".rb", ".java", ".kt", ".cs", ".php", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".json", ".yaml", ".yml", ".toml", ".md", ".html", ".css", ".sh", ".ps1",
]);

export type CandidateFile = {
  path: string;
  absolutePath: string;
  module: string;
  content: string;
  bytes: number;
  lines: number;
  hash: string;
  reachedBy: string | null;
  /** Path of the project the file belongs to. */
  project: string;
};

export type WalkResult = {
  candidates: CandidateFile[];
  skipped: SkippedFile[];
  excludedDirectories: ExcludedDirectory[];
  /** Every code file seen, parsed or skipped. */
  found: number;
  /** Package names declared by package.json files inside the repository. */
  workspacePackages: Set<string>;
  projects: Project[];
  /** Each project's adapter, by project path. */
  adapters: Map<string, FrameworkAdapter>;
  /** The project of every file found, parsed or skipped. */
  projectOf: Map<string, string>;
  /** Every manifest read during the walk, with the facts only it can state. */
  manifests: ManifestRead[];
  /** Repository-relative directories that hold at least one manifest. */
  manifestDirs: string[];
  /**
   * Repository-relative paths of files the walk saw but did not index because
   * they are not a code file this parser reads (a Rust source, a Python
   * module, a build output). Bounded: only files whose extension a manifest
   * ecosystem could plausibly declare are recorded, so this stays a small set.
   */
  otherFiles: Set<string>;
  /** Approved, screened non-code candidates (e.g. primary manifests). */
  nonCodeCandidates: NonCodeCandidate[];
  /** Structured classification decisions for non-code files encountered. */
  nonCodeClassifications: CandidateClassification[];
};

type CurrentProject = { path: string; adapter: FrameworkAdapter };

// Paths handed to an adapter are relative to its project.
export function withinProject(project: string, relativePath: string): string {
  return project === "." ? relativePath : relativePath.slice(project.length + 1);
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export function isCodeFile(p: string): boolean {
  return CODE_EXTENSIONS.includes(path.extname(p));
}

export function isDeclarationFile(p: string): boolean {
  return DECLARATION.test(p);
}

// The module is the containing folder: the finest grouping that is a fact
// about the repository rather than a judgement about it.
export function moduleOf(relativePath: string): string {
  const dir = path.posix.dirname(relativePath);
  return dir === "" ? "." : dir;
}

// The parser's line numbering, the one files.lines uses. Every line-number
// consumer in the repository (the read service among them) counts this way,
// so there is exactly one convention to keep in step with. An empty file
// has no lines; a final newline ends the last line rather than beginning an
// empty one.
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  const breaks = content.split("\n").length;
  return content.endsWith("\n") ? breaks - 1 : breaks;
}

function genericExclusion(name: string): string | null {
  if (name === "node_modules") return "dependency directory";
  if (name.startsWith(".")) return "dot-directory";
  return null;
}

export function walkRepository(root: string): WalkResult {
  const result: WalkResult = {
    candidates: [],
    skipped: [],
    excludedDirectories: [],
    found: 0,
    workspacePackages: new Set(),
    projects: [],
    adapters: new Map(),
    projectOf: new Map(),
    manifests: [],
    manifestDirs: [],
    otherFiles: new Set(),
    nonCodeCandidates: [],
    nonCodeClassifications: [],
  };

  const within = (project: CurrentProject, relativePath: string) => withinProject(project.path, relativePath);

  const visit = (absoluteDir: string, parent: CurrentProject | null): void => {
    const entries = readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    // The root is always a project. Below it, a package.json starts one only
    // when a framework is detected there; otherwise the folder stays in its
    // parent's project and keeps its conventions.
    // Early screening gate: a package.json that is not an eligible candidate
    // (e.g. secret detected, sensitive path, oversized, binary) is blocked from
    // framework adapter detection and workspace package name emission.
    let project = parent;
    const manifestEntry = entries.find((entry) => entry.isFile() && entry.name === "package.json");
    let safePkg: { name: string | null; dependencies: Set<string> } | null = null;
    if (manifestEntry) {
      const manifestPath = toPosix(path.relative(root, path.join(absoluteDir, manifestEntry.name)));
      const absPath = path.join(absoluteDir, manifestEntry.name);
      const check = classifyNonCodeFile(absPath, manifestPath);
      if (check.status === "eligible") {
        safePkg = readPackage(absPath);
      }
    }
    if (!parent || safePkg) {
      if (safePkg?.name) result.workspacePackages.add(safePkg.name);
      const adapter = selectAdapter({ dir: absoluteDir, dependencies: safePkg?.dependencies ?? new Set() });
      if (!parent || adapter !== fallbackAdapter) {
        project = { path: toPosix(path.relative(root, absoluteDir)) || ".", adapter };
        result.projects.push({ path: project.path, adapter: adapter.name });
        result.adapters.set(project.path, adapter);
      }
    }
    if (!project) throw new Error(`No project for ${absoluteDir}`);

    // Every manifest this directory holds, whatever ecosystem it belongs to.
    // Screened first before candidate approval or newly exposed metadata.
    const dirPath = toPosix(path.relative(root, absoluteDir)) || ".";
    for (const entry of entries) {
      const manifestPath = toPosix(path.relative(root, path.join(absoluteDir, entry.name)));
      const absPath = path.join(absoluteDir, entry.name);

      if (entry.isSymbolicLink() && PRIMARY_MANIFEST_NAMES.has(entry.name)) {
        result.nonCodeClassifications.push({
          status: "skipped",
          path: manifestPath,
          reason: "symlink",
          detail: "symbolic link not followed",
        });
        continue;
      }

      if (!entry.isFile()) continue;
      const ecosystem = manifestEcosystemOf(entry.name);
      if (ecosystem === null) continue;

      const classification = classifyNonCodeFile(absPath, manifestPath);
      result.nonCodeClassifications.push(classification);

      if (classification.status === "eligible") {
        result.nonCodeCandidates.push({
          path: manifestPath,
          absolutePath: absPath,
          module: dirPath,
          content: classification.content,
          bytes: classification.bytes,
          lines: classification.lines,
          hash: classification.hash,
          project: project.path,
          category: "primary_manifest",
        });
        result.manifests.push(readManifest(absPath, manifestPath, dirPath, project.path, ecosystem));
        if (!result.manifestDirs.includes(dirPath)) result.manifestDirs.push(dirPath);
      } else {
        // Fail closed for all non-eligible manifests (rejected or skipped):
        // Neither rejected nor oversized/binary/invalid-utf8 manifests reach readManifest.
        // No dependencies, scripts, workspaces, entry points, or metadata can be extracted.
        result.manifests.push({
          manifest: {
            path: manifestPath,
            dir: dirPath,
            project: project.path,
            ecosystem,
            name: null,
            workspaces: [],
            scripts: [],
            problems: [`security-screening-${classification.status}: ${classification.reason}`],
          },
          dependencies: [],
          declared: [],
        });
        if (!result.manifestDirs.includes(dirPath)) result.manifestDirs.push(dirPath);
      }
    }

    for (const entry of entries) {
      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = toPosix(path.relative(root, absolutePath));

      if (entry.isDirectory()) {
        const reason = genericExclusion(entry.name) ?? project.adapter.excludeDirectory(within(project, relativePath));
        if (reason) {
          result.excludedDirectories.push({ path: relativePath, reason });
          continue;
        }
        visit(absolutePath, project);
        continue;
      }

      if (entry.isSymbolicLink()) {
        // Following links can leave the repository or loop; neither is walked.
        const target = safeStat(absolutePath);
        if (target === "directory") {
          result.excludedDirectories.push({ path: relativePath, reason: "symbolic link" });
        } else if (isCodeFile(entry.name)) {
          result.found++;
          result.projectOf.set(relativePath, project.path);
          result.skipped.push({ path: relativePath, reason: "symlink", detail: "symbolic link not followed" });
        }
        continue;
      }

      if (!entry.isFile() || !isCodeFile(entry.name)) {
        // A file a manifest could name but this parser does not index is
        // remembered, so an entry point that points at it can say "not
        // indexed" rather than "not found". Those are different facts.
        if (entry.isFile() && DECLARABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          result.otherFiles.add(relativePath);
        }
        continue;
      }
      result.found++;
      result.projectOf.set(relativePath, project.path);

      if (isDeclarationFile(entry.name)) {
        result.skipped.push({ path: relativePath, reason: "declaration-file", detail: "types only, no runtime imports" });
        continue;
      }

      const candidate = readCandidate(absolutePath, relativePath, project.path, project.adapter.reachedBy(within(project, relativePath)));
      if ("reason" in candidate) result.skipped.push(candidate);
      else result.candidates.push(candidate);
    }
  };

  visit(root, null);
  return result;
}

function safeStat(absolutePath: string): "directory" | "file" | "missing" {
  const stat = statSync(absolutePath, { throwIfNoEntry: false });
  if (!stat) return "missing";
  return stat.isDirectory() ? "directory" : "file";
}

function readPackage(absolutePath: string): { name: string | null; dependencies: Set<string> } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch {
    // An unreadable package.json declares nothing; it isn't a code file, so it isn't counted.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const dependencies = new Set<string>();
  for (const field of ["dependencies", "devDependencies"]) {
    const block: unknown = field in parsed ? Reflect.get(parsed, field) : undefined;
    if (typeof block === "object" && block !== null) for (const name of Object.keys(block)) dependencies.add(name);
  }
  const name = "name" in parsed && typeof parsed.name === "string" ? parsed.name : null;
  return { name, dependencies };
}

function readCandidate(
  absolutePath: string,
  relativePath: string,
  project: string,
  reachedBy: string | null,
): CandidateFile | SkippedFile {
  let buffer: Buffer;
  try {
    buffer = readFileSync(absolutePath);
  } catch (error) {
    return { path: relativePath, reason: "unreadable", detail: error instanceof Error ? error.message : String(error) };
  }
  if (buffer.byteLength > MAX_FILE_BYTES) {
    return {
      path: relativePath,
      reason: "too-large",
      detail: `${buffer.byteLength} bytes, limit ${MAX_FILE_BYTES}`,
    };
  }
  if (buffer.includes(0)) {
    return { path: relativePath, reason: "binary", detail: "contains NUL bytes" };
  }
  const content = buffer.toString("utf8");
  return {
    path: relativePath,
    absolutePath,
    module: moduleOf(relativePath),
    content,
    bytes: buffer.byteLength,
    lines: countLines(content),
    hash: createHash("sha256").update(buffer).digest("hex"),
    reachedBy,
    project,
  };
}
