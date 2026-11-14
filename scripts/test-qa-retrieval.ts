// Deterministic tests for the Phase 3B.1 retrieval measurement helpers
// (scripts/eval-golden-qa.ts): file-level MRR, file-level Recall@3, budget
// utilization, stop-reason passthrough, and wasted-pass ratio. Pure metric
// branches run on synthetic fixtures; the baseline-compatibility branch shells
// into the real deterministic engine once and asserts the new retrieval
// section cannot leak into the Phase 3A baseline artifact.
//
//   pnpm test  (chain entry: node scripts/test-qa-retrieval.ts; also pnpm test:qa-retrieval)

import { readFileSync } from "node:fs";
import path from "node:path";
import { estimateCodeTokens, estimateProseTokens } from "../lib/ai/budget.ts";
import { mergeIterationWindows } from "../lib/ai/retrieval-loop.ts";
import type { RetrievedWindow } from "../lib/ai/retrieval.ts";
import { FIXTURES } from "./test-fixtures-shared.ts";
import {
  aggregateRetrieval,
  computeCaseBudget,
  computeCaseLoop,
  computeCasePassMeasurements,
  computeCaseProvenance,
  computeFileRanking,
  computeGoldYieldTrace,
  computeServedFileOrder,
  type RetrievalCaseBudget,
  type RetrievalCaseLoop,
  type RetrievalCaseMeasurement,
  type RetrievalCaseRanking,
  type RetrievalLoopMetadata,
} from "./eval-golden-qa.ts";
import {
  artifactFromEvalReport,
  BaselineGateError,
  compareRuns,
  loadBaselineFile,
  runGoldenEvalJson,
  updateBaselineFile,
  type GoldenEvalReport,
} from "./eval-golden-diff.ts";

const results: string[] = [];
const pass = (m: string) => {
  results.push(`ok    ${m}`);
  console.log(`ok    ${m}`);
};
const fail = (m: string) => {
  results.push(`FAIL  ${m}`);
  console.error(`FAIL  ${m}`);
};
const check = (cond: boolean, label: string): boolean => {
  if (cond) pass(label);
  else fail(label);
  return cond;
};

const BASELINE_FILE = path.join(FIXTURES, "golden-qa.baseline.json");

console.log("=== Golden QA retrieval measurement tests (Phase 3B.1) ===");

// ── Synthetic window/loop fixture helpers ────────────────────────────────────

type SynthWindow = { path: string; fileId: string; startLine: number; endLine: number; content: string };

let synthWindowCounter = 0;
function synthWindow(pathName: string, startLine = 1): SynthWindow {
  synthWindowCounter++;
  return { path: pathName, fileId: `file-${synthWindowCounter}`, startLine, endLine: startLine + 2, content: "x" };
}

function mkRanking(r: Partial<RetrievalCaseRanking> = {}): RetrievalCaseRanking {
  return { relevantFileCount: 0, servedFileOrder: [], firstRelevantFileRank: null, reciprocalRank: null, recallAt3: null, ...r };
}
function mkBudget(b: Partial<RetrievalCaseBudget> = {}): RetrievalCaseBudget {
  return { maxCharacters: 28000, maxTokens: 9334, renderedCharacters: null, totalTokens: null, characterUtilization: null, tokenUtilization: null, ...b };
}
function mkLoop(l: Partial<RetrievalCaseLoop> = {}): RetrievalCaseLoop {
  return { stoppedBecause: null, passCount: null, wastedPassNumerator: null, wastedPassDenominator: null, wastedPassRatio: null, passes: null, ...l };
}
function mkMeasurement(isPositive: boolean, ranking: RetrievalCaseRanking, budget: RetrievalCaseBudget, loop: RetrievalCaseLoop): RetrievalCaseMeasurement {
  return { isPositive, ranking, budget, loop, provenance: null, goldTrace: null, passLedger: null };
}

// ── Phase 3B.2 merge-fixture helpers (deterministic, mirroring the loop suite's mkWindow) ──
type Range = [number, number];

let loopWindowCounter = 0;
function mkLoopWindow(overrides: Partial<RetrievedWindow>): RetrievedWindow {
  loopWindowCounter += 1;
  return {
    fileId: `lf${loopWindowCounter}`,
    path: `src/loop${loopWindowCounter}.js`,
    contentHash: `lhash${loopWindowCounter}`,
    totalLines: 200,
    startLine: 1,
    endLine: 40,
    score: 90,
    text: "x".repeat(20),
    reason: "symbol \"probe\" (function) matches token \"probe\"",
    ...overrides,
  };
}

const loopLimits = { maxFiles: 16, maxWindowsPerFile: 2, maxCharacters: 28000, scoreFloor: 50 };

/** Byte-exact mirror of the loop's windowHeaderCost (lib/ai/retrieval-loop.ts). */
const headerCost = (w: { path: string; contentHash: string; startLine: number; endLine: number }): number =>
  `--- File: ${w.path} (lines ${w.startLine}-${w.endLine}) [hash: ${w.contentHash}] ---\n`.length + 2;

const servedCostOfLoopWindow = (w: RetrievedWindow): { chars: number; tokens: number } => ({
  chars: w.text.length + headerCost(w),
  tokens: estimateCodeTokens(w.text) + estimateProseTokens(w.path) + 15,
});

// ── Test 1: distinct-file ranking when multiple windows share a file ────────
{
  const windows = [synthWindow("a.ts"), synthWindow("a.ts"), synthWindow("b.ts"), synthWindow("a.ts")];
  const order = computeServedFileOrder(windows);
  const okOrder = check(JSON.stringify(order) === JSON.stringify(["a.ts", "b.ts"]), "distinct served-file order collapses repeated windows per file");
  const ranking = computeFileRanking(order, ["b.ts", "a.ts"]);
  if (okOrder) {
    check(
      ranking.firstRelevantFileRank === 1 && ranking.reciprocalRank === 1 && ranking.recallAt3 === 1,
      "ranking uses first appearance when the first file is relevant",
    );
  } else {
    fail("ranking skipped: served-file order fixture wrong");
  }
}

