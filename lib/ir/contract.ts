// Validation for the canonical IR, in the mould of the parser's contract
// validator (lib/parser/contract.ts): a malformed IR fails loudly with the
// field that is wrong, instead of becoming an Ir by assertion.
//
// The validator is deliberately at least as strict as the parser contract for
// the sections the two share, and stricter where the IR adds structure:
// declaration kinds must come from the registry, scope chains must decompose
// exactly into their names, and the provenance block is mandatory. It also
// validates the symbol fields the parser contract's read-back does not
// (signature, parameters, documentation, export kind), so an IR crossing a
// boundary cannot lose them silently.

import { ROLE_IDS } from "../roles.ts";
import type { NonCodeCandidate } from "../parser/screening.ts";
import {
  CONFIG_REFERENCE_KINDS,
  DEPENDENCY_KINDS,
  EDGE_KINDS,
  MANIFEST_ECOSYSTEMS,
  SCHEMA_VERSION,
  SYMBOL_KINDS,
  type ConfigReference,
  type ConfigReport,
  type Coverage,
  type Dependency,
  type EdgeKind,
  type EntryPoint,
  type EnvDeclaration,
  type ExcludedDirectory,
  type ExcludedReason,
  type Manifest,
  type OmittedRoute,
  type ParsedFile,
  type Project,
  type Route,
  type SkippedFile,
  type SkipReason,
  type StatusCounts,
  type UnresolvedImport,
  type UnresolvedReason,
  type WithheldRoutes,
} from "../parser/types.ts";
import { DECLARATION_KINDS, IR_VERSION, RELATIONSHIP_KINDS, type Ir, type IrExtensionValue, type IrExtensions, type IrSymbol } from "./types.ts";

const SKIP_REASONS: readonly SkipReason[] = ["declaration-file", "too-large", "binary", "symlink", "syntax-error", "unreadable"];
const EXCLUDED_REASONS: readonly ExcludedReason[] = ["non-code-file", "declaration-file", "target-skipped", "in-excluded-directory"];
const UNRESOLVED_REASONS: readonly UnresolvedReason[] = [
  "non-literal-dynamic-import",
  "non-literal-require",
  "file-not-found",
  "directory-without-index",
  "alias-target-not-found",
  "workspace-package-not-linked",
  "subpath-import-not-found",
];

/** JS/TS identifier shape. Qualified names are dot-joined identifiers. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Extension namespace: a lowercase slug. "ir" and "core" stay reserved. */
const EXTENSION_NAMESPACE = /^[a-z][a-z0-9-]*$/;
const RESERVED_NAMESPACES = new Set(["ir", "core"]);

