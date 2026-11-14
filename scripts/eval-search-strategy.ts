// Phase 4 Batch 3: search-strategy diagnostics for the golden QA dataset.
//
// Answers, per case and per gold file, HOW retrieval found (or failed to
// find) the relevant files: which anchor the query carried, which retrieval
// strategies contributed to each selected file, and whether a relevant file
// was never discovered, blocked by the affiliation gate, collected but
// rejected by the merge, or served and then displaced. Pure helpers are
// exported for tests; running the file executes the diagnostic sweep.
//
//   node scripts/eval-search-strategy.ts [--json]
//
// The sweep runs the same coverage loop the golden evaluation runs, exactly
// once per case (no additional retrieval executions, no provider calls, no
// timestamps), and consumes the loop's own trace fields:
//
//   - initialWindows  → pass-0 (base) candidates: anchor classification reads
//     ONLY these windows, because targeted focused queries reuse the concept
//     token itself (retrieval-loop.ts focusedQuery) and could otherwise
//     manufacture symbol anchors the question never carried.
//   - passes[].candidateFilesSeen / collectedCandidateFiles → funnel file
//     identities at the affiliation gate and at the merge.
//   - passes[].windowsAfterPass → files that were retained at some pass and
//     later displaced.
//   - result.windows → the final served evidence (strategy list carried from
//     the seeding candidate through serving).
//
// Attribution is never invented: when a file's strategies are not recorded
// (candidates rejected before serving carry no served-window record), the
// report says "unavailable".

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { retrieveWithCoverageLoop } from "../lib/ai/retrieval-loop.ts";
import type { RetrievedWindow } from "../lib/ai/retrieval.ts";
import { FIXTURES } from "./test-fixtures-shared.ts";
import { createFixtureContext, type FixtureContext } from "./eval-fixture-adapter.ts";
import { computeFileRanking, computeServedFileOrder } from "./eval-golden-qa.ts";

// ── Anchor classification ─────────────────────────────────────────────────────

/**
 * A reason segment the symbol stage writes, e.g.
 * `symbol "area" (function) matches token "area"` (merged windows join
 * segments with "; "). Matched captures: 1 symbol name, 2 kind, 3 token.
 */
