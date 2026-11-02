// Targeted tests for the CI-4 STANDARD_PROJECT_FILES citation fix.
//
//   node scripts/test-citations-manifest.ts
//
// These exercises are standalone: they import only the citation module and a
// small synthetic harness, so they do not depend on the repo's database or LLM
// setup. They exist to demonstrate the invariant the reviewer asked for: a
// standard manifest path (package.json, tsconfig.json, ...) may pass bare-
// mention verification only when it was actually rendered into the current
// answer's packaging block AND it is stored; excluded/legacy manifests, absent
// manifests, and manifests never shown are rejected through this tier. Line-
// range citations to manifests still require source-line evidence like any other
// file, and the general stored-file allowlist is untouched.

import {
  verifyCitations,
  type FileEvidence,
  type CitationOptions,
  type ManifestFile,
  STANDARD_PROJECT_FILES,
} from "../lib/ai/citations.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

function manifest(
  path: string,
  status: ManifestFile["content_status"],
  analysis_id: string = "analysis-current",
  rendered: boolean = true,
): ManifestFile {
  return { path, content_status: status, analysis_id, rendered };
}

function rawManifest(
  path: string,
  status: ManifestFile["content_status"],
  analysis_id?: string,
  rendered?: boolean,
): ManifestFile {
  return {
    path,
    content_status: status,
    ...(analysis_id !== undefined ? { analysis_id } : {}),
    ...(rendered !== undefined ? { rendered } : {}),
  };
}

function manifestsByPath(...entries: ManifestFile[]): CitationOptions["manifestsByPath"] {
  const m = new Map<string, ManifestFile>();
  for (const e of entries) m.set(e.path, e);
  return m;
}

const MANIFEST_PATHS = [...STANDARD_PROJECT_FILES];

// ---- 1. A stored manifest not included in rendered evidence is rejected. ----
console.log("=== 1. Standard manifest absent from rendered evidence is rejected ===");
{
  const evidenceMap = new Map<string, FileEvidence>([
    ["src/app.ts", { lines: 40, contentHash: "hash" }],
  ]);

  // A stored manifest that was explicitly marked rendered: false
  const notRendered = verifyCitations(
    "The repo's entry point is `src/app.ts` and its manifest is `package.json`.",
    evidenceMap,
    {
      analysisId: "analysis-current",
      manifestsByPath: manifestsByPath(manifest("package.json", "stored", "analysis-current", false)),
    },
  );
  if (notRendered.paths.length === 1 && notRendered.paths[0] === "package.json") {
    pass("a stored manifest marked rendered: false is rejected");
  } else {
    fail(`manifest-not-rendered mismatch: ${JSON.stringify(notRendered.paths)}`);
  }

  // A stored manifest where rendered is undefined (Blocker #3)
  const renderedUndefined = verifyCitations(
    "The repo's entry point is `src/app.ts` and its manifest is `package.json`.",
    evidenceMap,
    {
      analysisId: "analysis-current",
      manifestsByPath: manifestsByPath(rawManifest("package.json", "stored", "analysis-current", undefined)),
    },
  );
  if (renderedUndefined.paths.length === 1 && renderedUndefined.paths[0] === "package.json") {
    pass("a stored manifest with rendered: undefined is strictly rejected");
  } else {
    fail(`rendered-undefined mismatch: ${JSON.stringify(renderedUndefined.paths)}`);
  }

  // manifestsByPath was supplied, but does not contain package.json (never rendered)
  const notInMap = verifyCitations(
    "The repo's entry point is `src/app.ts` and its manifest is `package.json`.",
    evidenceMap,
    {
      analysisId: "analysis-current",
      manifestsByPath: manifestsByPath(manifest("README.md", "stored")),
    },
  );
  if (notInMap.paths.length === 1 && notInMap.paths[0] === "package.json") {
    pass("a stored manifest omitted from manifestsByPath (not rendered) is rejected");
  } else {
    fail(`manifest-not-in-map mismatch: ${JSON.stringify(notInMap.paths)}`);
  }

  // No manifestsByPath at all -> same result. The filename alone is not enough.
  const noManifestTable = verifyCitations(
    "See `package.json` for the scripts.",
    evidenceMap,
    { analysisId: "analysis-current", manifestsByPath: undefined as CitationOptions["manifestsByPath"] },
  );
  if (noManifestTable.paths.length === 1 && noManifestTable.paths[0] === "package.json") {
    pass("bare package.json with no manifest table is rejected");
  } else {
    fail(`no-manifest-table mismatch: ${JSON.stringify(noManifestTable.paths)}`);
  }
}

