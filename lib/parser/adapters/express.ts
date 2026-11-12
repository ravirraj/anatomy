import path from "node:path";
import { Node, SyntaxKind, type CallExpression, type Node as NodeT, type SourceFile, type VariableDeclaration } from "ts-morph";
import type { Role } from "../../roles.ts";
import { toolConventions, toolRole } from "./conventions.ts";
import { joinPath, literalString } from "./nestjs.ts";
import type { FrameworkAdapter, ProjectFiles, RouteReport } from "./types.ts";

// Express has no file conventions of its own; what it has is a folder habit
// that its generators and most tutorials share. Repositories spell the folders
// both ways, so singular and plural name the same role.
const FOLDER_ROLES: Record<string, Role> = {
  route: "router",
  routes: "router",
  router: "router",
  routers: "router",
  controller: "controller",
  controllers: "controller",
  service: "service",
  services: "service",
  model: "model",
  models: "model",
  middleware: "middleware",
  middlewares: "middleware",
};

// The folder nearest the file decides, so routes/v1/middleware/auth.js is
// middleware rather than a router.
function folderRole(path: string): Role | null {
  const folders = path.split("/").slice(0, -1);
  for (let i = folders.length - 1; i >= 0; i--) {
    const role = FOLDER_ROLES[folders[i] ?? ""];
    if (role) return role;
  }
  return null;
}

// The methods a route can be registered with, and the HTTP method each maps
// to. Express accepts more through app.METHOD (checkout, copy, …) and
// app.route() chains; a registration the syntax doesn't recognize is left out
// rather than guessed at.
const ROUTE_METHODS: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  options: "OPTIONS",
  head: "HEAD",
  all: "ALL",
};

// Why a router's registrations can't be given their full pattern. A pattern
// is the router's own path prefixed by every mount it sits under, so a
// registration is only emitted when every mount in its chain is written as a
// string literal in the parsed sources.
const NEVER_MOUNTED = "the router it's registered on is never mounted";
const NON_LITERAL_MOUNT = "the router it's registered on is mounted at a path that isn't a string literal";
const CIRCULAR_MOUNT = "the router it's registered on is mounted through a circular chain";
const ambiguousMount = (fromFile: string) => `the value mounted from ${fromFile} can't be traced to a single router`;

type Decl = { file: string; name: string; kind: "app" | "router" };

type PrefixState = { kind: "known"; prefixes: string[] } | { kind: "unknown"; reason: string };

// A mount records that one declared router (or app) mounts another under a
// prefix: app.use("/api", router). `prefixes === null` when the mount's path
// isn't a string literal, and `to` is null when the mounted value can't be
// traced to exactly one router in the parsed sources.
type Mount = { fromFile: string; from: string; prefixes: string[] | null; to: string | null; ambiguousFile: string | null };

type Registration = {
  key: string;
  file: string;
  callee: string;
  method: string;
  paths: string[] | null;
  line: number;
};

export const expressAdapter: FrameworkAdapter = {
  name: "Express",
  detect: (project) => project.dependencies.has("express"),
  excludeDirectory: () => null,
  reachedBy: toolConventions,
  // A test file under routes/ is still a test.
  roleOf: (file) => toolRole(file.path) ?? folderRole(file.path),
  routes: expressRoutes,
};

