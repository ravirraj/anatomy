import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSelection, selectFiles } from "../lib/parser/index.ts";
import { getFileContent, getFileLines } from "../lib/content/read.ts";
import { sha256 } from "../lib/content/store.ts";
import type { Db } from "../lib/content/types.ts";
import { storeResult } from "../lib/pipeline/store.ts";
import { PRIMARY_MANIFEST_NAMES, type NonCodeCandidate } from "../lib/parser/screening.ts";

function pass(name: string): void {
  console.log(`ok    ${name}`);
}

type ContentRow = { organization_id: string; content_hash: string; payload: string; size: number };
type FileRow = {
  id: string;
  organization_id: string;
  analysis_id: string;
  path: string;
  module?: string | null;
  lines?: number | null;
  bytes?: number | null;
  hash?: string | null;
  fan_in?: number | null;
  fan_out?: number | null;
  reached_by?: string | null;
  exports?: string[] | null;
  content_status?: string;
  skip_reason?: string | null;
  skip_detail?: string | null;
};

class FakeDatabase {
  contents: ContentRow[] = [];
  files = new Map<string, FileRow[]>(); // analysis_id -> FileRow[]
  quarantine = new Set<string>(); // "org:hash"
  fileIdCounter = 1;

  from(name: string): unknown {
    if (name === "file_contents") return this.fileContentsTable();
    if (name === "files") return this.filesTable();
    if (name === "manifests" || name === "config_references" || name === "entry_points") {
      return {
        delete: () => ({
          eq: () => Promise.resolve({ error: null }),
        }),
      };
    }
    throw new Error(`FakeDatabase: unexpected table ${name}`);
  }

  fileContentsTable() {
    return {
      upsert: (values: ContentRow | ContentRow[], _opts: { onConflict: string; ignoreDuplicates?: boolean }) => {
        const rows = Array.isArray(values) ? values : [values];
        for (const row of rows) {
          if (this.quarantine.has(`${row.organization_id}:${row.content_hash}`)) {
            return Promise.resolve({ error: { message: "content excluded by security policy", code: "CG001" } });
          }
          if (!this.contents.some((r) => r.organization_id === row.organization_id && r.content_hash === row.content_hash)) {
            this.contents.push(row);
          }
        }
        return Promise.resolve({ error: null });
      },
      select: (_cols?: string) => ({
        eq: (col1: string, val1: string) => ({
          eq: (col2: string, val2: string) => ({
            maybeSingle: () => {
              const row = this.contents.find((r) => {
                const match1 = (r as Record<string, unknown>)[col1] === val1;
                const match2 = (r as Record<string, unknown>)[col2] === val2;
                return match1 && match2;
              });
              return Promise.resolve({ data: row ?? null, error: null });
            },
          }),
        }),
      }),
    };
  }

