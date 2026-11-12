// Verifies the Phase 4 Batch 3 search-strategy diagnostics: anchor
// classification, strategy attribution, discovery-versus-ranking stages,
// stratified aggregation (including empty categories) and deterministic
// rendering. All tests use synthetic loop results — no retrieval runs here,
// the real pipeline suites cover those.
//
//   node scripts/test-search-strategy.ts

import {
  anchorStratum,
  attributeFileStrategies,
  buildCaseDiagnostic,
  classifyDiscoveryStage,
  classifyQueryAnchors,
  discoveryFailureOf,
  funnelTraceOf,
  renderMarkdownReport,
  stratifyAndAggregate,
  type BaseWindowSnapshot,
  type CaseSearchDiagnostic,
  type FunnelTrace,
  type GoldenCase,
} from "./eval-search-strategy.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);
const check = (cond: boolean, okMsg: string, failMsg: string) => (cond ? pass(okMsg) : fail(failMsg));

// ── Anchor classification ────────────────────────────────────────────────────

{
  const windows: BaseWindowSnapshot[] = [
    { path: "src/triangle.ts", strategies: ["explicit-path", "path"], reason: `file explicitly named in query ("src/triangle.ts")` },
    { path: "src/triangle.ts", strategies: ["symbol"], reason: `symbol "three" (function) matches token "three"` },
  ];
  const c = classifyQueryAnchors(windows);
  check(c.hasExplicitPathAnchor && c.pathAnchors.join(",") === "src/triangle.ts", "an explicit-path base window establishes a file anchor", `path anchor wrong: ${JSON.stringify(c)}`);
  check(c.hasExplicitSymbolAnchor && c.symbolAnchors.join(",") === "three", "a symbol window whose token equals the symbol's own name establishes a symbol anchor", `symbol anchor wrong: ${JSON.stringify(c)}`);
  check(anchorStratum(c) === "path-anchored", "path-anchored takes precedence when both anchors are present", `stratum wrong: ${anchorStratum(c)}`);
  check(c.hasExplicitSymbolAnchor, "the independent symbol flag is still reported for a both-anchors query", "symbol flag lost under precedence");
}

{
  // Subtoken and glossary matches do not establish a symbol anchor.
  const windows: BaseWindowSnapshot[] = [
    { path: "src/users.ts", strategies: ["symbol"], reason: `symbol "UserService" (class) matches token "user"` },
    { path: "src/db.ts", strategies: ["symbol"], reason: `symbol "connect" (function) matches token "database"` },
  ];
  const c = classifyQueryAnchors(windows);
  check(!c.hasExplicitSymbolAnchor && c.symbolAnchors.length === 0, "fragment or glossary token matches are not symbol anchors", `false anchors: ${JSON.stringify(c.symbolAnchors)}`);
}

{
  // Generic-verb-only matches do not either.
  const windows: BaseWindowSnapshot[] = [
    { path: "src/create.ts", strategies: ["symbol"], reason: `symbol "create" (function) matches token "create" (generic verb only, demoted)` },
  ];
  const c = classifyQueryAnchors(windows);
  check(!c.hasExplicitSymbolAnchor, "generic-verb-only symbol matches are not symbol anchors", "generic match became an anchor");
}

{
  // "default" is the parser's synthetic name for default exports.
  const windows: BaseWindowSnapshot[] = [
    { path: "src/three.ts", strategies: ["symbol"], reason: `symbol "default" (function) matches token "default"` },
  ];
  const c = classifyQueryAnchors(windows);
  check(!c.hasExplicitSymbolAnchor, "the synthetic default-export name is not a symbol anchor", `"default" became an anchor`);
}

{
  // Case-blind exact match, and merged reasons parsed segment by segment.
  const windows: BaseWindowSnapshot[] = [
    { path: "src/api.ts", strategies: ["symbol", "path"], reason: `symbol "UserRepo" (class) matches token "userrepo"; file path matches token "api" (+4 from 2 strategies)` },
  ];
  const c = classifyQueryAnchors(windows);
  check(c.symbolAnchors.join(",") === "UserRepo", "merged reason segments still detect a case-blind exact symbol anchor", `wrong: ${JSON.stringify(c.symbolAnchors)}`);
}

