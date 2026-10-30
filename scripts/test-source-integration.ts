// Tests Milestone 1: Source Content Integration
// Verifies that source fetching uses content storage, in-process LRU cache,
// lazy backfill, and organization isolation without redundant network calls.

import { ContentCache } from "../lib/content/cache.ts";
import { getFileContent, type BackfillDeps } from "../lib/content/read.ts";
import { sha256 } from "../lib/content/store.ts";
import type { Db } from "../lib/content/types.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

type MockFile = {
  id: string;
  path: string;
  hash: string | null;
  content_status: string;
  organization_id: string;
  lines: number | null;
  analysis: {
    commit_sha: string | null;
    project: { repo_owner: string; repo_name: string } | null;
  } | null;
};

class FakeClient {
  files = new Map<string, MockFile>();
  contents = new Map<string, { payload: string; size: number }>();
  dbFetches = 0;

  from(table: string) {
    if (table === "files") {
      return {
        select: (_cols: string) => ({
          eq: (field: string, val: string) => ({
            maybeSingle: async () => {
              if (field === "id") {
                const f = this.files.get(val);
                return { data: f ?? null, error: null };
              }
              return { data: null, error: null };
            },
          }),
        }),
      };
    }
    if (table === "file_contents") {
      return {
        select: (_cols: string) => ({
          eq: (_f1: string, orgId: string) => ({
            eq: (_f2: string, hash: string) => ({
              maybeSingle: async () => {
                this.dbFetches++;
                const key = `${orgId}:${hash}`;
                const row = this.contents.get(key);
                if (!row) return { data: null, error: null };
                return {
                  data: {
                    organization_id: orgId,
                    content_hash: hash,
                    payload: `\\x${Buffer.from(row.payload, "utf8").toString("hex")}`,
                    size: row.size,
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

// 1. Verify stored content read uses LRU cache and avoids DB round-trips
const fake = new FakeClient();
const cache = new ContentCache({ maxBytes: 1024 * 1024 });

const sampleText = "export const answer = 42;\n";
const sampleBytes = Buffer.from(sampleText, "utf8");
const sampleHash = sha256(sampleBytes);

fake.files.set("f1", {
  id: "f1",
  path: "src/answer.ts",
  hash: sampleHash,
  content_status: "stored",
  organization_id: "org_alpha",
  lines: 1,
  analysis: {
    commit_sha: "abc1234",
    project: { repo_owner: "org", repo_name: "repo" },
  },
});

fake.contents.set(`org_alpha:${sampleHash}`, {
  payload: sampleText,
  size: sampleBytes.length,
});

const deps: BackfillDeps = { cache };

// First read: reads from DB and populates cache
const read1 = await getFileContent(fake as unknown as Db, "f1", deps);
if (read1 === sampleText) {
  pass("first read returns exact source content");
} else {
  fail(`first read returned unexpected: ${read1}`);
}
if (fake.dbFetches === 1) {
  pass("first read hit database content table once");
} else {
  fail(`database fetches was ${fake.dbFetches}, expected 1`);
}

// Second read: served from cache without DB access
const read2 = await getFileContent(fake as unknown as Db, "f1", deps);
if (read2 === sampleText) {
  pass("second read returns exact same source");
} else {
  fail("second read returned mismatch");
}
if (fake.dbFetches === 1) {
  pass("second read served from LRU cache without hitting database");
} else {
  fail(`second read touched database: fetches=${fake.dbFetches}`);
}

// 2. Organization isolation
fake.files.set("f2_beta", {
  id: "f2_beta",
  path: "src/answer.ts",
  hash: sampleHash,
  content_status: "stored",
  organization_id: "org_beta", // Different organization!
  lines: 1,
  analysis: {
    commit_sha: "abc1234",
    project: { repo_owner: "org", repo_name: "repo" },
  },
});

// org_beta has no row in file_contents table for this org, and cache shouldn't share it
let consistencyCaught = false;
try {
  await getFileContent(fake as unknown as Db, "f2_beta", deps);
} catch (err: unknown) {
  if (err instanceof Error && err.name === "ConsistencyError") {
    consistencyCaught = true;
  }
}
if (consistencyCaught) {
  pass("organization isolation holds: org_beta cannot read org_alpha's cached content");
} else {
  fail("organization isolation failed");
}

// 3. Missing file returns null
const missing = await getFileContent(fake as unknown as Db, "nonexistent", deps);
if (missing === null) {
  pass("nonexistent file id returns null gracefully");
} else {
  fail(`expected null for nonexistent file, got ${missing}`);
}

// Report results
console.log("");
for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
if (failed > 0) process.exit(1);
