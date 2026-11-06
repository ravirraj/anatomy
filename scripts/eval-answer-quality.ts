// Answer-stage evaluation (Phase 1D Batch F, audit §10 V10): runs the golden
// questions through the PRODUCTION answer path — retrieveWithCoverageLoop →
// formatRetrievedContext → answerQuestion — against a real provider, then
// scores the answer bodies against expectedFacts (textual/predicate
// substrings) and completion policies (citation verification, abstention
// semantics). Opt-in and quota-costing; never gates CI. Baselines are
// recorded in docs/PROJECT_STATE.md.
//
// The cache here is in-process only: identical rendered packages within one
// run can reuse a generated body (--no-cache forbids even that, forcing a
// fresh model call per case). The answer cache key is exactly the production
// key's shape, so a run's numbers also characterize what a warm cache would
// serve for these renders.
//
//   node --env-file=.env.local scripts/eval-answer-quality.ts
//   node --env-file=.env.local scripts/eval-answer-quality.ts --no-cache --budget-csv -c QA-07 --json

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { retrieveWithCoverageLoop } from "../lib/ai/retrieval-loop.ts";
import { formatRetrievedContext, type Db } from "../lib/ai/retrieval.ts";
import { verifyCitations, type FileEvidence } from "../lib/ai/citations.ts";
import { answerQuestion, INSUFFICIENT_EVIDENCE_ANSWER, type Cache } from "../lib/ai/tasks.ts";
import { createFixtureContext, type FixtureContext } from "./eval-fixture-adapter.ts";

// Same dataset file the retrieval-side golden eval reads: case definitions
// stay shared, so both stages always measure the same 16 questions.
const goldenPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/golden-qa.json",
);

type GoldenCase = {
  id: string;
  fixture: string;
  question: string;
  expectedOutcome: "grounded_answer" | "grounded_scoped_negative" | "abstain_no_evidence";
  expectedFacts: Array<Record<string, unknown>>;
};

type GoldenDataset = { cases: GoldenCase[] };

type CaseVerdict = "PASS" | "WARN" | "FAIL";

type CaseReport = {
  id: string;
  fixture: string;
  verdict: CaseVerdict;
  cached: boolean;
  llmMs: number;
  retrievalMs: number;
  windows: number;
  files: number;
  totalCharacters: number;
  totalTokens: number | null;
  renderedCharacters: number | null;
  stoppedBecause: string | null;
  passes: number;
  coverage: { found: number; partial: number; unknown: number } | null;
  factsTotal: number;
  factsInBody: number;
  missingFacts: string[];
  citationsTotal: number;
  citationsVerify: boolean;
  policyOk: boolean;
  policyDetail: string;
  error: string | null;
};

interface Options {
  caseId?: string;
  filter?: string;
  json?: boolean;
  noCache?: boolean;
  budgetCsv?: boolean;
  failOnWarn?: boolean;
}

function printHelp(): void {
  console.log(`
Usage: node --env-file=.env.local scripts/eval-answer-quality.ts [options]

Options:
  -c, --case <id>      Run one specific case ID (e.g. QA-07)
  -f, --filter <term>  Filter cases matching term in ID or fixture
  --json               Machine-readable JSON report (includes the budget ledger)
  --no-cache           Fresh model call for every case (no render reuse)
  --budget-csv         Print the per-case retrieval budget ledger as CSV
  --fail-on-warn       Exit non-zero if any case is WARN or FAIL
  -h, --help           Show this help message
`);
}

function parseCliArgs(argv: string[]): Options {
  const options: Options = {};
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
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--no-cache") {
      options.noCache = true;
    } else if (arg === "--budget-csv") {
      options.budgetCsv = true;
    } else if (arg === "--fail-on-warn") {
      options.failOnWarn = true;
    } else {
      console.error(`Unknown option: ${arg} (use --help)`);
      process.exit(1);
    }
  }
  return options;
}

// ── Fact-to-body scoring (V10: textual/predicate substrings) ─────────────────

/**
 * The substrings a grounded answer body must contain for one expected fact.
 * Each predicate is verified textually against the answer body: the body must
 * name the thing the fact is about (and the version, for dependency claims).
 * Unknown predicates produce no substrings, so an unexpected schema shows up
 * as an unresolved fact (WARN) instead of vanishing.
 */