{
  // Legacy results without strategies: unknown, not absent.
  const c = classifyQueryAnchors([{ path: "src/x.ts" }]);
  check(!c.classificationAvailable && !c.hasExplicitPathAnchor && !c.hasExplicitSymbolAnchor, "base windows without strategy data report unavailable classification", `wrong: ${JSON.stringify(c)}`);
}

// ── Strategy attribution ─────────────────────────────────────────────────────

{
  const attribution = attributeFileStrategies([
    { path: "src/a.ts", strategies: ["symbol"], reason: `symbol "a" (function) matches token "a"` },
    { path: "src/a.ts", strategies: ["path", "symbol"], reason: `file path matches token "a"; symbol "a" (function) matches token "a" (+4 from 2 strategies)` },
    { path: "src/b.ts", strategies: ["derive"], reason: `derived import reference to "src/b.ts"` },
  ]);
  const a = attribution.get("src/a.ts");
  check(!!a && Array.isArray(a.strategies) && a.strategies.join("+") === "path+symbol", "a file's strategies union across its windows (multi-strategy attribution)", `wrong: ${JSON.stringify(a)}`);
  const b = attribution.get("src/b.ts");
  check(!!b && Array.isArray(b.strategies) && b.strategies[0] === "derive", "single-strategy files attribute that strategy", `wrong: ${JSON.stringify(b)}`);
  const missing = attributeFileStrategies([{ path: "src/c.ts", reason: "legacy window" }]).get("src/c.ts");
  check(missing?.strategies === "unavailable", "a file whose windows carry no strategy data attributes \"unavailable\"", `wrong: ${JSON.stringify(missing)}`);
  const mixed = attributeFileStrategies([
    { path: "src/d.ts", reason: "legacy window" },
    { path: "src/d.ts", strategies: ["role"], reason: "role window" },
  ]).get("src/d.ts");
  check(!!mixed && Array.isArray(mixed.strategies) && mixed.strategies[0] === "role", "a file with mixed legacy and stamped windows unions what exists", `wrong: ${JSON.stringify(mixed)}`);
}

// ── Discovery versus ranking ─────────────────────────────────────────────────

{
  const trace: FunnelTrace = {
    finalPaths: ["src/served.ts"],
    displacedPaths: ["src/displaced.ts"],
    collectedPaths: ["src/collected.ts", "src/served.ts"],
    seenPaths: ["src/gated.ts", "src/collected.ts", "src/served.ts"],
  };
  const stage = (p: string) => classifyDiscoveryStage(trace, p);
  check(stage("src/served.ts") === "selected" && discoveryFailureOf(stage("src/served.ts")) === "none", "a served gold file is selected with no failure", "selected misclassified");
  check(stage("src/displaced.ts") === "selected-then-displaced" && discoveryFailureOf(stage("src/displaced.ts")) === "ranking", "a file retained earlier but displaced is a ranking failure", "displaced misclassified");
  check(stage("src/collected.ts") === "merge-rejected" && discoveryFailureOf(stage("src/collected.ts")) === "ranking", "a collected candidate the merge rejected is a ranking failure", "merge-rejected misclassified");
  check(stage("src/gated.ts") === "gate-rejected" && discoveryFailureOf(stage("src/gated.ts")) === "discovery", "a file the affiliation gate blocked is a discovery failure", "gate-rejected misclassified");
  check(stage("src/unknown.ts") === "never-seen" && discoveryFailureOf(stage("src/unknown.ts")) === "discovery", "a file no retrieval call ever saw is a discovery failure", "never-seen misclassified");
}

