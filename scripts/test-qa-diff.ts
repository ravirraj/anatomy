// Deterministic tests for the Phase 3A golden-QA baseline comparator
// (scripts/eval-golden-diff.ts). All comparison-policy branches run against
// synthetic artifacts derived from the committed baseline; file-level tests
// (identity, update, atomicity) run in a temporary directory so the committed
// baseline is never modified.
//
//   pnpm test  (chain entry: node scripts/test-qa-diff.ts)

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIXTURES } from "./test-fixtures-shared.ts";
import {
  artifactFromEvalReport,
  assertCaseIds,
  assertDatasetIdentity,
  BaselineGateError,
  compareRuns,
  loadBaselineFile,
  parseBaseline,
  runGoldenEvalJson,
  updateBaselineFile,
  validateCliMode,
  type BaselineArtifact,
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

const BASELINE_FILE = path.join(FIXTURES, "golden-qa.baseline.json");
const DATASET_FILE = path.join(FIXTURES, "golden-qa.json");

console.log("=== Golden QA baseline comparison tests (Phase 3A) ===");

// Deep clone helper for synthetic artifacts.
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ── Test 1: unchanged baseline passes (real engine, committed baseline) ──────
let realReport: GoldenEvalReport | null = null;
{
  // Spawn the real deterministic engine once; the artifact must match the
  // committed baseline with zero regressions AND zero improvements.
  const run = runGoldenEvalJson();
  try {
    if (run.report === null) throw new BaselineGateError(`real evaluation failed (exit ${run.status}): ${run.stderrTail}`);
    realReport = run.report;
    const baseline = loadBaselineFile(BASELINE_FILE);
    const current = artifactFromEvalReport(run.report);
    assertCaseIds(baseline, current);
    const comparison = compareRuns(baseline, current);
    if (comparison.ok && comparison.improvements.length === 0 && comparison.regressions.length === 0) {
      pass("unchanged baseline passes against the real deterministic evaluation (no regressions, no drift)");
    } else {
      fail(`unchanged baseline did not pass cleanly: regressions=${JSON.stringify(comparison.regressions)} improvements=${JSON.stringify(comparison.improvements)} aggregate=${JSON.stringify(comparison.aggregateRegressions)}`);
    }
  } catch (error) {
    fail(`unchanged baseline check errored: ${(error as Error).message}`);
  }
}

const BASELINE = loadBaselineFile(BASELINE_FILE);

if (realReport === null) {
  // The remaining tests (12, 16–18) derive from a real run; abort cleanly
  // rather than crashing midway (test 1 has already recorded the failure).
  console.error("\nReal deterministic evaluation unavailable; the committed baseline cannot be validated. Aborting baseline tests.");
  process.exit(1);
}

function expectRegression(current: BaselineArtifact, mustContain: string, label: string): void {
  const comparison = compareRuns(BASELINE, current);
  if (comparison.ok) {
    fail(`${label}: comparison falsely accepted (ok=true)`);
    return;
  }
  const all = [...comparison.regressions, ...comparison.aggregateRegressions];
  if (all.some((r) => r.includes(mustContain))) {
    pass(label);
  } else {
    fail(`${label}: expected a regression naming "${mustContain}", got ${JSON.stringify(all)}`);
  }
}

// ── Test 2: improved precision/recall accepted and reported ──────────────────
{
  const current = clone(BASELINE);
  current.cases["QA-01"]!.metrics.linePrecision = 0.9;
  current.cases["QA-06"]!.metrics.lineRecall = 1;
  const comparison = compareRuns(BASELINE, current);
  const improved = comparison.improvements.filter((r) => r.includes("QA-01") || r.includes("QA-06"));
  if (comparison.ok && improved.length === 2 && comparison.regressions.length === 0) {
    pass("improved precision/recall accepted and reported");
  } else {
    fail(`improvement handling: ok=${comparison.ok} improvements=${JSON.stringify(comparison.improvements)} regressions=${JSON.stringify(comparison.regressions)}`);
  }
}

// ── Test 3: PASS -> WARN rejected ─────────────────────────────────────────────
{
  const current = clone(BASELINE);
  current.cases["QA-01"]!.verdict = "WARN";
  expectRegression(current, "QA-01: verdict PASS -> WARN (new unexpected WARN)", "PASS -> WARN rejected");
}

// ── Test 4: PASS -> FAIL rejected ─────────────────────────────────────────────
{
  const current = clone(BASELINE);
  current.cases["QA-01"]!.verdict = "FAIL";
  expectRegression(current, "QA-01: verdict PASS -> FAIL", "PASS -> FAIL rejected");
}

// ── Test 5: WARN -> FAIL rejected ─────────────────────────────────────────────
{
  const current = clone(BASELINE);
  current.cases["QA-05"]!.verdict = "FAIL";
  expectRegression(current, "QA-05: verdict WARN -> FAIL", "WARN -> FAIL rejected");
}

// ── Test 6: existing QA-05 WARN remains accepted ─────────────────────────────
{
  const current = clone(BASELINE); // exact committed baseline, QA-05 WARN untouched
  const comparison = compareRuns(BASELINE, current);
  const qa05 = comparison.caseDiffs.find((d) => d.id === "QA-05");
  if (comparison.ok && qa05?.classification === "warn-accepted") {
    pass("existing QA-05 18.8% precision WARN remains accepted (baseline-encoded, no hard-coded special case)");
  } else {
    fail(`existing WARN acceptance: ok=${comparison.ok} classification=${qa05?.classification}`);
  }
}

// ── Test 7: another new unexpected WARN rejected ──────────────────────────────
{
  const current = clone(BASELINE);
  current.cases["QA-04"]!.verdict = "WARN";
  expectRegression(current, "QA-04: verdict PASS -> WARN (new unexpected WARN)", "new unexpected WARN (QA-04) rejected");
}

// ── Test 8: worsened existing WARN reported per policy (regression) ──────────
{
  const current = clone(BASELINE);
  current.cases["QA-05"]!.verdict = "WARN"; // still WARN, no verdict change
  current.cases["QA-05"]!.metrics.linePrecision = 0.05; // 18.75% -> 5%
  const comparison = compareRuns(BASELINE, current);
  const qa05 = comparison.caseDiffs.find((d) => d.id === "QA-05");
  if (!comparison.ok && qa05?.classification === "warn-worsened" && comparison.regressions.some((r) => r.includes("QA-05") && r.includes("WARNING worsened"))) {
    pass("worsened existing WARN reported and rejected per the documented any-decline rule");
  } else {
    fail(`worsened WARN handling: ok=${comparison.ok} classification=${qa05?.classification} regressions=${JSON.stringify(comparison.regressions)}`);
  }
}

// ── Addition (F5): CLI mode validation — --json rejected with --approve-update ─
{
  const combo = validateCliMode(true, true);
  if (combo !== null && combo.includes("--approve-update") && combo.includes("--json")) {
    pass("--json combined with --approve-update rejected with an explicit usage error");
  } else {
    fail(`--json/--approve-update mode validation wrong: ${JSON.stringify(combo)}`);
  }
  const updateNoJson = validateCliMode(false, true);
  const comparisonWithJson = validateCliMode(true, false);
  if (updateNoJson === null && comparisonWithJson === null) {
    pass("valid CLI mode combinations accepted (update without --json, comparison with --json)");
  } else {
    fail(`valid mode combinations wrongly rejected: ${JSON.stringify([updateNoJson, comparisonWithJson])}`);
  }
}

// ── Addition (F6): fact-grounding-rate aggregate regression detection ────────
{
  // Decline: baseline recorded factGroundingRate 1 (37/37); a lower rate is a
  // regression reported with explicit percentages.
  const current = clone(BASELINE);
  current.summary.factGroundingRate = 0.9;
  const comparison = compareRuns(BASELINE, current);
  if (!comparison.ok && comparison.aggregateRegressions.some((r) => r.includes("fact grounding rate declined") && r.includes("100.0%") && r.includes("90.0%"))) {
    pass("fact-grounding-rate decline rejected as an aggregate regression with explicit percentages");
  } else {
    fail(`fact-grounding-rate decline wrong: ok=${comparison.ok} aggregates=${JSON.stringify(comparison.aggregateRegressions)}`);
  }
  // Improvement: a higher rate than the baseline's is accepted, not flagged.
  const modifiedBaseline = clone(BASELINE);
  modifiedBaseline.summary.factGroundingRate = 0.9;
  const improved = clone(modifiedBaseline);
  improved.summary.factGroundingRate = 1;
  const improvementRun = compareRuns(modifiedBaseline, improved);
  if (improvementRun.ok && improvementRun.aggregateRegressions.length === 0 && improvementRun.aggregateNotes.some((r) => r.includes("fact grounding rate improved"))) {
    pass("fact-grounding-rate improvement accepted without a regression");
  } else {
    fail(`fact-grounding-rate improvement wrong: ok=${improvementRun.ok} aggregates=${JSON.stringify(improvementRun.aggregateRegressions)} notes=${JSON.stringify(improvementRun.aggregateNotes)}`);
  }
}

// ── Temp directory for file-level tests (dataset identity + updates) ─────────
const tempDir = mkdtempSync(path.join(os.tmpdir(), "qa-diff-test-"));
try {
  // ── Test 9: dataset version mismatch rejected ──────────────────────────────
  {
    const mismFile = path.join(tempDir, "dataset-version-2.json");
    const dataset = JSON.parse(readFileSync(DATASET_FILE, "utf8")) as { version: number };
    dataset.version = 2;
    writeFileSync(mismFile, JSON.stringify(dataset, null, 2), "utf8");
    try {
      assertDatasetIdentity(BASELINE, mismFile);
      fail("dataset version mismatch was not rejected");
    } catch (error) {
      if ((error as BaselineGateError).message.includes("Dataset version changed")) pass("dataset version mismatch rejected with clear reason");
      else fail(`dataset version mismatch error unclear: ${(error as Error).message}`);
    }
  }

  // ── Test 10: dataset hash mismatch rejected ────────────────────────────────
  {
    const hashMismatchFile = path.join(tempDir, "dataset-same-version-edited.json");
    const dataset = JSON.parse(readFileSync(DATASET_FILE, "utf8")) as { description: string };
    dataset.description = `${dataset.description} (edited)`;
    writeFileSync(hashMismatchFile, JSON.stringify(dataset, null, 2), "utf8");
    try {
      assertDatasetIdentity(BASELINE, hashMismatchFile);
      fail("dataset hash mismatch was not rejected (same version field, edited bytes)");
    } catch (error) {
      if ((error as BaselineGateError).message.includes("Dataset SHA-256 changed")) pass("dataset hash mismatch rejected even when version field matches");
      else fail(`dataset hash mismatch error unclear: ${(error as Error).message}`);
    }
  }

  // ── Test 11: unsupported baseline schema rejected ──────────────────────────
  {
    const future = clone(BASELINE);
    future.baselineSchemaVersion = 2;
    try {
      assertDatasetIdentity(future, DATASET_FILE);
      fail("unsupported baseline schema version was not rejected");
    } catch (error) {
      if ((error as BaselineGateError).message.includes("not supported")) pass("unsupported baseline schema version rejected");
      else fail(`unsupported schema error unclear: ${(error as Error).message}`);
    }
  }

  // ── Test 12: duplicate case IDs rejected ───────────────────────────────────
  {
    const dup = clone(realReport!);
    dup.cases.push(clone(dup.cases[0]!));
    try {
      artifactFromEvalReport(dup);
      fail("duplicate case ID in evaluation report was not rejected");
    } catch (error) {
      if ((error as BaselineGateError).message.includes("Duplicate case ID")) pass("duplicate case IDs rejected");
      else fail(`duplicate-ID error unclear: ${(error as Error).message}`);
    }
  }

  // ── Test 13: missing case IDs rejected ─────────────────────────────────────
  {
    const current = clone(BASELINE);
    delete current.cases["QA-16"];
    try {
      assertCaseIds(BASELINE, current);
      fail("missing case ID was not rejected");
    } catch (error) {
      if ((error as BaselineGateError).message.includes("QA-16") && (error as BaselineGateError).message.includes("missing")) {
        pass("missing case IDs rejected and named");
      } else fail(`missing-ID error unclear: ${(error as Error).message}`);
    }
  }

  // ── Test 14: unexpected case IDs rejected ──────────────────────────────────
  {
    const current = clone(BASELINE);
    const extra = clone(current.cases["QA-01"]!);
    current.cases["QA-17"] = extra;
    try {
      assertCaseIds(BASELINE, current);
      fail("unexpected case ID was not rejected");
    } catch (error) {
      if ((error as BaselineGateError).message.includes("QA-17") && (error as BaselineGateError).message.includes("unexpected")) {
        pass("unexpected case IDs rejected and named");
      } else fail(`unexpected-ID error unclear: ${(error as Error).message}`);
    }
  }

  // ── Test 15: malformed baseline JSON rejected ───────────────────────────────
  {
    for (const [label, text] of [
      ["not JSON at all", "this is not json {{{"],
      ["truncated JSON", '{"baselineSchemaVersion": 1, "dataset": {"vers'],
    ] as const) {
      try {
        parseBaseline(text);
        fail(`malformed baseline (${label}) was not rejected`);
      } catch (error) {
        if ((error as BaselineGateError).message.includes("not a JSON object") || (error as BaselineGateError).message.includes("not valid JSON") || (error as BaselineGateError).message.includes("truncated")) pass(`malformed baseline rejected (${label})`);
        else fail(`malformed baseline (${label}) error unclear: ${(error as Error).message}`);
      }
    }
    try {
      const notAnObject = parseBaseline(JSON.stringify([1, 2, 3]));
      void notAnObject;
      fail("payload of `not a JSON object` should not have been accepted");
    } catch (error) {
      if ((error as BaselineGateError).message.includes("not a JSON object")) pass("malformed baseline rejected (array instead of object)");
      else fail(`array-baseline error unclear: ${(error as Error).message}`);
    }
  }

  // Temp baseline file shared by update tests (copy of the committed artifact).
  const tempBaseline = path.join(tempDir, "baseline.json");
  copyFileSync(BASELINE_FILE, tempBaseline);
  const tempBaselineBytes = () => readFileSync(tempBaseline);

  // ── Test 16: failed/incomplete evaluation cannot update the baseline ───────
  {
    const healthyReport = realReport!;
    const failing = clone(healthyReport);
    failing.summary.failed = 1;
    failing.cases = failing.cases.map((c) => (c.id === "QA-01" ? { ...c, status: "FAIL" } : c));
    const outcome1 = updateBaselineFile({ baselineFile: tempBaseline, datasetFile: DATASET_FILE, report: failing, evalStatus: 0, approve: true });
    const outcome2 = updateBaselineFile({ baselineFile: tempBaseline, datasetFile: DATASET_FILE, report: healthyReport, evalStatus: 1, approve: true });
    const incomplete = clone(healthyReport);
    incomplete.cases = incomplete.cases.filter((c) => c.id !== "QA-16");
    const outcome3 = updateBaselineFile({ baselineFile: tempBaseline, datasetFile: DATASET_FILE, report: incomplete, evalStatus: 0, approve: true });
    if (!outcome1.written && outcome1.reason!.includes("FAIL") && !outcome2.written && outcome2.reason!.includes("did not complete") && !outcome3.written && outcome3.reason!.includes("absent from report")) {
      pass("failed/incomplete evaluations cannot update the baseline (3 refusal paths, file untouched)");
      if (tempBaselineBytes().equals(readFileSync(BASELINE_FILE))) pass("refused updates left the baseline byte-identical");
      else fail("a refused update modified the baseline file");
    } else {
      fail(`update refusals wrong: ${JSON.stringify([outcome1.written, outcome2.written, outcome3.written, outcome1.reason, outcome2.reason, outcome3.reason])}`);
    }
  }

  // ── Test 17: baseline update requires explicit approval ────────────────────
  {
    const outcome = updateBaselineFile({ baselineFile: tempBaseline, datasetFile: DATASET_FILE, report: realReport!, evalStatus: 0, approve: false });
    if (!outcome.written && outcome.reason!.includes("--approve-update") && tempBaselineBytes().equals(readFileSync(BASELINE_FILE))) {
      pass("update without explicit approval refused and file untouched");
    } else {
      fail(`approval gate wrong: written=${outcome.written} reason=${outcome.reason}`);
    }
  }

  // ── Addition (F2): malformed / unsupported existing baselines in update mode ─
  // Both must return the standard refusal outcome (which runUpdate prints as
  // "=== Update refused ==="), never throw a stack trace, and never modify
  // the existing file.
  {
    const malformedFile = path.join(tempDir, "baseline-malformed.json");
    const garbage = "this is not json {{{";
    writeFileSync(malformedFile, garbage, "utf8");
    const malformed = updateBaselineFile({ baselineFile: malformedFile, datasetFile: DATASET_FILE, report: realReport!, evalStatus: 0, approve: true });
    const malformedUntouched = readFileSync(malformedFile, "utf8") === garbage;
    if (!malformed.written && malformed.reason!.includes("refusing to overwrite") && malformedUntouched) {
      pass("malformed existing baseline refused in update mode with the standard refusal (not a throw), file byte-identical");
    } else {
      fail(`malformed-baseline update wrong: written=${malformed.written} reason=${malformed.reason} untouched=${malformedUntouched}`);
    }

    const notApproved = updateBaselineFile({ baselineFile: malformedFile, datasetFile: DATASET_FILE, report: realReport!, evalStatus: 0, approve: false });
    const stillUntouched = readFileSync(malformedFile, "utf8") === garbage;
    if (!notApproved.written && notApproved.reason!.includes("--approve-update") && stillUntouched) {
      pass("update without approval on a malformed existing baseline refused, file byte-identical");
    } else {
      fail(`no-approval malformed-baseline refusal wrong: written=${notApproved.written} reason=${notApproved.reason} untouched=${stillUntouched}`);
    }

    const schema2File = path.join(tempDir, "baseline-schema2.json");
    const schema2 = clone(BASELINE);
    schema2.baselineSchemaVersion = 2;
    const schema2Bytes = Buffer.from(JSON.stringify(schema2, null, 2), "utf8");
    writeFileSync(schema2File, schema2Bytes, "utf8");
    const schema2Outcome = updateBaselineFile({ baselineFile: schema2File, datasetFile: DATASET_FILE, report: realReport!, evalStatus: 0, approve: true });
    const schema2Untouched = schema2Bytes.equals(readFileSync(schema2File));
    if (!schema2Outcome.written && schema2Outcome.reason!.includes("not supported") && schema2Untouched) {
      pass("unsupported-schema existing baseline refused in update mode with the standard refusal, file byte-identical");
    } else {
      fail(`unsupported-schema update wrong: written=${schema2Outcome.written} reason=${schema2Outcome.reason} untouched=${schema2Untouched}`);
    }
  }

  // ── Addition (F4): a null evaluation report can never update the baseline ────
  // The report parameter is explicitly nullable (no synthetic placeholder
  // object); refusals must fire regardless of the reported engine exit code.
  {
    const nullReportFile = path.join(tempDir, "baseline-nullreport.json");
    copyFileSync(BASELINE_FILE, nullReportFile);
    const beforeBytes = readFileSync(nullReportFile);
    const outcomeExit1 = updateBaselineFile({ baselineFile: nullReportFile, datasetFile: DATASET_FILE, report: null, evalStatus: 1, approve: true });
    const outcomeExit0 = updateBaselineFile({ baselineFile: nullReportFile, datasetFile: DATASET_FILE, report: null, evalStatus: 0, approve: true });
    const untouched = beforeBytes.equals(readFileSync(nullReportFile));
    if (!outcomeExit1.written && outcomeExit1.reason!.includes("did not complete") && !outcomeExit0.written && outcomeExit0.reason!.includes("did not complete") && untouched) {
      pass("null evaluation report refused by the update gates regardless of exit status; file byte-identical");
    } else {
      fail(`null-report refusals wrong: ${JSON.stringify([outcomeExit1.written, outcomeExit1.reason, outcomeExit0.written, outcomeExit0.reason, untouched])}`);
    }
  }

  // ── Test 18: atomic update leaves a complete baseline, no partial file ─────
  {
    const outcome = updateBaselineFile({
      baselineFile: tempBaseline,
      datasetFile: DATASET_FILE,
      report: realReport!,
      evalStatus: 0,
      approve: true,
      reference: "test-suite-atomic",
    });
    const leftovers = readdirSync(tempDir).filter((f) => f.includes(".tmp-"));
    if (outcome.written) {
      try {
        const written = parseBaseline(readFileSync(tempBaseline, "utf8"));
        const ids = Object.keys(written.cases);
        if (written.reference === "test-suite-atomic" && ids.length === 16 && leftoverFilesClean(leftovers)) {
          pass("atomic update wrote a complete, parseable 16-case baseline with no temp leftovers");
        } else {
          fail(`atomic write incomplete: ref=${written.reference} cases=${ids.length} leftovers=${JSON.stringify(leftovers)}`);
        }
      } catch (error) {
        fail(`atomic write produced an unparseable baseline: ${(error as Error).message}`);
      }
    } else {
      fail(`atomic update unexpectedly refused: ${outcome.reason}`);
    }
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function leftoverFilesClean(leftovers: string[]): boolean {
  return leftovers.length === 0;
}

// The committed baseline must never have been modified by these tests.
const committedNow = readFileSync(BASELINE_FILE, "utf8");
const committedParsed = parseBaseline(committedNow);
if (committedParsed.reference === "phase-3a" && committedParsed.dataset.version === 1) {
  pass("committed baseline untouched by the test run (still reference phase-3a, dataset v1)");
} else {
  fail(`committed baseline changed during tests: reference=${committedParsed.reference}`);
}

// ── Summary ──────────────────────────────────────────────────────────────────
const fails = results.filter((r) => r.startsWith("FAIL"));
if (fails.length > 0) {
  console.error(`\n${fails.length} assertion(s) failed:\n${fails.join("\n")}`);
  process.exit(1);
}
console.log(`\nAll ${results.length} baseline-comparison checks passed cleanly.`);
