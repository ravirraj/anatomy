import type { Db } from "../retrieval.ts";
import type { DiscoveryInput } from "./discovery.ts";
import { buildConceptIndex } from "./discovery.ts";
import type { ConceptIndex } from "./types.ts";

/**
 * Builds a ConceptIndex from a stored analysis. Returns null when the
 * analysis has no indexed files (so callers can fall back to the lexical
 * planner / hardcoded coverage).
 *
 * Loads only the already-indexed rows (files + roles, symbols, routes, edges)
 * and never re-reads source content. Organization isolation is preserved
 * because every query is filtered by analysis_id (and edges by the analysis's
 * file set).
 */
export async function buildConceptIndexForAnalysis(
  db: Db,
  analysisId: string,
): Promise<ConceptIndex | null> {
  const { data: filesData, error: filesError } = await db
    .from("files")
    .select("id, path, file_roles(role, source)")
    .eq("analysis_id", analysisId)
    .is("skip_reason", null);
  if (filesError) throw new Error(`loading files for concept index failed: ${filesError.message}`);

  const files: DiscoveryInput["files"] = [];
  const fileIds: string[] = [];
  for (const f of filesData ?? []) {
    const role = f.file_roles?.[0]?.role ?? null;
    files.push({ id: f.id, path: f.path, role });
    fileIds.push(f.id);
  }
  if (files.length === 0) return null;

  const { data: symbolsData, error: symbolsError } = await db
    .from("symbols")
    .select("file_id, name, kind, exported")
    .eq("analysis_id", analysisId);
  if (symbolsError) throw new Error(`loading symbols for concept index failed: ${symbolsError.message}`);

  const symbols: DiscoveryInput["symbols"] = (symbolsData ?? []).map((s) => ({
    fileId: s.file_id,
    name: s.name,
    kind: s.kind,
    exported: s.exported ?? false,
  }));

  const { data: routesData, error: routesError } = await db
    .from("routes")
    .select("file_id, method, path")
    .eq("analysis_id", analysisId);
  if (routesError) throw new Error(`loading routes for concept index failed: ${routesError.message}`);

  const routes: DiscoveryInput["routes"] = (routesData ?? []).map((r) => ({
    fileId: r.file_id,
    pattern: r.path,
    method: r.method,
  }));

  // Edges: load all edges touching this analysis's files.
  let edges: DiscoveryInput["edges"] = [];
  if (fileIds.length > 0) {
    const idList = fileIds.join(",");
    const { data: edgesData, error: edgesError } = await db
      .from("edges")
      .select("source_file_id, target_file_id")
      .eq("analysis_id", analysisId)
      .or(`source_file_id.in.(${idList}),target_file_id.in.(${idList})`);
    if (edgesError) throw new Error(`loading edges for concept index failed: ${edgesError.message}`);
    edges = (edgesData ?? []).map((e) => ({
      sourceFileId: e.source_file_id,
      targetFileId: e.target_file_id,
    }));
  }

  return buildConceptIndex({ analysisId, files, symbols, routes, edges });
}
