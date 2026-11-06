/**
 * Deterministic coverage evaluation (Phase 5 of the coverage-driven Q&A
 * plan). Consumes a QuestionPlan (lib/ai/planner.ts) and the final
 * retrieved evidence package (lib/ai/retrieval.ts) and judges, for every
 * expected evidence category, how firmly the retrieved source grounds it.
 *
 * The rules this module obeys:
 *  - found means actual source evidence: a retrieved window's *text* (the
 *    hash-verified content read by the pipeline) contains one of the
 *    concept's vocabulary variants. A matching file or directory name
 *    alone can never produce found.
 *  - partial means relevant material exists (a category-affiliated file
 *    was retrieved, symbol names echo the concept, or relationship
 *    evidence connects such files) but the behaviour is not fully
 *    established by the retrieved text.
 *  - unknown means the retrieved evidence does not establish the
 *    category. Unknown is epistemic: it is never proof that a feature
 *    does not exist (UNKNOWN_NOTE carries this semantics).
 *  - Every evaluation is explainable: each category reports which files,
 *    lines, provenance and signal supported its status.
 *  - Everything here is pure deterministic code — no LLM involved.
 */

import type { QuestionPlan } from "./planner.ts";
import type { RetrievalResult, RetrievedWindow } from "./retrieval.ts";
import type { ConceptIndex, QuestionConceptMapping } from "./concepts/types.ts";

export type CoverageStatus = "found" | "partial" | "unknown";

/**
 * Signal strength for one piece of evidence, strongest first:
 *  - source-text: a concept variant occurs in the window's verified text
 *  - symbol-name: the window's reason records a symbol whose *name* echoes
 *    the concept (parser-aggregated by the ingestion, not a filename)
 *  - relationship-indexed / relationship-derived: the window arrived
 *    through graph expansion or derivation, carrying category affiliation
 *    but no concept-level textual hit in the retrieved slice
 *  - filename-or-role: only the file's path or labelled role aligns
 */
export type EvidenceSignal =
  | "source-text"
  | "symbol-name"
  | "relationship-indexed"
  | "relationship-derived"
  | "filename-or-role";

export type EvidenceProvenance = "direct" | "indexed" | "derived";

export type CoverageEvidence = {
  path: string;
  startLine: number;
  endLine: number;
  provenance: EvidenceProvenance;
  signal: EvidenceSignal;
  matchedVariant?: string;
};

export type CategoryCoverage = {
  category: string;
  status: CoverageStatus;
  /** Explainability: which files and signals produce this status. */
  reason: string;
  evidence: CoverageEvidence[];
};

export type ConceptCoverage = {
  token: string;
  categories: CategoryCoverage[];
};

export type CoverageEvaluation = {
  query: string;
  concepts: ConceptCoverage[];
  /** Counts across every evaluated (concept, category) pair. */
  summary: { found: number; partial: number; unknown: number };
  /** Fixed semantics of unknown (see requirement: absence is not proof). */
  unknownNote: string;
};

/**
 * Where each planner category is expected to live. Deliberately coarse and
 * repo-agnostic: affiliation is checked as whole path segments (never
 * substrings, so "sessions" does not affiliate with "session"…) plus the
 * architectural role the retrieval reasons carry.
 */
export const CATEGORY_AFFILIATION: Record<string, { segments: string[]; roles: string[] }> = {
  controllers: { segments: ["controllers", "controller"], roles: ["controller"] },
  middleware: { segments: ["middlewares", "middleware"], roles: ["middleware"] },
  models: { segments: ["models", "model"], roles: ["model"] },
  services: { segments: ["services", "service"], roles: ["service"] },
  config: { segments: ["config", "configs", "configuration", "settings", "env"], roles: ["config"] },
  // Role lists hold roles the parser produces (lib/roles.ts) plus the values
  // legacy stored analyses may still carry ("route", "frontend", "cli") —
  // kept for older analyses, never produced by the current parser.
  routes: { segments: ["routes", "routers", "route"], roles: ["router", "page-route", "api-endpoint", "route"] },
  frontend: {
    segments: ["frontend", "components", "pages", "hooks", "store", "views", "screens", "ui", "client"],
    roles: ["component", "hook", "layout", "route-ui", "frontend"],
  },
  cli: {
    segments: ["cli", "bin", "commands", "cmd"],
    // No CLI role exists in the taxonomy; this list carries only the legacy
    // value, and path segments do the real work.
    roles: ["cli"],
  },
};

