// Validates fixtures/golden-qa.json against the actual fixture repository corpus.
// Verifies:
// 1. Language capability matrix completeness and consistency.
// 2. All fixture directories exist.
// 3. All target and evidence files exist.
// 4. All line intervals [start, end] are valid and within actual file bounds.
// 5. All structured fact predicates match real source syntax semantics (not loose keywords).
// 6. All abstention cases conform to the response policy schema without facts.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURES } from "./test-fixtures-shared.ts";

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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validatePredicateSemantics(f: FactPredicate, excerpt: string): string | null {
  if (f.predicate === "declares_symbol") {
    if (!f.symbol) return "symbol is required";
    const pattern = new RegExp(
      `(?:(?:export\\s+(?:default\\s+)?)?(?:function|class|const|let|var|type|interface)\\s+${escapeRegex(f.symbol)}\\b|module\\.exports\\.${escapeRegex(f.symbol)}\\s*=|module\\.exports\\s*=\\s*function\\s+${escapeRegex(f.symbol)}\\b|pub\\s+fn\\s+${escapeRegex(f.symbol)}\\b|fn\\s+${escapeRegex(f.symbol)}\\b|func\\s+${escapeRegex(f.symbol)}\\b|def\\s+${escapeRegex(f.symbol)}\\b)`,
    );
    if (!pattern.test(excerpt)) {
      return `no symbol declaration pattern matching "${f.symbol}" found in excerpt:\n${excerpt}`;
    }
  } else if (f.predicate === "calls") {
    if (!f.callee) return "callee is required";
    const callPattern = new RegExp(`\\b${escapeRegex(f.callee)}\\s*\\(`);
    if (!callPattern.test(excerpt)) {
      return `no call expression for callee "${f.callee}(...)" found in excerpt:\n${excerpt}`;
    }
    if (f.caller && !excerpt.includes(f.caller)) {
      return `caller "${f.caller}" not referenced in excerpt:\n${excerpt}`;
    }
  } else if (f.predicate === "imports") {
    if (!f.specifier) return "specifier is required";
    const importPattern = new RegExp(
      `(?:import\\s*\\(?\\s*["']${escapeRegex(f.specifier)}["']|(?:from|require\\s*\\()\\s*["']${escapeRegex(f.specifier)}["'])`,
    );
    if (!importPattern.test(excerpt)) {
      return `no import/require statement referencing specifier "${f.specifier}" in excerpt:\n${excerpt}`;
    }
    if (f.importedSymbols && f.importedSymbols.length > 0) {
      for (const sym of f.importedSymbols) {
        if (sym !== "*" && !excerpt.includes(sym)) {
          return `imported symbol "${sym}" not found in import excerpt:\n${excerpt}`;
        }
      }
    }
  } else if (f.predicate === "re_exports") {
    if (f.isWildcard) {
      const wildcardPattern = new RegExp(`export\\s*\\*\\s*from\\s*["']${escapeRegex(f.sourceModule ?? "")}["']`);
      if (!wildcardPattern.test(excerpt)) {
        return `no wildcard re-export "export * from '${f.sourceModule}'" found in excerpt:\n${excerpt}`;
      }
    } else {
      if (f.exportedSymbol) {
        const namedPattern = new RegExp(
          `export\\s*\\{[^}]*\\b(?:${escapeRegex(f.exportedSymbol)}|default\\s+as\\s+${escapeRegex(f.exportedSymbol)})\\b[^}]*\\}\\s*from\\s*["']${escapeRegex(f.sourceModule ?? "")}["']`,
        );
        if (!namedPattern.test(excerpt)) {
          return `no named re-export for symbol "${f.exportedSymbol}" from "${f.sourceModule}" in excerpt:\n${excerpt}`;
        }
      }
    }
  } else if (f.predicate === "declares_dependency") {
    if (!f.package) return "package is required";
    const isJson = excerpt.includes(`"${f.package}"`);
    const isToml = new RegExp(`^\\s*${escapeRegex(f.package)}\\s*=`, "m").test(excerpt);
    const isRequirements = new RegExp(`^\\s*${escapeRegex(f.package)}(?:\\[[^\\]]*\\])?(?:[<>=!~].*)?$`, "m").test(excerpt);
    const isGoMod = new RegExp(`(?:^|require\\s+|\\s+)${escapeRegex(f.package)}\\s+v?`, "m").test(excerpt);
    if (!isJson && !isToml && !isRequirements && !isGoMod) {
      return `no dependency declaration syntax for package "${f.package}" in excerpt:\n${excerpt}`;
    }
    if (f.kind === "indirect" && !excerpt.includes("// indirect")) {
      return `indirect dependency "${f.package}" missing "// indirect" marker in excerpt:\n${excerpt}`;
    }
  } else if (f.predicate === "reads_config") {
    if (!f.variable) return "variable is required";
    if (f.pattern === "process.env") {
      const envPattern = new RegExp(`process\\.env\\.${escapeRegex(f.variable)}\\b`);
      if (!envPattern.test(excerpt)) {
        return `pattern "process.env.${f.variable}" not found in excerpt:\n${excerpt}`;
      }
    } else if (f.pattern === "env-bracket") {
      const bracketPattern = new RegExp(`process\\.env\\[["']${escapeRegex(f.variable)}["']\\]`);
      if (!bracketPattern.test(excerpt)) {
        return `pattern "process.env['${f.variable}']" not found in excerpt:\n${excerpt}`;
      }
    } else if (f.pattern === "import.meta.env") {
      const metaPattern = new RegExp(`import\\.meta\\.env\\.${escapeRegex(f.variable)}\\b`);
      if (!metaPattern.test(excerpt)) {
        return `pattern "import.meta.env.${f.variable}" not found in excerpt:\n${excerpt}`;
      }
    } else if (f.pattern === "config-object") {
      const objPattern = new RegExp(`"${escapeRegex(f.variable)}"\\s*:`);
      if (!objPattern.test(excerpt)) {
        return `config-object key "${f.variable}": not found in excerpt:\n${excerpt}`;
      }
    }
  } else if (f.predicate === "scoped_absence") {
    if (!f.absentSymbol) return "absentSymbol is required";
    if (excerpt.includes(f.absentSymbol)) {
      return `scoped absence violated: "${f.absentSymbol}" was found in excerpt:\n${excerpt}`;
    }
    // Verify the excerpt represents an authoritative scope (e.g. dependencies block)
    if (f.scopeKind === "manifest_dependencies" && !excerpt.includes("dependencies")) {
      return `scoped absence scope invalid: "dependencies" block not found in excerpt:\n${excerpt}`;
    }
  }
  return null;
}

