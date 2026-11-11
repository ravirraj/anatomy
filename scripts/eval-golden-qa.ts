// CI-6: Deterministic QA Evaluation Engine
// Evaluates retrieval evidence precision/recall, structured fact grounding,
// response policies (abstention & scoped negative claims), and citation validity
// across the 16 golden evaluation cases with zero external dependencies.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeEvidenceLimits, retrieveGroundedContext, type RetrievalBudget } from "../lib/ai/retrieval.ts";
import { retrieveWithCoverageLoop } from "../lib/ai/retrieval-loop.ts";
import { verifyCitations, type FileEvidence } from "../lib/ai/citations.ts";
import { FIXTURES } from "./test-fixtures-shared.ts";
import { createFixtureContext, type FixtureContext } from "./eval-fixture-adapter.ts";
import { validatePredicateSemantics } from "./test-golden-dataset.ts";

type Range = [number, number];

type RelevantFile = {
  path: string;
  ranges: Range[];
};

type FactPredicate = {
  /**
   * Predicate kind distinguishing syntactic declaration, invocation, and manifest specification:
   * - 'declares_symbol': Syntactic declaration statement (function, class, const, etc.) in source code.
   * - 'calls': Syntactic call expression callee(...) in caller scope (not runtime invocation).
   * - 'imports': Syntactic import/require statement (not verified runtime execution).
   * - 're_exports': Syntactic module re-export statement.
   * - 'declares_dependency': Manifest dependency declaration (not verified installation).
   * - 'reads_config': Syntactic configuration reference pattern (process.env, import.meta.env).
   * - 'scoped_absence': Verified non-presence of a symbol/specifier within an authoritative container.
   */
  predicate: string;
  evidence: {
    path: string;
    lines: Range;
  };
  symbol?: string;
  kind?: string;
  caller?: string;
  callee?: string;
  importer?: string;
  specifier?: string;
  importedSymbols?: string[];
  exportedSymbol?: string;
  sourceModule?: string;
  isWildcard?: boolean;
  manifest?: string;
  package?: string;
  version?: string;
  file?: string;
  variable?: string;
  pattern?: string;
  target?: string;
  absentSymbol?: string;
  scopeKind?: string;
};

type GoldenCase = {
  id: string;
  fixture: string;
  category: string;
  language: string;
  question: string;
  expectedOutcome: "grounded_answer" | "grounded_scoped_negative" | "abstain_no_evidence";
  retrievalExpectation: {
    mustRetrieve: boolean;
    relevantFiles: RelevantFile[];
  };
  policyExpectation?: {
    topic: string;
    retrievalMustBeEmpty: boolean;
    allowFabricatedCitations: boolean;
  };
  expectedFacts: FactPredicate[];
};

type CapabilityEntry = {
  language: string;
  manifestSupport: "supported" | "unsupported";
  symbolExtraction: "supported" | "unsupported";
  importModuleExtraction: "supported" | "unsupported";
  callGraphExtraction: "supported" | "unsupported";
  goldenCasesAvailable: string[];
  unsupportedCapabilities: string[];
};

type GoldenDataset = {
  version: number;
  description: string;
  capabilityMatrix: CapabilityEntry[];
  cases: GoldenCase[];
};

type CaseMetric = {
  id: string;
  fixture: string;
  language: string;
  category: string;
  goldLines: number;
  retrievedWindows: number;
  retrievedLines: number;
  overlapLines: number;
  linePrecision: number | null;
  lineRecall: number | null;
  lineF1: number | null;
  factsTotal: number;
  factsGrounded: number;
  policyVerified: boolean;
  status: "PASS" | "WARN" | "FAIL";
  detail?: string;
  retrieval: RetrievalCaseMeasurement;
};

/** Merges overlapping or adjacent [start, end] intervals to prevent double-counting. */
export function mergeIntervals(ranges: Range[]): Range[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Range[] = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const prev = merged[merged.length - 1]!;
    if (current[0] <= prev[1] + 1) {
      prev[1] = Math.max(prev[1], current[1]);
    } else {
      merged.push(current);
    }
  }
  return merged;
}

/** Computes the total number of lines in a list of disjoint intervals. */
export function countIntervalLines(intervals: Range[]): number {
  return intervals.reduce((acc, [start, end]) => acc + (end - start + 1), 0);
}

/** Computes the line overlap between two lists of intervals for a file. */
export function calculateIntervalOverlap(a: Range[], b: Range[]): number {
  let overlap = 0;
  for (const [aStart, aEnd] of a) {
    for (const [bStart, bEnd] of b) {
      const start = Math.max(aStart, bStart);
      const end = Math.min(aEnd, bEnd);
      if (start <= end) {
        overlap += (end - start + 1);
      }
    }
  }
  return overlap;
}

// ── Phase 3B.1: deterministic retrieval measurement (informational) ──────────
//
// Pure helpers that measure what the coverage loop actually served, in final
// serving order, without ever running retrieval a second time and without
// touching engine behaviour. Every value derives from actual ledger results
// and loop pass records; timing fields (ms) are deliberately excluded so
// repeated evaluations serialize byte-identically.
//
// Measurement semantics (documented, deliberate):
// - Ranking is per FILE, not per window: a file's rank is the position of its
//   first served occurrence among DISTINCT files in the final serving order.
//   Window order inside a file is a fitting artifact and carries no rank info.
// - A case's reciprocal rank uses the first relevant file served (1/rank);
//   a relevant file that never appears serves reciprocal rank 0. MRR is the
//   mean over positive cases only; the positiveCaseCount is the denominator
//   and is reported alongside. Abstention cases (no relevant files) are N/A
//   (null per-case fields) and are excluded from the aggregate.
// - Recall@3 counts distinct relevant files among the first 3 distinct served
//   files, divided by the case's total relevant-file count. The aggregate is
//   the macro average (unweighted mean of per-case values over positive
//   cases; positiveCaseCount again reported explicitly).
// - Budget utilization divides the ACTUAL returned ledger values
//   (renderedCharacters / totalTokens) by evidence limits recomputed with the
//   exact shared helper and arguments the pipeline uses. The RetrievalResult
//   itself does not carry its limits; the golden evaluation runs profile-free
//   with an empty retrieval budget, so the mirror yields the same constants
//   the pipeline computed (maxCharacters = 28000, maxTokens = ceil(28000/3)).
//   If a budget or provider profile is ever introduced here, this mirror must
//   be revisited. Utilization is never clamped — a value above 1 would
//   surface as-is. A zero limit or a missing operand yields null (not
//   Infinity, not 0).
// - The stop reason is preserved verbatim from the loop; it is never inferred
//   from other metrics. --single-pass runs bypass the coverage loop, so their
//   loop metadata is null (unmeasured), not invented.
// - Wasted-pass ratio counts recorded passes whose ledger shows
//   addedWindows === 0 over the passes the loop actually recorded. An absent
//   pass record (--single-pass) is never counted as a zero-addition pass.
//   Zero recorded passes (e.g. a sufficient-coverage stop at pass 0) mean
//   nothing can be wasted: the ratio is null and the case is excluded from
//   the aggregate mean.
//
// Phase 3B.2 adds, on the same one-run contract: per-window pass provenance
// from the loop's actual merge events (never reconstructed from final
// windows alone), historical post-pass gold-yield snapshots (cumulative and
// marginal, double-count-free), per-pass rejection accounting (with the
// quality/budget counter split fixing stop-reason classification), and
// per-pass enforced-ledger deltas. All additive: every 3B.1 field, shape and
// value is unchanged.

