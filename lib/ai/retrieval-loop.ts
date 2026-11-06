/**
 * Bounded iterative retrieval (Phase 6 of the coverage-driven Q&A plan).
 * Runs the existing deterministic retrieval pipeline, evaluates coverage
 * (lib/ai/coverage.ts) and, while the plan's expected evidence is not yet
 * established, performs targeted retrieval passes for the missing
 * (partial/unknown) categories — using the same indexed data and
 * relationship machinery, never an LLM.
 *
 * Guarantees:
 *  - Duplicate-free merging: exact or overlapping ranges skip; per-file
 *    window cap and global caps hold; existing stronger (or protected)
 *    evidence is never displaced by weaker targeted candidates. Weaker
 *    evidence moves out only through an atomic, simulate-then-commit
 *    replacement that leaves the package untouched when infeasible.
 *  - The 16-file / 28k-character budget and the per-file window cap stay
 *    intact across all passes, including the window headers and line-1
 *    `[API surface]` appendices the final prompt renders.
 *  - At most `maxPasses` (default 3) additional retrieval passes; stops
 *    early on sufficient coverage, on missing useful candidates, or on an
 *    exhausted budget. "unknown" is treated as unproven, never as
 *    nonexistence: it merely feeds the next targeted pass.
 *  - Provenance and content hashes of every window flow through unchanged
 *    (citation verification downstream is untouched).
 *  - Direct single-pass behaviour is unchanged: with no missing categories
 *    the loop performs exactly one retrieval call and returns its result.
 */

import {
  CATEGORY_AFFILIATION,
  evaluateCoverage,
  evaluateCoverageAdaptive,
  type CoverageEvaluation,
} from "./coverage.ts";
import {
  DEFAULT_BUDGET,
  computeEvidenceLimits,
  formatApiSurfaceFor,
  retrieveGroundedContext,
  supportFilePenalty,
  type Db,
  type RetrievalBudget,
  type RetrievalResult,
  type RetrievedWindow,
} from "./retrieval.ts";
import { estimateCodeTokens, estimateProseTokens } from "./budget.ts";
import { buildConceptIndexForAnalysis } from "./concepts/loader.ts";
import { matchConceptsForQuery } from "./concepts/mapping.ts";
import type { ConceptIndex } from "./concepts/types.ts";

export type RetrievalLoopBudget = RetrievalBudget & {
  /**
   * Maximum number of ADDITIONAL retrieval passes after the first one.
   */
  maxPasses?: number;
  /**
   * Minimum candidate window score for a NEW file to enter the package;
   * lower-ranked relationship-only evidence may never displace or pad
   * stronger direct evidence when the file budget is contested.
   */
  scoreFloor?: number;
  /**
   * Use repository-derived concept discovery (buildConceptIndex) instead of
   * the hardcoded CONCEPT_CATEGORIES vocabulary. Defaults to true in production.
   * Tests of the lexical fallback path may set this to false.
   */
  adaptive?: boolean;
  /**
   * A pre-built ConceptIndex. When provided, the loop skips loading one.
   */
  conceptIndex?: ConceptIndex | null;
};

const DEFAULT_LOOP: Required<Pick<RetrievalLoopBudget, "maxPasses" | "scoreFloor">> = {
  maxPasses: 3,
  scoreFloor: 50,
};

/** Category vocabulary that drives the focused retrieval queries. Planner
 * categories (plural) and adaptive coverage categories (raw role ids from the
 * concept index) both land here. Role ids without an entry still fall back to
 * the raw category name, so unknown future roles keep working. */
export const CATEGORY_QUERY_WORDS: Record<string, string> = {
  controllers: "controller handler",
  controller: "controller handler",
  middleware: "middleware",
  models: "model schema",
  model: "model schema",
  services: "service",
  service: "service",
  config: "config environment",
  routes: "route router endpoint",
  frontend: "frontend component client",
  // Adaptive coverage categories that are taxonomy role ids.
  "page-route": "page route",
  "api-endpoint": "api endpoint route",
  "server-action": "server action",
  repository: "repository persistence",
  entity: "entity",
  dto: "data transfer object",
  resolver: "resolver",
  gateway: "gateway",
  guard: "guard",
  interceptor: "interceptor",
  component: "component ui",
  hook: "hook state",
};

export type IterationPass = {
  pass: number;
  /** The focused retrieval queries issued for the still-missing categories. */
  queries: string[];
  categories: string[];
  addedWindows: number;
  addedFiles: number;
  /** Existing files displaced by strictly stronger targeted evidence. */
  replacedFiles: number;
  ms: number;
};