// ---- 2. A standard manifest actually rendered and stored is accepted. ----
console.log("=== 2. Rendered, stored manifest is accepted ===");
{
  const evidenceMap = new Map<string, FileEvidence>([
    ["src/app.ts", { lines: 40, contentHash: "hash" }],
  ]);
  const pkgOk = verifyCitations(
    "The repo's manifest is `package.json` and the app lives in `src/app.ts`.",
    evidenceMap,
    {
      analysisId: "analysis-current",
      manifestsByPath: manifestsByPath(manifest("package.json", "stored")),
    },
  );
  if (pkgOk.paths.length === 0) pass("bare package.json passes when it was rendered and stored");
  else fail(`rendered-stored manifest flagged: ${JSON.stringify(pkgOk.paths)}`);

  const readmeOk = verifyCitations(
    "Start with `README.md`.",
    evidenceMap,
    {
      analysisId: "analysis-current",
      manifestsByPath: manifestsByPath(manifest("README.md", "stored")),
    },
  );
  if (readmeOk.paths.length === 0) pass("bare README.md passes when rendered and stored");
  else fail(`rendered-readme flagged: ${JSON.stringify(readmeOk.paths)}`);
}

// ---- 3. Each standard path is grounded only when rendered. ----
console.log("=== 3. Each standard manifest name is grounded only when rendered ===");
{
  const evidenceMap = new Map<string, FileEvidence>([
    ["src/app.ts", { lines: 40, contentHash: "hash" }],
  ]);
  let anyFail = false;
  for (const name of MANIFEST_PATHS) {
    const sentence = "The repo declares `" + name + "`.";
    const ok = verifyCitations(
      sentence,
      evidenceMap,
      {
        analysisId: "analysis-current",
        manifestsByPath: manifestsByPath(manifest(name, "stored")),
      },
    );
    if (ok.paths.length === 0) pass(`bare ${name} accepted when rendered and stored`);
    else {
      fail(`bare ${name} should be accepted when rendered and stored: ${JSON.stringify(ok.paths)}`);
      anyFail = true;
    }
  }
  if (!anyFail) pass("all standard manifest names behave identically under the grounded rule");
}

// ---- 4. Excluded and legacy-unclassified manifests are rejected. ----
console.log("=== 4. Excluded/legacy manifests are rejected ===");
{
  const evidenceMap = new Map<string, FileEvidence>([
    ["src/app.ts", { lines: 40, contentHash: "hash" }],
  ]);
  const excluded = verifyCitations(
    "The manifest is `package.json`.",
    evidenceMap,
    {
      analysisId: "analysis-current",
      manifestsByPath: manifestsByPath(manifest("package.json", "excluded")),
    },
  );
  if (excluded.paths.length === 1 && excluded.paths[0] === "package.json") {
    pass("excluded manifest is rejected through the standard tier");
  } else {
    fail(`excluded manifest mismatch: ${JSON.stringify(excluded.paths)}`);
  }

  const legacy = verifyCitations(
    "The manifest is `package.json`.",
    evidenceMap,
    {
      analysisId: "analysis-current",
      manifestsByPath: manifestsByPath(manifest("package.json", "legacy_unclassified")),
    },
  );
  if (legacy.paths.length === 1 && legacy.paths[0] === "package.json") {
    pass("legacy-unclassified manifest is rejected through the standard tier");
  } else {
    fail(`legacy manifest mismatch: ${JSON.stringify(legacy.paths)}`);
  }
}

