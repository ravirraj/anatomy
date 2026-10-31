/**
 * Repository-adaptive concept discovery engine (Phase 2).
 *
 * Builds a ConceptIndex from the already-indexed repository data:
 *   - file paths and directory structure  → path-exact, directory-exact evidence
 *   - symbol names + identifier subtokens  → symbol-exact evidence
 *   - routes and API patterns             → route-exact evidence
 *   - import graph edges                  → cluster-membership + relationships
 *
 * No hardcoded feature names, no hardcoded synonyms, no schema migrations.
 * The index is deterministic: given the same analysisId and the same
 * indexed rows, the same ConceptIndex is produced every time.
 *
 * Algorithm summary:
 *   1. Collect all identifier tokens from symbols, routes, file paths.
 *   2. Score each token by its frequency and breadth of signal sources.
 *   3. Cluster tokens that co-occur in the same files (union-find style).
 *   4. Name each cluster after its highest-scoring term.
 *   5. Prune clusters with insufficient evidence.
 *   6. Derive inter-concept relationships from the edge table.
 *   7. Build inverted indexes for O(1) lookup.
 */

import { createHash } from "node:crypto";
import { identifierSubtokens } from "../retrieval.ts";
import type {
  ConceptEvidence,
  ConceptEvidenceKind,
  ConceptId,
  ConceptIndex,
  ConceptRelationship,
  RepositoryConcept,
} from "./types.ts";

// ── Inputs ────────────────────────────────────────────────────────────────────

export type DiscoveryFile = {
  id: string;
  path: string;
  /** Architectural role assigned by the parser/convention (may be null). */
  role: string | null;
};

export type DiscoverySymbol = {
  fileId: string;
  name: string;
  kind: string;
  exported: boolean;
};

export type DiscoveryRoute = {
  fileId: string;
  /** e.g. "/api/auth/login" */
  pattern: string;
  method: string;
};

export type DiscoveryEdge = {
  sourceFileId: string;
  targetFileId: string;
};

export type DiscoveryInput = {
  analysisId: string;
  files: DiscoveryFile[];
  symbols: DiscoverySymbol[];
  routes: DiscoveryRoute[];
  edges: DiscoveryEdge[];
};

// ── Stop tokens: generic words that appear everywhere and carry no domain
// signal. We do NOT add SDK-specific or feature-specific words here: only
// words that are purely structural in any identifier or path.
const DISCOVERY_STOP_TOKENS = new Set([
  "index", "main", "app", "root", "base", "core", "common", "shared",
  "utils", "util", "helper", "helpers", "lib", "libs", "src", "dist",
  "types", "type", "interface", "class", "service", "module",
  "test", "tests", "spec", "specs", "mock", "mocks",
  "file", "files", "path", "paths",
  // Generic TS/JS scaffold words
  "default", "export", "exports", "import", "imports",
  "create", "get", "set", "update", "delete", "remove", "add",
  "init", "initialize", "start", "stop", "run", "build",
  "config", "configuration", "env", "environment",
  "error", "errors", "exception", "handler",
  // Single-character and very short tokens
]);

/** Minimum token length to be treated as a domain concept. */
const MIN_TOKEN_LEN = 3;

/**
 * Minimum number of distinct files a concept must span to survive pruning.
 * A concept supported by only one file and only one evidence kind is likely
 * a file-naming artifact, not a real domain concept.
 */
const MIN_FILES_FOR_CONCEPT = 2;

/**
 * Maximum number of concepts emitted. Prevents extremely fragmented
 * repositories from producing hundreds of one-file micro-concepts.
 */
const MAX_CONCEPTS = 60;

// ── Deterministic concept ID ──────────────────────────────────────────────────

/**
 * Derives a stable concept ID from the analysisId and the concept's
 * normalized name. The ID is collision-resistant (SHA-256 truncated to
 * 12 hex chars) and fully deterministic.
 */
export function conceptId(analysisId: string, normalizedName: string): ConceptId {
  const digest = createHash("sha256")
    .update(`${analysisId}:${normalizedName}`)
    .digest("hex")
    .slice(0, 12);
  return `cncpt:${digest}:${normalizedName}`;
}

