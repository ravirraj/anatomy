// Tests Milestone 2: Deterministic Retrieval Engine
// Exercises query normalization, entity extraction, multi-index discovery,
// graph expansion, window merging, and context budgeting.

import { createHash } from "node:crypto";
import {
  extractQueryTokens,
  formatRetrievedContext,
  mergeCandidateWindows,
  retrieveGroundedContext,
  type Db,
  type TargetWindow,
} from "../lib/ai/retrieval.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

// --- Section 1: Query token normalization ---
console.log("=== 1. Query token normalization ===");

const tokens1 = extractQueryTokens("How does authentication and session work in this repository?");
if (tokens1.includes("authentication") && tokens1.includes("session") && !tokens1.includes("how") && !tokens1.includes("work")) {
  pass("stop words are filtered and keywords extracted");
} else {
  fail(`unexpected tokens: ${JSON.stringify(tokens1)}`);
}

const tokens2 = extractQueryTokens("Where is createAdminSupabase client configured?");
if (tokens2.includes("createadminsupabase") && tokens2.includes("admin") && tokens2.includes("supabase")) {
  pass("camelCase identifiers are expanded and indexed");
} else {
  fail(`camelCase expansion failed: ${JSON.stringify(tokens2)}`);
}

const tokens3 = extractQueryTokens("Inspect app/(workspace)/analyses/[id]/actions.ts router");
if (tokens3.some((t) => t.includes("actions.ts"))) {
  pass("explicit file paths with extensions are extracted");
} else {
  fail(`file path extraction failed: ${JSON.stringify(tokens3)}`);
}

// --- Section 2: Window merging and deduplication ---
console.log("");
console.log("=== 2. Window merging and deduplication ===");

const sampleWindows: TargetWindow[] = [
  {
    fileId: "f1",
    path: "src/auth.ts",
    contentHash: "hash1",
    totalLines: 100,
    startLine: 10,
    endLine: 30,
    score: 80,
    reason: "match 1",
  },
  {
    fileId: "f1",
    path: "src/auth.ts",
    contentHash: "hash1",
    totalLines: 100,
    startLine: 25,
    endLine: 50,
    score: 90,
    reason: "match 2",
  },
  {
    fileId: "f1",
    path: "src/auth.ts",
    contentHash: "hash1",
    totalLines: 100,
    startLine: 70,
    endLine: 90,
    score: 60,
    reason: "match 3",
  },
  {
    fileId: "f2",
    path: "src/user.ts",
    contentHash: "hash2",
    totalLines: 50,
    startLine: 1,
    endLine: 40,
    score: 75,
    reason: "user match",
  },
];

const merged = mergeCandidateWindows(sampleWindows);
const f1Merged = merged.filter((m) => m.fileId === "f1");
const f2Merged = merged.filter((m) => m.fileId === "f2");

if (f1Merged.length === 2) {
  pass("overlapping windows on same file merged into 2 disjoint regions");
} else {
  fail(`expected 2 merged windows for f1, got ${f1Merged.length}`);
}

const firstWindow = f1Merged.find((m) => m.startLine === 10);
if (firstWindow && firstWindow.endLine === 50 && firstWindow.score === 90) {
  pass("merged window expands to cover [10, 50] with highest score");
} else {
  fail(`merged window bounds incorrect: start=${firstWindow?.startLine}, end=${firstWindow?.endLine}`);
}

if (f2Merged.length === 1 && f2Merged[0]!.path === "src/user.ts") {
  pass("independent file windows are preserved");
} else {
  fail("independent file window failed");
}

// --- Section 3: Multi-stage retrieval with Fake Database ---
console.log("");
console.log("=== 3. Multi-stage retrieval with mock DB ===");

const textAuth = Array.from({ length: 80 }, (_, i) => `// line ${i + 1} of session.ts\n`).join("");
const hashAuth = createHash("sha256").update(textAuth).digest("hex");

const textUser = Array.from({ length: 60 }, (_, i) => `// line ${i + 1} of user.ts\n`).join("");
const hashUser = createHash("sha256").update(textUser).digest("hex");

const textRoute = Array.from({ length: 40 }, (_, i) => `// line ${i + 1} of login.ts\n`).join("");
const hashRoute = createHash("sha256").update(textRoute).digest("hex");