function expressRoutes({ files, unparsed }: ProjectFiles): RouteReport {
  const report: RouteReport = { routes: [], omitted: [], withheld: null };
  const withhold = (reason: string): RouteReport => ({ ...report, withheld: reason });

  // Anything that changes every pattern from outside the routers has to be
  // known before any single pattern is: an unparsed file could mount any
  // router under another prefix.
  if (unparsed.length > 0) {
    return withhold(`${unparsed.length} file${unparsed.length === 1 ? " wasn't" : "s weren't"} parsed, and one could mount a router under another prefix`);
  }

  const paths = new Set(files.map((f) => f.path));

  // First pass, per file: the local names the express module is bound to, the
  // relative modules required or imported, and every app/router declared.
  const bindings = new Map<string, { app: Set<string>; router: Set<string> }>();
  const locals = new Map<string, Map<string, string>>();
  const decls = new Map<string, Map<string, "app" | "router">>();
  for (const { path: file, source } of files) {
    bindings.set(file, expressBindings(source));
    locals.set(file, localSpecifiers(source));
    const declared = new Map<string, "app" | "router">();
    for (const statement of source.getVariableDeclarations()) {
      const kind = declaredKind(statement, bindings.get(file)!);
      if (kind) declared.set(statement.getName(), kind);
    }
    decls.set(file, declared);
  }

  // Second pass: the mounts and the registrations each declared router holds.
  const mounts: Mount[] = [];
  const registrations: Registration[] = [];
  for (const { path: file, source } of files) {
    const declared = decls.get(file)!;
    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const receiver = callee.getExpression();
      if (!Node.isIdentifier(receiver)) continue;
      const kind = declared.get(receiver.getText());
      if (!kind) continue; // an unknown receiver is never read as a route

      const name = callee.getName();
      const key = `${file}::${receiver.getText()}`;
      if (name === "use") readMount(call, { file, key, decls, locals: locals.get(file)!, paths, mounts });
      else {
        const method = ROUTE_METHODS[name];
        if (method) readRegistration(call, { key, file, callee: `${receiver.getText()}.${name}`, method, registrations });
      }
    }
  }

  // Third pass: resolve each router's prefixes through its mount chain.
  const byKey = new Map<string, Decl>();
  for (const [file, declared] of decls) {
    for (const [name, kind] of declared) byKey.set(`${file}::${name}`, { file, name, kind });
  }
  const states = new Map<string, PrefixState>();
  // A mount whose target can't be traced to one router marks every router the
  // target file declares as prefix-unknown.
  for (const mount of mounts) {
    if (mount.ambiguousFile !== null) {
      for (const [key, decl] of byKey) {
        if (decl.file === mount.ambiguousFile && !states.has(key)) {
          states.set(key, { kind: "unknown", reason: ambiguousMount(mount.fromFile) });
        }
      }
    }
  }
  const resolving = new Set<string>();
  function prefixesOf(key: string): PrefixState {
    const memo = states.get(key);
    if (memo) return memo;
    if (resolving.has(key)) return { kind: "unknown", reason: CIRCULAR_MOUNT };
    resolving.add(key);
    const incoming = mounts.filter((m) => m.to === key);
    let state: PrefixState;
    if (incoming.length === 0) {
      // An app nobody mounts is the top of its chain; a router nobody mounts
      // can't be reached at any pattern at all.
      state = byKey.get(key)!.kind === "app"
        ? { kind: "known", prefixes: [""] }
        : { kind: "unknown", reason: NEVER_MOUNTED };
    } else {
      const prefixes: string[] = [];
      let unknownReason: string | null = null;
      for (const mount of incoming) {
        if (mount.prefixes === null) { unknownReason = NON_LITERAL_MOUNT; break; }
        const from = prefixesOf(mount.from);
        if (from.kind === "unknown") { unknownReason = from.reason; break; }
        for (const base of from.prefixes) {
          for (const piece of mount.prefixes) prefixes.push(joinPath([base, piece]));
        }
      }
      state = unknownReason === null ? { kind: "known", prefixes } : { kind: "unknown", reason: unknownReason };
    }
    resolving.delete(key);
    states.set(key, state);
    return state;
  }

  // A registration is only emitted with a pattern when both its own path and
  // every prefix in its mount chain are written in the syntax; anything less
  // is an explicit omission, never a guess.
  for (const registration of registrations) {
    const state = prefixesOf(registration.key);
    if (state.kind === "unknown") {
      report.omitted.push({ path: registration.file, line: registration.line, reason: state.reason });
      continue;
    }
    if (registration.paths === null) {
      report.omitted.push({
        path: registration.file,
        line: registration.line,
        reason: `${registration.callee}() is given a path that isn't a string literal`,
      });
      continue;
    }
    for (const prefix of state.prefixes) {
      for (const own of registration.paths) {
        report.routes.push({ path: registration.file, method: registration.method, pattern: joinPath([prefix, own]), line: registration.line });
      }
    }
  }
  return report;
}