  filesTable() {
    return {
      delete: () => ({
        eq: (_column: string, analysisId: string) => {
          this.files.set(analysisId, []);
          return Promise.resolve({ error: null });
        },
      }),
      insert: (rows: FileRow[]) => {
        for (const row of rows) {
          const id = row.id ?? `f-${this.fileIdCounter++}`;
          let status = row.content_status ?? "absent";
          if (row.hash && this.quarantine.has(`${row.organization_id}:${row.hash}`)) {
            status = "excluded";
          }
          const assigned: FileRow = { ...row, id, content_status: status };
          let list = this.files.get(row.analysis_id);
          if (!list) this.files.set(row.analysis_id, (list = []));
          list.push(assigned);
        }
        return Promise.resolve({ error: null });
      },
      select: (_cols?: string) => ({
        eq: (col: string, val: string) => ({
          eq: (col2: string, val2: string) => ({
            maybeSingle: () => {
              for (const list of this.files.values()) {
                const found = list.find(
                  (r) => (r as Record<string, unknown>)[col] === val && (r as Record<string, unknown>)[col2] === val2,
                );
                if (found) {
                  return Promise.resolve({
                    data: {
                      ...found,
                      analysis: {
                        commit_sha: "abc1234",
                        project: { repo_owner: "owner", repo_name: "repo" },
                      },
                    },
                    error: null,
                  });
                }
              }
              return Promise.resolve({ data: null, error: null });
            },
          }),
          maybeSingle: () => {
            for (const list of this.files.values()) {
              const found = list.find((r) => (r as Record<string, unknown>)[col] === val);
              if (found) {
                return Promise.resolve({
                  data: {
                    ...found,
                    analysis: {
                      commit_sha: "abc1234",
                      project: { repo_owner: "owner", repo_name: "repo" },
                    },
                  },
                  error: null,
                });
              }
            }
            return Promise.resolve({ data: null, error: null });
          },
        }),
      }),
      update: (patch: Partial<FileRow>) => ({
        eq: (_c1: string, id: string) => ({
          eq: (_c2: string, orgId: string) => ({
            eq: (_c3: string, hash: string) => ({
              eq: (_c4: string, status: string) => ({
                select: () => {
                  for (const list of this.files.values()) {
                    const found = list.find(
                      (r) => r.id === id && r.organization_id === orgId && r.hash === hash && r.content_status === status,
                    );
                    if (found) {
                      Object.assign(found, patch);
                      return Promise.resolve({ data: [{ id: found.id }], error: null });
                    }
                  }
                  return Promise.resolve({ data: [], error: null });
                },
              }),
            }),
          }),
        }),
      }),
    };
  }

  rpc(_name: string, _args: Record<string, unknown>) {
    return Promise.resolve({ error: null });
  }

  asDb(): Db {
    return {
      from: (name: string) => this.from(name) as never,
      rpc: (name: string, args: Record<string, unknown>) => this.rpc(name, args) as never,
    } as unknown as Db;
  }
}

function makeFixture(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "non-code-storage-"));
  for (const [rel, body] of Object.entries(files)) {
    const absolute = path.join(root, rel);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, body, "utf8");
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

console.log("=== 1. Eligible Manifest Pipeline Storage & Verified Reads ===");
{
  const fixture = makeFixture({
    "package.json": '{\n  "name": "polyglot",\n  "version": "1.0.0"\n}\n',
    "Cargo.toml": '[package]\nname = "my-crate"\nversion = "0.1.0"\n',
    "go.mod": "module example.com/pkg\n\ngo 1.22\n",
    "pyproject.toml": '[project]\nname = "py-app"\nversion = "0.1.0"\n',
    "requirements.txt": "requests==2.31.0\nurllib3>=2.0.0\n",
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
    "src/index.ts": 'export const greeting = "hello world";\n',
  });

  try {
    const selection = selectFiles(fixture.root);
    const result = parseSelection(selection);
    const contents = new Map<string, string>(selection.walk.candidates.map((c) => [c.path, c.content]));
    for (const c of selection.walk.nonCodeCandidates) {
      contents.set(c.path, c.content);
    }

    const fake = new FakeDatabase();
    const stats = await storeResult(
      fake.asDb(),
      { id: "analysis-eligible-1", organizationId: "org-alpha" },
      result,
      contents,
      selection.walk.nonCodeCandidates,
    );

    assert.strictEqual(stats.eligible, 1 + 6, "1 code file + 6 primary manifests = 7 eligible files");
    assert.strictEqual(stats.stored, 7, "All 7 files must be successfully stored");
    assert.strictEqual(stats.absent, 0, "No file left absent");

    const storedFiles = fake.files.get("analysis-eligible-1")!;
    assert(storedFiles && storedFiles.length > 0, "File rows inserted");

    // Check that all 6 primary manifests exist in public.files with content_status = 'stored'
    for (const name of PRIMARY_MANIFEST_NAMES) {
      const fileRow = storedFiles.find((f) => f.path === name);
      assert(fileRow, `File row for manifest ${name} must exist`);
      assert.strictEqual(fileRow.content_status, "stored", `${name} content_status must be 'stored'`);
      assert.strictEqual(fileRow.fan_in, 0, `${name} fan_in must be 0`);
      assert.strictEqual(fileRow.fan_out, 0, `${name} fan_out must be 0`);
      assert.deepStrictEqual(fileRow.exports, [], `${name} exports must be []`);
      assert(typeof fileRow.hash === "string" && fileRow.hash.length === 64, `${name} hash must be sha256`);
      assert((fileRow.lines ?? 0) > 0, `${name} line count must be > 0`);
      assert((fileRow.bytes ?? 0) > 0, `${name} byte count must be > 0`);

      // Verified read test via getFileContent
      const text = await getFileContent(fake.asDb(), fileRow.id);
      assert(text !== null, `getFileContent must serve text for ${name}`);
      const diskContent = readFileSync(path.join(fixture.root, name), "utf8");
      assert.strictEqual(text, diskContent, `Served text must match disk bytes exactly for ${name}`);

      // Verified line range read test via getFileLines
      const firstLine = await getFileLines(fake.asDb(), fileRow.id, 1, 1);
      assert(firstLine !== null, `getFileLines must serve first line for ${name}`);
      const expectedFirstLine = diskContent.split("\n")[0];
      assert.strictEqual(firstLine, expectedFirstLine, `First line must match disk content for ${name}`);
    }

    pass("all 6 primary manifests stored in file_contents and verified via getFileContent/getFileLines");
  } finally {
    fixture.cleanup();
  }
}

