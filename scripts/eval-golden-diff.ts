// Phase 3A: machine-readable golden QA baseline and regression comparison.
//
// The deterministic golden evaluation (scripts/eval-golden-qa.ts) prints its
// report and exits — the output is not persisted anywhere, so quality
// regressions are only detected by hand-comparing a run against prose
// baselines in docs/PROJECT_STATE.md. This tool closes that gap:
//
//   pnpm test:qa-diff
//     Compares a fresh deterministic evaluation against the reviewed baseline
//     artifact (fixtures/golden-qa.baseline.json). Never writes; exits nonzero
//     on any regression, dataset identity mismatch, or malformed baseline.
//
//   node scripts/eval-golden-diff.ts --approve-update [--reference <id>]
//     Explicit baseline refresh. Requires --approve-update, validates the
//     dataset and a completed evaluation first, and writes atomically.
//     Refuses to overwrite a baseline with an unsupported schema. Refuses to
//     record a run with hard failures. Never invoked by normal comparison.
//
// The evaluation itself is NOT reimplemented here: the comparator spawns
// `node scripts/eval-golden-qa.ts --json` verbatim, so there is exactly one
// engine and one report schema (the CSV/documentation review contract too).
// The run is fully deterministic and provider-free (in-memory fixture
// adapter), so repeated comparisons produce identical results.
//
// Comparison policy (documented, deliberate):
//  - Identity gates: supported baseline schema version; dataset version;
//    dataset SHA-256 over the exact bytes; case-ID set (missing, duplicated,
//    or unexpected IDs are named and rejected). A dataset change never
//    silently compares against a stale baseline.
//  - Verdict transitions: PASS -> WARN is a regression (new unexpected WARN);
//    PASS -> FAIL, WARN -> FAIL, and any previously-failing case re-failing
//    are regressions; WARN -> PASS or FAIL -> PASS are improvements.
//  - WARN cases (diagnostic-only verdicts, below the engine's 20% precision
//    floor): an unchanged WARN remains accepted — QA-05's historical 18.8%
//    WARN lives in the baseline, not in a hard-coded special case. A WARN
//    worsens when per-case line precision OR line recall numerically
//    declines; that is a regression. Improvements are reported, not gated.
//    No additional percentage thresholds are introduced; the engine's own
//    WARN floor already supplies the semantics.
//  - PASS cases: any per-case line precision or recall decline is a
//    regression; increases are improvements.
//  - Every case: fact shortfall (factsGrounded < factsTotal) or a lost
//    policyVerified flag is a regression.
//  - retrievedWindows / retrievedLines / goldLines changes are informational
//    context only — precision and recall (overlap ratios) already capture
//    their substance, and gating raw counts would add arbitrary rules.
//  - Aggregates (micro/macro precision/recall/F1 declines, facts grounded,
//    abstention passes, failed/warned counts) obey the same declines-are-
//    regressions rule; they necessarily mirror the per-case verdicts and are
//    checked as belt-and-braces.
//  - Float equality uses a 1e-9 epsilon (derived floats — F1 from P and R —
//    are structurally identical between same-input runs).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { FIXTURES } from "./test-fixtures-shared.ts";

/** Supported baseline artifact schema versions. Bump only for a breaking
 * baseline-format change, and migrate deliberately with reviewer approval. */
export const SUPPORTED_BASELINE_SCHEMA_VERSIONS = [1] as const;

/** Float equality window: below this, derived floats count as unchanged. */
const FLOAT_EPSILON = 1e-9;

export type CaseVerdict = "PASS" | "WARN" | "FAIL";

export type CaseMetricJson = {
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
  status: string;
  detail?: string;
};

export type GoldenEvalSummary = {
  passed: number;
  warned: number;
  failed: number;
  totalFacts: number;
  factsGrounded: number;
  factGroundingRate?: number;
  abstention: { total: number; passed: number };
  microMetrics: {
    precision: number | null;
    recall: number | null;
    f1: number | null;
    overlappingLines: number;
    retrievedLines: number;
    goldLines: number;
  };
  macroMetrics: {
    precision: number | null;
    recall: number | null;
    f1: number | null;
    nCases: number;
  };
};

export type GoldenEvalReport = {
  version: number;
  totalCases: number;
  cases: CaseMetricJson[];
  summary: GoldenEvalSummary;
};

export type BaselineCaseMetrics = {
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
};

export type BaselineArtifact = {
  baselineSchemaVersion: number;
  dataset: { version: number; sha256: string };
  reference: string;
  cases: Record<
    string,
    {
      fixture: string;
      language: string;
      category: string;
      verdict: CaseVerdict;
      metrics: BaselineCaseMetrics;
    }
  >;
  summary: GoldenEvalSummary;
};

/** Identity/gate failures make the comparison meaningless; each carries a
 * named reason so the failure is actionable, not silent. */
export class BaselineGateError extends Error {}

// ── Dataset identity ─────────────────────────────────────────────────────────

export function sha256File(file: string): string {
  const bytes = readFileSync(file);
  return createHash("sha256").update(bytes).digest("hex");
}