/** The local names the express module is bound to: the app factory and the Router factory. */
function expressBindings(source: SourceFile): { app: Set<string>; router: Set<string> } {
  const app = new Set<string>();
  const router = new Set<string>();
  for (const declaration of source.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== "express") continue;
    const def = declaration.getDefaultImport();
    if (def) app.add(def.getText());
    const namespace = declaration.getNamespaceImport();
    if (namespace) app.add(namespace.getText());
    for (const named of declaration.getNamedImports()) {
      if (named.getName() === "Router") router.add(named.getAliasNode()?.getText() ?? named.getName());
    }
  }
  for (const declaration of source.getVariableDeclarations()) {
    const init = declaration.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    const callee = init.getExpression();
    if (!(Node.isIdentifier(callee) && callee.getText() === "require")) continue;
    const [argument] = init.getArguments();
    const specifier = argument && Node.isStringLiteral(argument) ? argument.getLiteralValue() : null;
    if (specifier !== "express") continue;
    const nameNode = declaration.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      app.add(nameNode.getText());
      continue;
    }
    if (!Node.isObjectBindingPattern(nameNode)) continue;
    for (const element of nameNode.getElements()) {
      const exported = element.getPropertyNameNode() ?? element.getNameNode();
      const exportedName = Node.isStringLiteral(exported)
        ? exported.getLiteralValue()
        : Node.isIdentifier(exported) ? exported.getText() : null;
      const local = element.getNameNode().getText();
      if (exportedName === "default" || exportedName === "express") app.add(local);
      else if (exportedName === "Router") router.add(local);
    }
  }
  return { app, router };
}

/** The relative modules a file binds local names to, by require or import. */
function localSpecifiers(source: SourceFile): Map<string, string> {
  const locals = new Map<string, string>();
  for (const declaration of source.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
    const def = declaration.getDefaultImport();
    if (def) locals.set(def.getText(), specifier);
    for (const named of declaration.getNamedImports()) {
      locals.set(named.getAliasNode()?.getText() ?? named.getName(), specifier);
    }
  }
  for (const declaration of source.getVariableDeclarations()) {
    const init = declaration.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    const callee = init.getExpression();
    if (!(Node.isIdentifier(callee) && callee.getText() === "require")) continue;
    const [argument] = init.getArguments();
    const specifier = argument && Node.isStringLiteral(argument) ? argument.getLiteralValue() : null;
    if (specifier === null || (!specifier.startsWith("./") && !specifier.startsWith("../"))) continue;
    const nameNode = declaration.getNameNode();
    if (Node.isIdentifier(nameNode)) locals.set(nameNode.getText(), specifier);
    else if (Node.isObjectBindingPattern(nameNode)) {
      for (const element of nameNode.getElements()) {
        locals.set(element.getNameNode().getText(), specifier);
      }
    }
  }
  return locals;
}

/** `express()` declares an app; `Router()` and `express.Router()` declare a router. */
function declaredKind(
  statement: VariableDeclaration,
  moduleNames: { app: Set<string>; router: Set<string> },
): "app" | "router" | null {
  const init = statement.getInitializer();
  if (!init || !Node.isCallExpression(init)) return null;
  const callee = init.getExpression();
  if (Node.isIdentifier(callee)) {
    const name = callee.getText();
    if (moduleNames.app.has(name)) return "app";
    if (moduleNames.router.has(name)) return "router";
    return null;
  }
  if (Node.isPropertyAccessExpression(callee)) {
    const object = callee.getExpression();
    return Node.isIdentifier(object) && moduleNames.app.has(object.getText()) && callee.getName() === "Router"
      ? "router"
      : null;
  }
  return null;
}