// ---- 5. Absent/unverified manifests are rejected. ----
console.log("=== 5. Absent/unverified manifests are rejected ===");
{
  const evidenceMap = new Map<string, FileEvidence>([
    ["src/app.ts", { lines: 40, contentHash: "hash" }],
  ]);
  const absent = verifyCitations(
    "The manifest is `package.json`.",
    evidenceMap,
    {
      analysisId: "analysis-current",
      manifestsByPath: manifestsByPath(manifest("package.json", "absent")),
    },
  );
  if (absent.paths.length === 1 && absent.paths[0] === "package.json") {
    pass("absent manifest is rejected through the standard tier");
  } else {
    fail(`absent manifest mismatch: ${JSON.stringify(absent.paths)}`);
  }

  // Unknown status (manifest table not read for this answer) is also rejected.
  const unknown = verifyCitations(
    "The manifest is `package.json`.",
    evidenceMap,
    {
      analysisId: "analysis-current",
      manifestsByPath: manifestsByPath(manifest("package.json", "unknown")),
    },
  );
  if (unknown.paths.length === 1 && unknown.paths[0] === "package.json") {
    pass("unknown-status manifest is rejected through the standard tier");
  } else {
    fail(`unknown-status manifest mismatch: ${JSON.stringify(unknown.paths)}`);
  }
}

// ---- 6. Missing manifest record is rejected. ----
console.log("=== 6. Missing manifest record is rejected ===");
{
  const evidenceMap = new Map<string, FileEvidence>([
    ["src/app.ts", { lines: 40, contentHash: "hash" }],
  ]);
  const missing = verifyCitations(
    "The manifest is `package.json`.",
    evidenceMap,
    {
      analysisId: "analysis-current",
      manifestsByPath: manifestsByPath(manifest("README.md", "stored")),
    },
  );
  if (missing.paths.length === 1 && missing.paths[0] === "package.json") {
    pass("missing manifest record is rejected");
  } else {
    fail(`missing manifest record mismatch: ${JSON.stringify(missing.paths)}`);
  }
}

// ---- 7. Manifest from another analysis is rejected. ----
console.log("=== 7. Manifest from another analysis is rejected ===");
{
  const evidenceMap = new Map<string, FileEvidence>([
    ["src/app.ts", { lines: 40, contentHash: "hash" }],
  ]);
  const foreignManifest = verifyCitations(
    "The manifest is `package.json`.",
    evidenceMap,
    {
      analysisId: "analysis-current",
      manifestsByPath: manifestsByPath(manifest("package.json", "stored", "analysis-other", true)),
    },
  );
  if (foreignManifest.paths.length === 1 && foreignManifest.paths[0] === "package.json") {
    pass("manifest from another analysis is rejected");
  } else {
    fail(`foreign manifest mismatch: ${JSON.stringify(foreignManifest.paths)}`);
  }

  const currentAnalysisManifest = verifyCitations(
    "The manifest is `package.json`.",
    evidenceMap,
    {
      analysisId: "analysis-current",
      manifestsByPath: manifestsByPath(manifest("package.json", "stored", "analysis-current", true)),
    },
  );
  if (currentAnalysisManifest.paths.length === 0) {
    pass("manifest from current analysis is accepted");
  } else {
    fail(`current manifest flagged: ${JSON.stringify(currentAnalysisManifest.paths)}`);
  }
}

// ---- 8. Line-range citation to a manifest without source-line evidence is rejected. ----
console.log("=== 8. Line-range citation to a manifest without source-line evidence is rejected ===");
{
  const evidenceMap = new Map<string, FileEvidence>([
    ["src/app.ts", { lines: 40, contentHash: "hash" }],
  ]);
  const ranged = verifyCitations(
    "See `package.json#L1-L10`.",
    evidenceMap,
    {
      analysisId: "analysis-current",
      manifestsByPath: manifestsByPath(manifest("package.json", "stored")),
    },
  );
  if (
    ranged.paths.length === 1 &&
    ranged.paths[0] === "package.json#L1-L10" &&
    ranged.details?.some((d) => d.includes("is not in retrieved evidence"))
  ) {
    pass("line-range citation to a manifest without source-line evidence is rejected");
  } else {
    fail(`line-range manifest mismatch: ${JSON.stringify(ranged.paths)} ${JSON.stringify(ranged.details)}`);
  }

  // A line-range citation to a stored code file still works as before.
  const rangedOk = verifyCitations(
    "See `src/app.ts#L1-L10`.",
    evidenceMap,
    {
      analysisId: "analysis-current",
      manifestsByPath: manifestsByPath(manifest("package.json", "stored")),
    },
  );
  if (rangedOk.paths.length === 0) pass("line-range citation to a stored code file still passes");
  else fail(`line-range code file flagged: ${JSON.stringify(rangedOk.paths)}`);
}