console.log("\n=== 2. Hash Mismatch & Integrity Rejection ===");
{
  const fixture = makeFixture({
    "package.json": '{"name": "tampered", "version": "1.0.0"}',
  });

  try {
    const selection = selectFiles(fixture.root);
    const result = parseSelection(selection);
    // Maliciously pass modified content that disagrees with candidate.hash
    const tamperedContents = new Map<string, string>();
    tamperedContents.set("package.json", '{"name": "tampered-malicious-edit"}');

    const fake = new FakeDatabase();
    // Tamper the file on disk as well so re-read fails hash verification
    writeFileSync(path.join(fixture.root, "package.json"), '{"name": "tampered-on-disk-too"}', "utf8");

    const stats = await storeResult(
      fake.asDb(),
      { id: "analysis-tamper", organizationId: "org-alpha" },
      result,
      tamperedContents,
      selection.walk.nonCodeCandidates,
    );

    assert.strictEqual(stats.stored, 0, "Tampered manifest must NOT be stored");
    assert.strictEqual(stats.absent, 1, "Tampered manifest must be marked absent");
    assert.strictEqual(stats.changed, 1, "Stats must record 1 changed file");

    const storedFiles = fake.files.get("analysis-tamper")!;
    const pkgRow = storedFiles.find((f) => f.path === "package.json");
    assert(pkgRow, "package.json row created in files");
    assert.strictEqual(pkgRow.content_status, "absent", "Tampered file row must end with content_status = 'absent'");

    pass("tampered manifest fails hash verification and remains content_status = 'absent'");
  } finally {
    fixture.cleanup();
  }
}