export const UNKNOWN_NOTE =
  "\"unknown\" means the retrieved evidence does not establish the category; it is never proof that a feature does not exist — other or unretrieved files may contain it.";

const ROLE_IN_REASON = /holds the "([a-z-]+)" role/;

/**
 * Path-like tokens are not source evidence ("src/routes/auth.routes.js" is
 * a location, not behaviour). Repo-file-shaped tokens with source
 * extensions are scrubbed before any text matching so a category cannot
 * reach found through a filename echo inside the window text. Strings
 * without a source extension (route URLs like "/developer/sdk/keys",
 * plain identifiers like "sessions_v2") are genuine code and stay in.
 */
const PATH_TOKEN = /(?:\.\/|\.\.\/)?(?:[\w-]+\/)+[\w-]+(?:\.[\w-]+)*\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts|py|rb|go|rs|java|php|vue|svelte)\b/g;

function discretionaryText(text: string): string {
  return text.replace(PATH_TOKEN, " ");
}
const SYMBOL_MATCH = /symbol "[^"]+" \(|symbol \S+ matches/;

function classifyWindow(win: RetrievedWindow, variants: string[]): CoverageEvidence {
  const provenance: EvidenceProvenance = win.provenance ?? "direct";
  const scrubbed = discretionaryText(win.text).toLowerCase();
  const matchedVariant = variants.find((v) => scrubbed.includes(v));
  const signal: EvidenceSignal = matchedVariant !== undefined
    ? "source-text"
    : SYMBOL_MATCH.test(win.reason)
      ? "symbol-name"
      : provenance === "indexed"
        ? "relationship-indexed"
        : provenance === "derived"
          ? "relationship-derived"
          : "filename-or-role";
  return {
    path: win.path,
    startLine: win.startLine,
    endLine: win.endLine,
    provenance,
    signal,
    ...(matchedVariant !== undefined ? { matchedVariant } : {}),
  };
}

const SIGNAL_RANK: Record<EvidenceSignal, number> = {
  "source-text": 0,
  "symbol-name": 1,
  "relationship-indexed": 2,
  "relationship-derived": 3,
  "filename-or-role": 4,
};

/**
 * Evaluates the plan's expected evidence categories against the final
 * retrieved windows. Per (concept, category) pair the strongest evidence
 * wins for the status; evidence lists keep the top items in signal-strength
 * order so humans and the Phase 5 acceptance can see exactly what backed
 * each verdict.
 */