/** Dataset version plus SHA-256 over the exact dataset bytes. */
export function computeDatasetIdentity(datasetFile: string): { version: number; sha256: string } {
  if (!existsSync(datasetFile)) throw new BaselineGateError(`Dataset file not found: ${datasetFile}`);
  let dataset: unknown;
  try {
    dataset = JSON.parse(readFileSync(datasetFile, "utf8"));
  } catch (error) {
    throw new BaselineGateError(`Dataset is not valid JSON (${datasetFile}): ${(error as Error).message}`);
  }
  const version = (dataset as { version?: unknown }).version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new BaselineGateError(`Dataset version is missing or invalid in ${datasetFile}`);
  }
  const cases = (dataset as { cases?: unknown }).cases;
  if (!Array.isArray(cases)) throw new BaselineGateError(`Dataset "cases" is not an array in ${datasetFile}`);
  const ids = cases.map((c) => String((c as { id?: unknown })?.id));
  for (const id of ids) {
    if (!id || id === "undefined") throw new BaselineGateError(`Dataset contains a case without an id in ${datasetFile}`);
  }
  return { version, sha256: sha256File(datasetFile) };
}

/** Gate: the baseline must match the CURRENT dataset. A dataset byte change
 * without an approved baseline update is always a hard stop — matching the
 * version field alone is never enough. */
export function assertDatasetIdentity(baseline: BaselineArtifact, datasetFile: string): void {
  if (!SUPPORTED_BASELINE_SCHEMA_VERSIONS.includes(baseline.baselineSchemaVersion as 1)) {
    throw new BaselineGateError(
      `Baseline schema version ${baseline.baselineSchemaVersion} is not supported (supported: ${SUPPORTED_BASELINE_SCHEMA_VERSIONS.join(", ")}).`,
    );
  }
  const identity = computeDatasetIdentity(datasetFile);
  if (identity.version !== baseline.dataset.version) {
    throw new BaselineGateError(
      `Dataset version changed: baseline expects ${baseline.dataset.version}, dataset is ${identity.version}. Update the baseline deliberately with --approve-update after reviewing the change.`,
    );
  }
  if (identity.sha256 !== baseline.dataset.sha256) {
    throw new BaselineGateError(
      `Dataset SHA-256 changed: baseline expects ${baseline.dataset.sha256}, dataset hashes to ${identity.sha256}. The version field alone does not authorize a comparison against stale expectations.`,
    );
  }
}

/** Gate: current case-ID set must match the baseline exactly. */
export function assertCaseIds(baseline: BaselineArtifact, current: BaselineArtifact): void {
  const missing = Object.keys(baseline.cases).filter((id) => !(id in current.cases));
  const unexpected = Object.keys(current.cases).filter((id) => !(id in baseline.cases));
  const missingNote = missing.length > 0 ? `missing case IDs: ${missing.join(", ")}` : null;
  const unexpectedNote = unexpected.length > 0 ? `unexpected case IDs: ${unexpected.join(", ")}` : null;
  if (missingNote || unexpectedNote) {
    throw new BaselineGateError(`Case-ID mismatch between baseline and current evaluation (${[missingNote, unexpectedNote].filter(Boolean).join("; ")}).`);
  }
}

// ── Baseline artifact construction and parsing ───────────────────────────────

type ExportedCase = BaselineArtifact["cases"][string];

/** Converts one engine case metric into a stable baseline entry. */
function exportedCase(c: CaseMetricJson): ExportedCase {
  const verdict = c.status as CaseVerdict;
  if (verdict !== "PASS" && verdict !== "WARN" && verdict !== "FAIL") {
    throw new BaselineGateError(`Case ${c.id} has unknown status "${c.status}".`);
  }
  return {
    fixture: c.fixture,
    language: c.language,
    category: c.category,
    verdict,
    metrics: {
      goldLines: c.goldLines,
      retrievedWindows: c.retrievedWindows,
      retrievedLines: c.retrievedLines,
      overlapLines: c.overlapLines,
      linePrecision: c.linePrecision,
      lineRecall: c.lineRecall,
      lineF1: c.lineF1,
      factsTotal: c.factsTotal,
      factsGrounded: c.factsGrounded,
      policyVerified: c.policyVerified,
    },
  };
}

/** Converts an engine JSON report into a baseline-shaped artifact. Duplicate
 * IDs in the report are rejected up front. */
export function artifactFromEvalReport(report: GoldenEvalReport): BaselineArtifact {
  if (!report || !Array.isArray(report.cases) || !report.summary) {
    throw new BaselineGateError("Evaluation report is incomplete (missing cases array or summary).");
  }
  const cases: BaselineArtifact["cases"] = {};
  for (const c of report.cases) {
    if (c.id in cases) {
      throw new BaselineGateError(`Duplicate case ID in evaluation report: ${c.id}.`);
    }
    cases[c.id] = exportedCase(c);
  }
  return {
    baselineSchemaVersion: 1,
    dataset: { version: report.version, sha256: "" },
    reference: "",
    cases,
    summary: JSON.parse(JSON.stringify(report.summary)) as GoldenEvalSummary,
  };
}