export type IterativeRetrievalResult = {
  /** The final merged evidence package (itself a RetrievalResult). */
  result: RetrievalResult;
  /** Coverage evaluation of the final package against the base plan. */
  coverage: CoverageEvaluation;
  passes: IterationPass[];
  stoppedBecause:
    | "sufficient-coverage"
    | "no-candidates"
    | "max-passes"
    | "budget-exhausted"
    /** An explicitly-named file anchors the question; leftover self-named
     * (out-of-vocabulary) concepts are left honestly unknown instead of
     * drilling broad path noise (Phase 1D, V10). */
    | "explicit-anchor";
  totalMs: number;
};

type MissingPair = { token: string; category: string; status: string };

const ROLE_IN_REASON = /holds the "([a-z-]+)" role/;

function missingCategories(coverage: CoverageEvaluation): MissingPair[] {
  const missing: MissingPair[] = [];
  for (const concept of coverage.concepts) {
    for (const category of concept.categories) {
      // Phase 1D (V7b): the literal "unclassified" label is informational
      // only — drilling the word would query the junk label, not the code.
      // (Coverage renames role-less concepts under their own display name,
      // so this only ever fires on legacy data; kept defensive.)
      if (category.status !== "found" && category.category !== "unclassified") {
        missing.push({ token: concept.token, category: category.category, status: category.status });
      }
    }
  }
  // Prioritize partial over unknown (a partial category has already located
  // its layer; targeted retrieval there is more likely to land). sort() is
  // stable, so planner order is preserved inside each priority tier.
  return missing.sort(
    (a, b) => (a.status === "partial" ? 0 : 1) - (b.status === "partial" ? 0 : 1),
  );
}

function focusedQuery(pair: MissingPair): string {
  // Phase 1D (V1/V7b): self-named drills run the concept's own vocabulary
  // alone — the token IS the concept's query, and appending the category
  // name (the token again) or the junk "unclassified" literal would only
  // dilute or corrupt the focused search.
  if (pair.category === pair.token) return pair.token;
  const words = CATEGORY_QUERY_WORDS[pair.category] ?? (pair.category === "cli" ? "cli command subcommand" : pair.category);
  return `${pair.token} ${words}`;
}

/**
 * Same-file windows count as duplicate evidence when they overlap or sit
 * within the 5-line merge tolerance retrieval itself uses
 * (mergeCandidateWindows): a slice that close to evidence already in the
 * package would have been one window in a single pass.
 */
function windowOverlaps(a: RetrievedWindow, b: RetrievedWindow): boolean {
  return a.startLine <= b.endLine + 5 && b.startLine <= a.endLine + 5;
}

/**
 * Pure merge step of one iteration: folds candidate windows of a targeted
 * pass into the current evidence package without duplication, respecting
 * per-file window, file, and character caps. Weak existing evidence moves
 * out only through atomic replacement: when `options.allowReplacement` is
 * set and the candidate does not fit as served, eligible strictly weaker
 * windows are removed only inside a simulated plan, and the plan commits
 * in one step only if the incoming candidate then fits — so a failed
 * replacement can never leave the package gutted without its replacement.
 * Every fit decision is made on the retrieval contract's served figures
 * (window text + header + the line-1 `[API surface]` appendix the final
 * prompt attaches), never on raw text alone.
 */

// ── Per-window serving costs (retrieval contract accounting) ────────────────

/**
 * The exact per-window serving costs the base pipeline enforces
 * (lib/ai/retrieval.ts `windowCostOf`): the rendered package charges every
 * window its header line plus its code text, in characters, and its code
 * tokens plus the header's prose tokens. Iterative merging must respect the
 * same figures so it can never drift past the budget the base path enforced.
 */
const windowHeaderCost = (
  w: { path: string; contentHash: string; startLine: number; endLine: number },
): number =>
  `--- File: ${w.path} (lines ${w.startLine}-${w.endLine}) [hash: ${w.contentHash.slice(0, 8)}] ---\n`.length + 2;

