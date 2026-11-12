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

import { readdirSync, readFileSync } from "node:fs";
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
  type FrameworkView,
  type RouteReport,
  type ViewArgument,
  type ViewFile,
  type ViewImport,
  type ViewProperty,
} from "../lib/parser/adapters/types.ts";
import { detectLanguage } from "../lib/ir/languages.ts";
import type { WalkResult } from "../lib/parser/walk.ts";
import { FIXTURES, readBaseline } from "./test-fixtures-shared.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

// Deterministic element budget: every element the view carries for the corpus.
// Measured 2026-11-12 over all 14 fixtures: 427 elements (86 view files and
// skipped rows plus their imports, bindings, exports, declarations, decorators
// and arguments, calls, config properties and directives). The budget keeps
// ~2x headroom and catches accidental blow-up (duplicated content, quadratic
// copying) without any wall-clock precision claim.
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
      { form: "alias", name: "ns", line: 3 },
      { form: "declaration", name: "A", kind: "variable", line: 5 },
      { form: "declaration", name: "C", kind: "variable", line: 5 },
      { form: "declaration", name: "POST", kind: "function", line: 6 },
      { form: "declaration", name: "GETVAR", kind: "variable", line: 7 },
    ] satisfies ViewFile["exports"], "$"),
    "export-forms.ts: alias/star/namespace/destructured forms carried; the default export excluded",
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
  const legacy = expressAdapter.routes({ files: ordered.map((entry) => ({ path: entry.path, source: entry.source })), unparsed });
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
      const legacy = expressAdapter.routes({ files, unparsed });
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
  const namedOnly = expressAdapter.routes({ files: [{ path: namedDefault.path, source: namedDefault.source }], unparsed: [] });
  expect(
    deepEqual(namedOnly, { routes: [], omitted: [], withheld: null }, "$"),
    "D1 legacy pin: import { default as e } from \"express\" declares no app — an entirely empty report",
  );
  const ordinaryOnly = expressAdapter.routes({ files: [{ path: ordinary.path, source: ordinary.source }], unparsed: [] });
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

// Same FrameworkView instance for roles and routes: not externally observable
// (applyAdapters passes the one `view` it built to roleOf and routesFromView
// alike, and a second build would be content-equal anyway), so the pin is
// structural — the orchestration must call routesFromView with that same view
// variable and keep the legacy fallback for the unmigrated adapters.
{
  const orchestration = readFileSync(path.resolve("lib/parser/index.ts"), "utf8").replace(/\r\n/g, "\n");
  const prefersView = orchestration.includes("adapter.routesFromView\n      ? adapter.routesFromView(view, unparsed)");
  const keepsLegacy = orchestration.includes("adapter.routes({ files, unparsed })");
  if (prefersView && keepsLegacy) {
    pass("orchestration: routesFromView is called with the same view variable roleOf read; the legacy fallback stays");
  } else {
    fail(`orchestration: routesFromView/legacy fallback pin broken (prefersView=${prefersView}, keepsLegacy=${keepsLegacy})`);
  }
}

// ---- Summary ----

console.log(`\n${results.join("\n")}`);
const failedCount = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\nFrameworkView tests: ${results.filter((r) => r.startsWith("ok")).length} passed, ${failedCount} failed`);
if (failedCount > 0) process.exitCode = 1;
