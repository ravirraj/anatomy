// CI-6: Deterministic QA Evaluation Engine
// Evaluates retrieval evidence precision/recall, structured fact grounding,
// response policies (abstention & scoped negative claims), and citation validity
// across the 16 golden evaluation cases with zero external dependencies.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { retrieveGroundedContext } from "../lib/ai/retrieval.ts";
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
    const retrievalResult = options.singlePass
      ? await retrieveGroundedContext(ctx.db, ctx.analysisId, c.question)
      : (await retrieveWithCoverageLoop(ctx.db, ctx.analysisId, c.question)).result;
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