// ---- 9. The general stored-file allowlist is untouched. ----
console.log("=== 9. General stored-file allowlist still works ===");
{
  const evidenceMap = new Map<string, FileEvidence>([
    ["src/app.ts", { lines: 40, contentHash: "hash" }],
  ]);
  const allAnalysisFiles = new Set(["src/app.ts", "src/lib.ts"]);
  const ok = verifyCitations(
    "See `src/lib.ts`.",
    evidenceMap,
    { allAnalysisFiles, manifestsByPath: manifestsByPath(manifest("package.json", "stored")) },
  );
  if (ok.paths.length === 0) pass("general allowlist still accepts a stored file retrieval missed");
  else fail(`general allowlist broken: ${JSON.stringify(ok.paths)}`);

  const stillRejects = verifyCitations(
    "See `src/missing.ts`.",
    evidenceMap,
    { allAnalysisFiles, manifestsByPath: manifestsByPath(manifest("package.json", "stored")) },
  );
  if (stillRejects.paths.length === 1 && stillRejects.paths[0] === "src/missing.ts") {
    pass("general allowlist still rejects a file not in evidence or allowlist");
  } else {
    fail(`general allowlist rejection broken: ${JSON.stringify(stillRejects.paths)}`);
  }
}

// ---- 10. Explain-file/folder contexts reject bare manifest mentions without authorized evidence. ----
console.log("=== 10. Explain-file/folder contexts reject unauthorized manifests ===");
{
  const evidenceMap = new Map<string, FileEvidence>([
    ["src/app.ts", { lines: 40, contentHash: "hash" }],
  ]);
  const explainOk = verifyCitations(
    "The function is in `src/app.ts`.",
    evidenceMap,
    { manifestsByPath: undefined },
  );
  if (explainOk.paths.length === 0) pass("explain-file context without manifests accepts valid code path");
  else fail(`explain-file context flagged: ${JSON.stringify(explainOk.paths)}`);

  const explainRejected = verifyCitations(
    "The function is in `src/app.ts` and declares `package.json`.",
    evidenceMap,
    { manifestsByPath: undefined },
  );
  if (explainRejected.paths.length === 1 && explainRejected.paths[0] === "package.json") {
    pass("explain-file bare manifest mention without authorized manifest evidence is rejected");
  } else {
    fail(`explain-file manifest leak: ${JSON.stringify(explainRejected.paths)}`);
  }

  const folderOk = verifyCitations(
    "The code is in `src/lib.ts`.",
    new Map<string, FileEvidence>([
      ["src/lib.ts", { lines: 40, contentHash: "hash-lib" }],
    ]),
    { manifestsByPath: undefined },
  );
  if (folderOk.paths.length === 0) pass("explain-folder context without manifests accepts valid code path");
  else fail(`explain-folder context flagged: ${JSON.stringify(folderOk.paths)}`);

  const folderRejected = verifyCitations(
    "The code is in `src/lib.ts` and declares `package.json`.",
    new Map<string, FileEvidence>([
      ["src/lib.ts", { lines: 40, contentHash: "hash-lib" }],
    ]),
    { manifestsByPath: undefined },
  );
  if (folderRejected.paths.length === 1 && folderRejected.paths[0] === "package.json") {
    pass("explain-folder bare manifest mention without authorized manifest evidence is rejected");
  } else {
    fail(`explain-folder manifest leak: ${JSON.stringify(folderRejected.paths)}`);
  }

  // But if a manifest block were rendered, it is honored exactly like Q&A.
  const folderWithManifest = verifyCitations(
    "The code is in `src/lib.ts` and the manifest is `package.json`.",
    new Map<string, FileEvidence>([
      ["src/lib.ts", { lines: 40, contentHash: "hash-lib" }],
    ]),
    {
      analysisId: "analysis-current",
      manifestsByPath: manifestsByPath(manifest("package.json", "stored")),
    },
  );
  if (folderWithManifest.paths.length === 0) pass("explain-folder context with a rendered stored manifest accepts it");
  else fail(`explain-folder with manifest flagged: ${JSON.stringify(folderWithManifest.paths)}`);
}

console.log("");
for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