// ── Test 2: first appearance determines file rank (no window ranking) ───────
{
  const windows = [synthWindow("x.ts"), synthWindow("y.ts"), synthWindow("x.ts"), synthWindow("z.ts")];
  const order = computeServedFileOrder(windows);
  check(JSON.stringify(order) === JSON.stringify(["x.ts", "y.ts", "z.ts"]), "later occurrences of a file do not change its first-appearance rank");
  const ranking = computeFileRanking(order, ["z.ts"]);
  check(
    ranking.firstRelevantFileRank === 3 && ranking.reciprocalRank === 1 / 3 && ranking.recallAt3 === 1,
    "first appearance determines rank among distinct files (z.ts rank 3, rr 1/3; recall@3 = 1 because all three distinct files fall inside the top-3 window)",
  );
}

// ── Test 3: missing relevant files contribute zero reciprocal rank ──────────
{
  const order = computeServedFileOrder([synthWindow("p.ts")]);
  const ranking = computeFileRanking(order, ["missing.ts"]);
  check(
    ranking.firstRelevantFileRank === null && ranking.reciprocalRank === 0 && ranking.recallAt3 === 0,
    "never-served relevant file: rank null, reciprocal rank 0, recall 0",
  );
  const emptyRanking = computeFileRanking([], ["missing.ts"]);
  check(emptyRanking.reciprocalRank === 0 && emptyRanking.recallAt3 === 0, "empty final serving measures as a total miss (not N/A) for positive cases");
}

// ── Test 4: MRR excludes abstention cases (explicit denominator) ────────────
{
  const pos1 = mkMeasurement(true, mkRanking({ relevantFileCount: 1, firstRelevantFileRank: 1, reciprocalRank: 1, recallAt3: 1 }), mkBudget(), mkLoop({ stoppedBecause: "sufficient-coverage", passCount: 0, wastedPassNumerator: 0, wastedPassDenominator: 0, wastedPassRatio: null, passes: [] }));
  const pos2 = mkMeasurement(true, mkRanking({ relevantFileCount: 2, firstRelevantFileRank: 2, reciprocalRank: 0.5, recallAt3: 0.5 }), mkBudget(), mkLoop({ stoppedBecause: "max-passes", passCount: 1, wastedPassNumerator: 0, wastedPassDenominator: 1, wastedPassRatio: 0, passes: [] }));
  const abstain = mkMeasurement(false, mkRanking(), mkBudget(), mkLoop());
  const agg = aggregateRetrieval([pos1, abstain, pos2]);
  check(
    agg.ranking.fileMRR.value === (1 + 0.5) / 2 && agg.ranking.fileMRR.positiveCaseCount === 2,
    "fileMRR aggregates reciprocal ranks over positives only with explicit denominator",
  );
}

// ── Test 5: Recall@3 counts distinct relevant files among first 3 files ─────
{
  const windows = [synthWindow("noise.ts"), synthWindow("a.ts"), synthWindow("b.ts"), synthWindow("c.ts")];
  const order = computeServedFileOrder(windows);
  const ranking = computeFileRanking(order, ["a.ts", "b.ts", "c.ts"]);
  check(
    ranking.recallAt3 === 2 / 3 && ranking.firstRelevantFileRank === 2 && ranking.reciprocalRank === 0.5,
    "recall@3 = 2 of 3 relevant files in the first 3 distinct served files (macro per-case value)",
  );
  const rankingSingle = computeFileRanking(computeServedFileOrder([synthWindow("a.ts"), synthWindow("b.ts")]), ["a.ts", "b.ts"]);
  check(rankingSingle.recallAt3 === 1, "recall@3 counts distinct files, duplicate windows never double-count");
}

// ── Test 6: Recall@3 aggregates exclude abstention cases ────────────────────
{
  const pos1 = mkMeasurement(true, mkRanking({ relevantFileCount: 1, reciprocalRank: 1, recallAt3: 1, servedFileOrder: ["a.ts"] }), mkBudget(), mkLoop());
  const pos2 = mkMeasurement(true, mkRanking({ relevantFileCount: 2, reciprocalRank: 0, recallAt3: 0.5, servedFileOrder: ["a.ts"] }), mkBudget(), mkLoop());
  const abstain = mkMeasurement(false, mkRanking(), mkBudget(), mkLoop());
  const agg = aggregateRetrieval([pos1, abstain, pos2]);
  check(
    agg.ranking.recallAt3.value === (1 + 0.5) / 2 && agg.ranking.recallAt3.positiveCaseCount === 2,
    "recall@3 macro average excludes abstention cases with explicit denominator",
  );
}

// ── Test 7: budget utilization from actual ledger values ────────────────────
{
  const budget = computeCaseBudget({ query: "how does the cache eviction work?", renderedCharacters: 14000, totalTokens: 4000 });
  check(
    budget.maxCharacters === 28000 && budget.maxTokens === 9334,
    "profile-free eval limits mirror the pipeline constants (28000 chars, ceil(28000/3)=9334 tokens)",
  );
  check(
    budget.characterUtilization === 14000 / 28000 && budget.tokenUtilization === 4000 / 9334,
    "character/token utilization are real quotients of actual ledger values (0.5 and 4000/9334)",
  );
}