{
  // The trace is assembled from the loop's own fields.
  const trace = funnelTraceOf({
    result: { windows: [{ path: "src/final.ts" }] },
    initialWindows: [{ path: "src/final.ts" }, { path: "src/dropped.ts" }],
    passes: [
      { candidateFilesSeen: ["src/seen.ts"], collectedCandidateFiles: ["src/seen.ts"], windowsAfterPass: [{ path: "src/final.ts" }, { path: "src/dropped.ts" }] },
      { candidateFilesSeen: ["src/final.ts", "src/seen.ts"], collectedCandidateFiles: [], windowsAfterPass: [{ path: "src/final.ts" }] },
    ],
  });
  check(trace.finalPaths.join(",") === "src/final.ts", "the trace's final paths come from the served windows in served order", `wrong: ${JSON.stringify(trace.finalPaths)}`);
  check(trace.displacedPaths.join(",") === "src/dropped.ts", "files retained at some pass but absent from the final package are displaced", `wrong: ${JSON.stringify(trace.displacedPaths)}`);
  check(trace.collectedPaths.join(",") === "src/seen.ts", "collected candidate paths are the union over passes", `wrong: ${JSON.stringify(trace.collectedPaths)}`);
  check(trace.seenPaths.join(",") === "src/final.ts,src/seen.ts", "seen paths are the pre-gate union over passes", `wrong: ${JSON.stringify(trace.seenPaths)}`);
}

// ── Stratified aggregation ───────────────────────────────────────────────────

const goldCase = (id: string, stratum: "path-anchored" | "symbol-anchored" | "unanchored", perFile: { path: string; stage: CaseSearchDiagnostic["perFile"][number]["stage"] }[], rank: number | null, recall: number | null): CaseSearchDiagnostic => ({
  id,
  fixture: "fx",
  category: "test",
  question: `question ${id}`,
  classification: {
    hasExplicitPathAnchor: stratum === "path-anchored",
    hasExplicitSymbolAnchor: stratum === "symbol-anchored",
    symbolAnchors: [],
    pathAnchors: [],
    classificationAvailable: true,
  },
  stratum,
  goldFiles: perFile.map((f) => f.path),
  retrievedFiles: [],
  perFile: perFile.map((f) => ({ ...f, failure: discoveryFailureOf(f.stage), strategies: "unavailable" as const, servedRank: null })),
  firstRelevantFileRank: rank,
  reciprocalRank: rank === null ? null : 1 / rank,
  recallAt3: recall,
  stopReason: "sufficient-coverage",
  stopReasonAvailable: true,
});

{
  const diagnostics = [
    goldCase("P1", "path-anchored", [{ path: "a.ts", stage: "selected" }], 1, 1),
    goldCase("S1", "symbol-anchored", [{ path: "b.ts", stage: "never-seen" }], null, 0),
    goldCase("A1", "unanchored", [{ path: "c.ts", stage: "merge-rejected" }], null, 0),
    goldCase("N1", "unanchored", [{ path: "d.ts", stage: "gate-rejected" }], null, 0),
  ];
  const strata = stratifyAndAggregate(diagnostics);
  const byName = new Map(strata.map((s) => [s.stratum, s]));
  const path = byName.get("path-anchored")!;
  check(path.caseCount === 1 && path.discoveryRate === 1 && path.selectionRate === 1, "a populated stratum aggregates its cases' rates", `wrong: ${JSON.stringify(path)}`);
  const symbol = byName.get("symbol-anchored")!;
  check(symbol.discoveryFailures.length === 1 && symbol.discoveryFailures[0]!.stage === "never-seen", "discovery failures are enumerated per gold file with their stage", `wrong: ${JSON.stringify(symbol.discoveryFailures)}`);
  const unanchored = byName.get("unanchored")!;
  check(unanchored.rankingFailures.length === 1 && unanchored.discoveryFailures.length === 1, "a stratum can carry both failure kinds", `wrong: ${JSON.stringify({ d: unanchored.discoveryFailures, r: unanchored.rankingFailures })}`);
  const abstention = byName.get("abstention")!;
  check(abstention.caseCount === 0 && abstention.empty && abstention.discoveryRate === null && abstention.note.length > 0, "an empty stratum reports zero cases, null rates and an explicit note", `wrong: ${JSON.stringify(abstention)}`);
}

