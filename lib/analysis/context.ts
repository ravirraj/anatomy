import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClassifyInput, FileInput, FolderFile, FolderInput, NeighbourFacts } from "../ai/prompts.ts";
import { foldDirectories } from "../graph/fold.ts";
import { EDGE_KINDS, type EdgeKind } from "../parser/types.ts";
import type { Database } from "../supabase/database.types.ts";
import { readAll } from "./load.ts";

type Db = SupabaseClient<Database>;

// What the model is handed, read from the stored analysis and nowhere else.
// The browser names a file or folder; which files are its neighbours is read
// here from the edges the parser stored, never taken from the request. Reads
// go through the caller's client, so the policies decide what comes back.

export type StoredFile = { id: string; path: string; hash: string; conventionRole: boolean };

export async function loadFileInput(
  db: Db,
  analysisId: string,
  path: string,
): Promise<{ file: StoredFile; input: FileInput; classify: ClassifyInput } | null> {
  const { data: file, error } = await db
    .from("files")
    .select("id, path, hash, exports, reached_by, skip_reason, content_status, file_roles(role, source)")
    .eq("analysis_id", analysisId)
    .eq("path", path)
    .maybeSingle();
  if (error) throw new Error(`Reading ${path} failed: ${error.message}`);
  if (!file) return null;
  if (file.skip_reason !== null || file.hash === null || file.exports === null) {
    throw new Error(`${path} was skipped by the parser, so there's nothing parsed to explain`);
  }
  // CI-4 gate, ahead of everything else in the caller: quarantined content is
  // never explainable evidence, so this must throw before a cached
  // classification or cached explanation can be served for the target.
  if (file.content_status === "excluded" || file.content_status === "legacy_unclassified") {
    throw new Error(`${path} is excluded in this analysis, so there's no content to explain`);
  }

  const edges = await readAll((from, to) =>
    db
      .from("edges")
      .select(
        "id, kind, type_only, source_file_id, target_file_id, source:files!edges_source_file_id_organization_id_fkey(path, exports, content_status, file_roles(role, source)), target:files!edges_target_file_id_organization_id_fkey(path, exports, content_status, file_roles(role, source))",
      )
      .eq("analysis_id", analysisId)
      .or(`source_file_id.eq.${file.id},target_file_id.eq.${file.id}`)
      .order("id")
      .range(from, to),
  );

  const imports = new Map<string, NeighbourFacts>();
  const importedBy = new Map<string, NeighbourFacts>();
  for (const e of edges) {
    const outgoing = e.source_file_id === file.id;
    const other = outgoing ? e.target : e.source;
    if (!other) throw new Error(`An edge of ${path} points at a file that isn't stored`);
    // Quarantined neighbours are filtered out of the input here so they can
    // never reach imports/importedBy and, through it, fileCitationsAllowed.
    // Stored and absent neighbours pass unchanged.
    if (other.content_status === "excluded" || other.content_status === "legacy_unclassified") continue;
    // A file importing itself would sit in both lists; the parser's own
    // counts include it that way too.
    if (outgoing) add(imports, other, e.kind, e.type_only);
    if (e.target_file_id === file.id) add(importedBy, other, e.kind, e.type_only);
  }

  const role = file.file_roles[0] ?? null;
  const input: FileInput = {
    path: file.path,
    hash: file.hash,
    role: role?.role ?? null,
    reachedBy: file.reached_by,
    exports: file.exports,
    imports: sorted(imports),
    importedBy: sorted(importedBy),
  };
  const classify: ClassifyInput = {
    path: file.path,
    hash: file.hash,
    exports: file.exports,
    imports: input.imports.map((n) => ({ path: n.path, role: n.role })),
    importedBy: input.importedBy.map((n) => ({ path: n.path, role: n.role })),
  };
  return { file: { id: file.id, path: file.path, hash: file.hash, conventionRole: role?.source === "convention" }, input, classify };
}