// ── Token collection ─────────────────────────────────────────────────────────

type TokenSource = {
  kind: ConceptEvidenceKind;
  fileId: string;
  filePath: string;
  matchedTerm: string;
};

/**
 * Extracts domain tokens from path segments, filtering out generic scaffolding
 * names and very short tokens. Returns each segment together with its kind.
 */
function pathTokens(path: string, fileId: string): TokenSource[] {
  const parts = path
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")   // strip extension
    .split(/[/\\]/)
    .filter(Boolean);

  const out: TokenSource[] = [];
  const seenTerms = new Set<string>();

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const isFilename = i === parts.length - 1;
    const kind: ConceptEvidenceKind = isFilename ? "path-exact" : "directory-exact";

    // Split the part into subtokens (handles kebab-case, snake_case)
    const subtokens = identifierSubtokens(part);
    for (const tok of subtokens) {
      if (tok.length < MIN_TOKEN_LEN) continue;
      if (DISCOVERY_STOP_TOKENS.has(tok)) continue;
      if (seenTerms.has(tok)) continue;
      seenTerms.add(tok);
      out.push({ kind, fileId, filePath: path, matchedTerm: tok });
    }

    // Also include the whole part if it is meaningfully long and not a stop
    if (part.length >= MIN_TOKEN_LEN && !DISCOVERY_STOP_TOKENS.has(part) && !seenTerms.has(part)) {
      seenTerms.add(part);
      out.push({ kind, fileId, filePath: path, matchedTerm: part });
    }
  }

  return out;
}

/**
 * Extracts domain tokens from a symbol name using identifier subtokens.
 */