export function validateIr(value: unknown): Ir {
  const o = object(value, "$");
  const irVersion = o.irVersion;
  if (irVersion !== IR_VERSION) {
    throw new IrContractError("$.irVersion", `unsupported IR version: expected ${IR_VERSION}, got ${JSON.stringify(irVersion)}`);
  }
  const source = object(o.source, "$.source");
  const producer = string(source.producer, "$.source.producer");
  if (producer.length === 0) throw new IrContractError("$.source.producer", "producer must be a non-empty string");
  const derivedFrom = object(source.derivedFrom, "$.source.derivedFrom");
  const parserSchema = derivedFrom.parserSchema;
  if (parserSchema !== SCHEMA_VERSION) {
    throw new IrContractError("$.source.derivedFrom.parserSchema", `unsupported parser schema: expected ${SCHEMA_VERSION}, got ${JSON.stringify(parserSchema)}`);
  }

  const files = array(o.files, "$.files", parsedFile);
  const paths = new Set<string>();
  for (const [i, file] of files.entries()) {
    if (paths.has(file.path)) throw new IrContractError(`$.files[${i}].path`, `duplicate file path: ${file.path}`);
    paths.add(file.path);
  }

  const symbols = array(o.symbols, "$.symbols", (v, at) => symbol(v, at, paths));
  const relationships = array(o.relationships, "$.relationships", relationship);

  const ir: Ir = {
    irVersion,
    source: { producer, derivedFrom: { parserSchema } },
    root: string(o.root, "$.root"),
    projects: array(o.projects, "$.projects", project),
    files,
    symbols,
    relationships,
    routes: array(o.routes, "$.routes", route),
    manifests: array(o.manifests, "$.manifests", manifest),
    dependencies: array(o.dependencies, "$.dependencies", dependency),
    configReferences: array(o.configReferences, "$.configReferences", configReference),
    envDeclarations: array(o.envDeclarations, "$.envDeclarations", envDeclaration),
    entryPoints: array(o.entryPoints, "$.entryPoints", entryPoint),
    coverage: coverage(o.coverage, "$.coverage"),
    configs: array(o.configs, "$.configs", configReport),
    ...(o.nonCodeCandidates === undefined ? {} : { nonCodeCandidates: array(o.nonCodeCandidates, "$.nonCodeCandidates", nonCodeCandidate) }),
  };

  // Structural guarantees, checked rather than trusted — the parser contract's
  // own rules, restated over IR field names.
  ir.relationships.forEach((r, i) => {
    if (!paths.has(r.source)) throw new IrContractError(`$.relationships[${i}].source`, `${r.source} is not a file in the IR`);
    if (!paths.has(r.target)) throw new IrContractError(`$.relationships[${i}].target`, `${r.target} is not a file in the IR`);
  });
  ir.routes.forEach((r, i) => {
    if (!paths.has(r.file)) throw new IrContractError(`$.routes[${i}].file`, `${r.file} is not a file in the IR`);
  });
  ir.symbols.forEach((s, i) => {
    if (!paths.has(s.file)) throw new IrContractError(`$.symbols[${i}].file`, `${s.file} is not a file in the IR`);
  });
  ir.entryPoints.forEach((e, i) => {
    if (e.resolved && !paths.has(e.path)) {
      throw new IrContractError(`$.entryPoints[${i}].resolved`, `${e.path} is marked resolved but is not a file in the IR`);
    }
    if (!e.resolved && paths.has(e.path)) {
      throw new IrContractError(`$.entryPoints[${i}].resolved`, `${e.path} is marked unresolved but is a file in the IR`);
    }
    for (const via of e.via ?? []) {
      if (!paths.has(via)) throw new IrContractError(`$.entryPoints[${i}].via`, `${via} is not a file in the IR`);
    }
  });
  const manifestPaths = new Set<string>();
  ir.manifests.forEach((m, i) => {
    if (manifestPaths.has(m.path)) throw new IrContractError(`$.manifests[${i}].path`, `duplicate manifest path: ${m.path}`);
    manifestPaths.add(m.path);
  });
  ir.dependencies.forEach((d, i) => {
    if (!manifestPaths.has(d.manifest)) {
      throw new IrContractError(`$.dependencies[${i}].manifest`, `${d.manifest} is not a manifest in the IR`);
    }
  });
  const envPaths = new Set(ir.envDeclarations.map((e) => e.path));
  ir.configReferences.forEach((r, i) => {
    if (r.kind !== "env-example" && !paths.has(r.file)) {
      throw new IrContractError(`$.configReferences[${i}].file`, `${r.file} is not a file in the IR`);
    }
    if (r.kind === "env-example" && !envPaths.has(r.file)) {
      throw new IrContractError(`$.configReferences[${i}].file`, `${r.file} is not an environment template in the IR`);
    }
  });
  if (ir.projects[0]?.path !== ".") throw new IrContractError("$.projects[0].path", "the root must be the first project");
  const { found, parsed, skipped } = ir.coverage.files;
  if (parsed !== ir.files.length) throw new IrContractError("$.coverage.files.parsed", `${parsed} but ${ir.files.length} files listed`);
  if (found !== parsed + skipped) throw new IrContractError("$.coverage.files.found", `${found} ≠ ${parsed} parsed + ${skipped} skipped`);
  return ir;
}

export class IrContractError extends Error {
  constructor(at: string, problem: string) {
    super(`Invalid IR at ${at}: ${problem}`);
    this.name = "IrContractError";
  }
}

// ---- Shared sections (same shape and rules as the parser contract) ----