// Citation claims a question may satisfy outside the evidence actually read:
// paths of files this analysis holds that were parsed, belong to the asking
// analysis's scope, and whose content is field-trusted — `stored`. Excluded
// and legacy-unclassified paths never appear here, and an `absent` path is
// not eligible either: it can only become citable by a successful authorized
// backfill that puts it in the answer's evidence map. The join runs against
// db under the caller's policies, so another organization's analysis is not
// in the set.
export async function allowedAnalysisPaths(db: Db, analysisId: string): Promise<Set<string>> {
  const { data, error } = await db
    .from("files")
    .select("path")
    .eq("analysis_id", analysisId)
    .is("skip_reason", null)
    .eq("content_status", "stored");
  if (error) throw new Error(`Reading the citation allowlist failed: ${error.message}`);
  return new Set((data ?? []).map((f) => f.path));
}
export async function loadFolderInput(db: Db, analysisId: string, dir: string): Promise<FolderInput | null> {
  const rows = await readAll((from, to) =>
    db
      .from("files")
      .select("id, path, module, hash, exports, fan_in, fan_out, content_status, file_roles(role, source)")
      .eq("analysis_id", analysisId)
      .is("skip_reason", null)
      .order("id")
      .range(from, to),
  );
  const files = rows.map((r) => {
    if (r.module === null || r.hash === null || r.exports === null || r.fan_in === null || r.fan_out === null) {
      throw new Error(`Stored parsed file ${r.path} is missing its measurements`);
    }
    return { ...r, module: r.module, hash: r.hash, exports: r.exports, fan_in: r.fan_in, fan_out: r.fan_out };
  });
  // CI-4: quarantined files are not explainable evidence. Removing them here
  // keeps them out of the folder's grouping, its members and — through the
  // endpoint check below — its boundary-edge metadata, which is exactly what
  // folderCitationsAllowed is built from. The underlying graph rows and the
  // stored fan-in/fan-out measurements are never touched.
  const isQuarantined = (id: string): boolean => {
    const status = files.find((f) => f.id === id)?.content_status;
    return status === "excluded" || status === "legacy_unclassified";
  };
  const eligible = files.filter((f) => !(f.content_status === "excluded" || f.content_status === "legacy_unclassified"));
  const group = foldDirectories(eligible).groups.find((g) => g.dir === dir);
  if (!group) return null;

  const inside = new Set(group.files);
  const pathOf = new Map(files.map((f) => [f.id, f.path]));
  const edges = await readAll((from, to) =>
    db.from("edges").select("id, source_file_id, target_file_id").eq("analysis_id", analysisId).order("id").range(from, to),
  );
  const incoming = new Map<string, { from: string; to: string }>();
  const outgoing = new Map<string, { from: string; to: string }>();
  for (const e of edges) {
    // Quarantined endpoints are excluded from the boundary metadata before
    // resolution, so a quarantined file is not misread as a corrupt edge;
    // genuinely unknown ids below still throw as before.
    if (isQuarantined(e.source_file_id) || isQuarantined(e.target_file_id)) continue;
    const source = pathOf.get(e.source_file_id);
    const target = pathOf.get(e.target_file_id);
    if (source === undefined || target === undefined) throw new Error("A stored edge points at a file that isn't a stored parsed file");
    if (!inside.has(source) && inside.has(target)) incoming.set(`${source}\0${target}`, { from: source, to: target });
    if (inside.has(source) && !inside.has(target)) outgoing.set(`${source}\0${target}`, { from: source, to: target });
  }

  const byPath = new Map(eligible.map((f) => [f.path, f]));
  const members: FolderFile[] = group.files.map((p) => {
    const f = byPath.get(p);
    if (!f) throw new Error(`Folded file ${p} isn't in the file list it was folded from`);
    return { path: f.path, hash: f.hash, role: conventionRole(f.file_roles), exports: f.exports, fanIn: f.fan_in, fanOut: f.fan_out };
  });
  const order = (a: { from: string; to: string }, b: { from: string; to: string }) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
  return { dir, files: members, incoming: [...incoming.values()].sort(order), outgoing: [...outgoing.values()].sort(order) };
}

type RoleRow = { role: string; source: string };
type Other = { path: string; exports: string[] | null; content_status: string; file_roles: RoleRow[] };

// Other files' roles go to the model only when convention gave them. A label
// the model gave one file later would otherwise change every neighbour's and
// folder's question, and throw away their cached answers for nothing the
// parser found.
function conventionRole(rows: RoleRow[]): string | null {
  const row = rows[0];
  return row?.source === "convention" ? row.role : null;
}

function add(into: Map<string, NeighbourFacts>, other: Other, kind: string, typeOnly: boolean): void {
  if (!isEdgeKind(kind)) throw new Error(`Stored edge kind "${kind}" isn't one the parser produces`);
  const existing = into.get(other.path);
  if (!existing) {
    into.set(other.path, { path: other.path, role: conventionRole(other.file_roles), exports: other.exports ?? [], kinds: [kind], typeOnly });
    return;
  }
  if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
  existing.typeOnly &&= typeOnly;
}

function sorted(map: Map<string, NeighbourFacts>): NeighbourFacts[] {
  return [...map.values()]
    .map((n) => ({ ...n, kinds: EDGE_KINDS.filter((k) => n.kinds.includes(k)) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function isEdgeKind(kind: string): kind is EdgeKind {
  return (EDGE_KINDS as readonly string[]).includes(kind);
}