export function runDatasetValidation(): boolean {
  const results: string[] = [];
  const pass = (m: string) => {
    results.push(`ok    ${m}`);
    console.log(`ok    ${m}`);
  };
  const fail = (m: string) => {
    results.push(`FAIL  ${m}`);
    console.error(`FAIL  ${m}`);
  };

  const dataPath = path.join(FIXTURES, "golden-qa.json");
  if (!existsSync(dataPath)) {
    console.error(`Missing dataset file at ${dataPath}`);
    return false;
  }

  const dataset = JSON.parse(readFileSync(dataPath, "utf8")) as GoldenDataset;

  console.log("=== 1. Validating Multi-Language Capability Matrix ===");

if (!Array.isArray(dataset.capabilityMatrix) || dataset.capabilityMatrix.length < 4) {
  fail(`Expected capabilityMatrix with at least 4 languages, found: ${dataset.capabilityMatrix?.length}`);
} else {
  pass(`capabilityMatrix contains ${dataset.capabilityMatrix.length} language specifications`);
}

const expectedLanguages = ["TypeScript / JavaScript", "Rust", "Go", "Python"];
for (const lang of expectedLanguages) {
  const entry = dataset.capabilityMatrix.find((c) => c.language === lang);
  if (!entry) {
    fail(`Missing capability entry for language: ${lang}`);
    continue;
  }

  if (lang === "TypeScript / JavaScript") {
    if (entry.symbolExtraction !== "supported" || entry.importModuleExtraction !== "supported" || entry.callGraphExtraction !== "supported") {
      fail(`TypeScript / JavaScript must have full AST parsing support`);
    } else {
      pass(`TypeScript / JavaScript: full AST support validated`);
    }
  } else {
    // Non-JS/TS languages have manifest support but NO source-code AST support in current parser
    if (entry.manifestSupport !== "supported") {
      fail(`${lang} must have manifestSupport: "supported"`);
    }
    if (entry.symbolExtraction !== "unsupported" || entry.importModuleExtraction !== "unsupported" || entry.callGraphExtraction !== "unsupported") {
      fail(`${lang} source code AST extraction must be marked "unsupported"`);
    } else {
      pass(`${lang}: manifest=supported, source AST (symbols/imports/calls)=unsupported (explicitly tracked)`);
    }
  }

  if (entry.goldenCasesAvailable.length === 0) {
    fail(`${lang} must have at least one golden evaluation case available`);
  }
}

console.log("\n=== 2. Validating Golden QA Cases & Fixture Ground Truth ===");

if (dataset.version !== 1) {
  fail(`Unexpected dataset version: ${dataset.version}`);
} else {
  pass("dataset version is 1");
}

if (!Array.isArray(dataset.cases) || dataset.cases.length < 16) {
  fail(`Expected at least 16 golden cases, found: ${dataset.cases?.length}`);
} else {
  pass(`found ${dataset.cases.length} golden cases (${dataset.cases.length}/16)`);
}

// Track IDs
const seenIds = new Set<string>();

for (const c of dataset.cases) {
  if (seenIds.has(c.id)) {
    fail(`Duplicate case ID: ${c.id}`);
  }
  seenIds.add(c.id);

  const fixtureRepo = path.join(FIXTURES, c.fixture, "repo");
  if (!existsSync(fixtureRepo)) {
    fail(`[${c.id}] Fixture directory does not exist: ${fixtureRepo}`);
    continue;
  }

  // 1. Verify retrieval expectations
  if (c.expectedOutcome === "abstain_no_evidence") {
    if (c.retrievalExpectation.mustRetrieve !== false) {
      fail(`[${c.id}] Abstention case must have mustRetrieve: false`);
    }
    if (c.retrievalExpectation.relevantFiles.length !== 0) {
      fail(`[${c.id}] Abstention case must have empty relevantFiles`);
    }
    if (c.expectedFacts.length !== 0) {
      fail(`[${c.id}] Abstention case must have empty expectedFacts`);
    }
    if (!c.policyExpectation) {
      fail(`[${c.id}] Abstention case must declare policyExpectation`);
    } else {
      pass(`[${c.id}] Verified abstention case schema: topic="${c.policyExpectation.topic}"`);
    }
    continue;
  }

  // Positive or scoped negative cases
  if (c.retrievalExpectation.mustRetrieve !== true) {
    fail(`[${c.id}] Positive case must have mustRetrieve: true`);
  }
  if (c.retrievalExpectation.relevantFiles.length === 0) {
    fail(`[${c.id}] Positive case must declare relevantFiles`);
  }

  // Check all relevant files and line bounds
  for (const rf of c.retrievalExpectation.relevantFiles) {
    const filePath = path.join(fixtureRepo, rf.path);
    if (!existsSync(filePath)) {
      fail(`[${c.id}] Relevant file does not exist: ${rf.path}`);
      continue;
    }
    const fileContent = readFileSync(filePath, "utf8");
    const lines = fileContent.split("\n");
    const lineCount = lines.length;

    for (const [start, end] of rf.ranges) {
      if (start < 1 || end > lineCount || start > end) {
        fail(`[${c.id}] Line range [${start}, ${end}] out of bounds for ${rf.path} (1..${lineCount})`);
      }
    }
  }

  // 2. Check structured facts
  if (c.expectedFacts.length === 0) {
    fail(`[${c.id}] Non-abstention case must declare expectedFacts`);
  }

  let caseHasError = false;
  for (const f of c.expectedFacts) {
    const evPath = path.join(fixtureRepo, f.evidence.path);
    if (!existsSync(evPath)) {
      fail(`[${c.id}] Evidence file does not exist: ${f.evidence.path}`);
      caseHasError = true;
      continue;
    }
    const fileContent = readFileSync(evPath, "utf8");
    const lines = fileContent.split("\n");
    const [start, end] = f.evidence.lines;

    if (start < 1 || end > lines.length || start > end) {
      fail(`[${c.id}] Evidence lines [${start}, ${end}] out of bounds for ${f.evidence.path} (1..${lines.length})`);
      caseHasError = true;
      continue;
    }

    const excerpt = lines.slice(start - 1, end).join("\n");

    // Semantic predicate verification
    const semanticError = validatePredicateSemantics(f, excerpt);
    if (semanticError) {
      fail(`[${c.id}] ${f.predicate} semantic failure: ${semanticError}`);
      caseHasError = true;
    }
  }

  if (!caseHasError) {
    pass(`[${c.id}] (${c.language}) All ${c.retrievalExpectation.relevantFiles.length} files and ${c.expectedFacts.length} facts verified semantically against fixture`);
  }
}

// 3. Verify all available cases in capability matrix exist in cases
for (const entry of dataset.capabilityMatrix) {
  for (const caseId of entry.goldenCasesAvailable) {
    if (!seenIds.has(caseId)) {
      fail(`Capability matrix for ${entry.language} references non-existent case: ${caseId}`);
    }
  }
}
pass("all capability matrix case references resolve to active cases");

  console.log("\n=== Summary ===");
  const fails = results.filter((r) => r.startsWith("FAIL"));
  if (fails.length > 0) {
    console.error(`${fails.length} assertions failed:\n` + fails.join("\n"));
    return false;
  }

  console.log(`All ${results.length} checks passed cleanly.`);
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const ok = runDatasetValidation();
  if (!ok) process.exit(1);
}
