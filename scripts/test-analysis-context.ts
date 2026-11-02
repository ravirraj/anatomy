/* eslint-disable @typescript-eslint/no-explicit-any */
// Exerciser for the CI-4 analysis-context helpers: `allowedAnalysisPaths`,
// `loadFileInput` targets, `loadFolderInput` folders and boundary edges.
//
//   node scripts/test-analysis-context.ts
//
// This file is deliberately NOT a unit test file — the repo's real `pnpm test`
// chain is written around Vitest and real Supabase clients, and this helper was
// written outside that toolchain. It is run directly with Node when the reviewer
// asks for it.

import { createHash } from "node:crypto";
import { allowedAnalysisPaths, loadFileInput, loadFolderInput } from "../lib/analysis/context.ts";
import type { Db } from "../lib/ai/retrieval.ts";
import { getFileLines } from "../lib/content/read.ts";
import type { BackfillDeps } from "../lib/content/read.ts";

type FileRow = {
  id: string;
  path: string;
  hash: string | null;
  exports: string[] | null;
  reached_by: string | null;
  skip_reason: string | null;
  content_status: string;
  file_roles: { role: string; source: string }[];
  analysis_id: string;
  organization_id: string;
  module?: string;
  fan_in?: number;
  fan_out?: number;
  analysis?: { commit_sha: string; project?: { repo_owner: string; repo_name: string } };
};

type EdgeRow = {
  id: string;
  kind: string;
  type_only: boolean;
  source_file_id: string;
  target_file_id: string;
  source_file?: FileRow;
  target_file?: FileRow;
  analysis_id: string;
  organization_id?: string;
};

const results: string[] = [];
const check = (ok: boolean, m: string, detail?: string) => {
  results.push((ok ? "ok   " : "FAIL ") + m + (detail ? ` — ${detail}` : ""));
};

const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

// ---- A fake in-memory database that speaks the Supabase client shape used by
// loadFileInput / loadFolderInput / allowedAnalysisPaths in the test harness. ----
class TestDb {
  files: FileRow[] = [];
  edges: EdgeRow[] = [];
  contents: Map<string, Buffer> = new Map();

  from(table: string) {
    if (table === "files") {
      return this.filesQuery();
    }
    if (table === "edges") {
      return this.edgesQuery();
    }
    if (table === "file_contents") {
      return this.fileContentsQuery();
    }
    throw new Error(`Unexpected table: ${table}`);
  }