export function evaluateCoverage(plan: QuestionPlan, result: RetrievalResult): CoverageEvaluation {
  const concepts: ConceptCoverage[] = [];
  let found = 0;
  let partial = 0;
  let unknown = 0;

  for (const concept of plan.concepts) {
    const variantList = [...new Set([concept.token, ...concept.variants.map((v) => v.text)])];
    const categories: CategoryCoverage[] = [];
    for (const category of concept.expectedEvidence) {
      const affiliation = CATEGORY_AFFILIATION[category];
      // Affiliation: whole path segment match or a retrieval reason that
      // records the matching architectural role (role seeding writes
      // `holds the "<role>" role` into the reason).
      const affiliated = result.windows.filter((win) => {
        if (!affiliation) return false;
        const segments = win.path.toLowerCase().split("/");
        if (segments.some((segment) => affiliation.segments.includes(segment))) return true;
        const roleMatch = ROLE_IN_REASON.exec(win.reason);
        return roleMatch !== null && affiliation.roles.includes(roleMatch[1]!);
      });

      const evidence = affiliated
        .map((win) => classifyWindow(win, variantList))
        .sort(
          (a, b) =>
            SIGNAL_RANK[a.signal] - SIGNAL_RANK[b.signal] ||
            a.path.localeCompare(b.path) ||
            a.startLine - b.startLine,
        )
        .slice(0, 8);

      let status: CoverageStatus;
      let reason: string;
      // Ensure concept-specific source text, not just category-affiliated text.
      const textEvidenced = evidence.filter((e) => e.signal === "source-text");
      if (affiliated.length === 0) {
        status = "unknown";
        reason = `no retrieved file is affiliated with the "${category}" layer of "${concept.token}"`;
      } else if (textEvidenced.length > 0) {
        // Concept-specific check: evidence must both match the concept variant and be from
        // a window whose affiliation matches the category we are evaluating for this concept.
        status = "found";
        const shown = textEvidenced.slice(0, 3).map((e) => `${e.path} (${e.provenance}, via "${e.matchedVariant}")`);
        reason = `source text in ${shown.join(", ")} establishes the "${category}" layer of "${concept.token}"`;
      } else {
        status = "partial";
        const nameMatches = evidence.filter((e) => e.signal === "symbol-name").length;
        const relationHints = evidence.filter(
          (e) => e.signal === "relationship-indexed" || e.signal === "relationship-derived",
        ).length;
        const uniquePaths = [...new Set(evidence.map((e) => e.path))].slice(0, 3);
        reason = `category-affiliated files exist (e.g. ${uniquePaths.join(", ")})`
          + (nameMatches > 0 ? `; ${nameMatches} window(s) echo the concept in symbol names` : "")
          + (relationHints > 0 ? `; ${relationHints} relationship-traversed file(s)` : "")
          + `, but the retrieved text does not itself establish the "${category}" behaviour of "${concept.token}"`;
      }

      if (status === "found") found += 1;
      else if (status === "partial") partial += 1;
      else unknown += 1;

      categories.push({ category, status, reason, evidence });
    }
    concepts.push({ token: concept.token, categories });
  }

  return {
    query: plan.query,
    concepts,
    summary: { found, partial, unknown },
    unknownNote: UNKNOWN_NOTE,
  };
}


// ── Adaptive coverage ─────────────────────────────────────────────────────────

/**
 * Adaptive coverage evaluation that uses the ConceptIndex and QuestionConceptMapping
 * to derive expected evidence categories from the REPOSITORY's own structure,
 * not from a hardcoded glossary.
 *
 * Affiliation is exact: a concept file affiliates only with the category that
 * matches its recorded role (concept.fileRoles, populated by concept discovery
 * from the existing indexed role data). A service file can therefore never
 * establish controller or repository coverage merely because all three belong
 * to the same concept. Windows may still affiliate through the retrieval
 * reason's recorded role.
 *
 * Falls back to evaluateCoverage() when the concept mapping produces no
 * top concepts (e.g. for queries about entirely unknown subsystems).
 *
 * This replaces the hardcoded CATEGORY_AFFILIATION lookup for concept-matched
 * categories, while preserving all existing provenance, signal and evidence
 * semantics.
 */