export const SYMBOL_REASON_SEGMENT = /^symbol "([^"]+)" \(([^)]+)\) matches token "([^"]+)"/;

/** Minimal pass-0 window snapshot the loop exposes (strategies/reason are the
 * Batch 3 passthrough; absent for hand-constructed results). */
export type BaseWindowSnapshot = {
  path: string;
  strategies?: string[];
  reason?: string;
};

export type QueryAnchorClassification = {
  /** The query names a file outright (pipeline-established: a served/candidate
   * window was stamped "explicit-path"). */
  hasExplicitPathAnchor: boolean;
  /** The query names a symbol identifier verbatim: a base symbol-strategy
   * window whose matched token equals the symbol's own name (case-blind) and
   * is not a generic-verb-only match. Fragments and glossary matches are NOT
   * anchors — they cannot establish that the question named the symbol. */
  hasExplicitSymbolAnchor: boolean;
  /** The exact symbol names detected (sorted). */
  symbolAnchors: string[];
  /** The explicitly named files (sorted). */
  pathAnchors: string[];
  /** False when the base windows carry no strategy data (legacy/hand-built
   * results, or no pass-0 window list at all) — anchors are then unknown,
   * not absent. An EMPTY list is available-with-no-anchors: the base
   * retrieval genuinely served nothing (e.g. an abstention case). */
  classificationAvailable: boolean;
};

export function classifyQueryAnchors(baseWindows: BaseWindowSnapshot[] | undefined): QueryAnchorClassification {
  const classificationAvailable = baseWindows !== undefined
    && (baseWindows.length === 0 || baseWindows.some((w) => w.strategies !== undefined));
  const symbolAnchors = new Set<string>();
  const pathAnchors = new Set<string>();
  for (const w of baseWindows ?? []) {
    const strategies = w.strategies ?? [];
    if (strategies.includes("explicit-path")) pathAnchors.add(w.path);
    if (strategies.includes("symbol") && w.reason) {
      for (const segment of w.reason.split("; ")) {
        const match = SYMBOL_REASON_SEGMENT.exec(segment);
        if (!match) continue;
        const [, symbolName, , token] = match;
        if (segment.includes("(generic verb only")) continue;
        if (token!.toLowerCase() === symbolName!.toLowerCase()) symbolAnchors.add(symbolName!);
      }
    }
  }
  // "default" is the parser's synthetic name for default exports, not an
  // identifier an author wrote: a question saying "default export" names the
  // export *kind*, not a symbol, so it is not a reliable anchor.
  symbolAnchors.delete("default");
  return {
    hasExplicitPathAnchor: pathAnchors.size > 0,
    hasExplicitSymbolAnchor: symbolAnchors.size > 0,
    symbolAnchors: [...symbolAnchors].sort(),
    pathAnchors: [...pathAnchors].sort(),
    classificationAvailable,
  };
}

/** Which stratum a case belongs to. Path-anchored takes precedence when both
 * anchors are present (the named file scopes the question); the raw flags
 * stay independent in the case record. Abstention cases (no relevant files)
 * are classified by anchor but excluded from ranked strata. */
export type AnchorStratum = "path-anchored" | "symbol-anchored" | "unanchored";

export function anchorStratum(classification: QueryAnchorClassification): AnchorStratum {
  if (classification.hasExplicitPathAnchor) return "path-anchored";
  if (classification.hasExplicitSymbolAnchor) return "symbol-anchored";
  return "unanchored";
}

// ── Strategy attribution ─────────────────────────────────────────────────────

export type StrategyAttribution = {
  /** Union of the strategies across every retained window of the file, or
   * "unavailable" when no retained window carries strategy data. */
  strategies: string[] | "unavailable";
  /** Reason segments that named a strategy, verbatim, for the report. */
  reasons: string[];
};

/** Attributes strategies to a file from its retained windows. Windows from
 * hand-built results may omit strategies: a file whose windows ALL lack them
 * gets "unavailable"; a file with mixed windows unions what exists. */
export function attributeFileStrategies(
  windows: Pick<RetrievedWindow, "path" | "strategies" | "reason">[],
): Map<string, StrategyAttribution> {
  const acc = new Map<string, { hasStrategies: boolean; union: string[]; reasons: string[] }>();
  for (const w of windows) {
    const entry = acc.get(w.path) ?? { hasStrategies: false, union: [], reasons: [] };
    if (w.reason && !entry.reasons.includes(w.reason)) entry.reasons.push(w.reason);
    if (w.strategies) {
      entry.hasStrategies = true;
      entry.union = [...new Set([...entry.union, ...w.strategies])];
    }
    acc.set(w.path, entry);
  }
  const out = new Map<string, StrategyAttribution>();
  for (const [p, entry] of acc) {
    out.set(p, { strategies: entry.hasStrategies ? entry.union.sort() : "unavailable", reasons: entry.reasons });
  }
  return out;
}

// ── Discovery versus ranking ─────────────────────────────────────────────────

/** How far into the funnel a gold file got, ordered by best stage reached:
 * "selected" beats "selected-then-displaced" beats "merge-rejected" beats
 * "gate-rejected" beats "never-seen". A file that never entered the merge's
 * candidate set is a DISCOVERY failure ("never-seen", "gate-rejected"); one
 * that entered it but is absent from the final package is a RANKING failure
 * ("merge-rejected", "selected-then-displaced"). */
export type DiscoveryStage =
  | "selected"
  | "selected-then-displaced"
  | "merge-rejected"
  | "gate-rejected"
  | "never-seen";

export type DiscoveryFailure = "none" | "discovery" | "ranking";

export type FunnelTrace = {
  /** Final served window paths, in served order. */
  finalPaths: string[];
  /** Paths retained at pass 0 or any later pass but absent from the final
   * package (displaced). */
  displacedPaths: string[];
  /** Paths among the affiliation gate's collected candidates (pre-merge). */
  collectedPaths: string[];
  /** Paths seen by focused retrievals before the gate. */
  seenPaths: string[];
};

export function classifyDiscoveryStage(trace: FunnelTrace, filePath: string): DiscoveryStage {
  if (trace.finalPaths.includes(filePath)) return "selected";
  if (trace.displacedPaths.includes(filePath)) return "selected-then-displaced";
  if (trace.collectedPaths.includes(filePath)) return "merge-rejected";
  if (trace.seenPaths.includes(filePath)) return "gate-rejected";
  return "never-seen";
}

export function discoveryFailureOf(stage: DiscoveryStage): DiscoveryFailure {
  if (stage === "never-seen" || stage === "gate-rejected") return "discovery";
  if (stage === "merge-rejected" || stage === "selected-then-displaced") return "ranking";
  return "none";
}

/** Builds the funnel trace from one loop execution's own fields. */
export function funnelTraceOf(
  loop: {
    result: { windows: { path: string }[] };
    initialWindows?: { path: string }[];
    passes: { candidateFilesSeen?: string[]; collectedCandidateFiles?: string[]; windowsAfterPass?: { path: string }[] }[];
  },
): FunnelTrace {
  const finalPaths = loop.result.windows.map((w) => w.path);
  const finalSet = new Set(finalPaths);
  const displaced = new Set<string>();
  for (const w of [...(loop.initialWindows ?? []), ...loop.passes.flatMap((p) => p.windowsAfterPass ?? [])]) {
    if (!finalSet.has(w.path)) displaced.add(w.path);
  }
  const collected = new Set(loop.passes.flatMap((p) => p.collectedCandidateFiles ?? []));
  const seen = new Set(loop.passes.flatMap((p) => p.candidateFilesSeen ?? []));
  return {
    finalPaths,
    displacedPaths: [...displaced].sort(),
    collectedPaths: [...collected].sort(),
    seenPaths: [...seen].sort(),
  };
}

// ── Per-case record ──────────────────────────────────────────────────────────

export type CaseFileDiagnostic = {
  path: string;
  stage: DiscoveryStage;
  failure: DiscoveryFailure;
  strategies: string[] | "unavailable";
  /** This file's rank in the final served order (null when not served). */
  servedRank: number | null;
};

export type CaseSearchDiagnostic = {
  id: string;
  fixture: string;
  category: string;
  question: string;
  classification: QueryAnchorClassification;
  stratum: AnchorStratum | "abstention";
  goldFiles: string[];
  retrievedFiles: string[];
  perFile: CaseFileDiagnostic[];
  firstRelevantFileRank: number | null;
  reciprocalRank: number | null;
  recallAt3: number | null;
  stopReason: string | null;
  stopReasonAvailable: boolean;
};

export type GoldenCase = {
  id: string;
  fixture: string;
  category: string;
  question: string;
  retrievalExpectation: { mustRetrieve: boolean; relevantFiles: { path: string; ranges: [number, number][] }[] };
};

export function buildCaseDiagnostic(
  c: GoldenCase,
  classification: QueryAnchorClassification,
  attribution: Map<string, StrategyAttribution>,
  trace: FunnelTrace,
  stopReason: string | null,
  stopReasonAvailable: boolean,
): CaseSearchDiagnostic {
  const goldFiles = c.retrievalExpectation.relevantFiles.map((rf) => rf.path).sort();
  const retrievedFiles = trace.finalPaths;
  const perFile: CaseFileDiagnostic[] = goldFiles.map((p) => {
    const stage = classifyDiscoveryStage(trace, p);
    const entry = attribution.get(p);
    return {
      path: p,
      stage,
      failure: discoveryFailureOf(stage),
      strategies: entry ? entry.strategies : "unavailable",
      servedRank: trace.finalPaths.indexOf(p) >= 0 ? trace.finalPaths.indexOf(p) + 1 : null,
    };
  });
  const ranking = computeFileRanking(computeServedFileOrder(retrievedFiles.map((p) => ({ path: p }))), goldFiles);
  return {
    id: c.id,
    fixture: c.fixture,
    category: c.category,
    question: c.question,
    classification,
    stratum: goldFiles.length === 0 ? "abstention" : anchorStratum(classification),
    goldFiles,
    retrievedFiles,
    perFile,
    firstRelevantFileRank: ranking.firstRelevantFileRank,
    reciprocalRank: ranking.reciprocalRank,
    recallAt3: ranking.recallAt3,
    stopReason,
    stopReasonAvailable,
  };
}

// ── Stratified aggregation ───────────────────────────────────────────────────

export type StratumMetrics = {
  stratum: AnchorStratum | "abstention";
  caseCount: number;
  caseIds: string[];
  relevantFileCount: number;
  /** Gold files that entered the merge's candidate set at any pass. */
  discoveredFileCount: number;
  discoveryRate: number | null;
  /** Gold files present in the final served package. */
  selectedFileCount: number;
  selectionRate: number | null;
  fileMRR: number | null;
  recallAt3: number | null;
  discoveryFailures: { caseId: string; path: string; stage: DiscoveryStage }[];
  rankingFailures: { caseId: string; path: string; stage: DiscoveryStage }[];
  /** "no cases" marker for an empty stratum; rates are null there. */
  empty: boolean;
  note: string;
};

const STRATUM_ORDER: (AnchorStratum | "abstention")[] = ["path-anchored", "symbol-anchored", "unanchored", "abstention"];

export function stratifyAndAggregate(diagnostics: CaseSearchDiagnostic[]): StratumMetrics[] {
  return STRATUM_ORDER.map((stratum) => {
    const cases = diagnostics.filter((d) => d.stratum === stratum);
    const files = cases.flatMap((d) => d.perFile);
    const mean = (values: (number | null)[]): number | null => {
      const nums = values.filter((v): v is number => v !== null);
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
    };
    const discovered = files.filter((f) => f.stage === "selected" || f.stage === "selected-then-displaced" || f.stage === "merge-rejected");
    const selected = files.filter((f) => f.stage === "selected");
    const discoveryFailures = cases.flatMap((d) =>
      d.perFile.filter((f) => f.failure === "discovery").map((f) => ({ caseId: d.id, path: f.path, stage: f.stage })));
    const rankingFailures = cases.flatMap((d) =>
      d.perFile.filter((f) => f.failure === "ranking").map((f) => ({ caseId: d.id, path: f.path, stage: f.stage })));
    const empty = cases.length === 0;
    let note = "";
    if (empty) {
      note = stratum === "abstention"
        ? "no abstention cases in this dataset"
        : `no ${stratum} cases in this dataset: the stratum is empty, its rates are undefined (null), and no conclusion may be drawn from it`;
    } else if (stratum === "abstention") {
      note = "abstention cases have no relevant files to discover or rank; excluded from all rates by definition";
    } else {
      const n = cases.length;
      note = n <= 3
        ? `very small sample (n=${n}): rates are descriptive only, not statistically conclusive`
        : `small sample (n=${n}): rates are descriptive, not statistically conclusive`;
    }
    return {
      stratum,
      caseCount: cases.length,
      caseIds: cases.map((d) => d.id),
      relevantFileCount: files.length,
      discoveredFileCount: discovered.length,
      discoveryRate: empty || stratum === "abstention" ? null : discovered.length / files.length,
      selectedFileCount: selected.length,
      selectionRate: empty || stratum === "abstention" ? null : selected.length / files.length,
      fileMRR: empty || stratum === "abstention" ? null : mean(cases.map((d) => d.reciprocalRank)),
      recallAt3: empty || stratum === "abstention" ? null : mean(cases.map((d) => d.recallAt3)),
      discoveryFailures,
      rankingFailures,
      empty,
      note,
    };
  });
}

// ── Rendering ────────────────────────────────────────────────────────────────

const STAGE_LABEL: Record<DiscoveryStage, string> = {
  "selected": "selected",
  "selected-then-displaced": "selected-then-displaced (ranking failure)",
  "merge-rejected": "merge-rejected (ranking failure)",
  "gate-rejected": "gate-rejected (discovery failure)",
  "never-seen": "never-seen (discovery failure)",
};

export function renderMarkdownReport(diagnostics: CaseSearchDiagnostic[], strata: StratumMetrics[]): string {
  const lines: string[] = [];
  lines.push("# Search-Strategy Diagnostics (Phase 4 Batch 3)");
  lines.push("");
  lines.push("How each golden case's retrieval found (or failed to find) its relevant files.");
  lines.push("One coverage-loop execution per case; anchor classification reads pass-0 windows");
  lines.push("only; attribution is \"unavailable\" where the pipeline records none.");
  lines.push("");
  lines.push("## Anchor-stratified summary");
  lines.push("");
  lines.push("| stratum | cases | gold files | discovery rate | selection rate | file MRR | recall@3 | discovery failures | ranking failures |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const s of strata) {
    const pct = (v: number | null) => (v === null ? "N/A" : `${(v * 100).toFixed(1)}%`);
    lines.push(
      `| ${s.stratum} | ${s.caseCount} | ${s.relevantFileCount} | ${pct(s.discoveryRate)} | ${pct(s.selectionRate)}`
      + ` | ${s.fileMRR === null ? "N/A" : s.fileMRR.toFixed(4)} | ${s.recallAt3 === null ? "N/A" : s.recallAt3.toFixed(4)}`
      + ` | ${s.discoveryFailures.length} | ${s.rankingFailures.length} |`,
    );
  }
  lines.push("");
  for (const s of strata) {
    lines.push(`- **${s.stratum}**: ${s.note}${s.caseIds.length > 0 ? ` (cases: ${s.caseIds.join(", ")})` : ""}`);
  }
  lines.push("");
  lines.push("## Per-case detail");
  lines.push("");
  for (const d of diagnostics) {
    lines.push(`### ${d.id} — stratum: ${d.stratum}${d.classification.classificationAvailable ? "" : " (anchor classification unavailable: base windows carry no strategy data)"}`);
    lines.push("");
    lines.push(`> ${d.question}`);
    lines.push("");
    const flags: string[] = [];
    if (d.classification.pathAnchors.length > 0) flags.push(`explicit path anchor: ${d.classification.pathAnchors.join(", ")}`);
    if (d.classification.symbolAnchors.length > 0) flags.push(`explicit symbol anchor: ${d.classification.symbolAnchors.join(", ")}`);
    if (flags.length === 0) flags.push("no reliable explicit anchor detected (concept/discovery query)");
    lines.push(`- Anchors: ${flags.join("; ")}`);
    lines.push(`- Gold files: ${d.goldFiles.length > 0 ? d.goldFiles.join(", ") : "(none — abstention case)"}`);
    lines.push(`- Retrieved files (served order): ${d.retrievedFiles.length > 0 ? d.retrievedFiles.join(", ") : "(none)"}`);
    lines.push(`- First relevant-file rank: ${d.firstRelevantFileRank ?? "N/A"}; recall@3: ${d.recallAt3 === null ? "N/A" : d.recallAt3.toFixed(4)}; loop stop: ${d.stopReasonAvailable ? d.stopReason : "unavailable"}`);
    for (const f of d.perFile) {
      const strat = f.strategies === "unavailable" ? "unavailable (candidate never retained, strategy list not recorded)" : f.strategies.join("+");
      lines.push(`  - ${f.path}: ${STAGE_LABEL[f.stage]}; served rank ${f.servedRank ?? "—"}; strategies: ${strat}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ── CLI sweep ────────────────────────────────────────────────────────────────

function loadDataset(): { cases: GoldenCase[] } {
  const datasetPath = path.join(FIXTURES, "golden-qa.json");
  const raw = JSON.parse(readFileSync(datasetPath, "utf8")) as { cases: GoldenCase[] };
  return { cases: raw.cases };
}

export async function runDiagnostics(): Promise<{ diagnostics: CaseSearchDiagnostic[]; strata: StratumMetrics[] }> {
  const { cases } = loadDataset();
  const contexts = new Map<string, FixtureContext>();
  const getContext = (fixture: string): FixtureContext => {
    let ctx = contexts.get(fixture);
    if (!ctx) {
      ctx = createFixtureContext(fixture);
      contexts.set(fixture, ctx);
    }
    return ctx;
  };

  const diagnostics: CaseSearchDiagnostic[] = [];
  for (const c of cases) {
    const ctx = getContext(c.fixture);
    // Exactly one loop execution per case, mirroring the golden evaluation's
    // own retrieval work; the diagnostics only read its returned trace.
    const loop = await retrieveWithCoverageLoop(ctx.db, ctx.analysisId, c.question);
    const baseWindows: BaseWindowSnapshot[] | undefined = loop.initialWindows;
    const classification = classifyQueryAnchors(baseWindows);
    const attribution = attributeFileStrategies(loop.result.windows);
    const trace = funnelTraceOf(loop);
    diagnostics.push(buildCaseDiagnostic(c, classification, attribution, trace, loop.stoppedBecause, true));
  }
  const strata = stratifyAndAggregate(diagnostics);
  return { diagnostics, strata };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { diagnostics, strata } = await runDiagnostics();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ diagnostics, strata }, null, 2));
  } else {
    console.log(renderMarkdownReport(diagnostics, strata));
  }
}

// A module, so top-level await above is allowed.
export {};