export type RetrievalPassRecord = {
  pass: number;
  queries: string[];
  categories: string[];
  addedWindows: number;
  addedFiles: number;
  replacedFiles: number;
};

export type RetrievalCaseRanking = {
  relevantFileCount: number;
  servedFileOrder: string[];
  firstRelevantFileRank: number | null;
  reciprocalRank: number | null;
  recallAt3: number | null;
};

export type RetrievalCaseBudget = {
  maxCharacters: number;
  maxTokens: number;
  renderedCharacters: number | null;
  totalTokens: number | null;
  characterUtilization: number | null;
  tokenUtilization: number | null;
};

export type RetrievalCaseLoop = {
  stoppedBecause: string | null;
  passCount: number | null;
  wastedPassNumerator: number | null;
  wastedPassDenominator: number | null;
  wastedPassRatio: number | null;
  passes: RetrievalPassRecord[] | null;
};

export type RetrievalCaseMeasurement = {
  isPositive: boolean;
  ranking: RetrievalCaseRanking;
  budget: RetrievalCaseBudget;
  loop: RetrievalCaseLoop;
  // ── Phase 3B.2 (additive): provenance, gold yield, per-pass ledger ──────────
  /** Final retained-window pass attribution (null when unmeasured). */
  provenance: CaseProvenanceMeasurement | null;
  /** Cumulative/marginal gold evidence after pass 0 and each targeted pass
   * (null when unmeasured). `cumulativeRecall` is null for abstention cases. */
  goldTrace: GoldYieldPassRecord[] | null;
  /** Per targeted pass: rejection accounting and enforced-ledger deltas
   * (null fields where the loop did not expose the value). */
  passLedger: CasePassMeasurement[] | null;
};

export type RetrievalAggregate = {
  schemaVersion: 1;
  ranking: {
    fileMRR: { value: number | null; positiveCaseCount: number };
    recallAt3: { value: number | null; positiveCaseCount: number };
  };
  budget: {
    meanCharacterUtilization: number | null;
    meanTokenUtilization: number | null;
    characterEligibleCaseCount: number;
    tokenEligibleCaseCount: number;
  };
  loop: {
    meanWastedPassRatio: number | null;
    wastedPassEligibleCaseCount: number;
    stopReasonCounts: Record<string, number>;
    unmeasuredStopReasonCaseCount: number;
    // ── Phase 3B.2 (additive) ──────────────────────────────────────────────────
    /** Candidate rejection accounting summed over every measured targeted
     * pass, covering the full funnel: focused windows seen, affiliation
     * rejections, intra-pass duplicates, collected candidates, candidates
     * considered at the merge, and the merge's rejection counters. */
    rejectionCounts: {
      considered: number;
      overlap: number;
      perFileCap: number;
      quality: number;
      budget: number;
      focusedWindows: number;
      affiliationRejected: number;
      intraPassDuplicates: number;
      collected: number;
    };
  };
  // ── Phase 3B.2 (additive) ────────────────────────────────────────────────────
  /** Retained-window pass attribution across all measured cases. */
  provenance: {
    casesMeasured: number;
    totalRetainedWindows: number;
    byOriginPass: Record<string, number>;
  };
  /** Marginal gold-evidence totals across measured cases. The marginal
   * telescopes: the sum equals the final gold overlap of the measured cases. */
  gold: {
    casesMeasured: number;
    totalMarginalGoldLines: number;
    totalAddedGoldEvidencePasses: number;
  };
};

/** Minimal window identity shared by the 3B.2 trace structures. */
export type PassWindowSnapshot = {
  fileId: string;
  path: string;
  startLine: number;
  endLine: number;
};

/** Loop metadata the measurement consumes, stripped of timing. `null` means
 * the coverage loop never ran (--single-pass / unmeasured). Phase 3B.2 adds
 * optional trace fields (absent for `--single-pass` runs). */
export type RetrievalLoopMetadata = {
  stoppedBecause: string | null;
  passes: {
    pass: number;
    queries: string[];
    categories: string[];
    addedWindows: number;
    addedFiles: number;
    replacedFiles: number;
    candidatesConsidered?: number;
    rejectedOverlap?: number;
    rejectedPerFileCap?: number;
    rejectedQuality?: number;
    rejectedBudget?: number;
    windowsAfterPass?: PassWindowSnapshot[];
    charactersBefore?: number;
    renderedCharactersBefore?: number;
    tokensBefore?: number;
    charactersAfter?: number;
    renderedCharactersAfter?: number;
    tokensAfter?: number;
    replacedCharacters?: number;
    replacedTokens?: number;
    remainingCharacters?: number;
    remainingTokens?: number;
    focusedWindowsSeen?: number;
    affiliationRejected?: number;
    intraPassDuplicates?: number;
    candidatesCollected?: number;
  }[];
  /** Pass-0 window state and final per-window pass attribution. */
  initialWindows?: PassWindowSnapshot[];
  windowProvenance?: { fileId: string; path: string; startLine: number; endLine: number; originPass: number }[];
};

/** Distinct files ordered by their first appearance in final serving order. */
export function computeServedFileOrder(windows: { path: string }[]): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const w of windows) {
    if (seen.has(w.path)) continue;
    seen.add(w.path);
    order.push(w.path);
  }
  return order;
}

export type FileRankingResult = {
  firstRelevantFileRank: number | null;
  reciprocalRank: number | null;
  recallAt3: number | null;
};

/** File-level ranking for one case. A case with no relevant files (abstention)
 * has no ranking to measure: every field is N/A (null). */
export function computeFileRanking(servedFileOrder: string[], relevantPaths: string[], topK = 3): FileRankingResult {
  const relevant = new Set(relevantPaths);
  if (relevant.size === 0) {
    return { firstRelevantFileRank: null, reciprocalRank: null, recallAt3: null };
  }
  let firstRelevantFileRank: number | null = null;
  for (let i = 0; i < servedFileOrder.length; i++) {
    if (relevant.has(servedFileOrder[i]!)) {
      firstRelevantFileRank = i + 1;
      break;
    }
  }
  const relevantInTopK = new Set(servedFileOrder.slice(0, topK).filter((p) => relevant.has(p)));
  return {
    firstRelevantFileRank,
    reciprocalRank: firstRelevantFileRank !== null ? 1 / firstRelevantFileRank : 0,
    recallAt3: relevantInTopK.size / relevant.size,
  };
}

/** Budget utilization from actual ledger values (see block comment above).
 * The limits mirror the pipeline's own computation: same shared helper, same
 * arguments. The eval never passes a retrieval budget, so the argument stays
 * the default empty object. */