function expectedFactSubstrings(fact: Record<string, unknown>): string[] {
  switch (fact.predicate) {
    case "declares_dependency": {
      const substrings = [String(fact.package)];
      if (fact.version !== undefined) substrings.push(String(fact.version));
      return substrings;
    }
    case "declares_symbol":
      return [String(fact.symbol)];
    case "calls":
      return [String(fact.callee)];
    case "imports": {
      // A wildcard import derives no symbol substrings; the honest textual
      // residue is the module specifier the import names.
      const symbols = (Array.isArray(fact.importedSymbols) ? fact.importedSymbols : [])
        .map(String)
        .filter((s) => s !== "*");
      return symbols.length > 0 ? symbols : fact.specifier !== undefined ? [String(fact.specifier)] : [];
    }
    case "re_exports":
      return fact.isWildcard === true ? [String(fact.sourceModule)] : [String(fact.exportedSymbol)];
    case "scoped_absence":
      return [String(fact.absentSymbol)];
    case "reads_config":
      // The body must name the configuration variable/key being read.
      return [String(fact.variable)];
    default:
      return [];
  }
}

/**
 * Facts whose needle is an ordinary word (config keys like `main` or `bin`)
 * require word-boundary matches: a bare substring would false-positive
 * inside unrelated words ("domain", "combined") and inflate the score.
 */
function factNeedsWordBoundary(fact: Record<string, unknown>): boolean {
  return fact.predicate === "reads_config";
}

function containsNeedle(body: string, needle: string, wordBoundary: boolean): boolean {
  if (!wordBoundary) return body.includes(needle);
  return new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(body);
}

// ── Budget ledger (per-case retrieval cost accounting) ───────────────────────

function printBudgetCsv(reports: CaseReport[]): void {
  const cell = (v: string) => (v.includes(",") ? `"${v}"` : v);
  console.log("case,stop,windows,files,totalCharacters,totalTokens,renderedCharacters,passes,freshness,ms");
  for (const r of reports) {
    console.log(
      [
        r.id,
        r.stoppedBecause ?? "",
        String(r.windows),
        String(r.files),
        String(r.totalCharacters),
        r.totalTokens === null ? "" : String(r.totalTokens),
        r.renderedCharacters === null ? "" : String(r.renderedCharacters),
        String(r.passes),
        r.cached ? "cached" : "fresh",
        String(r.llmMs),
      ]
        .map(cell)
        .join(","),
    );
  }
}

// ── Case execution ────────────────────────────────────────────────────────────

const fixtureContexts = new Map<string, FixtureContext>();
function getContext(fixture: string): FixtureContext {
  let ctx = fixtureContexts.get(fixture);
  if (!ctx) {
    ctx = createFixtureContext(fixture);
    fixtureContexts.set(fixture, ctx);
  }
  return ctx;
}