const windowServingCost = (
  w: { path: string; contentHash: string; startLine: number; endLine: number; text: string },
): { chars: number; tokens: number } => ({
  chars: w.text.length + windowHeaderCost(w),
  tokens: estimateCodeTokens(w.text) + estimateProseTokens(w.path) + 15,
});
export function mergeIterationWindows(
  current: {
    windows: RetrievedWindow[];
    totalCharacters: number;
    totalTokens?: number;
    /**
     * Enforced as-served character ledger (the base result's
     * `renderedCharacters`): window text + header + line-1 appendix
     * characters, exactly what the base pipeline finished counting. When
     * given, it starts the ledger directly — appendix costs already present
     * in it are preserved, not re-added.
     */
    renderedCharacters?: number;
  },
  candidates: RetrievedWindow[],
  limits: { maxFiles: number; maxWindowsPerFile: number; maxCharacters: number; scoreFloor: number; maxTokens?: number },
  options?: {
    allowReplacement?: boolean;
    protectedFiles?: Set<string>;
    replacementMargin?: number;
    /**
     * Exact cost of a file's `[API surface]` appendix as the final prompt
     * attaches it (the appendix is appended to every window containing
     * line 1 of a file that has exported symbols). Provide it whenever
     * symbol rows are known so line-1 windows reserve the appendix the
     * final assembly will render; omitted → no appendix accounting.
     */
    appendixOf?: (w: { path: string }) => { chars: number; tokens: number };
  },
): {
  windows: RetrievedWindow[];
  totalCharacters: number;
  totalTokens: number;
  renderedCharacters: number;
  added: number;
  addedFiles: number;
  replacedFiles: number;
  rejectedBudget: number;
  candidatesConsidered: number;
} {
  const windows = [...current.windows];
  let totalCharacters = current.totalCharacters;
  // Enforcement ledger mirrors the base pipeline's serving contract: every
  // window occupies its header-inclusive character cost, its serving token
  // cost, and — for windows containing line 1 — the `[API surface]`
  // appendix cost the final prompt attaches (lib/ai/retrieval.ts
  // `formatRetrievedContext`). The merge therefore cannot drift past the
  // budget the base path itself enforced, even when the final prompt adds
  // appendix text on top of the windows. `totalCharacters` keeps its raw
  // code-character semantics for callers; `renderedCharacters` carries the
  // enforced ledger forward between passes.
  const appendixOf = options?.appendixOf;
  const appendixCostOf = (
    w: { path: string; startLine: number },
  ): { chars: number; tokens: number } =>
    w.startLine === 1 && appendixOf !== undefined ? appendixOf(w) : { chars: 0, tokens: 0 };
  const servedCostOf = (
    w: { path: string; contentHash: string; startLine: number; endLine: number; text: string },
  ): { chars: number; tokens: number } => {
    const cost = windowServingCost(w);
    const appendix = appendixCostOf(w);
    return { chars: cost.chars + appendix.chars, tokens: cost.tokens + appendix.tokens };
  };
  // The character ledger starts from the caller's enforced figure when given
  // (base.renderedCharacters is header- and appendix-inclusive — exactly
  // what the base pipeline already counted) and otherwise derives it from
  // the caller's raw character figure plus each window's non-text overheads
  // (header + appendix). The raw figure already owns the window text, so
  // text is never added twice, and appendix costs inherited in the caller's
  // figures are preserved, never re-added (no double counting).
  let ledgerCharacters = current.renderedCharacters
    ?? totalCharacters
      + windows.reduce((acc, w) => acc + windowHeaderCost(w) + appendixCostOf(w).chars, 0);
  // Same convention for tokens: either the caller's ledger (base.totalTokens
  // already counts header and appendix serving tokens) or the consistent
  // sum of the windows' served token costs — never a raw-characters heuristic
  // mixed with served-token additions.
  let totalTokens = current.totalTokens
    ?? windows.reduce((acc, w) => acc + servedCostOf(w).tokens, 0);
  // Fold stronger candidates first so the budget (char/file caps) is spent
  // on the most relevant evidence; sort by effective score (support files
  // demoted) to mirror the base pipeline's prioritization.
  const sortedCandidates = [...candidates].sort(
    (a, b) =>
      b.score - supportFilePenalty(b.path) - (a.score - supportFilePenalty(a.path)) ||
      a.path.localeCompare(b.path) ||
      a.startLine - b.startLine,
  );
  const perFile = new Map<string, number>();
  const files = new Set<string>();

  for (const win of windows) {
    perFile.set(win.fileId, (perFile.get(win.fileId) ?? 0) + 1);
    files.add(win.fileId);
  }

  let added = 0;
  let addedFiles = 0;
  let replacedFiles = 0;
  let rejectedBudget = 0;
  let candidatesConsidered = 0;

  const margin = options?.replacementMargin ?? 10;

  for (const cand of sortedCandidates) {
    candidatesConsidered += 1;
    const existing = windows.filter((w) => w.fileId === cand.fileId);
    const exactDuplicate = existing.some(
      (w) => w.startLine === cand.startLine && w.endLine === cand.endLine,
    );
    if (exactDuplicate || existing.some((w) => windowOverlaps(w, cand))) {
      continue; // same or overlapping slice already retrieved — never re-serve evidence
    }
    if ((perFile.get(cand.fileId) ?? 0) >= limits.maxWindowsPerFile) {
      continue; // per-file window cap
    }
    const isNewFile = !files.has(cand.fileId);
    if (isNewFile) {
      if (cand.score < limits.scoreFloor) {
        rejectedBudget += 1;
        continue; // weak relationship-only padding
      }
      const candCost = servedCostOf(cand);
      const candidateFits = (): boolean =>
        files.size + 1 <= limits.maxFiles &&
        ledgerCharacters + candCost.chars <= limits.maxCharacters &&
        (limits.maxTokens === undefined || totalTokens + candCost.tokens <= limits.maxTokens);
      if (!candidateFits() && options?.allowReplacement) {
        // Atomic replacement planning: identify eligible victims and simulate
        // their removal against copied ledger figures until the candidate
        // fits. No existing window, counter or ledger figure is touched
        // during planning — the commit below happens only when the plan
        // succeeds (the base pipeline's Phase D rescue follows the same
        // simulate-then-commit pattern), so an infeasible replacement
        // preserves the original result exactly.
        const removedFileIds: string[] = [];
        let simChars = ledgerCharacters;
        let simTokens = totalTokens;
        let simFiles = files.size;
        let feasible = true;
        while (
          simFiles + 1 > limits.maxFiles ||
          simChars + candCost.chars > limits.maxCharacters ||
          (limits.maxTokens !== undefined && simTokens + candCost.tokens > limits.maxTokens)
        ) {
          let victim: string | null = null;
          let victimScore = Infinity;
          const fileBest = new Map<string, number>();
          const removedSet = new Set(removedFileIds);
          for (const w of windows) {
            if (removedSet.has(w.fileId)) continue;
            const cur = fileBest.get(w.fileId) ?? 0;
            if (w.score > cur) fileBest.set(w.fileId, w.score);
          }
          for (const [fid, best] of fileBest) {
            if (options.protectedFiles?.has(fid)) continue;
            if (best >= cand.score - margin) continue;
            if (best < victimScore || (best === victimScore && (victim === null || fid < victim))) {
              victim = fid;
              victimScore = best;
            }
          }
          if (victim === null) {
            feasible = false;
            break; // no strictly weaker victim left — the package stays as it is
          }
          removedFileIds.push(victim);
          for (const w of windows) {
            if (w.fileId !== victim) continue;
            const cost = servedCostOf(w);
            simChars -= cost.chars;
            simTokens -= cost.tokens;
          }
          simFiles -= 1;
        }
        if (feasible) {
          // Commit the whole plan in one step: windows, file set, per-file
          // counts, raw characters and both ledger figures move together.
          const removedSet = new Set(removedFileIds);
          for (const w of windows) {
            if (removedSet.has(w.fileId)) totalCharacters -= w.text.length;
          }
          const kept = windows.filter((w) => !removedSet.has(w.fileId));
          windows.length = 0;
          windows.push(...kept);
          for (const fid of removedFileIds) {
            files.delete(fid);
            perFile.delete(fid);
            replacedFiles += 1;
          }
          ledgerCharacters = simChars;
          totalTokens = simTokens;
        }
      }
      if (files.size >= limits.maxFiles) {
        rejectedBudget += 1;
        continue; // file budget still full
      }
    }
    let finalCand = cand;
    let finalCost = servedCostOf(finalCand);
    const exceedsChar = ledgerCharacters + finalCost.chars > limits.maxCharacters;
    const exceedsToken = limits.maxTokens !== undefined && totalTokens + finalCost.tokens > limits.maxTokens;
    if (exceedsChar || exceedsToken) {
      const remainingChars = limits.maxCharacters - ledgerCharacters;
      const remainingTokens = limits.maxTokens !== undefined ? limits.maxTokens - totalTokens : Infinity;
      if (remainingChars >= 250 && remainingTokens >= 60) {
        // Truncation reserves the candidate's fixed as-served overhead first —
        // header text and the line-1 appendix the final prompt attaches — so
        // the fitting slice plus its served overhead stays inside the
        // remaining budget.
        const overheadChars = windowHeaderCost(finalCand) + appendixCostOf(finalCand).chars;
        const overheadTokens = estimateProseTokens(finalCand.path) + 15 + appendixCostOf(finalCand).tokens;
        const lines = cand.text.split("\n");
        let accum = "";
        let lineCount = 0;
        for (let i = 0; i < lines.length; i++) {
          const next = accum === "" ? lines[i]! : accum + "\n" + lines[i]!;
          if (next.length + overheadChars > remainingChars || estimateCodeTokens(next) + overheadTokens > remainingTokens) break;
          accum = next;
          lineCount++;
        }
        if (lineCount >= 8 && accum.length > 0) {
          finalCand = {
            ...cand,
            endLine: cand.startLine + lineCount - 1,
            text: accum,
          };
          // The re-headered slice must still fit as served (the header text
          // changes with the recomputed line range; the line-1 appendix cost
          // is unchanged — the slice still contains line 1); otherwise
          // reject whole.
          finalCost = servedCostOf(finalCand);
          if (
            ledgerCharacters + finalCost.chars > limits.maxCharacters ||
            (limits.maxTokens !== undefined && totalTokens + finalCost.tokens > limits.maxTokens)
          ) {
            rejectedBudget += 1;
            continue;
          }
        } else {
          rejectedBudget += 1;
          continue;
        }
      } else {
        rejectedBudget += 1;
        continue;
      }
    }
    if (limits.maxTokens !== undefined && totalTokens + finalCost.tokens > limits.maxTokens) {
      rejectedBudget += 1;
      continue;
    }
    windows.push(finalCand);
    totalCharacters += finalCand.text.length;
    ledgerCharacters += finalCost.chars;
    totalTokens += finalCost.tokens;
    perFile.set(finalCand.fileId, (perFile.get(finalCand.fileId) ?? 0) + 1);
    if (isNewFile) {
      files.add(finalCand.fileId);
      addedFiles += 1;
    }
    added += 1;
  }

  return {
    windows,
    totalCharacters,
    totalTokens,
    renderedCharacters: ledgerCharacters,
    added,
    addedFiles,
    replacedFiles,
    rejectedBudget,
    candidatesConsidered,
  };
}

