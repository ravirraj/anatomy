// Lightweight in-memory Db adapter converting fixture parse results into
// the queryable schema expected by retrieveGroundedContext and packaging evidence.

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parseRepository } from "../lib/parser/index.ts";
import { PRIMARY_MANIFEST_NAMES } from "../lib/parser/screening.ts";
import { FIXTURES } from "./test-fixtures-shared.ts";
import type { Db } from "../lib/ai/retrieval.ts";

export type FixtureContext = {
  db: Db;
  analysisId: string;
  organizationId: string;
  repoDir: string;
  fileTexts: Map<string, string>;
};

export function createFixtureContext(fixtureName: string): FixtureContext {
  const repoDir = path.join(FIXTURES, fixtureName, "repo");
  if (!existsSync(repoDir)) {
    throw new Error(`Fixture directory not found: ${repoDir}`);
  }

  const analysisId = `analysis_${fixtureName}`;
  const organizationId = `org_${fixtureName}`;
  const parseResult = parseRepository(repoDir);

  const fileTexts = new Map<string, string>(); // path -> content
  const hashToText = new Map<string, string>(); // hash -> content

  // 1. Prepare code files
  const files: {
    id: string;
    path: string;
    module: string;
    lines: number;
    bytes: number;
    hash: string;
    fan_in: number;
    fan_out: number;
    content_status: "stored" | "absent" | "excluded";
    analysis_id: string;
    organization_id: string;
    file_roles?: { role: string | undefined; source: string }[];
  }[] = [];

  const fileIdByPath = new Map<string, string>();

  let idCounter = 1;
  for (const f of parseResult.files) {
    const fileId = `f_${idCounter++}`;
    fileIdByPath.set(f.path, fileId);

    const diskPath = path.join(repoDir, f.path);
    let text = "";
    if (existsSync(diskPath)) {
      text = readFileSync(diskPath, "utf8");
    }
    const hash = f.hash || createHash("sha256").update(text).digest("hex");
    fileTexts.set(f.path, text);
    hashToText.set(hash, text);

    files.push({
      id: fileId,
      path: f.path,
      module: f.module,
      lines: f.lines,
      bytes: f.bytes,
      hash,
      fan_in: f.fanIn ?? 0,
      fan_out: f.fanOut ?? 0,
      content_status: "stored",
      analysis_id: analysisId,
      organization_id: organizationId,
      file_roles: [{ role: f.role ?? undefined, source: "convention" }],
    });
  }

  // 2. Prepare non-code primary manifests
  const candidates = parseResult.nonCodeCandidates ?? [];
  for (const c of candidates) {
    const basename = path.basename(c.path);
    if (!PRIMARY_MANIFEST_NAMES.has(basename)) continue;

    const fileId = `f_${idCounter++}`;
    fileIdByPath.set(c.path, fileId);

    const hash = c.hash || createHash("sha256").update(c.content).digest("hex");
    fileTexts.set(c.path, c.content);
    hashToText.set(hash, c.content);

    files.push({
      id: fileId,
      path: c.path,
      module: c.module,
      lines: c.lines,
      bytes: c.bytes,
      hash,
      fan_in: 0,
      fan_out: 0,
      content_status: "stored",
      analysis_id: analysisId,
      organization_id: organizationId,
      // Non-code candidates carry no convention role (parseRepository only
      // assigns roles to parsed source files); kept explicit so the row
      // shape matches the code files above.
      file_roles: [{ role: undefined, source: "convention" }],
    });
  }

  // 3. Prepare symbols
  const symbols = parseResult.symbols.map((s) => ({
    file_id: fileIdByPath.get(s.file) ?? "unknown",
    name: s.name,
    kind: s.kind,
    line: s.line,
    exported: s.exported,
    analysis_id: analysisId,
  }));

  // 4. Prepare edges
  const edges = parseResult.edges.map((e) => ({
    source_file_id: fileIdByPath.get(e.source) ?? "unknown",
    target_file_id: fileIdByPath.get(e.target) ?? "unknown",
    kind: e.kind,
    analysis_id: analysisId,
  }));

  // 5. Prepare routes
  const routes = parseResult.routes.map((r) => ({
    file_id: fileIdByPath.get(r.file) ?? "unknown",
    method: r.method,
    path: r.pattern, // in ParseResult it is pattern, in DB column it is path
    line: r.line,
    analysis_id: analysisId,
  }));

  // 6. Packaging tables
  const manifests = parseResult.manifests.map((m) => ({
    path: m.path,
    dir: m.dir,
    ecosystem: m.ecosystem,
    name: m.name,
    workspaces: m.workspaces,
    scripts: m.scripts,
    problems: m.problems,
    analysis_id: analysisId,
  }));

  const dependencies = parseResult.dependencies.map((d) => ({
    name: d.name,
    version: d.version,
    kind: d.kind,
    manifest_path: d.manifest,
    dir: d.dir,
    imported_by: d.importedBy,
    analysis_id: analysisId,
  }));

  const configReferences = parseResult.configReferences.map((c) => ({
    file_path: c.file,
    variable: c.variable,
    line: c.line,
    kind: c.kind,
    detail: c.detail,
    analysis_id: analysisId,
  }));

  const entryPoints = parseResult.entryPoints.map((e) => ({
    path: e.path,
    kind: e.kind,
    source: e.source,
    manifest_path: e.manifest,
    detail: e.detail,
    resolved: e.resolved,
    unresolved_reason: e.unresolvedReason,
    via: e.via,
    analysis_id: analysisId,
  }));

  // 7. Mock Db implementation
  const db = {
    from(table: string) {
      if (table === "files") {
        return {
          select: () => {
            const queryState = {
              eqCol: "",
              eqVal: "",
              inCol: "",
              inVals: [] as string[],
            };
            const builder = {
              eq: (col: string, val: string) => {
                queryState.eqCol = col;
                queryState.eqVal = val;
                return builder;
              },
              in: (col: string, vals: string[]) => {
                queryState.inCol = col;
                queryState.inVals = vals;
                return builder;
              },
              is: () => {
                let res = files;
                if (queryState.eqCol === "analysis_id") {
                  res = res.filter((f) => f.analysis_id === queryState.eqVal);
                }
                if (queryState.inCol === "path") {
                  res = res.filter((f) => queryState.inVals.includes(f.path));
                }
                return Promise.resolve({ data: res, error: null });
              },
              maybeSingle: async () => {
                const found = files.find((f) =>
                  queryState.eqCol === "id" ? f.id === queryState.eqVal : queryState.eqCol === "hash" ? f.hash === queryState.eqVal : false,
                );
                return { data: found ?? null, error: null };
              },
              then: (resolve: (v: unknown) => void) => {
                let res = files;
                if (queryState.eqCol === "analysis_id") {
                  res = res.filter((f) => f.analysis_id === queryState.eqVal);
                }
                if (queryState.inCol === "path") {
                  res = res.filter((f) => queryState.inVals.includes(f.path));
                }
                resolve({ data: res, error: null });
              },
            };
            return builder;
          },
        };
      }
      if (table === "symbols") {
        return {
          select: () => ({
            eq: (col: string, val: string) =>
              Promise.resolve({
                data: col === "analysis_id" ? symbols.filter((s) => s.analysis_id === val) : symbols,
                error: null,
              }),
          }),
        };
      }
      if (table === "routes") {
        return {
          select: () => ({
            eq: (col: string, val: string) =>
              Promise.resolve({
                data: col === "analysis_id" ? routes.filter((r) => r.analysis_id === val) : routes,
                error: null,
              }),
          }),
        };
      }
      if (table === "edges") {
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              const visible = col === "analysis_id" ? edges.filter((e) => e.analysis_id === val) : edges;
              return {
                or: (orFilter: string) => {
                  const seedIds = new Set<string>();
                  for (const m of orFilter.matchAll(/in\.\(([^)]*)\)/g)) {
                    for (const id of (m[1] ?? "").split(",")) {
                      if (id.trim()) seedIds.add(id.trim());
                    }
                  }
                  const filtered = visible.filter(
                    (edge) => seedIds.has(edge.source_file_id) || seedIds.has(edge.target_file_id),
                  );
                  return Promise.resolve({ data: filtered, error: null });
                },
              };
            },
          }),
        };
      }
      if (table === "file_contents") {
        return {
          select: () => ({
            eq: () => ({
              eq: (_col2: string, hash: string) => ({
                maybeSingle: async () => {
                  const text = hashToText.get(hash);
                  if (text === undefined) return { data: null, error: null };
                  return {
                    data: {
                      payload: `\\x${Buffer.from(text, "utf8").toString("hex")}`,
                      size: Buffer.byteLength(text, "utf8"),
                    },
                    error: null,
                  };
                },
              }),
            }),
          }),
        };
      }
      if (table === "manifests") {
        return {
          select: () => ({
            eq: (col: string, val: string) =>
              Promise.resolve({
                data: col === "analysis_id" ? manifests.filter((m) => m.analysis_id === val) : manifests,
                error: null,
              }),
          }),
        };
      }
      if (table === "dependencies") {
        return {
          select: () => ({
            eq: (col: string, val: string) =>
              Promise.resolve({
                data: col === "analysis_id" ? dependencies.filter((d) => d.analysis_id === val) : dependencies,
                error: null,
              }),
          }),
        };
      }
      if (table === "config_references") {
        return {
          select: () => ({
            eq: (col: string, val: string) =>
              Promise.resolve({
                data: col === "analysis_id" ? configReferences.filter((c) => c.analysis_id === val) : configReferences,
                error: null,
              }),
          }),
        };
      }
      if (table === "entry_points") {
        return {
          select: () => ({
            eq: (col: string, val: string) =>
              Promise.resolve({
                data: col === "analysis_id" ? entryPoints.filter((e) => e.analysis_id === val) : entryPoints,
                error: null,
              }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table} in FixtureDb`);
    },
  } as unknown as Db;

  return {
    db,
    analysisId,
    organizationId,
    repoDir,
    fileTexts,
  };
}