function parsedFile(value: unknown, at: string): ParsedFile {
  const o = object(value, at);
  return {
    path: string(o.path, `${at}.path`),
    module: string(o.module, `${at}.module`),
    lines: count(o.lines, `${at}.lines`),
    bytes: count(o.bytes, `${at}.bytes`),
    hash: string(o.hash, `${at}.hash`),
    fanIn: count(o.fanIn, `${at}.fanIn`),
    fanOut: count(o.fanOut, `${at}.fanOut`),
    reachedBy: o.reachedBy === null ? null : string(o.reachedBy, `${at}.reachedBy`),
    role: o.role === null ? null : oneOf(o.role, `${at}.role`, ROLE_IDS),
    exports: array(o.exports, `${at}.exports`, string),
  };
}

function route(value: unknown, at: string): Route {
  const o = object(value, at);
  const method = string(o.method, `${at}.method`);
  if (!/^[A-Z]+$/.test(method)) throw new IrContractError(`${at}.method`, `expected an upper-case method, got ${JSON.stringify(method)}`);
  const pattern = string(o.pattern, `${at}.pattern`);
  if (!pattern.startsWith("/")) throw new IrContractError(`${at}.pattern`, `expected a pattern starting with /, got ${JSON.stringify(pattern)}`);
  return { file: string(o.file, `${at}.file`), method, pattern, line: count(o.line, `${at}.line`) };
}

function omittedRoute(value: unknown, at: string): OmittedRoute {
  const o = object(value, at);
  return { file: string(o.file, `${at}.file`), line: count(o.line, `${at}.line`), reason: string(o.reason, `${at}.reason`) };
}

function withheldRoutes(value: unknown, at: string): WithheldRoutes {
  const o = object(value, at);
  return { project: string(o.project, `${at}.project`), reason: string(o.reason, `${at}.reason`) };
}

function project(value: unknown, at: string): Project {
  const o = object(value, at);
  return { path: string(o.path, `${at}.path`), adapter: string(o.adapter, `${at}.adapter`) };
}

function relationship(value: unknown, at: string): Ir["relationships"][number] {
  const o = object(value, at);
  return {
    source: string(o.source, `${at}.source`),
    target: string(o.target, `${at}.target`),
    kind: oneOf(o.kind, `${at}.kind`, RELATIONSHIP_KINDS),
    typeOnly: boolean(o.typeOnly, `${at}.typeOnly`),
    specifier: string(o.specifier, `${at}.specifier`),
    line: count(o.line, `${at}.line`),
  };
}

function manifest(value: unknown, at: string): Manifest {
  const o = object(value, at);
  return {
    path: string(o.path, `${at}.path`),
    dir: string(o.dir, `${at}.dir`),
    project: string(o.project, `${at}.project`),
    ecosystem: oneOf(o.ecosystem, `${at}.ecosystem`, MANIFEST_ECOSYSTEMS),
    name: o.name === null ? null : string(o.name, `${at}.name`),
    workspaces: array(o.workspaces, `${at}.workspaces`, string),
    scripts: array(o.scripts, `${at}.scripts`, (v, p) => {
      const s = object(v, p);
      return { name: string(s.name, `${p}.name`), command: string(s.command, `${p}.command`) };
    }),
    problems: array(o.problems, `${at}.problems`, string),
  };
}

function dependency(value: unknown, at: string): Dependency {
  const o = object(value, at);
  return {
    name: string(o.name, `${at}.name`),
    version: o.version === null ? null : string(o.version, `${at}.version`),
    kind: oneOf(o.kind, `${at}.kind`, DEPENDENCY_KINDS),
    manifest: string(o.manifest, `${at}.manifest`),
    dir: string(o.dir, `${at}.dir`),
    project: string(o.project, `${at}.project`),
    importedBy: count(o.importedBy, `${at}.importedBy`),
  };
}

function configReference(value: unknown, at: string): ConfigReference {
  const o = object(value, at);
  return {
    file: string(o.file, `${at}.file`),
    variable: string(o.variable, `${at}.variable`),
    line: count(o.line, `${at}.line`),
    kind: oneOf(o.kind, `${at}.kind`, CONFIG_REFERENCE_KINDS),
    ...(o.detail === undefined ? {} : { detail: string(o.detail, `${at}.detail`) }),
  };
}

function envDeclaration(value: unknown, at: string): EnvDeclaration {
  const o = object(value, at);
  return { path: string(o.path, `${at}.path`), keys: array(o.keys, `${at}.keys`, string) };
}