async function runCase(c: GoldenCase, options: Pick<Options, "noCache">): Promise<CaseReport> {
  const ctx = getContext(c.fixture);

  // 1. Production retrieval: the coverage loop owns evidence gathering, and
  // the report carries its stop reason and pass ledger verbatim.
  const tRet0 = performance.now();
  const loop = await retrieveWithCoverageLoop(ctx.db as unknown as Db, ctx.analysisId, c.question);
  const retrieval = loop.result;
  const retrievalMs = Math.round(performance.now() - tRet0);
  const windows = retrieval.windows;

  // 2. The production question input, exactly as the Q&A action assembles it
  // (coverage layers union, allowlist after retrieval, manifests by path).
  const contextText = formatRetrievedContext(retrieval);
  const coverageLayers = {
    verified: new Set<string>(),
    partial: new Set<string>(),
    unknown: new Set<string>(),
  };
  for (const concept of loop.coverage.concepts) {
    for (const cat of concept.categories) {
      if (cat.status === "found") coverageLayers.verified.add(cat.category);
      else if (cat.status === "partial") coverageLayers.partial.add(cat.category);
      else coverageLayers.unknown.add(cat.category);
    }
  }
  for (const layer of coverageLayers.verified) coverageLayers.partial.delete(layer);
  for (const layer of coverageLayers.verified) coverageLayers.unknown.delete(layer);
  for (const layer of coverageLayers.partial) coverageLayers.unknown.delete(layer);

  // The citation allowlist: the stored file texts the fixture adapter keeps —
  // precisely the paths the real action reads via allowedAnalysisPaths.
  const allAnalysisFiles = new Set(ctx.fileTexts.keys());
  const manifestsByPath = new Map((retrieval.manifests ?? []).map((m) => [m.path, m]));

  // In-process cache: identical rendered input inside one run may reuse a
  // body; --no-cache forbids reuse and forces a fresh model call.
  const cacheBodies = new Map<string, string>();
  const cache: Cache = options.noCache
    ? { read: async () => null, write: async () => undefined, delete: async () => undefined }
    : {
        read: async (key) => cacheBodies.get(key) ?? null,
        write: async ({ key, body }) => {
          cacheBodies.set(key, body);
        },
        delete: async (key) => {
          cacheBodies.delete(key);
        },
      };

  const tLlm0 = performance.now();
  let body = "";
  let cached = false;
  let citations: unknown[] = [];
  let answerError: string | null = null;
  try {
    const answer = await answerQuestion(
      {
        question: c.question,
        contextText,
        files: retrieval.files.map((f) => ({
          path: f.path,
          contentHash: f.contentHash,
          totalLines: f.totalLines,
          ...(f.windows ? { windows: f.windows } : {}),
        })),
        coverage: {
          verified: [...coverageLayers.verified].sort(),
          partial: [...coverageLayers.partial].sort(),
          unknown: [...coverageLayers.unknown].sort(),
          unknownNote: loop.coverage.unknownNote,
        },
        insufficientEvidence: retrieval.insufficientEvidence,
      },
      { cache, allAnalysisFiles, manifestsByPath, analysisId: ctx.analysisId },
    );
    body = answer.body;
    cached = answer.cached;
    citations = answer.citations;
  } catch (error) {
    answerError = error instanceof Error ? error.message : String(error);
  }
  const llmMs = Math.round(performance.now() - tLlm0);

  // 3. Fact scoring: what the BODY itself establishes.
  const missingFacts: string[] = [];
  let factsInBody = 0;
  for (const fact of c.expectedFacts) {
    const substrings = expectedFactSubstrings(fact);
    if (substrings.length === 0) {
      missingFacts.push(`unmeasured predicate ${String(fact.predicate)}`);
      continue;
    }
    const wordBoundary = factNeedsWordBoundary(fact);
    if (substrings.every((s) => containsNeedle(body, s, wordBoundary))) factsInBody++;
    else missingFacts.push(`${String(fact.predicate)}:${substrings.join("+")}`);
  }

  // 4. Policy scoring: every citation in the body must verify against the
  // evidence the package served; abstention cases must be the deterministic
  // abstention body; grounded cases must not abstain.
  const evidenceMap = new Map<string, FileEvidence>();
  for (const file of retrieval.files) {
    evidenceMap.set(file.path, {
      lines: file.totalLines,
      contentHash: file.contentHash,
      windows: windows
        .filter((w) => w.path === file.path)
        .map((w) => ({ startLine: w.startLine, endLine: w.endLine })),
    });
  }
  let citationsVerify = true;
  let citationFailure = "";
  try {
    const failing = verifyCitations(body, evidenceMap, {
      allAnalysisFiles,
      manifestsByPath,
      analysisId: ctx.analysisId,
    });
    if (failing.paths.length > 0) {
      citationsVerify = false;
      citationFailure = failing.paths.join(", ");
    }
  } catch (error) {
    citationsVerify = false;
    citationFailure = `verification threw: ${error instanceof Error ? error.message : String(error)}`;
  }

  const isAbstain = body === INSUFFICIENT_EVIDENCE_ANSWER;

  let policyOk = true;
  const policyDetails: string[] = [];
  if (c.expectedOutcome === "abstain_no_evidence") {
    if (body !== INSUFFICIENT_EVIDENCE_ANSWER) {
      policyOk = false;
      policyDetails.push(`expected the deterministic abstention body, got ${body.length} chars`);
    }
  } else {
    if (windows.length === 0) {
      policyOk = false;
      policyDetails.push("expected retrieved windows for a grounded case, got 0");
    }
    if (isAbstain) {
      policyOk = false;
      policyDetails.push("grounded case abstained (insufficient-evidence body)");
    }
    if (!citationsVerify) {
      policyOk = false;
      policyDetails.push(`body citations failed verification: ${citationFailure}`);
    }
  }
  if (answerError !== null) {
    policyOk = false;
    policyDetails.push(`generation failed: ${answerError}`);
  }

  // 5. Verdict: FAIL on generation/policy violation; WARN when a fact is
  // unestablished; PASS otherwise.
  const verdict: CaseVerdict =
    !policyOk ? "FAIL" : missingFacts.length > 0 ? "WARN" : "PASS";

  return {
    id: c.id,
    fixture: c.fixture,
    verdict,
    cached,
    llmMs,
    retrievalMs,
    windows: windows.length,
    files: retrieval.files.length,
    totalCharacters: retrieval.totalCharacters,
    totalTokens: retrieval.totalTokens ?? null,
    renderedCharacters: retrieval.renderedCharacters ?? null,
    stoppedBecause: loop.stoppedBecause,
    passes: loop.passes.length,
    coverage: loop.coverage.summary,
    factsTotal: c.expectedFacts.length,
    factsInBody,
    missingFacts,
    citationsTotal: citations.length,
    citationsVerify,
    policyOk,
    policyDetail: policyDetails.join("; "),
    error: null,
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function runEvaluation(options: Options): Promise<void> {
  // Provider gate (V10: opt-in, quota-costing): fail fast with instructions
  // instead of failing mid-run on the first model call.
  const providerKey =
    process.env.AI_API_KEY?.trim() ||
    process.env.OPENROUTER_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim();
  if (!providerKey) {
    console.error(
      "No AI provider key found (AI_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY).\n" +
        "This evaluation sends every golden question to the question model and costs real quota:\n" +
        "  node --env-file=.env.local scripts/eval-answer-quality.ts",
    );
    process.exit(1);
  }

  const dataset: GoldenDataset = JSON.parse(readFileSync(goldenPath, "utf8"));

  let cases = [...dataset.cases];
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
      (c) => c.id.toLowerCase().includes(filter) || c.fixture.toLowerCase().includes(filter),
    );
    if (cases.length === 0) {
      console.error(`No cases found matching filter "${options.filter}"`);
      process.exit(1);
    }
  }

  if (!options.json) {
    console.log("===============================================================================");
    console.log("Answer-stage evaluation (V10): golden questions through the production path");
    console.log("===============================================================================");
  }

  const reports: CaseReport[] = [];
  for (const c of cases) {
    if (!options.json) console.error(`running ${c.id} ("${c.fixture}") ...`);
    reports.push(await runCase(c, options));
  }

  const summary = {
    total: reports.length,
    passed: reports.filter((r) => r.verdict === "PASS").length,
    warned: reports.filter((r) => r.verdict === "WARN").length,
    failed: reports.filter((r) => r.verdict === "FAIL").length,
    factsTotal: reports.reduce((n, r) => n + r.factsTotal, 0),
    factsInBody: reports.reduce((n, r) => n + r.factsInBody, 0),
    avgLlmMs: Math.round(
      reports.reduce((n, r) => n + r.llmMs, 0) / Math.max(1, reports.length),
    ),
  };

  if (options.json) {
    console.log(JSON.stringify({ version: 1, cases: reports, summary }, null, 2));
    if (options.budgetCsv) {
      console.error("");
      printBudgetCsv(reports);
    }
  } else {
    console.log("");
    console.log("---------------------------------------------------------------------------");
    console.log("ID     | Verdict | Facts     | Cited | Cache | Windows | Stop              | ms");
    console.log("---------------------------------------------------------------------------");
    for (const r of reports) {
      const factsCell = `${r.factsInBody}/${r.factsTotal}`.padEnd(9);
      console.log(
        `${r.id.padEnd(6)} | ${r.verdict.padEnd(7)} | ${factsCell} | ${
          r.citationsVerify ? "ok" : "FAIL"
        }  | ${r.cached ? "hit" : "fresh"}  | ${String(r.windows).padEnd(7)} | ${
          (r.stoppedBecause ?? "-").padEnd(17)
        } | ${r.llmMs}`,
      );
      for (const m of r.missingFacts) console.log(`   └─ missing body fact: ${m}`);
      if (r.policyDetail) console.log(`   └─ ${r.policyDetail}`);
    }
    console.log("");
    console.log(
      `Summary: ${summary.passed} PASS, ${summary.warned} WARN, ${summary.failed} FAIL across ${summary.total} case(s);` +
        ` body facts ${summary.factsInBody}/${summary.factsTotal}; avg llm ${summary.avgLlmMs} ms`,
    );
    if (options.budgetCsv) {
      console.log("");
      printBudgetCsv(reports);
    }
  }

  if (options.failOnWarn && summary.warned + summary.failed > 0) process.exit(1);
}

runEvaluation(parseCliArgs(process.argv.slice(2))).catch((error) => {
  console.error(`Evaluation runtime error: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