export function computeCaseBudget(
  ledger: { query: string; renderedCharacters?: number; totalTokens?: number; packaging?: string },
  budget: RetrievalBudget = {},
): RetrievalCaseBudget {
  const limits = computeEvidenceLimits(budget, ledger.query, ledger.packaging ?? "");
  const renderedCharacters = typeof ledger.renderedCharacters === "number" ? ledger.renderedCharacters : null;
  const totalTokens = typeof ledger.totalTokens === "number" ? ledger.totalTokens : null;
  return {
    maxCharacters: limits.maxCharacters,
    maxTokens: limits.maxTokens,
    renderedCharacters,
    totalTokens,
    characterUtilization:
      limits.maxCharacters > 0 && renderedCharacters !== null ? renderedCharacters / limits.maxCharacters : null,
    tokenUtilization: limits.maxTokens > 0 && totalTokens !== null ? totalTokens / limits.maxTokens : null,
  };
}

/** Pass-record metadata and stop-reason passthrough. Zero recorded passes keep
 * the wasted ratio at null (nothing can be wasted); zero-addition passes are
 * only counted from records that actually exist. `ms` is dropped here so the
 * measurement is timing-free and byte-deterministic. */
export function computeCaseLoop(loop: RetrievalLoopMetadata | null): RetrievalCaseLoop {
  if (loop === null) {
    return { stoppedBecause: null, passCount: null, wastedPassNumerator: null, wastedPassDenominator: null, wastedPassRatio: null, passes: null };
  }
  const passes: RetrievalPassRecord[] = loop.passes.map((p) => ({
    pass: p.pass,
    queries: [...p.queries],
    categories: [...p.categories],
    addedWindows: p.addedWindows,
    addedFiles: p.addedFiles,
    replacedFiles: p.replacedFiles,
  }));
  const denominator = passes.length;
  const numerator = passes.filter((p) => p.addedWindows === 0).length;
  return {
    stoppedBecause: loop.stoppedBecause,
    passCount: denominator,
    wastedPassNumerator: numerator,
    wastedPassDenominator: denominator,
    wastedPassRatio: denominator > 0 ? numerator / denominator : null,
    passes,
  };
}

// ── Phase 3B.2: per-pass attribution, gold yield, ledger deltas ──────────────
//
// Pure helpers over the loop's actual trace events (pass snapshots and merge
// outcomes). The gold-overlap interpretation is exactly the existing golden
// evaluator's: per-file merged retrieved intervals vs merged gold intervals
// (mergeIntervals + calculateIntervalOverlap), so the FINAL cumulative
// overlap of a case's gold trace must equal its `overlapLines` metric and the
// final cumulative recall must equal its `lineRecall`.

export type GoldYieldPassRecord = {
  /** Pass number: 0 = the base retrieval, then each targeted pass. */
  pass: number;
  /** Distinct retained windows after this pass (historical snapshot). */
  windowCount: number;
  /** Gold-overlap lines (merged, double-count-free) after this pass. */
  cumulativeGoldOverlapLines: number;
  /** Distinct relevant files represented after this pass. */
  cumulativeRelevantFiles: number;
  /** Additional gold-overlap lines this pass contributed. A net delta of the
   * cumulative (merged) overlap — it can go negative when a replacement
   * removes previously covered gold lines; overlapping windows can never
   * double-count the same gold line. */
  marginalGoldLines: number;
  /** Relevant files newly represented by this pass (net delta; each file
   * counted once, negative when a replacement removes a relevant file). */
  marginalRelevantFiles: number;
  /** cumulativeGoldOverlapLines / total gold lines (null for abstention). */
  cumulativeRecall: number | null;
};

/** Cumulative and marginal gold evidence from actual post-pass snapshots.
 * Marginals are differences of cumulative (merged) overlaps, so the same gold
 * line is never double-counted across overlapping windows or passes. */
export function computeGoldYieldTrace(
  initialWindows: PassWindowSnapshot[],
  passes: { pass: number; windowsAfterPass?: PassWindowSnapshot[] }[],
  goldIntervalsByPath: Map<string, Range[]>,
  totalGoldLines: number,
): GoldYieldPassRecord[] {
  const relevantPaths = new Set(goldIntervalsByPath.keys());
  const snapshots: { pass: number; windows: PassWindowSnapshot[] }[] = [
    { pass: 0, windows: initialWindows },
    ...passes.map((p) => ({ pass: p.pass, windows: p.windowsAfterPass ?? [] })),
  ];
  const records: GoldYieldPassRecord[] = [];
  let previousOverlap = 0;
  let previousRelevantFiles = 0;
  for (const snapshot of snapshots) {
    const byPath = new Map<string, Range[]>();
    for (const w of snapshot.windows) {
      const list = byPath.get(w.path) ?? [];
      list.push([w.startLine, w.endLine]);
      byPath.set(w.path, list);
    }
    let overlap = 0;
    for (const [p, intervals] of byPath) {
      const gold = goldIntervalsByPath.get(p);
      if (!gold) continue;
      overlap += calculateIntervalOverlap(mergeIntervals(intervals), gold);
    }
    const relevantFiles = new Set(
      snapshot.windows.filter((w) => relevantPaths.has(w.path)).map((w) => w.path),
    ).size;
    records.push({
      pass: snapshot.pass,
      windowCount: snapshot.windows.length,
      cumulativeGoldOverlapLines: overlap,
      cumulativeRelevantFiles: relevantFiles,
      marginalGoldLines: overlap - previousOverlap,
      marginalRelevantFiles: relevantFiles - previousRelevantFiles,
      cumulativeRecall: totalGoldLines > 0 ? overlap / totalGoldLines : null,
    });
    previousOverlap = overlap;
    previousRelevantFiles = relevantFiles;
  }
  return records;
}

export type CaseProvenanceMeasurement = {
  /** Pass-0 baseline evidence: windows and files the base retrieval served. */
  initialWindowCount: number;
  initialFileCount: number;
  /** Final retained windows — always equals the case's served window count. */
  retainedWindowCount: number;
  /** Retained windows keyed by their origin pass ("0", "1", …). */
  retainedByOrigin: Record<string, number>;
  /** Final retained windows with their contributing pass. */
  windows: { fileId: string; path: string; startLine: number; endLine: number; originPass: number }[];
};

/** Final retained-window pass attribution from the loop's provenance ledger.
 * Null when the loop did not run (unmeasured), never inferred. */
export function computeCaseProvenance(loop: RetrievalLoopMetadata | null): CaseProvenanceMeasurement | null {
  if (loop === null || loop.initialWindows === undefined || loop.windowProvenance === undefined) return null;
  const retainedByOrigin: Record<string, number> = {};
  for (const w of loop.windowProvenance) {
    const key = String(w.originPass);
    retainedByOrigin[key] = (retainedByOrigin[key] ?? 0) + 1;
  }
  return {
    initialWindowCount: loop.initialWindows.length,
    initialFileCount: new Set(loop.initialWindows.map((w) => w.fileId)).size,
    retainedWindowCount: loop.windowProvenance.length,
    retainedByOrigin,
    windows: loop.windowProvenance.map((w) => ({
      fileId: w.fileId,
      path: w.path,
      startLine: w.startLine,
      endLine: w.endLine,
      originPass: w.originPass,
    })),
  };
}