// ── Test 8: zero / missing limits and missing ledger values ─────────────────
{
  const missingLedger = computeCaseBudget({ query: "q" });
  check(
    missingLedger.renderedCharacters === null && missingLedger.totalTokens === null && missingLedger.characterUtilization === null && missingLedger.tokenUtilization === null,
    "missing ledger values yield null utilization, not 0 or invented numbers",
  );
  const zeroLimits = computeCaseBudget({ query: "q", renderedCharacters: 100, totalTokens: 50 }, { maxCharacters: 0, maxTokens: 0 });
  check(
    zeroLimits.maxCharacters === 0 && zeroLimits.maxTokens === 0 && zeroLimits.characterUtilization === null && zeroLimits.tokenUtilization === null,
    "zero limits yield null utilization (never division by zero, never clamped)",
  );
  // No silent clamping: utilization above 1.0 must surface verbatim.
  const overLimit = computeCaseBudget({ query: "q", renderedCharacters: 30000 }, {});
  check(overLimit.characterUtilization === 30000 / 28000, "over-limit utilization is surfaced unclamped (30000/28000)");
}

// ── Test 9: wasted-pass numerator and denominator from actual records ───────
{
  // Source records carry ms (as the real loop produces); the measurement must
  // strip timing.
  const rawPasses = [
    { pass: 1, queries: ["q1"], categories: ["type:module"], addedWindows: 3, addedFiles: 1, replacedFiles: 0, ms: 12 },
    { pass: 2, queries: ["q2"], categories: ["type:config"], addedWindows: 0, addedFiles: 0, replacedFiles: 0, ms: 7 },
    { pass: 3, queries: ["q3"], categories: ["type:module"], addedWindows: 1, addedFiles: 1, replacedFiles: 1, ms: 9 },
  ];
  const loop: RetrievalLoopMetadata = { stoppedBecause: "max-passes", passes: rawPasses };
  const measured = computeCaseLoop(loop);
  check(
    measured.passCount === 3 && measured.wastedPassNumerator === 1 && measured.wastedPassDenominator === 3 && measured.wastedPassRatio === 1 / 3,
    "wasted-pass ratio = one zero-addition pass over three recorded passes",
  );
  check(
    Array.isArray(measured.passes) && measured.passes.length === 3 && Object.keys(measured.passes[0]!).every((k) => k !== "ms"),
    "pass records are passthrough-normalized with timing (ms) stripped",
  );
}

// ── Test 10: zero-pass and absent-record handling ───────────────────────────
{
  const zeroPass = computeCaseLoop({ stoppedBecause: "sufficient-coverage", passes: [] });
  check(
    zeroPass.passCount === 0 && zeroPass.wastedPassNumerator === 0 && zeroPass.wastedPassDenominator === 0 && zeroPass.wastedPassRatio === null,
    "zero recorded passes: denominator 0 does not fabricate a ratio (null, not 0)",
  );
  const zeroPassAgg = aggregateRetrieval([mkMeasurement(true, mkRanking({ reciprocalRank: 1, recallAt3: 1 }), mkBudget(), mkLoop({ stoppedBecause: "sufficient-coverage", passCount: 0, wastedPassNumerator: 0, wastedPassDenominator: 0, wastedPassRatio: null, passes: [] }))]);
  check(
    zeroPassAgg.loop.meanWastedPassRatio === null && zeroPassAgg.loop.wastedPassEligibleCaseCount === 0,
    "aggregate wasted-pass mean has no eligible cases when every case recorded zero passes",
  );
  const absent = computeCaseLoop(null);
  check(
    absent.stoppedBecause === null && absent.passCount === null && absent.wastedPassNumerator === null && absent.wastedPassDenominator === null && absent.wastedPassRatio === null && absent.passes === null,
    "absent loop (--single-pass/unmeasured): all-null metadata, never counted as zero-addition passes",
  );
  const absentAgg = aggregateRetrieval([mkMeasurement(true, mkRanking({ reciprocalRank: 1, recallAt3: 1 }), mkBudget(), mkLoop())]);
  check(
    absentAgg.loop.meanWastedPassRatio === null && absentAgg.loop.wastedPassEligibleCaseCount === 0 && absentAgg.loop.unmeasuredStopReasonCaseCount === 1,
    "unmeasured cases are counted in unmeasuredStopReasonCaseCount and excluded from wasted-pass means",
  );
}

// ── Test 11: stop-reason passthrough without inference ──────────────────────
{
  const loop = computeCaseLoop({ stoppedBecause: "budget-exhausted", passes: [] });
  check(loop.stoppedBecause === "budget-exhausted", "stop reason preserved verbatim, even when a classifier would rename it");
  const rawPass = { pass: 1, queries: [], categories: [], addedWindows: 0, addedFiles: 0, replacedFiles: 0, ms: 1 };
  const a = computeCaseLoop({ stoppedBecause: "no-candidates", passes: [rawPass] }).stoppedBecause;
  check(a === "no-candidates", "each source string maps to itself (no quality/budget reclassification in this batch)");
  const agg = aggregateRetrieval([
    mkMeasurement(true, mkRanking({ reciprocalRank: 1, recallAt3: 1 }), mkBudget(), mkLoop({ stoppedBecause: "budget-exhausted", passCount: 1, wastedPassNumerator: 1, wastedPassDenominator: 1, wastedPassRatio: 1, passes: [] })),
    mkMeasurement(true, mkRanking({ reciprocalRank: 1, recallAt3: 1 }), mkBudget(), mkLoop({ stoppedBecause: "budget-exhausted", passCount: 1, wastedPassNumerator: 0, wastedPassDenominator: 1, wastedPassRatio: 0, passes: [] })),
    mkMeasurement(false, mkRanking(), mkBudget(), mkLoop({ stoppedBecause: "sufficient-coverage", passCount: 0, wastedPassNumerator: 0, wastedPassDenominator: 0, wastedPassRatio: null, passes: [] })),
    mkMeasurement(false, mkRanking(), mkBudget(), mkLoop()),
  ]);
  check(
    JSON.stringify(agg.loop.stopReasonCounts) === JSON.stringify({ "budget-exhausted": 2, "sufficient-coverage": 1 }) && agg.loop.unmeasuredStopReasonCaseCount === 1,
    "aggregate stop-reason histogram counts source strings verbatim in case order",
  );
  check(
    agg.loop.meanWastedPassRatio === (1 + 0) / 2 && agg.loop.wastedPassEligibleCaseCount === 2,
    "wasted-pass aggregate is a mean over cases with an actual pass denominator",
  );
}