/** Builds a complete baseline artifact: engine snapshot + dataset identity. */
export function buildBaselineArtifact(report: GoldenEvalReport, datasetFile: string, reference: string): BaselineArtifact {
  const artifact = artifactFromEvalReport(report);
  artifact.dataset = computeDatasetIdentity(datasetFile);
  artifact.reference = reference;
  return artifact;
}

/** Parses baseline text with clear failure messages for every malformed shape. */
export function parseBaseline(text: string): BaselineArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BaselineGateError(`Baseline is not valid JSON: ${(error as Error).message}`);
  }
  const artifact = parsed as BaselineArtifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new BaselineGateError("Baseline is not a JSON object.");
  }
  if (typeof artifact.baselineSchemaVersion !== "number") {
    throw new BaselineGateError("Baseline is missing a numeric baselineSchemaVersion.");
  }
  if (!artifact.dataset || typeof artifact.dataset.version !== "number" || typeof artifact.dataset.sha256 !== "string") {
    throw new BaselineGateError("Baseline is missing a valid dataset identity (version and sha256).");
  }
  if (!/^[0-9a-f]{64}$/.test(artifact.dataset.sha256)) {
    throw new BaselineGateError(`Baseline dataset sha256 is not a SHA-256 hex digest: "${artifact.dataset.sha256}".`);
  }
  if (!artifact.cases || typeof artifact.cases !== "object" || Array.isArray(artifact.cases)) {
    throw new BaselineGateError("Baseline cases must be an object keyed by case ID.");
  }
  for (const [id, value] of Object.entries(artifact.cases)) {
    const entry = value as ExportedCase;
    if (!entry || (entry.verdict !== "PASS" && entry.verdict !== "WARN" && entry.verdict !== "FAIL") || !entry.metrics) {
      throw new BaselineGateError(`Baseline case ${id} is malformed (verdict/metrics missing or invalid).`);
    }
  }
  if (!artifact.summary || typeof artifact.summary !== "object") {
    throw new BaselineGateError("Baseline is missing a summary.");
  }
  if (typeof artifact.reference !== "string") {
    throw new BaselineGateError("Baseline is missing a reference identifier.");
  }
  return artifact;
}

export function loadBaselineFile(baselineFile: string): BaselineArtifact {
  if (!existsSync(baselineFile)) {
    throw new BaselineGateError(
      `Baseline file not found: ${baselineFile}. Generate it deliberately with: node scripts/eval-golden-diff.ts --approve-update`,
    );
  }
  return parseBaseline(readFileSync(baselineFile, "utf8"));
}

// ── Comparison ───────────────────────────────────────────────────────────────

function sameNumber(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= FLOAT_EPSILON;
}

function pct(n: number | null): string {
  return n === null ? "N/A" : `${(n * 100).toFixed(1)}%`;
}

export type CaseDiff = {
  id: string;
  verdictFrom: CaseVerdict;
  verdictTo: CaseVerdict;
  precisionFrom: number | null;
  precisionTo: number | null;
  recallFrom: number | null;
  recallTo: number | null;
  windowsFrom: number;
  windowsTo: number;
  classification: "unchanged" | "improved" | "regressed" | "warn-accepted" | "warn-improved" | "warn-worsened";
  reasons: string[];
};

export type ComparisonResult = {
  ok: boolean;
  regressions: string[];
  improvements: string[];
  caseDiffs: CaseDiff[];
  aggregateRegressions: string[];
  aggregateNotes: string[];
};

/** Compares two baseline-shaped artifacts (same ID set, already identity-gated).
 * Split so tests can drive every policy branch with small synthetic artifacts. */