function entryPoint(value: unknown, at: string): EntryPoint {
  const o = object(value, at);
  const resolved = boolean(o.resolved, `${at}.resolved`);
  const reason = o.unresolvedReason === undefined ? undefined : oneOf(o.unresolvedReason, `${at}.unresolvedReason`, ["not-indexed", "not-found"] as const);
  if (resolved && reason !== undefined) {
    throw new IrContractError(`${at}.unresolvedReason`, "a resolved entry point cannot carry an unresolved reason");
  }
  if (!resolved && reason === undefined) {
    throw new IrContractError(`${at}.unresolvedReason`, "an unresolved entry point must carry an unresolved reason");
  }
  return {
    path: string(o.path, `${at}.path`),
    kind: oneOf(o.kind, `${at}.kind`, ["declared", "inferred"] as const),
    source: string(o.source, `${at}.source`),
    manifest: o.manifest === null ? null : string(o.manifest, `${at}.manifest`),
    ...(o.detail === undefined ? {} : { detail: string(o.detail, `${at}.detail`) }),
    resolved,
    ...(reason === undefined ? {} : { unresolvedReason: reason }),
    ...(o.via === undefined ? {} : { via: array(o.via, `${at}.via`, string) }),
  };
}

function configReport(value: unknown, at: string): ConfigReport {
  const o = object(value, at);
  return { path: string(o.path, `${at}.path`), errors: array(o.errors, `${at}.errors`, string) };
}

function nonCodeCandidate(value: unknown, at: string): NonCodeCandidate {
  const o = object(value, at);
  return {
    path: string(o.path, `${at}.path`),
    absolutePath: string(o.absolutePath, `${at}.absolutePath`),
    module: string(o.module, `${at}.module`),
    content: string(o.content, `${at}.content`),
    bytes: count(o.bytes, `${at}.bytes`),
    lines: count(o.lines, `${at}.lines`),
    hash: string(o.hash, `${at}.hash`),
    project: string(o.project, `${at}.project`),
    category: oneOf(o.category, `${at}.category`, ["primary_manifest"] as const),
  };
}

function coverage(value: unknown, at: string): Coverage {
  const o = object(value, at);
  const files = object(o.files, `${at}.files`);
  const imports = object(o.imports, `${at}.imports`);
  const byKind = object(imports.byKind, `${at}.imports.byKind`);
  const external = object(imports.external, `${at}.imports.external`);
  const routes = object(o.routes, `${at}.routes`);
  const calls = object(o.calls, `${at}.calls`);
  return {
    files: {
      found: count(files.found, `${at}.files.found`),
      parsed: count(files.parsed, `${at}.files.parsed`),
      skipped: count(files.skipped, `${at}.files.skipped`),
      skippedFiles: array(files.skippedFiles, `${at}.files.skippedFiles`, skippedFile),
      excludedDirectories: array(files.excludedDirectories, `${at}.files.excludedDirectories`, excludedDirectory),
    },
    imports: {
      total: statusCounts(imports.total, `${at}.imports.total`),
      byKind: {
        import: statusCounts(byKind.import, `${at}.imports.byKind.import`),
        "re-export": statusCounts(byKind["re-export"], `${at}.imports.byKind.re-export`),
        "dynamic-import": statusCounts(byKind["dynamic-import"], `${at}.imports.byKind.dynamic-import`),
        require: statusCounts(byKind.require, `${at}.imports.byKind.require`),
        call: statusCounts(byKind.call, `${at}.imports.byKind.call`),
      },
      external: {
        package: count(external.package, `${at}.imports.external.package`),
        builtin: count(external.builtin, `${at}.imports.external.builtin`),
        "outside-root": count(external["outside-root"], `${at}.imports.external.outside-root`),
      },
      excluded: countsKeyedBy(imports.excluded, `${at}.imports.excluded`, EXCLUDED_REASONS),
      unresolvedByReason: countsKeyedBy(imports.unresolvedByReason, `${at}.imports.unresolvedByReason`, UNRESOLVED_REASONS),
      unresolved: array(imports.unresolved, `${at}.imports.unresolved`, unresolvedImport),
    },
    routes: {
      omitted: array(routes.omitted, `${at}.routes.omitted`, omittedRoute),
      withheld: array(routes.withheld, `${at}.routes.withheld`, withheldRoutes),
    },
    calls: {
      total: count(calls.total, `${at}.calls.total`),
      resolved: count(calls.resolved, `${at}.calls.resolved`),
      unresolved: count(calls.unresolved, `${at}.calls.unresolved`),
      unresolvedCalls: array(calls.unresolvedCalls, `${at}.calls.unresolvedCalls`, (v, p) => {
        const u = object(v, p);
        return {
          from: string(u.from, `${p}.from`),
          callee: string(u.callee, `${p}.callee`),
          line: count(u.line, `${p}.line`),
          reason: string(u.reason, `${p}.reason`),
        };
      }),
    },
  };
}

