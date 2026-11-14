// Phase 5 Batch 3.1: FrameworkView contract tests. Batch 3.2 adds the role
// migration section: roleOf now answers over the view, and the section proves
// its outputs equal the frozen pre-migration role sets.
//
// Proves, over the whole 14-fixture corpus, that the JS/TS builder produces a
// deterministic, source-text-free view carrying exactly the facts the framework
// adapters read: pins on the Express mount/registration shapes, NestJS
// decorators and bootstrap, Next.js export lines (checked against the frozen
// expected.json routes), import binding and resolution shapes, directives, JSX
// and config-object properties; cross-checks every view against the ParseResult
// it replayed; and covers the shapes no fixture has with synthetic files.
//
// The replay below mirrors lib/parser/index.ts parseSelection verbatim (the
// ts-morph Project options, the syntactic-diagnostics gate, the resolver),
// because parseSelection does not hand out its SourceFiles. The cross-checks
// against parseRepository's own output keep the replay honest: if the mirror
// drifts from the real parse, the agreement checks fail.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Project, ts, type SourceFile } from "ts-morph";
import { parseRepository, selectFiles, type Selection } from "../lib/parser/index.ts";
import type { ImportStatus, ParseResult, SkippedFile } from "../lib/parser/types.ts";
import type { Role } from "../lib/roles.ts";
import { docusaurusAdapter } from "../lib/parser/adapters/docusaurus.ts";
import { expressAdapter } from "../lib/parser/adapters/express.ts";
import { fallbackAdapter } from "../lib/parser/adapters/fallback.ts";
import { nestjsAdapter } from "../lib/parser/adapters/nestjs.ts";
import { nextjsAdapter } from "../lib/parser/adapters/nextjs.ts";
import { reactAdapter } from "../lib/parser/adapters/react.ts";
import type { Resolver } from "../lib/parser/resolve.ts";
import { createResolver } from "../lib/parser/resolve.ts";
import { buildFrameworkView, type ViewSourceEntry } from "../lib/parser/adapters/view.ts";
import {
  FRAMEWORK_VIEW_VERSION,
  NO_ROUTES,
  type FrameworkAdapter,
  type FrameworkView,
  type RouteReport,
  type ViewArgument,
  type ViewFile,
  type ViewImport,
  type ViewProperty,
} from "../lib/parser/adapters/types.ts";
import { detectLanguage } from "../lib/ir/languages.ts";
import type { WalkResult } from "../lib/parser/walk.ts";
import { withinProject } from "../lib/parser/walk.ts";
import { FIXTURES, readBaseline } from "./test-fixtures-shared.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

// Deterministic element budget: every element the view carries for the corpus.
// Measured 2026-11-12 over all 14 fixtures: 442 elements (86 view files and
// skipped rows plus their imports, bindings, exports, declarations, decorators
// and arguments, calls, config properties, file-wide property assignments and
// directives). 3.3c.1 added the file-wide property-assignment stream (15
// assignments corpus-wide, 9 of which duplicate objectProperties content by
// design — the legacy Next.js config scan is uniformly file-wide). The budget
// keeps ~2x headroom and catches accidental blow-up (duplicated content,
// quadratic copying) without any wall-clock precision claim.
const CORPUS_ELEMENT_BUDGET = 900;
const CORPUS_WALL_CLOCK_BUDGET_MS = 60_000;

// ---- Strict deep equality (undefined-valued keys count as absent) ----

type Diff = { path: string; expected: string; actual: string } | null;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

function deepEqual(expected: unknown, actual: unknown, at: string): Diff {
  if (expected === actual) return null;
  const e = canonical(expected);
  const a = canonical(actual);
  if (e === a) return null;
  if (typeof e !== "object" || e === null || typeof a !== "object" || a === null || Array.isArray(e) !== Array.isArray(a)) {
    return { path: at, expected: JSON.stringify(expected), actual: JSON.stringify(actual) };
  }
  const keys = new Set([...Object.keys(e as object), ...Object.keys(a as object)]);
  for (const key of keys) {
    const diff = deepEqual((e as Record<string, unknown>)[key], (a as Record<string, unknown>)[key], `${at}.${key}`);
    if (diff) return diff;
  }
  return null;
}

function expect(diff: Diff, what: string): void {
  if (!diff) pass(what);
  else fail(`${what}: at ${diff.path} expected ${diff.expected}, got ${diff.actual}`);
}

// ---- The replayed parse (mirror of parseSelection, kept honest by cross-checks) ----

type ParsedReplay = {
  parsed: { path: string; absolutePath: string; project: string; content: string; source: SourceFile }[];
  skipped: SkippedFile[];
  resolver: Resolver;
};

function replayParse(selection: Selection): ParsedReplay {
  const { root, walk } = selection;
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
  const parsed: ParsedReplay["parsed"] = [];
  for (const entry of sourceFiles) {
    const [first, ...rest] = program.getSyntacticDiagnostics(entry.sourceFile);
    if (!first) {
      parsed.push({
        path: entry.candidate.path,
        absolutePath: entry.candidate.absolutePath,
        project: entry.candidate.project,
        content: entry.candidate.content,
        source: entry.sourceFile,
      });
      continue;
    }
    // A file that doesn't parse cleanly would give a partial view. Absent beats approximate.
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
    nodes: new Set(parsed.map((entry) => entry.path)),
    skipped: new Map(skipped.map((file) => [file.path, file])),
    excludedDirectories: walk.excludedDirectories,
    workspacePackages: walk.workspacePackages,
  });
  return { parsed, skipped, resolver };
}

function buildViews(walk: WalkResult, replay: ParsedReplay): Map<string, FrameworkView> {
  const views = new Map<string, FrameworkView>();
  for (const projectPath of walk.adapters.keys()) {
    views.set(
      projectPath,
      buildFrameworkView({
        project: projectPath,
        files: replay.parsed
          .filter((entry) => entry.project === projectPath)
          .map((entry) => ({ path: entry.path, absolutePath: entry.absolutePath, source: entry.source })),
        skipped: replay.skipped.filter((file) => walk.projectOf.get(file.path) === projectPath),
        resolveSpecifier: replay.resolver.resolve,
      }),
    );
  }
  return views;
}

const repoPathOf = (project: string, viewPath: string): string => (project === "." ? viewPath : `${project}/${viewPath}`);

// Deterministic element count, everything the view carries, recursively.
function countProperties(properties: readonly ViewProperty[]): number {
  return properties.reduce(
    (sum, property) =>
      sum +
      1 +
      (property.value.kind === "object" ? countProperties(property.value.properties) : 0),
    0,
  );
}

function countArguments(arguments_: readonly ViewArgument[]): number {
  return arguments_.reduce(
    (sum, argument) => sum + 1 + (argument.kind === "object" ? countProperties(argument.properties) : 0),
    0,
  );
}

function countElements(view: FrameworkView): number {
  let count = view.files.length + view.skipped.length;
  for (const file of view.files) {
    for (const imported of file.imports) count += 1 + imported.bindings.length;
    count += file.exports.length;
    for (const declaration of file.declarations) {
      count += 1 + declaration.decorators.reduce((sum, d) => sum + 1 + countArguments(d.arguments), 0);
    }
    for (const call of file.calls) count += 1 + countArguments(call.arguments);
    count += countProperties(file.objectProperties);
    count += countProperties(file.propertyAssignments);
    count += file.directives.length;
  }
  return count;
}

// ---- Section 1: corpus — contract shape, determinism, cross-checks ----

console.log("=== 1. Corpus: contract shape, determinism, cross-checks against ParseResult ===");