export function compareRuns(baseline: BaselineArtifact, current: BaselineArtifact): ComparisonResult {
  const regressions: string[] = [];
  const improvements: string[] = [];
  const caseDiffs: CaseDiff[] = [];
  const aggregateRegressions: string[] = [];
  const aggregateNotes: string[] = [];

  for (const id of Object.keys(baseline.cases)) {
    const b = baseline.cases[id]!;
    const c = current.cases[id]!;
    const reasons: string[] = [];
    let classification: CaseDiff["classification"] = "unchanged";

    // Verdict transitions.
    if (b.verdict !== c.verdict) {
      if (b.verdict === "PASS" && c.verdict === "WARN") {
        const r = `${id}: verdict PASS -> WARN (new unexpected WARN)`;
        regressions.push(r);
        reasons.push(r);
        classification = "regressed";
      } else if (c.verdict === "FAIL") {
        const r = `${id}: verdict ${b.verdict} -> FAIL`;
        regressions.push(r);
        reasons.push(r);
        classification = "regressed";
      } else if (b.verdict === "FAIL") {
        // c.verdict here is PASS or WARN (PASS->WARN and any ->FAIL were the
        // earlier branches), so a previously-failing case recovering on any
        // healthy verdict is an improvement.
        const r = `${id}: verdict FAIL -> ${c.verdict}`;
        improvements.push(r);
        reasons.push(r);
        classification = "improved";
      } else {
        // By elimination: b.verdict === "WARN", c.verdict === "PASS".
        const r = `${id}: verdict WARN -> PASS`;
        improvements.push(r);
        reasons.push(r);
        classification = "improved";
      }
    }

    // Numeric disagreements: null on exactly one side is a structural change
    // (e.g. a gold-line count appearing/disappearing) and fails closed.
    let precisionDeclined = false;
    let precisionImproved = false;
    let recallDeclined = false;
    let recallImproved = false;
    if (sameNumber(b.metrics.linePrecision, c.metrics.linePrecision)) {
      // equal within epsilon
    } else if (b.metrics.linePrecision === null || c.metrics.linePrecision === null) {
      const r = `${id}: line precision ${pct(b.metrics.linePrecision)} -> ${pct(c.metrics.linePrecision)} (measurement appeared/disappeared)`;
      regressions.push(r);
      reasons.push(r);
      classification = "regressed";
    } else {
      precisionDeclined = c.metrics.linePrecision < b.metrics.linePrecision - FLOAT_EPSILON;
      precisionImproved = c.metrics.linePrecision > b.metrics.linePrecision + FLOAT_EPSILON;
    }
    if (sameNumber(b.metrics.lineRecall, c.metrics.lineRecall)) {
      // equal within epsilon
    } else if (b.metrics.lineRecall === null || c.metrics.lineRecall === null) {
      const r = `${id}: line recall ${pct(b.metrics.lineRecall)} -> ${pct(c.metrics.lineRecall)} (measurement appeared/disappeared)`;
      regressions.push(r);
      reasons.push(r);
      classification = "regressed";
    } else {
      recallDeclined = c.metrics.lineRecall < b.metrics.lineRecall - FLOAT_EPSILON;
      recallImproved = c.metrics.lineRecall > b.metrics.lineRecall + FLOAT_EPSILON;
    }

    if (precisionDeclined || recallDeclined) {
      if (b.verdict === "WARN" && c.verdict === "WARN") {
        classification = "warn-worsened";
        const r = `${id}: WARNING worsened (still WARN)${precisionDeclined ? `, precision ${pct(b.metrics.linePrecision)} -> ${pct(c.metrics.linePrecision)}` : ""}${recallDeclined ? `, recall ${pct(b.metrics.lineRecall)} -> ${pct(c.metrics.lineRecall)}` : ""} — per policy any numeric decline on a diagnostic case is a regression`;
        regressions.push(r);
        reasons.push(r);
      } else if (c.verdict !== "FAIL" && b.verdict !== "FAIL") {
        classification = "regressed";
        const r = `${id}: ${precisionDeclined ? "precision" : "recall"} declined${precisionDeclined ? ` ${pct(b.metrics.linePrecision)} -> ${pct(c.metrics.linePrecision)}` : ""}${recallDeclined ? ` recall ${pct(b.metrics.lineRecall)} -> ${pct(c.metrics.lineRecall)}` : ""}`;
        regressions.push(r);
        reasons.push(r);
      }
    } else if (precisionImproved || recallImproved) {
      // A fact/policy regression on the same case outranks a numeric improvement.
      if (classification !== "regressed") {
        if (b.verdict === "WARN" && c.verdict === "WARN") {
          classification = "warn-improved";
        } else {
          classification = classification === "unchanged" ? "improved" : classification;
        }
        const r = `${id}: ${precisionImproved ? `precision improved ${pct(b.metrics.linePrecision)} -> ${pct(c.metrics.linePrecision)}` : ""}${precisionImproved && recallImproved ? ", " : ""}${recallImproved ? `recall improved ${pct(b.metrics.lineRecall)} -> ${pct(c.metrics.lineRecall)}` : ""}`;
        improvements.push(r);
        reasons.push(r);
      }
    }

    // Facts and policy are hard requirements on every case.
    if (c.metrics.factsGrounded < c.metrics.factsTotal && b.metrics.factsGrounded === b.metrics.factsTotal) {
      const r = `${id}: fact grounding lost (${c.metrics.factsGrounded}/${c.metrics.factsTotal}, was ${b.metrics.factsGrounded}/${b.metrics.factsTotal})`;
      regressions.push(r);
      reasons.push(r);
      if (classification === "unchanged") classification = "regressed";
    }
    if (b.metrics.policyVerified && !c.metrics.policyVerified) {
      const r = `${id}: policy compliance lost`;
      regressions.push(r);
      reasons.push(r);
      if (classification === "unchanged") classification = "regressed";
    }

    if (classification === "unchanged") {
      if (b.verdict === "WARN" && c.verdict === "WARN") {
        classification = "warn-accepted";
      }
    }

    caseDiffs.push({
      id,
      verdictFrom: b.verdict,
      verdictTo: c.verdict,
      precisionFrom: b.metrics.linePrecision,
      precisionTo: c.metrics.linePrecision,
      recallFrom: b.metrics.lineRecall,
      recallTo: c.metrics.lineRecall,
      windowsFrom: b.metrics.retrievedWindows,
      windowsTo: c.metrics.retrievedWindows,
      classification,
      reasons,
    });
  }

  // Aggregates (belt-and-braces; they mirror the per-case verdicts).
  // Direction is explicit per metric: an INCREASE in failed or warned cases
  // is a regression, a DECREASE is an improvement; every ratio metric is the
  // reverse. Counts are printed as integers, ratios as percentages.
  const bs = baseline.summary;
  const cs = current.summary;
  const aggChecks: Array<{ name: string; from: number; to: number; higherIsBetter: boolean; format: (n: number) => string }> = [
    { name: "failed cases", from: bs.failed, to: cs.failed, higherIsBetter: false, format: String },
    { name: "warned cases", from: bs.warned, to: cs.warned, higherIsBetter: false, format: String },
    { name: "facts grounded", from: bs.factsGrounded, to: cs.factsGrounded, higherIsBetter: true, format: String },
    { name: "abstention passes", from: bs.abstention.passed, to: cs.abstention.passed, higherIsBetter: true, format: String },
    { name: "micro precision", from: bs.microMetrics.precision ?? 0, to: cs.microMetrics.precision ?? 0, higherIsBetter: true, format: pct },
    { name: "micro recall", from: bs.microMetrics.recall ?? 0, to: cs.microMetrics.recall ?? 0, higherIsBetter: true, format: pct },
    { name: "micro F1", from: bs.microMetrics.f1 ?? 0, to: cs.microMetrics.f1 ?? 0, higherIsBetter: true, format: pct },
    { name: "macro precision", from: bs.macroMetrics.precision ?? 0, to: cs.macroMetrics.precision ?? 0, higherIsBetter: true, format: pct },
    { name: "macro recall", from: bs.macroMetrics.recall ?? 0, to: cs.macroMetrics.recall ?? 0, higherIsBetter: true, format: pct },
    { name: "macro F1", from: bs.macroMetrics.f1 ?? 0, to: cs.macroMetrics.f1 ?? 0, higherIsBetter: true, format: pct },
  ];
  for (const { name, from, to, higherIsBetter, format } of aggChecks) {
    if (sameNumber(from, to)) {
      aggregateNotes.push(`${name}: ${format(from)} (unchanged)`);
    } else if ((higherIsBetter && to < from - FLOAT_EPSILON) || (!higherIsBetter && to > from + FLOAT_EPSILON)) {
      aggregateRegressions.push(`${name} ${higherIsBetter ? "declined" : "increased"}: ${format(from)} -> ${format(to)}`);
    } else {
      aggregateNotes.push(`${name} ${higherIsBetter ? "improved" : "reduced"}: ${format(from)} -> ${format(to)}`);
    }
  }

  // Fact-grounding rate (grounded/totalFacts): mirrored ratio with explicit
  // higher-is-better direction. A missing rate on either side (a hand-made
  // artifact without the field, or a vacuous zero-fact dataset) leaves
  // nothing comparable — no regression is invented from absent data.
  const bRate = bs.factGroundingRate;
  const cRate = cs.factGroundingRate;
  if (typeof bRate === "number" && typeof cRate === "number") {
    if (sameNumber(bRate, cRate)) {
      aggregateNotes.push(`fact grounding rate: ${pct(bRate)} (unchanged)`);
    } else if (cRate < bRate - FLOAT_EPSILON) {
      aggregateRegressions.push(`fact grounding rate declined: ${pct(bRate)} -> ${pct(cRate)}`);
    } else {
      aggregateNotes.push(`fact grounding rate improved: ${pct(bRate)} -> ${pct(cRate)}`);
    }
  }

  const ok = regressions.length === 0 && aggregateRegressions.length === 0;
  return { ok, regressions, improvements, caseDiffs, aggregateRegressions, aggregateNotes };
}