export function evaluateCoverageAdaptive(
  plan: QuestionPlan,
  result: RetrievalResult,
  mapping: QuestionConceptMapping,
  _index: ConceptIndex,
): CoverageEvaluation {
  // If no concepts matched, fall back to the existing deterministic evaluator
  if (mapping.topConcepts.length === 0) {
    return evaluateCoverage(plan, result);
  }

  const adaptiveConcepts: ConceptCoverage[] = [];
  let found = 0;
  let partial = 0;
  let unknown = 0;

  for (const concept of mapping.topConcepts) {
    const variantList = [
      concept.displayName,
      ...concept.normalizedTerms,
    ];

    // Derive expected categories from the concept's own files' roles
    // (not from a hardcoded word→categories map)
    const expectedCategories = concept.discoveredCategories.length > 0
      ? concept.discoveredCategories
      : ["unclassified"];

    // Category → files of this concept whose recorded role is that category.
    // Files without a recorded role affiliate only with "unclassified".
    const categoryToFiles = new Map<string, { fileIds: Set<string>; paths: Set<string> }>();
    for (let i = 0; i < concept.fileIds.length; i++) {
      const fid = concept.fileIds[i]!;
      const role = concept.fileRoles[fid] ?? "unclassified";
      const entry = categoryToFiles.get(role)
        ?? { fileIds: new Set<string>(), paths: new Set<string>() };
      entry.fileIds.add(fid);
      const path = concept.filePaths[i];
      if (path) entry.paths.add(path);
      categoryToFiles.set(role, entry);
    }

    const categories: CategoryCoverage[] = [];

    for (const category of expectedCategories) {
      // Affiliation: windows whose file conceptually belongs to this role
      // (by recorded fileId or the concept's own path for it), OR whose
      // retrieval reason records the matching role. All derived from the
      // index and role data — no hardcoded segment names.
      const affiliatedFiles = categoryToFiles.get(category)
        ?? { fileIds: new Set<string>(), paths: new Set<string>() };
      const affiliated = result.windows.filter((win) => {
        if (affiliatedFiles.fileIds.has(win.fileId) || affiliatedFiles.paths.has(win.path)) return true;
        const roleMatch = ROLE_IN_REASON.exec(win.reason);
        return roleMatch !== null && roleMatch[1] === category;
      });

      const evidence = affiliated
        .map((win) => classifyWindow(win, variantList))
        .sort(
          (a, b) =>
            SIGNAL_RANK[a.signal] - SIGNAL_RANK[b.signal] ||
            a.path.localeCompare(b.path) ||
            a.startLine - b.startLine,
        )
        .slice(0, 8);

      let status: CoverageStatus;
      let reason: string;
      const textEvidenced = evidence.filter((e) => e.signal === "source-text");

      if (affiliated.length === 0) {
        status = "unknown";
        reason = `no retrieved file is affiliated with the "${category}" layer of concept "${concept.displayName}"`;
      } else if (textEvidenced.length > 0) {
        status = "found";
        const shown = textEvidenced.slice(0, 3).map((e) => `${e.path} (${e.provenance}, via "${e.matchedVariant}")`);
        reason = `source text in ${shown.join(", ")} establishes the "${category}" layer of concept "${concept.displayName}"`;
      } else {
        status = "partial";
        const nameMatches = evidence.filter((e) => e.signal === "symbol-name").length;
        const relationHints = evidence.filter(
          (e) => e.signal === "relationship-indexed" || e.signal === "relationship-derived",
        ).length;
        const uniquePaths = [...new Set(evidence.map((e) => e.path))].slice(0, 3);
        reason = `concept-affiliated files exist (e.g. ${uniquePaths.join(", ")})`
          + (nameMatches > 0 ? `; ${nameMatches} window(s) echo the concept in symbol names` : "")
          + (relationHints > 0 ? `; ${relationHints} relationship-traversed file(s)` : "")
          + `, but the retrieved text does not establish "${category}" behaviour of "${concept.displayName}"`;
      }

      if (status === "found") found += 1;
      else if (status === "partial") partial += 1;
      else unknown += 1;

      categories.push({ category, status, reason, evidence });
    }

    adaptiveConcepts.push({ token: concept.displayName, categories });
  }

  return {
    query: plan.query,
    concepts: adaptiveConcepts,
    summary: { found, partial, unknown },
    unknownNote: UNKNOWN_NOTE,
  };
}
