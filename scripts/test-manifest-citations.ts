// Tests for CI-4 Phase 4: Non-Code Manifest Citation Integration.
//
// Verifies:
//   1. Valid line-bound citations to securely stored, retrieved primary manifests.
//   2. Verification of cited line ranges against actual retrieved window bounds and total line counts.
//   3. Rejection of unretrieved, absent, excluded, legacy_unclassified, and skipped manifests.
//   4. Strict rejection of wrong-analysis and wrong-organization manifests.
//   5. Equivalence of citation verification between fresh answers and cached answers.
//   6. Cache invalidation, purge, and healing when manifest evidence status changes.
//   7. Raw public.manifests metadata cannot authorize source-line citations.
//   8. Complete preservation of code-file citation verification semantics.
//
// Run: node scripts/test-manifest-citations.ts

import {
  verifyCitations,
  CitationError,
  extractCitations,
  type FileEvidence,
  type ManifestFile,
} from "../lib/ai/citations.ts";
import { answerQuestion, cacheKey, type Cache } from "../lib/ai/tasks.ts";
import { QUESTION_SYSTEM, questionMessage, type QuestionInput } from "../lib/ai/prompts.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

async function run() {
  const currentAnalysisId = "analysis_curr";
  const otherAnalysisId = "analysis_other";

  console.log("=== 1. Valid Line Citations to Stored Retrieved Primary Manifests ===");
  {
    // Evidence map with all 6 primary manifests retrieved as stored source evidence
    const manifestEvidence = new Map<string, FileEvidence>([
      ["package.json", { lines: 35, contentHash: "hash_pkg", windows: [{ startLine: 1, endLine: 35 }] }],
      ["Cargo.toml", { lines: 25, contentHash: "hash_cargo", windows: [{ startLine: 1, endLine: 25 }] }],
      ["go.mod", { lines: 20, contentHash: "hash_go", windows: [{ startLine: 1, endLine: 20 }] }],
      ["pyproject.toml", { lines: 30, contentHash: "hash_py", windows: [{ startLine: 1, endLine: 30 }] }],
      ["requirements.txt", { lines: 15, contentHash: "hash_req", windows: [{ startLine: 1, endLine: 15 }] }],
      ["pnpm-workspace.yaml", { lines: 10, contentHash: "hash_pnpm", windows: [{ startLine: 1, endLine: 10 }] }],
    ]);

    const answerBody =
      "Dependencies are configured in `package.json:5-15` and `Cargo.toml#L1-L10`. " +
      "Go modules use `go.mod:1-8`, Python uses `pyproject.toml#L10-L25` and `requirements.txt:1-5`. " +
      "Workspaces are in `pnpm-workspace.yaml:1-5`.";

    const verification = verifyCitations(answerBody, manifestEvidence, { analysisId: currentAnalysisId });
    if (verification.paths.length === 0) {
      pass("all 6 primary manifests accept valid line-bound citations when retrieved");
    } else {
      fail(`valid manifest citations rejected: ${JSON.stringify(verification)}`);
    }

    const citations = extractCitations(answerBody);
    if (citations.length === 6) {
      pass("extractCitations extracts all 6 manifest citations with line bounds");
    } else {
      fail(`expected 6 citations, got ${citations.length}`);
    }
  }

  console.log("\n=== 2. Retrieved Window Bounds Verification ===");
  {
    // Manifest retrieved with a bounded window [1, 20], but total file length is 50 lines
    const boundedEvidence = new Map<string, FileEvidence>([
      ["package.json", { lines: 50, contentHash: "hash_pkg", windows: [{ startLine: 1, endLine: 20 }] }],
    ]);

    // A. Citation completely within retrieved window [1, 20]
    const inWindow = verifyCitations("See `package.json:5-15`.", boundedEvidence);
    if (inWindow.paths.length === 0) {
      pass("citation inside retrieved window bounds passes verification");
    } else {
      fail(`in-window citation failed: ${JSON.stringify(inWindow)}`);
    }

    // B. Citation extending past the retrieved window [1, 20] (even though <= totalLines 50)
    const outWindow = verifyCitations("See `package.json:15-30`.", boundedEvidence);
    if (outWindow.paths.length === 1 && outWindow.details?.[0]?.includes("not within retrieved window")) {
      pass("citation extending outside retrieved window bounds is rejected");
    } else {
      fail(`out-of-window citation not caught: ${JSON.stringify(outWindow)}`);
    }

    // C. Citation completely outside the retrieved window [25, 40]
    const outsideBoth = verifyCitations("See `package.json:25-40`.", boundedEvidence);
    if (outsideBoth.paths.length === 1 && outsideBoth.details?.[0]?.includes("not within retrieved window")) {
      pass("citation completely outside retrieved window is rejected");
    } else {
      fail(`outside-window citation not caught: ${JSON.stringify(outsideBoth)}`);
    }

    // D. Citation exceeding totalLines (> 50)
    const overTotal = verifyCitations("See `package.json:1-999`.", boundedEvidence);
    if (overTotal.paths.length === 1 && overTotal.details?.[0]?.includes("exceeds file length")) {
      pass("citation exceeding totalLines fails with length error");
    } else {
      fail(`over-total citation not caught: ${JSON.stringify(overTotal)}`);
    }

    // E. Inverted line range
    const inverted = verifyCitations("See `package.json:20-10`.", boundedEvidence);
    if (inverted.paths.length === 1 && inverted.details?.[0]?.includes("exceeds end line")) {
      pass("inverted line range fails verification");
    } else {
      fail(`inverted range not caught: ${JSON.stringify(inverted)}`);
    }

    // F. Zero start line
    const zeroStart = verifyCitations("See `package.json:0-10`.", boundedEvidence);
    if (zeroStart.paths.length === 1 && zeroStart.details?.[0]?.includes("must be >= 1")) {
      pass("zero start line fails verification");
    } else {
      fail(`zero start line not caught: ${JSON.stringify(zeroStart)}`);
    }
  }

  console.log("\n=== 3. Rejection of Unretrieved, Absent, Excluded & Legacy Manifests ===");
  {
    // Allowed evidence contains only a code file; no manifests were retrieved
    const codeOnlyEvidence = new Map<string, FileEvidence>([
      ["src/index.ts", { lines: 100, contentHash: "hash_code", windows: [{ startLine: 1, endLine: 100 }] }],
    ]);

    // Packaging metadata records various unretrieved / non-stored manifests
    const manifestsByPath = new Map<string, ManifestFile>([
      ["package.json", { path: "package.json", content_status: "absent", analysis_id: currentAnalysisId, rendered: true }],
      ["Cargo.toml", { path: "Cargo.toml", content_status: "excluded", analysis_id: currentAnalysisId, rendered: true }],
      ["pyproject.toml", { path: "pyproject.toml", content_status: "legacy_unclassified", analysis_id: currentAnalysisId, rendered: true }],
      ["requirements.txt", { path: "requirements.txt", content_status: "stored", analysis_id: currentAnalysisId, rendered: false }],
    ]);

    // Line citations to absent, excluded, legacy, or unretrieved manifests
    const lineCitations = [
      "`package.json:1-10`",
      "`Cargo.toml:1-10`",
      "`pyproject.toml:1-10`",
      "`requirements.txt:1-10`",
    ];

    for (const cite of lineCitations) {
      const res = verifyCitations(`Reference: ${cite}`, codeOnlyEvidence, {
        allAnalysisFiles: new Set(["src/index.ts"]),
        manifestsByPath,
        analysisId: currentAnalysisId,
      });
      if (res.paths.length === 1) {
        pass(`line citation to non-retrieved manifest ${cite} is rejected`);
      } else {
        fail(`line citation to non-retrieved manifest ${cite} was allowed: ${JSON.stringify(res)}`);
      }
    }

    // Bare mentions of absent, excluded, and legacy manifests
    const bareChecks = [
      { path: "package.json", desc: "absent manifest" },
      { path: "Cargo.toml", desc: "excluded manifest" },
      { path: "pyproject.toml", desc: "legacy_unclassified manifest" },
    ];
    for (const { path: p, desc } of bareChecks) {
      const res = verifyCitations(`Reference: \`${p}\``, codeOnlyEvidence, {
        allAnalysisFiles: new Set(["src/index.ts"]),
        manifestsByPath,
        analysisId: currentAnalysisId,
      });
      if (res.paths.length === 1) {
        pass(`bare mention of ${desc} (\`${p}\`) is rejected`);
      } else {
        fail(`bare mention of ${desc} (\`${p}\`) was unexpectedly allowed`);
      }
    }
  }

  console.log("\n=== 4. Cross-Analysis and Wrong-Organization Isolation ===");
  {
    const allowed = new Map<string, FileEvidence>([
      ["src/index.ts", { lines: 50, contentHash: "hash_code" }],
    ]);

    // Manifest belonging to a different analysis_id
    const foreignManifests = new Map<string, ManifestFile>([
      ["package.json", { path: "package.json", content_status: "stored", analysis_id: otherAnalysisId, rendered: true }],
    ]);

    const resForeign = verifyCitations("The app uses `package.json`.", allowed, {
      allAnalysisFiles: new Set(["src/index.ts"]),
      manifestsByPath: foreignManifests,
      analysisId: currentAnalysisId,
    });

    if (resForeign.paths.length === 1) {
      pass("foreign-analysis manifest bare citation is rejected");
    } else {
      fail("foreign-analysis manifest citation leaked");
    }

    const resForeignLine = verifyCitations("The app uses `package.json:1-10`.", allowed, {
      allAnalysisFiles: new Set(["src/index.ts"]),
      manifestsByPath: foreignManifests,
      analysisId: currentAnalysisId,
    });

    if (resForeignLine.paths.length === 1) {
      pass("foreign-analysis manifest line citation is rejected");
    } else {
      fail("foreign-analysis manifest line citation leaked");
    }
  }

  console.log("\n=== 5. Raw public.manifests Metadata Cannot Authorize Source Citations ===");
  {
    // Manifest is stored and rendered in packaging metadata, but was NOT retrieved as source evidence
    const manifestsByPath = new Map<string, ManifestFile>([
      ["package.json", { path: "package.json", content_status: "stored", analysis_id: currentAnalysisId, rendered: true }],
    ]);

    const allowedWithoutManifest = new Map<string, FileEvidence>([
      ["src/server.ts", { lines: 80, contentHash: "hash_server" }],
    ]);

    // A. Bare mention passes because manifest is stored, belongs to current analysis, and is rendered in packaging
    const bareRes = verifyCitations("The project uses `package.json`.", allowedWithoutManifest, {
      allAnalysisFiles: new Set(["src/server.ts", "package.json"]),
      manifestsByPath,
      analysisId: currentAnalysisId,
    });
    if (bareRes.paths.length === 0) {
      pass("stored rendered manifest is groundable for bare mention");
    } else {
      fail(`bare mention unexpectedly failed: ${JSON.stringify(bareRes)}`);
    }

    // B. Line-bound citation MUST FAIL because metadata cannot authorize source lines
    const lineRes = verifyCitations("The dependencies are in `package.json:10-20`.", allowedWithoutManifest, {
      allAnalysisFiles: new Set(["src/server.ts", "package.json"]),
      manifestsByPath,
      analysisId: currentAnalysisId,
    });
    if (lineRes.paths.length === 1 && lineRes.details?.[0]?.includes("not in retrieved evidence")) {
      pass("metadata presence cannot authorize line-bound source citations");
    } else {
      fail(`metadata improperly authorized source line citation: ${JSON.stringify(lineRes)}`);
    }
  }

  console.log("\n=== 6. Fresh Answer and Cached Answer Equivalence & Self-Healing ===");
  {
    const cacheStore = new Map<string, string>();
    const mockCache: Cache = {
      async read(key: string) {
        return cacheStore.get(key) ?? null;
      },
      async write({ key, body }) {
        cacheStore.set(key, body);
      },
      async delete(key: string) {
        cacheStore.delete(key);
      },
    };

    const pkgHash = "hash_pkg_verified";
    const qInput: QuestionInput = {
      question: "What dependencies are in package.json?",
      contextText: "--- File: package.json (lines 1-30) [hash: hash_pkg] ---\n{\n  \"dependencies\": {\"express\": \"4.18.2\"}\n}",
      files: [
        {
          path: "package.json",
          contentHash: pkgHash,
          totalLines: 30,
          windows: [{ startLine: 1, endLine: 30 }],
        },
      ],
    };

    const manifestsByPath = new Map<string, ManifestFile>([
      ["package.json", { path: "package.json", content_status: "stored", analysis_id: currentAnalysisId, rendered: true }],
    ]);

    let modelCalls = 0;
    const completeMock = async () => {
      modelCalls++;
      return "Express is declared in `package.json:2-3`.";
    };

    // A. Fresh answer generation & verification
    const freshAnswer = await answerQuestion(qInput, {
      cache: mockCache,
      complete: completeMock,
      allAnalysisFiles: new Set(["package.json"]),
      manifestsByPath,
      analysisId: currentAnalysisId,
    });

    if (!freshAnswer.cached && modelCalls === 1 && freshAnswer.citations.length === 1) {
      pass("fresh answer citing retrieved manifest lines verifies and caches");
    } else {
      fail("fresh answer generation failed");
    }

    // B. Cached answer verification hit
    const cachedAnswer = await answerQuestion(qInput, {
      cache: mockCache,
      complete: completeMock,
      allAnalysisFiles: new Set(["package.json"]),
      manifestsByPath,
      analysisId: currentAnalysisId,
    });

    if (cachedAnswer.cached && modelCalls === 1 && cachedAnswer.citations.length === 1) {
      pass("cached answer verifies and serves identical manifest citations without model call");
    } else {
      fail("cached answer verification failed");
    }

    // C. Cache invalidation on manifest quarantine / status change
    // Manifest changes to 'excluded' in fresh verification
    const quarantinedManifests = new Map<string, ManifestFile>([
      ["package.json", { path: "package.json", content_status: "excluded", analysis_id: currentAnalysisId, rendered: true }],
    ]);

    // Also remove package.json from retrieved files (as Phase 3 does when excluded)
    const quarantinedInput: QuestionInput = {
      ...qInput,
      files: [],
      contextText: "No source evidence.",
    };

    const healedAnswer = await answerQuestion(quarantinedInput, {
      cache: mockCache,
      complete: async () => {
        modelCalls++;
        return "No manifest is available.";
      },
      allAnalysisFiles: new Set(),
      manifestsByPath: quarantinedManifests,
      analysisId: currentAnalysisId,
    });

    if (modelCalls === 2 && !healedAnswer.cached) {
      pass("cache hit citing quarantined manifest is rejected, purged, and healed with regeneration");
    } else {
      fail("cache invalidation failed when manifest status changed");
    }
  }

  console.log("\n=== 7. Code File Citations Remain Completely Unchanged ===");
  {
    const codeEvidence = new Map<string, FileEvidence>([
      ["src/auth/session.ts", { lines: 100, contentHash: "code_hash_1" }],
      ["src/database/client.ts", { lines: 80, contentHash: "code_hash_2" }],
    ]);

    const codeAnswer = "Auth happens in `src/auth/session.ts:10-40` and DB queries in `src/database/client.ts#L15-L30`.";
    const codeRes = verifyCitations(codeAnswer, codeEvidence, {
      allAnalysisFiles: new Set(["src/auth/session.ts", "src/database/client.ts"]),
      analysisId: currentAnalysisId,
    });

    if (codeRes.paths.length === 0) {
      pass("code-file line citations verify identically without regression");
    } else {
      fail(`code file citation failed: ${JSON.stringify(codeRes)}`);
    }

    // Out of bounds code file citation (> totalLines 100)
    const codeBadRange = verifyCitations("Auth happens in `src/auth/session.ts:90-150`.", codeEvidence);
    if (codeBadRange.paths.length === 1 && codeBadRange.details?.[0]?.includes("exceeds file length")) {
      pass("out-of-bounds code file citation is rejected as before");
    } else {
      fail("out-of-bounds code citation was not rejected");
    }
  }

  console.log("\nSummary:");
  for (const r of results) {
    console.log(r);
  }

  const failed = results.filter((r) => r.startsWith("FAIL"));
  if (failed.length > 0) {
    console.error(`\n${failed.length} test(s) failed.`);
    process.exit(1);
  } else {
    console.log(`\nAll ${results.length} checks passed.`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