// ── Evaluation runner (spawns the real engine; never reimplements it) ────────

export type EvalRun = { status: number | null; report: GoldenEvalReport | null; stderrTail: string };

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function runGoldenEvalJson(): EvalRun {
  const result = spawnSync(process.execPath, [path.join(HERE, "eval-golden-qa.ts"), "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    cwd: path.join(HERE, ".."),
  });
  const stderrTail = (result.stderr ?? "").split("\n").slice(-8).join("\n").trim();
  if (result.status !== 0 || !result.stdout) {
    return { status: result.status, report: null, stderrTail };
  }
  try {
    const report = JSON.parse(result.stdout) as GoldenEvalReport;
    return { status: result.status, report, stderrTail };
  } catch (error) {
    return { status: result.status, report: null, stderrTail: `report JSON parse failed: ${(error as Error).message}\n${stderrTail}` };
  }
}

// ── Explicit baseline update (atomic, gated, never automatic) ────────────────

export type DatasetIntegrity = { ok: boolean; problems: string[] };

/** Minimal structural integrity check for the dataset before an update is
 * allowed: valid JSON, integer version >= 1, a non-empty case array with
 * unique non-empty case IDs. The deeper semantic battery is
 * `pnpm test:qa-dataset`; the existing-baseline schema version is gated
 * separately in `updateBaselineFile`, not here. */