function statusCounts(value: unknown, at: string): StatusCounts {
  const o = object(value, at);
  return {
    seen: count(o.seen, `${at}.seen`),
    internal: count(o.internal, `${at}.internal`),
    external: count(o.external, `${at}.external`),
    excluded: count(o.excluded, `${at}.excluded`),
    unresolved: count(o.unresolved, `${at}.unresolved`),
  };
}

function skippedFile(value: unknown, at: string): SkippedFile {
  const o = object(value, at);
  return {
    path: string(o.path, `${at}.path`),
    reason: oneOf(o.reason, `${at}.reason`, SKIP_REASONS),
    detail: string(o.detail, `${at}.detail`),
  };
}

function excludedDirectory(value: unknown, at: string): ExcludedDirectory {
  const o = object(value, at);
  return { path: string(o.path, `${at}.path`), reason: string(o.reason, `${at}.reason`) };
}

function unresolvedImport(value: unknown, at: string): UnresolvedImport {
  const o = object(value, at);
  return {
    from: string(o.from, `${at}.from`),
    specifier: string(o.specifier, `${at}.specifier`),
    kind: oneOf<EdgeKind>(o.kind, `${at}.kind`, EDGE_KINDS),
    line: count(o.line, `${at}.line`),
    reason: oneOf(o.reason, `${at}.reason`, UNRESOLVED_REASONS),
    detail: string(o.detail, `${at}.detail`),
  };
}

function countsKeyedBy<K extends string>(value: unknown, at: string, keys: readonly K[]): Partial<Record<K, number>> {
  const o = object(value, at);
  const out: Partial<Record<K, number>> = {};
  for (const [key, n] of Object.entries(o)) {
    out[oneOf(key, `${at} key`, keys)] = count(n, `${at}.${key}`);
  }
  return out;
}

// ---- Symbols (IR-specific structure) ----

function symbol(value: unknown, at: string, paths: ReadonlySet<string>): IrSymbol {
  const o = object(value, at);
  const file = string(o.file, `${at}.file`);
  if (!paths.has(file)) throw new IrContractError(`${at}.file`, `${file} is not a file in the IR`);

  const name = string(o.name, `${at}.name`);
  const segments = name.split(".");
  if (segments.length === 0 || name.length === 0) throw new IrContractError(`${at}.name`, "a qualified name cannot be empty");
  for (const [i, segment] of segments.entries()) {
    if (!IDENTIFIER.test(segment)) {
      throw new IrContractError(`${at}.name`, `segment ${i} of ${JSON.stringify(name)} is not an identifier`);
    }
  }

  const leafName = string(o.leafName, `${at}.leafName`);
  if (leafName !== segments[segments.length - 1]) {
    throw new IrContractError(`${at}.leafName`, `${JSON.stringify(leafName)} is not the final segment of ${JSON.stringify(name)}`);
  }

  const scope = array(o.scope, `${at}.scope`, (v, p) => {
    const segment = object(v, p);
    const segmentName = string(segment.name, `${p}.name`);
    if (!IDENTIFIER.test(segmentName)) throw new IrContractError(`${p}.name`, `not an identifier: ${JSON.stringify(segmentName)}`);
    const container =
      segment.container === null
        ? null
        : (() => {
            const c = object(segment.container, `${p}.container`);
            return {
              declaration: oneOf(c.declaration, `${p}.container.declaration`, DECLARATION_KINDS),
              compatKind: oneOf(c.compatKind, `${p}.container.compatKind`, SYMBOL_KINDS),
            };
          })();
    return { name: segmentName, container };
  });
  if (scope.length !== segments.length - 1) {
    throw new IrContractError(`${at}.scope`, `expected ${segments.length - 1} segments for ${JSON.stringify(name)}, got ${scope.length}`);
  }
  for (const [i, segment] of scope.entries()) {
    if (segment.name !== segments[i]) {
      throw new IrContractError(`${at}.scope[${i}].name`, `${JSON.stringify(segment.name)} does not match segment ${i} of ${JSON.stringify(name)}`);
    }
  }

  const out: IrSymbol = {
    file,
    name,
    leafName,
    compatKind: oneOf(o.compatKind, `${at}.compatKind`, SYMBOL_KINDS),
    declaration: oneOf(o.declaration, `${at}.declaration`, DECLARATION_KINDS),
    scope,
    line: count(o.line, `${at}.line`),
    exported: boolean(o.exported, `${at}.exported`),
  };
  if (o.endLine !== undefined) out.endLine = count(o.endLine, `${at}.endLine`);
  if (o.exportKind !== undefined) out.exportKind = oneOf(o.exportKind, `${at}.exportKind`, ["named", "default", "none"] as const);
  if (o.parameters !== undefined) {
    out.parameters = array(o.parameters, `${at}.parameters`, (v, p) => {
      const parameter = object(v, p);
      return { name: string(parameter.name, `${p}.name`), type: string(parameter.type, `${p}.type`) };
    });
  }
  if (o.returnType !== undefined) out.returnType = string(o.returnType, `${at}.returnType`);
  if (o.signature !== undefined) out.signature = string(o.signature, `${at}.signature`);
  if (o.documentation !== undefined) out.documentation = string(o.documentation, `${at}.documentation`);
  if (o.isPublicApi !== undefined) out.isPublicApi = boolean(o.isPublicApi, `${at}.isPublicApi`);
  if (o.extensions !== undefined) out.extensions = extensions(o.extensions, `${at}.extensions`);
  return out;
}