  private filesQuery() {
    let selectedFiles = [...this.files];
    const updateTarget: { content_status?: string } = {};

    const builder: any = {
      select: (_cols?: string) => builder,
      update: (values: { content_status?: string }) => {
        Object.assign(updateTarget, values);
        return builder;
      },
      eq: (col: string, val: any) => {
        if (col === "analysis_id") {
          selectedFiles = selectedFiles.filter((f) => f.analysis_id === val);
        } else if (col === "path") {
          selectedFiles = selectedFiles.filter((f) => f.path === val);
        } else if (col === "id") {
          selectedFiles = selectedFiles.filter((f) => f.id === val);
        } else if (col === "content_status") {
          selectedFiles = selectedFiles.filter((f) => f.content_status === val);
        } else if (col === "organization_id") {
          selectedFiles = selectedFiles.filter((f) => f.organization_id === val);
        } else if (col === "hash") {
          selectedFiles = selectedFiles.filter((f) => f.hash === val);
        }
        return builder;
      },
      is: (col: string, val: any) => {
        if (col === "skip_reason" && val === null) {
          selectedFiles = selectedFiles.filter((f) => f.skip_reason === null);
        }
        return builder;
      },
      order: (_col: string) => builder,
      range: (from: number, to: number) => {
        const slice = selectedFiles.slice(from, to + 1);
        return Promise.resolve({ data: slice, error: null });
      },
      maybeSingle: async () => {
        const item = selectedFiles[0] ?? null;
        return { data: item, error: null };
      },
      single: async () => {
        const item = selectedFiles[0] ?? null;
        return { data: item, error: null };
      },
      then: (resolve: (val: any) => any, reject?: (err: any) => any) => {
        if (updateTarget.content_status) {
          for (const f of selectedFiles) {
            f.content_status = updateTarget.content_status;
            f.skip_reason = null;
          }
          return Promise.resolve({ data: selectedFiles.map((f) => ({ id: f.id })), error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: selectedFiles, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  private edgesQuery() {
    let selectedEdges = [...this.edges];

    const builder: any = {
      select: (_cols?: string) => builder,
      eq: (col: string, val: any) => {
        if (col === "analysis_id") {
          selectedEdges = selectedEdges.filter((e) => e.analysis_id === val);
        }
        return builder;
      },
      or: (filter: string) => {
        const match = filter.match(/source_file_id\.eq\.([^,]+),target_file_id\.eq\.(.+)/);
        if (match) {
          const [, src, tgt] = match;
          selectedEdges = selectedEdges.filter(
            (e) => e.source_file_id === src || e.target_file_id === tgt,
          );
        }
        return builder;
      },
      order: (_col: string) => builder,
      range: (from: number, to: number) => {
        const slice = selectedEdges.slice(from, to + 1).map((e) => {
          const src = this.files.find((f) => f.id === e.source_file_id);
          const tgt = this.files.find((f) => f.id === e.target_file_id);
          return {
            id: e.id,
            kind: e.kind,
            type_only: e.type_only,
            source_file_id: e.source_file_id,
            target_file_id: e.target_file_id,
            source: src
              ? { path: src.path, exports: src.exports, content_status: src.content_status, file_roles: src.file_roles }
              : null,
            target: tgt
              ? { path: tgt.path, exports: tgt.exports, content_status: tgt.content_status, file_roles: tgt.file_roles }
              : null,
          };
        });
        return Promise.resolve({ data: slice, error: null });
      },
      then: (resolve: (val: any) => any, reject?: (err: any) => any) => {
        return Promise.resolve({ data: selectedEdges, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  private fileContentsQuery() {
    let org = "";
    let hash = "";

    const builder: any = {
      select: (_cols?: string) => builder,
      eq: (col: string, val: string) => {
        if (col === "organization_id") org = val;
        if (col === "content_hash") hash = val;
        return builder;
      },
      maybeSingle: async () => {
        const bytes = this.contents.get(`${org}:${hash}`) ?? null;
        return {
          data: bytes ? { payload: new Uint8Array(bytes), size: bytes.length } : null,
          error: null,
        };
      },
    };
    return builder;
  }
}

function makeFile(id: string, path: string, status: string, hash?: string): FileRow {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  return {
    id,
    path,
    module: dir,
    fan_in: 0,
    fan_out: 0,
    hash: hash ?? createHash("sha256").update(path).digest("hex"),
    exports: ["testExport"],
    reached_by: null,
    skip_reason: null,
    content_status: status,
    file_roles: [],
    analysis_id: "a1",
    organization_id: "org1",
    analysis: { commit_sha: "sha", project: { repo_owner: "o", repo_name: "r" } },
  };
}

function makeEdge(id: string, from: string, to: string, kind = "import", type_only = false): EdgeRow {
  return {
    id,
    kind,
    type_only,
    source_file_id: from,
    target_file_id: to,
    analysis_id: "a1",
    organization_id: "org1",
  };
}

async function main() {
  const db = new TestDb();

  // Baseline analysis a1: three stored files, one excluded sibling, one
  // legacy-unclassified sibling, one absent sibling.
  const fApp = makeFile("f_app", "src/app.ts", "stored");
  fApp.fan_out = 2;
  const fLib = makeFile("f_lib", "src/lib.ts", "stored");
  fLib.fan_in = 1;
  fLib.reached_by = "src/app.ts";
  const fUtil = makeFile("f_util", "src/util.ts", "stored");
  fUtil.fan_in = 1;
  const fQuar = makeFile("f_quar", "src/quarantine/secret.ts", "excluded");
  const fLegacy = makeFile("f_legacy", "src/legacy/old.ts", "legacy_unclassified");
  const fAbsent = makeFile("f_absent", "src/absent.js", "absent");
  fAbsent.skip_reason = "not-parsed";
  fAbsent.exports = null;
  const absentBytes = Buffer.from("const absent = 1;\nconst rows = 2;");
  fAbsent.hash = createHash("sha256").update(absentBytes).digest("hex");
  db.contents.set(`org1:${fAbsent.hash}`, absentBytes);

  db.files.push(fApp, fLib, fUtil, fQuar, fLegacy, fAbsent);

  // Edges: app imports lib, app imports util, app imports quarantine (should be filtered),
  // app imports legacy (should be filtered).
  const eQuar = makeEdge("e_quar", "f_app", "f_quar", "import", false);
  const eLegacy = makeEdge("e_legacy", "f_app", "f_legacy", "import", false);
  const eLib = makeEdge("e_lib", "f_app", "f_lib", "import", false);
  const eUtil = makeEdge("e_util", "f_app", "f_util", "import", false);
  db.edges.push(eQuar, eLegacy, eLib, eUtil);

  // ---- 1. allowedAnalysisPaths ----
  console.log("=== 1. allowedAnalysisPaths scope ===");
  const allowlist = await allowedAnalysisPaths(db as unknown as Db, "a1");
  check(allowlist.has("src/app.ts"), "stored app path is in the allowlist");
  check(allowlist.has("src/lib.ts"), "stored lib path is in the allowlist");
  check(allowlist.has("src/util.ts"), "stored util path is in the allowlist");
  check(!allowlist.has("src/quarantine/secret.ts"), "excluded path is not in the allowlist");
  check(!allowlist.has("src/legacy/old.ts"), "legacy-unclassified path is not in the allowlist");
  check(!allowlist.has("src/absent.js"), "absent path is not in the allowlist");
  check(allowlist.size === 3, "allowlist has exactly the stored paths", `got ${Array.from(allowlist).join(", ")}`);

  // ---- 2. loadFileInput target gating ----
  console.log("=== 2. loadFileInput target gating ===");
  {
    const ok = await loadFileInput(db as unknown as Db, "a1", "src/app.ts");
    if (ok) pass("a stored target loads normally");
    else fail("a stored target should load");
  }
  {
    const threw = await loadFileInput(db as unknown as Db, "a1", "src/quarantine/secret.ts").then(
      () => false,
      () => true,
    );
    if (threw)
      pass("an excluded target throws before any cached explanation can be served");
    else fail("an excluded target should throw");
  }
  {
    const threw = await loadFileInput(db as unknown as Db, "a1", "src/legacy/old.ts").then(
      () => false,
      () => true,
    );
    if (threw)
      pass("a legacy-unclassified target throws before any cached explanation can be served");
    else fail("a legacy-unclassified target should throw");
  }
  {
    const threw = await loadFileInput(db as unknown as Db, "a1", "src/absent.js").then(
      () => false,
      () => true,
    );
    if (threw)
      pass("an absent target throws (nothing parsed to explain)");
    else fail("an absent target should throw");
  }

  // ---- 3. loadFileInput neighbours: quarantined neighbours cannot enter
  // imports/importedBy, so they cannot reach fileCitationsAllowed. ----
  console.log("=== 3. loadFileInput neighbour filtering ===");
  {
    const input = await loadFileInput(db as unknown as Db, "a1", "src/app.ts");
    check(input !== null, "app input loaded");
    if (input) {
      const importPaths = input.input.imports.map((n: { path: string }) => n.path);
      const importedByPaths = input.input.importedBy.map((n: { path: string }) => n.path);
      check(
        !importPaths.includes("src/quarantine/secret.ts"),
        "excluded neighbour is not in imports",
        `imports=${importPaths.join(", ")}`,
      );
      check(
        !importedByPaths.includes("src/quarantine/secret.ts"),
        "excluded neighbour is not in importedBy",
        `importedBy=${importedByPaths.join(", ")}`,
      );
      check(
        !importPaths.includes("src/legacy/old.ts"),
        "legacy-unclassified neighbour is not in imports",
        `imports=${importPaths.join(", ")}`,
      );
      check(
        importPaths.includes("src/lib.ts"),
        "stored neighbour still appears in imports",
        `imports=${importPaths.join(", ")}`,
      );
      check(
        importPaths.includes("src/util.ts"),
        "stored neighbour still appears in imports",
        `imports=${importPaths.join(", ")}`,
      );
    }
  }

  // ---- 4. loadFolderInput: excluded/legacy members and edge endpoints are
  // kept out of the folder model-facing metadata. ----
  console.log("=== 4. loadFolderInput folder + boundary filtering ===");
  {
    const folder = await loadFolderInput(db as unknown as Db, "a1", "src");
    check(folder !== null, "the src folder exists");
    if (folder) {
      const memberPaths = folder.files.map((f) => f.path);
      check(
        memberPaths.includes("src/app.ts"),
        "stored member is in the folder",
        `members=${memberPaths.join(", ")}`,
      );
      check(
        !memberPaths.includes("src/quarantine/secret.ts"),
        "excluded member is not in the folder",
        `members=${memberPaths.join(", ")}`,
      );
      check(
        !memberPaths.includes("src/legacy/old.ts"),
        "legacy-unclassified member is not in the folder",
        `members=${memberPaths.join(", ")}`,
      );
      check(
        !memberPaths.includes("src/absent.js"),
        "absent member is not in the folder (not parsed)",
        `members=${memberPaths.join(", ")}`,
      );

      const incoming = folder.incoming.map((e) => `${e.from} -> ${e.to}`);
      const outgoing = folder.outgoing.map((e) => `${e.from} -> ${e.to}`);
      check(
        !incoming.some((s) => s.includes("src/quarantine/secret.ts")),
        "excluded edge endpoint is not in incoming boundary",
        `incoming=${incoming.join("; ")}`,
      );
      check(
        !incoming.some((s) => s.includes("src/legacy/old.ts")),
        "legacy-unclassified edge endpoint is not in incoming boundary",
        `incoming=${incoming.join("; ")}`,
      );
      check(
        !outgoing.some((s) => s.includes("src/quarantine/secret.ts")),
        "excluded edge endpoint is not in outgoing boundary",
        `outgoing=${outgoing.join("; ")}`,
      );
      check(
        !outgoing.some((s) => s.includes("src/legacy/old.ts")),
        "legacy-unclassified edge endpoint is not in outgoing boundary",
        `outgoing=${outgoing.join("; ")}`,
      );
    }
  }

  // ---- 5. loadFolderInput still groups around the stored files and keeps
  // the eligible folder metadata intact. ----
  console.log("=== 5. loadFolderInput grouping intact ===");
  {
    const folder = await loadFolderInput(db as unknown as Db, "a1", "src");
    check(folder !== null, "the src folder still groups");
    if (folder) {
      check(folder.files.length === 3, "the folder has exactly the three eligible files", `members=${folder.files.map((f) => f.path).join(", ")}`);
      check(folder.incoming.length === 0, "no outside importers enter the folder", `incoming keys=${folder.incoming.map((e) => `${e.from} -> ${e.to}`).join(", ")}`);
      check(folder.outgoing.length === 0, "no internal edges cross the folder boundary to outside", `outgoing=${folder.outgoing.map((e) => `${e.from} -> ${e.to}`).join(", ")}`);
    }
  }

  // ---- 6. Unknown edge IDs still trigger the existing corruption behavior. ----
  console.log("=== 6. Unknown edge ids still corrupt ===");
  {
    const dbBad = new TestDb();
    dbBad.files.push(makeFile("f_only", "src/only.ts", "stored"));
    dbBad.files.push(makeFile("f_second", "src/second.ts", "stored"));
    dbBad.edges.push(makeEdge("e_bogus", "f_only", "f_missing"));
    let threw = false;
    try {
      await loadFolderInput(dbBad as unknown as Db, "a1", "src");
    } catch {
      threw = true;
    }
    if (threw) pass("an edge pointing at an unknown file still throws the existing corruption error");
    else fail("an unknown edge id should still throw");
  }

  // ---- 7. Stored and absent neighbour behavior is unchanged. ----
  console.log("=== 7. Stored and absent neighbour behavior unchanged ===");
  {
    const input = await loadFileInput(db as unknown as Db, "a1", "src/lib.ts");
    check(input !== null, "lib target loaded");
    if (input) {
      // lib has no incoming edges in this fixture; app reaches lib.
      check(input.input.reachedBy === "src/app.ts", "lib's reachedBy is the stored app file", `reachedBy=${input.input.reachedBy}`);
      check(input.input.imports.length === 0, "lib imports nothing in this fixture");
      check(input.input.importedBy.length === 1, "lib is imported by app", `importedBy=${input.input.importedBy.map((n: { path: string }) => n.path).join(", ")}`);
      check(input.input.importedBy[0].path === "src/app.ts", "lib's importer is the stored app file");
    }
  }

  // ---- 8. Absence is terminal until the authorized read service fills it. ----
  console.log("=== 8. Absence stays ineligible until the read service fills it ===");
  {
    const before = await allowedAnalysisPaths(db as unknown as Db, "a1");
    check(!before.has("src/absent.js"), "before the backfill the absent path is not generally citable", "absent path eligible too early");

    const deps: BackfillDeps = { writer: db as unknown as Db, fetchFile: neverFetch, cache: null };
    const lines = await getFileLines(db as unknown as Db, "f_absent", 1, 2, deps);
    check(lines === "const absent = 1;\nconst rows = 2;", "the verified absent read serves its lines", `absent read wrong: ${JSON.stringify(lines)}`);
    check(db.files.find((f) => f.id === "f_absent")!.content_status === "stored", "the read's own metadata update rounds the row to stored", "backfill flip missing");

    const after = await allowedAnalysisPaths(db as unknown as Db, "a1");
    check(after.has("src/absent.js"), "the same request's allowlist now includes the backfilled path", "backfilled path stayed ineligible");
    check(!after.has("src/quarantine/secret.ts") && !after.has("src/legacy/old.ts"), "the legacy-unclassified sibling remains ineligible", "sibling leaked into the allowlist");
  }

  console.log("");
  for (const line of results) console.log(line);
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

const neverFetch = () => {
  throw new Error("the fixture never backfills from GitHub");
};

main().catch((error) => {
  console.error("Test runner threw:", error);
  process.exit(1);
});