function symbolTokens(sym: DiscoverySymbol, filePath: string): TokenSource[] {
  const subtokens = identifierSubtokens(sym.name);
  const out: TokenSource[] = [];
  const seen = new Set<string>();
  for (const tok of subtokens) {
    if (tok.length < MIN_TOKEN_LEN) continue;
    if (DISCOVERY_STOP_TOKENS.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push({ kind: "symbol-exact", fileId: sym.fileId, filePath, matchedTerm: tok });
  }
  // If the symbol name itself (lowercased) is a good domain term, include it
  const nameLower = sym.name.toLowerCase();
  if (nameLower.length >= MIN_TOKEN_LEN && !DISCOVERY_STOP_TOKENS.has(nameLower) && !seen.has(nameLower)) {
    out.push({ kind: "symbol-exact", fileId: sym.fileId, filePath, matchedTerm: nameLower });
  }
  return out;
}

/**
 * Extracts domain tokens from a route pattern.
 * "/api/auth/login" → ["api", "auth", "login"]
 */
function routeTokens(route: DiscoveryRoute, filePath: string): TokenSource[] {
  const segments = route.pattern
    .toLowerCase()
    .split(/[/\-_]/)
    .map((s) => s.replace(/[^a-z0-9]/g, ""))
    .filter((s) => s.length >= MIN_TOKEN_LEN && !DISCOVERY_STOP_TOKENS.has(s));
  return segments.map((seg) => ({
    kind: "route-exact" as const,
    fileId: route.fileId,
    filePath,
    matchedTerm: seg,
  }));
}

// ── Clustering ────────────────────────────────────────────────────────────────

/**
 * Groups raw token sources into domain concepts using a term-frequency
 * co-occurrence approach:
 *
 * 1. Build a map: term → {fileIds, sources[]}
 * 2. For each term, find all other terms that appear in ≥ MIN_COOCCURRENCE
 *    of the same files → these terms describe the same concept.
 * 3. Union-find: merge terms that share many files.
 * 4. Each component becomes one concept, named by its most-frequent term.
 *
 * This is intentionally simple and fast: no LLM, no vector DB, no embedding.
 */
const MIN_COOCCURRENCE = 2; // terms must share ≥ 2 files to be merged

type TermData = {
  term: string;
  fileIds: Set<string>;
  sources: TokenSource[];
};

function clusterTerms(
  termMap: Map<string, TermData>,
): Map<string, Set<string>> {
  // Union-Find
  const parent = new Map<string, string>();
  const terms = [...termMap.keys()];

  function find(t: string): string {
    let root = t;
    while (parent.get(root) !== undefined) root = parent.get(root)!;
    // Path compression
    let cur = t;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  }

  // Merge terms that share ≥ MIN_COOCCURRENCE files
  for (let i = 0; i < terms.length; i++) {
    const a = terms[i]!;
    const dataA = termMap.get(a)!;
    for (let j = i + 1; j < terms.length; j++) {
      const b = terms[j]!;
      const dataB = termMap.get(b)!;
      // Count shared files
      let shared = 0;
      for (const fid of dataA.fileIds) {
        if (dataB.fileIds.has(fid)) {
          shared++;
          if (shared >= MIN_COOCCURRENCE) break;
        }
      }
      if (shared >= MIN_COOCCURRENCE) {
        union(a, b);
      }
    }
  }

  // Build clusters: root → set of member terms
  const clusters = new Map<string, Set<string>>();
  for (const t of terms) {
    const root = find(t);
    if (!clusters.has(root)) clusters.set(root, new Set());
    clusters.get(root)!.add(t);
  }

  return clusters;
}

// ── Confidence scoring ────────────────────────────────────────────────────────

const EVIDENCE_KIND_WEIGHT: Record<ConceptEvidenceKind, number> = {
  "symbol-exact": 1.0,
  "route-exact": 0.9,
  "path-exact": 0.7,
  "directory-exact": 0.5,
  "source-cooccurrence": 0.8,
  "cluster-membership": 0.3,
};

function scoreEvidence(sources: TokenSource[]): number {
  const fileIds = new Set(sources.map((s) => s.fileId));
  const kindSet = new Set(sources.map((s) => s.kind));

  // Base: number of files (spread breadth)
  const fileFactor = Math.min(1.0, fileIds.size / 10);

  // Kind factor: the highest-weight kind present
  let kindFactor = 0;
  for (const k of kindSet) kindFactor = Math.max(kindFactor, EVIDENCE_KIND_WEIGHT[k]);

  // Diversity: how many distinct evidence kinds support this concept
  const diversity = Math.min(1.0, kindSet.size / 4);

  return fileFactor * 0.5 + kindFactor * 0.3 + diversity * 0.2;
}

// ── Relationship derivation ───────────────────────────────────────────────────

function deriveRelationships(
  concepts: RepositoryConcept[],
  edges: DiscoveryEdge[],
): ConceptRelationship[] {
  const fileIdToConcept = new Map<string, string[]>();
  for (const c of concepts) {
    for (const fid of c.fileIds) {
      const list = fileIdToConcept.get(fid) ?? [];
      list.push(c.id);
      fileIdToConcept.set(fid, list);
    }
  }

  const relationships: ConceptRelationship[] = [];
  const seen = new Set<string>();

  // Indexed: real edges between concept files
  for (const edge of edges) {
    const fromConcepts = fileIdToConcept.get(edge.sourceFileId) ?? [];
    const toConcepts = fileIdToConcept.get(edge.targetFileId) ?? [];
    for (const fromId of fromConcepts) {
      for (const toId of toConcepts) {
        if (fromId === toId) continue;
        const key = `${fromId}→${toId}`;
        if (seen.has(key)) {
          // Increment weight
          const existing = relationships.find(
            (r) => r.fromId === fromId && r.toId === toId && r.kind === "imports",
          );
          if (existing) existing.weight++;
          continue;
        }
        seen.add(key);
        relationships.push({
          fromId,
          toId,
          kind: "imports",
          provenance: "indexed",
          weight: 1,
        });
      }
    }
  }

  // Derived: shared directory (co-location)
  const conceptByDir = new Map<string, Set<string>>();
  for (const c of concepts) {
    for (const fp of c.filePaths) {
      const slash = fp.lastIndexOf("/");
      const dir = slash === -1 ? "" : fp.slice(0, slash);
      if (!conceptByDir.has(dir)) conceptByDir.set(dir, new Set());
      conceptByDir.get(dir)!.add(c.id);
    }
  }
  for (const [, ids] of conceptByDir) {
    if (ids.size < 2) continue;
    const arr = [...ids];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = `coloc:${arr[i]}↔${arr[j]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        relationships.push({
          fromId: arr[i]!,
          toId: arr[j]!,
          kind: "co-located",
          provenance: "derived",
          weight: 1,
        });
      }
    }
  }

  // Shared files
  const conceptToFileSet = new Map<string, Set<string>>();
  for (const c of concepts) conceptToFileSet.set(c.id, new Set(c.fileIds));
  for (let i = 0; i < concepts.length; i++) {
    for (let j = i + 1; j < concepts.length; j++) {
      const a = concepts[i]!;
      const b = concepts[j]!;
      let shared = 0;
      for (const fid of (conceptToFileSet.get(a.id) ?? new Set())) {
        if (conceptToFileSet.get(b.id)?.has(fid)) shared++;
      }
      if (shared >= 1) {
        const key = `shared:${a.id}↔${b.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          relationships.push({
            fromId: a.id,
            toId: b.id,
            kind: "shares-files",
            provenance: "derived",
            weight: shared,
          });
        }
      }
    }
  }

  return relationships;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Builds a ConceptIndex from the repository's indexed data.
 *
 * This is the ONLY function that needs access to the analysis data; the
 * resulting ConceptIndex is then passed to matchConceptsForQuery() and the
 * retrieval/coverage integrations.
 *
 * Runtime: O(F * S) where F = number of files and S = symbols per file.
 * Typical repositories (<2000 files): < 50 ms.
 */
