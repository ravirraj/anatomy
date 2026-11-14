import { Node, SyntaxKind, type Decorator, type Expression, type SourceFile } from "ts-morph";
import type { Role } from "../../roles.ts";
import { toolConventions, toolRole } from "./conventions.ts";
import type {
  FrameworkAdapter,
  FrameworkView,
  ProjectFiles,
  RouteReport,
  ViewArgument,
  ViewDecorator,
  ViewFile,
  ViewValue,
} from "./types.ts";

// NestJS names a file for what it holds — users.controller.ts,
// users.service.ts — which is the suffix its CLI generates. Routes are
// assembled from the controller's decorator and the method's together, plus a
// global prefix if the bootstrap sets one.

const SUFFIX_ROLES: Record<string, Role> = {
  controller: "controller",
  resolver: "resolver",
  gateway: "gateway",
  service: "service",
  module: "module",
  entity: "entity",
  dto: "dto",
  repository: "repository",
  middleware: "middleware",
  guard: "guard",
  interceptor: "interceptor",
  pipe: "pipe",
  filter: "filter",
};
const SUFFIX = new RegExp(`\\.(${Object.keys(SUFFIX_ROLES).join("|")})\\.[cm]?[jt]s$`);

// The route decorators @nestjs/common exports, and the method each one maps.
const METHOD_DECORATORS: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Delete: "DELETE",
  Patch: "PATCH",
  Options: "OPTIONS",
  Head: "HEAD",
  Search: "SEARCH",
  All: "ALL",
};

export const nestjsAdapter: FrameworkAdapter = {
  name: "NestJS",
  detect: (project) => project.dependencies.has("@nestjs/core"),
  // Where the Nest CLI compiles to. Some repositories commit it, and walking it
  // would count every controller twice.
  excludeDirectory: (dir) => (dir === "dist" ? "NestJS build output" : null),
  reachedBy: toolConventions,
  roleOf(file) {
    const suffix = SUFFIX.exec(file.path.slice(file.path.lastIndexOf("/") + 1));
    return (suffix?.[1] ? SUFFIX_ROLES[suffix[1]] : undefined) ?? toolRole(file.path);
  },
  routes: nestRoutes,
  // Batch 3.3b.2: the parser prefers this when present. Same algorithm as
  // nestRoutes below — which stays until Batch 3.3d as the comparison
  // oracle — reading only the FrameworkView the orchestration already built.
  routesFromView: nestRoutesFromView,
};

