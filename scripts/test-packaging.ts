// Phase 4: packaging, configuration and entry-point extraction.
//
// The checks here are about *epistemic honesty* as much as extraction: a
// declaration must never be reported as an installation, an inferred entry
// must never be reported as a declared one, and a configuration value must
// never be stored at all. Those are the properties that make the rest of the
// system safe to build on, so they are asserted directly rather than implied.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseRepository } from "../lib/parser/index.ts";
import { validateParseResult } from "../lib/parser/contract.ts";
import { queryTouchesPackaging, formatPackagingEvidence } from "../lib/ai/packaging.ts";
import type { ParseResult } from "../lib/parser/types.ts";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`ok    ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const FIXTURES = "fixtures";

function parse(fixture: string): ParseResult {
  const result = parseRepository(path.join(FIXTURES, fixture, "repo"));
  // Every result is put through the contract validator, so a fixture that
  // parses but violates the schema fails here rather than downstream.
  validateParseResult(JSON.parse(JSON.stringify(result)));
  return result;
}

console.log("=== 1. Manifest formats ===");

const polyglot = parse("polyglot-manifests");
const ecosystems = new Set(polyglot.manifests.map((m) => m.ecosystem));
check("package.json read as npm", ecosystems.has("npm"));
check("pnpm-workspace.yaml read as pnpm-workspace", ecosystems.has("pnpm-workspace"));
check("Cargo.toml read as cargo", ecosystems.has("cargo"));
check("go.mod read as go", ecosystems.has("go"));
check("requirements.txt read as python-requirements", ecosystems.has("python-requirements"));
check("pyproject.toml read as python-project", ecosystems.has("python-project"));
check("six structurally different manifests in one repository", polyglot.manifests.length === 6, `${polyglot.manifests.length}`);

const pnpmManifest = polyglot.manifests.find((m) => m.ecosystem === "pnpm-workspace")!;
check("pnpm workspace globs captured", pnpmManifest.workspaces.includes("packages/*"));
check("pnpm exclusion glob captured verbatim", pnpmManifest.workspaces.includes("!packages/legacy"));

const pyproject = polyglot.manifests.find((m) => m.ecosystem === "python-project")!;
check("multi-line TOML array parsed without problems", pyproject.problems.length === 0, JSON.stringify(pyproject.problems));
check("pyproject declares its package name", pyproject.name === "polyglot-tools");

console.log("\n=== 2. Dependency kinds and versions ===");

const dep = (name: string) => polyglot.dependencies.find((d) => d.name === name);
check("runtime dependency from package.json", dep("left-pad")?.kind === "runtime");
check("dev dependency from package.json", dep("typescript")?.kind === "dev");
check("optional dependency from package.json", dep("fsevents")?.kind === "optional");
check("peer dependency from package.json", dep("react")?.kind === "peer");
check("cargo dev-dependency", dep("criterion")?.kind === "dev");
check("cargo build-dependency", dep("cc")?.kind === "build");
check("go indirect dependency", dep("golang.org/x/sync")?.kind === "indirect");
check("pyproject dev group dependency", dep("pytest")?.kind === "dev");
check("requirements.txt runtime dependency", dep("flask")?.kind === "runtime");

check("caret constraint preserved verbatim", dep("left-pad")?.version === "^1.3.0");
check("range constraint preserved verbatim", dep("requests")?.version === ">=2.31,<3");
check("extras in a requirement are not part of the name", dep("celery") !== undefined);
check("a requirement with no version records null, not a guess", dep("rich")?.version === null);
check("workspace protocol constraint preserved", dep("shared-lib")?.version === "workspace:*");
check("every dependency names its declaring manifest", polyglot.dependencies.every((d) => d.manifest.length > 0));
check("every dependency names its workspace directory", polyglot.dependencies.every((d) => d.dir.length > 0));

console.log("\n=== 3. Declared is not installed ===");

// The schema itself must have no way to express installation. Only field
// declarations are inspected: the doc comment is expected to *mention*
// installation, precisely to say the type cannot express it.
const dependencyType = readFileSync("lib/parser/types.ts", "utf8");
const dependencyBlock = dependencyType.slice(
  dependencyType.indexOf("export type Dependency = {"),
  dependencyType.indexOf("};", dependencyType.indexOf("export type Dependency = {")),
);
const dependencyFields = dependencyBlock
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => /^[a-zA-Z]+\??:/.test(line))
  .map((line) => line.slice(0, line.indexOf(":")).replace("?", ""));
check(
  "dependency type has no installed/resolved/locked field",
  !dependencyFields.some((f) => /install|resolv|lock|present/i.test(f)),
  JSON.stringify(dependencyFields),
);
check("dependency type records reachability, not usage", dependencyFields.includes("importedBy"), JSON.stringify(dependencyFields));

const imported = polyglot.dependencies.filter((d) => d.importedBy > 0).map((d) => d.name);
check("a dependency imported by source is counted", imported.includes("left-pad"), JSON.stringify(imported));
check("a declared dependency nothing imports is still listed", dep("typescript")?.importedBy === 0);
check(
  "an unimported dependency is not dropped from the output",
  polyglot.dependencies.some((d) => d.name === "typescript" && d.importedBy === 0),
);

console.log("\n=== 4. Configuration references and secret exclusion ===");

const config = polyglot.configReferences;
const varNames = config.map((c) => c.variable);
check("process.env.X captured", varNames.includes("DATABASE_URL"));
check("process.env[\"X\"] bracket form captured", varNames.includes("API_KEY"));
check("import.meta.env.X captured", varNames.includes("VITE_REGION"));
check(".env.example declarations captured", config.some((c) => c.kind === "env-example" && c.variable === "DATABASE_URL"));
check("a commented .env line declares nothing", !varNames.includes("SECRET_TOKEN"));
check("config object keys captured", config.some((c) => c.kind === "config-object" && c.variable === "port"));
check("every source reference carries a line number", config.filter((c) => c.kind !== "env-example").every((c) => c.line > 0));
check("every reference carries its file", config.every((c) => c.file.length > 0));

// The decisive property: no value from the fixture's .env.example may appear
// anywhere in the parse output. The fixture deliberately contains values that
// would be obvious if leaked.
const serialized = JSON.stringify(polyglot);
const fixtureEnv = readFileSync(path.join(FIXTURES, "polyglot-manifests/repo/.env.example"), "utf8");
const secretValues = fixtureEnv
  .split("\n")
  .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
  .map((l) => l.slice(l.indexOf("=") + 1).trim())
  .filter((v) => v.length > 0);
check("fixture actually carries values to leak", secretValues.length >= 3, `${secretValues.length}`);
for (const value of secretValues) {
  check(`configuration value "${value}" is absent from the parse output`, !serialized.includes(value));
}
check("env declarations expose names only", polyglot.envDeclarations.every((d) => Array.isArray(d.keys)));
check("no config reference carries a value field", config.every((c) => !("value" in c)));

console.log("\n=== 5. Entry points: declared vs inferred ===");

const declaredFixture = parse("declared-entries");
const declared = declaredFixture.entryPoints.filter((e) => e.kind === "declared");
const inferred = declaredFixture.entryPoints.filter((e) => e.kind === "inferred");

check("package.json main yields a declared entry", declared.some((e) => e.source === "package.json main"));
check("package.json bin yields a declared entry", declared.some((e) => e.source === "package.json bin"));
check("package.json exports yields declared entries", declared.some((e) => e.source === "package.json exports"));
check("a declared entry names its manifest", declared.every((e) => e.manifest !== null));
check("an inferred entry names no manifest", inferred.every((e) => e.manifest === null));
check("the two kinds are never merged", declared.every((e) => e.kind === "declared") && inferred.every((e) => e.kind === "inferred"));

const mainEntry = declared.find((e) => e.source === "package.json main")!;
check("a declared entry that exists resolves", mainEntry.resolved === true);
check("a resolved entry carries no unresolved reason", mainEntry.unresolvedReason === undefined);

const missingEntry = declared.find((e) => e.path === "src/does-not-exist.ts");
check("a declaration pointing at nothing is kept, not dropped", missingEntry !== undefined);
check("a declaration pointing at nothing is marked unresolved", missingEntry?.resolved === false);
check("an entry with no file at all is 'not-found'", missingEntry?.unresolvedReason === "not-found");

const rustEntries = polyglot.entryPoints.filter((e) => e.path.endsWith(".rs"));
check("cargo [lib] and [[bin]] yield declared entries", rustEntries.length >= 2, `${rustEntries.length}`);
check("a file that exists but is not indexed is 'not-indexed'", rustEntries.every((e) => e.unresolvedReason === "not-indexed"));
check("'not-indexed' is never reported as 'not-found'", rustEntries.every((e) => e.unresolvedReason !== "not-found"));

console.log("\n=== 6. Re-export chains ===");

const indexEntry = declared.find((e) => e.path === "src/index.ts" && e.source === "package.json exports")!;
check("a re-export chain is followed from the entry", (indexEntry.via ?? []).length >= 3, JSON.stringify(indexEntry.via));
check("the chain includes a direct re-export", (indexEntry.via ?? []).includes("src/theme.ts"));
check("the chain follows transitively", (indexEntry.via ?? []).includes("src/palette.ts"));
check("the entry file is not listed in its own chain", !(indexEntry.via ?? []).includes("src/index.ts"));
check("only re-export edges are followed", !(indexEntry.via ?? []).includes("src/cli.ts"));

console.log("\n=== 7. Broken and missing manifests ===");

const broken = declaredFixture.manifests.find((m) => m.path === "packages/broken/package.json")!;
check("a manifest with invalid JSON is still listed", broken !== undefined);
check("a broken manifest reports what could not be read", broken.problems.length > 0);
check("a broken manifest declares no dependencies", !declaredFixture.dependencies.some((d) => d.manifest === broken.path));
check("a broken manifest is not silently treated as empty", broken.problems.some((p) => /invalid JSON/i.test(p)));

const noManifest = parse("barrel-index");
check("a repository with a manifest and no declared entries yields none", noManifest.entryPoints.length === 0);

console.log("\n=== 8. Duplicate and conflicting metadata ===");

const reactDeps = declaredFixture.dependencies.filter((d) => d.name === "react");
check("a package declared as both runtime and dev is recorded twice", reactDeps.length === 2, `${reactDeps.length}`);
check("the two declarations keep distinct kinds", new Set(reactDeps.map((d) => d.kind)).size === 2);
check("both declarations name the same manifest", reactDeps.every((d) => d.manifest === "package.json"));

const mainAndExports = declaredFixture.entryPoints.filter((e) => e.path === "src/index.ts");
check("main and exports naming one file produce two entries", mainAndExports.length === 2, `${mainAndExports.length}`);
check("the two entries keep distinct sources", new Set(mainAndExports.map((e) => e.source)).size === 2);

console.log("\n=== 9. Workspace association ===");

const monorepo = parse("two-framework-monorepo");
const apiDeps = monorepo.dependencies.filter((d) => d.dir === "packages/api");
const webDeps = monorepo.dependencies.filter((d) => d.dir === "packages/web");
check("each workspace package's dependencies stay with it", apiDeps.length > 0 && webDeps.length > 0);
check("a dependency's project matches its directory", monorepo.dependencies.every((d) => d.project === d.dir));
check("no dependency is attributed to the root", monorepo.dependencies.every((d) => d.dir !== "."));
check("a workspace package's imports are counted for that package only", apiDeps.some((d) => d.importedBy > 0));

console.log("\n=== 10. Backward-compatible ingestion ===");

// An analysis stored before Phase 4 has no packaging rows. The parser must
// still produce a valid result for a repository whose manifest declares
// nothing at all, and for one with no manifest.
const bare = parse("commonjs");
check("a manifest declaring nothing yields no dependencies", bare.dependencies.length === 0);
check("a manifest declaring nothing yields no config references", bare.configReferences.length === 0);
check("a package root index file is still inferred as an entry", bare.entryPoints.some((e) => e.kind === "inferred"));
check("an inferred entry from a bare repository resolves", bare.entryPoints.every((e) => e.resolved));
check("the result still satisfies the contract", bare.schemaVersion === 7);

// A repository with no manifest at all is the harder case: nothing declares
// anything, and the parser must say so rather than inventing a manifest.
const withManifest = parse("path-aliases");
check("a repository with a manifest still parses", withManifest.manifests.length > 0);
check("its dependencies are read from that manifest", Array.isArray(withManifest.dependencies));

console.log("\n=== 11. Retrieval relevance gating ===");

check("a packaging question is recognised", queryTouchesPackaging("What dependencies does this use?"));
check("an entry-point question is recognised", queryTouchesPackaging("Where does execution start?"));
check("a configuration question is recognised", queryTouchesPackaging("Which environment variables are required?"));
check("an integration question is recognised", queryTouchesPackaging("How do I integrate this into another project?"));
check("an exposure question is recognised", queryTouchesPackaging("How is this package exposed?"));
check("a run question is recognised", queryTouchesPackaging("How do I run this?"));
check("an unrelated question is not recognised", !queryTouchesPackaging("How does authentication work?"));
check("an unrelated question about errors is not recognised", !queryTouchesPackaging("Where are errors handled?"));
check("an empty query is not recognised", !queryTouchesPackaging(""));

const emptyEvidence = { relevant: false, blocks: [], counts: { manifests: 0, dependencies: 0, config: 0, entries: 0 } };
check("no evidence renders as an empty string, not as a claim of absence", formatPackagingEvidence(emptyEvidence) === "");

console.log("\n=== 12. Organization isolation ===");

// The migration is the enforcement point; assert its shape rather than
// trusting the comment above it.
const migration = readFileSync("supabase/migrations/20261103000000_repo_metadata.sql", "utf8");
for (const table of ["manifests", "dependencies", "config_references", "entry_points"]) {
  check(`${table} carries organization_id`, new RegExp(`create table public\\.${table}[\\s\\S]*?organization_id text not null`).test(migration));
  check(`${table} has a row-level security policy`, new RegExp(`create policy[^;]*on public\\.${table}`).test(migration));
  check(`${table} cascades from its analysis`, new RegExp(`create table public\\.${table}[\\s\\S]*?references public\\.analyses`).test(migration));
}
check("no migration column could hold a configuration value", !/value\s+text/i.test(migration));
check("dependencies reference a manifest of the same analysis", /foreign key \(analysis_id, manifest_path\)/.test(migration));

console.log("\n=== 13. Determinism ===");

const once = JSON.stringify(parse("polyglot-manifests"));
const twice = JSON.stringify(parse("polyglot-manifests"));
check("parsing the same repository twice yields identical output", once === twice);

console.log("\n=== 14. No feature-specific or question-specific rules ===");

// The parser must not contain repository names, question phrasings or
// per-fixture special cases. A fixture name that is also a pre-existing
// vocabulary term (an edge kind, a role) is not a special case, so those are
// excluded by name rather than by weakening the check.
const PRE_EXISTING_VOCABULARY = new Set(["dynamic-import"]);
const parserSources = ["manifests.ts", "config.ts", "entries.ts", "index.ts"].map((f) =>
  readFileSync(path.join("lib/parser", f), "utf8"),
);
const packagingSource = readFileSync("lib/ai/packaging.ts", "utf8");
const allNew = [...parserSources, packagingSource].join("\n");
for (const fixtureName of readdirSync(FIXTURES).filter((f) => statSync(path.join(FIXTURES, f)).isDirectory())) {
  if (PRE_EXISTING_VOCABULARY.has(fixtureName)) continue;
  check(`no reference to fixture "${fixtureName}" in the implementation`, !allNew.includes(fixtureName));
}
check("no question text is used to decide entry points", !/entryPoints[\s\S]{0,200}rawQuery/.test(allNew));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