// ── Test 12: deterministic serialization ────────────────────────────────────
{
  const windows = [synthWindow("a.ts"), synthWindow("a.ts"), synthWindow("b.ts")];
  const rawPasses = [{ pass: 1, queries: ["q"], categories: [], addedWindows: 2, addedFiles: 1, replacedFiles: 0, ms: 4 }];
  const loop: RetrievalLoopMetadata = { stoppedBecause: "max-passes", passes: rawPasses };
  function buildOnce(): string {
    const order = computeServedFileOrder(windows);
    const measurement = mkMeasurement(
      true,
      mkRanking({ relevantFileCount: 2, servedFileOrder: order, ...computeFileRanking(order, ["a.ts"]) }),
      computeCaseBudget({ query: "how does eviction work?", renderedCharacters: 12345, totalTokens: 3000 }),
      computeCaseLoop(loop),
    );
    const agg = aggregateRetrieval([measurement, mkMeasurement(false, mkRanking(), mkBudget(), mkLoop())]);
    return JSON.stringify({ servedFileOrder: order, measurement, aggregate: agg }, null, 2);
  }
  check(buildOnce() === buildOnce(), "rebuilding the measurement from identical inputs serializes byte-identically");
}

// ── Test 13: budget aggregates over separately eligible case sets ───────────
{
  const agg = aggregateRetrieval([
    mkMeasurement(true, mkRanking({ reciprocalRank: 1, recallAt3: 1 }), mkBudget({ renderedCharacters: 14000, totalTokens: undefined, characterUtilization: 0.5, tokenUtilization: null }), mkLoop({ stoppedBecause: "sufficient-coverage", passCount: 0, wastedPassNumerator: 0, wastedPassDenominator: 0, wastedPassRatio: null, passes: [] })),
    mkMeasurement(true, mkRanking({ reciprocalRank: 1, recallAt3: 1 }), mkBudget({ renderedCharacters: 7000, totalTokens: 4000, characterUtilization: 0.25, tokenUtilization: 4000 / 9334 }), mkLoop({ stoppedBecause: "max-passes", passCount: 2, wastedPassNumerator: 1, wastedPassDenominator: 2, wastedPassRatio: 0.5, passes: [] })),
  ]);
  check(
    agg.budget.meanCharacterUtilization === (0.5 + 0.25) / 2 && agg.budget.characterEligibleCaseCount === 2,
    "character-utilization mean over eligible cases with explicit denominator",
  );
  check(
    agg.budget.meanTokenUtilization === 4000 / 9334 && agg.budget.tokenEligibleCaseCount === 1,
    "token-utilization mean uses its own eligibility set (one case lacks token ledger)",
  );
}

// ── One shared real-engine run for the integration/compatibility tests ──────
let realReport: GoldenEvalReport & { retrieval?: unknown } | null = null;
{
  const run = runGoldenEvalJson();
  realReport = run.report as GoldenEvalReport & { retrieval?: unknown } | null;
  if (realReport === null) {
    fail(`real deterministic evaluation unavailable (exit ${run.status}): ${run.stderrTail}`);
  }
}