function nestRoutes({ files, unparsed }: ProjectFiles): RouteReport {
  const report: RouteReport = { routes: [], omitted: [], withheld: null };
  const withhold = (reason: string): RouteReport => ({ ...report, withheld: reason });

  // Anything that changes every pattern from outside the controllers has to be
  // known before any single pattern is.
  if (unparsed.length > 0) {
    return withhold(`${unparsed.length} file${unparsed.length === 1 ? " wasn't" : "s weren't"} parsed, and one could set a global prefix`);
  }
  let bootstraps = 0;
  const prefixes: { path: string; value: string | null; hasOptions: boolean }[] = [];
  for (const { path, source } of files) {
    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const name = callee.getName();
      if (name === "enableVersioning") return withhold(`${path} enables versioning, which can add a version to any path`);
      if (name === "create" && callee.getExpression().getText() === "NestFactory") bootstraps++;
      if (name === "setGlobalPrefix") {
        const [first, ...rest] = call.getArguments();
        prefixes.push({ path, value: first ? literalString(first) : null, hasOptions: rest.length > 0 });
      }
    }
    if ([...importsFrom(source, "@nestjs/core").values()].includes("RouterModule")) {
      return withhold(`${path} uses RouterModule, which prefixes whole modules`);
    }
  }
  let prefix = "";
  if (prefixes.length > 0) {
    const [only, ...more] = prefixes;
    if (!only || more.length > 0) return withhold("setGlobalPrefix is called more than once");
    if (bootstraps !== 1) return withhold(`setGlobalPrefix is called, but there are ${bootstraps} bootstraps it could apply to`);
    if (only.value === null) return withhold(`${only.path} sets the global prefix to a computed value`);
    if (only.hasOptions) return withhold(`${only.path} excludes some routes from the global prefix`);
    prefix = only.value;
  }

  for (const { path, source } of files) {
    const common = importsFrom(source, "@nestjs/common");
    const decoratorName = (d: Decorator): string | undefined => {
      const call = d.getCallExpression();
      const callee = call?.getExpression();
      return callee && Node.isIdentifier(callee) ? common.get(callee.getText()) : undefined;
    };

    for (const cls of source.getClasses()) {
      const controller = cls.getDecorators().find((d) => decoratorName(d) === "Controller");
      if (!controller) continue;
      const bases = controllerPaths(controller);
      if (typeof bases === "string") {
        report.omitted.push({ path, line: controller.getStartLineNumber(), reason: bases });
        continue;
      }
      for (const method of cls.getMethods()) {
        for (const decorator of method.getDecorators()) {
          const name = decoratorName(decorator);
          const verb = name === undefined ? undefined : METHOD_DECORATORS[name];
          if (!verb) continue;
          const line = decorator.getStartLineNumber();
          const own = pathArgument(decorator.getArguments()[0]);
          if (own === null) {
            report.omitted.push({ path, line, reason: `@${name}() is given a path that isn't a string literal` });
            continue;
          }
          for (const base of bases) {
            for (const tail of own) report.routes.push({ path, method: verb, pattern: joinPath([prefix, base, tail]), line });
          }
        }
      }
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// The view-based reader (Batch 3.3b.2). Pass-for-pass with nestRoutes above —
// same withhold order and reason strings, same bootstrap/prefix rules, same
// decorator recognition, same composition — reading only what the view
// carries. Every legacy guard survives: the property-access-only call gate
// (the view records exactly that shape, so bare identifier calls stay
// undetected), the identifier-only decorator callee (a mapped local name can
// only be reached by a plain-identifier callee, and bare decorators are
// flagged), and named-imports-only import maps (default slot, namespace and
// import-equals spellings are excluded exactly as the legacy scan never saw
// them).
// ---------------------------------------------------------------------------

function nestRoutesFromView(view: FrameworkView, unparsed: readonly string[]): RouteReport {
  const report: RouteReport = { routes: [], omitted: [], withheld: null };
  const withhold = (reason: string): RouteReport => ({ ...report, withheld: reason });

  // File-level scans iterate in the walker's original order when the view
  // carries it for every file — the order the legacy reader received — so a
  // withhold reason names the same first offender. Without it, the
  // path-sorted files are all there is. The two orders are never mixed.
  const files = view.files.every((file) => file.walkOrder !== undefined)
    ? [...view.files].sort((a, b) => (a.walkOrder ?? 0) - (b.walkOrder ?? 0))
    : view.files;

  // Anything that changes every pattern from outside the controllers has to be
  // known before any single pattern is.
  if (unparsed.length > 0) {
    return withhold(`${unparsed.length} file${unparsed.length === 1 ? " wasn't" : "s weren't"} parsed, and one could set a global prefix`);
  }
  let bootstraps = 0;
  const prefixes: { path: string; value: string | null; hasOptions: boolean }[] = [];
  for (const file of files) {
    for (const call of file.calls) {
      // enableVersioning and setGlobalPrefix fire on any receiver — a chained
      // a.b.enableVersioning() is detected, exactly as the legacy scan saw
      // it; create needs the NestFactory receiver.
      if (call.member === "enableVersioning") return withhold(`${file.path} enables versioning, which can add a version to any path`);
      if (call.member === "create" && call.receiver === "NestFactory") bootstraps++;
      if (call.member === "setGlobalPrefix") {
        const [first] = call.arguments;
        prefixes.push({ path: file.path, value: first ? viewLiteralString(first) : null, hasOptions: call.arguments.length > 1 });
      }
    }
    if ([...importedNames(file, "@nestjs/core").values()].includes("RouterModule")) {
      return withhold(`${file.path} uses RouterModule, which prefixes whole modules`);
    }
  }
  let prefix = "";
  if (prefixes.length > 0) {
    const [only, ...more] = prefixes;
    if (!only || more.length > 0) return withhold("setGlobalPrefix is called more than once");
    if (bootstraps !== 1) return withhold(`setGlobalPrefix is called, but there are ${bootstraps} bootstraps it could apply to`);
    if (only.value === null) return withhold(`${only.path} sets the global prefix to a computed value`);
    if (only.hasOptions) return withhold(`${only.path} excludes some routes from the global prefix`);
    prefix = only.value;
  }

  for (const file of files) {
    const common = importedNames(file, "@nestjs/common");
    // A bare decorator is no call; only the call form could ever be
    // recognized. Any callee text that isn't one of the imported local names
    // (a namespace-qualified spelling, a computed callee) misses the map —
    // the same outcome the legacy identifier check produced, since a map key
    // is always a written identifier and a non-identifier callee's text is
    // never one.
    const decoratorName = (decorator: ViewDecorator): string | undefined =>
      decorator.bare ? undefined : common.get(decorator.name);

    // Classes in document order; the 1-based position of each class among
    // the file's class declarations IS the ownerClass ordinal the builder
    // records. A method resolves its owner from that ordinal, or — for a
    // uniquely named class's methods, which carry no owner field — from the
    // class's written name, which the builder guarantees to be unique
    // whenever it leaves the name to carry ownership. Same-named classes'
    // method groups therefore never merge, and nothing depends on a method
    // happening to sit next to its class.
    const uniqueClasses = new Map<string, ClassState>();
    const classByOrdinal: ClassState[] = [];
    for (const declaration of file.declarations) {
      if (declaration.kind === "class") {
        const state: ClassState = { bases: null, active: false };
        classByOrdinal.push(state);
        if (declaration.name !== "" && !uniqueClasses.has(declaration.name)) uniqueClasses.set(declaration.name, state);
        const controller = declaration.decorators.find((decorator) => decoratorName(decorator) === "Controller");
        if (!controller) continue;
        const bases = controllerPathsView(controller.arguments);
        if (typeof bases === "string") {
          // The class's start line is its first decorator's line — the same
          // line the parser reports for the route the decorator names.
          report.omitted.push({ path: file.path, line: declaration.line, reason: bases });
          continue;
        }
        state.bases = bases;
        state.active = true;
        continue;
      }
      if (declaration.kind !== "function") continue; // variables carry no route decorators
      const owner =
        declaration.ownerClass !== undefined
          ? (classByOrdinal[declaration.ownerClass - 1] ?? null)
          : (methodOwnerClass(declaration.name, uniqueClasses) ?? null);
      if (!owner?.active) continue;
      const bases = owner.bases;
      if (bases === null) continue;
      for (const decorator of declaration.decorators) {
        const name = decoratorName(decorator);
        const verb = name === undefined ? undefined : METHOD_DECORATORS[name];
        if (!verb) continue;
        const line = decorator.line;
        const own = pathArgumentView(decorator.arguments[0]);
        if (own === null) {
          report.omitted.push({ path: file.path, line, reason: `@${name}() is given a path that isn't a string literal` });
          continue;
        }
        for (const base of bases) {
          for (const tail of own) report.routes.push({ path: file.path, method: verb, pattern: joinPath([prefix, base, tail]), line });
        }
      }
    }
  }
  return report;
}

/** A class currently being read: whether it is an active controller, and the paths its decorator resolved to. */
type ClassState = { bases: string[] | null; active: boolean };

/** The class a `Cls.method` declaration belongs to, by the class's written name. */
function methodOwnerClass(name: string, classes: Map<string, ClassState>): ClassState | null {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (classes.get(name.slice(0, dot)) ?? null) : null;
}

/** The paths @Controller() puts in front of its methods, or why they aren't known — over the view's argument values. */
function controllerPathsView(args: readonly ViewArgument[]): string[] | string {
  const [argument] = args;
  if (argument && argument.kind === "object") {
    // version wins over path, checked first exactly as the legacy reader
    // did. A shorthand `{ version }` counts (the view records it); a
    // computed key doesn't (the view skips it, and the legacy name lookup
    // missed it too); a spread hides both (skipped here, unmatched there).
    if (argument.properties.some((property) => property.name === "version")) {
      return "@Controller() sets a version, which changes the path";
    }
    const path = argument.properties.find((property) => property.name === "path");
    if (!path) return [""];
    // A shorthand `{ path }` arrives as an identifier value and resolves to
    // unknown — the same omission string the legacy non-PropertyAssignment
    // guard returned directly.
    return pathArgumentView(path.value) ?? "@Controller() is given a path that isn't a string literal";
  }
  return pathArgumentView(argument) ?? "@Controller() is given a path that isn't a string literal";
}

/** No argument is the empty path; a literal or an array of literals is those paths; anything else is unknown. */
function pathArgumentView(argument: ViewArgument | undefined): string[] | null {
  if (argument === undefined) return [""];
  if (argument.kind === "string-array") return argument.values.length > 0 ? [...argument.values] : null;
  const value = viewLiteralString(argument);
  return value === null ? null : [value];
}

/** A string literal (or no-substitution template) value, else null — the view's spelling of the legacy literalString. */
function viewLiteralString(value: ViewValue): string | null {
  return value.kind === "string" ? value.value : null;
}

/**
 * Local name → exported name, for the named imports from one module — the
 * view's spelling of the legacy importsFrom: literal import statements only
 * (no import-equals, no require), named bindings only (no default slot, no
 * namespace), aliases preserved, the last written binding of a local name
 * winning.
 */
function importedNames(file: ViewFile, module: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const imported of file.imports) {
    if (imported.specifier !== module || imported.kind !== "import" || imported.importEquals) continue;
    for (const binding of imported.bindings) {
      if (binding.defaultSlot || binding.imported === "*" || binding.imported === null) continue;
      names.set(binding.local, binding.imported);
    }
  }
  return names;
}

/** The paths @Controller() puts in front of its methods, or why they aren't known. */
function controllerPaths(decorator: Decorator): string[] | string {
  const [argument] = decorator.getArguments();
  if (argument && Node.isObjectLiteralExpression(argument)) {
    if (argument.getProperty("version")) return "@Controller() sets a version, which changes the path";
    const path = argument.getProperty("path");
    if (!path) return [""];
    if (!Node.isPropertyAssignment(path)) return "@Controller() is given a path that isn't a string literal";
    return pathArgument(path.getInitializer()) ?? "@Controller() is given a path that isn't a string literal";
  }
  return pathArgument(argument) ?? "@Controller() is given a path that isn't a string literal";
}

/** No argument is the empty path; a literal or an array of literals is those paths; anything else is unknown. */
function pathArgument(argument: Node | undefined): string[] | null {
  if (argument === undefined) return [""];
  if (Node.isArrayLiteralExpression(argument)) {
    const values = argument.getElements().map(literalString);
    return values.length > 0 && values.every((v) => v !== null) ? values.filter((v) => v !== null) : null;
  }
  const value = literalString(argument);
  return value === null ? null : [value];
}

export function literalString(node: Node | Expression): string | null {
  return Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) ? node.getLiteralValue() : null;
}

// What Nest does joining the pieces: each gets one leading slash and loses
// its trailing ones, empty pieces drop out, and nothing at all is "/".
// Shared with the Express adapter, which composes mounts the same way.
export function joinPath(pieces: string[]): string {
  const joined = pieces
    .map((p) => p.replace(/\/+$/, ""))
    .filter((p) => p !== "")
    .map((p) => (p.startsWith("/") ? p : `/${p}`))
    .join("");
  return joined === "" ? "/" : joined;
}

/** Local name → exported name, for the named imports from one module. */
function importsFrom(source: SourceFile, module: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const declaration of source.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== module) continue;
    for (const specifier of declaration.getNamedImports()) {
      names.set(specifier.getAliasNode()?.getText() ?? specifier.getName(), specifier.getName());
    }
  }
  return names;
}