export type CasePassMeasurement = {
  pass: number;
  addedWindows: number;
  addedFiles: number;
  replacedFiles: number;
  /** Rejection accounting from the merge outcome (null when unexposed). */
  candidatesConsidered: number | null;
  rejectedOverlap: number | null;
  rejectedPerFileCap: number | null;
  rejectedQuality: number | null;
  rejectedBudget: number | null;
  /** Full candidate funnel above the merge (null when unexposed):
   * focusedWindowsSeen = affiliationRejected + intraPassDuplicates +
   * candidatesCollected → candidatesConsidered at the merge. */
  focusedWindowsSeen: number | null;
  affiliationRejected: number | null;
  intraPassDuplicates: number | null;
  candidatesCollected: number | null;
  /** Whether the pass added gold evidence — separate from whether it added
   * any window at all (the wasted-pass definition stays addedWindows === 0). */
  addedGoldEvidence: boolean | null;
  marginalGoldLines: number | null;
  marginalRelevantFiles: number | null;
  cumulativeRecall: number | null;
  /** Net enforced-ledger change across the pass (after − before). */
  charactersDelta: number | null;
  renderedCharactersDelta: number | null;
  tokensDelta: number | null;
  /** Absolute enforced-ledger figures around the pass (before → after), so
   * consecutive passes can be reconciled: pass k's before equals pass k−1's
   * after. Null where the base result carried no figure. */
  charactersBefore: number | null;
  charactersAfter: number | null;
  renderedCharactersBefore: number | null;
  renderedCharactersAfter: number | null;
  tokensBefore: number | null;
  tokensAfter: number | null;
  /** Served cost released through committed replacements. */
  replacedCharacters: number | null;
  replacedTokens: number | null;
  /** Remaining evidence budget after the pass (limits − after figures). */
  remainingCharacters: number | null;
  remainingTokens: number | null;
};

/** Per targeted pass: rejection counts and ledger deltas from the loop trace,
 * joined with the case's gold-yield trace. One measurement per recorded pass;
 * pass 0's baseline evidence lives in the gold trace and the provenance
 * measurement, not here. */
export function computeCasePassMeasurements(
  loop: RetrievalLoopMetadata | null,
  goldTrace: GoldYieldPassRecord[] | null,
): CasePassMeasurement[] {
  if (loop === null) return [];
  const goldByPass = new Map((goldTrace ?? []).map((g) => [g.pass, g]));
  const delta = (before?: number, after?: number): number | null =>
    typeof before === "number" && typeof after === "number" ? after - before : null;
  return loop.passes.map((p) => {
    const gold = goldByPass.get(p.pass) ?? null;
    return {
      pass: p.pass,
      addedWindows: p.addedWindows,
      addedFiles: p.addedFiles,
      replacedFiles: p.replacedFiles,
      candidatesConsidered: p.candidatesConsidered ?? null,
      rejectedOverlap: p.rejectedOverlap ?? null,
      rejectedPerFileCap: p.rejectedPerFileCap ?? null,
      rejectedQuality: p.rejectedQuality ?? null,
      rejectedBudget: p.rejectedBudget ?? null,
      focusedWindowsSeen: p.focusedWindowsSeen ?? null,
      affiliationRejected: p.affiliationRejected ?? null,
      intraPassDuplicates: p.intraPassDuplicates ?? null,
      candidatesCollected: p.candidatesCollected ?? null,
      addedGoldEvidence: gold ? gold.marginalGoldLines > 0 : null,
      marginalGoldLines: gold ? gold.marginalGoldLines : null,
      marginalRelevantFiles: gold ? gold.marginalRelevantFiles : null,
      cumulativeRecall: gold ? gold.cumulativeRecall : null,
      charactersDelta: delta(p.charactersBefore, p.charactersAfter),
      renderedCharactersDelta: delta(p.renderedCharactersBefore, p.renderedCharactersAfter),
      tokensDelta: delta(p.tokensBefore, p.tokensAfter),
      charactersBefore: p.charactersBefore ?? null,
      charactersAfter: p.charactersAfter ?? null,
      renderedCharactersBefore: p.renderedCharactersBefore ?? null,
      renderedCharactersAfter: p.renderedCharactersAfter ?? null,
      tokensBefore: p.tokensBefore ?? null,
      tokensAfter: p.tokensAfter ?? null,
      replacedCharacters: p.replacedCharacters ?? null,
      replacedTokens: p.replacedTokens ?? null,
      remainingCharacters: p.remainingCharacters ?? null,
      remainingTokens: p.remainingTokens ?? null,
    };
  });
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((acc, v) => acc + v, 0) / values.length;
}

/** Aggregates per-case measurements over the full evaluated case list. Means
 * are computed in case order so serialization is deterministic; every
 * aggregate reports its own eligible-case denominator for auditability. */
export function aggregateRetrieval(measurements: RetrievalCaseMeasurement[]): RetrievalAggregate {
  const positive = measurements.filter((m) => m.isPositive);
  const charEligible = measurements.filter((m) => m.budget.characterUtilization !== null);
  const tokenEligible = measurements.filter((m) => m.budget.tokenUtilization !== null);
  const wastedEligible = measurements.filter((m) => m.loop.wastedPassRatio !== null);

  const stopReasonCounts: Record<string, number> = {};
  let unmeasuredStopReasonCaseCount = 0;
  for (const m of measurements) {
    const reason = m.loop.stoppedBecause;
    if (reason === null) unmeasuredStopReasonCaseCount++;
    else stopReasonCounts[reason] = (stopReasonCounts[reason] ?? 0) + 1;
  }

  // Phase 3B.2 aggregates: retained-window origin attribution and candidate
  // rejection accounting, summed over measured cases in case order.
  const provenanceMeasured = measurements.filter((m) => m.provenance !== null);
  const goldMeasured = measurements.filter((m) => m.goldTrace !== null);
  const byOriginPass: Record<string, number> = {};
  let totalRetainedWindows = 0;
  for (const m of provenanceMeasured) {
    totalRetainedWindows += m.provenance!.retainedWindowCount;
    for (const [origin, count] of Object.entries(m.provenance!.retainedByOrigin)) {
      byOriginPass[origin] = (byOriginPass[origin] ?? 0) + count;
    }
  }
  const rejectionCounts = { considered: 0, overlap: 0, perFileCap: 0, quality: 0, budget: 0, focusedWindows: 0, affiliationRejected: 0, intraPassDuplicates: 0, collected: 0 };
  let totalMarginalGoldLines = 0;
  let totalAddedGoldEvidencePasses = 0;
  for (const m of measurements) {
    for (const p of m.passLedger ?? []) {
      rejectionCounts.considered += p.candidatesConsidered ?? 0;
      rejectionCounts.overlap += p.rejectedOverlap ?? 0;
      rejectionCounts.perFileCap += p.rejectedPerFileCap ?? 0;
      rejectionCounts.quality += p.rejectedQuality ?? 0;
      rejectionCounts.budget += p.rejectedBudget ?? 0;
      rejectionCounts.focusedWindows += p.focusedWindowsSeen ?? 0;
      rejectionCounts.affiliationRejected += p.affiliationRejected ?? 0;
      rejectionCounts.intraPassDuplicates += p.intraPassDuplicates ?? 0;
      rejectionCounts.collected += p.candidatesCollected ?? 0;
    }
    const lastTrace = m.goldTrace?.[m.goldTrace.length - 1];
    totalMarginalGoldLines += lastTrace?.cumulativeGoldOverlapLines ?? 0;
    totalAddedGoldEvidencePasses += (m.passLedger ?? []).filter((p) => p.addedGoldEvidence === true).length;
  }

  return {
    schemaVersion: 1,
    ranking: {
      fileMRR: {
        value: mean(positive.map((m) => m.ranking.reciprocalRank ?? 0)),
        positiveCaseCount: positive.length,
      },
      recallAt3: {
        value: mean(positive.map((m) => m.ranking.recallAt3 ?? 0)),
        positiveCaseCount: positive.length,
      },
    },
    budget: {
      meanCharacterUtilization: mean(charEligible.map((m) => m.budget.characterUtilization!)),
      meanTokenUtilization: mean(tokenEligible.map((m) => m.budget.tokenUtilization!)),
      characterEligibleCaseCount: charEligible.length,
      tokenEligibleCaseCount: tokenEligible.length,
    },
    loop: {
      meanWastedPassRatio: mean(wastedEligible.map((m) => m.loop.wastedPassRatio!)),
      wastedPassEligibleCaseCount: wastedEligible.length,
      stopReasonCounts,
      unmeasuredStopReasonCaseCount,
      rejectionCounts,
    },
    provenance: {
      casesMeasured: provenanceMeasured.length,
      totalRetainedWindows,
      byOriginPass,
    },
    gold: {
      casesMeasured: goldMeasured.length,
      totalMarginalGoldLines,
      totalAddedGoldEvidencePasses,
    },
  };
}