const fixtureNames = readdirSync(FIXTURES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const corpus = new Map<
  string,
  { result: ParseResult; views: Map<string, FrameworkView>; contents: Map<string, string>; replay: ParsedReplay; walk: WalkResult }
>();
let corpusElements = 0;
const corpusStart = Date.now();

for (const name of fixtureNames) {
  const directory = path.join(FIXTURES, name, "repo");
  const selection = selectFiles(directory);
  const replay = replayParse(selection);
  const views = buildViews(selection.walk, replay);
  const again = buildViews(selection.walk, replay);
  const result = parseRepository(directory);

  expect(
    deepEqual(Object.fromEntries(views), Object.fromEntries(again), "$"),
    `${name}: two builds from identical input are deeply equal (determinism)`,
  );
  corpusElements += [...views.values()].reduce((sum, view) => sum + countElements(view), 0);
  corpus.set(name, {
    result,
    views,
    contents: new Map(replay.parsed.map((entry) => [entry.path, entry.content])),
    replay,
    walk: selection.walk,
  });

  const fileExports = new Map(result.files.map((file) => [file.path, file.exports]));
  const filePaths = new Set(result.files.map((file) => file.path));
  let versionBad = 0;

  for (const [project, view] of views) {
    if (view.viewVersion !== FRAMEWORK_VIEW_VERSION || view.project !== project) versionBad += 1;

    const unsorted = view.files.some((file, i) => i > 0 && view.files[i - 1]!.path.localeCompare(file.path) >= 0);
    if (unsorted) fail(`${name}/${project}: view files are not sorted by path`);
    const duplicate = new Set(view.files.map((f) => f.path)).size !== view.files.length;
    if (duplicate) fail(`${name}/${project}: duplicate view file paths`);

    // Language: the Batch 2 registry decides; corpus files are all JS/TS.
    const languageBad = view.files.filter(
      (file) =>
        file.language === null ||
        !["javascript", "typescript"].includes(file.language) ||
        file.language !== detectLanguage(repoPathOf(project, file.path)),
    );
    if (languageBad.length === 0) {
      pass(`${name}/${project}: every file's language comes from the registry (${view.files.length} files)`);
    } else {
      fail(`${name}/${project}: ${languageBad.length} files disagree with the language registry`);
    }

    // Cross-check: the view holds every parsed file of its project, no others,
    // and every path is project-relative (its repository path is a parsed file).
    const expectedFiles = result.files.filter((file) => selection.walk.projectOf.get(file.path) === project).length;
    const pathBad = view.files.filter(
      (file) => project !== "." && (file.path.startsWith(`${project}/`) || !filePaths.has(repoPathOf(project, file.path))),
    );
    if (view.files.length !== expectedFiles || pathBad.length > 0) {
      fail(`${name}/${project}: view files disagree with ParseResult (${view.files.length} vs ${expectedFiles}, ${pathBad.length} bad paths)`);
    } else {
      pass(`${name}/${project}: view file count and project-relative paths agree with ParseResult (${expectedFiles})`);
    }

    // Cross-check: skipped files, by path and reason, exactly what the parse skipped.
    const expectedSkipped = Object.fromEntries(
      result.coverage.files.skippedFiles
        .filter((file) => selection.walk.projectOf.get(file.path) === project)
        .map((file) => [repoPathOf(project, file.path), file.reason]),
    );
    expect(
      deepEqual(expectedSkipped, Object.fromEntries(view.skipped.map((file) => [file.path, file.reason])), "$"),
      `${name}/${project}: skipped files agree with ParseResult coverage`,
    );

    // Cross-check: every view export name is a name the parser exported too.
    let exportBad = 0;
    for (const file of view.files) {
      const exported = fileExports.get(repoPathOf(project, file.path)) ?? [];
      for (const entry of file.exports) {
        if (entry.form !== "star" && !exported.includes(entry.name)) exportBad += 1;
      }
    }
    if (exportBad === 0) pass(`${name}/${project}: every view export name is in the parser's own exports`);
    else fail(`${name}/${project}: ${exportBad} view export names are absent from ParseResult`);

    // Cross-check: internal import targets are files the parse holds.
    let targetBad = 0;
    for (const file of view.files) {
      for (const imported of file.imports) {
        if (imported.resolution.status === "internal" && !filePaths.has(imported.resolution.target)) targetBad += 1;
      }
    }
    if (targetBad === 0) pass(`${name}/${project}: every internal import target is a parsed file`);
    else fail(`${name}/${project}: ${targetBad} internal import targets are not parsed files`);
  }

  if (versionBad === 0) {
    pass(`${name}: every project view carries viewVersion ${FRAMEWORK_VIEW_VERSION} and its own project path`);
  } else {
    fail(`${name}: ${versionBad} project views have a wrong viewVersion or project`);
  }

  // No source text in the view, for any file with enough content to make the check meaningful.
  let textBad = 0;
  for (const view of views.values()) {
    const json = JSON.stringify(view);
    for (const content of corpus.get(name)?.contents.values() ?? []) {
      if (content.length > 200 && json.includes(content)) textBad += 1;
    }
  }
  if (textBad === 0) pass(`${name}: the view carries no file's source text`);
  else fail(`${name}: ${textBad} views embed source text`);
}

if (FRAMEWORK_VIEW_VERSION !== 1) fail("FRAMEWORK_VIEW_VERSION must be 1");
else pass("FRAMEWORK_VIEW_VERSION is pinned to 1");

// ---- Section 2: Express pins ----

console.log("=== 2. Express fixture: mounts, registrations, require bindings ===");

{
  const entry = corpus.get("express-routes");
  if (!entry) fail("express-routes fixture missing");
  else {
    const view = entry.views.get(".")!;
    const appJs = view.files.find((file) => file.path === "app.js")!;
    if (!appJs) fail("express-routes: app.js missing from the view");
    else {
      expect(deepEqual(appJs.language, "javascript", "$"), "app.js: language javascript");

      // Declarations: the app/router factories the adapter keys on.
      const declarations = new Map(appJs.declarations.map((declaration) => [declaration.name, declaration]));
      expect(
        deepEqual(
          declarations.get("app"),
          {
            name: "app",
            kind: "const",
            line: 8,
            decorators: [],
            initializerCall: "express",
            initializerCallee: { receiver: "express", member: null },
          },
          "$",
        ),
        "app.js: `const app = express()` is a declaration with initializerCall express at line 8 (structural callee: identifier, no member)",
      );
      expect(
        deepEqual(declarations.get("apiRouter")?.initializerCall, "require", "$"),
        "app.js: apiRouter's initializer call is require",
      );
      expect(
        deepEqual(declarations.get("miscMount")?.initializerCall, null, "$"),
        "app.js: miscMount (a non-call initializer) carries initializerCall null",
      );

      // Imports: external express, internal routers, require bindings.
      const imports = new Map(appJs.imports.map((imported) => [imported.specifier, imported]));
      expect(
        deepEqual(imports.get("express"), {
          specifier: "express",
          kind: "require",
          line: 1,
          resolution: { status: "external", external: "package" },
          bindings: [{ local: "express", imported: "default" }],
        }, "$"),
        "app.js: require(\"express\") is external with a default binding",
      );
      expect(
        deepEqual(imports.get("./routes/index"), {
          specifier: "./routes/index",
          kind: "require",
          line: 2,
          resolution: { status: "internal", target: "routes/index.js" },
          bindings: [{ local: "apiRouter", imported: "default" }],
        }, "$"),
        "app.js: require(\"./routes/index\") resolves internally to routes/index.js",
      );
      expect(
        deepEqual(imports.get("./routes/misc")?.resolution, { status: "internal", target: "routes/misc.js" }, "$"),
        "app.js: require(\"./routes/misc\") resolves internally to routes/misc.js",
      );

      // Calls: the mixed literal + identifier mount is the contract's reason to exist.
      const calls = new Map(appJs.calls.map((call) => [`${call.callee}@${call.line}`, call]));
      expect(
        deepEqual(calls.get("app.use@13")?.arguments, [{ kind: "string", value: "/api" }, { kind: "identifier", name: "apiRouter" }] satisfies ViewArgument[], "$"),
        "app.js: app.use(\"/api\", apiRouter) preserves the literal AND the identifier",
      );
      expect(
        deepEqual(calls.get("app.use@15")?.arguments, [{ kind: "identifier", name: "miscMount" }, { kind: "identifier", name: "miscRouter" }] satisfies ViewArgument[], "$"),
        "app.js: app.use(miscMount, miscRouter) keeps both identifiers, never the computed value",
      );
      expect(
        deepEqual(calls.get("app.get@10")?.arguments, [{ kind: "string", value: "/health" }, { kind: "identifier", name: "healthCheck" }] satisfies ViewArgument[], "$"),
        "app.js: app.get(\"/health\", healthCheck) carries the registration shape",
      );
      expect(
        deepEqual(calls.get("app.listen@29")?.arguments, [{ kind: "other" }] satisfies ViewArgument[], "$"),
        "app.js: app.listen(3000) — a number literal is other, never evaluated",
      );

      // No source text, pinned on the snippets a leak would carry.
      const json = JSON.stringify(appJs);
      if (json.includes("process.env.MISC_MOUNT") || json.includes('app.get("/health", healthCheck)') || json.includes('require("express")')) {
        fail("app.js: the view leaks source text");
      } else {
        pass("app.js: view carries no statement text, no process.env expression, no require text");
      }
    }

    const postsJs = view.files.find((file) => file.path === "routes/posts.js")!;
    if (!postsJs) fail("express-routes: routes/posts.js missing from the view");
    else {
      const router = postsJs.declarations.find((declaration) => declaration.name === "router");
      expect(
        deepEqual(router?.initializerCall, "express.Router", "$"),
        "routes/posts.js: `express.Router()` initializer is preserved verbatim",
      );
      const calls = new Map(postsJs.calls.map((call) => [`${call.callee}@${call.line}`, call]));
      expect(
        deepEqual(calls.get("router.get@12")?.arguments, [{ kind: "string-array", values: ["/archive", "/feed"] }, { kind: "identifier", name: "listArchived" }] satisfies ViewArgument[], "$"),
        "routes/posts.js: an array of literals is a string-array argument",
      );
      expect(
        deepEqual(calls.get("router.get@13")?.arguments, [{ kind: "identifier", name: "unlistedPath" }, { kind: "identifier", name: "showUnlisted" }] satisfies ViewArgument[], "$"),
        "routes/posts.js: router.get(unlistedPath, …) keeps the identifier",
      );
      expect(
        deepEqual(calls.get("router.delete@14")?.arguments[0], { kind: "other" } satisfies ViewArgument, "$"),
        "routes/posts.js: a template with substitutions is other",
      );
      expect(
        deepEqual(postsJs.exports, [] satisfies ViewFile["exports"], "$"),
        "routes/posts.js: module.exports is a CommonJS whole-module export — excluded from the view",
      );
    }

    const indexJs = view.files.find((file) => file.path === "routes/index.js")!;
    if (!indexJs) fail("express-routes: routes/index.js missing from the view");
    else {
      const nested = indexJs.imports.find((imported) => imported.specifier === "./users");
      expect(
        deepEqual(nested?.resolution, { status: "internal", target: "routes/users.js" }, "$"),
        "routes/index.js: a nested require still resolves internally",
      );
      const mount = indexJs.calls.find((call) => call.callee === "router.use");
      expect(
        deepEqual(mount?.arguments, [{ kind: "string", value: "/users" }, { kind: "identifier", name: "usersRouter" }] satisfies ViewArgument[], "$"),
        "routes/index.js: the nested app.use(\"/users\", usersRouter) mount is preserved",
      );
    }
  }
}

// ---- Section 3: NestJS pins ----

console.log("=== 3. NestJS fixture: decorators, decorator arguments, bootstrap ===");

{
  const entry = corpus.get("two-framework-monorepo");
  if (!entry) fail("two-framework-monorepo fixture missing");
  else {
    const api = entry.views.get("packages/api");
    if (!api) fail("two-framework-monorepo: packages/api view missing");
    else {
      const controller = api.files.find((file) => file.path === "src/users/users.controller.ts")!;
      if (!controller) fail("two-framework-monorepo: users.controller.ts missing");
      else {
        expect(deepEqual(controller.language, "typescript", "$"), "users.controller.ts: language typescript");
        const declarations = new Map(controller.declarations.map((declaration) => [declaration.name, declaration]));
        // A decorated declaration starts at its decorator's line — the same
        // line the parser reports for the route the decorator names.
        expect(
          deepEqual(declarations.get("UsersController"), {
            name: "UsersController",
            kind: "class",
            line: 4,
            decorators: [{ name: "Controller", arguments: [{ kind: "string", value: "users" }], line: 4 }],
            initializerCall: null,
          }, "$"),
          "users.controller.ts: @Controller(\"users\") carries its argument and its line",
        );
        expect(
          deepEqual(declarations.get("UsersController.list"), {
            name: "UsersController.list",
            kind: "function",
            line: 8,
            decorators: [{ name: "Get", arguments: [], line: 8 }],
            initializerCall: null,
          }, "$"),
          "users.controller.ts: the method is a qualified declaration with its @Get decorator",
        );
        expect(
          deepEqual(declarations.get("UsersController.create")?.decorators, [{ name: "Post", arguments: [], line: 13 }] satisfies ViewFile["declarations"][number]["decorators"], "$"),
          "users.controller.ts: @Post() decorator on the create method",
        );
        const common = controller.imports.find((imported) => imported.specifier === "@nestjs/common");
        expect(
          deepEqual(common?.bindings, [
            { local: "Controller", imported: "Controller" },
            { local: "Get", imported: "Get" },
            { local: "Post", imported: "Post" },
          ] satisfies ViewFile["imports"][number]["bindings"], "$"),
          "users.controller.ts: named imports from @nestjs/common keep local/imported pairs",
        );
        expect(
          deepEqual(common?.resolution, { status: "external", external: "package" } satisfies ViewFile["imports"][number]["resolution"], "$"),
          "users.controller.ts: @nestjs/common is an external package import",
        );
        const service = controller.imports.find((imported) => imported.specifier === "./users.service");
        expect(
          deepEqual(service?.resolution, { status: "internal", target: "packages/api/src/users/users.service.ts" } satisfies ViewFile["imports"][number]["resolution"], "$"),
          "users.controller.ts: the internal import target is repository-relative",
        );
      }

      const service = api.files.find((file) => file.path === "src/users/users.service.ts")!;
      if (!service) fail("two-framework-monorepo: users.service.ts missing");
      else {
        const cls = service.declarations.find((declaration) => declaration.name === "UsersService");
        expect(
          deepEqual(cls?.decorators, [{ name: "Injectable", arguments: [], line: 3 }] satisfies ViewFile["declarations"][number]["decorators"], "$"),
          "users.service.ts: @Injectable() with no arguments",
        );
        expect(
          deepEqual(service.declarations.find((declaration) => declaration.name === "UsersService.all")?.line, 5, "$"),
          "users.service.ts: the method is a qualified declaration",
        );
      }
    }

    const web = entry.views.get("packages/web");
    if (!web) fail("two-framework-monorepo: packages/web view missing");
    else {
      const page = web.files.find((file) => file.path === "app/page.tsx")!;
      if (!page) fail("two-framework-monorepo: packages/web app/page.tsx missing");
      else {
        expect(deepEqual(page.flags, { jsx: true } satisfies ViewFile["flags"], "$"), "packages/web page.tsx: JSX presence is true");
        expect(
          deepEqual(page.exports, [] satisfies ViewFile["exports"], "$"),
          "packages/web page.tsx: a default export is excluded from the view",
        );
        const branding = page.imports.find((imported) => imported.specifier === "../lib/branding");
        expect(
          deepEqual(branding?.resolution, { status: "internal", target: "packages/web/lib/branding.ts" } satisfies ViewFile["imports"][number]["resolution"], "$"),
          "packages/web page.tsx: ../lib/branding resolves internally",
        );
      }
    }
  }
}

// ---- Section 4: Next.js pins ----

console.log("=== 4. Next.js fixture: export lines vs the frozen expected.json routes ===");

{
  const entry = corpus.get("nextjs-app-router");
  if (!entry) fail("nextjs-app-router fixture missing");
  else {
    const view = entry.views.get(".")!;
    // The frozen baseline's route lines are the export lines the view must carry.
    const expected = JSON.parse(readFileSync(path.join(FIXTURES, "nextjs-app-router", "expected.json"), "utf8")) as {
      routes: { file: string; method: string; line: number }[];
    };
    let lineBad = 0;
    for (const route of expected.routes) {
      const file = view.files.find((candidate) => candidate.path === route.file);
      const hit = file?.exports.some(
        (candidate) => candidate.form === "declaration" && candidate.name === route.method && candidate.line === route.line,
      );
      if (!hit) lineBad += 1;
    }
    if (lineBad === 0) {
      pass(`all ${expected.routes.length} frozen route lines (${expected.routes.map((r) => `${r.method}@${r.line}`).join(", ")}) match view export lines`);
    } else {
      fail(`${lineBad} of ${expected.routes.length} frozen route lines are not carried by the view`);
    }

    const idRoute = view.files.find((file) => file.path === "app/api/users/[id]/route.ts")!;
    if (!idRoute) fail("nextjs-app-router: [id]/route.ts missing");
    else {
      expect(
        deepEqual(idRoute.exports, [
          { form: "declaration", name: "GET", kind: "function", line: 3 },
          { form: "declaration", name: "DELETE", kind: "function", line: 7 },
        ] satisfies ViewFile["exports"], "$"),
        "[id]/route.ts: both handler exports with their own lines",
      );
      const store = idRoute.imports.find((imported) => imported.specifier === "../../../../lib/store");
      expect(
        deepEqual(store?.resolution, { status: "internal", target: "lib/store.ts" } satisfies ViewFile["imports"][number]["resolution"], "$"),
        "[id]/route.ts: the store import resolves to lib/store.ts",
      );
    }

    const page = view.files.find((file) => file.path === "app/page.tsx")!;
    if (!page) fail("nextjs-app-router: app/page.tsx missing");
    else {
      expect(deepEqual(page.flags, { jsx: false } satisfies ViewFile["flags"], "$"), "app/page.tsx: JSX absence is false (no JSX in this page)");
      expect(
        deepEqual(page.exports, [{ form: "declaration", name: "UserList", kind: "function", line: 3 }] satisfies ViewFile["exports"], "$"),
        "app/page.tsx: the exported function carries its line",
      );
    }

    const store = view.files.find((file) => file.path === "lib/store.ts")!;
    if (!store) fail("nextjs-app-router: lib/store.ts missing");
    else {
      const declarations = new Map(store.declarations.map((declaration) => [declaration.name, declaration]));
      expect(
        deepEqual(declarations.get("USERS")?.kind, "const", "$"),
        "lib/store.ts: a non-exported const is still a declaration",
      );
      expect(
        deepEqual(
          store.exports.filter((entry) => entry.form !== "star").map((entry) => `${entry.name}@${entry.line}`),
          ["allUsers@5", "user@9"] satisfies string[],
          "$",
        ),
        "lib/store.ts: exported functions with their lines",
      );
    }

    // This fixture has no directives; the prologue facts are synthetic-tested below.
    if (view.files.every((file) => file.directives.length === 0)) {
      pass("nextjs-app-router: no file claims a directive prologue (none exists)");
    } else {
      fail("nextjs-app-router: a file without a prologue claims directives");
    }
  }
}

// ---- Section 5: synthetic shapes no fixture covers ----

console.log("=== 5. Synthetic: directives, export forms, import shapes, config, limits ===");

const syntheticProject = new Project({
  skipAddingFilesFromTsConfig: true,
  skipFileDependencyResolution: true,
  compilerOptions: { allowJs: true, noLib: true, noResolve: true, types: [] },
});
const syntheticDir = path.resolve("synthetic-adapter-view");
const syntheticEntries: ViewSourceEntry[] = [];
const synthFile = (name: string, content: string): ViewSourceEntry => {
  const entry = {
    path: name,
    absolutePath: path.join(syntheticDir, name),
    source: syntheticProject.createSourceFile(path.join(syntheticDir, name), content, { overwrite: true }),
  };
  syntheticEntries.push(entry);
  return entry;
};

// A stub resolver keeps the synthetic cases about syntax, not the filesystem;
// resolution against real files is pinned by the corpus sections above. A
// zero-parameter function is assignable to the resolver's signature.
const stubResolve = (): ImportStatus => ({ status: "external", external: "package" });

const buildSynthetic = (files: readonly ViewSourceEntry[], skipped: { path: string; reason: string }[] = [], project = "."): FrameworkView =>
  buildFrameworkView({ project, files: [...files], skipped, resolveSpecifier: stubResolve });

// Directives: the leading run of string-literal statements, exactly the
// prologue the Next.js adapter scans.
{
  const file = synthFile(
    "directives.ts",
    `"use strict";
"use server";

export function action() {}
`,
  );
  const view = buildSynthetic([file]);
  expect(
    deepEqual(view.files[0]?.directives, ["use strict", "use server"] satisfies string[], "$"),
    "directives.ts: the prologue's values are carried in order",
  );

  const late = synthFile(
    "not-directive.ts",
    `const x = 1;
"use server";
`,
  );
  const lateView = buildSynthetic([late]);
  expect(deepEqual(lateView.files[0]?.directives, [] satisfies string[], "$"), "not-directive.ts: a string statement after code is not a directive");
}

// Export forms: aliases, bare star, namespace star, destructured variables —
// and the exclusions (default exports, CommonJS whole-module exports).
{
  const file = synthFile(
    "export-forms.ts",
    `export { handler as GET };
export * from "./m";
export * as ns from "./m2";
export default function GET() {}
export const { A, B: C } = pair;
export function POST() {}
export const GETVAR = 1;
`,
  );
  const view = buildSynthetic([file]);
  expect(
    deepEqual(view.files[0]?.exports, [
      { form: "alias", name: "GET", line: 1 },
      { form: "star", line: 2 },
      { form: "alias", name: "ns", line: 3, namespace: true },
      { form: "declaration", name: "A", kind: "variable", line: 5 },
      { form: "declaration", name: "C", kind: "variable", line: 5 },
      { form: "declaration", name: "POST", kind: "function", line: 6 },
      { form: "declaration", name: "GETVAR", kind: "variable", line: 7 },
    ] satisfies ViewFile["exports"], "$"),
    "export-forms.ts: alias/star/namespace/destructured forms carried; the default export excluded",
  );
}

// The namespace re-export spelling is marked, so a consumer resolving
// exported names by alias never reads `export * as GET` as a GET handler —
// the fact the legacy Next.js export scan observed by skipping namespace
// exports entirely.
{
  const file = synthFile(
    "namespace-exports.ts",
    `const handler = null;
const plain = 1;
export * as GET from "./module";
export * as ns from "./other";
export { handler as GET };
export * from "./bare";
export { plain };
`,
  );
  expect(
    deepEqual(buildSynthetic([file]).files[0]?.exports, [
      { form: "alias", name: "GET", line: 3, namespace: true },
      { form: "alias", name: "ns", line: 4, namespace: true },
      { form: "alias", name: "GET", line: 5 },
      { form: "star", line: 6 },
      { form: "alias", name: "plain", line: 7 },
    ] satisfies ViewFile["exports"], "$"),
    "namespace-exports.ts: only the `export * as ns` spelling carries the namespace marker; ordinary aliases and bare stars unchanged",
  );
}

// Import shapes: default, namespace, named, alias, type-only, import-equals,
// destructured require with a string key, literal dynamic import — and the
// skips (computed require path; the import-equals require not double-counted).
{
  const file = synthFile(
    "import-shapes.ts",
    `import def, { named as alias, plain } from "pkg";
import * as nsAll from "pkg2";
import type Only from "pkg3";
import eq = require("pkg5");

const { a, b: c, "d-e": f } = require("pkg6");
const mod = import("./m");
const computed = require(prefix + "/x");
`,
  );
  const view = buildSynthetic([file]);
  const imports = view.files[0]!.imports;
  expect(
    deepEqual(imports, [
      {
        specifier: "pkg",
        kind: "import",
        line: 1,
        resolution: { status: "external", external: "package" },
        bindings: [
          { local: "def", imported: "default", defaultSlot: true },
          { local: "alias", imported: "named" },
          { local: "plain", imported: "plain" },
        ],
      },
      {
        specifier: "pkg2",
        kind: "import",
        line: 2,
        resolution: { status: "external", external: "package" },
        bindings: [{ local: "nsAll", imported: "*" }],
      },
      {
        specifier: "pkg3",
        kind: "import",
        line: 3,
        resolution: { status: "external", external: "package" },
        bindings: [{ local: "Only", imported: "default", defaultSlot: true }],
      },
      {
        specifier: "pkg5",
        kind: "import",
        importEquals: true,
        line: 4,
        resolution: { status: "external", external: "package" },
        bindings: [{ local: "eq", imported: "*" }],
      },
      {
        specifier: "pkg6",
        kind: "require",
        line: 6,
        resolution: { status: "external", external: "package" },
        bindings: [
          { local: "a", imported: "a" },
          { local: "c", imported: "b" },
          { local: "f", imported: "d-e" },
        ],
      },
      {
        specifier: "./m",
        kind: "dynamic-import",
        line: 7,
        resolution: { status: "external", external: "package" },
        bindings: [],
      },
    ] satisfies ViewImport[], "$"),
    "import-shapes.ts: every binding shape, one import-equals entry, computed require skipped",
  );
  if (imports.filter((imported) => imported.specifier === "pkg5").length === 1) {
    pass("import-shapes.ts: the import-equals require is not double-counted");
  } else {
    fail("import-shapes.ts: the import-equals require is duplicated");
  }
}

// Calls and arguments: receiver.method only, every argument as written,
// unsupported expressions conservatively "other".
{
  const file = synthFile(
    "call-shapes.js",
    `const app = { use: (a, b) => a };

app.use("/x", () => {}, gen(), flag);
app.route("/p").get(h);

const router = { get: (a, b) => a };
router.get(["/a", handler], f);
router.get([ok(), "/b"], f);
`,
  );
  const view = buildSynthetic([file]);
  const calls = view.files[0]!.calls;
  const at = (callee: string, line: number) => calls.filter((call) => call.callee === callee && call.line === line);
  expect(
    deepEqual(at("app.use", 3)[0]?.arguments, [{ kind: "string", value: "/x" }, { kind: "other" }, { kind: "other" }, { kind: "identifier", name: "flag" }] satisfies ViewArgument[], "$"),
    "call-shapes.js: function expressions and call arguments are other; identifiers survive",
  );
  if (calls.some((call) => call.callee === 'app.route("/p").get')) {
    pass("call-shapes.js: a chained registration keeps its full callee text");
  } else {
    fail("call-shapes.js: the chained registration callee is missing");
  }
  expect(
    deepEqual(at("router.get", 7)[0]?.arguments[0], { kind: "other" } satisfies ViewArgument, "$"),
    "call-shapes.js: a mixed array (literal + identifier) degrades to other, not to half a fact",
  );
  expect(
    deepEqual(at("router.get", 8)[0]?.arguments[0], { kind: "other" } satisfies ViewArgument, "$"),
    "call-shapes.js: an array with a call element degrades to other",
  );
}

// Config objects: the next.config shapes, with every conservative case.
{
  const file = synthFile(
    "next.config.mjs",
    `const nextConfig = {
  basePath: "/docs",
  pageExtensions: ["mdx", "ts"],
  shorthand,
  computed: compute(),
  template: \`/x\${v}\`,
  nested: { basePath },
  spread: { ...opts, basePath: "/b" },
  [key]: 1,
};
module.exports = nextConfig;
`,
  );
  const view = buildSynthetic([file]);
  expect(
    deepEqual(view.files[0]?.objectProperties, [
      { name: "basePath", value: { kind: "string", value: "/docs" }, line: 2 },
      { name: "pageExtensions", value: { kind: "string-array", values: ["mdx", "ts"] }, line: 3 },
      { name: "shorthand", value: { kind: "identifier", name: "shorthand" }, line: 4 },
      { name: "computed", value: { kind: "other" }, line: 5 },
      { name: "template", value: { kind: "other" }, line: 6 },
      {
        name: "nested",
        value: { kind: "object", properties: [{ name: "basePath", value: { kind: "identifier", name: "basePath" }, line: 7 }] },
        line: 7,
      },
      { name: "spread", value: { kind: "object", properties: [{ name: "basePath", value: { kind: "string", value: "/b" }, line: 8 }] }, line: 8 },
    ] satisfies ViewProperty[], "$"),
    "next.config.mjs: literal, array, shorthand, nested and spread cases; computed keys skipped",
  );
}

// module.exports and export default object literals reach the view too.
{
  const file = synthFile(
    "config-cjs.js",
    `module.exports = { basePath: "/cjs" };
`,
  );
  const defaultFile = synthFile(
    "config-esm.mjs",
    `export default { basePath: "/esm" };
`,
  );
  const view = buildSynthetic([file, defaultFile]);
  const cjs = view.files.find((f) => f.path === "config-cjs.js")!;
  const esm = view.files.find((f) => f.path === "config-esm.mjs")!;
  expect(
    deepEqual(cjs?.objectProperties, [{ name: "basePath", value: { kind: "string", value: "/cjs" }, line: 1 }] satisfies ViewProperty[], "$"),
    "config-cjs.js: module.exports = { … } is a config object",
  );
  expect(
    deepEqual(esm?.objectProperties, [{ name: "basePath", value: { kind: "string", value: "/esm" }, line: 1 }] satisfies ViewProperty[], "$"),
    "config-esm.mjs: export default { … } is a config object",
  );
}

// The file-wide property-assignment stream: every explicit and shorthand
// assignment in document order, wherever it sits — top-level literals, call
// arguments, function returns, array elements — with the shorthand spelling
// marked and computed keys skipped. The distinction between
// `{ basePath: basePath }` (explicit, unmarked) and `{ basePath }` (shorthand,
// marked) is the fact Next.js's two config withhold reasons hang on.
{
  const file = synthFile(
    "property-stream.ts",
    `const direct = { basePath: "/root", "q-key": "v", ["computed"]: 1, ...rest, nested: { deep: "y" } };
module.exports = withPlugins({ basePath: "/wrapped", short });
function make() { return { basePath: "/returned" }; }
const arr = [{ basePath: "/in-array" }, { sh2 }];
const explicitVsShorthand = { basePath: basePath, sh3 };
`,
  );
  const view = buildSynthetic([file]);
  expect(
    deepEqual(view.files[0]?.propertyAssignments, [
      { name: "basePath", value: { kind: "string", value: "/root" }, line: 1 },
      { name: "q-key", value: { kind: "string", value: "v" }, line: 1 },
      { name: "nested", value: { kind: "object", properties: [{ name: "deep", value: { kind: "string", value: "y" }, line: 1 }] }, line: 1 },
      { name: "deep", value: { kind: "string", value: "y" }, line: 1 },
      { name: "basePath", value: { kind: "string", value: "/wrapped" }, line: 2 },
      { name: "short", value: { kind: "identifier", name: "short" }, line: 2, shorthand: true },
      { name: "basePath", value: { kind: "string", value: "/returned" }, line: 3 },
      { name: "basePath", value: { kind: "string", value: "/in-array" }, line: 4 },
      { name: "sh2", value: { kind: "identifier", name: "sh2" }, line: 4, shorthand: true },
      { name: "basePath", value: { kind: "identifier", name: "basePath" }, line: 5 },
      { name: "sh3", value: { kind: "identifier", name: "sh3" }, line: 5, shorthand: true },
    ] satisfies ViewFile["propertyAssignments"], "$"),
    "property-stream.ts: every assignment file-wide in document order — top-level, call-wrapped, returned, in-array — shorthand marked, quoted keys normalized, computed keys skipped",
  );
  expect(
    deepEqual(view.files[0]?.objectProperties, [
      { name: "basePath", value: { kind: "string", value: "/root" }, line: 1 },
      { name: "q-key", value: { kind: "string", value: "v" }, line: 1 },
      { name: "nested", value: { kind: "object", properties: [{ name: "deep", value: { kind: "string", value: "y" }, line: 1 }] }, line: 1 },
      { name: "basePath", value: { kind: "identifier", name: "basePath" }, line: 5 },
      { name: "sh3", value: { kind: "identifier", name: "sh3" }, line: 5 },
    ] satisfies ViewProperty[], "$"),
    "property-stream.ts: objectProperties keeps its exact existing meaning — only top-level config literals, shorthand unmarked",
  );
}

// Decorator argument shapes the NestJS adapter resolves.
{
  const file = synthFile(
    "decorator-shapes.ts",
    `const Controller = (a?: unknown) => a;
const Get = (a?: unknown) => a;

@Controller({ path: ["a", "b"] })
class A {
  @Get("x")
  m() {}
}

@Controller(computed())
class B {}

@Controller({ version: "v1" })
class C {}
`,
  );
  const view = buildSynthetic([file]);
  const declarations = new Map(view.files[0]!.declarations.map((declaration) => [declaration.name, declaration]));
  expect(
    deepEqual(declarations.get("A")?.decorators, [
      { name: "Controller", arguments: [{ kind: "object", properties: [{ name: "path", value: { kind: "string-array", values: ["a", "b"] }, line: 4 }] }], line: 4 },
    ] satisfies ViewFile["declarations"][number]["decorators"], "$"),
    "decorator-shapes.ts: an object decorator argument keeps its properties",
  );
  expect(
    deepEqual(declarations.get("A.m")?.decorators, [{ name: "Get", arguments: [{ kind: "string", value: "x" }], line: 6 }] satisfies ViewFile["declarations"][number]["decorators"], "$"),
    "decorator-shapes.ts: @Get(\"x\") carries the literal and the decorator's line",
  );
  expect(
    deepEqual(declarations.get("B")?.decorators, [{ name: "Controller", arguments: [{ kind: "other" }], line: 10 }] satisfies ViewFile["declarations"][number]["decorators"], "$"),
    "decorator-shapes.ts: a call decorator argument is other",
  );
  expect(
    deepEqual(declarations.get("C")?.decorators, [
      { name: "Controller", arguments: [{ kind: "object", properties: [{ name: "version", value: { kind: "string", value: "v1" }, line: 13 }] }], line: 13 },
    ] satisfies ViewFile["declarations"][number]["decorators"], "$"),
    "decorator-shapes.ts: the version property is visible to the adapter",
  );
}

// Depth cap: runaway nesting degrades to other instead of unbounded work.
{
  const leaf = "leaf";
  const depth = 10;
  let content = JSON.stringify(leaf);
  for (let i = 0; i < depth; i++) content = `{ a: ${content} }`;
  const file = synthFile("deep-config.js", `const config = ${content};\n`);
  const view = buildSynthetic([file]);
  const innermost = view.files[0]!.objectProperties[0];
  let levels = 0;
  let current = innermost;
  while (current?.value.kind === "object") {
    current = current.value.properties[0];
    levels += 1;
  }
  if (current?.value.kind === "other" && levels === depth - 1) {
    pass(`deep-config.js: ${levels} object levels carried, then the cap turned the leaf into other`);
  } else {
    fail(`deep-config.js: depth cap wrong (levels ${levels}, leaf ${JSON.stringify(current?.value)})`);
  }
}

// Skipped files: project-relative passthrough with reasons; empty views stay empty.
{
  const view = buildSynthetic([], [
    { path: "packages/api/src/broken.ts", reason: "syntax-error" },
    { path: "packages/api/other.d.ts", reason: "declaration-file" },
  ], "packages/api");
  expect(
    deepEqual(view.skipped, [
      { path: "other.d.ts", reason: "declaration-file" },
      { path: "src/broken.ts", reason: "syntax-error" },
    ] satisfies FrameworkView["skipped"], "$"),
    "skipped passthrough: reasons carried, paths made project-relative, sorted",
  );
  expect(
    deepEqual(buildSynthetic([]), { viewVersion: 1, project: ".", files: [], skipped: [] } satisfies FrameworkView, "$"),
    "an empty project builds the empty view",
  );
}

// JSX presence on a synthetic .tsx (the corpus covers absence already).
{
  const file = synthFile("jsx.tsx", `export const el = () => <b>hi</b>;\n`);
  const view = buildSynthetic([file]);
  expect(deepEqual(view.files[0]?.flags, { jsx: true } satisfies ViewFile["flags"], "$"), "jsx.tsx: JSX presence is true");
}

// Synthetic determinism, for completeness with the stub resolver.
{
  const once = buildSynthetic(syntheticEntries);
  const twice = buildSynthetic(syntheticEntries);
  expect(deepEqual(once, twice, "$"), "synthetic: two builds are deeply equal");
}

// ---- Section 6: element budget ----

console.log("=== 6. Element budget ===");

if (corpusElements <= CORPUS_ELEMENT_BUDGET) {
  pass(`corpus views carry ${corpusElements} elements, within the deterministic budget ${CORPUS_ELEMENT_BUDGET}`);
} else {
  fail(`corpus view elements ${corpusElements} exceed the budget ${CORPUS_ELEMENT_BUDGET}`);
}
const elapsed = Date.now() - corpusStart;
if (elapsed <= CORPUS_WALL_CLOCK_BUDGET_MS) {
  pass(`corpus view building took ${elapsed}ms (generous smoke bound ${CORPUS_WALL_CLOCK_BUDGET_MS}ms, not a precision assertion)`);
} else {
  fail(`corpus view building took ${elapsed}ms, over the smoke bound ${CORPUS_WALL_CLOCK_BUDGET_MS}ms`);
}

// ---- Section 7: role migration equivalence (Batch 3.2) ----

console.log("=== 7. Role migration: view-fed roleOf equals the frozen role sets ===");

// roleOf answers over ViewFile now (types.ts), and lib/parser/index.ts feeds it
// the per-project FrameworkView. The acceptance is strict: every role must be
// what it was when roleOf read AdapterFile. The frozen expected.json files are
// that "before" — their files[].role fields were written by the pre-migration
// parser — so per fixture the complete path → role assignment set (nulls
// included: absence is part of the set) must equal the frozen one. The
// synthetic pins then hold the adapters' documented role semantics against
// hand-built ViewFiles, covering the shapes no fixture has ("use server", the
// directive ordering, hook-over-JSX precedence).

for (const name of fixtureNames) {
  const entry = corpus.get(name);
  if (!entry) {
    fail(`${name}: corpus entry missing`);
    continue;
  }
  const before = JSON.parse(readBaseline(path.join(FIXTURES, name, "expected.json"))) as ParseResult;
  const beforeRoles = Object.fromEntries(before.files.map((file) => [file.path, file.role ?? null]));
  const afterRoles = Object.fromEntries(entry.result.files.map((file) => [file.path, file.role ?? null]));
  expect(
    deepEqual(beforeRoles, afterRoles, "$"),
    `${name}: all ${Object.keys(afterRoles).length} role assignments (complete path → role set) equal the frozen expected.json`,
  );
}

// Multi-framework monorepo: each project's own adapter assigns its roles, so
// the NestJS package and the Next.js package disagree on what a role means and
// neither borrows the other's.
{
  const entry = corpus.get("two-framework-monorepo");
  if (!entry) fail("two-framework-monorepo: corpus entry missing");
  else {
    const roles = new Map(entry.result.files.map((file) => [file.path, file.role ?? null]));
    expect(deepEqual(roles.get("packages/api/src/users/users.controller.ts"), "controller", "$"), "monorepo: the NestJS package's controller is a controller");
    expect(deepEqual(roles.get("packages/api/src/users/users.service.ts"), "service", "$"), "monorepo: the NestJS package's service is a service");
    expect(deepEqual(roles.get("packages/web/app/page.tsx"), "page-route", "$"), "monorepo: the Next.js package's page is a page-route");
    expect(deepEqual(roles.get("packages/web/lib/branding.ts"), null, "$"), "monorepo: an unrouted file stays unclassified");
  }
}

// A ViewFile carrying only the facts a role reads; everything else is empty.
const roleFile = (path: string, overrides: Partial<ViewFile> = {}): ViewFile => ({
  path,
  language: "typescript",
  directives: [],
  flags: { jsx: false },
  imports: [],
  exports: [],
  declarations: [],
  calls: [],
  objectProperties: [],
  propertyAssignments: [],
  ...overrides,
});

const roleCase = (adapter: { name: string; roleOf: (file: ViewFile) => Role | null }, file: ViewFile, expected: Role | null, what: string): void =>
  expect(deepEqual(adapter.roleOf(file), expected, "$"), what);

// Next.js: path conventions first, then tools, then directive/React shape.
roleCase(nextjsAdapter, roleFile("app/page.tsx"), "page-route", "next: app/page.tsx is a page-route");
roleCase(nextjsAdapter, roleFile("pages/index.tsx"), "page-route", "next: a pages/ file is a page-route");
roleCase(nextjsAdapter, roleFile("pages/api/users.ts"), "api-endpoint", "next: a pages/api file is an api-endpoint");
roleCase(nextjsAdapter, roleFile("pages/_app.tsx"), "layout", "next: pages/_app.tsx is a layout");
roleCase(nextjsAdapter, roleFile("middleware.ts"), "middleware", "next: middleware.ts is middleware");
roleCase(nextjsAdapter, roleFile("next.config.ts"), "config", "next: next.config.ts is a tool config");
roleCase(nextjsAdapter, roleFile("app/actions.ts", { directives: ["use server"] }), "server-action", "next: a leading \"use server\" prologue makes a server-action");
roleCase(nextjsAdapter, roleFile("app/actions.ts", { directives: ["use strict", "use server"] }), "server-action", "next: \"use server\" anywhere in the leading string run still counts");
roleCase(nextjsAdapter, roleFile("app/actions.ts", { directives: ["use client"] }), null, "next: a leading \"use client\" is not a server-action");
roleCase(nextjsAdapter, roleFile("app/actions.ts", { directives: [] }), null, "next: no prologue, no role (a string statement after code is not a directive)");
roleCase(nextjsAdapter, roleFile("app/actions.ts", { flags: { jsx: true } }), "component", "next: without directives the React fallback reads the jsx flag");
roleCase(nextjsAdapter, roleFile("lib/useStore.ts"), "hook", "next: the hook naming rule survives the migration");

// React: hook naming first, then the view's jsx flag.
roleCase(reactAdapter, roleFile("components/Button.tsx", { flags: { jsx: true } }), "component", "react: jsx true is a component");
roleCase(reactAdapter, roleFile("components/Button.tsx", { flags: { jsx: false } }), null, "react: jsx false stays unclassified");
roleCase(reactAdapter, roleFile("src/useCounter.ts"), "hook", "react: a useCamel name is a hook without any JSX");
roleCase(reactAdapter, roleFile("lib/utils.ts"), null, "react: an ordinary module has no role");
roleCase(reactAdapter, roleFile("useThing.tsx", { flags: { jsx: true } }), "hook", "react: the hook name wins over a component's jsx");

// Express: tool conventions first, then the nearest folder decides.
roleCase(expressAdapter, roleFile("routes/users.js"), "router", "express: routes/ is a router");
roleCase(expressAdapter, roleFile("routes/v1/middleware/auth.js"), "middleware", "express: the nearest folder decides (middleware over routes)");
roleCase(expressAdapter, roleFile("controllers/users.js"), "controller", "express: controllers/ is a controller");
roleCase(expressAdapter, roleFile("services/user.js"), "service", "express: services/ is a service");
roleCase(expressAdapter, roleFile("models/user.js"), "model", "express: models/ is a model");
roleCase(expressAdapter, roleFile("app.js"), null, "express: a file outside the folder habit has no role");
roleCase(expressAdapter, roleFile("routes/__tests__/users.test.js"), "test", "express: a test file under routes/ is still a test");

// NestJS: the CLI's suffix names the role; a test suffix falls back to the runner.
roleCase(nestjsAdapter, roleFile("src/users/users.controller.ts"), "controller", "nestjs: the controller suffix is a controller");
roleCase(nestjsAdapter, roleFile("src/users/users.service.ts"), "service", "nestjs: the service suffix is a service");
roleCase(nestjsAdapter, roleFile("src/users/users.dto.ts"), "dto", "nestjs: the dto suffix is a dto");
roleCase(nestjsAdapter, roleFile("src/app.module.ts"), "module", "nestjs: the module suffix is a module");
roleCase(nestjsAdapter, roleFile("src/main.ts"), null, "nestjs: a file without a known suffix has no role");
roleCase(nestjsAdapter, roleFile("src/users/users.controller.spec.ts"), "test", "nestjs: a spec file is collected by the test runner first");

// Docusaurus: its own paths, its config files, then the React reading.
roleCase(docusaurusAdapter, roleFile("src/pages/index.tsx"), "page-route", "docusaurus: src/pages is a page-route");
roleCase(docusaurusAdapter, roleFile("src/theme/Footer.tsx"), "theme-override", "docusaurus: src/theme is a theme-override");
roleCase(docusaurusAdapter, roleFile("docusaurus.config.ts"), "config", "docusaurus: docusaurus.config.ts is a config");
roleCase(docusaurusAdapter, roleFile("sidebars.js"), "config", "docusaurus: sidebars.js is a config");
roleCase(docusaurusAdapter, roleFile("src/components/Widget.tsx", { flags: { jsx: true } }), "component", "docusaurus: everything else is read the React way");

// Fallback: only the tool conventions ever assign a role.
roleCase(fallbackAdapter, roleFile("jest.config.js"), "config", "fallback: a tool config is a config");
roleCase(fallbackAdapter, roleFile("src/app.test.ts"), "test", "fallback: a test pattern is a test");
roleCase(fallbackAdapter, roleFile("src/app.ts"), null, "fallback: an ordinary file has no role");

// ---- Section 8: Express routes over the view (Batch 3.3a) ----

console.log("=== 8. Express route migration: view-fed routesFromView equals the legacy report ===");

// The acceptance is strict: the complete RouteReport must be what it was when
// expressRoutes read the source trees — every route, omission, withheld gate,
// line number and record order included. The legacy reader (still in express.ts
// until Batch 3.3d) and the view reader see the same parsed sources, so a
// deep-equal of the two complete reports over the real fixture and over every
// synthetic shape proves the migration changed nothing. The fixture's report is
// additionally folded through the parser's own dedupe+sort and compared against
// the frozen expected.json, and the express-routes regression suite (sections
// A–G) now runs inside `pnpm test`.

// One comparison point: the same entries feed both readers (sorted by path,
// the order view.files carries), `unparsed` goes to both untouched, and the
// complete reports must be deeply equal.
const expressReportDiff = (
  what: string,
  entries: readonly ViewSourceEntry[],
  unparsed: readonly string[] = [],
): { legacy: RouteReport; view: RouteReport } => {
  const ordered = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const legacy = expressAdapter.routes!({ files: ordered.map((entry) => ({ path: entry.path, source: entry.source })), unparsed });
  const view = expressAdapter.routesFromView!(buildSynthetic(ordered, [], "."), unparsed);
  expect(
    deepEqual(legacy, view, "$"),
    `${what}: the view-based RouteReport equals the legacy report (routes, omitted, withheld, order)`,
  );
  return { legacy, view };
};

const routeKeys = (report: RouteReport): string[] =>
  report.routes.map((r) => `${r.method} ${r.pattern} ${r.path}@${r.line}`);
const omittedKeys = (report: RouteReport): string[] =>
  report.omitted.map((o) => `${o.path}@${o.line}: ${o.reason}`);

// 1-based line of the first occurrence of a needle in a file's source, for
// pinning exact line numbers in synthetic expectations.
const lineIn = (content: string, needle: string): number =>
  content.slice(0, content.indexOf(needle)).split("\n").length;

// The real fixture: complete-report equivalence plus the frozen baseline.
{
  const entry = corpus.get("express-routes");
  if (!entry) fail("express-routes: corpus entry missing");
  else {
    const view = entry.views.get(".");
    const files = entry.replay.parsed
      .filter((parsed) => parsed.project === ".")
      .map((parsed) => ({ path: parsed.path, source: parsed.source }));
    const unparsed = entry.replay.skipped
      .filter((f) => entry.walk.projectOf.get(f.path) === "." && f.reason !== "declaration-file")
      .map((f) => f.path);
    if (!view) fail("express-routes: project view missing");
    else {
      const legacy = expressAdapter.routes!({ files, unparsed });
      const viewReport = expressAdapter.routesFromView!(view, unparsed);
      expect(
        deepEqual(legacy, viewReport, "$"),
        "express-routes: the view-based RouteReport deep-equals the legacy report over the real fixture",
      );

      const frozen = JSON.parse(readBaseline(path.join(FIXTURES, "express-routes", "expected.json"))) as ParseResult;
      expect(
        deepEqual(viewReport.withheld, null, "$"),
        "express-routes: the report is not withheld, as frozen",
      );
      expect(
        deepEqual(frozen.coverage.routes.withheld, [], "$"),
        "express-routes: no project is withheld in the frozen expected.json",
      );
      expect(
        deepEqual(
          [...viewReport.omitted]
            .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
            .map((o) => ({ file: o.path, line: o.line, reason: o.reason })),
          frozen.coverage.routes.omitted,
          "$",
        ),
        "express-routes: the omitted records (file, line, reason) equal the frozen expected.json",
      );
      // The parser folds the report through its own last-wins dedupe and
      // (pattern, method, file) sort; replicating that here pins the frozen
      // routes directly against this section's report.
      const unique = new Map(
        viewReport.routes.map((r) => [`${r.method} ${r.pattern} ${r.path}`, { file: r.path, method: r.method, pattern: r.pattern, line: r.line }]),
      );
      const folded = [...unique.values()].sort(
        (a, b) => a.pattern.localeCompare(b.pattern) || a.method.localeCompare(b.method) || a.file.localeCompare(b.file),
      );
      expect(
        deepEqual(folded, frozen.routes, "$"),
        "express-routes: the report's routes, deduped last-wins and sorted, equal the frozen expected.json",
      );
    }
  }
}

// Circular mounts: each file mounts the other; both registrations are omitted
// with the circular-chain reason, never guessed.
{
  const aContent = `const express = require("express");
const bRouter = require("./syn-circular-b");
const app = express();
app.use("/a", bRouter);
app.get("/from-a", handlerA);
function handlerA(_q, s) { s.json({}); }
`;
  const bContent = `const express = require("express");
const aApp = require("./syn-circular-a");
const router = express.Router();
router.use("/b", aApp);
router.get("/from-b", handlerB);
function handlerB(_q, s) { s.json({}); }
`;
  const a = synthFile("syn-circular-a.js", aContent);
  const b = synthFile("syn-circular-b.js", bContent);
  const { view } = expressReportDiff("circular mounts", [a, b]);
  expect(
    deepEqual(
      omittedKeys(view),
      [
        `syn-circular-a.js@${lineIn(aContent, `app.get("/from-a"`)}: the router it's registered on is mounted through a circular chain`,
        `syn-circular-b.js@${lineIn(bContent, `router.get("/from-b"`)}: the router it's registered on is mounted through a circular chain`,
      ],
      "$",
    ),
    "circular mounts: both registrations are omitted with the exact circular reason",
  );
  expect(deepEqual(view.routes, [], "$"), "circular mounts: no route is invented");
}

// Ambiguous target: the mounted value comes from a file that declares two
// routers; every router there is prefix-unknown with the exact reason.
{
  const helpersContent = `const express = require("express");
const r1 = express.Router();
const r2 = express.Router();
r1.get("/one", handler1);
r2.get("/two", handler2);
function handler1(_q, s) { s.json({}); }
function handler2(_q, s) { s.json({}); }
`;
  const appContent = `const express = require("express");
const { r1 } = require("./syn-amb-helpers");
const app = express();
app.use("/h", r1);
`;
  const helpers = synthFile("syn-amb-helpers.js", helpersContent);
  const app = synthFile("syn-amb-app.js", appContent);
  const { view } = expressReportDiff("ambiguous target", [helpers, app]);
  const reason = `the value mounted from syn-amb-app.js can't be traced to a single router`;
  expect(
    deepEqual(
      omittedKeys(view),
      [
        `syn-amb-helpers.js@${lineIn(helpersContent, `r1.get("/one"`)}: ${reason}`,
        `syn-amb-helpers.js@${lineIn(helpersContent, `r2.get("/two"`)}: ${reason}`,
      ],
      "$",
    ),
    "ambiguous target: both routers are omitted with the exact ambiguous reason",
  );
}

// Unresolved imports and unsupported receiver shapes: an unresolvable mounted
// value is middleware (no mount), a bare require argument is not an
// identifier, a chained receiver is ignored — and optional chaining on an
// identifier receiver IS a registration, exactly as the legacy scan saw it.
{
  const appContent = `const express = require("express");
const ghost = require("./syn-does-not-exist");
const app = express();
app.use("/ghost", ghost);
app.use("/ghost2", require("./syn-also-missing"));
app?.get("/optional", handler);
app.route("/chained").get(handler);
app.get("/real", handler);
function handler(_q, s) { s.json({}); }
`;
  const app = synthFile("syn-unr-app.js", appContent);
  const { view } = expressReportDiff("unresolved imports and receiver shapes", [app]);
  expect(
    deepEqual(
      routeKeys(view),
      [
        `GET /optional syn-unr-app.js@${lineIn(appContent, `app?.get("/optional"`)}`,
        `GET /real syn-unr-app.js@${lineIn(appContent, `app.get("/real"`)}`,
      ],
      "$",
    ),
    "unresolved: only the optional-chained and the real registration survive, in document order",
  );
}

// Empty arrays: an empty path array is unknown, never a zero-length prefix —
// for a registration's own path (explicit omission) and for a mount (the
// mounted router's registrations are prefix-unknown).
{
  const mountContent = `const express = require("express");
const emptyPathRouter = require("./syn-empty-routes");
const nonLiteralRouter = require("./syn-nl-routes");
const app = express();
app.use([], nonLiteralRouter);
app.use("/e", emptyPathRouter);
`;
  const emptyContent = `const express = require("express");
const emptyRouter = express.Router();
emptyRouter.get([], handler3);
function handler3(_q, s) { s.json({}); }
`;
  const nlContent = `const express = require("express");
const nlRouter = express.Router();
nlRouter.get("/nl", handler4);
function handler4(_q, s) { s.json({}); }
`;
  const mount = synthFile("syn-empty-mount.js", mountContent);
  const emptyRoutes = synthFile("syn-empty-routes.js", emptyContent);
  const nlRoutes = synthFile("syn-nl-routes.js", nlContent);
  const { view } = expressReportDiff("empty arrays", [mount, emptyRoutes, nlRoutes]);
  expect(
    deepEqual(
      omittedKeys(view),
      [
        `syn-empty-routes.js@${lineIn(emptyContent, `emptyRouter.get([]`)}: emptyRouter.get() is given a path that isn't a string literal`,
        `syn-nl-routes.js@${lineIn(nlContent, `nlRouter.get("/nl"`)}: the router it's registered on is mounted at a path that isn't a string literal`,
      ],
      "$",
    ),
    "empty arrays: an empty path array is unknown for both the registration and the mount",
  );
  expect(deepEqual(view.routes, [], "$"), "empty arrays: no route is invented");
}

// Import shapes the fixture doesn't have: TypeScript's import-equals binds no
// app factory (its "*" binding is not a namespace import), a namespace import
// does, a type-only import's local still traces a mount, and a computed-key
// destructured require keeps its local binding (imported: null).
{
  const eqContent = `import server = require("express");
import * as express from "express";
import type { router } from "./syn-eq-typed";

const { [which]: computed } = require("./syn-eq-computed");
const { typed } = require("./syn-eq-typed");

const app = express();
app.get("/namespace", handler);
app.use("/computed", computed);
app.use("/typed", typed);
app.use("/t", router);
server.get("/ignored", handler);

function handler(_q: unknown, s: { json(x: unknown): void }): void { s.json({}); }
const which = "r";
`;
  const computedContent = `const express = require("express");
const r = express.Router();
r.get("/computed", handlerC);
function handlerC(_q, s) { s.json({}); }
`;
  const typedContent = `const express = require("express");
const router = express.Router();
router.get("/typed", handlerT);
function handlerT(_q, s) { s.json({}); }
`;
  const eq = synthFile("syn-eq.ts", eqContent);
  const computedFile = synthFile("syn-eq-computed.js", computedContent);
  const typedFile = synthFile("syn-eq-typed.js", typedContent);
  const { view } = expressReportDiff("import-equals, namespace, type-only, computed require", [eq, computedFile, typedFile]);
  expect(
    deepEqual(
      routeKeys(view),
      [
        `GET /computed/computed syn-eq-computed.js@${lineIn(computedContent, `r.get("/computed"`)}`,
        `GET /typed/typed syn-eq-typed.js@${lineIn(typedContent, `router.get("/typed"`)}`,
        `GET /t/typed syn-eq-typed.js@${lineIn(typedContent, `router.get("/typed"`)}`,
        `GET /namespace syn-eq.ts@${lineIn(eqContent, `app.get("/namespace"`)}`,
      ],
      "$",
    ),
    "import shapes: namespace app is registered; the computed-key local mounts; the type-only import's local mounts through the same router (second prefix); import-equals binds nothing",
  );
}

// D1 closure: a named `default` binding (`import { default as e }`) is not the
// import clause's default slot. The legacy scan reads only that slot, so this
// spelling binds no app factory and the file is silent — the view now says the
// same through defaultSlot. Ordinary default imports keep declaring the app.
{
  const namedDefaultContent = `import { default as e } from "express";

const app = e();
app.get("/users", handler);

function handler(_q: unknown, s: { json(x: unknown): void }): void { s.json({}); }
`;
  const ordinaryContent = `import express from "express";

const app = express();
app.get("/ok", handler);
function handler(_q, s) { s.json({}); }
`;
  const namedDefault = synthFile("syn-named-default.ts", namedDefaultContent);
  const ordinary = synthFile("syn-def-ok.js", ordinaryContent);

  // The legacy behavior, pinned directly on the legacy reader.
  const namedOnly = expressAdapter.routes!({ files: [{ path: namedDefault.path, source: namedDefault.source }], unparsed: [] });
  expect(
    deepEqual(namedOnly, { routes: [], omitted: [], withheld: null }, "$"),
    "D1 legacy pin: import { default as e } from \"express\" declares no app — an entirely empty report",
  );
  const ordinaryOnly = expressAdapter.routes!({ files: [{ path: ordinary.path, source: ordinary.source }], unparsed: [] });
  expect(
    deepEqual(routeKeys(ordinaryOnly), [`GET /ok syn-def-ok.js@${lineIn(ordinaryContent, `app.get("/ok"`)}`], "$"),
    "D1 legacy pin: an ordinary default import still declares the app",
  );

  const { view } = expressReportDiff("D1 named default", [namedDefault, ordinary]);
  expect(
    deepEqual(routeKeys(view), [`GET /ok syn-def-ok.js@${lineIn(ordinaryContent, `app.get("/ok"`)}`], "$"),
    "D1 view: identical — only the ordinary default import produced a route",
  );
}

// D3 closure: the view carries the call's receiver/member as node names, so
// comment trivia inside a receiver chain can no longer lose a call. Every
// shape the legacy receiver-identifier check decided — comment in the chain,
// comment and whitespace around the dot, optional chaining, the plain form,
// a chained receiver even when its first segment is declared — resolves the
// same way over the view.
{
  const routesContent = `const express = require("express");
const router = express.Router();
router.get("/deep", handlerR);
function handlerR(_q, s) { s.json({}); }
`;
  const appContent = `const express = require("express");
const router = require("./syn-comment-routes");
const a = express();
const app = express();
app/* mid */.use("/api", router);
app /* c */ .get("/users", handler);
app?.get("/opt", handler);
app.get /* c2 */ ("/plain", handler);
a.b.use("/api", router);
function handler(_q, s) { s.json({}); }
`;
  const routesFile = synthFile("syn-comment-routes.js", routesContent);
  const appFile = synthFile("syn-comment.js", appContent);
  const { view } = expressReportDiff("comment-trivia receiver chains", [routesFile, appFile]);
  expect(
    deepEqual(
      routeKeys(view),
      [
        `GET /api/deep syn-comment-routes.js@${lineIn(routesContent, `router.get("/deep"`)}`,
        `GET /users syn-comment.js@${lineIn(appContent, `app /* c */ .get("/users"`)}`,
        `GET /opt syn-comment.js@${lineIn(appContent, `app?.get("/opt"`)}`,
        `GET /plain syn-comment.js@${lineIn(appContent, `app.get /* c2 */ ("/plain"`)}`,
      ],
      "$",
    ),
    "comment trivia: the commented mount mounts, commented and optional registrations survive, the chained a.b.use is rejected (with `a` declared, so a naive split would match)",
  );
}

// Withholding: any qualifying unparsed code file gates the whole report, with
// the exact singular reason string.
{
  const appContent = `const express = require("express");
const app = express();
app.get("/w", handler5);
function handler5(_q, s) { s.json({}); }
`;
  const app = synthFile("syn-withhold-app.js", appContent);
  const { view } = expressReportDiff("withholding", [app], ["syn-broken.js"]);
  expect(
    deepEqual(
      view.withheld,
      "1 file wasn't parsed, and one could mount a router under another prefix",
      "$",
    ),
    "withholding: the exact singular withheld reason survives",
  );
  expect(deepEqual(view.routes, [], "$"), "withholding: no route is emitted under the gate");
  expect(deepEqual(view.omitted, [], "$"), "withholding: no omission is emitted under the gate");
}

// Same FrameworkView instance for roles and routes, and the legacy readers
// out of production: not externally observable (applyAdapters passes the one
// `view` it built to roleOf and routesFromView alike, and a second build
// would be content-equal anyway), so the pin is structural — the
// orchestration must call routesFromView with that same view variable, fall
// back to NO_ROUTES when an adapter has no route logic, and never invoke the
// legacy routes() spellings or build an AdapterFile.
{
  const orchestration = readFileSync(path.resolve("lib/parser/index.ts"), "utf8").replace(/\r\n/g, "\n");
  const prefersView = orchestration.includes("adapter.routesFromView?.(view, unparsed) ?? NO_ROUTES");
  const noAdapterFiles = !orchestration.includes("AdapterFile");
  const noLegacyRoutes = !/adapter\.routes\(/.test(orchestration);
  if (prefersView && noAdapterFiles && noLegacyRoutes) {
    pass("orchestration: routesFromView is called with the same view variable roleOf read; no legacy routes path, no AdapterFile");
  } else {
    fail(`orchestration: view-only pin broken (prefersView=${prefersView}, noAdapterFiles=${noAdapterFiles}, noLegacyRoutes=${noLegacyRoutes})`);
  }
}

// ---- Section 9: FrameworkView compatibility extensions (Batch 3.3b.1) ----

console.log("=== 9. Compatibility extensions: bare decorators, anonymous/computed declarations, walk order ===");

// 1-based line of a needle's occurrence in a file's source (0 = first), for
// pinning exact line numbers in synthetic expectations.
const lineOf = (content: string, needle: string, occurrence = 0): number => {
  let at = -1;
  for (let i = 0; i <= occurrence; i += 1) {
    at = content.indexOf(needle, at + 1);
    if (at < 0) throw new Error(`needle not found (occurrence ${i}): ${JSON.stringify(needle)}`);
  }
  return content.slice(0, at).split("\n").length;
};

// N1: a bare decorator (`@Controller`) is marked as such; the call form
// (`@Controller()`) carries no flag even at zero arguments, so an empty
// argument list alone never reads as the bare spelling. Name, arguments and
// line survive on both forms.
{
  const content = `const Controller: unknown = undefined;
const Get: unknown = undefined;

@Controller
class Bare {
  @Get
  touch() {}
}

@Controller()
class Called {
  @Get("x")
  poke() {}
}
`;
  const file = synthFile("syn-decorator-forms.ts", content);
  const view = buildSynthetic([file]);
  const declarations = new Map(view.files[0]!.declarations.map((declaration) => [declaration.name, declaration]));
  expect(
    deepEqual(declarations.get("Bare")?.decorators, [
      { name: "Controller", arguments: [], line: lineOf(content, "@Controller\nclass Bare"), bare: true },
    ] satisfies ViewFile["declarations"][number]["decorators"], "$"),
    "N1: the bare @Controller is marked bare, with its own line and no arguments",
  );
  expect(
    deepEqual(declarations.get("Called")?.decorators, [
      { name: "Controller", arguments: [], line: lineOf(content, "@Controller()\nclass Called") },
    ] satisfies ViewFile["declarations"][number]["decorators"], "$"),
    "N1: the call-form @Controller() at zero arguments carries no bare flag — the forms stay distinct",
  );
  expect(
    deepEqual(declarations.get("Bare.touch")?.decorators, [
      { name: "Get", arguments: [], line: lineOf(content, "@Get\n  touch"), bare: true },
    ] satisfies ViewFile["declarations"][number]["decorators"], "$"),
    "N1: a bare method decorator is marked bare",
  );
  expect(
    deepEqual(declarations.get("Called.poke")?.decorators, [
      { name: "Get", arguments: [{ kind: "string", value: "x" }], line: lineOf(content, '@Get("x")') },
    ] satisfies ViewFile["declarations"][number]["decorators"], "$"),
    "N1: the call-form method decorator keeps its argument and line, unmarked",
  );
}

// N2: anonymous classes and computed-name methods — the declarations the
// legacy route readers process but the view used to drop — are carried in
// document order, with ownerClass giving every method its class by per-file
// ordinal. Nothing is evaluated or invented: a computed name is "" and
// flagged, and ownership never depends on a synthetic name.
{
  const content = `const Controller: unknown = undefined;
const Get: unknown = undefined;

@Get()
class Twin {
  @Get()
  alpha() {}

  @Get()
  ["beta"]() {}
}

@Get()
class Twin {
  @Get()
  alpha() {}

  @Get()
  extra() {}
}

export default @Get()
class {
  @Get()
  index() {}

  @Get()
  ["gamma"]() {}
}
`;
  const file = synthFile("syn-declaration-ownership.ts", content);
  const view = buildSynthetic([file]);
  const decls = view.files[0]!.declarations;
  expect(
    deepEqual(decls, [
      {
        name: "Twin",
        kind: "class",
        line: lineOf(content, "@Get()\nclass Twin"),
        decorators: [{ name: "Get", arguments: [], line: lineOf(content, "@Get()\nclass Twin") }],
        initializerCall: null,
      },
      {
        name: "Twin.alpha",
        kind: "function",
        line: lineOf(content, "@Get()\n  alpha"),
        decorators: [{ name: "Get", arguments: [], line: lineOf(content, "@Get()\n  alpha") }],
        initializerCall: null,
        ownerClass: 1,
      },
      {
        name: "",
        kind: "function",
        line: lineOf(content, '@Get()\n  ["beta"]'),
        decorators: [{ name: "Get", arguments: [], line: lineOf(content, '@Get()\n  ["beta"]') }],
        initializerCall: null,
        ownerClass: 1,
        nameComputed: true,
      },
      {
        name: "Twin",
        kind: "class",
        line: lineOf(content, "@Get()\nclass Twin", 1),
        decorators: [{ name: "Get", arguments: [], line: lineOf(content, "@Get()\nclass Twin", 1) }],
        initializerCall: null,
      },
      {
        name: "Twin.alpha",
        kind: "function",
        line: lineOf(content, "@Get()\n  alpha", 1),
        decorators: [{ name: "Get", arguments: [], line: lineOf(content, "@Get()\n  alpha", 1) }],
        initializerCall: null,
        ownerClass: 2,
      },
      {
        name: "Twin.extra",
        kind: "function",
        line: lineOf(content, "@Get()\n  extra"),
        decorators: [{ name: "Get", arguments: [], line: lineOf(content, "@Get()\n  extra") }],
        initializerCall: null,
        ownerClass: 2,
      },
      {
        name: "",
        kind: "class",
        line: lineOf(content, "@Get()\nclass {"),
        decorators: [{ name: "Get", arguments: [], line: lineOf(content, "@Get()\nclass {") }],
        initializerCall: null,
      },
      {
        name: "index",
        kind: "function",
        line: lineOf(content, "@Get()\n  index"),
        decorators: [{ name: "Get", arguments: [], line: lineOf(content, "@Get()\n  index") }],
        initializerCall: null,
        ownerClass: 3,
      },
      {
        name: "",
        kind: "function",
        line: lineOf(content, '@Get()\n  ["gamma"]'),
        decorators: [{ name: "Get", arguments: [], line: lineOf(content, '@Get()\n  ["gamma"]') }],
        initializerCall: null,
        ownerClass: 3,
        nameComputed: true,
      },
      { name: "Controller", kind: "const", line: lineOf(content, "const Controller"), decorators: [], initializerCall: null },
      { name: "Get", kind: "const", line: lineOf(content, "const Get"), decorators: [], initializerCall: null },
    ] satisfies ViewFile["declarations"], "$"),
    "N2: anonymous classes, computed-name methods and duplicate class names are carried in document order with ordinal ownership",
  );
  const classes = decls.filter((declaration) => declaration.kind === "class");
  expect(
    deepEqual(classes.map((declaration) => declaration.name), ["Twin", "Twin", ""] satisfies string[], "$"),
    "N2: three class declarations in document order; the anonymous one carries no name",
  );
  expect(
    deepEqual(decls.filter((declaration) => declaration.name === "Twin.alpha").map((declaration) => declaration.ownerClass), [1, 2] satisfies (number | undefined)[], "$"),
    "N2: same-named classes' same-named methods separate by owner ordinal",
  );
  expect(
    deepEqual(classes.map((_, index) => decls.filter((declaration) => declaration.ownerClass === index + 1).length), [2, 2, 2] satisfies number[], "$"),
    "N2: each class recovers exactly its own two methods by counting class declarations in order",
  );
  expect(
    deepEqual(buildSynthetic([file]), buildSynthetic([file]), "$"),
    "N2: identity and ownership are deterministic across repeated builds",
  );
}

// N3: the view records each file's rank in the repository walk's original
// order, so a consumer can iterate the walker's own order — naming the first
// offending file in a withhold reason exactly as the legacy route readers
// did — while `files` stays sorted by path. The synthetic repo makes the two
// orders disagree: the walker visits src/index.js before src.js; the path
// sort reverses them.
{
  const versioningContent = "app.enableVersioning();\n";
  const dir = mkdtempSync(path.join(tmpdir(), "adapter-view-walk-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), versioningContent, "utf8");
    writeFileSync(path.join(dir, "src.js"), versioningContent, "utf8");

    const selection = selectFiles(dir);
    const walkOrder = selection.walk.candidates.map((candidate) => candidate.path);
    expect(
      deepEqual(walkOrder, ["src/index.js", "src.js"] satisfies string[], "$"),
      "N3: the walker's actual output visits src/index.js before src.js (per-directory entry sort, not a path sort)",
    );

    const entries = selection.walk.candidates.map((candidate, rank) => ({
      path: candidate.path,
      absolutePath: candidate.absolutePath,
      source: syntheticProject.createSourceFile(candidate.absolutePath, candidate.content, { overwrite: true }),
      walkOrder: rank,
    }));
    const view = buildFrameworkView({ project: ".", files: entries, skipped: [], resolveSpecifier: stubResolve });

    expect(
      deepEqual(view.files.map((file) => file.path), ["src.js", "src/index.js"] satisfies string[], "$"),
      "N3: view.files stays path-sorted — which here reverses the walk order",
    );
    expect(
      deepEqual(view.files.map((file) => [file.path, file.walkOrder]), [["src.js", 1], ["src/index.js", 0]] satisfies (string | number | undefined)[][], "$"),
      "N3: each file's walkOrder is its rank in the walker's original order",
    );
    const byWalkOrder = [...view.files].sort((a, b) => (a.walkOrder ?? 0) - (b.walkOrder ?? 0));
    expect(
      deepEqual(byWalkOrder.map((file) => file.path), walkOrder satisfies string[], "$"),
      "N3: sorting a copy by walkOrder recovers the walker's original order",
    );
    expect(
      deepEqual(view.files.every((file) => file.calls.some((call) => call.member === "enableVersioning")), true, "$"),
      "N3: both files' versioning calls are carried (per-file document order intact)",
    );

    // The legacy reader — iterating in walk order — withholds naming the
    // FIRST offender; iterating path-sorted would name the other. The
    // walkOrder metadata is what lets a view consumer name the same file.
    const sources = new Map(entries.map((entry) => [entry.path, entry.source]));
    const legacyWalk = nestjsAdapter.routes!({ files: byWalkOrder.map((file) => ({ path: file.path, source: sources.get(file.path)! })), unparsed: [] });
    expect(
      deepEqual(legacyWalk.withheld, "src/index.js enables versioning, which can add a version to any path", "$"),
      "N3: legacy, iterating in walk order, names the first walk-ordered offender — recoverable from the metadata",
    );
    const legacySorted = nestjsAdapter.routes!({ files: view.files.map((file) => ({ path: file.path, source: sources.get(file.path)! })), unparsed: [] });
    expect(
      deepEqual(legacySorted.withheld, "src.js enables versioning, which can add a version to any path", "$"),
      "N3: path-sorted iteration would name the other file — the divergence the metadata exists to repair",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The same recovery for the RouterModule withholding, whose reason also names
// the first offending file in iteration order.
{
  const moduleContent = 'import { RouterModule } from "@nestjs/core";\n';
  const dir = mkdtempSync(path.join(tmpdir(), "adapter-view-walk-rm-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.ts"), moduleContent, "utf8");
    writeFileSync(path.join(dir, "src.ts"), moduleContent, "utf8");

    const selection = selectFiles(dir);
    const walkOrder = selection.walk.candidates.map((candidate) => candidate.path);
    expect(
      deepEqual(walkOrder, ["src/index.ts", "src.ts"] satisfies string[], "$"),
      "N3: the walker's actual output visits src/index.ts before src.ts",
    );

    const entries = selection.walk.candidates.map((candidate, rank) => ({
      path: candidate.path,
      absolutePath: candidate.absolutePath,
      source: syntheticProject.createSourceFile(candidate.absolutePath, candidate.content, { overwrite: true }),
      walkOrder: rank,
    }));
    const view = buildFrameworkView({ project: ".", files: entries, skipped: [], resolveSpecifier: stubResolve });
    expect(
      deepEqual(
        view.files.every((file) =>
          file.imports.some((imported) => imported.specifier === "@nestjs/core" && imported.bindings.some((binding) => binding.imported === "RouterModule")),
        ),
        true,
        "$",
      ),
      "N3: both files' RouterModule imports are carried",
    );
    const byWalkOrder = [...view.files].sort((a, b) => (a.walkOrder ?? 0) - (b.walkOrder ?? 0));
    const sources = new Map(entries.map((entry) => [entry.path, entry.source]));
    const legacy = nestjsAdapter.routes!({ files: byWalkOrder.map((file) => ({ path: file.path, source: sources.get(file.path)! })), unparsed: [] });
    expect(
      deepEqual(legacy.withheld, "src/index.ts uses RouterModule, which prefixes whole modules", "$"),
      "N3: the first RouterModule importer in walk order is the one legacy names, and the metadata recovers it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A caller that doesn't track the walk order carries none: the field is
// optional end to end, so nothing existing changes shape.
{
  const file = synthFile("syn-no-walk-order.ts", "export const x = 1;\n");
  const view = buildSynthetic([file]);
  expect(deepEqual(view.files[0]?.walkOrder, undefined, "$"), "N3: a caller that passes no walk order carries none");
}

// ---- Section 10: NestJS routes over the view (Batch 3.3b.2) ----

console.log("=== 10. NestJS route migration: view-fed routesFromView equals the legacy report ===");

// The acceptance is strict, as in Section 8: the complete RouteReport must be
// what it was when nestRoutes read the source trees — every route, omission,
// withheld gate, line number and record order included. The legacy reader
// (still in nestjs.ts until Batch 3.3d) is the behavioral specification; the
// view reader sees the same parsed sources, so a deep-equal of the two
// complete reports over the real fixture and over every synthetic shape proves
// the migration changed nothing — including its quirks (bare identifier
// versioning calls undetected, bare decorators unrecognized, the version
// property's precedence, computed keys and spreads).

// One comparison point: the same entries feed both readers (sorted by path,
// the order view.files carries when no walk order is attached), `unparsed`
// goes to both untouched, and the complete reports must be deeply equal.
const nestjsReportDiff = (
  what: string,
  entries: readonly ViewSourceEntry[],
  unparsed: readonly string[] = [],
): { legacy: RouteReport; view: RouteReport } => {
  const ordered = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const legacy = nestjsAdapter.routes!({ files: ordered.map((entry) => ({ path: entry.path, source: entry.source })), unparsed });
  const view = nestjsAdapter.routesFromView!(buildSynthetic(ordered, [], "."), unparsed);
  expect(
    deepEqual(legacy, view, "$"),
    `${what}: the view-based RouteReport equals the legacy report (routes, omitted, withheld, order)`,
  );
  return { legacy, view };
};

// 1. The real fixture: complete-report equivalence plus the frozen baseline.
{
  const entry = corpus.get("two-framework-monorepo");
  if (!entry) fail("two-framework-monorepo: corpus entry missing");
  else {
    const project = "packages/api";
    const view = entry.views.get(project);
    const files = entry.replay.parsed
      .filter((parsed) => parsed.project === project)
      .map((parsed) => ({ path: withinProject(project, parsed.path), source: parsed.source }));
    const unparsed = entry.replay.skipped
      .filter((f) => entry.walk.projectOf.get(f.path) === project && f.reason !== "declaration-file")
      .map((f) => withinProject(project, f.path));
    if (!view) fail("two-framework-monorepo: packages/api view missing");
    else {
      const legacy = nestjsAdapter.routes!({ files, unparsed });
      const viewReport = nestjsAdapter.routesFromView!(view, unparsed);
      expect(
        deepEqual(legacy, viewReport, "$"),
        "nestjs fixture: the view-based RouteReport deep-equals the legacy report over packages/api",
      );
      const frozen = JSON.parse(readBaseline(path.join(FIXTURES, "two-framework-monorepo", "expected.json"))) as ParseResult;
      // The frozen baseline names files the way the parser records routes —
      // repository-relative — while a RouteReport is project-relative.
      const unique = new Map(
        viewReport.routes.map((r) => [
          `${r.method} ${r.pattern} ${r.path}`,
          { file: `${project}/${r.path}`, method: r.method, pattern: r.pattern, line: r.line },
        ]),
      );
      const folded = [...unique.values()].sort(
        (a, b) => a.pattern.localeCompare(b.pattern) || a.method.localeCompare(b.method) || a.file.localeCompare(b.file),
      );
      expect(
        deepEqual(folded, frozen.routes, "$"),
        "nestjs fixture: the report's routes, deduped last-wins and sorted, equal the frozen expected.json",
      );
      expect(deepEqual(viewReport.withheld, null, "$"), "nestjs fixture: the report is not withheld, as frozen");
      expect(
        deepEqual(frozen.coverage.routes.withheld, [], "$"),
        "nestjs fixture: no project is withheld in the frozen expected.json",
      );
    }
  }
}

// 2. Bootstrap + single literal prefix: NestFactory.create counts, the
// prefix composes into every pattern, routes keep their decorator lines.
{
  const content = `import { NestFactory } from "@nestjs/core";
import { Controller, Get, Post } from "@nestjs/common";

@Controller("/users")
class UsersController {
  @Get()
  list() {}
  @Post("create")
  create() {}
}

async function bootstrap() {
  const app = await NestFactory.create(0);
  app.setGlobalPrefix("/api");
}
`;
  const file = synthFile("syn-nest-main.ts", content);
  const { legacy } = nestjsReportDiff("bootstrap + prefix", [file]);
  expect(
    deepEqual(
      routeKeys(legacy),
      [
        `GET /api/users syn-nest-main.ts@${lineOf(content, "@Get()\n  list")}`,
        `POST /api/users/create syn-nest-main.ts@${lineOf(content, '@Post("create")')}`,
      ],
      "$",
    ),
    "bootstrap + prefix: the global prefix composes and the decorator lines survive",
  );
}

// 3–6. Prefix validation, in the legacy order: more than one prefix call,
// zero bootstraps, two bootstraps, a computed value, an options argument.
{
  const twiceContent = `import { Controller } from "@nestjs/common";

@Controller("/x")
class C {}

app.setGlobalPrefix("/a");
app.setGlobalPrefix("/b");
`;
  expect(
    deepEqual(nestjsReportDiff("two prefix calls", [synthFile("syn-nest-prefix-twice.ts", twiceContent)]).legacy.withheld, "setGlobalPrefix is called more than once", "$"),
    "two prefix calls: the exact withheld reason, before any bootstrap check",
  );

  const zeroContent = `app.setGlobalPrefix("/api");
`;
  expect(
    deepEqual(nestjsReportDiff("zero bootstraps", [synthFile("syn-nest-no-bootstrap.ts", zeroContent)]).legacy.withheld, "setGlobalPrefix is called, but there are 0 bootstraps it could apply to", "$"),
    "zero bootstraps: the exact withheld reason fires at 0 too",
  );

  const twoContent = `const a = await NestFactory.create(0);
const b = await NestFactory.create(0);
app.setGlobalPrefix("/api");
`;
  expect(
    deepEqual(nestjsReportDiff("two bootstraps", [synthFile("syn-nest-two-bootstraps.ts", twoContent)]).legacy.withheld, "setGlobalPrefix is called, but there are 2 bootstraps it could apply to", "$"),
    "two bootstraps: the exact withheld reason counts both NestFactory.create calls",
  );

  const computedContent = `const app = await NestFactory.create(0);
app.setGlobalPrefix(basePath);
`;
  expect(
    deepEqual(nestjsReportDiff("computed prefix", [synthFile("syn-nest-prefix-computed.ts", computedContent)]).legacy.withheld, "syn-nest-prefix-computed.ts sets the global prefix to a computed value", "$"),
    "computed prefix: the withheld reason names the file",
  );

  const optionsContent = `const app = await NestFactory.create(0);
app.setGlobalPrefix("/api", { exclude: ["a"] });
`;
  expect(
    deepEqual(nestjsReportDiff("prefix options", [synthFile("syn-nest-prefix-options.ts", optionsContent)]).legacy.withheld, "syn-nest-prefix-options.ts excludes some routes from the global prefix", "$"),
    "prefix options: a second argument excludes the whole report",
  );
}

// 7–9. Versioning: any property-access enableVersioning call withholds
// naming the file — chained and optional-chained receivers included — while
// a bare identifier call stays undetected, as in the legacy scan.
{
  const plainContent = `app.enableVersioning();
`;
  expect(
    deepEqual(nestjsReportDiff("versioning", [synthFile("syn-nest-versioning.ts", plainContent)]).legacy.withheld, "syn-nest-versioning.ts enables versioning, which can add a version to any path", "$"),
    "versioning: the exact withheld reason names the file",
  );

  const chainedContent = `globalApp.versioning.enableVersioning();
`;
  expect(
    deepEqual(nestjsReportDiff("chained versioning", [synthFile("syn-nest-versioning-chained.ts", chainedContent)]).legacy.withheld, "syn-nest-versioning-chained.ts enables versioning, which can add a version to any path", "$"),
    "chained versioning: a chained receiver is still detected",
  );

  const optionalContent = `app?.enableVersioning();
`;
  expect(
    deepEqual(nestjsReportDiff("optional-chained versioning", [synthFile("syn-nest-versioning-optional.ts", optionalContent)]).legacy.withheld, "syn-nest-versioning-optional.ts enables versioning, which can add a version to any path", "$"),
    "optional-chained versioning: detected, exactly as the legacy property-access scan saw it",
  );

  const bareContent = `import { Controller, Get } from "@nestjs/common";

@Controller("/users")
class UsersController {
  @Get()
  list() {}
}

enableVersioning(app);
`;
  const { legacy } = nestjsReportDiff("bare versioning call", [synthFile("syn-nest-versioning-bare.ts", bareContent)]);
  expect(deepEqual(legacy.withheld, null, "$"), "bare versioning call: an identifier callee is NOT versioning — the legacy quirk");
  expect(
    deepEqual(routeKeys(legacy), [`GET /users syn-nest-versioning-bare.ts@${lineOf(bareContent, "@Get()\n  list")}`], "$"),
    "bare versioning call: routes flow as if versioning was never there",
  );
}

// 10–14. RouterModule: a named import from @nestjs/core withholds naming
// the file — aliased or not — while namespace, import-equals, named-default,
// require and an unrelated specifier stay silent, exactly as the legacy
// named-import map saw them.
{
  const controller = (extra: string) => `import { Controller, Get } from "@nestjs/common";
${extra}
@Controller("/x")
class C {
  @Get("/y")
  m() {}
}
`;
  const plain = nestjsReportDiff("RouterModule plain", [synthFile("syn-nest-routermodule.ts", `import { RouterModule } from "@nestjs/core";\n`)]);
  expect(deepEqual(plain.legacy.withheld, "syn-nest-routermodule.ts uses RouterModule, which prefixes whole modules", "$"), "RouterModule plain: the exact withheld reason");

  const aliased = nestjsReportDiff("RouterModule aliased", [synthFile("syn-nest-routermodule-alias.ts", `import { RouterModule as RM } from "@nestjs/core";\n`)]);
  expect(deepEqual(aliased.legacy.withheld, "syn-nest-routermodule-alias.ts uses RouterModule, which prefixes whole modules", "$"), "RouterModule aliased: an alias is still RouterModule");

  for (const [name, extra] of [
    ["unrelated package", `import { RouterModule } from "@nestjs/router";`],
    ["namespace import", `import * as core from "@nestjs/core";`],
    ["import-equals", `import core = require("@nestjs/core");`],
    ["named default", `import { default as RM } from "@nestjs/core";`],
    ["require", `const { RouterModule } = require("@nestjs/core");`],
  ] as const) {
    const content = controller(extra);
    const { legacy } = nestjsReportDiff(`RouterModule ${name}`, [synthFile(`syn-nest-rm-${name.replace(/ /g, "-")}.ts`, content)]);
    expect(deepEqual(legacy.withheld, null, "$"), `RouterModule ${name}: no withholding`);
    expect(
      deepEqual(routeKeys(legacy), [`GET /x/y ${`syn-nest-rm-${name.replace(/ /g, "-")}.ts`}@${lineOf(content, '@Get("/y")')}`], "$"),
      `RouterModule ${name}: routes flow normally`,
    );
  }
}

// 15–16. Bare @Controller invents nothing; the call form is recognized.
// (This comparison is only writable since Batch 3.3b.1 gave the view the
// bare marker.)
{
  const content = `import { Controller, Get } from "@nestjs/common";

@Controller
class Bare {
  @Get("/hidden")
  m() {}
}

@Controller()
class Called {
  @Get("/found")
  n() {}
}
`;
  const { legacy } = nestjsReportDiff("bare controller", [synthFile("syn-nest-bare-controller.ts", content)]);
  expect(
    deepEqual(routeKeys(legacy), [`GET /found syn-nest-bare-controller.ts@${lineOf(content, '@Get("/found")')}`], "$"),
    "bare controller: only the call-form class is a controller; the bare spelling invents no route",
  );
}

// 17–23. Controller and method path shapes, every supported method
// decorator, unknown decorators, and every omission — one kitchen-sink
// file, complete-report equality plus exact pins on the subtle outcomes.
{
  const content = `import { Controller, Get, Post, Put, Delete, Patch, Options, Head, Search, All, Custom } from "@nestjs/common";

@Controller("/users")
class Users {
  @Get()
  list() {}
  @Post("create")
  create() {}
  @Put(["/a", "/b"])
  put() {}
  @Delete("/d")
  del() {}
  @Patch()
  patch() {}
  @Options()
  opts() {}
  @Head()
  head() {}
  @Search()
  search() {}
  @All()
  all() {}
  @Custom()
  unknown() {}
  @Get(path)
  nonLiteral() {}
  @Get(["/x", ok()])
  mixed() {}
}

@Controller("/empty-string")
class EmptyStr {
  @Get("")
  empty() {}
}

@Controller()
class NoArg {
  @Get("/x")
  x() {}
}

@Controller(["/one", "/two"])
class Arrays {
  @Get("/leaf")
  leaf() {}
}

@Controller([])
class EmptyArr {
  @Get("/never")
  never() {}
}

@Controller({ path: "/obj" })
class ObjPath {
  @Get("/deep")
  deep() {}
}

@Controller({})
class EmptyObj {
  @Get("/still")
  still() {}
}

@Controller({ path: "/v", version: "1" })
class Versioned {
  @Get("/hidden")
  hidden() {}
}

@Controller({ version })
class VersionShorthand {
  @Get("/hidden2")
  hidden2() {}
}

@Controller({ path })
class ShorthandPath {
  @Get("/hidden3")
  hidden3() {}
}

@Controller({ ["path"]: "/ck" })
class ComputedKey {
  @Get("/visible")
  visible() {}
}

@Controller({ ...rest })
class SpreadOnly {
  @Get("/visible2")
  visible2() {}
}
`;
  const file = synthFile("syn-nest-controllers.ts", content);
  const { legacy } = nestjsReportDiff("controller and method path shapes", [file]);
  expect(
    deepEqual(
      routeKeys(legacy),
      [
        `GET /users syn-nest-controllers.ts@${lineOf(content, "@Get()\n  list")}`,
        `POST /users/create syn-nest-controllers.ts@${lineOf(content, '@Post("create")')}`,
        `PUT /users/a syn-nest-controllers.ts@${lineOf(content, '@Put(["/a", "/b"])')}`,
        `PUT /users/b syn-nest-controllers.ts@${lineOf(content, '@Put(["/a", "/b"])')}`,
        `DELETE /users/d syn-nest-controllers.ts@${lineOf(content, '@Delete("/d")')}`,
        `PATCH /users syn-nest-controllers.ts@${lineOf(content, "@Patch()\n  patch")}`,
        `OPTIONS /users syn-nest-controllers.ts@${lineOf(content, "@Options()\n  opts")}`,
        `HEAD /users syn-nest-controllers.ts@${lineOf(content, "@Head()\n  head")}`,
        `SEARCH /users syn-nest-controllers.ts@${lineOf(content, "@Search()\n  search")}`,
        `ALL /users syn-nest-controllers.ts@${lineOf(content, "@All()\n  all")}`,
        `GET /empty-string syn-nest-controllers.ts@${lineOf(content, '@Get("")')}`,
        `GET /x syn-nest-controllers.ts@${lineOf(content, '@Get("/x")')}`,
        `GET /one/leaf syn-nest-controllers.ts@${lineOf(content, '@Get("/leaf")')}`,
        `GET /two/leaf syn-nest-controllers.ts@${lineOf(content, '@Get("/leaf")')}`,
        `GET /obj/deep syn-nest-controllers.ts@${lineOf(content, '@Get("/deep")')}`,
        `GET /still syn-nest-controllers.ts@${lineOf(content, '@Get("/still")')}`,
        `GET /visible syn-nest-controllers.ts@${lineOf(content, '@Get("/visible")')}`,
        `GET /visible2 syn-nest-controllers.ts@${lineOf(content, '@Get("/visible2")')}`,
      ],
      "$",
    ),
    "path shapes: every supported method decorator maps, array and object paths compose, computed keys and spreads fall back to the empty path",
  );
  expect(
    deepEqual(
      omittedKeys(legacy).filter((key) => key.includes("isn't a string literal")),
      [
        `syn-nest-controllers.ts@${lineOf(content, "@Get(path)")}: @Get() is given a path that isn't a string literal`,
        `syn-nest-controllers.ts@${lineOf(content, '@Get(["/x", ok()])')}: @Get() is given a path that isn't a string literal`,
        `syn-nest-controllers.ts@${lineOf(content, "@Controller([])")}: @Controller() is given a path that isn't a string literal`,
        `syn-nest-controllers.ts@${lineOf(content, "@Controller({ path })")}: @Controller() is given a path that isn't a string literal`,
      ],
      "$",
    ),
    "path shapes: an empty array, an identifier, a mixed array and a shorthand path are omitted with the exact reason, in document order",
  );
  expect(
    deepEqual(
      omittedKeys(legacy).filter((key) => key.includes("version, which changes")),
      [
        `syn-nest-controllers.ts@${lineOf(content, '@Controller({ path: "/v", version: "1" })')}: @Controller() sets a version, which changes the path`,
        `syn-nest-controllers.ts@${lineOf(content, "@Controller({ version })")}: @Controller() sets a version, which changes the path`,
      ],
      "$",
    ),
    "path shapes: the version property (shorthand included) wins over path and withholds the class's methods",
  );
  if (routeKeys(legacy).every((key) => !key.includes("/hidden") && !key.includes("/never"))) {
    pass("path shapes: no route is invented for omitted classes (version, shorthand path, empty array)");
  } else {
    fail("path shapes: an omitted class still produced a route");
  }
}

// 24–27. Structural shapes: multiple controllers per file, two same-named
// classes whose methods must not merge, anonymous decorated classes, and
// computed-name methods — on both named and anonymous classes.
{
  const content = `import { Controller, Get } from "@nestjs/common";

@Controller("/first")
class Same {
  @Get("/one")
  handler() {}
}

@Controller("/second")
class Same {
  @Get("/two")
  handler() {}
}

export default @Controller("/anon")
class {
  @Get("/three")
  index() {}
  @Get("/four")
  ["computed"]() {}
}

@Controller("/computed")
class ComputedMethods {
  @Get("/named")
  named() {}
  @Get("/unnamed")
  ["renamed"]() {}
}
`;
  const { legacy } = nestjsReportDiff("structural shapes", [synthFile("syn-nest-shapes.ts", content)]);
  expect(
    deepEqual(
      routeKeys(legacy),
      [
        `GET /first/one syn-nest-shapes.ts@${lineOf(content, '@Get("/one")')}`,
        `GET /second/two syn-nest-shapes.ts@${lineOf(content, '@Get("/two")')}`,
        `GET /anon/three syn-nest-shapes.ts@${lineOf(content, '@Get("/three")')}`,
        `GET /anon/four syn-nest-shapes.ts@${lineOf(content, '@Get("/four")')}`,
        `GET /computed/named syn-nest-shapes.ts@${lineOf(content, '@Get("/named")')}`,
        `GET /computed/unnamed syn-nest-shapes.ts@${lineOf(content, '@Get("/unnamed")')}`,
      ],
      "$",
    ),
    "structural shapes: duplicate-named classes keep their own methods, anonymous classes are controllers, computed-name methods carry routes",
  );
}

// 28. Multiple files: routes accumulate in the path-sorted file order the
// view carries, each file's own document order intact.
{
  const make = (name: string, controllerPath: string, methodPath: string) =>
    synthFile(name, `import { Controller, Get } from "@nestjs/common";\n\n@Controller("${controllerPath}")\nclass C {\n  @Get("${methodPath}")\n  m() {}\n}\n`);
  const a = make("syn-nest-order-a.ts", "/a", "/one");
  const b = make("syn-nest-order-b.ts", "/b", "/one");
  const c = make("syn-nest-order-c.ts", "/c", "/one");
  const { legacy } = nestjsReportDiff("multiple files", [c, a, b]);
  expect(
    deepEqual(
      routeKeys(legacy),
      [
        `GET /a/one syn-nest-order-a.ts@${lineOf(a.source.getFullText(), '@Get("/one")')}`,
        `GET /b/one syn-nest-order-b.ts@${lineOf(b.source.getFullText(), '@Get("/one")')}`,
        `GET /c/one syn-nest-order-c.ts@${lineOf(c.source.getFullText(), '@Get("/one")')}`,
      ],
      "$",
    ),
    "multiple files: route order is file order then document order, identical on both readers",
  );
}

// 31. Unparsed withholding: the exact singular and plural reasons, straight
// from the `unparsed` argument.
{
  const file = synthFile("syn-nest-unparsed.ts", `const x = 1;\n`);
  expect(
    deepEqual(nestjsReportDiff("unparsed singular", [file], ["syn-broken.ts"]).legacy.withheld, "1 file wasn't parsed, and one could set a global prefix", "$"),
    "unparsed: the exact singular withheld reason",
  );
  expect(
    deepEqual(nestjsReportDiff("unparsed plural", [file], ["syn-broken.ts", "syn-broken2.ts"]).legacy.withheld, "2 files weren't parsed, and one could set a global prefix", "$"),
    "unparsed: the exact plural withheld reason",
  );
}

// 32–34. Walk order. With the metadata attached, the view reader iterates in
// the walker's original order — the order the legacy reader received — so
// the reports are equal AND the withhold reason names the same first
// offender. Without the metadata, both readers see the path-sorted order and
// are still equal, naming the other file.
{
  const versioningContent = "app.enableVersioning();\n";
  const dir = mkdtempSync(path.join(tmpdir(), "nest-routes-walk-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), versioningContent, "utf8");
    writeFileSync(path.join(dir, "src.js"), versioningContent, "utf8");
    const selection = selectFiles(dir);

    const withOrder = selection.walk.candidates.map((candidate, rank) => ({
      path: candidate.path,
      absolutePath: candidate.absolutePath,
      source: syntheticProject.createSourceFile(candidate.absolutePath, candidate.content, { overwrite: true }),
      walkOrder: rank,
    }));
    const orderedView = buildFrameworkView({ project: ".", files: withOrder, skipped: [], resolveSpecifier: stubResolve });
    const legacyWalk = nestjsAdapter.routes!({ files: withOrder.map((entry) => ({ path: entry.path, source: entry.source })), unparsed: [] });
    const viewWalk = nestjsAdapter.routesFromView!(orderedView, []);
    expect(
      deepEqual(legacyWalk, viewWalk, "$"),
      "walk order, metadata attached: the complete reports are equal (32)",
    );
    expect(
      deepEqual(viewWalk.withheld, "src/index.js enables versioning, which can add a version to any path", "$"),
      "walk order, metadata attached: the withhold reason names the first file in the walker's original order",
    );

    const withoutOrder = selection.walk.candidates.map((candidate) => ({
      path: candidate.path,
      absolutePath: candidate.absolutePath,
      source: syntheticProject.createSourceFile(candidate.absolutePath, candidate.content, { overwrite: true }),
    }));
    const pathView = buildFrameworkView({ project: ".", files: withoutOrder, skipped: [], resolveSpecifier: stubResolve });
    const legacyPath = nestjsAdapter.routes!({
      files: [...withoutOrder].sort((a, b) => a.path.localeCompare(b.path)).map((entry) => ({ path: entry.path, source: entry.source })),
      unparsed: [],
    });
    const viewPath = nestjsAdapter.routesFromView!(pathView, []);
    expect(
      deepEqual(legacyPath, viewPath, "$"),
      "walk order, metadata absent: the fallback to view.files order keeps the reports equal (34)",
    );
    expect(
      deepEqual(viewPath.withheld, "src.js enables versioning, which can add a version to any path", "$"),
      "walk order, metadata absent: the withhold reason names the path-sorted first file — the documented divergence the metadata repairs",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const moduleContent = 'import { RouterModule } from "@nestjs/core";\n';
  const dir = mkdtempSync(path.join(tmpdir(), "nest-routes-walk-rm-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.ts"), moduleContent, "utf8");
    writeFileSync(path.join(dir, "src.ts"), moduleContent, "utf8");
    const selection = selectFiles(dir);
    const withOrder = selection.walk.candidates.map((candidate, rank) => ({
      path: candidate.path,
      absolutePath: candidate.absolutePath,
      source: syntheticProject.createSourceFile(candidate.absolutePath, candidate.content, { overwrite: true }),
      walkOrder: rank,
    }));
    const view = buildFrameworkView({ project: ".", files: withOrder, skipped: [], resolveSpecifier: stubResolve });
    const legacy = nestjsAdapter.routes!({ files: withOrder.map((entry) => ({ path: entry.path, source: entry.source })), unparsed: [] });
    const viewReport = nestjsAdapter.routesFromView!(view, []);
    expect(
      deepEqual(legacy, viewReport, "$"),
      "walk order, RouterModule: the complete reports are equal over the walker's original order (33)",
    );
    expect(
      deepEqual(viewReport.withheld, "src/index.ts uses RouterModule, which prefixes whole modules", "$"),
      "walk order, RouterModule: the withhold reason names the first importer in the walker's original order",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- Section 11: Next.js routes over the view (Batch 3.3c.2) ----

console.log("=== 11. Next.js route migration: view-fed routesFromView equals the legacy report ===");

// The acceptance is strict, as in Sections 8 and 10: the complete RouteReport
// must be what it was when nextRoutes read the source trees — every route,
// omission, withheld gate, line number and record order included. The legacy
// reader (still in nextjs.ts until the cleanup batch) is the behavioral
// specification; the view reader sees the same parsed sources, so a deep-equal
// of the two complete reports over the real fixtures and over every synthetic
// shape proves the migration changed nothing — including its quirks (the
// file-wide config scan, the shorthand pass overriding an earlier explicit
// literal, `export * as ns` naming no method, computed keys and spreads).

// One comparison point: the same entries feed both readers (sorted by path,
// the order view.files carries when no walk order is attached), `unparsed`
// goes to both untouched, and the complete reports must be deeply equal.
const nextjsReportDiff = (
  what: string,
  entries: readonly ViewSourceEntry[],
  unparsed: readonly string[] = [],
): { legacy: RouteReport; view: RouteReport } => {
  const ordered = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const legacy = nextjsAdapter.routes!({ files: ordered.map((entry) => ({ path: entry.path, source: entry.source })), unparsed });
  const view = nextjsAdapter.routesFromView!(buildSynthetic(ordered, [], "."), unparsed);
  expect(
    deepEqual(legacy, view, "$"),
    `${what}: the view-based RouteReport equals the legacy report (routes, omitted, withheld, order)`,
  );
  return { legacy, view };
};

// Codepoint sort for the frozen-fold comparisons: the parser's own fold sorts
// with locale collation, whose treatment of punctuation is not worth
// replicating here — both sides of each comparison go through the same
// comparator, so the pin is on content, not on collation.
const byRoute = (a: { pattern: string; method: string; file: string }, b: { pattern: string; method: string; file: string }) =>
  a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
const byOmitted = (a: { path: string; line: number }, b: { path: string; line: number }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line);

// A. The real fixtures: complete-report equivalence plus the frozen baselines.
{
  const entry = corpus.get("nextjs-app-router");
  if (!entry) fail("nextjs-app-router: corpus entry missing");
  else {
    const view = entry.views.get(".");
    const files = entry.replay.parsed
      .filter((parsed) => parsed.project === ".")
      .map((parsed) => ({ path: parsed.path, source: parsed.source }));
    const unparsed = entry.replay.skipped
      .filter((f) => entry.walk.projectOf.get(f.path) === "." && f.reason !== "declaration-file")
      .map((f) => f.path);
    if (!view) fail("nextjs-app-router: project view missing");
    else {
      const legacy = nextjsAdapter.routes!({ files, unparsed });
      const viewReport = nextjsAdapter.routesFromView!(view, unparsed);
      expect(
        deepEqual(legacy, viewReport, "$"),
        "nextjs-app-router: the view-based RouteReport deep-equals the legacy report over the real fixture",
      );

      const frozen = JSON.parse(readBaseline(path.join(FIXTURES, "nextjs-app-router", "expected.json"))) as ParseResult;
      expect(deepEqual(viewReport.withheld, null, "$"), "nextjs-app-router: the report is not withheld, as frozen");
      expect(
        deepEqual(frozen.coverage.routes.withheld, [], "$"),
        "nextjs-app-router: no project is withheld in the frozen expected.json",
      );
      // The frozen file lists routes in its own order; the parser's fold sorts,
      // so both sides go through the same comparator before comparing.
      const unique = new Map(
        viewReport.routes.map((r) => [`${r.method} ${r.pattern} ${r.path}`, { file: r.path, method: r.method, pattern: r.pattern, line: r.line }]),
      );
      const folded = [...unique.values()].sort(byRoute);
      expect(
        deepEqual(folded, [...frozen.routes].sort(byRoute), "$"),
        "nextjs-app-router: the report's routes, deduped and sorted, equal the frozen expected.json",
      );
      expect(
        deepEqual(
          [...viewReport.omitted].sort(byOmitted).map((o) => ({ file: o.path, line: o.line, reason: o.reason })),
          frozen.coverage.routes.omitted,
          "$",
        ),
        "nextjs-app-router: the omitted records (file, line, reason) equal the frozen expected.json",
      );
    }
  }
}
{
  const entry = corpus.get("nextjs-pages-router");
  if (!entry) fail("nextjs-pages-router: corpus entry missing");
  else {
    const view = entry.views.get(".");
    const files = entry.replay.parsed
      .filter((parsed) => parsed.project === ".")
      .map((parsed) => ({ path: parsed.path, source: parsed.source }));
    const unparsed = entry.replay.skipped
      .filter((f) => entry.walk.projectOf.get(f.path) === "." && f.reason !== "declaration-file")
      .map((f) => f.path);
    if (!view) fail("nextjs-pages-router: project view missing");
    else {
      const legacy = nextjsAdapter.routes!({ files, unparsed });
      const viewReport = nextjsAdapter.routesFromView!(view, unparsed);
      expect(
        deepEqual(legacy, viewReport, "$"),
        "nextjs-pages-router: the view-based RouteReport deep-equals the legacy report over the real fixture",
      );

      const frozen = JSON.parse(readBaseline(path.join(FIXTURES, "nextjs-pages-router", "expected.json"))) as ParseResult;
      expect(deepEqual(viewReport.withheld, null, "$"), "nextjs-pages-router: the report is not withheld, as frozen");
      expect(
        deepEqual(frozen.coverage.routes.withheld, [], "$"),
        "nextjs-pages-router: no project is withheld in the frozen expected.json",
      );
      expect(
        deepEqual(
          [...viewReport.omitted]
            .sort(byOmitted)
            .map((o) => ({ file: o.path, line: o.line, reason: o.reason })),
          frozen.coverage.routes.omitted,
          "$",
        ),
        "nextjs-pages-router: the omitted records equal the frozen expected.json",
      );
      const unique = new Map(
        viewReport.routes.map((r) => [`${r.method} ${r.pattern} ${r.path}`, { file: r.path, method: r.method, pattern: r.pattern, line: r.line }]),
      );
      expect(
        deepEqual([...unique.values()].sort(byRoute), [...frozen.routes].sort(byRoute), "$"),
        "nextjs-pages-router: the report's routes equal the frozen expected.json (none — pages/api is omitted, not routed)",
      );
    }
  }
}
{
  const entry = corpus.get("two-framework-monorepo");
  if (!entry) fail("two-framework-monorepo: corpus entry missing");
  else {
    const project = "packages/web";
    const view = entry.views.get(project);
    const files = entry.replay.parsed
      .filter((parsed) => parsed.project === project)
      .map((parsed) => ({ path: withinProject(project, parsed.path), source: parsed.source }));
    const unparsed = entry.replay.skipped
      .filter((f) => entry.walk.projectOf.get(f.path) === project && f.reason !== "declaration-file")
      .map((f) => withinProject(project, f.path));
    if (!view) fail("two-framework-monorepo: packages/web view missing");
    else {
      const legacy = nextjsAdapter.routes!({ files, unparsed });
      const viewReport = nextjsAdapter.routesFromView!(view, unparsed);
      expect(
        deepEqual(legacy, viewReport, "$"),
        "nextjs monorepo: the view-based RouteReport deep-equals the legacy report over packages/web",
      );
      expect(deepEqual(viewReport.withheld, null, "$"), "nextjs monorepo: the web report is not withheld");
      const frozen = JSON.parse(readBaseline(path.join(FIXTURES, "two-framework-monorepo", "expected.json"))) as ParseResult;
      expect(
        deepEqual(frozen.routes.filter((r) => r.file.startsWith(`${project}/`)), [], "$"),
        "nextjs monorepo: packages/web contributes no routes to the frozen expected.json, as the report shows",
      );
      expect(
        deepEqual(frozen.coverage.routes.omitted.filter((o) => o.file.startsWith(`${project}/`)), [], "$"),
        "nextjs monorepo: packages/web contributes no omissions to the frozen expected.json, as the report shows",
      );
    }
  }
}

// B. App Router path shapes. Only route.* files are api endpoints; the pattern
// is the folder path under app/ (src/ stripped, groups and slots left out,
// trailing slash dropped, root normalized to "/").
{
  const content = `export async function GET() {}\n`;
  const { legacy } = nextjsReportDiff("app root route", [synthFile("app/route.ts", content)]);
  expect(
    deepEqual(routeKeys(legacy), [`GET / app/route.ts@${lineOf(content, "GET")}`], "$"),
    "app root route: the empty segment list normalizes to \"/\"",
  );
  expect(deepEqual(legacy.withheld, null, "$"), "app root route: nothing withholds");
}
{
  const content = `export function POST() {}\n`;
  const { legacy } = nextjsReportDiff("src/app route", [synthFile("src/app/route.ts", content)]);
  expect(
    deepEqual(routeKeys(legacy), [`POST / src/app/route.ts@${lineOf(content, "POST")}`], "$"),
    "src/app route: src/ is stripped for the pattern but the record keeps the full path",
  );
}
{
  const content = `export function GET() {}\n`;
  const { legacy } = nextjsReportDiff("route group", [synthFile("app/(marketing)/route.ts", content)]);
  expect(
    deepEqual(routeKeys(legacy), [`GET / app/(marketing)/route.ts@${lineOf(content, "GET")}`], "$"),
    "route group: (marketing) is left out of the URL by definition",
  );
}
{
  const content = `export function PUT() {}\n`;
  const { legacy } = nextjsReportDiff("parallel slot", [synthFile("app/@modal/route.ts", content)]);
  expect(
    deepEqual(routeKeys(legacy), [`PUT / app/@modal/route.ts@${lineOf(content, "PUT")}`], "$"),
    "parallel slot: @modal is left out of the URL by definition",
  );
}
{
  const content = `export function GET() {}\nexport async function PUT() {}\n`;
  const { legacy } = nextjsReportDiff("dynamic segment", [synthFile("app/users/[id]/route.ts", content)]);
  expect(
    deepEqual(
      routeKeys(legacy),
      [
        `GET /users/[id] app/users/[id]/route.ts@${lineOf(content, "GET")}`,
        `PUT /users/[id] app/users/[id]/route.ts@${lineOf(content, "PUT")}`,
      ],
      "$",
    ),
    "dynamic segment: [id] stays in the pattern, both methods carry their own lines",
  );
}
{
  const content = `export function DELETE() {}\n`;
  const { legacy } = nextjsReportDiff("catch-all", [synthFile("app/docs/[...slug]/route.ts", content)]);
  expect(
    deepEqual(routeKeys(legacy), [`DELETE /docs/[...slug] app/docs/[...slug]/route.ts@${lineOf(content, "DELETE")}`], "$"),
    "catch-all: [...slug] stays in the pattern verbatim",
  );
}
{
  const content = `export function PATCH() {}\n`;
  const { legacy } = nextjsReportDiff("optional catch-all", [synthFile("app/archive/[[...slug]]/route.ts", content)]);
  expect(
    deepEqual(routeKeys(legacy), [`PATCH /archive/[[...slug]] app/archive/[[...slug]]/route.ts@${lineOf(content, "PATCH")}`], "$"),
    "optional catch-all: [[...slug]] stays in the pattern verbatim",
  );
}
{
  const content = `export function GET() {}\n`;
  const { legacy } = nextjsReportDiff("private folder", [synthFile("app/_internal/route.ts", content)]);
  expect(
    deepEqual([routeKeys(legacy), omittedKeys(legacy), legacy.withheld], [[], [], null] satisfies [string[], string[], string | null], "$"),
    "private folder: a route.* file under an underscore folder is not a route file at all — no route, no omission",
  );
}
{
  // The three intercepting spellings, each omitted naming the whole segment.
  const cases: [string, string][] = [
    ["app/(.)photo/route.ts", "(.)photo"],
    ["app/(..)photo/route.ts", "(..)photo"],
    ["app/(...)deep/route.ts", "(...)deep"],
  ];
  for (const [filePath, segment] of cases) {
    const content = `export function GET() {}\n`;
    const { legacy } = nextjsReportDiff(`intercepting ${segment}`, [synthFile(filePath, content)]);
    expect(
      deepEqual(
        [routeKeys(legacy), omittedKeys(legacy)],
        [[], [`${filePath}@1: ${segment} is an intercepting segment, which matches by navigation, not by path`]] satisfies [string[], string[]],
        "$",
      ),
      `intercepting ${segment}: no route, the exact omission reason, no other record`,
    );
  }
}
{
  const content = `export function GET() {}\n`;
  const { legacy } = nextjsReportDiff("URL-encoded folder", [synthFile("app/caf%C3%A9/route.ts", content)]);
  expect(
    deepEqual(
      [routeKeys(legacy), omittedKeys(legacy)],
      [[], ["app/caf%C3%A9/route.ts@1: a folder name is URL-encoded"]] satisfies [string[], string[]],
      "$",
    ),
    "URL-encoded folder: a percent segment omits with the exact reason",
  );
}
{
  // Page, layout and metadata conventions are reached by path, not by method:
  // none of them is an api endpoint, so none of them records anything.
  const page = synthFile("app/page.tsx", `export default function Page() {}\n`);
  const layout = synthFile("app/layout.tsx", `export default function Layout({ children }: { children: React.ReactNode }) {\n  return children;\n}\n`);
  const loading = synthFile("app/loading.tsx", `export default function Loading() {}\n`);
  const sitemap = synthFile("app/sitemap.ts", `export default function sitemap() { return []; }\n`);
  const icon = synthFile("app/icon.ts", `export default function icon() {}\n`);
  const { legacy } = nextjsReportDiff("non-route conventions", [page, layout, loading, sitemap, icon]);
  expect(
    deepEqual([routeKeys(legacy), omittedKeys(legacy), legacy.withheld], [[], [], null] satisfies [string[], string[], string | null], "$"),
    "non-route conventions: pages, layouts and metadata files produce no routes and no omissions",
  );
}

// C. Pages Router. Every file under pages/api/ is an api endpoint whose method
// is chosen at runtime; pages/api.ts itself is an ordinary page; the special
// top-level pages are layouts and boundaries.
{
  const nested = synthFile("pages/api/nested/users.ts", `export default function handler() { return Response.json({}); }\n`);
  const flat = synthFile("pages/api/users.ts", `export default function handler() { return Response.json({}); }\n`);
  const { legacy } = nextjsReportDiff("pages/api handlers", [nested, flat]);
  expect(
    deepEqual(
      [routeKeys(legacy), omittedKeys(legacy)],
      [
        [],
        [
          `pages/api/nested/users.ts@1: a pages/api handler chooses its method at runtime`,
          `pages/api/users.ts@1: a pages/api handler chooses its method at runtime`,
        ],
      ] satisfies [string[], string[]],
      "$",
    ),
    "pages/api handlers: runtime-method omission at line 1, nested before flat in file order",
  );
}
{
  const content = `export default function Page() {}\n`;
  const { legacy } = nextjsReportDiff("pages/api.ts is a page", [synthFile("pages/api.ts", content)]);
  expect(
    deepEqual([routeKeys(legacy), omittedKeys(legacy), legacy.withheld], [[], [], null] satisfies [string[], string[], string | null], "$"),
    "pages/api.ts: \"pages/api/\" does not match the file itself — an ordinary page records nothing",
  );
}
{
  const specials = [
    synthFile("pages/_app.tsx", `export default function App({ Component, pageProps }: { Component: () => null; pageProps: object }) {\n  return Component(pageProps);\n}\n`),
    synthFile("pages/_document.tsx", `export default function Document() {}\n`),
    synthFile("pages/_error.tsx", `export default function ErrorPage() {}\n`),
    synthFile("pages/404.ts", `export default function NotFound() {}\n`),
    synthFile("pages/500.ts", `export default function ServerError() {}\n`),
    synthFile("pages/index.tsx", `export default function Home() {}\n`),
  ];
  const { legacy } = nextjsReportDiff("special pages", specials);
  expect(
    deepEqual([routeKeys(legacy), omittedKeys(legacy), legacy.withheld], [[], [], null] satisfies [string[], string[], string | null], "$"),
    "special pages: _app, _document, _error, 404, 500 and index are not api endpoints",
  );
}

// D. HTTP export forms. The method comes only from an exported name in the
// HTTP_METHODS set — never from a filename, a function's callers or runtime.
{
  const content = `export async function GET() {}
export function HEAD() {}
export function POST() {}
export async function PUT() {}
export function DELETE() {}
export function PATCH() {}
export function OPTIONS() {}
`;
  const { legacy } = nextjsReportDiff("all seven methods", [synthFile("app/api/handlers/route.ts", content)]);
  expect(
    deepEqual(
      routeKeys(legacy),
      ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"].map(
        (method) => `${method} /api/handlers app/api/handlers/route.ts@${lineOf(content, `function ${method}`)}`,
      ),
      "$",
    ),
    "all seven methods: function declarations (async included) map in statement order with their own lines",
  );
}
{
  const content = `export const GET = () => {};
export let POST = handler;
export var PUT = handler;
`;
  const { legacy } = nextjsReportDiff("const/let/var handlers", [synthFile("app/api/handlers/route.ts", content)]);
  expect(
    deepEqual(
      routeKeys(legacy),
      [
        `GET /api/handlers app/api/handlers/route.ts@${lineOf(content, "const GET")}`,
        `POST /api/handlers app/api/handlers/route.ts@${lineOf(content, "let POST")}`,
        `PUT /api/handlers app/api/handlers/route.ts@${lineOf(content, "var PUT")}`,
      ],
      "$",
    ),
    "const/let/var handlers: exported variable bindings of every kind carry their declaration lines",
  );
}
{
  const content = `export const {
  handler: GET,
  POST,
  "aliased": PATCH,
} = handlers;
`;
  const { legacy } = nextjsReportDiff("destructured handlers", [synthFile("app/api/handlers/route.ts", content)]);
  expect(
    deepEqual(
      routeKeys(legacy),
      [
        `GET /api/handlers app/api/handlers/route.ts@${lineOf(content, "handler: GET")}`,
        `POST /api/handlers app/api/handlers/route.ts@${lineOf(content, "POST,")}`,
        `PATCH /api/handlers app/api/handlers/route.ts@${lineOf(content, "\"aliased\": PATCH")}`,
      ],
      "$",
    ),
    "destructured handlers: renamed and string-keyed elements carry their local names and element lines",
  );
}
{
  const content = `export const GET = () => {};
export const {
  handler: POST,
} = handlers;
const read = null;
export { read as DELETE };
export { OPTIONS } from "./m";
export { HEAD as PUT } from "./m2";
`;
  const { legacy } = nextjsReportDiff("aliases and re-exports", [synthFile("app/api/handlers/route.ts", content)]);
  expect(
    deepEqual(
      routeKeys(legacy),
      [
        `GET /api/handlers app/api/handlers/route.ts@${lineOf(content, "const GET")}`,
        `POST /api/handlers app/api/handlers/route.ts@${lineOf(content, "handler: POST")}`,
        `DELETE /api/handlers app/api/handlers/route.ts@${lineOf(content, "read as DELETE")}`,
        `OPTIONS /api/handlers app/api/handlers/route.ts@${lineOf(content, "OPTIONS } from")}`,
        `PUT /api/handlers app/api/handlers/route.ts@${lineOf(content, "HEAD as PUT")}`,
      ],
      "$",
    ),
    "aliases and re-exports: local, aliased and re-exported names all map at their specifier lines",
  );
}
{
  const content = `export function GET() {}
export const GET = () => {};
`;
  const { legacy } = nextjsReportDiff("duplicate methods", [synthFile("app/api/handlers/route.ts", content)]);
  expect(
    deepEqual(
      [routeKeys(legacy), omittedKeys(legacy)],
      [[`GET /api/handlers app/api/handlers/route.ts@1`], []] satisfies [string[], string[]],
      "$",
    ),
    "duplicate methods: the first export wins, the later one is ignored, nothing is omitted",
  );
}
{
  const content = `export default function GET() {}
export function user() {}
export const GETVAR = () => {};
export type GET = 1;
`;
  const { legacy } = nextjsReportDiff("default and non-method exports", [synthFile("app/api/handlers/route.ts", content)]);
  expect(
    deepEqual(
      [routeKeys(legacy), omittedKeys(legacy)],
      [[], [`app/api/handlers/route.ts@1: no exported HTTP method was found`]] satisfies [string[], string[]],
      "$",
    ),
    "default and non-method exports: a default GET, a non-method function, a non-method const and a type alias name no method",
  );
}
{
  const content = `export * as GET from "./m";\n`;
  const { legacy } = nextjsReportDiff("namespace re-export", [synthFile("app/api/handlers/route.ts", content)]);
  expect(
    deepEqual(
      [routeKeys(legacy), omittedKeys(legacy)],
      [[], [`app/api/handlers/route.ts@1: no exported HTTP method was found`]] satisfies [string[], string[]],
      "$",
    ),
    "namespace re-export: `export * as GET` names a module object, not a method — the namespace-marker exclusion",
  );
}
{
  const content = `export * from "./m";\n`;
  const { legacy } = nextjsReportDiff("bare star", [synthFile("app/api/handlers/route.ts", content)]);
  expect(
    deepEqual(
      [routeKeys(legacy), omittedKeys(legacy)],
      [[], [`app/api/handlers/route.ts@1: export * hides which methods come from the other module`]] satisfies [string[], string[]],
      "$",
    ),
    "bare star: the star line is the omission line",
  );
}
{
  const content = `export * from "./a";
export * from "./b";
`;
  const { legacy } = nextjsReportDiff("two bare stars", [synthFile("app/api/handlers/route.ts", content)]);
  expect(
    deepEqual(
      [routeKeys(legacy), omittedKeys(legacy)],
      [[], [`app/api/handlers/route.ts@1: export * hides which methods come from the other module`]] satisfies [string[], string[]],
      "$",
    ),
    "two bare stars: only the first star's line is recorded",
  );
}
{
  const content = `export function GET() {}
export * from "./a";
`;
  const { legacy } = nextjsReportDiff("star with a method", [synthFile("app/api/handlers/route.ts", content)]);
  expect(
    deepEqual(
      [routeKeys(legacy), omittedKeys(legacy)],
      [
        [`GET /api/handlers app/api/handlers/route.ts@${lineOf(content, "GET")}`],
        [`app/api/handlers/route.ts@${lineOf(content, "export *")}: export * hides which methods come from the other module`],
      ] satisfies [string[], string[]],
      "$",
    ),
    "star with a method: the named route and the star omission coexist in one report",
  );
}

// E. Config behavior. Only a root next.config.* file is a config; the scan is
// file-wide (wrapped calls, returns, nested objects, arrays), explicit
// assignments first and shorthands second, with the shorthand pass overriding.
{
  const content = `export function GET() {}\n`;
  const { legacy } = nextjsReportDiff("no config", [synthFile("app/route.ts", content)]);
  expect(
    deepEqual(routeKeys(legacy), [`GET / app/route.ts@${lineOf(content, "GET")}`], "$"),
    "no config: without a next.config the pattern is the plain folder path",
  );
}
{
  const config = synthFile("next.config.mjs", `export default { basePath: "/base" };\n`);
  const route = synthFile("app/users/route.ts", `export function GET() {}\n`);
  const { legacy } = nextjsReportDiff("literal basePath", [config, route]);
  expect(
    deepEqual(routeKeys(legacy), [`GET /base/users app/users/route.ts@${lineOf(route.source.getFullText(), "GET")}`], "$"),
    "literal basePath: a string-literal basePath composes into every pattern",
  );
}
{
  const config = synthFile("next.config.cjs", `module.exports = { basePath: "/cjs" };\n`);
  const route = synthFile("app/route.ts", `export function GET() {}\n`);
  const { legacy } = nextjsReportDiff("module.exports config", [config, route]);
  expect(
    deepEqual(routeKeys(legacy), [`GET /cjs app/route.ts@${lineOf(route.source.getFullText(), "GET")}`], "$"),
    "module.exports config: the file-wide scan reads the assignment's object too",
  );
}
{
  const config = synthFile("next.config.js", `module.exports = withPlugins({ basePath: "/wrapped" });\n`);
  const route = synthFile("app/route.ts", `export function GET() {}\n`);
  const { legacy } = nextjsReportDiff("wrapped config call", [config, route]);
  expect(
    deepEqual(routeKeys(legacy), [`GET /wrapped app/route.ts@${lineOf(route.source.getFullText(), "GET")}`], "$"),
    "wrapped config call: an object inside a call argument is still the config (return-position R1 shape)",
  );
}
{
  const config = synthFile("next.config.ts", `function make() {\n  return { basePath: "/returned" };\n}\nmake();\n`);
  const route = synthFile("app/route.ts", `export function GET() {}\n`);
  const { legacy } = nextjsReportDiff("function-return config", [config, route]);
  expect(
    deepEqual(routeKeys(legacy), [`GET /returned app/route.ts@${lineOf(route.source.getFullText(), "GET")}`], "$"),
    "function-return config: a basePath built by a function is read from anywhere in the file (return-position R1 shape)",
  );
}
{
  const config = synthFile(
    "next.config.ts",
    `export default {\n  nested: { basePath: "/deep" },\n  list: [{ basePath: "/deep" }],\n};\n`,
  );
  const route = synthFile("app/route.ts", `export function GET() {}\n`);
  const { legacy } = nextjsReportDiff("nested and array config", [config, route]);
  expect(
    deepEqual(routeKeys(legacy), [`GET /deep app/route.ts@${lineOf(route.source.getFullText(), "GET")}`], "$"),
    "nested and array config: a basePath inside a nested object or an array element is read, equal values accepted",
  );
}
{
  const config = synthFile("next.config.ts", `export default { basePath: basePath };\n`);
  const route = synthFile("app/route.ts", `export function GET() {}\n`);
  const { legacy } = nextjsReportDiff("computed basePath", [config, route]);
  expect(
    deepEqual(
      [routeKeys(legacy), omittedKeys(legacy), legacy.withheld],
      [[], [], "next.config.ts sets basePath to a computed value"] satisfies [string[], string[], string | null],
      "$",
    ),
    "computed basePath: an identifier value withholds the whole report, valid routes and all",
  );
}
{
  const config = synthFile("next.config.js", `const basePath = "/x";\nexport default { basePath };\n`);
  const { legacy } = nextjsReportDiff("shorthand basePath", [config]);
  expect(
    deepEqual(legacy.withheld, "next.config.js sets basePath from a variable", "$"),
    "shorthand basePath: the shorthand pass's own withhold reason",
  );
}
{
  // The shorthand pass runs after every explicit assignment, so a shorthand
  // found later in the file overrides an earlier literal — wherever the two
  // sit in the document.
  const config = synthFile("next.config.js", `export default { basePath: "/x" };\nconst extra = { basePath };\n`);
  const { legacy } = nextjsReportDiff("shorthand after explicit", [config]);
  expect(
    deepEqual(legacy.withheld, "next.config.js sets basePath from a variable", "$"),
    "shorthand after explicit: the second pass overrides the first pass's literal (R3 shape)",
  );
}
{
  const config = synthFile("next.config.mjs", `export default { pageExtensions: ["mdx"] };\n`);
  const { legacy } = nextjsReportDiff("pageExtensions explicit", [config]);
  expect(
    deepEqual(legacy.withheld, "next.config.mjs sets pageExtensions, so which files are route handlers is uncertain", "$"),
    "pageExtensions explicit: the exact withhold reason, checked before basePath on every property",
  );
}
{
  const config = synthFile("next.config.mjs", `const pageExtensions = [];\nexport default { pageExtensions };\n`);
  const { legacy } = nextjsReportDiff("pageExtensions shorthand", [config]);
  expect(
    deepEqual(legacy.withheld, "next.config.mjs sets pageExtensions, so which files are route handlers is uncertain", "$"),
    "pageExtensions shorthand: the same reason from the second pass",
  );
}
{
  const config = synthFile("next.config.js", `export default { basePath: "/x", alt: { basePath: "/x" } };\n`);
  const route = synthFile("app/route.ts", `export function GET() {}\n`);
  const { legacy } = nextjsReportDiff("duplicate identical basePath", [config, route]);
  expect(
    deepEqual(routeKeys(legacy), [`GET /x app/route.ts@${lineOf(route.source.getFullText(), "GET")}`], "$"),
    "duplicate identical basePath: the same value twice is accepted",
  );
}
{
  const config = synthFile("next.config.js", `export default { basePath: "/a" };\nmodule.exports = { basePath: "/b" };\n`);
  const { legacy } = nextjsReportDiff("conflicting basePath in one file", [config]);
  expect(
    deepEqual(legacy.withheld, "next.config.js sets basePath more than once", "$"),
    "conflicting basePath in one file: the file-scoped conflict reason",
  );
}
{
  const configA = synthFile("next.config.js", `export default { basePath: "/shared" };\n`);
  const configB = synthFile("next.config.mjs", `export default { basePath: "/shared" };\n`);
  const route = synthFile("app/route.ts", `export function GET() {}\n`);
  const { legacy } = nextjsReportDiff("two configs, same value", [configA, configB, route]);
  expect(
    deepEqual(routeKeys(legacy), [`GET /shared app/route.ts@${lineOf(route.source.getFullText(), "GET")}`], "$"),
    "two configs, same value: configs are read in file order and agree, so routes flow",
  );
}
{
  const configA = synthFile("next.config.js", `export default { basePath: "/one" };\n`);
  const configB = synthFile("next.config.mjs", `export default { basePath: "/two" };\n`);
  const { legacy } = nextjsReportDiff("two configs, conflicting", [configA, configB]);
  expect(
    deepEqual(legacy.withheld, "more than one next.config sets basePath", "$"),
    "two configs, conflicting: the cross-config reason names no file",
  );
}
{
  const route = synthFile("app/route.ts", `export function GET() {}\n`);
  const config = synthFile("next.config.mjs", `export default { basePath: "/base" };\n`);
  const { legacy } = nextjsReportDiff("unparsed config", [route, config], ["next.config.js"]);
  expect(
    deepEqual(
      [routeKeys(legacy), omittedKeys(legacy), legacy.withheld],
      [[], [], "next.config.js couldn't be parsed, so basePath is unknown"] satisfies [string[], string[], string | null],
      "$",
    ),
    "unparsed config: the unparsed check precedes everything, even a parsed config and valid routes",
  );
}
{
  const route = synthFile("app/route.ts", `export function GET() {}\n`);
  const { legacy } = nextjsReportDiff("unparsed config order", [route], ["next.config.mjs", "next.config.js"]);
  expect(
    deepEqual(legacy.withheld, "next.config.mjs couldn't be parsed, so basePath is unknown", "$"),
    "unparsed config order: the first CONFIG-matching entry in unparsed order is named",
  );
}
{
  const config = synthFile("next.config.js", `export default { "basePath": "/quoted" };\n`);
  const route = synthFile("app/route.ts", `export function GET() {}\n`);
  const { legacy } = nextjsReportDiff("quoted config key", [config, route]);
  expect(
    deepEqual(routeKeys(legacy), [`GET /quoted app/route.ts@${lineOf(route.source.getFullText(), "GET")}`], "$"),
    "quoted config key: quote normalization matches the legacy scan's",
  );
}
{
  const config = synthFile("next.config.js", `export default { [basePath]: "/x" };\n`);
  const route = synthFile("app/route.ts", `export function GET() {}\n`);
  const { legacy } = nextjsReportDiff("computed config key", [config, route]);
  expect(
    deepEqual([routeKeys(legacy), legacy.withheld], [[`GET / app/route.ts@${lineOf(route.source.getFullText(), "GET")}`], null] satisfies [string[], string | null], "$"),
    "computed config key: a computed property name is not a basePath and is skipped, as in the legacy scan",
  );
}

// F. Ordering and regex edges: which filenames are configs at all, mixed
// reports, and walker-order record order (repaired by the view's walkOrder).
{
  for (const ext of ["js", "mjs", "cjs"]) {
    const name = `next.config.${ext}`;
    const { legacy } = nextjsReportDiff(`config extension ${ext}`, [synthFile(name, `export default { basePath: basePath };\n`)]);
    expect(
      deepEqual(legacy.withheld, `${name} sets basePath to a computed value`, "$"),
      `config extension ${ext}: the root-anchored regex accepts it and the withhold names it`,
    );
  }
}
{
  const config = synthFile("src/next.config.js", `export default { basePath: basePath };\n`);
  const route = synthFile("app/route.ts", `export function GET() {}\n`);
  const { legacy } = nextjsReportDiff("nested config path", [config, route]);
  expect(
    deepEqual([routeKeys(legacy), legacy.withheld], [[`GET / app/route.ts@${lineOf(route.source.getFullText(), "GET")}`], null] satisfies [string[], string | null], "$"),
    "nested config path: src/next.config.js is not a config — the root-anchored regex ignores it",
  );
}
{
  const config = synthFile("next.configx.js", `export default { basePath: basePath };\n`);
  const route = synthFile("app/route.ts", `export function GET() {}\n`);
  const { legacy } = nextjsReportDiff("config lookalike", [config, route]);
  expect(
    deepEqual([routeKeys(legacy), legacy.withheld], [[`GET / app/route.ts@${lineOf(route.source.getFullText(), "GET")}`], null] satisfies [string[], string | null], "$"),
    "config lookalike: next.configx.js fails the regex, so its computed basePath never withholds",
  );
}
{
  const route = synthFile("app/api/users/route.ts", `export function GET() {}\n`);
  const pages = synthFile("pages/api/status.ts", `export default function handler() { return Response.json({}); }\n`);
  const { legacy } = nextjsReportDiff("mixed app and pages", [route, pages]);
  expect(
    deepEqual(
      [routeKeys(legacy), omittedKeys(legacy)],
      [
        [`GET /api/users app/api/users/route.ts@${lineOf(route.source.getFullText(), "GET")}`],
        [`pages/api/status.ts@1: a pages/api handler chooses its method at runtime`],
      ] satisfies [string[], string[]],
      "$",
    ),
    "mixed app and pages: routes and pages/api omissions coexist in one report, in file order",
  );
}

// Walk order. With the metadata attached, the view reader iterates in the
// walker's original order — the order the legacy reader received — so the
// reports are equal AND the records appear in the walker's order. Without the
// metadata, both readers see the path-sorted order and are still equal, in the
// other order. Next.js has no walker-order-sensitive named withhold (one
// config file per project, and the cross-config conflict names no file), so
// the order property is pinned through the route and omission records.
{
  const dir = mkdtempSync(path.join(tmpdir(), "next-routes-walk-"));
  try {
    mkdirSync(path.join(dir, "app", "route"), { recursive: true });
    writeFileSync(path.join(dir, "app", "route", "route.ts"), `export async function GET() {}\n`, "utf8");
    writeFileSync(path.join(dir, "app", "route.ts"), `export function POST() {}\n`, "utf8");
    const selection = selectFiles(dir);

    // The walker descends the directory named "route" before it reaches the
    // sibling file route.ts — the reverse of path-sorted order.
    expect(
      deepEqual(
        selection.walk.candidates.map((candidate) => candidate.path),
        ["app/route/route.ts", "app/route.ts"] satisfies string[],
        "$",
      ),
      "walk order: the walker's own candidate order, verified for this layout",
    );

    const withOrder = selection.walk.candidates.map((candidate, rank) => ({
      path: candidate.path,
      absolutePath: candidate.absolutePath,
      source: syntheticProject.createSourceFile(candidate.absolutePath, candidate.content, { overwrite: true }),
      walkOrder: rank,
    }));
    const orderedView = buildFrameworkView({ project: ".", files: withOrder, skipped: [], resolveSpecifier: stubResolve });
    const legacyWalk = nextjsAdapter.routes!({ files: withOrder.map((entry) => ({ path: entry.path, source: entry.source })), unparsed: [] });
    const viewWalk = nextjsAdapter.routesFromView!(orderedView, []);
    expect(
      deepEqual(legacyWalk, viewWalk, "$"),
      "walk order, metadata attached: the complete reports are equal over the walker's original order",
    );
    expect(
      deepEqual(
        routeKeys(viewWalk),
        [`GET /route app/route/route.ts@1`, `POST / app/route.ts@1`] satisfies string[],
        "$",
      ),
      "walk order, metadata attached: the route records follow the walker's order, not the path-sorted one",
    );
    expect(deepEqual(viewWalk.withheld, null, "$"), "walk order, metadata attached: nothing withholds");

    const withoutOrder = selection.walk.candidates.map((candidate) => ({
      path: candidate.path,
      absolutePath: candidate.absolutePath,
      source: syntheticProject.createSourceFile(candidate.absolutePath, candidate.content, { overwrite: true }),
    }));
    const pathView = buildFrameworkView({ project: ".", files: withoutOrder, skipped: [], resolveSpecifier: stubResolve });
    const legacyPath = nextjsAdapter.routes!({
      files: [...withoutOrder].sort((a, b) => a.path.localeCompare(b.path)).map((entry) => ({ path: entry.path, source: entry.source })),
      unparsed: [],
    });
    const viewPath = nextjsAdapter.routesFromView!(pathView, []);
    expect(
      deepEqual(legacyPath, viewPath, "$"),
      "walk order, metadata absent: the fallback to view.files order keeps the reports equal",
    );
    expect(
      deepEqual(
        routeKeys(viewPath),
        [`POST / app/route.ts@1`, `GET /route app/route/route.ts@1`] satisfies string[],
        "$",
      ),
      "walk order, metadata absent: the path-sorted order both readers then see — the documented divergence the metadata repairs",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = mkdtempSync(path.join(tmpdir(), "next-routes-walk-omitted-"));
  try {
    mkdirSync(path.join(dir, "app", "route", "(.)x"), { recursive: true });
    writeFileSync(path.join(dir, "app", "route", "(.)x", "route.ts"), `export function GET() {}\n`, "utf8");
    writeFileSync(path.join(dir, "app", "route.ts"), `export function handle() {}\n`, "utf8");
    const selection = selectFiles(dir);

    expect(
      deepEqual(
        selection.walk.candidates.map((candidate) => candidate.path),
        ["app/route/(.)x/route.ts", "app/route.ts"] satisfies string[],
        "$",
      ),
      "walk order, omissions: the walker's own candidate order, verified for this layout",
    );

    const withOrder = selection.walk.candidates.map((candidate, rank) => ({
      path: candidate.path,
      absolutePath: candidate.absolutePath,
      source: syntheticProject.createSourceFile(candidate.absolutePath, candidate.content, { overwrite: true }),
      walkOrder: rank,
    }));
    const orderedView = buildFrameworkView({ project: ".", files: withOrder, skipped: [], resolveSpecifier: stubResolve });
    const legacyWalk = nextjsAdapter.routes!({ files: withOrder.map((entry) => ({ path: entry.path, source: entry.source })), unparsed: [] });
    const viewWalk = nextjsAdapter.routesFromView!(orderedView, []);
    expect(
      deepEqual(legacyWalk, viewWalk, "$"),
      "walk order, omissions: the complete reports are equal over the walker's original order",
    );
    expect(
      deepEqual(
        [routeKeys(viewWalk), omittedKeys(viewWalk)],
        [
          [],
          [
            `app/route/(.)x/route.ts@1: (.)x is an intercepting segment, which matches by navigation, not by path`,
            `app/route.ts@1: no exported HTTP method was found`,
          ],
        ] satisfies [string[], string[]],
        "$",
      ),
      "walk order, omissions: the omission records follow the walker's order, not the path-sorted one",
    );

    const withoutOrder = selection.walk.candidates.map((candidate) => ({
      path: candidate.path,
      absolutePath: candidate.absolutePath,
      source: syntheticProject.createSourceFile(candidate.absolutePath, candidate.content, { overwrite: true }),
    }));
    const pathView = buildFrameworkView({ project: ".", files: withoutOrder, skipped: [], resolveSpecifier: stubResolve });
    const legacyPath = nextjsAdapter.routes!({
      files: [...withoutOrder].sort((a, b) => a.path.localeCompare(b.path)).map((entry) => ({ path: entry.path, source: entry.source })),
      unparsed: [],
    });
    const viewPath = nextjsAdapter.routesFromView!(pathView, []);
    expect(
      deepEqual(legacyPath, viewPath, "$"),
      "walk order, omissions: the fallback to view.files order keeps the reports equal",
    );
    expect(
      deepEqual(
        [routeKeys(viewPath), omittedKeys(viewPath)],
        [
          [],
          [
            `app/route.ts@1: no exported HTTP method was found`,
            `app/route/(.)x/route.ts@1: (.)x is an intercepting segment, which matches by navigation, not by path`,
          ],
        ] satisfies [string[], string[]],
        "$",
      ),
      "walk order, omissions: the path-sorted order both readers then see",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- Section 12: production route-adapter invariant (Batch 3.3d.1) ----

console.log("=== 12. Production route invariant: view-fed adapters only, legacy readers as oracles ===");

// Every adapter with route logic implements routesFromView — the production
// route interface — and keeps its legacy routes() spelling as a directly
// callable compatibility oracle. Every adapter without route logic carries
// neither method: the orchestration contributes NO_ROUTES for it. The
// registry is pinned too, so an adapter added to production without a route
// shape fails here instead of silently bypassing the invariant.
{
  const adapters: { name: string; adapter: FrameworkAdapter }[] = [
    { name: "Next.js", adapter: nextjsAdapter },
    { name: "NestJS", adapter: nestjsAdapter },
    { name: "Express", adapter: expressAdapter },
    { name: "Docusaurus", adapter: docusaurusAdapter },
    { name: "React", adapter: reactAdapter },
    { name: "fallback", adapter: fallbackAdapter },
  ];
  for (const { name, adapter } of adapters) {
    if (adapter.routesFromView) {
      expect(
        deepEqual(typeof adapter.routesFromView, "function", "$"),
        `${name}: the production route interface is routesFromView`,
      );
      expect(
        deepEqual(typeof adapter.routes, "function", "$"),
        `${name}: the legacy oracle stays directly callable for the compatibility tests`,
      );
    } else {
      expect(
        deepEqual(adapter.routes, undefined, "$"),
        `${name}: no route logic — the adapter carries neither route method`,
      );
    }
  }

  const registry = readFileSync(path.resolve("lib/parser/adapters/index.ts"), "utf8").replace(/\r\n/g, "\n");
  const listed = [...registry.matchAll(/^  (\w+)Adapter,$/gm)].map((match) => match[1]!);
  expect(
    deepEqual(listed, ["nextjs", "nestjs", "express", "docusaurus", "react", "fallback"] satisfies string[], "$"),
    "invariant: the production registry lists exactly these six adapters, each covered above",
  );

  // The no-route adapters' former boilerplate is gone; the shared NO_ROUTES
  // constant is still exported, for the orchestration's fallback.
  expect(
    deepEqual(NO_ROUTES, { routes: [], omitted: [], withheld: null } satisfies RouteReport, "$"),
    "invariant: the shared NO_ROUTES constant remains the orchestration's no-route fallback",
  );
}

// ---- Summary ----

console.log(`\n${results.join("\n")}`);
const failedCount = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\nFrameworkView tests: ${results.filter((r) => r.startsWith("ok")).length} passed, ${failedCount} failed`);
if (failedCount > 0) process.exitCode = 1;