export function buildConceptIndex(input: DiscoveryInput): ConceptIndex {
  const t0 = performance.now();
  const { analysisId, files, symbols, routes, edges } = input;

  // Build lookup tables
  const fileById = new Map(files.map((f) => [f.id, f]));
  const fileByPath = new Map(files.map((f) => [f.path, f]));

  // ── Step 1: Collect all domain token sources ───────────────────────────────
  const termMap = new Map<string, TermData>();

  const addSource = (src: TokenSource) => {
    const existing = termMap.get(src.matchedTerm);
    if (existing) {
      existing.fileIds.add(src.fileId);
      existing.sources.push(src);
    } else {
      termMap.set(src.matchedTerm, {
        term: src.matchedTerm,
        fileIds: new Set([src.fileId]),
        sources: [src],
      });
    }
  };

  // File paths and directories
  for (const file of files) {
    for (const src of pathTokens(file.path, file.id)) {
      addSource(src);
    }
  }

  // Symbols
  for (const sym of symbols) {
    const file = fileById.get(sym.fileId);
    if (!file) continue;
    for (const src of symbolTokens(sym, file.path)) {
      addSource(src);
    }
  }

  // Routes
  for (const route of routes) {
    const file = fileById.get(route.fileId);
    if (!file) continue;
    for (const src of routeTokens(route, file.path)) {
      addSource(src);
    }
  }

  // ── Step 2: Prune terms that appear in only one file ──────────────────────
  // (They cannot cluster with anything and are likely file-specific artifacts.)
  for (const [term, data] of termMap) {
    if (data.fileIds.size < MIN_FILES_FOR_CONCEPT) {
      termMap.delete(term);
    }
  }

  // ── Step 3: Cluster terms by file co-occurrence ────────────────────────────
  const clusters = clusterTerms(termMap);

  // ── Step 4: Build one concept per cluster ─────────────────────────────────
  const rawConcepts: Array<{
    terms: string[];
    fileIds: Set<string>;
    sources: TokenSource[];
    confidence: number;
  }> = [];

  for (const [, memberTerms] of clusters) {
    const allSources: TokenSource[] = [];
    const allFileIds = new Set<string>();
    for (const term of memberTerms) {
      const data = termMap.get(term);
      if (!data) continue;
      for (const src of data.sources) {
        allSources.push(src);
        allFileIds.add(src.fileId);
      }
    }

    if (allFileIds.size < MIN_FILES_FOR_CONCEPT) continue;

    const confidence = scoreEvidence(allSources);
    rawConcepts.push({
      terms: [...memberTerms],
      fileIds: allFileIds,
      sources: allSources,
      confidence,
    });
  }

  // ── Step 5: Sort by confidence, cap at MAX_CONCEPTS ───────────────────────
  rawConcepts.sort((a, b) => b.confidence - a.confidence || a.terms[0]!.localeCompare(b.terms[0]!));
  const topConcepts = rawConcepts.slice(0, MAX_CONCEPTS);

  // ── Step 6: Build RepositoryConcept objects ────────────────────────────────
  const builtConcepts: RepositoryConcept[] = topConcepts.map((raw) => {
    // Pick the display name: the term with the most sources (highest frequency)
    const termFreq = new Map<string, number>();
    for (const src of raw.sources) {
      termFreq.set(src.matchedTerm, (termFreq.get(src.matchedTerm) ?? 0) + 1);
    }
    const normalizedTerms = [...termFreq.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t]) => t);
    const displayName = normalizedTerms[0] ?? "unknown";

    // File ordering: sort files by how many evidence sources they have for this concept
    const fileEvidence = new Map<string, TokenSource[]>();
    for (const src of raw.sources) {
      const list = fileEvidence.get(src.fileId) ?? [];
      list.push(src);
      fileEvidence.set(src.fileId, list);
    }
    const orderedFileIds = [...raw.fileIds].sort(
      (a, b) => (fileEvidence.get(b)?.length ?? 0) - (fileEvidence.get(a)?.length ?? 0),
    );

    // Build evidence objects
    const evidence: ConceptEvidence[] = [];
    for (const src of raw.sources) {
      evidence.push({
        kind: src.kind,
        filePath: src.filePath,
        matchedTerm: src.matchedTerm,
        provenance: src.kind === "cluster-membership" ? "indexed" : "direct",
      });
    }

    // Discovered categories: architectural roles from the concept's files
    const discoveredCategories = new Set<string>();
    for (const fid of raw.fileIds) {
      const file = fileById.get(fid);
      if (file?.role) discoveredCategories.add(file.role);
    }

    return {
      id: conceptId(analysisId, displayName),
      displayName,
      normalizedTerms,
      fileIds: orderedFileIds,
      filePaths: orderedFileIds.map((fid) => fileById.get(fid)?.path ?? ""),
      evidence,
      confidence: raw.confidence,
      discoveredCategories: [...discoveredCategories],
      relationships: [], // filled in next step
    };
  });

  // ── Step 7: Derive inter-concept relationships ─────────────────────────────
  const allRelationships = deriveRelationships(builtConcepts, edges);
  const relsByConceptId = new Map<string, ConceptRelationship[]>();
  for (const rel of allRelationships) {
    for (const id of [rel.fromId, rel.toId]) {
      const list = relsByConceptId.get(id) ?? [];
      list.push(rel);
      relsByConceptId.set(id, list);
    }
  }
  for (const c of builtConcepts) {
    c.relationships = relsByConceptId.get(c.id) ?? [];
  }

  // ── Step 8: Build inverted indexes ────────────────────────────────────────
  const fileIdToConcepts = new Map<string, ConceptId[]>();
  const termToConcepts = new Map<string, ConceptId[]>();

  for (const c of builtConcepts) {
    for (const fid of c.fileIds) {
      const list = fileIdToConcepts.get(fid) ?? [];
      list.push(c.id);
      fileIdToConcepts.set(fid, list);
    }
    for (const term of c.normalizedTerms) {
      const list = termToConcepts.get(term) ?? [];
      list.push(c.id);
      termToConcepts.set(term, list);
    }
  }

  const buildMs = Math.round(performance.now() - t0);

  return {
    analysisId,
    concepts: builtConcepts,
    fileIdToConcepts,
    termToConcepts,
    buildMs,
  };
}