// ── Test 14: real engine integration + auditability of the aggregate ───────
{
  // One real deterministic run; the top-level retrieval aggregate must be
  // recomputable from the per-case retrieval sections (no hidden inputs), and
  // abstention cases must be flagged as non-positive with null rankings.
  if (realReport === null) {
    // Already recorded as a failure above; skip without crashing midway.
  } else {
    const report = realReport;
    if (!check((report.retrieval as { schemaVersion?: number } | undefined)?.schemaVersion === 1, "engine JSON exposes a top-level retrieval section with schemaVersion 1")) {
      throw new BaselineGateError("retrieval section missing");
    }
    const perCase = report.cases.map((c) => (c as unknown as { retrieval: RetrievalCaseMeasurement }).retrieval);
    const abstention = report.cases.filter((c) => c.goldLines === 0);
    if (!check(
      abstention.length > 0
        && abstention.every((c) => {
          const r = (c as unknown as { retrieval: RetrievalCaseMeasurement }).retrieval;
          return r.isPositive === false && r.ranking.firstRelevantFileRank === null && r.ranking.reciprocalRank === null && r.ranking.recallAt3 === null && r.ranking.relevantFileCount === 0;
        }),
      "abstention cases report non-positive with N/A (null) ranking fields",
    )) {
      throw new BaselineGateError("abstention case retrieval section wrong");
    }
    const positives = report.cases.filter((c) => c.goldLines > 0);
    if (!check(
      positives.every((c) => {
        const r = (c as unknown as { retrieval: RetrievalCaseMeasurement }).retrieval;
        return r.isPositive === true && Array.isArray(r.ranking.servedFileOrder) && r.ranking.servedFileOrder.length >= 1 && r.ranking.reciprocalRank !== null;
      }),
      "positive cases report a non-empty served-file order and a defined reciprocal rank",
    )) {
      throw new BaselineGateError("positive case retrieval section wrong");
    }
    const recomputed = aggregateRetrieval(perCase);
    check(
      JSON.stringify(report.retrieval) === JSON.stringify(recomputed),
      "top-level retrieval aggregate is exactly recomputable from the per-case sections",
    );
    const mrrAgg = report.retrieval as { ranking: { fileMRR: { positiveCaseCount: number } } };
    check(mrrAgg.ranking.fileMRR.positiveCaseCount === positives.length, "fileMRR positiveCaseCount equals the engine's positive-case count");
    // ── Phase 3B.2 reconciliation against the final case metrics ──────────────
    let provenanceOk = true;
    let goldOk = true;
    let funnelOk = true;
    let ledgerChainOk = true;
    for (const c of report.cases) {
      const m = (c as unknown as { retrieval: RetrievalCaseMeasurement }).retrieval;
      // Provenance ledger mirrors the final retained window set (count and
      // origin histogram), and windows only ever originate from passes that
      // actually added windows (pass 0 excepted).
      const originSum = Object.values(m.provenance?.retainedByOrigin ?? {}).reduce((a, b) => a + b, 0);
      if (!m.provenance || m.provenance.retainedWindowCount !== c.retrievedWindows || originSum !== c.retrievedWindows) {
        provenanceOk = false;
      }
      if (m.goldTrace) {
        const first = m.goldTrace[0]!;
        const last = m.goldTrace[m.goldTrace.length - 1]!;
        // Pass-0 baseline evidence + telescoping marginals + final equals the
        // case's existing overlap/recall metrics; abstentions stay null.
        if (first.pass !== 0 || first.windowCount !== m.provenance?.initialWindowCount) goldOk = false;
        if (m.goldTrace.slice(1).reduce((a, g) => a + g.marginalGoldLines, 0) !== last.cumulativeGoldOverlapLines - first.cumulativeGoldOverlapLines) goldOk = false;
        if (c.goldLines > 0) {
          if (last.cumulativeGoldOverlapLines !== c.overlapLines || Math.abs((last.cumulativeRecall ?? -1) - (c.lineRecall ?? -2)) > 1e-9) goldOk = false;
        } else if (last.cumulativeRecall !== null) {
          goldOk = false;
        }
      } else {
        goldOk = false;
      }
      if (m.passLedger) {
        m.passLedger.forEach((p, i) => {
          // Full candidate-funnel identity at the collection sites.
          if (p.focusedWindowsSeen !== (p.affiliationRejected ?? 0) + (p.intraPassDuplicates ?? 0) + (p.candidatesCollected ?? 0)) funnelOk = false;
          if (p.candidatesCollected !== p.candidatesConsidered) funnelOk = false;
          // A window can only originate from a pass that actually added windows.
          const originCount = m.provenance?.retainedByOrigin?.[String(p.pass)] ?? 0;
          if (originCount > p.addedWindows) funnelOk = false;
          // Ledger chain: pass k's before-figures equal pass k−1's after-figures.
          if (i > 0) {
            const prev = m.passLedger![i - 1]!;
            if (
              (p.charactersBefore !== null && prev.charactersAfter !== null && p.charactersBefore !== prev.charactersAfter)
              || (p.tokensBefore !== null && prev.tokensAfter !== null && p.tokensBefore !== prev.tokensAfter)
              || (p.renderedCharactersBefore !== null && prev.renderedCharactersAfter !== null && p.renderedCharactersBefore !== prev.renderedCharactersAfter)
            ) {
              ledgerChainOk = false;
            }
          }
        });
      } else {
        funnelOk = false;
      }
    }
    check(provenanceOk, "per-case provenance ledger mirrors the final retained window set (count and origin histogram)");
    check(goldOk, "per-case gold trace telescopes; final cumulative overlap/recall equal the case's overlapLines/lineRecall; abstentions stay null");
    check(funnelOk, "per-pass funnel identity holds (seen = affiliation-rejected + intra-pass duplicates + collected; collected = considered)");
    check(ledgerChainOk, "per-pass ledger figures chain across consecutive passes (before_k = after_(k-1))");
    const agg3B2 = report.retrieval as {
      provenance: { totalRetainedWindows: number; byOriginPass: Record<string, number> };
      gold: { totalMarginalGoldLines: number };
      loop: { rejectionCounts: Record<string, number> };
    };
    check(
      agg3B2.provenance.totalRetainedWindows === report.cases.reduce((a, c) => a + c.retrievedWindows, 0)
        && Object.values(agg3B2.provenance.byOriginPass).reduce((a, b) => a + b, 0) === agg3B2.provenance.totalRetainedWindows,
      "aggregate provenance totals equal the sum of served windows with a consistent origin histogram",
    );
    check(
      agg3B2.gold.totalMarginalGoldLines === report.cases.reduce((a, c) => a + c.overlapLines, 0),
      "aggregate marginal gold yield telescopes to the total gold-overlap lines (89)",
    );
    const funnelSum = agg3B2.loop.rejectionCounts.focusedWindows
      - (agg3B2.loop.rejectionCounts.affiliationRejected + agg3B2.loop.rejectionCounts.intraPassDuplicates + agg3B2.loop.rejectionCounts.collected);
    check(funnelSum === 0, "aggregate funnel reconciles: focused windows seen = affiliation rejections + duplicates + collected");
  }
}