function extensions(value: unknown, at: string): IrExtensions {
  const namespaces = object(value, at);
  const out: IrExtensions = {};
  for (const [namespace, detail] of Object.entries(namespaces)) {
    if (!EXTENSION_NAMESPACE.test(namespace)) {
      throw new IrContractError(`${at}.${namespace}`, `extension namespaces are lowercase slugs, got ${JSON.stringify(namespace)}`);
    }
    if (RESERVED_NAMESPACES.has(namespace)) {
      throw new IrContractError(`${at}.${namespace}`, `"${namespace}" is a reserved namespace`);
    }
    const entries = object(detail, `${at}.${namespace}`);
    const checked: { [key: string]: IrExtensionValue } = {};
    for (const [key, entryValue] of Object.entries(entries)) {
      if (key.length === 0) throw new IrContractError(`${at}.${namespace}`, "extension keys cannot be empty");
      checked[key] = extensionValue(entryValue, `${at}.${namespace}.${key}`);
    }
    out[namespace] = checked;
  }
  return out;
}

function extensionValue(value: unknown, at: string): IrExtensionValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new IrContractError(at, "extension numbers must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => extensionValue(v, `${at}[${i}]`));
  if (typeof value === "object") {
    const o = object(value, at);
    const out: { [key: string]: IrExtensionValue } = {};
    for (const [key, v] of Object.entries(o)) out[key] = extensionValue(v, `${at}.${key}`);
    return out;
  }
  throw new IrContractError(at, `extension values must be JSON data, got ${typeof value}`);
}

// ---- Value helpers (same discipline as the parser contract) ----

function object(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new IrContractError(at, "expected an object");
  return value as Record<string, unknown>;
}

function string(value: unknown, at: string): string {
  if (typeof value !== "string") throw new IrContractError(at, `expected a string, got ${JSON.stringify(value)}`);
  return value;
}

function count(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new IrContractError(at, `expected a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function boolean(value: unknown, at: string): boolean {
  if (typeof value !== "boolean") throw new IrContractError(at, `expected a boolean, got ${JSON.stringify(value)}`);
  return value;
}

function oneOf<T extends string>(value: unknown, at: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new IrContractError(at, `expected one of ${JSON.stringify(allowed)}, got ${JSON.stringify(value)}`);
  }
  return value as T;
}

function array<T>(value: unknown, at: string, item: (v: unknown, at: string) => T): T[] {
  if (!Array.isArray(value)) throw new IrContractError(at, "expected an array");
  return value.map((v, i) => item(v, `${at}[${i}]`));
}
