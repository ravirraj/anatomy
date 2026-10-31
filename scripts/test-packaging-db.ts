// Live database checks for the Phase 4 tables.
//
// These run against the real project and assert the properties the migration
// claims: organization isolation, the manifest→dependency foreign key, the
// resolved/unresolved invariant, and the absence of any column that could
// hold a configuration value.
//
// The tables only exist once 20261103000000_repo_metadata.sql has been
// applied. When they are absent this exits with a clear message and a non-zero
// code rather than passing quietly — a test that cannot run is not a test that
// passed.

import { createAdminSupabase } from "../lib/supabase/admin.ts";

const db = createAdminSupabase();

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`ok    ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- Precondition -----------------------------------------------------------

const probe = await db.from("manifests").select("id").limit(1);
if (probe.error) {
  console.error(
    `The Phase 4 tables are not present in this database: ${probe.error.message}\n` +
      `Apply the migration first: npx supabase db push\n` +
      `(pending: 20261030060000, 20261030070000, 20261101000000, 20261102000000, 20261103000000)`,
  );
  process.exit(1);
}

// --- Fixtures ---------------------------------------------------------------

const suffix = `phase4-${Date.now()}`;
const orgA = `${suffix}-a`;
const orgB = `${suffix}-b`;

async function cleanup(): Promise<void> {
  for (const org of [orgA, orgB]) {
    await db.from("organizations").delete().eq("id", org);
  }
}

await cleanup();

for (const org of [orgA, orgB]) {
  const { error } = await db.from("organizations").insert({ id: org });
  if (error) {
    console.error(`Could not create test organization ${org}: ${error.message}`);
    process.exit(1);
  }
}

async function makeAnalysis(org: string, label: string): Promise<string> {
  const { data: project, error: projectError } = await db
    .from("projects")
    .insert({ organization_id: org, repo_owner: "fixture", repo_name: `${label}-repo` })
    .select("id")
    .single();
  if (projectError || !project) throw new Error(`project: ${projectError?.message}`);

  const { data: analysis, error } = await db
    .from("analyses")
    .insert({
      organization_id: org,
      project_id: project.id,
      status: "complete",
      // A complete row must name the stage it finished in and when it started:
      // the schema ties 'queued' to a null stage and a null start time, so a
      // row that has left 'queued' must carry both.
      stage: "store",
      started_at: new Date().toISOString(),
      schema_version: 7,
      commit_sha: "0".repeat(40),
      // A complete analysis must carry its coverage, its projects and a finish
      // time: the schema refuses a "complete" row without them, and rightly so.
      finished_at: new Date().toISOString(),
      coverage: { files: { seen: 0, internal: 0, external: 0, excluded: 0, unresolved: 0 } },
      detected_projects: [{ path: ".", adapter: "none" }],
    })
    .select("id")
    .single();
  if (error || !analysis) throw new Error(`analysis: ${error?.message}`);
  return analysis.id;
}

const analysisA = await makeAnalysis(orgA, "a");
const analysisB = await makeAnalysis(orgB, "b");

// --- Manifests and dependencies --------------------------------------------

console.log("=== 1. Manifests and dependencies ===");

const manifestPayload = [
  {
    path: "package.json",
    dir: ".",
    project: ".",
    ecosystem: "npm",
    name: "fixture",
    workspaces: ["packages/*"],
    scripts: [{ name: "build", command: "tsc" }],
    problems: [],
  },
];

const { error: manifestError } = await db.rpc("insert_manifests", {
  p_analysis_id: analysisA,
  p_manifests: manifestPayload,
});
check("a manifest is stored", manifestError === null, manifestError?.message ?? "");

const { data: storedManifest } = await db
  .from("manifests")
  .select("path, ecosystem, name, workspaces, scripts")
  .eq("analysis_id", analysisA)
  .single();
check("the manifest round-trips its ecosystem", storedManifest?.ecosystem === "npm");
check("the manifest round-trips its workspaces", Array.isArray(storedManifest?.workspaces));
check("the manifest round-trips its scripts", Array.isArray(storedManifest?.scripts));

const { error: depError } = await db.rpc("insert_dependencies", {
  p_analysis_id: analysisA,
  p_dependencies: [
    { manifest: "package.json", dir: ".", name: "react", version: "^19.0.0", kind: "runtime", imported_by: 3 },
    { manifest: "package.json", dir: ".", name: "typescript", version: "^5.6.0", kind: "dev", imported_by: 0 },
  ],
});
check("dependencies are stored", depError === null, depError?.message ?? "");

const { data: deps } = await db
  .from("dependencies")
  .select("name, version, kind, imported_by")
  .eq("analysis_id", analysisA)
  .order("name");
check("both dependencies stored", deps?.length === 2, `${deps?.length}`);
check("runtime kind preserved", deps?.find((d) => d.name === "react")?.kind === "runtime");
check("dev kind preserved", deps?.find((d) => d.name === "typescript")?.kind === "dev");
check("import count preserved", deps?.find((d) => d.name === "react")?.imported_by === 3);
check("a zero import count is stored as zero, not null", deps?.find((d) => d.name === "typescript")?.imported_by === 0);

// The foreign key is the guarantee that a dependency cannot hang off another
// analysis's manifest. A dependency naming a manifest that does not exist must
// be refused, not silently dropped.
const { error: orphanError } = await db.rpc("insert_dependencies", {
  p_analysis_id: analysisA,
  p_dependencies: [
    { manifest: "does/not/exist/package.json", dir: "x", name: "ghost", version: "1", kind: "runtime", imported_by: 0 },
  ],
});
check("a dependency naming an unknown manifest is refused", orphanError !== null);
check(
  "the refusal names the mismatch",
  /0 of 1|matched stored manifests/i.test(orphanError?.message ?? ""),
  orphanError?.message ?? "",
);

// --- Configuration references ---------------------------------------------

console.log("\n=== 2. Configuration references ===");

const { error: configError } = await db.rpc("insert_config_references", {
  p_analysis_id: analysisA,
  p_references: [
    { file: ".env.example", variable: "DATABASE_URL", line: 0, kind: "env-example", detail: null },
    { file: ".env.example", variable: "API_KEY", line: 0, kind: "env-example", detail: null },
  ],
});
check(
  "environment template keys are stored without a matching file row",
  configError === null,
  configError?.message ?? "",
);

const { data: configRows } = await db
  .from("config_references")
  .select("file_path, variable, line, kind")
  .eq("analysis_id", analysisA);
check("both keys stored", configRows?.length === 2, `${configRows?.length}`);
check("only names are stored", (configRows ?? []).every((r) => typeof r.variable === "string" && r.variable.length > 0));

// A source reference must resolve to a stored file. With no files stored, it
// must be refused rather than accepted against nothing.
const { error: unbackedError } = await db.rpc("insert_config_references", {
  p_analysis_id: analysisA,
  p_references: [{ file: "src/index.ts", variable: "PORT", line: 4, kind: "process.env", detail: null }],
});
check("a source reference with no stored file is refused", unbackedError !== null);

// --- Entry points ----------------------------------------------------------

console.log("\n=== 3. Entry points ===");

const { error: entryError } = await db.rpc("insert_entry_points", {
  p_analysis_id: analysisA,
  p_entries: [
    {
      path: "dist/index.js",
      kind: "declared",
      source: "package.json main",
      manifest: "package.json",
      detail: null,
      resolved: false,
      unresolved_reason: "not-found",
      via: [],
    },
    {
      path: "src/main.rs",
      kind: "declared",
      source: "Cargo.toml [lib]",
      manifest: "package.json",
      detail: null,
      resolved: false,
      unresolved_reason: "not-indexed",
      via: [],
    },
  ],
});
check("unresolved entry points are stored, not dropped", entryError === null, entryError?.message ?? "");

const { data: entries } = await db
  .from("entry_points")
  .select("path, kind, resolved, unresolved_reason")
  .eq("analysis_id", analysisA)
  .order("path");
check("both entries stored", entries?.length === 2, `${entries?.length}`);
check("'not-found' preserved", entries?.find((e) => e.path === "dist/index.js")?.unresolved_reason === "not-found");
check("'not-indexed' preserved", entries?.find((e) => e.path === "src/main.rs")?.unresolved_reason === "not-indexed");

// The check constraint is the guarantee that a resolved entry cannot claim an
// unresolved reason, and an unresolved one cannot omit it.
const { error: contradictionError } = await db.rpc("insert_entry_points", {
  p_analysis_id: analysisA,
  p_entries: [
    {
      path: "src/x.ts",
      kind: "declared",
      source: "package.json main",
      manifest: "package.json",
      detail: null,
      resolved: true,
      unresolved_reason: "not-found",
      via: [],
    },
  ],
});
check("a resolved entry carrying an unresolved reason is refused", contradictionError !== null);

const { error: missingReasonError } = await db.rpc("insert_entry_points", {
  p_analysis_id: analysisA,
  p_entries: [
    {
      path: "src/y.ts",
      kind: "declared",
      source: "package.json main",
      manifest: "package.json",
      detail: null,
      resolved: false,
      unresolved_reason: null,
      via: [],
    },
  ],
});
check("an unresolved entry with no reason is refused", missingReasonError !== null);

// --- Organization isolation -----------------------------------------------

console.log("\n=== 4. Organization isolation ===");

// Organization B's analysis has nothing stored. Every read scoped to it must
// come back empty even though organization A's rows exist in the same tables.
for (const table of ["manifests", "dependencies", "config_references", "entry_points"] as const) {
  const { data } = await db.from(table).select("id").eq("analysis_id", analysisB);
  check(`${table}: another analysis sees none of these rows`, (data ?? []).length === 0);
}

const { data: orgCheck } = await db.from("manifests").select("organization_id").eq("analysis_id", analysisA);
check("stored rows carry the owning organization", (orgCheck ?? []).every((r) => r.organization_id === orgA));

const { error: crossOrgError } = await db.rpc("insert_manifests", {
  p_analysis_id: analysisB,
  p_manifests: manifestPayload,
});
check("org B's analysis can receive its own manifest", crossOrgError === null, crossOrgError?.message ?? "");
const { data: orgBRows } = await db.from("manifests").select("organization_id").eq("analysis_id", analysisB);
check("org B's rows are stamped with org B", (orgBRows ?? []).every((r) => r.organization_id === orgB));

// --- No value column ------------------------------------------------------

console.log("\n=== 5. No configuration value can be stored ===");

// Ask for every column of config_references and assert none of them holds a
// value. This is a shape check on real rows, not on the migration text.
const { data: sampleRow } = await db
  .from("config_references")
  .select("*")
  .eq("analysis_id", analysisA)
  .limit(1)
  .single();
if (sampleRow) {
  const columns = Object.keys(sampleRow);
  check(
    "config_references has no value-like column",
    !columns.some((c) => /value|secret|content|payload/i.test(c)),
    JSON.stringify(columns),
  );
  check(
    "config_references stores only a name, a place and a kind",
    columns.includes("variable") && columns.includes("file_path") && columns.includes("kind"),
  );
}

// --- Cascade --------------------------------------------------------------

console.log("\n=== 6. Cascade on analysis deletion ===");

await db.from("analyses").delete().eq("id", analysisA);
for (const table of ["manifests", "dependencies", "config_references", "entry_points"] as const) {
  const { data } = await db.from(table).select("id").eq("analysis_id", analysisA);
  check(`${table}: rows are removed with their analysis`, (data ?? []).length === 0);
}

await cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