interface EvalOptions {
  caseId?: string;
  filter?: string;
  json?: boolean;
  markdown?: boolean;
  failOnWarn?: boolean;
  /** Freeze pass-0 behavior: run the unchanged deterministic pipeline once
   * per case (used to compare engine baselines; default is the production
   * coverage loop). */
  singlePass?: boolean;
}

function printHelp(): void {
  console.log(`
Usage: node scripts/eval-golden-qa.ts [options]

Options:
  -c, --case <id>      Run evaluation for a specific case ID (e.g. QA-04)
  -f, --filter <term>  Filter cases matching term in ID, fixture, category, or language
  --json               Output machine-readable JSON evaluation report
  --markdown, --md     Output GitHub Flavored Markdown table and summary
  --fail-on-warn       Exit with non-zero code (1) if any diagnostic precision warnings occur
  --single-pass        Run the frozen pass-0 pipeline instead of the coverage loop (baseline comparison)
  -h, --help           Show this help message
`);
}

function parseCliArgs(argv: string[]): EvalOptions {
  const options: EvalOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if ((arg === "--case" || arg === "-c") && i + 1 < argv.length) {
      options.caseId = argv[++i];
    } else if (arg.startsWith("--case=")) {
      options.caseId = arg.slice(7);
    } else if ((arg === "--filter" || arg === "-f") && i + 1 < argv.length) {
      options.filter = argv[++i];
    } else if (arg.startsWith("--filter=")) {
      options.filter = arg.slice(9);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--markdown" || arg === "--md") {
      options.markdown = true;
    } else if (arg === "--fail-on-warn") {
      options.failOnWarn = true;
    } else if (arg === "--single-pass") {
      options.singlePass = true;
    } else {
      console.error(`Unknown argument: "${arg}". Use --help for usage.`);
      process.exit(1);
    }
  }
  return options;
}