// ── Test 15: Phase 3A baseline compatibility (report extra section, v1 artifact) ──
{
  // The comparator is version-agnostic to the new section: an updated engine
  // report must produce an unchanged v1 artifact whose case entries never
  // contain retrieval data, and must compare cleanly against the committed
  // baseline.
  if (realReport === null) {
    // Already recorded as a failure above; skip.
  } else {
    const artifact = artifactFromEvalReport(realReport);
    check(artifact.baselineSchemaVersion === 1, "artifact built from a retrieval-carrying report is still baseline schema v1");
    check(
      Object.values(artifact.cases).every((c) => !JSON.stringify(c).includes('"retrieval"')),
      "baseline case entries carry no retrieval data (informational metrics stay out of the baseline)",
    );
    const baseline = loadBaselineFile(BASELINE_FILE);
    const comparison = compareRuns(baseline, artifact);
    check(
      comparison.ok && comparison.regressions.length === 0 && comparison.aggregateRegressions.length === 0,
      "committed v1 baseline compares cleanly (no regressions) against the updated engine",
    );
  }
}

// ── Test 16: ordinary comparison never writes; explicit approval still required ──
{
  const outcome = updateBaselineFile({
    baselineFile: BASELINE_FILE,
    datasetFile: path.join(FIXTURES, "golden-qa.json"),
    report: null,
    evalStatus: 1,
    approve: false,
  });
  check(outcome.written === false && outcome.reason !== null && outcome.reason.includes("--approve-update"), "update without explicit approval is refused with the standard gate message");
}

// ── Test 17: provenance helper semantics (pass 0 and pass-k attribution) ────
{
  const provenance = computeCaseProvenance({
    stoppedBecause: "max-passes",
    passes: [],
    initialWindows: [
      { fileId: "f1", path: "src/a.ts", startLine: 1, endLine: 30 },
      { fileId: "f1", path: "src/a.ts", startLine: 50, endLine: 80 },
      { fileId: "f2", path: "src/b.ts", startLine: 1, endLine: 20 },
    ],
    windowProvenance: [
      { fileId: "f1", path: "src/a.ts", startLine: 1, endLine: 30, originPass: 0 },
      { fileId: "f1", path: "src/a.ts", startLine: 50, endLine: 80, originPass: 0 },
      { fileId: "f2", path: "src/b.ts", startLine: 1, endLine: 20, originPass: 0 },
      { fileId: "f3", path: "src/c.ts", startLine: 5, endLine: 25, originPass: 2 },
    ],
  });
  check(
    provenance !== null
      && provenance.initialWindowCount === 3 && provenance.initialFileCount === 2
      && provenance.retainedWindowCount === 4
      && JSON.stringify(provenance.retainedByOrigin) === JSON.stringify({ "0": 3, "2": 1 }),
    "provenance helper: pass-0 baseline evidence and per-pass origin histogram",
  );
  check(
    computeCaseProvenance(null) === null && computeCaseProvenance({ stoppedBecause: null, passes: [] }) === null,
    "provenance helper: unmeasured loop (--single-pass) yields null, never inferred data",
  );
}

// ── Test 18: merge-level overlap skips and duplicates (no restamp, no count) ──
{
  const existing = mkLoopWindow({ fileId: "fA", path: "src/a.js", startLine: 1, endLine: 40 });
  const merged = mergeIterationWindows(
    { windows: [existing], totalCharacters: 200, renderedCharacters: 200 + headerCost(existing) },
    [
      mkLoopWindow({ fileId: "fA", path: "src/a.js", startLine: 1, endLine: 40 }),   // exact duplicate
      mkLoopWindow({ fileId: "fA", path: "src/a.js", startLine: 10, endLine: 60 }),  // overlapping slice
    ],
    loopLimits,
  );
  check(
    merged.added === 0 && merged.rejectedOverlap === 2 && merged.rejectedQuality === 0 && merged.rejectedBudget === 0 && merged.rejectedPerFileCap === 0
      && merged.windows.length === 1 && merged.windows[0]!.startLine === 1 && merged.windows[0]!.endLine === 40,
    "overlap/exact-duplicate candidates are skipped, counted as overlap rejections, and never restamp the served window",
  );
}

// ── Test 19: quality-only rejection never reads as budget exhaustion ────────
{
  const merged = mergeIterationWindows(
    { windows: [mkLoopWindow({ fileId: "fA", path: "src/a.js" })], totalCharacters: 100 },
    [mkLoopWindow({ fileId: "fW", path: "src/weak.js", score: 40 })],
    loopLimits,
  );
  check(
    merged.added === 0 && merged.rejectedQuality === 1 && merged.rejectedBudget === 0,
    "score-floor rejection increments the quality counter, never the budget counter",
  );
  // The corrected stop rule (as implemented in the loop): a pass with only
  // quality rejections stops as "no-candidates", not "budget-exhausted".
  const classify = (m: { candidatesConsidered: number; rejectedBudget: number }): string =>
    m.candidatesConsidered === 0 ? "no-candidates" : m.rejectedBudget > 0 ? "budget-exhausted" : "no-candidates";
  check(
    classify({ candidatesConsidered: 1, rejectedBudget: 0 }) === "no-candidates",
    "quality-only dry pass classifies as no-candidates (not budget-exhausted)",
  );
  check(
    classify({ candidatesConsidered: 1, rejectedBudget: 2 }) === "budget-exhausted",
    "a genuine budget/cap rejection still classifies as budget-exhausted",
  );
}

// ── Test 20: per-file cap counted separately; genuine budget distinguishable ──
{
  const atCap = [mkLoopWindow({ fileId: "fA", path: "src/a.js", startLine: 1, endLine: 40 }), mkLoopWindow({ fileId: "fA", path: "src/a.js", startLine: 70, endLine: 95 })];
  const capped = mergeIterationWindows(
    { windows: atCap, totalCharacters: 200 },
    [mkLoopWindow({ fileId: "fA", path: "src/a.js", startLine: 130, endLine: 170 })],
    loopLimits,
  );
  check(
    capped.added === 0 && capped.rejectedPerFileCap === 1 && capped.rejectedBudget === 0 && capped.rejectedQuality === 0,
    "per-file window-cap rejections carry their own counter (not a budget claim)",
  );
  const full = mergeIterationWindows(
    { windows: [mkLoopWindow({ fileId: "fA", path: "src/a.js", text: "y".repeat(2000) })], totalCharacters: 27900, renderedCharacters: 27900 + headerCost(atCap[0]!) },
    [mkLoopWindow({ fileId: "fN", path: "src/n.js", text: "z".repeat(2000) })],
    loopLimits,
  );
  check(
    full.added === 0 && full.rejectedBudget === 1 && full.rejectedQuality === 0,
    "character-budget overflow is a genuine budget rejection, distinguishable from quality",
  );
}