export function checkDatasetIntegrity(datasetFile: string): DatasetIntegrity {
  const problems: string[] = [];
  let parsed: { version?: unknown; cases?: unknown };
  try {
    parsed = JSON.parse(readFileSync(datasetFile, "utf8"));
  } catch (error) {
    return { ok: false, problems: [`dataset is not valid JSON: ${(error as Error).message}`] };
  }
  if (typeof parsed.version !== "number" || !Number.isInteger(parsed.version) || parsed.version < 1) {
    problems.push("dataset version is missing or invalid");
  }
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    problems.push("dataset cases is not a non-empty array");
  } else {
    const seen = new Set<string>();
    for (const c of parsed.cases as { id?: unknown }[]) {
      const id = String(c?.id ?? "");
      if (!id) problems.push("a case is missing its id");
      else if (seen.has(id)) problems.push(`duplicate case ID in dataset: ${id}`);
      else seen.add(id);
    }
  }
  return { ok: problems.length === 0, problems };
}

export type UpdateOutcome =
  | { written: false; reason: string; before: BaselineArtifact | null; after: BaselineArtifact | null }
  | { written: true; reason: null; before: BaselineArtifact | null; after: BaselineArtifact };

/** Explicit baseline refresh. Gates, in order: explicit approval; dataset
 * integrity; existing-baseline schema compatibility; completed evaluation
 * (engine exit 0, zero hard failures, every dataset case present). Writes via
 * temp file + rename so an interrupted write can never leave a partial
 * baseline. A normal comparison NEVER calls this. */
export function updateBaselineFile(options: {
  baselineFile: string;
  datasetFile: string;
  report: GoldenEvalReport | null;
  evalStatus: number;
  approve: boolean;
  reference?: string;
}): UpdateOutcome {
  if (!options.approve) {
    let before: BaselineArtifact | null = null;
    let malformedNote = "";
    if (existsSync(options.baselineFile)) {
      try {
        before = loadBaselineFile(options.baselineFile);
      } catch (error) {
        // A malformed existing baseline is refused the same way as any other
        // unusable state — reported, not overwritten, and never thrown past
        // the formatted refusal output.
        malformedNote = ` (the existing baseline could not be loaded: ${(error as Error).message})`;
      }
    }
    return {
      written: false,
      reason: `Baseline update requires explicit approval: re-run with --approve-update. Normal comparison never rewrites the baseline.${malformedNote}`,
      before,
      after: null,
    };
  }

  const integrity = checkDatasetIntegrity(options.datasetFile);
  if (!integrity.ok) {
    return { written: false, reason: `Dataset integrity failed; baseline not written: ${integrity.problems.join("; ")}`, before: null, after: null };
  }

  let before: BaselineArtifact | null = null;
  if (existsSync(options.baselineFile)) {
    try {
      before = loadBaselineFile(options.baselineFile);
    } catch (error) {
      // A malformed existing baseline must surface as the standard refusal
      // outcome (no stack trace anywhere), and the file must stay untouched.
      return {
        written: false,
        reason: `Existing baseline is malformed or unsupported; refusing to overwrite it. Fix or remove the baseline deliberately, then re-run. (${(error as Error).message})`,
        before: null,
        after: null,
      };
    }
    if (!SUPPORTED_BASELINE_SCHEMA_VERSIONS.includes(before.baselineSchemaVersion as 1)) {
      return {
        written: false,
        reason: `Existing baseline schema version ${before.baselineSchemaVersion} is not supported (supported: ${SUPPORTED_BASELINE_SCHEMA_VERSIONS.join(", ")}); refusing to overwrite.`,
        before,
        after: null,
      };
    }
  }

  if (options.evalStatus !== 0 || !options.report || !options.report.cases || !options.report.summary || !options.report.cases.some((c) => c && c.id)) {
    return {
      written: false,
      reason: `Evaluation did not complete successfully (engine exit ${options.evalStatus}${options.report && !options.report.cases?.length ? ", incomplete report" : ""}); baseline not written. Diagnose the failure before refreshing the baseline.`,
      before,
      after: null,
    };
  }
  if (options.report.summary.failed > 0) {
    return {
      written: false,
      reason: `Evaluation has ${options.report.summary.failed} hard FAIL case(s); refusing to record them into the baseline. Baselines document accepted healthy behaviour, not failing runs.`,
      before,
      after: null,
    };
  }
  const datasetCases = (JSON.parse(readFileSync(options.datasetFile, "utf8")) as { cases: { id: string }[] }).cases;
  const missing = datasetCases.filter((c) => !options.report!.cases.some((r) => r.id === c.id));
  if (missing.length > 0) {
    return { written: false, reason: `Evaluation incomplete: dataset case(s) absent from report: ${missing.map((c) => c.id).join(", ")}.`, before, after: null };
  }

  const reference = options.reference ?? "phase-3a";
  const after = buildBaselineArtifact(options.report, options.datasetFile, reference);

  // Atomic write: temp file in the target directory, then rename.
  const dir = path.dirname(options.baselineFile);
  mkdirSync(dir, { recursive: true });
  const tmp = `${options.baselineFile}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(after, null, 2)}\n`, "utf8");
    renameSync(tmp, options.baselineFile);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort cleanup only */ }
    return { written: false, reason: `Atomic baseline write failed; original left untouched: ${(error as Error).message}`, before, after: null };
  }
  return { written: true, reason: null, before, after };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