{
  // Abstention cases (no gold files) are excluded from ranked strata rates.
  const abstentionCase: CaseSearchDiagnostic = {
    ...goldCase("N1", "unanchored", [], null, null),
    stratum: "abstention",
    goldFiles: [],
  };
  const strata = stratifyAndAggregate([abstentionCase]);
  const abstention = strata.find((s) => s.stratum === "abstention")!;
  const unanchored = strata.find((s) => s.stratum === "unanchored")!;
  check(abstention.caseCount === 1 && abstention.discoveryRate === null && abstention.fileMRR === null, "abstention cases are counted in their own stratum without rates", `wrong: ${JSON.stringify(abstention)}`);
  check(unanchored.caseCount === 0 && unanchored.empty, "an abstention case does not enter the unanchored stratum", `wrong: ${JSON.stringify(unanchored)}`);
}

{
  // The small-sample note is present, and never claims significance.
  const strata = stratifyAndAggregate([goldCase("P1", "path-anchored", [{ path: "a.ts", stage: "selected" }], 1, 1)]);
  check(/not statistically conclusive|descriptive/.test(strata[0]!.note), "small strata carry an explicit non-conclusiveness note", `note: ${strata[0]!.note}`);
}

// ── Determinism ──────────────────────────────────────────────────────────────

{
  const diagnostics = [
    goldCase("P1", "path-anchored", [{ path: "a.ts", stage: "selected" }], 1, 1),
    goldCase("P2", "path-anchored", [{ path: "b.ts", stage: "merge-rejected" }, { path: "c.ts", stage: "selected" }], 1, 0.5),
    goldCase("S1", "symbol-anchored", [{ path: "d.ts", stage: "gate-rejected" }], null, 0),
  ];
  const strataA = stratifyAndAggregate(diagnostics);
  const strataB = stratifyAndAggregate(diagnostics);
  const jsonA = JSON.stringify(strataA);
  const jsonB = JSON.stringify(strataB);
  check(jsonA === jsonB, "stratified aggregation is deterministic across runs", "aggregate output differed between runs");
  const reportA = renderMarkdownReport(diagnostics, strataA);
  const reportB = renderMarkdownReport(diagnostics, strataB);
  check(reportA === reportB, "the rendered report is byte-identical across runs", "report output differed between runs");
  check(!/Timestamp|timestamp|Date\(|random/.test(reportA), "the report contains no timestamps or random identifiers", "report leaked unstable content");
}

{
  // Case diagnostics round-trip deterministically too (JSON machine output).
  const c: GoldenCase = {
    id: "X1",
    fixture: "fx",
    category: "test",
    question: "q",
    retrievalExpectation: { mustRetrieve: true, relevantFiles: [{ path: "a.ts", ranges: [[1, 2]] }] },
  };
  const trace: FunnelTrace = { finalPaths: ["a.ts"], displacedPaths: [], collectedPaths: ["a.ts"], seenPaths: ["a.ts"] };
  const d1 = buildCaseDiagnostic(c, classifyQueryAnchors(undefined), attributeFileStrategies([]), trace, "sufficient-coverage", true);
  const d2 = buildCaseDiagnostic(c, classifyQueryAnchors(undefined), attributeFileStrategies([]), trace, "sufficient-coverage", true);
  check(JSON.stringify(d1) === JSON.stringify(d2), "case diagnostics are deterministic across runs", "case diagnostic differed between runs");
  // Base windows without strategies: classification is unavailable, not guessed.
  check(!d1.classification.classificationAvailable, "an unmeasured base window set yields unavailable classification", "classification invented without data");
}

console.log("");
for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

// A module, so the awaits above are allowed.
export {};