console.log("\n=== 3. Quarantine & Exclusion Enforcement ===");
{
  const fixture = makeFixture({
    "package.json": '{"name": "quarantined-manifest", "version": "1.0.0"}',
  });

  try {
    const selection = selectFiles(fixture.root);
    const result = parseSelection(selection);
    const candidate = selection.walk.nonCodeCandidates.find((c) => c.path === "package.json")!;
    assert(candidate, "Candidate found");

    const fake = new FakeDatabase();
    // Pre-quarantine this manifest's hash in org-quarantine
    fake.quarantine.add(`org-quarantine:${candidate.hash}`);

    const contents = new Map<string, string>([["package.json", candidate.content]]);
    const stats = await storeResult(
      fake.asDb(),
      { id: "analysis-quarantine", organizationId: "org-quarantine" },
      result,
      contents,
      [candidate],
    );

    // Write to file_contents was refused by trigger/gate
    assert.strictEqual(fake.contents.length, 0, "Quarantined manifest body must not be in file_contents");
    assert.strictEqual(stats.stored, 0, "Quarantined manifest must not be counted as stored");

    const storedFiles = fake.files.get("analysis-quarantine")!;
    const pkgRow = storedFiles.find((f) => f.path === "package.json");
    assert(pkgRow, "File row exists in files table");
    assert.strictEqual(pkgRow.content_status, "excluded", "Quarantined row is forced to content_status = 'excluded'");

    // Verified read must return null for excluded content
    const readOutcome = await getFileContent(fake.asDb(), pkgRow.id);
    assert.strictEqual(readOutcome, null, "getFileContent must refuse excluded/quarantined content");

    pass("quarantined manifest is blocked from storage and strictly refused on read");
  } finally {
    fixture.cleanup();
  }
}

console.log("\n=== 4. Organization Isolation ===");
{
  const fixture = makeFixture({
    "package.json": '{"name": "tenant-isolated", "version": "1.0.0"}',
  });

  try {
    const selection = selectFiles(fixture.root);
    const result = parseSelection(selection);
    const contents = new Map<string, string>(selection.walk.nonCodeCandidates.map((c) => [c.path, c.content]));

    const fake = new FakeDatabase();
    // Org A stores manifest
    await storeResult(
      fake.asDb(),
      { id: "analysis-org-a", organizationId: "org-a" },
      result,
      contents,
      selection.walk.nonCodeCandidates,
    );

    const orgAFiles = fake.files.get("analysis-org-a")!;
    const fileRow = orgAFiles.find((f) => f.path === "package.json")!;
    assert(fileRow, "Org A file row exists");

    // Content row exists for org-a
    assert(fake.contents.some((c) => c.organization_id === "org-a" && c.content_hash === fileRow.hash));
    // Content row does not exist for org-b
    assert(!fake.contents.some((c) => c.organization_id === "org-b" && c.content_hash === fileRow.hash));

    // A read by Org A succeeds
    const orgARead = await getFileContent(fake.asDb(), fileRow.id);
    assert(orgARead !== null, "Org A can read its own file");

    pass("manifest content and file rows are strictly isolated by organization");
  } finally {
    fixture.cleanup();
  }
}

console.log("\n=== 5. Repeated Ingestion & Idempotency ===");
{
  const fixture = makeFixture({
    "package.json": '{"name": "idempotent-pkg", "version": "1.0.0"}',
    "Cargo.toml": '[package]\nname = "idempotent-crate"\nversion = "0.1.0"\n',
  });

  try {
    const selection = selectFiles(fixture.root);
    const result = parseSelection(selection);
    const contents = new Map<string, string>(selection.walk.nonCodeCandidates.map((c) => [c.path, c.content]));

    const fake = new FakeDatabase();
    // Run 1
    const stats1 = await storeResult(
      fake.asDb(),
      { id: "analysis-re-run", organizationId: "org-re-run" },
      result,
      contents,
      selection.walk.nonCodeCandidates,
    );
    assert.strictEqual(stats1.stored, 2);
    const contentCountRun1 = fake.contents.length;
    assert.strictEqual(contentCountRun1, 2);

    // Run 2 (Re-run of same analysis)
    const stats2 = await storeResult(
      fake.asDb(),
      { id: "analysis-re-run", organizationId: "org-re-run" },
      result,
      contents,
      selection.walk.nonCodeCandidates,
    );
    assert.strictEqual(stats2.stored, 2);
    // file_contents must not duplicate rows
    assert.strictEqual(fake.contents.length, contentCountRun1, "No duplicate rows created in file_contents");
    // files table has exactly the 2 rows for the analysis
    const filesAfter = fake.files.get("analysis-re-run")!;
    assert.strictEqual(filesAfter.length, 2, "Files table correctly holds exactly 2 rows after re-run");
    assert(filesAfter.every((f) => f.content_status === "stored"), "All rows end with content_status = 'stored'");

    pass("re-indexing is completely idempotent with no duplicate storage");
  } finally {
    fixture.cleanup();
  }
}