interface CliOptions {
  baselineFile: string;
  datasetFile: string;
  json: boolean;
  approveUpdate: boolean;
  reference?: string;
}

const DEFAULT_BASELINE = path.join(FIXTURES, "golden-qa.baseline.json");
const DEFAULT_DATASET = path.join(FIXTURES, "golden-qa.json");

function printHelp(): void {
  console.log(`
Usage: node scripts/eval-golden-diff.ts [options]

Options:
  --baseline <file>      Baseline artifact (default: fixtures/golden-qa.baseline.json)
  --dataset <file>       Golden dataset (default: fixtures/golden-qa.json)
  --json                 Machine-readable comparison report
  --approve-update       Explicitly refresh the baseline after an approved change
                         (requires a completed evaluation: engine exit 0, zero FAIL
                         cases; writes atomically; never part of normal comparison)
  --reference <id>       Baseline generation reference for --approve-update
                         (default: "phase-3a")
  -h, --help             Show this help message

Exit codes: 0 = no regressions (or approved update written); 1 = regression,
identity/gate failure, malformed baseline, or refused update.
`);
}

/** Mode-dependent CLI validation: --json is a comparison-output format, not an
 * update-output format. Returns a usage-error message, or null when the
 * combination is valid. */
export function validateCliMode(json: boolean, approveUpdate: boolean): string | null {
  if (json && approveUpdate) {
    return "--json cannot be combined with --approve-update: update output is a human review summary, not a machine-readable comparison report. Re-run without --json.";
  }
  return null;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = { baselineFile: DEFAULT_BASELINE, datasetFile: DEFAULT_DATASET, json: false, approveUpdate: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--baseline" && i + 1 < argv.length) options.baselineFile = argv[++i]!;
    else if (arg.startsWith("--baseline=")) options.baselineFile = arg.slice("--baseline=".length);
    else if (arg === "--dataset" && i + 1 < argv.length) options.datasetFile = argv[++i]!;
    else if (arg.startsWith("--dataset=")) options.datasetFile = arg.slice("--dataset=".length);
    else if (arg === "--json") options.json = true;
    else if (arg === "--approve-update") options.approveUpdate = true;
    else if (arg === "--reference" && i + 1 < argv.length) options.reference = argv[++i]!;
    else if (arg.startsWith("--reference=")) options.reference = arg.slice("--reference=".length);
    else {
      console.error(`Unknown argument: "${arg}". Use --help for usage.`);
      process.exit(1);
    }
  }
  return options;
}

function formatCaseDiff(d: CaseDiff): string {
  const verdict = d.verdictFrom === d.verdictTo ? d.verdictTo.padEnd(4) : `${d.verdictFrom}->${d.verdictTo}`.padEnd(9);
  return `${d.id.padEnd(6)} | ${verdict} | P ${pct(d.precisionFrom)} -> ${pct(d.precisionTo)} | R ${pct(d.recallFrom)} -> ${pct(d.recallTo)} | ${d.windowsFrom}->${d.windowsTo} win | ${d.classification}${d.reasons.length > 0 ? `  [${d.reasons[0]}]` : ""}`;
}

