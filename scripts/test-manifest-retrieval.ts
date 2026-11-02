// Comprehensive tests for CI-4 Phase 3: Non-Code Manifest Retrieval Integration.
//
// Verifies:
//   1. Stored primary manifest retrieval as hash-verified source evidence.
//   2. Strict filtering of absent, excluded, legacy_unclassified, and non-allowlisted non-code files.
//   3. Cross-analysis and organization isolation.
//   4. Deterministic budget compliance (characters, files, windows).
//   5. Ranking preservation between specific code symbols and manifest evidence.
//   6. Grounded citation verification and cache key sensitivity.
//
// Run: node scripts/test-manifest-retrieval.ts

import { createHash } from "node:crypto";
import { countLines } from "../lib/parser/walk.ts";
import {
  retrieveGroundedContext,
  formatRetrievedContext,
  type Db,
  type TargetWindow,
} from "../lib/ai/retrieval.ts";
import { answerQuestion, cacheKey, type Cache } from "../lib/ai/tasks.ts";
import { CitationError, verifyCitations } from "../lib/ai/citations.ts";
import { QUESTION_SYSTEM, questionMessage, type QuestionInput } from "../lib/ai/prompts.ts";
import type { BackfillDeps } from "../lib/content/read.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type FileRow = {
  id: string;
  analysis_id: string;
  organization_id: string;
  path: string;
  hash: string | null;
  lines: number | null;
  content_status: string;
  skip_reason: string | null;
  file_roles?: { role: string; source: string }[];
};

class MockRetrievalDb {
  files: FileRow[] = [];
  fileTexts = new Map<string, string>();
  symbols: { analysis_id: string; file_id: string; name: string; kind: string; line: number; exported: boolean }[] = [];
  edges: { analysis_id: string; source_file_id: string; target_file_id: string; kind: string }[] = [];

  from(table: string) {
    if (table === "files") {
      return {
        select: (cols: string) => {
          let filtered = [...this.files];
          const builder = {
            eq: (col: string, val: string) => {
              filtered = filtered.filter((f) => (f as Record<string, unknown>)[col] === val);
              return builder;
            },
            is: (col: string, val: unknown) => {
              filtered = filtered.filter((f) => (f as Record<string, unknown>)[col] === val);
              return builder;
            },
            in: (col: string, vals: string[]) => {
              const set = new Set(vals);
              filtered = filtered.filter((f) => set.has((f as Record<string, unknown>)[col] as string));
              return builder;
            },
            maybeSingle: async () => {
              const row = filtered[0];
              if (!row) return { data: null, error: null };
              return {
                data: {
                  ...row,
                  analysis: {
                    commit_sha: "abcd1234",
                    project: { repo_owner: "test-owner", repo_name: "test-repo" },
                  },
                },
                error: null,
              };
            },
            then: (resolve: (res: { data: FileRow[]; error: null }) => void) => {
              resolve({ data: filtered, error: null });
            },
          };
          return builder;
        },
      };
    }

    if (table === "symbols") {
      return {
        select: () => ({
          eq: (col: string, val: string) => {
            const data = this.symbols.filter((s) => (s as Record<string, unknown>)[col] === val);
            return Promise.resolve({ data, error: null });
          },
        }),
      };
    }

    if (table === "edges") {
      return {
        select: () => ({
          eq: (col: string, val: string) => ({
            or: (_clause: string) => {
              const data = this.edges.filter((e) => (e as Record<string, unknown>)[col] === val);
              return Promise.resolve({ data, error: null });
            },
          }),
        }),
      };
    }

    if (table === "file_contents") {
      return {
        select: () => ({
          eq: (_col1: string, orgId: string) => ({
            eq: (_col2: string, hash: string) => ({
              maybeSingle: async () => {
                const file = this.files.find((f) => f.hash === hash && f.organization_id === orgId);
                if (!file) return { data: null, error: null };
                const text = this.fileTexts.get(file.id);
                if (text === undefined) return { data: null, error: null };
                const hex = Buffer.from(text, "utf8").toString("hex");
                return {
                  data: {
                    payload: `\\x${hex}`,
                    size: Buffer.byteLength(text, "utf8"),
                  },
                  error: null,
                };
              },
            }),
          }),
        }),
      };
    }

    if (
      table === "manifests" ||
      table === "dependencies" ||
      table === "config_references" ||
      table === "entry_points" ||
      table === "routes"
    ) {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      };
    }