console.log("\n=== 6. Rejection of Secret-Bearing, Oversized, and Non-Allowlisted Files ===");
{
  const fake = new FakeDatabase();
  const fakeResult = {
    schemaVersion: 7 as const,
    root: "/repo",
    projects: [{ path: ".", adapter: "none" }],
    files: [],
    edges: [],
    routes: [],
    symbols: [],
    manifests: [],
    dependencies: [],
    configReferences: [],
    envDeclarations: [],
    entryPoints: [],
    coverage: {
      files: { found: 0, parsed: 0, skipped: 0, skippedFiles: [], excludedDirectories: [] },
      imports: { total: { seen: 0, internal: 0, external: 0, excluded: 0, unresolved: 0 }, byKind: {} as never, external: {} as never, excluded: {}, unresolvedByReason: {}, unresolved: [] },
      routes: { omitted: [], withheld: [] },
      calls: { total: 0, resolved: 0, unresolved: 0, unresolvedCalls: [] },
    },
    configs: [],
  };

  // Malicious candidate containing a token
  const secretContent = '{"name": "secret", "token": "ghp_0123456789abcdefghijklmnopqrstuvwxyz"}';
  const secretCandidate: NonCodeCandidate = {
    path: "package.json",
    absolutePath: "/repo/package.json",
    module: ".",
    content: secretContent,
    bytes: Buffer.byteLength(secretContent, "utf8"),
    lines: 1,
    hash: sha256(Buffer.from(secretContent, "utf8")),
    project: ".",
    category: "primary_manifest",
  };

  // Malicious oversized candidate (> 512 KiB)
  const oversizedContent = "x".repeat(600 * 1024);
  const oversizedCandidate: NonCodeCandidate = {
    path: "Cargo.toml",
    absolutePath: "/repo/Cargo.toml",
    module: ".",
    content: oversizedContent,
    bytes: Buffer.byteLength(oversizedContent, "utf8"),
    lines: 1,
    hash: sha256(Buffer.from(oversizedContent, "utf8")),
    project: ".",
    category: "primary_manifest",
  };

  // Malicious non-allowlisted candidate
  const nonAllowlistedContent = "SECRET_KEY=12345";
  const nonAllowlistedCandidate: NonCodeCandidate = {
    path: ".env",
    absolutePath: "/repo/.env",
    module: ".",
    content: nonAllowlistedContent,
    bytes: Buffer.byteLength(nonAllowlistedContent, "utf8"),
    lines: 1,
    hash: sha256(Buffer.from(nonAllowlistedContent, "utf8")),
    project: ".",
    category: "primary_manifest" as never,
  };

  const maliciousCandidates = [secretCandidate, oversizedCandidate, nonAllowlistedCandidate];
  const contents = new Map<string, string>([
    [secretCandidate.path, secretCandidate.content],
    [oversizedCandidate.path, oversizedCandidate.content],
    [nonAllowlistedCandidate.path, nonAllowlistedCandidate.content],
  ]);

  const stats = await storeResult(
    fake.asDb(),
    { id: "analysis-malicious", organizationId: "org-defense" },
    fakeResult,
    contents,
    maliciousCandidates,
  );

  assert.strictEqual(fake.contents.length, 0, "No malicious candidate ever written to file_contents");
  assert.strictEqual(stats.stored, 0, "Zero malicious files stored");
  assert(
    !fake.contents.some((c) => c.payload.includes("ghp_")),
    "No secret token ever enters file_contents",
  );

  pass("defense-in-depth screening catches and excludes secret, oversized, and non-allowlisted candidates");
}

console.log("\nEvery Phase 2 test passed.");