class MockDb {
  files = [
    {
      id: "f_auth",
      path: "src/auth/session.ts",
      hash: hashAuth,
      lines: 80,
      content_status: "stored",
      file_roles: [{ role: "service", source: "convention" }],
    },
    {
      id: "f_user",
      path: "src/models/user.ts",
      hash: hashUser,
      lines: 60,
      content_status: "stored",
      file_roles: [{ role: "model", source: "convention" }],
    },
    {
      id: "f_route",
      path: "src/api/login.ts",
      hash: hashRoute,
      lines: 40,
      content_status: "stored",
      file_roles: [{ role: "endpoint", source: "convention" }],
    },
  ];

  symbols = [
    { file_id: "f_auth", name: "validateSession", kind: "function", line: 25, exported: true },
    { file_id: "f_auth", name: "createToken", kind: "function", line: 55, exported: true },
    { file_id: "f_user", name: "UserRecord", kind: "interface", line: 10, exported: true },
  ];

  routes = [
    { file_id: "f_route", method: "POST", path: "/api/login", line: 15 },
  ];

  edges = [
    { source_file_id: "f_route", target_file_id: "f_auth", kind: "import" },
  ];

  fileTexts = new Map<string, string>([
    ["f_auth", textAuth],
    ["f_user", textUser],
    ["f_route", textRoute],
  ]);

  from(table: string) {
    if (table === "files") {
      return {
        select: () => ({
          eq: (_f: string, val: string) => ({
            is: () => Promise.resolve({ data: this.files, error: null }),
            maybeSingle: async () => {
              const file = this.files.find((f) => f.id === val);
              if (!file) return { data: null, error: null };
              return {
                data: {
                  ...file,
                  organization_id: "org_test",
                  analysis: { commit_sha: "sha1", project: { repo_owner: "o", repo_name: "r" } },
                },
                error: null,
              };
            },
          }),
        }),
      };
    }
    if (table === "symbols") {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: this.symbols, error: null }),
        }),
      };
    }
    if (table === "routes") {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: this.routes, error: null }),
        }),
      };
    }
    if (table === "edges") {
      return {
        select: () => ({
          eq: () => ({
            or: () => Promise.resolve({ data: this.edges, error: null }),
          }),
        }),
      };
    }
    if (table === "file_contents") {
      return {
        select: () => ({
          eq: () => ({
            eq: (_f2: string, hash: string) => ({
              maybeSingle: async () => {
                const f = this.files.find((file) => file.hash === hash);
                if (!f) return { data: null, error: null };
                const text = this.fileTexts.get(f.id) ?? "";
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
    throw new Error(`Unexpected table ${table}`);
  }
}

const mockDb = new MockDb();

// Test symbol-driven query
const resultA = await retrieveGroundedContext(mockDb as unknown as Db, "test_analysis", "How does validateSession verify users?");
if (!resultA.insufficientEvidence && resultA.windows.length > 0) {
  pass("symbol query retrieves candidate windows");
} else {
  fail("symbol query returned no evidence");
}

const authWin = resultA.windows.find((w) => w.path.includes("session.ts"));
if (authWin && authWin.reason.includes("validateSession")) {
  pass("matched window contains expected symbol validation reason");
} else {
  fail(`symbol window missing: ${JSON.stringify(resultA.windows)}`);
}

// Test route-driven query + 1-hop graph expansion
const resultB = await retrieveGroundedContext(mockDb as unknown as Db, "test_analysis", "Explain the login endpoint POST /api/login");
if (resultB.windows.some((w) => w.path.includes("login.ts"))) {
  pass("route query identifies seed file login.ts");
} else {
  fail("route query failed to identify login.ts");
}
if (resultB.windows.some((w) => w.path.includes("session.ts") && w.reason.includes("1-hop dependency"))) {
  pass("dependency graph expansion brings in imported session.ts");
} else {
  fail(`graph expansion failed: ${JSON.stringify(resultB.windows.map((w) => ({ path: w.path, reason: w.reason })))}`);
}

// Test insufficient evidence query
const resultC = await retrieveGroundedContext(mockDb as unknown as Db, "test_analysis", "Where is the billing stripe webhook processed?");
if (resultC.insufficientEvidence && resultC.windows.length === 0) {
  pass("query with no matching evidence sets insufficientEvidence: true");
} else {
  fail("expected insufficientEvidence for unrelated query");
}

// Test formatting context for prompt
const formatted = formatRetrievedContext(resultB);
if (formatted.includes("--- File: src/api/login.ts") && formatted.includes("line 1 of login.ts")) {
  pass("context formatted cleanly with file headers and line indicators");
} else {
  fail(`formatted context failed: ${formatted}`);
}

// Summary
console.log("");
for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
if (failed > 0) process.exit(1);
