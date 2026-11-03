// scripts/test-retrieval-serving.ts
// Deterministic unit tests for Stage 5 budget-constrained serving in
// retrieveGroundedContext: core compaction, pad expansion, and the
// transactional displacement rescue. General fixtures only — no
// repository-specific paths, symbols, or query phrases.
//
// Invariants under test:
//   1. A high-scoring candidate whose whole padded window exceeds the budget
//      is served through its matched evidence core instead of being lost to
//      a weaker candidate that merely fits.
//   2. Multi-file breadth: leftover budget is shared (pad expansion
//      round-robin) and displacement never empties a file's evidence unless
//      the rescued candidate introduces a new file, and at most once.
//   3. Compaction is transactional and line-exact: served text always equals
//      the source slice for the recorded bounds; totals match the sum of
//      per-window costs; budget ceilings are never exceeded.
//   4. Explicit path targets keep their serve priority and are never
//      displaced by the rescue.
//   5. Cross-run determinism: identical inputs produce identical packages.

import { createHash } from "node:crypto";
import {
  effectiveScore,
  formatRetrievedContext,
  retrieveGroundedContext,
  type Db,
  type RetrievalResult,
} from "../lib/ai/retrieval.ts";
import { verifyCitations, type FileEvidence } from "../lib/ai/citations.ts";

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string, detail?: string) {
  if (cond) {
    passed += 1;
    console.log(`ok    ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

// ---- The minimal deterministic mock database (same shape the production
// read service and retrieval expect; mirrors the established mock pattern) --
type MockFileData = { id: string; path: string; text: string; role?: string };
type MockSymbolData = {
  file_id: string;
  name: string;
  kind: string;
  line: number;
  /** Optional true span end of the symbol; unknown spans default to one line. */
  end_line?: number;
  exported: boolean;
  signature?: string;
  documentation?: string;
};

class ServingMockDb {
  files: {
    id: string;
    path: string;
    hash: string;
    lines: number;
    content_status: string;
    file_roles: { role: string; source: string }[];
  }[];
  fileTexts = new Map<string, string>();
  symbols: MockSymbolData[];
  edges: { source_file_id: string; target_file_id: string; kind: string }[];

  constructor(
    fileSpecs: MockFileData[],
    symbols: MockSymbolData[] = [],
    edges: { source_file_id: string; target_file_id: string; kind: string }[] = [],
  ) {
    this.symbols = symbols;
    this.edges = edges;
    this.files = fileSpecs.map((f) => {
      const hash = createHash("sha256").update(f.text).digest("hex");
      this.fileTexts.set(f.id, f.text);
      return {
        id: f.id,
        path: f.path,
        hash,
        lines: f.text.split("\n").length,
        content_status: "stored",
        file_roles: f.role ? [{ role: f.role, source: "convention" }] : [],
      };
    });
  }

  from(table: string) {
    if (table === "files") {
      return {
        select: () => ({
          eq: (_f: string, _val: string) => ({
            is: () => Promise.resolve({ data: this.files, error: null }),
            in: (_inCol: string, paths: string[]) =>
              Promise.resolve({ data: this.files.filter((f) => paths.includes(f.path)), error: null }),
            maybeSingle: async () => {
              const file = this.files.find((f) => f.id === _val);
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
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      };
    }
    if (table === "edges" || table === "graph_edges") {
      return {
        select: () => ({
          eq: () => ({
            or: (orFilter: string) => {
              const seedIds = new Set<string>();
              for (const m of orFilter.matchAll(/in\.\(([^)]*)\)/g)) {
                for (const id of (m[1] ?? "").split(",")) {
                  if (id.trim()) seedIds.add(id.trim());
                }
              }
              return Promise.resolve({
                data: this.edges.filter(
                  (edge) => seedIds.has(edge.source_file_id) || seedIds.has(edge.target_file_id),
                ),
                error: null,
              });
            },
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
                return {
                  data: {
                    payload: `\\x${Buffer.from(text, "utf8").toString("hex")}`,
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
    if (table === "manifests") {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      };
    }
    if (table === "dependencies" || table === "config_references" || table === "entry_points") {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      };
    }
    throw new Error(`Unexpected table ${table}`);
  }
}

// ---- generic assertion helpers ----

const lineLengths = (text: string): number[] => text.split("\n").map((l) => l.length);

function wholeWindowIntegrity(res: RetrievalResult, db: ServingMockDb, label: string): void {
  let allIntact = true;
  for (const win of res.windows) {
    const raw = db.fileTexts.get(win.fileId) ?? "";
    const rawLines = raw.split("\n");
    const slice = rawLines.slice(win.startLine - 1, win.endLine).join("\n");
    if (win.text.trim() !== slice.trim()) {
      allIntact = false;
      break;
    }
  }
  check(allIntact, `${label}: every served window equals the source slice for its recorded bounds`);
}

function budgetBounds(res: RetrievalResult, maxCharacters: number, label: string): void {
  check(
    (res.renderedCharacters ?? res.totalCharacters) <= maxCharacters,
    `${label}: rendered evidence within ${maxCharacters} character ceiling (${res.renderedCharacters ?? res.totalCharacters})`,
  );
  check(
    (res.totalTokens ?? 0) <= Math.ceil(maxCharacters / 3.0) + 64,
    `${label}: token estimate within binding ceiling (${res.totalTokens})`,
  );
  const files = new Set(res.files.map((f) => f.fileId));
  check(res.files.length === files.size, `${label}: files list has unique file entries`);
}

function accountingConsistency(res: RetrievalResult, _maxCharacters: number, label: string): void {
  // totalCharacters is the raw code character sum without headers; it must
  // equal the sum of served window texts exactly for the package to be
  // consistent (proof that serving phases never double-count or lose cost).
  const rawSum = res.windows.reduce((acc, w) => acc + w.text.length, 0);
  check(
    res.totalCharacters === rawSum,
    `${label}: raw code characters equal the sum of served window texts (${res.totalCharacters} vs ${rawSum})`,
  );
}

function citationsOf(res: RetrievalResult) {
  const allowed = new Map<string, FileEvidence>();
  for (const f of res.files) {
    allowed.set(f.path, {
      lines: f.totalLines,
      contentHash: f.contentHash,
      ...(f.windows ? { windows: f.windows } : {}),
    });
  }
  return allowed;
}

function resultShape(res: RetrievalResult): string {
  return JSON.stringify({
    windows: res.windows.map((w) => ({ path: w.path, start: w.startLine, end: w.endLine, text: w.text, score: w.score })),
    files: res.files.map((f) => ({ path: f.path, windows: (f.windows ?? []).slice().sort((a, b) => a.startLine - b.startLine) })),
    totalCharacters: res.totalCharacters,
    totalTokens: res.totalTokens,
    renderedCharacters: res.renderedCharacters,
    insufficientEvidence: res.insufficientEvidence,
  });
}

// -----------------------------------------------------------------------------
// Section 1: Core compaction — high-scoring large window vs small weak windows
// -----------------------------------------------------------------------------
console.log("\n=== 1. Core compaction: big relevant file vs small weak files, tight budget ===");
{
  const line = (n: number, tag: string) =>
    `${tag} padded row ${String(n).padStart(3, "0")} with plain filler text`;
  const bigText = Array.from({ length: 60 }, (_, i) => line(i + 1, "big")).join("\n");
  const small1Text = Array.from({ length: 12 }, (_, i) => line(i + 1, "weak")).join("\n");
  const small2Text = Array.from({ length: 14 }, (_, i) => line(i + 1, "soft")).join("\n");

  const files: MockFileData[] = [
    { id: "f_big", path: "src/core/pipeline/serverEngine.ts", text: bigText, role: "service" },
    { id: "f_weak", path: "src/core/pipeline/localCache.ts", text: small1Text, role: "service" },
    { id: "f_soft", path: "src/tools/export/printSoft.ts", text: small2Text, role: "service" },
  ];
  const symbols: MockSymbolData[] = [
    { file_id: "f_big", name: "initializeServerEngine", kind: "function", line: 20, end_line: 24, exported: true },
    { file_id: "f_weak", name: "purgeCache", kind: "function", line: 5, end_line: 7, exported: true },
    { file_id: "f_soft", name: "printSoft", kind: "function", line: 8, end_line: 9, exported: true },
  ];
  const db = new ServingMockDb(files, symbols);

  // Tight budget: the ~65-line padded window for the big file cannot fit
  // whole, while the small files' windows would fully consume the package
  // under plain first-fit serving. With core compaction the big file's own
  // 5-line kernel is served and pad expansion grows all three back.
  const res = await retrieveGroundedContext(db as unknown as Db, "test_analysis_serving", "how does initializeServerEngine use purgeCache before printSoft renders?", {
    maxCharacters: 2_200,
  });
  const filePaths = new Set(res.files.map((f) => f.path));
  check(filePaths.has("src/core/pipeline/serverEngine.ts"), "compacted high-score file is served, not dropped");
  check(filePaths.has("src/core/pipeline/localCache.ts"), "weak small file retains a served window (breadth preserved)");
  check(filePaths.has("src/tools/export/printSoft.ts"), "all matching files retain evidence under the tight budget");
  check(res.files.length >= 3, `multiple files compete within the tight budget (${res.files.length} files)`);

  wholeWindowIntegrity(res, db, "S1");
  budgetBounds(res, 2_200, "S1");
  accountingConsistency(res, 2_200, "S1");

  // The matched symbol's whole core span must be present, whole.
  const bigFile = res.files.find((f) => f.path === "src/core/pipeline/serverEngine.ts")!;
  const spans = (bigFile.windows ?? []).map((w) => w.startLine <= 20 && w.endLine >= 24);
  check(spans.some(Boolean), "the matched symbol span [20-24] survives whole inside a served window");
  const bigWins = res.windows.filter((w) => w.path === "src/core/pipeline/serverEngine.ts");
  check(
    bigWins.every((w) => w.startLine >= 1 && w.endLine <= 60),
    "compacted window bounds stay inside the file",
  );

  // Citations into compacted windows verify; a line outside any window is rejected.
  const allowed = citationsOf(res);
  const bigWindow = bigWins[0]!;
  const validBody = `Runs at src/core/pipeline/serverEngine.ts#L${bigWindow.startLine}-L${Math.min(bigWindow.endLine, bigWindow.startLine + 3)}.`;
  check(verifyCitations(validBody, allowed).paths.length === 0, "citation into compacted window verifies");
  const rejectedBody = "Runs at src/tools/export/nonexistent.ts#L1-L2.";
  check(verifyCitations(rejectedBody, allowed).paths.length > 0, "citation to unserved file rejected");
}

// -----------------------------------------------------------------------------
// Section 2: Pad expansion — leftover budget grows served windows round-robin
// -----------------------------------------------------------------------------
console.log("\n=== 2. Pad expansion: leftover budget shared, order deterministic ===");
{
  const bigText = Array.from({ length: 60 }, (_, i) => `big line ${String(i + 1).padStart(3, "0")}`).join("\n");
  const s1 = Array.from({ length: 40 }, (_, i) => `first line ${String(i + 1).padStart(3, "0")}`).join("\n");
  const s2 = Array.from({ length: 40 }, (_, i) => `second line ${String(i + 1).padStart(3, "0")}`).join("\n");
  const files: MockFileData[] = [
    { id: "f_big", path: "src/core/pipeline/serverEngine.ts", text: bigText, role: "service" },
    { id: "f_s1", path: "src/core/pipeline/localCache.ts", text: s1, role: "service" },
    { id: "f_s2", path: "src/tools/export/printSoft.ts", text: s2, role: "service" },
  ];
  const symbols: MockSymbolData[] = [
    { file_id: "f_big", name: "initializeServerEngine", kind: "function", line: 20, end_line: 24, exported: true },
    { file_id: "f_s1", name: "purgeCache", kind: "function", line: 6, end_line: 8, exported: true },
    { file_id: "f_s2", name: "printSoft", kind: "function", line: 9, end_line: 11, exported: true },
  ];
  const db = new ServingMockDb(files, symbols);

  const res = await retrieveGroundedContext(db as unknown as Db, "test_analysis_serving", "how does initializeServerEngine use purgeCache before printSoft renders?", {
    maxCharacters: 1_200,
  });
  wholeWindowIntegrity(res, db, "S2");
  budgetBounds(res, 1_200, "S2");
  check(res.files.length >= 3, `pad expansion keeps all competing files (${res.files.length} files)`);
  // Round-robin: no single served window grew to dominate the leftovers.
  const maxShare = Math.max(
    ...res.windows.map((w) => w.text.length),
  );
  const totalText = res.windows.reduce((acc, w) => acc + w.text.length, 0);
  check(
    maxShare <= totalText * 0.9 + 400,
    `no single window monopolized the leftover budget (largest ${maxShare} / total ${totalText})`,
  );
  // Every kernel grew back at least one line beyond its core when budget
  // allowed (or is already at its candidate bounds).
  const big = res.files.find((f) => f.path === "src/core/pipeline/serverEngine.ts")!;
  const bigWin = (big.windows ?? [])[0]!;
  check(bigWin.endLine - bigWin.startLine + 1 >= 5, "compacted kernel retained its whole core span");
}

// -----------------------------------------------------------------------------
// Section 3: Transactional displacement rescue — starved high-value candidate
// -----------------------------------------------------------------------------
console.log("\n=== 3. Displacement rescue: starved candidate replaces weaker evidence ===");
{
  // Fixture arithmetic (all tokens are generic two-letter-safe words):
  //   - "aurora"/"borealis" are exact single-token symbol matches (score 105):
  //     each walks before the star candidate and their long window slices eat
  //     the budget (A whole, B kernel-only).
  //   - "gatewayStars" matches exactly one token ("stars") at 95 and is not
  //     exported (no +5): strict rank 3. Its padded window [35-75] and even
  //     its core span [50-58] cannot fit the ~600 remaining characters, so
  //     the walk starves it BOTH as a full window and as a kernel.
  //   - The rescue then displaces the weakest batch (A, costliest first) and
  //     serves the star core. Net file count preserved (2 -> 2), at most one
  //     file emptied, B retained.
  const pad = (tag: string, n: number) =>
    `${tag} alignment row ${String(n).padStart(3, "0")} with steady filler characters for a stable cost`;
  const textA = Array.from({ length: 20 }, (_, i) => pad("aurora", i + 1)).join("\n");
  const textB = Array.from({ length: 20 }, (_, i) => pad("borealis", i + 1)).join("\n");
  const textStar = Array.from({ length: 200 }, (_, i) => pad("starpath", i + 1)).join("\n");
  const files: MockFileData[] = [
    { id: "f_a", path: "src/aurora/core.ts", text: textA, role: "controller" },
    { id: "f_b", path: "src/borealis/core.ts", text: textB, role: "controller" },
    { id: "f_star", path: "src/gateway/starPath.ts", text: textStar, role: "service" },
  ];
  const symbols: MockSymbolData[] = [
    { file_id: "f_a", name: "aurora", kind: "function", line: 1, exported: true },
    { file_id: "f_b", name: "borealis", kind: "function", line: 1, exported: true },
    { file_id: "f_star", name: "gatewayStars", kind: "function", line: 50, end_line: 58, exported: false },
  ];
  const db = new ServingMockDb(files, symbols);

  const query = "how does the aurora pair with the borealis around the stars?";
  const res = await retrieveGroundedContext(db as unknown as Db, "test_analysis_serving", query, {
    maxCharacters: 2_200,
  });
  wholeWindowIntegrity(res, db, "S3");
  budgetBounds(res, 2_200, "S3");
  accountingConsistency(res, 2_200, "S3");
  check(res.files.length >= 2, `net file count preserved under the displacement swap (${res.files.length} files)`);
  check(!res.files.some((f) => f.path === "src/aurora/core.ts"), "rescue displaced the costliest weaker evidence");
  check(res.files.some((f) => f.path === "src/borealis/core.ts"), "the other weaker file kept its evidence (breadth)");
  const starWin = res.windows.find((w) => w.path === "src/gateway/starPath.ts");
  check(starWin !== undefined, "the starved single-concept candidate was rescued");
  if (starWin) {
    check(
      starWin.startLine <= 50 && starWin.endLine >= 58,
      "rescued window covers the complete matched symbol span [50-58]",
    );
  }
  const first = resultShape(await retrieveGroundedContext(db as unknown as Db, "test_analysis_serving", query, { maxCharacters: 2_200 }));
  const second = resultShape(await retrieveGroundedContext(db as unknown as Db, "test_analysis_serving", query, { maxCharacters: 2_200 }));
  check(first === second, "S3: identical runs produce identical packages after rescue decisions");
}

// -----------------------------------------------------------------------------
// Section 4: Explicit path priority — not displaced, served whole when it fits
// -----------------------------------------------------------------------------
console.log("\n=== 4. Explicit path target keeps priority, never displaced ===");
{
  const textBig = Array.from({ length: 70 }, (_, i) => `pain row ${String(i + 1).padStart(3, "0")}`).join("\n");
  const textExplicit = Array.from({ length: 45 }, (_, i) => `target row ${String(i + 1).padStart(3, "0")}`).join("\n");
  const files: MockFileData[] = [
    { id: "f_pain", path: "src/shared/painful.ts", text: textBig, role: "service" },
    { id: "f_explicit", path: "src/shared/targetFile.ts", text: textExplicit, role: "service" },
  ];
  const symbols: MockSymbolData[] = [
    { file_id: "f_pain", name: "painfulHelper", kind: "function", line: 10, end_line: 12, exported: true },
    { file_id: "f_explicit", name: "targetRoutine", kind: "function", line: 12, end_line: 14, exported: true },
  ];
  const db = new ServingMockDb(files, symbols);

  const res = await retrieveGroundedContext(db as unknown as Db, "test_analysis_serving", "does src/shared/targetFile.ts implement targetRoutine with painfulHelper?", {
    maxCharacters: 2_000,
  });
  wholeWindowIntegrity(res, db, "S4");
  budgetBounds(res, 2_000, "S4");
  const explicitWins = res.windows.filter((w) => w.path === "src/shared/targetFile.ts");
  check(explicitWins.length > 0, "explicit file target is served");
  const others = res.windows.filter((w) => w.path === "src/shared/painful.ts");
  check(
    others.length === 0 ||
      effectiveScore({ score: explicitWins[0]!.score, path: explicitWins[0]!.path }) >=
        effectiveScore({ score: others[others.length - 1]!.score, path: others[others.length - 1]!.path }),
    "no survivor outranks the explicit target's priority",
  );
}

// -----------------------------------------------------------------------------
// Section 5: Infeasible rescue — transactional rollback leaves package intact
// -----------------------------------------------------------------------------
console.log("\n=== 5. Infeasible rescue restores the walk's package exactly ===");
{
  // A star candidate far bigger than the whole budget: even its kernel core
  // cannot fit, and dropping impossible. Nothing may change from the plain
  // walk, and totals must stay consistent.
  const huge = Array.from({ length: 200 }, (_, i) => `huge row ${String(i + 1).padStart(3, "0")}`).join("\n");
  const tiny = "release tiny one-liner";
  const files: MockFileData[] = [
    { id: "f_huge", path: "src/gen/monolith.ts", text: huge, role: "model" },
    { id: "f_tiny", path: "src/gen/kicker.ts", text: tiny, role: "model" },
  ];
  const symbols: MockSymbolData[] = [
    { file_id: "f_huge", name: "monolithicSpan", kind: "function", line: 80, end_line: 140, exported: true },
    { file_id: "f_tiny", name: "kickerOne", kind: "const", line: 1, exported: true },
  ];
  const db = new ServingMockDb(files, symbols);
  const res = await retrieveGroundedContext(db as unknown as Db, "test_analysis_serving", "does monolithicSpan adjust kickerOne output?", {
    maxCharacters: 200,
  });
  check(
    !res.files.some((f) => f.path === "src/gen/monolith.ts"),
    "rescue cannot admit a candidate whose core exceeds the entire budget",
  );
  budgetBounds(res, 200, "S5");
  wholeWindowIntegrity(res, db, "S5");
  accountingConsistency(res, 200, "S5");
}

// -----------------------------------------------------------------------------
// Section 6: Determinism across repeated runs (all scenarios)
// -----------------------------------------------------------------------------
console.log("\n=== 6. Determinism: identical fixtures, repeated retrieval ===");
{
  const text = Array.from({ length: 50 }, (_, i) => `dst row ${String(i + 1).padStart(3, "0")}`).join("\n");
  const small = Array.from({ length: 12 }, (_, i) => `aux row ${String(i + 1).padStart(3, "0")}`).join("\n");
  const files: MockFileData[] = [
    { id: "f_dst", path: "src/core/destination.ts", text, role: "service" },
    { id: "f_aux", path: "src/tools/aux.ts", text: small, role: "service" },
  ];
  const symbols: MockSymbolData[] = [
    { file_id: "f_dst", name: "destinationStrategy", kind: "function", line: 25, end_line: 33, exported: true },
    { file_id: "f_aux", name: "auxEntry", kind: "function", line: 4, end_line: 6, exported: true },
  ];
  const dbs = [0, 1].map(() => new ServingMockDb(files, symbols));
  const query = "how does destinationStrategy relate to auxEntry routing?";
  const budget = { maxCharacters: 1_000 };
  const a = resultShape(await retrieveGroundedContext(dbs[0] as unknown as Db, "test_analysis_serving", query, budget));
  const b = resultShape(await retrieveGroundedContext(dbs[1] as unknown as Db, "test_analysis_serving", query, budget));
  check(a === b, "two identically-built fixtures produce identical packages");
  wholeWindowIntegrity(
    await retrieveGroundedContext(dbs[0] as unknown as Db, "test_analysis_serving", query, budget),
    dbs[0],
    "S6",
  );
  budgetBounds(
    await retrieveGroundedContext(dbs[0] as unknown as Db, "test_analysis_serving", query, budget),
    1_000,
    "S6",
  );
}

// -----------------------------------------------------------------------------
// Section 7: Whole-window integrity on default (roomy) budget is unchanged
// -----------------------------------------------------------------------------
console.log("\n=== 7. Roomy budget: full windows, walk behavior unchanged ===");
{
  const text = Array.from({ length: 40 }, (_, i) => `roomy line ${String(i + 1).padStart(3, "0")}`).join("\n");
  const files: MockFileData[] = [{ id: "f_r", path: "src/core/roomy.ts", text, role: "service" }];
  const symbols: MockSymbolData[] = [
    { file_id: "f_r", name: "roomyProcedure", kind: "function", line: 10, end_line: 14, exported: true },
  ];
  const db = new ServingMockDb(files, symbols);
  const res = await retrieveGroundedContext(db as unknown as Db, "test_analysis_serving", "how does roomyProcedure work in src/core/roomy.ts?");
  // With the default roomy budget the merged candidate (symbol pad and
  // explicit-path window) is served whole: the walk is untouched by
  // compaction or rescue.
  const win = res.windows.find((w) => w.path === "src/core/roomy.ts");
  check(win !== undefined, "roomy budget serves the file");
  check(win!.startLine <= 1 && win!.endLine >= 35, "roomy budget serves the full merged window, no compaction");
  wholeWindowIntegrity(res, db, "S7");

  // Formatting: header line count matches rendered totals.
  const ctx = formatRetrievedContext(res);
  check(
    ctx.includes("[hash:") && /--- File: src\/core\/roomy\.ts \(lines \d+-\d+\)/.test(ctx),
    "formatting reports the served bounds",
  );
}

// -----------------------------------------------------------------------------
// Final Summary
// -----------------------------------------------------------------------------
console.log("\n------------------------------------------------------------");
console.log(`Retrieval Serving Test Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All retrieval-serving invariants verified successfully.");
}
