/**
 * Bounded iterative retrieval (Phase 6 of the coverage-driven Q&A plan).
 * Runs the existing deterministic retrieval pipeline, evaluates coverage
 * (lib/ai/coverage.ts) and, while the plan's expected evidence is not yet
 * established, performs targeted retrieval passes for the missing
 * (partial/unknown) categories — using the same indexed data and
 * relationship machinery, never an LLM.
 *
 * Guarantees:
 *  - Append-only merging: nothing is duplicated (exact or overlapping
 *    ranges skip; per-file window cap and global caps hold). Existing
 *    stronger evidence is never displaced by weaker targeted candidates.
 *  - The 16-file / 28k-character budget and the per-file window cap stay
 *    intact across all passes.
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
  retrieveGroundedContext,
  supportFilePenalty,
  type Db,
  type RetrievalBudget,
  type RetrievalResult,
  type RetrievedWindow,
} from "./retrieval.ts";

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
};

const DEFAULT_LOOP: Required<Pick<RetrievalLoopBudget, "maxPasses" | "scoreFloor">> = {
  maxPasses: 3,
  scoreFloor: 50,
};

/** Category vocabulary that drives the focused retrieval queries. */
export const CATEGORY_QUERY_WORDS: Record<string, string> = {
  controllers: "controller handler",
  middleware: "middleware",
  models: "model schema",
  services: "service",
  config: "config environment",
  routes: "route router endpoint",
  frontend: "frontend component client",
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
    | "budget-exhausted";
  totalMs: number;
};

type MissingPair = { token: string; category: string; status: string };

const ROLE_IN_REASON = /holds the "([a-z-]+)" role/;

function missingCategories(coverage: CoverageEvaluation): MissingPair[] {
  const missing: MissingPair[] = [];
  for (const concept of coverage.concepts) {
    for (const category of concept.categories) {
      if (category.status !== "found") {
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
  const words = CATEGORY_QUERY_WORDS[pair.category] ?? pair.category;
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
 * per-file window, file, and character caps. Candidates never displace
 * existing windows — the merge is append-only and drops everything that
 * does not fit.
 */
export function mergeIterationWindows(
  current: { windows: RetrievedWindow[]; totalCharacters: number },
  candidates: RetrievedWindow[],
  limits: { maxFiles: number; maxWindowsPerFile: number; maxCharacters: number; scoreFloor: number },
  options?: { allowReplacement?: boolean; protectedFiles?: Set<string>; replacementMargin?: number },
): {
  windows: RetrievedWindow[];
  totalCharacters: number;
  added: number;
  addedFiles: number;
  replacedFiles: number;
  rejectedBudget: number;
  candidatesConsidered: number;
} {
  const windows = [...current.windows];
  let totalCharacters = current.totalCharacters;
  // Fold stronger candidates first so the budget (char/file caps) is spent
  // on the most relevant evidence; sort by effective score (support files
  // demoted) to mirror the base pipeline's prioritization.
  const sortedCandidates = [...candidates].sort(
    (a, b) => (b.score - supportFilePenalty(b.path)) - (a.score - supportFilePenalty(a.path)) || a.path.localeCompare(b.path),
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
      if (files.size >= limits.maxFiles) {
        // File budget full. Displace only when explicitly allowed and only
        // the weakest, non-protected existing file that is strictly weaker
        // than the candidate: stronger direct evidence is never displaced,
        // and a file that is the sole source-text contributor to a currently
        // verified category is protected.
        let victim: string | null = null;
        let victimScore = Infinity;
        if (options?.allowReplacement) {
          const fileBest = new Map<string, number>();
          for (const w of windows) {
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
        }
        if (victim === null) {
          rejectedBudget += 1;
          continue; // file budget full, no eligible displacement
        }
        // Remove the displaced file's windows and free its slot/chars.
        for (const w of windows.filter((w) => w.fileId === victim)) totalCharacters -= w.text.length;
        const remaining = windows.filter((w) => w.fileId !== victim);
        windows.length = 0;
        windows.push(...remaining);
        files.delete(victim);
        perFile.delete(victim);
        replacedFiles += 1;
      }
    }
    if (totalCharacters + cand.text.length > limits.maxCharacters) {
      rejectedBudget += 1;
      continue;
    }
    windows.push(cand);
    totalCharacters += cand.text.length;
    perFile.set(cand.fileId, (perFile.get(cand.fileId) ?? 0) + 1);
    if (isNewFile) {
      files.add(cand.fileId);
      addedFiles += 1;
    }
    added += 1;
  }

  return { windows, totalCharacters, added, addedFiles, replacedFiles, rejectedBudget, candidatesConsidered };
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
  const { maxPasses, scoreFloor, ...retrievalBudget } = budget;
  const config = {
    maxPasses: maxPasses ?? DEFAULT_LOOP.maxPasses,
    scoreFloor: scoreFloor ?? DEFAULT_LOOP.scoreFloor,
  };
  const limits = {
    maxFiles: DEFAULT_BUDGET.maxFiles,
    maxWindowsPerFile: DEFAULT_BUDGET.maxWindowsPerFile,
    maxCharacters: DEFAULT_BUDGET.maxCharacters,
    scoreFloor: config.scoreFloor,
  };

  // Pass 0: the unchanged deterministic pipeline.
  const base = await retrieveGroundedContext(db, analysisId, rawQuery, retrievalBudget);
  let windows: RetrievedWindow[] = [...base.windows];
  let totalCharacters = base.totalCharacters;
  let coverage = evaluateCoverage(base.plan, base);

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
      };
    }),
    totalCharacters,
    insufficientEvidence: windows.length === 0,
  });

  const passes: IterationPass[] = [];
  let stoppedBecause: IterativeRetrievalResult["stoppedBecause"] = "max-passes";

  if (missingCategories(coverage).length === 0) {
    // Coverage already sufficient — direct behaviour, zero extra passes.
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
    if (missing.length === 0) {
      stoppedBecause = "sufficient-coverage";
      break;
    }

    // At most two focused retrievals per pass (priority: partial first).
    const pairs = missing.slice(0, 2);
    const passStartedAt = performance.now();
    const queries = pairs.map((pair) => focusedQuery(pair));
    const wanted = new Set(pairs.map((p) => p.category));
    const candidates: RetrievedWindow[] = [];

    for (const query of queries) {
      const focused = await retrieveGroundedContext(db, analysisId, query, retrievalBudget);
      for (const win of focused.windows) {
        // Targeted retrieval must add evidence for the missing category,
        // not more of what was already established.
        if (wanted.has(windowAffiliation(win) ?? ""))
          candidates.push(win);
      }
    }

    // Protected files: those contributing source-text to a currently verified
    // category. They may never be displaced by targeted evidence.
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
    // Merge: dedupe, caps, char/file budget, provenance intact. Displacement
    // is allowed only for strictly weaker, non-protected files, so stronger
    // direct evidence is never displaced (Phase 6 rule) while a saturated
    // budget can still admit strictly stronger targeted evidence.
    const merged = mergeIterationWindows(
      { windows, totalCharacters },
      candidates,
      limits,
      { allowReplacement: true, protectedFiles, replacementMargin: 10 },
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
    coverage = evaluateCoverage(base.plan, buildResult());

    if (missingCategories(coverage).length === 0) {
      stoppedBecause = "sufficient-coverage";
      break;
    }
    if (merged.added !== 0 && pass === config.maxPasses) {
      stoppedBecause = "max-passes";
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