type MountContext = {
  file: string;
  key: string;
  decls: Map<string, Map<string, "app" | "router">>;
  locals: Map<string, string>;
  paths: Set<string>;
  mounts: Mount[];
};

/** app.use(path?, router) — the mounted value has to trace to one declared router. */
function readMount(call: CallExpression, context: MountContext): void {
  const args = call.getArguments();
  // Two arguments is path + router; one is a bare router. Anything else is a
  // middleware shape the syntax doesn't pin down.
  if (args.length > 2 || args.length === 0) return;
  const target = args[args.length - 1];
  if (!Node.isIdentifier(target)) return;
  const resolved = resolveMounted(context, target.getText());
  if (resolved === null) return;
  const prefixes = args.length === 2 ? pathPrefixes(args[0]!) : [""];
  context.mounts.push({
    fromFile: context.file,
    from: context.key,
    prefixes,
    to: resolved.key,
    ambiguousFile: resolved.ambiguousFile,
  });
}

type RegistrationContext = {
  key: string;
  file: string;
  callee: string;
  method: string;
  registrations: Registration[];
};

/** X.<method>(path, handler…) — the path is a literal, an array of literals, or unknown. */
function readRegistration(call: CallExpression, context: RegistrationContext): void {
  const [pathNode] = call.getArguments();
  if (!pathNode) return;
  let paths: string[] | null;
  if (Node.isArrayLiteralExpression(pathNode)) {
    const values = pathNode.getElements().map(literalString);
    paths = values.length > 0 && values.every((v) => v !== null) ? (values as string[]) : null;
  } else {
    const value = literalString(pathNode);
    paths = value === null ? null : [value];
  }
  context.registrations.push({
    key: context.key,
    file: context.file,
    callee: context.callee,
    method: context.method,
    paths,
    line: call.getStartLineNumber(),
  });
}

/** The paths a mount is given: a literal is one path, an array of literals is each, anything else is unknown. */
function pathPrefixes(node: NodeT): string[] | null {
  if (Node.isArrayLiteralExpression(node)) {
    const values = node.getElements().map(literalString);
    return values.length > 0 && values.every((v) => v !== null) ? (values as string[]) : null;
  }
  const value = literalString(node);
  return value === null ? null : [value];
}

type Mounted = { key: string | null; ambiguousFile: string | null };

/** Which declared router a mounted identifier names: one in this file, or the single one a relative module declares. */
function resolveMounted(context: MountContext, identifier: string): Mounted | null {
  if (context.decls.get(context.file)?.has(identifier)) {
    return { key: `${context.file}::${identifier}`, ambiguousFile: null };
  }
  const specifier = context.locals.get(identifier);
  if (!specifier) return null; // external or not a module binding: middleware
  const target = resolveSpecifier(context.paths, context.file, specifier);
  if (target === null) return null;
  const declared = [...(context.decls.get(target)?.entries() ?? [])];
  if (declared.length === 1) return { key: `${target}::${declared[0]![0]}`, ambiguousFile: null };
  if (declared.length === 0) return null; // the module holds no router: middleware
  return { key: null, ambiguousFile: target };
}

// Node's require and import resolution over the parsed files, far enough for
// relative specifiers: the exact path, with an extension added, or an index.
const CODE_EXTENSIONS = [".js", ".ts", ".mjs", ".cjs"];

function resolveSpecifier(files: Set<string>, fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : ".";
  const base = path.posix.join(dir, specifier);
  const candidates = [base];
  for (const extension of CODE_EXTENSIONS) candidates.push(base + extension);
  for (const extension of CODE_EXTENSIONS) candidates.push(`${base}/index${extension}`);
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}