async function runComparison(options: CliOptions): Promise<void> {
  try {
    // 1. Identity gates BEFORE spending effort on an evaluation run.
    assertDatasetIdentity(loadBaselineFile(options.baselineFile), options.datasetFile);
    console.log("=== Dataset identity ===");
    console.log("ok    baseline schema, dataset version and SHA-256 match");
  } catch (error) {
    if (options.json) console.log(JSON.stringify({ ok: false, gateError: (error as BaselineGateError).message }, null, 2));
    else {
      console.error(`=== Comparison refused ===\n${(error as BaselineGateError).message}`);
      console.error("\nNO COMPARISON PERFORMED. Update the baseline deliberately with --approve-update after reviewer approval.");
    }
    process.exit(1);
  }

  // 2. Fresh deterministic evaluation (the real engine, unmodified).
  const run = runGoldenEvalJson();
  if (run.report === null) {
    const message = `Golden evaluation did not complete (exit ${run.status}): ${run.stderrTail || "no output"}\nNO COMPARISON PERFORMED; baseline untouched.`;
    if (options.json) console.log(JSON.stringify({ ok: false, gateError: message }, null, 2));
    else console.error(message);
    process.exit(1);
  }

  try {
    const baseline = loadBaselineFile(options.baselineFile);
    const current = artifactFromEvalReport(run.report);
    assertCaseIds(baseline, current);
    const comparison = compareRuns(baseline, current);

    if (options.json) {
      console.log(JSON.stringify({ ok: comparison.ok, regressions: [...comparison.regressions, ...comparison.aggregateRegressions], improvements: comparison.improvements, caseDiffs: comparison.caseDiffs, aggregateNotes: comparison.aggregateNotes }, null, 2));
    } else {
      console.log("\n=== Per-case comparison (a -> b means verdict/metric change; identical values mean unchanged) ===");
      for (const d of comparison.caseDiffs) console.log(formatCaseDiff(d));
      console.log("\n=== Aggregate comparison ===");
      for (const note of comparison.aggregateNotes) console.log(`· ${note}`);
      for (const r of comparison.aggregateRegressions) console.log(`REGRESSION  ${r}`);
      console.log("\n=== Summary ===");
      const improved = comparison.caseDiffs.filter((d) => d.classification === "improved" || d.classification === "warn-improved").length;
      const accepted = comparison.caseDiffs.filter((d) => d.classification === "unchanged" || d.classification === "warn-accepted").length;
      const regressed = comparison.caseDiffs.filter((d) => d.classification === "regressed" || d.classification === "warn-worsened").length;
      console.log(`${accepted} unchanged/accepted, ${improved} improved, ${regressed} regressed`);
      if (comparison.ok) {
        console.log(`\nNO REGRESSIONS against ${path.basename(options.baselineFile)} (reference: ${baseline.reference}; dataset ${baseline.dataset.version}, sha256 ${baseline.dataset.sha256.slice(0, 12)}…).`);
      } else {
        for (const r of [...comparison.regressions, ...comparison.aggregateRegressions]) console.error(`REGRESSION  ${r}`);
        console.error("\nREGRESSIONS DETECTED. Fix the cause, or — if the change is intended — update the baseline deliberately with --approve-update after reviewer approval.");
      }
    }
    if (!comparison.ok) process.exit(1);
  } catch (error) {
    const message = (error as BaselineGateError).message;
    if (options.json) console.log(JSON.stringify({ ok: false, gateError: message }, null, 2));
    else {
      console.error(`=== Comparison refused ===\n${message}`);
      console.error("\nNO COMPARISON PERFORMED; baseline untouched.");
    }
    process.exit(1);
  }
}

async function runUpdate(options: CliOptions): Promise<void> {
  // Dataset integrity first: a broken dataset must never seed a new baseline.
  const integrity = checkDatasetIntegrity(options.datasetFile);
  if (!integrity.ok) {
    console.error(`=== Update refused ===\nDataset integrity failed: ${integrity.problems.join("; ")}\nBaseline NOT written.`);
    process.exit(1);
  }
  const run = runGoldenEvalJson();
  const outcome = updateBaselineFile({
    baselineFile: options.baselineFile,
    datasetFile: options.datasetFile,
    report: run.report,
    evalStatus: run.report === null ? 1 : 0,
    approve: options.approveUpdate,
    reference: options.reference,
  });
  if (!outcome.written) {
    console.error(`=== Update refused ===\n${outcome.reason}\nBaseline NOT written.`);
    process.exit(1);
  }
  const before = outcome.before?.summary;
  const after = outcome.after.summary;
  console.log("=== Baseline updated (atomic) ===");
  console.log(`Reference: ${outcome.after.reference}`);
  console.log(`Dataset version: ${outcome.after.dataset.version}  sha256: ${outcome.after.dataset.sha256}`);
  console.log(`Schema version: ${outcome.after.baselineSchemaVersion}`);
  console.log(
    `Before: ${before ? `${before.passed} PASS / ${before.warned} WARN / ${before.failed} FAIL, facts ${before.factsGrounded}/${before.totalFacts}` : "(no previous baseline)"}`,
  );
  console.log(`After:  ${after.passed} PASS / ${after.warned} WARN / ${after.failed} FAIL, facts ${after.factsGrounded}/${after.totalFacts}`);
  console.log(`Micro-precision ${(after.microMetrics.precision! * 100).toFixed(1)}% (${after.microMetrics.overlappingLines}/${after.microMetrics.retrievedLines}), micro-recall ${(after.microMetrics.recall! * 100).toFixed(1)}% (${after.microMetrics.overlappingLines}/${after.microMetrics.goldLines})`);
  console.log(`Cases: ${Object.keys(outcome.after.cases).join(", ")}`);
  console.log("\nReview the written baseline with git diff before committing.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const options = parseCliArgs(process.argv.slice(2));
  const modeError = validateCliMode(options.json, options.approveUpdate);
  if (modeError) {
    console.error(`Usage error: ${modeError}`);
    process.exit(1);
  }
  const run = options.approveUpdate ? runUpdate(options) : runComparison(options);
  Promise.resolve(run).catch((err) => {
    console.error(`Comparison runtime error: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
}