async function runEvaluation(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));

  const dataPath = path.join(FIXTURES, "golden-qa.json");
  if (!existsSync(dataPath)) {
    console.error(`Dataset not found at ${dataPath}`);
    process.exit(1);
  }

  const dataset = JSON.parse(readFileSync(dataPath, "utf8")) as GoldenDataset;

  let cases = dataset.cases;
  if (options.caseId) {
    const id = options.caseId.toLowerCase();
    cases = cases.filter((c) => c.id.toLowerCase() === id);
    if (cases.length === 0) {
      console.error(`No case found with ID matching "${options.caseId}"`);
      process.exit(1);
    }
  } else if (options.filter) {
    const filter = options.filter.toLowerCase();
    cases = cases.filter(
      (c) =>
        c.id.toLowerCase().includes(filter) ||
        c.category.toLowerCase().includes(filter) ||
        c.language.toLowerCase().includes(filter) ||
        c.fixture.toLowerCase().includes(filter),
    );
    if (cases.length === 0) {
      console.error(`No cases found matching filter "${options.filter}"`);
      process.exit(1);
    }
  }

  if (!options.json && !options.markdown) {
    console.log("================================================================================");
    console.log("CI-6: Deterministic QA Evaluation Engine");
    console.log("================================================================================\n");
  }

  const fixtureContexts = new Map<string, FixtureContext>();
  function getContext(fixture: string): FixtureContext {
    let ctx = fixtureContexts.get(fixture);
    if (!ctx) {
      ctx = createFixtureContext(fixture);
      fixtureContexts.set(fixture, ctx);
    }
    return ctx;
  }

  const caseMetrics: CaseMetric[] = [];

  for (const c of cases) {
    const ctx = getContext(c.fixture);

    // 1. Run the production QA evidence path (Phase 1D, Batch D): the
    // coverage loop owns retrieval — pass 0 is the unchanged deterministic
    // pipeline, targeted passes add what coverage says the plan missed.
    // --single-pass freezes the pass-0-only baseline for engine comparison.
    // Phase 3B.1: the loop return (passes, stoppedBecause) is captured for
    // the informational retrieval measurement below; retrieval still runs
    // exactly once per case.
    const loopInfo = options.singlePass ? null : await retrieveWithCoverageLoop(ctx.db, ctx.analysisId, c.question);
    const retrievalResult = options.singlePass
      ? await retrieveGroundedContext(ctx.db, ctx.analysisId, c.question)
      : loopInfo!.result;
    const windows = retrievalResult.windows;

    // 2. Group and merge retrieved intervals by file
    const retrievedIntervalsByPath = new Map<string, Range[]>();
    for (const w of windows) {
      const list = retrievedIntervalsByPath.get(w.path) ?? [];
      list.push([w.startLine, w.endLine]);
      retrievedIntervalsByPath.set(w.path, list);
    }

    const mergedRetrievedByPath = new Map<string, Range[]>();
    let totalRetrievedLines = 0;
    for (const [filePath, intervals] of retrievedIntervalsByPath.entries()) {
      const merged = mergeIntervals(intervals);
      mergedRetrievedByPath.set(filePath, merged);
      totalRetrievedLines += countIntervalLines(merged);
    }

    // 3. Prepare gold intervals
    const goldIntervalsByPath = new Map<string, Range[]>();
    let totalGoldLines = 0;
    for (const rf of c.retrievalExpectation.relevantFiles) {
      const merged = mergeIntervals(rf.ranges);
      goldIntervalsByPath.set(rf.path, merged);
      totalGoldLines += countIntervalLines(merged);
    }

    // 4. Calculate line overlap across all files
    let totalOverlapLines = 0;
    const allPaths = new Set([...mergedRetrievedByPath.keys(), ...goldIntervalsByPath.keys()]);
    for (const p of allPaths) {
      const ret = mergedRetrievedByPath.get(p) ?? [];
      const gold = goldIntervalsByPath.get(p) ?? [];
      totalOverlapLines += calculateIntervalOverlap(ret, gold);
    }

    // 5. Calculate precision, recall, and F1 (N/A for empty abstention cases)
    let linePrecision: number | null = null;
    let lineRecall: number | null = null;
    let lineF1: number | null = null;

    if (totalGoldLines > 0) {
      linePrecision = totalRetrievedLines > 0 ? totalOverlapLines / totalRetrievedLines : 0;
      lineRecall = totalOverlapLines / totalGoldLines;
      lineF1 = linePrecision + lineRecall > 0 ? (2 * linePrecision * lineRecall) / (linePrecision + lineRecall) : 0;
    }

    // 6. Fact Grounding Verification
    let factsGrounded = 0;
    for (const f of c.expectedFacts) {
      const retWindows = windows.filter((w) => w.path === f.evidence.path);
      const isRetrieved = retWindows.some(
        (w) => w.startLine <= f.evidence.lines[1] && w.endLine >= f.evidence.lines[0],
      );
      if (!isRetrieved) continue;

      // Extract lines bounded by the enclosing window
      const fullText = ctx.fileTexts.get(f.evidence.path);
      if (!fullText) continue;

      const matchingWindow = retWindows.find(
        (w) => w.startLine <= f.evidence.lines[1] && w.endLine >= f.evidence.lines[0],
      )!;
      const fileLines = fullText.split("\n");
      const windowExcerpt = fileLines.slice(matchingWindow.startLine - 1, matchingWindow.endLine).join("\n");

      const semErr = validatePredicateSemantics(f, windowExcerpt);
      if (!semErr) {
        factsGrounded++;
      }
    }

    // 7. Deterministic Completion-Policy Verification
    let policyVerified = true;
    let policyDetail = "";

    // Build evidence map from retrievalResult for citation verification
    const evidenceMap = new Map<string, FileEvidence>();
    for (const file of retrievalResult.files) {
      evidenceMap.set(file.path, {
        lines: file.totalLines,
        contentHash: file.contentHash,
        windows: windows
          .filter((w) => w.path === file.path)
          .map((w) => ({ startLine: w.startLine, endLine: w.endLine })),
      });
    }

    if (c.expectedOutcome === "abstain_no_evidence") {
      // Must retrieve zero windows
      if (windows.length !== 0) {
        policyVerified = false;
        policyDetail = `Expected 0 retrieved windows for abstention, got ${windows.length}`;
      } else {
        // Zero-tolerance citation test: fabricated citation must fail closed
        const fabricated = "I found the answer at [src/index.ts#L1-L3].";
        const failure = verifyCitations(fabricated, new Map());
        if (failure.paths.length > 0) {
          policyVerified = true;
        } else {
          policyVerified = false;
          policyDetail = "Fabricated citation unexpectedly passed verification without failure";
        }
      }
    } else {
      // Positive or scoped negative cases: verify that a citation to retrieved window passes,
      // and an out-of-bounds citation fails closed
      if (windows.length > 0) {
        const firstWin = windows[0]!;
        const validCitation = `Based on [${firstWin.path}#L${firstWin.startLine}-L${firstWin.endLine}], evidence is verified.`;
        const validFailure = verifyCitations(validCitation, evidenceMap);
        if (validFailure.paths.length > 0) {
          policyVerified = false;
          policyDetail = `Valid citation failed verification: ${validFailure.paths.join(", ")}`;
        }

        // Test out-of-bounds failure
        const badCitation = `Based on [${firstWin.path}#L990-L995], evidence is invalid.`;
        const badFailure = verifyCitations(badCitation, evidenceMap);
        if (badFailure.paths.length === 0) {
          policyVerified = false;
          policyDetail = "Out-of-bounds citation was not rejected";
        }
      } else {
        policyVerified = false;
        policyDetail = "Expected retrieved windows for positive case, but got 0";
      }
    }

    // 8. Explicit Evaluation Thresholds (PASS / WARN / FAIL):
    // - FAIL if: policy broke, facts not 100% grounded, or zero recall on positive query.
    // - WARN if: policy verified & facts grounded, but low precision (< 20%) due to window expansion.
    // - PASS if: positive case with recall > 0% and precision >= 20%, OR abstention case with W=0 and policy verified.
    let status: "PASS" | "WARN" | "FAIL" = "PASS";
    const factsSatisfied = c.expectedFacts.length === 0 || factsGrounded === c.expectedFacts.length;

    if (!policyVerified || !factsSatisfied) {
      status = "FAIL";
    } else if (c.expectedOutcome === "abstain_no_evidence") {
      status = windows.length === 0 ? "PASS" : "FAIL";
    } else {
      if ((lineRecall ?? 0) === 0) {
        status = "FAIL";
        policyDetail = "Total retrieval miss (line recall is 0%)";
      } else if ((linePrecision ?? 0) < 0.20) {
        status = "WARN";
        policyDetail = `Low precision (${((linePrecision ?? 0) * 100).toFixed(1)}% < 20%): retrieved window expansion exceeds snippet`;
      } else {
        status = "PASS";
      }
    }

    // Phase 3B.1: final serving order for the informational measurement.
    const servedFileOrder = computeServedFileOrder(windows);
    // Phase 3B.2: the loop's actual trace (pass snapshots, provenance ledger,
    // merge rejection/ledger outcomes), null for --single-pass runs.
    const loopMetadata: RetrievalLoopMetadata | null = loopInfo
      ? {
          stoppedBecause: loopInfo.stoppedBecause,
          passes: loopInfo.passes,
          initialWindows: loopInfo.initialWindows,
          windowProvenance: loopInfo.windowProvenance,
        }
      : null;
    const goldTrace = loopMetadata
      ? computeGoldYieldTrace(loopMetadata.initialWindows ?? [], loopMetadata.passes, goldIntervalsByPath, totalGoldLines)
      : null;
    const passLedger = loopMetadata ? computeCasePassMeasurements(loopMetadata, goldTrace) : null;
    const provenance = computeCaseProvenance(loopMetadata);

    caseMetrics.push({
      id: c.id,
      fixture: c.fixture,
      language: c.language,
      category: c.category,
      goldLines: totalGoldLines,
      retrievedWindows: windows.length,
      retrievedLines: totalRetrievedLines,
      overlapLines: totalOverlapLines,
      linePrecision,
      lineRecall,
      lineF1,
      factsTotal: c.expectedFacts.length,
      factsGrounded,
      policyVerified,
      status,
      detail: policyDetail,
      retrieval: {
        isPositive: totalGoldLines > 0,
        ranking: {
          relevantFileCount: totalGoldLines > 0 ? c.retrievalExpectation.relevantFiles.length : 0,
          servedFileOrder,
          ...(totalGoldLines > 0
            ? computeFileRanking(
                servedFileOrder,
                c.retrievalExpectation.relevantFiles.map((rf) => rf.path),
              )
            : { firstRelevantFileRank: null, reciprocalRank: null, recallAt3: null }),
        },
        budget: computeCaseBudget(retrievalResult),
        loop: computeCaseLoop(loopMetadata),
        provenance,
        goldTrace,
        passLedger,
      },
    });
  }

  // Aggregate Metrics over positive cases (excluding N/A abstention cases)
  const positiveCases = caseMetrics.filter((m) => m.goldLines > 0);
  const nPositive = positiveCases.length;

  const totalGold = positiveCases.reduce((acc, m) => acc + m.goldLines, 0);
  const totalRetrieved = positiveCases.reduce((acc, m) => acc + m.retrievedLines, 0);
  const totalOverlap = positiveCases.reduce((acc, m) => acc + m.overlapLines, 0);

  // Micro Metrics (explicit denominators)
  const microPrecision = totalRetrieved > 0 ? totalOverlap / totalRetrieved : 0;
  const microRecall = totalGold > 0 ? totalOverlap / totalGold : 0;
  const microF1 = microPrecision + microRecall > 0 ? (2 * microPrecision * microRecall) / (microPrecision + microRecall) : 0;

  // Macro Metrics (unweighted mean across positive cases)
  const macroPrecision = nPositive > 0 ? positiveCases.reduce((acc, m) => acc + (m.linePrecision ?? 0), 0) / nPositive : 0;
  const macroRecall = nPositive > 0 ? positiveCases.reduce((acc, m) => acc + (m.lineRecall ?? 0), 0) / nPositive : 0;
  const macroF1 = nPositive > 0 ? positiveCases.reduce((acc, m) => acc + (m.lineF1 ?? 0), 0) / nPositive : 0;

  const totalFacts = caseMetrics.reduce((acc, m) => acc + m.factsTotal, 0);
  const totalFactsGrounded = caseMetrics.reduce((acc, m) => acc + m.factsGrounded, 0);
  const factGroundingRate = totalFacts > 0 ? (totalFactsGrounded / totalFacts) * 100 : 100;

  const abstentionCases = caseMetrics.filter((m) => m.goldLines === 0);
  const abstentionPassed = abstentionCases.filter((m) => m.policyVerified && m.retrievedWindows === 0).length;

  const passedCases = caseMetrics.filter((m) => m.status === "PASS").length;
  const warnedCases = caseMetrics.filter((m) => m.status === "WARN").length;
  const failedCases = caseMetrics.filter((m) => m.status === "FAIL").length;

  // Phase 3B.1: informational retrieval aggregate (deterministic; see the
  // measurement block comment for full metric semantics).
  const retrievalAggregate = aggregateRetrieval(caseMetrics.map((m) => m.retrieval));

  // 1. JSON output format
  if (options.json) {
    const jsonOutput = {
      version: dataset.version,
      totalCases: caseMetrics.length,
      cases: caseMetrics,
      summary: {
        passed: passedCases,
        warned: warnedCases,
        failed: failedCases,
        totalFacts,
        factsGrounded: totalFactsGrounded,
        factGroundingRate: totalFacts > 0 ? totalFactsGrounded / totalFacts : 1,
        abstention: {
          total: abstentionCases.length,
          passed: abstentionPassed,
        },
        microMetrics: {
          precision: microPrecision,
          recall: microRecall,
          f1: microF1,
          overlappingLines: totalOverlap,
          retrievedLines: totalRetrieved,
          goldLines: totalGold,
        },
        macroMetrics: {
          precision: macroPrecision,
          recall: macroRecall,
          f1: macroF1,
          nCases: nPositive,
        },
      },
      capabilityMatrix: dataset.capabilityMatrix,
      // Phase 3B.1 informational measurement. Additive and versioned; the
      // per-case values above each case's `retrieval` key fully determine
      // these aggregates. Not a regression gate, and not part of the baseline
      // artifact in this batch.
      retrieval: retrievalAggregate,
    };
    console.log(JSON.stringify(jsonOutput, null, 2));
    if (failedCases > 0 || (options.failOnWarn && warnedCases > 0)) {
      process.exit(1);
    }
    return;
  }

  // 2. Markdown output format
  if (options.markdown) {
    console.log("### CI-6 Golden QA Evaluation Results\n");
    console.log("| ID | Fixture | Language | Win | Prec | Recall | F1 | Facts | Verdict | Detail |");
    console.log("| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |");
    for (const m of caseMetrics) {
      const precStr = m.linePrecision !== null ? `${(m.linePrecision * 100).toFixed(1)}%` : "N/A";
      const recStr = m.lineRecall !== null ? `${(m.lineRecall * 100).toFixed(1)}%` : "N/A";
      const f1Str = m.lineF1 !== null ? `${(m.lineF1 * 100).toFixed(1)}%` : "N/A";
      const detailStr = m.detail ? `\`${m.detail.replace(/\|/g, "\\|")}\`` : "-";
      console.log(`| ${m.id} | \`${m.fixture}\` | ${m.language} | ${m.retrievedWindows} | ${precStr} | ${recStr} | ${f1Str} | ${m.factsGrounded}/${m.factsTotal} | **${m.status}** | ${detailStr} |`);
    }
    console.log("\n#### Aggregate Summary\n");
    console.log(`- **Cases Evaluated:** ${caseMetrics.length} (${passedCases} PASS, ${warnedCases} WARN, ${failedCases} FAIL)`);
    console.log(`- **Fact Grounding Rate:** ${totalFactsGrounded}/${totalFacts} (${factGroundingRate.toFixed(1)}%)`);
    if (abstentionCases.length > 0) {
      console.log(`- **Abstention Policy Rate:** ${abstentionPassed}/${abstentionCases.length} (100.0%)`);
    }
    if (nPositive > 0) {
      console.log(`- **Micro Metrics:** Precision ${(microPrecision * 100).toFixed(1)}%, Recall ${(microRecall * 100).toFixed(1)}%, F1 ${(microF1 * 100).toFixed(1)}% (${totalOverlap}/${totalRetrieved} retrieved, ${totalOverlap}/${totalGold} gold lines)`);
      console.log(`- **Macro Metrics:** Precision ${(macroPrecision * 100).toFixed(1)}%, Recall ${(macroRecall * 100).toFixed(1)}%, F1 ${(macroF1 * 100).toFixed(1)}%`);
    }
    if (failedCases > 0 || (options.failOnWarn && warnedCases > 0)) {
      process.exit(1);
    }
    return;
  }

  // 3. Default ASCII Table output
  console.log("--------------------------------------------------------------------------------------------------");
  console.log("ID     | Fixture             | Language   | Win | Prec    | Recall  | F1      | Facts | Verdict");
  console.log("--------------------------------------------------------------------------------------------------");
  for (const m of caseMetrics) {
    const precStr = m.linePrecision !== null ? (m.linePrecision * 100).toFixed(1).padStart(5) + "%" : "  N/A  ";
    const recStr = m.lineRecall !== null ? (m.lineRecall * 100).toFixed(1).padStart(5) + "%" : "  N/A  ";
    const f1Str = m.lineF1 !== null ? (m.lineF1 * 100).toFixed(1).padStart(5) + "%" : "  N/A  ";
    const factStr = `${m.factsGrounded}/${m.factsTotal}`.padStart(5);
    const winStr = String(m.retrievedWindows).padStart(3);
    const fixStr = m.fixture.padEnd(19);
    const langStr = m.language.slice(0, 10).padEnd(10);
    const statusStr = m.status === "PASS" ? "PASS" : m.status === "WARN" ? "WARN" : "FAIL";
    console.log(`${m.id.padEnd(6)} | ${fixStr} | ${langStr} | ${winStr} | ${precStr} | ${recStr} | ${f1Str} | ${factStr} | ${statusStr}`);
    if (m.detail && m.status !== "PASS") {
      console.log(`       └─ [${m.status}] ${m.detail}`);
    }
  }
  console.log("--------------------------------------------------------------------------------------------------");

  console.log("\n=== Aggregate Evaluation Summary ===");
  console.log(`Total Cases Evaluated:       ${caseMetrics.length} (${nPositive} Positive/Scoped + ${abstentionCases.length} Negative Abstention)`);
  console.log(`Case Verdicts:               ${passedCases} PASS, ${warnedCases} WARN (Diagnostic), ${failedCases} FAIL`);
  console.log(`Fact Grounding Rate:         ${totalFactsGrounded}/${totalFacts} (${factGroundingRate.toFixed(1)}%) across all cases`);
  if (abstentionCases.length > 0) {
    console.log(`Abstention Policy Rate:      ${abstentionPassed}/${abstentionCases.length} (100.0%) [W=0, zero fabricated citations allowed]`);
  }
  if (nPositive > 0) {
    console.log("\n--- Retrieval Line Metrics (excluding N/A abstention cases) ---");
    console.log(`Micro-Precision:             ${(microPrecision * 100).toFixed(1)}% (${totalOverlap} overlapping lines / ${totalRetrieved} retrieved lines)`);
    console.log(`Micro-Recall:                ${(microRecall * 100).toFixed(1)}% (${totalOverlap} overlapping lines / ${totalGold} gold lines)`);
    console.log(`Micro-F1:                    ${(microF1 * 100).toFixed(1)}%`);
    console.log(`Macro-Precision:             ${(macroPrecision * 100).toFixed(1)}% (mean across ${nPositive} cases)`);
    console.log(`Macro-Recall:                ${(macroRecall * 100).toFixed(1)}% (mean across ${nPositive} cases)`);
    console.log(`Macro-F1:                    ${(macroF1 * 100).toFixed(1)}% (mean across ${nPositive} cases)`);
  }

  // Phase 3B.1 informational measurement (diagnostic, not a gate).
  console.log("\n--- Retrieval Measurement (informational, not a gate) ---");
  const mrrValue = retrievalAggregate.ranking.fileMRR.value;
  const recallValue = retrievalAggregate.ranking.recallAt3.value;
  console.log(`File MRR:                    ${mrrValue !== null ? mrrValue.toFixed(4) : "N/A"} (first relevant file, mean over ${retrievalAggregate.ranking.fileMRR.positiveCaseCount} positive cases)`);
  console.log(`File Recall@3:               ${recallValue !== null ? recallValue.toFixed(4) : "N/A"} (mean over ${retrievalAggregate.ranking.recallAt3.positiveCaseCount} positive cases)`);
  console.log(`Budget Utilization:          ${retrievalAggregate.budget.meanCharacterUtilization !== null ? retrievalAggregate.budget.meanCharacterUtilization.toFixed(4) : "N/A"} char mean (${retrievalAggregate.budget.characterEligibleCaseCount} eligible), ${retrievalAggregate.budget.meanTokenUtilization !== null ? retrievalAggregate.budget.meanTokenUtilization.toFixed(4) : "N/A"} token mean (${retrievalAggregate.budget.tokenEligibleCaseCount} eligible)`);
  const stopReasonText = Object.entries(retrievalAggregate.loop.stopReasonCounts)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ");
  console.log(`Stop Reasons:                ${stopReasonText || "none"}${retrievalAggregate.loop.unmeasuredStopReasonCaseCount > 0 ? `, unmeasured=${retrievalAggregate.loop.unmeasuredStopReasonCaseCount}` : ""}`);
  console.log(`Wasted-Pass Ratio:           ${retrievalAggregate.loop.meanWastedPassRatio !== null ? retrievalAggregate.loop.meanWastedPassRatio.toFixed(4) : "N/A"} mean (${retrievalAggregate.loop.wastedPassEligibleCaseCount} eligible: share of passes with 0 added windows)`);
  const rejectionText = `considered=${retrievalAggregate.loop.rejectionCounts.considered}, overlap=${retrievalAggregate.loop.rejectionCounts.overlap}, perFileCap=${retrievalAggregate.loop.rejectionCounts.perFileCap}, quality=${retrievalAggregate.loop.rejectionCounts.quality}, budget=${retrievalAggregate.loop.rejectionCounts.budget}`;
  console.log(`Pass Rejections:             ${rejectionText}`);
  const originText = Object.entries(retrievalAggregate.provenance.byOriginPass)
    .map(([origin, count]) => `pass${origin}=${count}`)
    .join(", ");
  console.log(`Window Origin (3B.2):        ${originText || "none"} (${retrievalAggregate.provenance.totalRetainedWindows} retained across ${retrievalAggregate.provenance.casesMeasured} cases)`);
  console.log(`Marginal Gold Yield (3B.2):  ${retrievalAggregate.gold.totalMarginalGoldLines} gold lines added after pass 0; ${retrievalAggregate.gold.totalAddedGoldEvidencePasses} pass(es) added gold evidence`);

  console.log("\n=== Multi-Language Capability Status ===");
  for (const cap of dataset.capabilityMatrix) {
    const unsupp = cap.unsupportedCapabilities.length > 0 ? ` [Unsupported: ${cap.unsupportedCapabilities.join(", ")}]` : "";
    console.log(`- ${cap.language.padEnd(23)}: Manifest=${cap.manifestSupport}, Symbols=${cap.symbolExtraction}, Imports=${cap.importModuleExtraction}${unsupp}`);
  }

  if (failedCases > 0 || (options.failOnWarn && warnedCases > 0)) {
    console.error(`\nEvaluation failed: ${failedCases} case(s) had hard failures${options.failOnWarn && warnedCases > 0 ? `, ${warnedCases} case(s) had warnings with --fail-on-warn` : ""}.`);
    process.exit(1);
  } else {
    console.log(`\nALL EVALUATION CHECKS SATISFIED (0 Hard Failures).`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runEvaluation().catch((err) => {
    console.error("Evaluation runtime error:", err);
    process.exit(1);
  });
}