// ── Test 21: ledger deltas reconcile with served-cost arithmetic ────────────
{
  const existing = mkLoopWindow({ fileId: "fA", path: "src/a.js", startLine: 1, endLine: 40 });
  const cand = mkLoopWindow({ fileId: "fB", path: "src/b.js", startLine: 1, endLine: 40, text: "b".repeat(30) });
  const beforeRendered = 27900;
  const beforeTokens = 500;
  const merged = mergeIterationWindows(
    {
      windows: [existing],
      totalCharacters: existing.text.length,
      totalTokens: beforeTokens,
      renderedCharacters: beforeRendered,
    },
    [cand],
    loopLimits,
  );
  const candServed = servedCostOfLoopWindow(cand);
  check(
    merged.added === 1
      && merged.renderedCharacters - beforeRendered === candServed.chars
      && merged.totalTokens - beforeTokens === candServed.tokens
      && merged.replacedCharacters === 0 && merged.replacedTokens === 0,
    "one admitted window: rendered/token deltas equal its exact served cost (header/appendix-inclusive)",
  );
  check(
    loopLimits.maxCharacters - merged.renderedCharacters === loopLimits.maxCharacters - (beforeRendered + candServed.chars),
    "remaining budget is limits minus the after-ledger (no invented figures)",
  );
}

// ── Test 22: replacement releases its exact served cost ─────────────────────
{
  const victim = mkLoopWindow({ fileId: "fV", path: "src/weak.js", startLine: 1, endLine: 40, score: 30, text: "v".repeat(5000) });
  const keeper = mkLoopWindow({ fileId: "fK", path: "src/keeper.js", startLine: 1, endLine: 40, score: 95, text: "k".repeat(10) });
  const cand = mkLoopWindow({ fileId: "fN", path: "src/new.js", startLine: 1, endLine: 40, score: 90, text: "n".repeat(1000) });
  const victimCost = servedCostOfLoopWindow(victim);
  const candCost = servedCostOfLoopWindow(cand);
  const beforeRendered = 26000;
  const merged = mergeIterationWindows(
    { windows: [victim, keeper], totalCharacters: victim.text.length + keeper.text.length, totalTokens: 800, renderedCharacters: beforeRendered },
    [cand],
    { ...loopLimits, maxCharacters: 26500 },
    { allowReplacement: true, replacementMargin: 10 },
  );
  check(
    merged.replacedFiles === 1 && merged.added === 1
      && merged.replacedCharacters === victimCost.chars && merged.replacedTokens === victimCost.tokens,
    "a committed replacement releases exactly the removed window's served cost",
  );
  check(
    merged.renderedCharacters === beforeRendered - victimCost.chars + candCost.chars,
    "the enforced ledger after a replacement = before − released + admitted served cost",
  );
}

// ── Test 23: marginal gold yield avoids double-counting; file gain counted once ──
{
  const gold = new Map<string, Range[]>([
    ["src/a.ts", [[1, 20]]],
    ["src/b.ts", [[1, 10]]],
  ]);
  const trace = computeGoldYieldTrace(
    [{ fileId: "fA", path: "src/a.ts", startLine: 1, endLine: 20 }],
    [
      // windowsAfterPass is the FULL post-pass snapshot (the engine's adopted
      // merged state), not a per-pass delta.
      { pass: 1, windowsAfterPass: [{ fileId: "fA", path: "src/a.ts", startLine: 1, endLine: 20 }, { fileId: "fA", path: "src/a.ts", startLine: 10, endLine: 30 }] },
      { pass: 2, windowsAfterPass: [{ fileId: "fA", path: "src/a.ts", startLine: 1, endLine: 30 }, { fileId: "fB", path: "src/b.ts", startLine: 1, endLine: 10 }, { fileId: "fB", path: "src/b.ts", startLine: 1, endLine: 10 }] },
    ],
    gold,
    30,
  );
  check(
    trace.length === 3
      && trace[0]!.cumulativeGoldOverlapLines === 20 && trace[0]!.marginalGoldLines === 20 && trace[0]!.cumulativeRelevantFiles === 1
      && trace[1]!.cumulativeGoldOverlapLines === 20 && trace[1]!.marginalGoldLines === 0 && trace[1]!.marginalRelevantFiles === 0
      && trace[2]!.cumulativeGoldOverlapLines === 30 && trace[2]!.marginalGoldLines === 10 && trace[2]!.cumulativeRelevantFiles === 2 && trace[2]!.marginalRelevantFiles === 1,
    "gold yield: overlapping later windows add 0 marginal lines; new relevant file counts once; duplicate windows never double-count",
  );
  check(
    trace[1]!.cumulativeRecall === 20 / 30 && trace[2]!.cumulativeRecall === 1,
    "cumulative recall uses the actual post-pass window state (same gold interpretation as the evaluator)",
  );
}

