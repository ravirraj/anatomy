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
 * Self-named honesty (Phase 1D, V1): an unnamed concept associates with a
 * window only when a real signal connects them the concept's own
 * vocabulary. A symbol-mention reason counts only when the symbol name
 * actually echoes one of the concept's variants — a window reached through
 * an unrelated symbol (any query produces symbol-hit files) must not turn
 * an unknown concept into a phantom partial. Relationship provenance is
 * kept: those windows were reached through query-token-driven traversal.
 */
function selfNamedPositive(win: RetrievedWindow, variantList: string[]): boolean {
  const signal = classifyWindow(win, variantList).signal;
  if (signal === "source-text") return true;
  if (signal === "filename-or-role") return false;
  if (signal === "symbol-name") {
    const match = /symbol "([^"]+)"|symbol \S+ matches/.exec(win.reason);
    const name = (match?.[1] ?? match?.[0] ?? "").toLowerCase();
    return variantList.some((v) => v.length >= 3 && name.includes(v));
  }
  return true;
}

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
    // Phase 1D (V1): a concept the planner could not name any categories for
    // was evaluated to nothing — vacuously covered, invisible to the drill
    // and to the answer's coverage block. It now gets one self-named
    // category (e.g. "zorb" for concept "zorb"), affiliated with EVERY
    // retrieved window and judged by the same signal rules, so coverage is
    // honest and the loop can drill for it with the concept's own
    // vocabulary.
    const selfNamed = concept.expectedEvidence.length === 0;
    const categories: CategoryCoverage[] = [];
    for (const category of selfNamed ? [concept.token] : concept.expectedEvidence) {
      const affiliation = CATEGORY_AFFILIATION[category];
      // Affiliation: whole path segment match or a retrieval reason that
      // records the matching architectural role (role seeding writes
      // `holds the "<role>" role` into the reason). Self-named concepts
      // affiliate with every window: found/partial/unknown still come only
      // from the concept's own classified signals below.
      const affiliated = result.windows.filter((win) => {
        if (selfNamed) return true;
        if (!affiliation) return false;
        const segments = win.path.toLowerCase().split("/");
        if (segments.some((segment) => affiliation.segments.includes(segment))) return true;
        const roleMatch = ROLE_IN_REASON.exec(win.reason);
        return roleMatch !== null && affiliation.roles.includes(roleMatch[1]!);
      });

      const classified = affiliated
        .map((win) => ({ win, item: classifyWindow(win, variantList) }))
        .sort(
          (a, b) =>
            SIGNAL_RANK[a.item.signal] - SIGNAL_RANK[b.item.signal] ||
            a.win.path.localeCompare(b.win.path) ||
            a.win.startLine - b.win.startLine,
        )
        .slice(0, 8);

      let status: CoverageStatus;
      let reason: string;
      // Ensure concept-specific source text, not just category-affiliated text.
      const textEvidenced = classified.filter((p) => p.item.signal === "source-text");
      // Real association for a self-named concept: echo-checked positives
      // only — a bare path match establishes nothing about an unnamed
      // concept, and an unrelated symbol mention echoes nothing.
      const positivePairs = selfNamed
        ? classified.filter((p) => selfNamedPositive(p.win, variantList))
        : [];
      const evidence = selfNamed ? positivePairs.map((p) => p.item) : classified.map((p) => p.item);
      const positiveEvidence = evidence;

      if (selfNamed && positivePairs.length === 0) {
        // An unnamed concept with no real signal stays unknown, and reports
        // no evidence items (unknown never presents evidence).
        status = "unknown";
        reason = `no retrieved file carries evidence of the "${category}" concept: any retrieved file could hold it, and none matched its variants`;
      } else if (affiliated.length === 0) {
        status = "unknown";
        reason = selfNamed
          ? `no retrieved file carries evidence of the "${category}" concept: any retrieved file could hold it, and none matched its variants`
          : `no retrieved file is affiliated with the "${category}" layer of "${concept.token}"`;
      } else if (textEvidenced.length > 0) {
        // Concept-specific check: evidence must both match the concept variant and be from
        // a window whose affiliation matches the category we are evaluating for this concept.
        status = "found";
        const shown = textEvidenced
          .slice(0, 3)
          .map((p) => `${p.item.path} (${p.item.provenance}, via "${p.item.matchedVariant}")`);
        reason = selfNamed
          ? `source text in ${shown.join(", ")} establishes the "${category}" concept`
          : `source text in ${shown.join(", ")} establishes the "${category}" layer of "${concept.token}"`;
      } else {
        status = "partial";
        const nameMatches = evidence.filter((e) => e.signal === "symbol-name").length;
        const relationHints = evidence.filter(
          (e) => e.signal === "relationship-indexed" || e.signal === "relationship-derived",
        ).length;
        const uniquePaths = [...new Set(positiveEvidence.map((e) => e.path))].slice(0, 3);
        reason = selfNamed
          ? `retrieved file(s) associate with "${category}" (e.g. ${uniquePaths.join(", ")})`
            + (nameMatches > 0 ? `; ${nameMatches} window(s) echo the concept in symbol names` : "")
            + ", but no retrieved text establishes the concept's own vocabulary"
          : `category-affiliated files exist (e.g. ${uniquePaths.join(", ")})`
            + (nameMatches > 0 ? `; ${nameMatches} window(s) echo the concept in symbol names` : "")
            + (relationHints > 0 ? `; ${relationHints} relationship-traversed file(s)` : "")
            + `, but the retrieved text does not itself establish the "${category}" behaviour of "${concept.token}"`;
      }

      if (status === "found") found += 1;
      else if (status === "partial") partial += 1;
      else unknown += 1;

      categories.push({ category, status, reason, evidence: positiveEvidence });
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
 * Self-named coverage of one plan concept (Phase 1D, V1): a single category
 * named after the concept itself, affiliated with every retrieved window
 * (any file could carry the concept), and classified by the standard signal
 * rules. Reason wording speaks of the concept directly rather than of a
 * "category layer" of it, and — for honesty — evidence items drop
 * filename-or-role echoes (a bare path match establishes nothing about an
 * unnamed concept; such a result stays unknown).
 */
function evaluateSelfNamedConcept(
  concept: { token: string; variants: { text: string }[] },
  result: RetrievalResult,
): ConceptCoverage {
  const variantList = [...new Set([concept.token, ...concept.variants.map((v) => v.text)])];
  const category = concept.token;
  const classified = result.windows
    .map((win) => ({ win, item: classifyWindow(win, variantList) }))
    .sort(
      (a, b) =>
        SIGNAL_RANK[a.item.signal] - SIGNAL_RANK[b.item.signal] ||
        a.win.path.localeCompare(b.win.path) ||
        a.win.startLine - b.win.startLine,
    )
    .slice(0, 8);
  const textEvidenced = classified
    .filter((p) => p.item.signal === "source-text")
    .map((p) => p.item);
  const positive = classified
    .filter((p) => selfNamedPositive(p.win, variantList))
    .map((p) => p.item);
  const evidence = positive;

  let status: CoverageStatus;
  let reason: string;
  if (positive.length === 0) {
    status = "unknown";
    reason = `no retrieved file carries evidence of the "${category}" concept: any retrieved file could hold it, and none matched its variants`;
  } else if (textEvidenced.length > 0) {
    status = "found";
    const shown = textEvidenced.slice(0, 3).map((e) => `${e.path} (${e.provenance}, via "${e.matchedVariant}")`);
    reason = `source text in ${shown.join(", ")} establishes the "${category}" concept`;
  } else {
    status = "partial";
    const nameMatches = positive.filter((e) => e.signal === "symbol-name").length;
    const uniquePaths = [...new Set(positive.map((e) => e.path))].slice(0, 3);
    reason = `retrieved file(s) associate with "${category}" (e.g. ${uniquePaths.join(", ")})`
      + (nameMatches > 0 ? `; ${nameMatches} window(s) echo the concept in symbol names` : "")
      + ", but no retrieved text establishes the concept's own vocabulary";
  }

  return {
    token: concept.token,
    categories: [{ category, status, reason, evidence: positive }],
  };
}

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
    // (not from a hardcoded word→categories map).
    //
    // Phase 1D (V7b): a concept whose files never received an indexed role
    // previously surfaced as a junk "unclassified" layer — meaningless to
    // the model, drilled by the literal word, and presented as if
    // "unclassified" were a real layer of the codebase. It is now reported
    // under the concept's own name, affiliating by its own fileIds (set on
    // categoryToFiles below).
    const noRoles = concept.discoveredCategories.length === 0;
    const expectedCategories = noRoles
      ? [concept.displayName]
      : concept.discoveredCategories;

    // Category → files of this concept whose recorded role is that category.
    // Files without a recorded role affiliate only with "unclassified" —
    // except in the fully role-less case, where the concept affiliates with
    // everything it owns under its own name.
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
    if (noRoles) {
      categoryToFiles.set(
        concept.displayName,
        { fileIds: new Set(concept.fileIds), paths: new Set(concept.filePaths.filter(Boolean)) },
      );
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

  // Phase 1D (V1): plan concepts the repository's concept index did not
  // match must still be evaluated. Previously they vanished the moment one
  // of their sibling tokens DID match — no coverage line, no drill, and no
  // honest unknown in the answer's coverage block. Each unmatched concept
  // contributes one self-named category with any-window affiliation; a
  // concept already represented by a top concept (same display name, or the
  // token is one of its normalized terms) is skipped to avoid duplicates.
  for (const planConcept of plan.concepts) {
    if (mapping.matches.has(planConcept.token)) continue;
    if (
      mapping.topConcepts.some(
        (tc) =>
          tc.displayName === planConcept.token ||
          tc.normalizedTerms.includes(planConcept.token),
      )
    ) {
      continue;
    }
    const appended = evaluateSelfNamedConcept(planConcept, result);
    for (const cat of appended.categories) {
      if (cat.status === "found") found += 1;
      else if (cat.status === "partial") partial += 1;
      else unknown += 1;
    }
    adaptiveConcepts.push(appended);
  }

  return {
    query: plan.query,
    concepts: adaptiveConcepts,
    summary: { found, partial, unknown },
    unknownNote: UNKNOWN_NOTE,
  };
}