/**
 * Affiliation filter (mirrors coverage semantics): only windows whose file
 * belongs to a still-missing category are useful candidates for a pass —
 * targeted retrieval must add evidence for the gap, not more of the same.
 */
export function windowAffiliation(win: {
  path: string;
  reason: string;
}): string | null {
  const segments = win.path.toLowerCase().split("/");
  const roleMatch = ROLE_IN_REASON.exec(win.reason);
  for (const [category, aff] of Object.entries(CATEGORY_AFFILIATION)) {
    if (segments.some((segment) => aff.segments.includes(segment))) return category;
    if (roleMatch !== null && aff.roles.includes(roleMatch[1]!)) return category;
  }
  return null;
}

export async function retrieveWithCoverageLoop(
  db: Db,
  analysisId: string,
  rawQuery: string,
  budget: RetrievalLoopBudget = {},
): Promise<IterativeRetrievalResult> {
  const startedAt = performance.now();
  const { maxPasses, scoreFloor, adaptive, conceptIndex: providedIndex, ...retrievalBudget } = budget;
  const useAdaptive = adaptive !== false;
  const config = {
    maxPasses: maxPasses ?? DEFAULT_LOOP.maxPasses,
    scoreFloor: scoreFloor ?? DEFAULT_LOOP.scoreFloor,
  };
  // Build the repository-derived concept index once (Phase 1 integration).
  let conceptIndex: ConceptIndex | null = null;
  if (useAdaptive) {
    if (providedIndex !== undefined) {
      conceptIndex = providedIndex ?? null;
    } else {
      try {
        conceptIndex = await buildConceptIndexForAnalysis(db, analysisId);
      } catch {
        conceptIndex = null;
      }
    }
  }

  // Pass 0: the unchanged deterministic pipeline, now concept-aware.
  const base = await retrieveGroundedContext(db, analysisId, rawQuery, retrievalBudget, conceptIndex);
  let windows: RetrievedWindow[] = [...base.windows];
  let totalCharacters = base.totalCharacters;
  // Symbol knowledge for appendix accounting: every retrieval pass (base and
  // focused alike) loads the symbol rows of the files it served, and
  // `formatRetrievedContext` attaches the same `[API surface]` text under
  // every line-1 window whose file has exported symbols in the final result.
  // Keep the best-known rows per path so the merge can reserve exactly what
  // the final prompt will render. Base rows win: rows for an already-served
  // file are identical in every later load, so the first entry is kept and
  // no appendix is ever counted twice.
  const symbolKnowledge = new Map<string, NonNullable<RetrievalResult["symbols"]>>();
  for (const sym of base.symbols ?? []) {
    const list = symbolKnowledge.get(sym.path) ?? [];
    list.push(sym);
    symbolKnowledge.set(sym.path, list);
  }
  const appendixOf = (w: { path: string }): { chars: number; tokens: number } => {
    const syms = symbolKnowledge.get(w.path);
    if (!syms || syms.length === 0) return { chars: 0, tokens: 0 };
    const block = formatApiSurfaceFor(syms);
    return block ? { chars: block.length, tokens: estimateCodeTokens(block) } : { chars: 0, tokens: 0 };
  };
  let totalTokens = base.totalTokens
    ?? [...base.windows].reduce((acc, w) => acc + windowServingCost(w).tokens + appendixOf(w).tokens, 0);
  // Enforced as-served character ledger (headers + line-1 appendices), the
  // exact figure the base pipeline finished counting; threaded through every
  // merge pass so no appendix cost already paid for is counted twice.
  let renderedCharacters: number | undefined = base.renderedCharacters ?? undefined;
  let symbolsState: RetrievalResult["symbols"] = base.symbols ?? [];
  let symbolsStale = false;

  // Single unified evidence budget: Pass 0, iterative passes, packaging, and API surface share one allocation.
  const retrievalLimits = computeEvidenceLimits(retrievalBudget, rawQuery, base.packaging ?? "");
  const pkgChars = base.packaging ? base.packaging.length : 0;
  const pkgTokens = base.packaging ? estimateCodeTokens(base.packaging) : 0;
  const availableCodeChars = retrievalLimits.maxCharacters;
  const availableCodeTokens = retrievalLimits.maxTokens;

  const limits = {
    maxFiles: retrievalBudget.maxFiles ?? DEFAULT_BUDGET.maxFiles,
    maxWindowsPerFile: retrievalBudget.maxWindowsPerFile ?? DEFAULT_BUDGET.maxWindowsPerFile,
    maxCharacters: availableCodeChars,
    maxTokens: availableCodeTokens,
    scoreFloor: config.scoreFloor,
  };

  // Generic tokens for concept matching come from the plan.
  const genericTokens = new Set<string>(
    (base.plan.unusedTokens ?? [])
      .filter((u: { reason: string }) => u.reason === "generic-verb")
      .map((u: { word: string }) => u.word),
  );

  const mapping = conceptIndex
    ? matchConceptsForQuery(base.tokens, genericTokens, conceptIndex)
    : null;

  // Category -> file set for affiliation (adaptive only). A concept file
  // belongs to exactly the category that matches its recorded role
  // (concept.fileRoles, from the indexed role data) — never to every
  // category the concept spans.
  const categoryToFiles = new Map<string, Set<string>>();
  const useAdaptiveCoverage = !!mapping && mapping.topConcepts.length > 0;
  if (useAdaptiveCoverage && mapping) {
    for (const c of mapping.topConcepts) {
      // Phase 1D (V7b): a concept whose files all lack indexed roles is
      // drilled under its own display name (coverage renamed the junk
      // "unclassified" layer), affiliating focused windows by its own
      // fileIds.
      const noRoles = c.discoveredCategories.length === 0;
      for (const cat of noRoles ? [c.displayName] : c.discoveredCategories) {
        const set = categoryToFiles.get(cat) ?? new Set<string>();
        if (noRoles) {
          for (const fid of c.fileIds) set.add(fid);
        } else {
          for (const fid of c.fileIds) {
            if (c.fileRoles[fid] === cat) set.add(fid);
          }
        }
        categoryToFiles.set(cat, set);
      }
    }
  }

  function evaluateCurrent(result: RetrievalResult): CoverageEvaluation {
    if (useAdaptiveCoverage && mapping && conceptIndex) {
      return evaluateCoverageAdaptive(base.plan, result, mapping, conceptIndex);
    }
    return evaluateCoverage(base.plan, result);
  }

  function affiliate(win: { fileId: string; path: string; reason: string }, category: string): boolean {
    if (useAdaptiveCoverage) {
      if (categoryToFiles.get(category)?.has(win.fileId)) return true;
      const roleMatch = ROLE_IN_REASON.exec(win.reason);
      if (roleMatch !== null && roleMatch[1] === category) return true;
    }
    const aff = CATEGORY_AFFILIATION[category];
    if (!aff) return false;
    const segments = win.path.toLowerCase().split("/");
    if (segments.some((segment) => aff.segments.includes(segment))) return true;
    const roleMatch = ROLE_IN_REASON.exec(win.reason);
    return roleMatch !== null && aff.roles.includes(roleMatch[1]!);
  }

  let coverage = evaluateCurrent(base);

  const buildResult = (): RetrievalResult => ({
    analysisId: base.analysisId,
    query: base.query,
    tokens: base.tokens,
    plan: base.plan,
    windows: [...windows],
    files: [...new Set(windows.map((w) => w.fileId))].map((fileId) => {
      const first = windows.find((w) => w.fileId === fileId)!;
      return {
        fileId,
        path: first.path,
        contentHash: first.contentHash,
        totalLines: first.totalLines,
        windows: windows
          .filter((w) => w.fileId === fileId)
          .map((w) => ({ startLine: w.startLine, endLine: w.endLine })),
      };
    }),
    symbols: symbolsState,
    totalCharacters,
    totalTokens,
    ...(renderedCharacters !== undefined ? { renderedCharacters } : {}),
    insufficientEvidence: windows.length === 0 && !base.packaging,
    // Packaging evidence is query-level, not window-level: it does not change
    // as the loop adds windows, so it is carried through unchanged.
    ...(base.packaging ? { packaging: base.packaging } : {}),
    ...(base.manifests ? { manifests: base.manifests } : {}),
  });

  const passes: IterationPass[] = [];
  let stoppedBecause: IterativeRetrievalResult["stoppedBecause"] = "max-passes";

  // Phase 1D (V10): when pass 0 already served a file the question names
  // outright ("file explicitly named in query"), the question's target is
  // explicit and the named file is the scope. Leftover missing categories —
  // self-named oov concepts (structural tokens the planner extracted from
  // the named path itself, e.g. "package" from package.json) as much as
  // planner/adaptive category pairs — must not be punched into the
  // repository: their focused queries match broad path or glossary noise
  // rather than anything scoped to the question, and the honest outcome —
  // the named file, plus unknown for every coverage claim the package
  // cannot establish — is already on the table. Drill widening resumes for
  // questions that do not name a file.
  const explicitAnchor = base.windows.some((w) =>
    w.reason.startsWith("file explicitly named in query"),
  );

  if (missingCategories(coverage).length === 0) {
    return {
      result: buildResult(),
      coverage,
      passes,
      stoppedBecause: "sufficient-coverage",
      totalMs: Math.round(performance.now() - startedAt),
    };
  }

  for (let pass = 1; pass <= config.maxPasses; pass += 1) {
    const missing = missingCategories(coverage);
    // (V10) An explicit anchor holds the question and its named file: no
    // speculative drills of any kind. Coverage keeps reporting every
    // unestablished claim as unknown; nothing new goes into the package.
    if (explicitAnchor) {
      stoppedBecause = missing.length > 0 ? "explicit-anchor" : "sufficient-coverage";
      break;
    }
    if (missing.length === 0) {
      stoppedBecause = "sufficient-coverage";
      break;
    }

    const pairs = missing.slice(0, 2);
    const passStartedAt = performance.now();
    const queries = pairs.map((pair) => focusedQuery(pair));
    const wanted = new Set(pairs.map((p) => p.category));
    const candidates: RetrievedWindow[] = [];

    for (const query of queries) {
      const focused = await retrieveGroundedContext(
        db,
        analysisId,
        query,
        { ...retrievalBudget, isIterativePass: true },
        conceptIndex,
      );
      // Absorb the focused pass's symbol rows so files newly introduced by
      // this pass carry their exact appendix cost at merge time (appendix
      // text is only attached when a file's exported symbols are known, and
      // `formatRetrievedContext` renders exactly `formatApiSurfaceFor`).
      const focusedByPath = new Map<string, NonNullable<RetrievalResult["symbols"]>>();
      for (const sym of focused.symbols ?? []) {
        const list = focusedByPath.get(sym.path) ?? [];
        list.push(sym);
        focusedByPath.set(sym.path, list);
      }
      for (const [path, list] of focusedByPath) {
        if (!symbolKnowledge.has(path)) symbolKnowledge.set(path, list);
      }
      for (const win of focused.windows) {
        // Per-pair acceptance (Phase 1D: V1/V7b self-named drills). A window
        // is a candidate when it affiliates with one of the missing pairs'
        // categories. A self-named pair (category === token — the concept's
        // own name after the V1/V7b renames; never "unclassified") instead
        // accepts every focused window: the drill already ran the concept's
        // own vocabulary, so whatever focused retrieval returned is
        // candidate evidence for it, and coverage — not this gate — decides
        // what the merged evidence actually proves.
        let aff: string | null = null;
        for (const pair of pairs) {
          if (pair.category === pair.token) {
            aff = pair.category;
            break;
          }
          if (useAdaptiveCoverage) {
            if (affiliate(win, pair.category)) { aff = pair.category; break; }
          } else if (windowAffiliation(win) === pair.category) {
            aff = pair.category;
            break;
          }
        }
        if (aff !== null && wanted.has(aff)) {
          if (!candidates.some((c) => c.fileId === win.fileId && c.startLine === win.startLine && c.endLine === win.endLine)) {
            candidates.push(win);
          }
        }
      }
    }

    // Protected files: source-text contributors to currently verified categories.
    const protectedFiles = new Set<string>();
    for (const concept of coverage.concepts) {
      for (const cat of concept.categories) {
        if (cat.status !== "found") continue;
        for (const ev of cat.evidence) {
          if (ev.signal !== "source-text") continue;
          const f = buildResult().files.find((x) => x.path === ev.path);
          if (f) protectedFiles.add(f.fileId);
        }
      }
    }

    const merged = mergeIterationWindows(
      {
        windows,
        totalCharacters,
        totalTokens,
        ...(renderedCharacters !== undefined ? { renderedCharacters } : {}),
      },
      candidates,
      limits,
      { allowReplacement: true, protectedFiles, replacementMargin: 10, appendixOf },
    );

    passes.push({
      pass,
      queries,
      categories: pairs.map((p) => p.category),
      addedWindows: merged.added,
      addedFiles: merged.addedFiles,
      replacedFiles: merged.replacedFiles,
      ms: Math.round(performance.now() - passStartedAt),
    });

    if (merged.added === 0) {
      stoppedBecause =
        merged.candidatesConsidered === 0
          ? "no-candidates"
          : merged.rejectedBudget > 0
            ? "budget-exhausted"
            : "no-candidates";
      break;
    }

    windows = merged.windows;
    totalCharacters = merged.totalCharacters;
    totalTokens = merged.totalTokens;
    renderedCharacters = merged.renderedCharacters;
    symbolsStale = true;
    coverage = evaluateCurrent(buildResult());

    if (missingCategories(coverage).length === 0) {
      stoppedBecause = "sufficient-coverage";
      break;
    }
    if (merged.added !== 0 && pass === config.maxPasses) {
      stoppedBecause = "max-passes";
    }
  }

  if (symbolsStale) {
    const ids = [...new Set(windows.map((w) => w.fileId))];
    if (ids.length === 0) {
      symbolsState = [];
    } else {
      const idSet = new Set(ids);
      try {
        const { data } = await (db as unknown as { from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => Promise<{ data: unknown; error: unknown }> } } })
          .from("symbols")
          .select("file_id, name, kind, line, end_line, exported, export_kind, signature, return_type, documentation")
          .eq("analysis_id", analysisId);
        const rows = (data ?? []) as Record<string, unknown>[];
        const pathById = new Map(windows.map((w) => [w.fileId, w.path]));
        symbolsState = rows
          .filter((s) => idSet.has(s.file_id as string))
          .map((s) => ({
            fileId: s.file_id as string,
            path: pathById.get(s.file_id as string) ?? "",
            name: s.name as string,
            kind: s.kind as string,
            line: s.line as number,
            ...(typeof s.end_line === "number" ? { endLine: s.end_line as number } : {}),
            exported: s.exported as boolean,
            ...(s.export_kind ? { exportKind: s.export_kind as string } : {}),
            ...(s.signature ? { signature: s.signature as string } : {}),
            ...(s.return_type ? { returnType: s.return_type as string } : {}),
            ...(s.documentation ? { documentation: s.documentation as string } : {}),
          }))
          .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.name.localeCompare(b.name));
      } catch {
        symbolsState = base.symbols ?? [];
      }
    }
  }

  return {
    result: buildResult(),
    coverage,
    passes,
    stoppedBecause,
    totalMs: Math.round(performance.now() - startedAt),
  };
}