// ── Test 24: zero-yield passes and the added-gold flag stay separate ─────────
{
  const gold = new Map<string, Range[]>([["src/a.ts", [[1, 20]]]]);
  const trace = computeGoldYieldTrace(
    [{ fileId: "fA", path: "src/a.ts", startLine: 1, endLine: 20 }],
    [{ pass: 1, windowsAfterPass: [{ fileId: "fA", path: "src/a.ts", startLine: 1, endLine: 20 }, { fileId: "fC", path: "src/c.ts", startLine: 1, endLine: 5 }] }],
    gold,
    20,
  );
  const ledger = computeCasePassMeasurements(
    {
      stoppedBecause: "no-candidates",
      passes: [{ pass: 1, queries: [], categories: [], addedWindows: 1, addedFiles: 1, replacedFiles: 0, windowsAfterPass: [{ fileId: "fA", path: "src/a.ts", startLine: 1, endLine: 20 }, { fileId: "fC", path: "src/c.ts", startLine: 1, endLine: 5 }] }],
    },
    trace,
  );
  check(
    ledger.length === 1 && ledger[0]!.addedWindows === 1 && ledger[0]!.addedGoldEvidence === false && ledger[0]!.marginalGoldLines === 0,
    "a pass may add windows without adding gold evidence; the wasted-pass definition (addedWindows === 0) is untouched",
  );
  const unmeasured = computeCasePassMeasurements(null, null);
  check(unmeasured.length === 0, "pass measurements are empty for an unmeasured loop, not fabricated");
}

// ── Test 25: funnel accounting from actual collection events ────────────────
{
  const metadata: RetrievalLoopMetadata = {
    stoppedBecause: "no-candidates",
    passes: [
      {
        pass: 1,
        queries: ["widget"],
        categories: ["widget"],
        addedWindows: 0,
        addedFiles: 0,
        replacedFiles: 0,
        focusedWindowsSeen: 7,
        affiliationRejected: 5,
        intraPassDuplicates: 1,
        candidatesCollected: 1,
        candidatesConsidered: 1,
        rejectedOverlap: 1,
        rejectedPerFileCap: 0,
        rejectedQuality: 0,
        rejectedBudget: 0,
      },
    ],
  };
  const ledger = computeCasePassMeasurements(metadata, null);
  check(
    ledger[0]!.focusedWindowsSeen === 7 && ledger[0]!.affiliationRejected === 5 && ledger[0]!.intraPassDuplicates === 1 && ledger[0]!.candidatesCollected === 1 && ledger[0]!.candidatesConsidered === 1,
    "funnel fields flow from actual collection events (seen = rejected + duplicates + collected)",
  );
  const agg = aggregateRetrieval([
    mkMeasurement(true, mkRanking({ reciprocalRank: 1, recallAt3: 1 }), mkBudget(), mkLoop({ stoppedBecause: "no-candidates", passCount: 1, wastedPassNumerator: 1, wastedPassDenominator: 1, wastedPassRatio: 1, passes: [] })),
  ].map((m) => ({ ...m, provenance: null, goldTrace: null, passLedger: ledger })));
  check(
    agg.loop.rejectionCounts.focusedWindows === 7 && agg.loop.rejectionCounts.affiliationRejected === 5 && agg.loop.rejectionCounts.considered === 1,
    "aggregate rejection accounting sums the full funnel over measured passes",
  );
}

// ── Test 26: full deterministic case measurement, byte-identical rebuild ─────
{
  function build3B2Once(): string {
    const gold = new Map<string, Range[]>([["src/a.ts", [[1, 20]]]]);
    const initial = [{ fileId: "fA", path: "src/a.ts", startLine: 1, endLine: 20 }];
    const metadata: RetrievalLoopMetadata = {
      stoppedBecause: "max-passes",
      passes: [
        { pass: 1, queries: ["a"], categories: ["a"], addedWindows: 1, addedFiles: 0, replacedFiles: 0, windowsAfterPass: [{ fileId: "fA", path: "src/a.ts", startLine: 1, endLine: 30 }], charactersBefore: 100, charactersAfter: 130, renderedCharactersBefore: 150, renderedCharactersAfter: 180, tokensBefore: 40, tokensAfter: 50, remainingCharacters: 27820, remainingTokens: 9284 },
      ],
      initialWindows: initial,
      windowProvenance: [{ fileId: "fA", path: "src/a.ts", startLine: 1, endLine: 30, originPass: 1 }],
    };
    const goldTrace = computeGoldYieldTrace(metadata.initialWindows ?? [], metadata.passes, gold, 30);
    const measurement: RetrievalCaseMeasurement = {
      isPositive: true,
      ranking: { relevantFileCount: 1, servedFileOrder: ["src/a.ts"], firstRelevantFileRank: 1, reciprocalRank: 1, recallAt3: 1 },
      budget: computeCaseBudget({ query: "q", renderedCharacters: 180, totalTokens: 50 }),
      loop: computeCaseLoop(metadata),
      provenance: computeCaseProvenance(metadata),
      goldTrace,
      passLedger: computeCasePassMeasurements(metadata, goldTrace),
    };
    return JSON.stringify({ measurement, aggregate: aggregateRetrieval([measurement]) }, null, 2);
  }
  check(build3B2Once() === build3B2Once(), "full 3B.2 measurement (provenance + gold trace + ledger) rebuilds byte-identically");
}

// The committed baseline must never have been modified by these tests.
const committedNow = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as { reference?: string; baselineSchemaVersion?: number };
check(
  committedNow.reference === "phase-3a" && committedNow.baselineSchemaVersion === 1,
  "committed baseline untouched by the test run (still reference phase-3a, schema v1)",
);

// ── Summary ──────────────────────────────────────────────────────────────────
const fails = results.filter((r) => r.startsWith("FAIL"));
if (fails.length > 0) {
  console.error(`\n${fails.length} assertion(s) failed:\n${fails.join("\n")}`);
  process.exit(1);
}
console.log(`\nAll ${results.length} retrieval-measurement checks passed cleanly.`);