    throw new Error(`Unexpected table: ${table}`);
  }
}

async function run() {
  const db = new MockRetrievalDb();
  const orgId = "org_123";
  const analysisId = "analysis_curr";

  // 1. Stored package.json
  const pkgText = JSON.stringify(
    {
      name: "my-app",
      version: "1.0.0",
      dependencies: {
        express: "^4.18.2",
        zod: "^3.22.4",
      },
      devDependencies: {
        typescript: "^5.3.3",
      },
    },
    null,
    2,
  );
  const pkgHash = sha256(pkgText);
  const pkgLines = countLines(pkgText);

  db.files.push({
    id: "f_pkg",
    analysis_id: analysisId,
    organization_id: orgId,
    path: "package.json",
    hash: pkgHash,
    lines: pkgLines,
    content_status: "stored",
    skip_reason: null,
  });
  db.fileTexts.set("f_pkg", pkgText);

  // 2. Stored Cargo.toml
  const cargoText = `[package]\nname = "my-crate"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde = "1.0"\n`;
  const cargoHash = sha256(cargoText);
  db.files.push({
    id: "f_cargo",
    analysis_id: analysisId,
    organization_id: orgId,
    path: "Cargo.toml",
    hash: cargoHash,
    lines: countLines(cargoText),
    content_status: "stored",
    skip_reason: null,
  });
  db.fileTexts.set("f_cargo", cargoText);

  // 3. Absent pyproject.toml
  const pyText = `[project]\nname = "py-app"\nversion = "0.1.0"\ndependencies = ["requests>=2.31.0"]\n`;
  const pyHash = sha256(pyText);
  db.files.push({
    id: "f_py",
    analysis_id: analysisId,
    organization_id: orgId,
    path: "pyproject.toml",
    hash: pyHash,
    lines: countLines(pyText),
    content_status: "absent",
    skip_reason: null,
  });
  db.fileTexts.set("f_py", pyText);

  // 4. Excluded requirements.txt
  const reqText = `flask==3.0.0\ngunicorn==21.2.0\n`;
  const reqHash = sha256(reqText);
  db.files.push({
    id: "f_req",
    analysis_id: analysisId,
    organization_id: orgId,
    path: "requirements.txt",
    hash: reqHash,
    lines: countLines(reqText),
    content_status: "excluded",
    skip_reason: null,
  });
  db.fileTexts.set("f_req", reqText);

  // 5. Legacy unclassified pnpm-workspace.yaml
  const pnpmText = `packages:\n  - 'packages/*'\n`;
  const pnpmHash = sha256(pnpmText);
  db.files.push({
    id: "f_pnpm",
    analysis_id: analysisId,
    organization_id: orgId,
    path: "pnpm-workspace.yaml",
    hash: pnpmHash,
    lines: countLines(pnpmText),
    content_status: "legacy_unclassified",
    skip_reason: null,
  });
  db.fileTexts.set("f_pnpm", pnpmText);

  // 6. Non-allowlisted non-code file (README.md)
  const readmeText = `# My App\nDocumentation overview\n`;
  const readmeHash = sha256(readmeText);
  db.files.push({
    id: "f_readme",
    analysis_id: analysisId,
    organization_id: orgId,
    path: "README.md",
    hash: readmeHash,
    lines: countLines(readmeText),
    content_status: "stored",
    skip_reason: null,
  });
  db.fileTexts.set("f_readme", readmeText);

  // 7. Stored code file
  const codeText = `import express from "express";\nexport function startServer() {\n  return express();\n}\n`;
  const codeHash = sha256(codeText);
  db.files.push({
    id: "f_code",
    analysis_id: analysisId,
    organization_id: orgId,
    path: "src/server.ts",
    hash: codeHash,
    lines: countLines(codeText),
    content_status: "stored",
    skip_reason: null,
    file_roles: [{ role: "service", source: "convention" }],
  });
  db.fileTexts.set("f_code", codeText);
  db.symbols.push({
    analysis_id: analysisId,
    file_id: "f_code",
    name: "startServer",
    kind: "function",
    line: 2,
    exported: true,
  });

  // 8. Foreign analysis manifest (different analysis_id)
  const foreignText = `{\n  "name": "foreign-app",\n  "dependencies": { "secret-dep": "1.0.0" }\n}\n`;
  const foreignHash = sha256(foreignText);
  db.files.push({
    id: "f_foreign",
    analysis_id: "other_analysis",
    organization_id: "other_org",
    path: "package.json",
    hash: foreignHash,
    lines: countLines(foreignText),
    content_status: "stored",
    skip_reason: null,
  });
  db.fileTexts.set("f_foreign", foreignText);

  // Guard against any unexpected backfill calls
  let backfillInvoked = false;
  const backfillDeps: BackfillDeps = {
    writer: undefined,
    fetchFile: async () => {
      backfillInvoked = true;
      throw new Error("Backfill must never be invoked for non-code manifests");
    },
    cache: null,
  };

  console.log("=== 1. Stored Primary Manifest Retrieval ===");
  {
    const res = await retrieveGroundedContext(
      db as unknown as Db,
      analysisId,
      "What dependencies are listed in package.json?",
      {},
      null,
      backfillDeps,
    );

    if (res.insufficientEvidence) {
      fail("package.json query returned insufficient evidence");
    } else {
      pass("package.json query discovered evidence");
    }

    const pkgWindow = res.windows.find((w) => w.path === "package.json");
    if (pkgWindow) {
      pass("package.json window retrieved as source evidence");
      if (pkgWindow.text.includes('"express": "^4.18.2"') && pkgWindow.text.includes('"zod"')) {
        pass("retrieved window contains verified text from file_contents");
      } else {
        fail(`retrieved window missing expected dependencies: ${pkgWindow.text}`);
      }
      if (pkgWindow.contentHash === pkgHash) {
        pass("window contentHash matches stored sha256");
      } else {
        fail(`hash mismatch: expected ${pkgHash}, got ${pkgWindow.contentHash}`);
      }
    } else {
      fail(`package.json missing from retrieved windows: ${res.windows.map((w) => w.path).join(", ")}`);
    }

    const pkgFile = res.files.find((f) => f.path === "package.json");
    if (pkgFile && pkgFile.contentHash === pkgHash && pkgFile.totalLines === pkgLines) {
      pass("retrieved.files accurately registers package.json metadata");
    } else {
      fail("retrieved.files missing or corrupt package.json entry");
    }

    const formatted = formatRetrievedContext(res);
    if (formatted.includes(`--- File: package.json (lines 1-${pkgLines}) [hash: ${pkgHash.slice(0, 8)}] ---`)) {
      pass("formatted context includes standard verified file header with hash");
    } else {
      fail(`formatRetrievedContext output missing expected header: ${formatted}`);
    }
  }

  // Glossary expansion for packaging question
  {
    const res = await retrieveGroundedContext(
      db as unknown as Db,
      analysisId,
      "What dependencies does this project have?",
      {},
      null,
      backfillDeps,
    );
    if (res.windows.some((w) => w.path === "package.json")) {
      pass("concept glossary expands 'dependencies' to retrieve package.json manifest");
    } else {
      fail(`dependencies query did not retrieve package.json: ${res.windows.map((w) => w.path).join(", ")}`);
    }
  }

  // Cargo manifest query
  {
    const res = await retrieveGroundedContext(
      db as unknown as Db,
      analysisId,
      "Inspect Cargo.toml crates",
      {},
      null,
      backfillDeps,
    );
    if (res.windows.some((w) => w.path === "Cargo.toml")) {
      pass("Cargo.toml manifest retrieved for Cargo query");
    } else {
      fail(`Cargo.toml missing from retrieval: ${res.windows.map((w) => w.path).join(", ")}`);
    }
  }

  console.log("\n=== 2. Strict Filtering of Ineligible Non-Code Files ===");
  {
    // Absent pyproject.toml
    const resPy = await retrieveGroundedContext(
      db as unknown as Db,
      analysisId,
      "What is in pyproject.toml?",
      {},
      null,
      backfillDeps,
    );
    if (resPy.windows.some((w) => w.path === "pyproject.toml")) {
      fail("absent pyproject.toml leaked into retrieved windows");
    } else {
      pass("absent pyproject.toml is strictly filtered out of retrieval candidates");
    }
    if (backfillInvoked) {
      fail("GitHub backfill was attempted on an absent manifest");
    } else {
      pass("no backfill attempted for absent non-code files");
    }

    // Excluded requirements.txt
    const resReq = await retrieveGroundedContext(
      db as unknown as Db,
      analysisId,
      "Show requirements.txt",
      {},
      null,
      backfillDeps,
    );
    if (resReq.windows.some((w) => w.path === "requirements.txt")) {
      fail("excluded requirements.txt leaked into retrieved windows");
    } else {
      pass("excluded requirements.txt is strictly excluded from retrieval");
    }

    // Legacy unclassified pnpm-workspace.yaml
    const resPnpm = await retrieveGroundedContext(
      db as unknown as Db,
      analysisId,
      "Show pnpm-workspace.yaml",
      {},
      null,
      backfillDeps,
    );
    if (resPnpm.windows.some((w) => w.path === "pnpm-workspace.yaml")) {
      fail("legacy_unclassified pnpm-workspace.yaml leaked into retrieved windows");
    } else {
      pass("legacy_unclassified pnpm-workspace.yaml is strictly rejected");
    }

    // Non-allowlisted non-code file (README.md)
    const resReadme = await retrieveGroundedContext(
      db as unknown as Db,
      analysisId,
      "Show README.md documentation",
      {},
      null,
      backfillDeps,
    );
    if (resReadme.windows.some((w) => w.path === "README.md")) {
      fail("non-allowlisted README.md was retrieved as source evidence");
    } else {
      pass("non-allowlisted non-code files (README.md) are denied candidate entry");
    }
  }

  console.log("\n=== 3. Cross-Analysis and Organization Isolation ===");
  {
    const res = await retrieveGroundedContext(
      db as unknown as Db,
      analysisId,
      "What dependencies are listed in package.json?",
      {},
      null,
      backfillDeps,
    );
    const win = res.windows.find((w) => w.path === "package.json");
    if (win && win.text.includes("foreign-app")) {
      fail("foreign analysis manifest leaked into retrieval context");
    } else {
      pass("foreign analysis manifest never leaks across analysis boundaries");
    }
  }

  console.log("\n=== 4. Bounded Budget Compliance ===");
  {
    // Restrict maxCharacters to 200 with 2 matching manifests (total ~280 chars)
    const tightBudgetRes = await retrieveGroundedContext(
      db as unknown as Db,
      analysisId,
      "package.json Cargo.toml",
      { maxCharacters: 200 },
      null,
      backfillDeps,
    );
    if (tightBudgetRes.totalCharacters <= 200 && tightBudgetRes.windows.length === 1) {
      pass(`character budget respected under tight cap (totalChars: ${tightBudgetRes.totalCharacters} <= 200, windows: 1)`);
    } else {
      fail(`character budget not bounded: totalChars=${tightBudgetRes.totalCharacters}, windows=${tightBudgetRes.windows.length}`);
    }

    // Restrict maxFiles to 1 with multiple matches
    const fileBudgetRes = await retrieveGroundedContext(
      db as unknown as Db,
      analysisId,
      "package.json Cargo.toml",
      { maxFiles: 1 },
      null,
      backfillDeps,
    );
    if (fileBudgetRes.files.length <= 1) {
      pass(`maxFiles budget cap respected (files retrieved: ${fileBudgetRes.files.length})`);
    } else {
      fail(`maxFiles budget exceeded: ${fileBudgetRes.files.length} > 1`);
    }
  }

  console.log("\n=== 5. Ranking Preservation ===");
  {
    // Specific symbol query: "startServer"
    const symbolRes = await retrieveGroundedContext(
      db as unknown as Db,
      analysisId,
      "How does startServer function work?",
      {},
      null,
      backfillDeps,
    );
    if (symbolRes.windows[0]?.path === "src/server.ts") {
      pass("exact code symbol match ranks before secondary or generic files");
    } else {
      fail(`symbol match did not rank first: ${symbolRes.windows.map((w) => w.path).join(", ")}`);
    }

    // Direct manifest query: "package.json"
    const manifestRes = await retrieveGroundedContext(
      db as unknown as Db,
      analysisId,
      "Inspect package.json dependencies",
      {},
      null,
      backfillDeps,
    );
    if (manifestRes.windows[0]?.path === "package.json") {
      pass("direct manifest query ranks package.json as top evidence window");
    } else {
      fail(`package.json was not top window: ${manifestRes.windows.map((w) => w.path).join(", ")}`);
    }
  }

  console.log("\n=== 6. Citations & Cache Identity ===");
  {
    const cacheStore = new Map<string, string>();
    const testCache: Cache = {
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

    const qInput: QuestionInput = {
      question: "What dependencies are in package.json?",
      contextText: formatRetrievedContext(
        await retrieveGroundedContext(db as unknown as Db, analysisId, "package.json", {}, null, backfillDeps),
      ),
      files: [
        {
          path: "package.json",
          contentHash: pkgHash,
          totalLines: pkgLines,
        },
      ],
    };

    // Valid line citation to stored package.json
    const answer1 = await answerQuestion(qInput, {
      cache: testCache,
      complete: async () => "Dependencies include express in `package.json:4-7`.",
    });
    if (!answer1.cached && answer1.citations.length > 0) {
      pass("line-bound citation to retrieved stored manifest succeeds (package.json:4-7)");
    } else {
      fail(`citation to stored manifest failed: ${JSON.stringify(answer1)}`);
    }

    // Out-of-bounds line citation to package.json
    try {
      await answerQuestion(
        { ...qInput, question: "check out of bounds" },
        {
          cache: testCache,
          complete: async () => "Invalid citation `package.json:1-999`.",
        },
      );
      fail("out-of-bounds line citation should have thrown CitationError");
    } catch (err) {
      if (err instanceof CitationError) {
        pass("out-of-bounds line citation fails closed with CitationError");
      } else {
        fail(`unexpected error type: ${err}`);
      }
    }

    // Line citation to absent manifest (pyproject.toml)
    try {
      await answerQuestion(
        { ...qInput, question: "check absent citation" },
        {
          cache: testCache,
          complete: async () => "Pyproject dependencies in `pyproject.toml:1-5`.",
        },
      );
      fail("citation to unretrieved absent manifest should have thrown CitationError");
    } catch (err) {
      if (err instanceof CitationError) {
        pass("citation to unretrieved manifest fails closed with CitationError");
      } else {
        fail(`unexpected error type: ${err}`);
      }
    }

    // Cache key sensitivity: altering manifest content changes cache key
    const keyOriginal = cacheKey("answer-question", "gemini-2.5-flash", {
      system: QUESTION_SYSTEM,
      body: questionMessage({
        ...qInput,
        question: qInput.question.toLowerCase(),
      }),
    });

    const modifiedInput: QuestionInput = {
      ...qInput,
      contextText: qInput.contextText.replace('"express": "^4.18.2"', '"express": "^5.0.0"'),
    };
    const keyModified = cacheKey("answer-question", "gemini-2.5-flash", {
      system: QUESTION_SYSTEM,
      body: questionMessage({
        ...modifiedInput,
        question: modifiedInput.question.toLowerCase(),
      }),
    });

    if (keyOriginal !== keyModified) {
      pass("cache identity naturally differentiates modified manifest content");
    } else {
      fail("cache key did not change when manifest context was modified");
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
