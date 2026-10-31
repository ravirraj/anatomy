// Unit tests for safe garbage collection: lib/content/gc.ts
//
// Tests:
// - Old unreferenced content is eligible.
// - Recently created content is retained (within grace period).
// - Referenced content is retained (referenced by files in same org).
// - References belonging to another organization do not protect unrelated content.
// - Bounded batch behavior (respects batchSize and maxBatches).
// - Dry-run never deletes, only reports counts.
// - Explicit execution (execute: true) deletes eligible content.
// - Repeated execution is safe (idempotent).
// - Failure during a batch does not cause uncontrolled deletion.
// - Local cache entries are invalidated when items are deleted.
//
//   node scripts/test-content-gc.ts

import { ContentCache } from "../lib/content/cache.ts";
import { garbageCollectOrphanedContent } from "../lib/content/gc.ts";
import type { Db } from "../lib/content/types.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);
const check = (message: string, condition: boolean) => {
  if (condition) pass(message);
  else fail(message);
};

type FileRow = {
  id: string;
  organization_id: string;
  hash: string;
};

type ContentRow = {
  organization_id: string;
  content_hash: string;
  payload: string;
  size: number;
  created_at: string;
};

class FakeGcDb {
  files: FileRow[] = [];
  contents: ContentRow[] = [];
  failNextRpc: string | null = null;

  from(table: string) {
    if (table === "file_contents") {
      return this.fileContentsChain();
    }
    if (table === "files") {
      return this.filesChain();
    }
    throw new Error(`Unknown table: ${table}`);
  }

  private fileContentsChain() {
    const filters: { col: string; op: string; val: unknown }[] = [];
    let limitCount: number | null = null;

    const builder = {
      select: () => {
        return builder;
      },
      lt: (col: string, val: unknown) => {
        filters.push({ col, op: "lt", val });
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push({ col, op: "eq", val });
        return builder;
      },
      order: () => {
        return builder;
      },
      limit: (n: number) => {
        limitCount = n;
        return builder;
      },
      then: (resolve: (val: { data: unknown[]; error: null }) => void) => {
        let rows = [...this.contents];
        for (const f of filters) {
          if (f.op === "lt") {
            rows = rows.filter((r) => r[f.col as keyof ContentRow] < (f.val as string));
          } else if (f.op === "eq") {
            rows = rows.filter((r) => r[f.col as keyof ContentRow] === f.val);
          }
        }
        if (limitCount !== null) {
          rows = rows.slice(0, limitCount);
        }
        resolve({ data: rows, error: null });
      },
    };
    return builder;
  }

  private filesChain() {
    const filters: { col: string; val: unknown }[] = [];

    const builder = {
      select: () => {
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push({ col, val });
        return builder;
      },
      then: (resolve: (val: { count: number; error: null }) => void) => {
        let rows = [...this.files];
        for (const f of filters) {
          rows = rows.filter((r) => r[f.col as keyof FileRow] === f.val);
        }
        resolve({ count: rows.length, error: null });
      },
    };
    return builder;
  }

  async rpc(name: string, args: { p_organization_id: string | null; p_grace_period: string; p_batch_size: number }) {
    if (name !== "delete_orphaned_file_contents") {
      throw new Error(`Unknown RPC: ${name}`);
    }

    if (this.failNextRpc) {
      const msg = this.failNextRpc;
      this.failNextRpc = null;
      return { data: null, error: { message: msg } };
    }

    // Parse grace period
    const match = args.p_grace_period.match(/(\d+)\s+(seconds|milliseconds)/);
    const val = match ? parseInt(match[1]!, 10) : 86400;
    const ms = match && match[2] === "milliseconds" ? val : val * 1000;
    const cutoff = new Date(Date.now() - ms).toISOString();

    // Find candidates eligible for deletion
    const eligible: ContentRow[] = [];
    for (const c of this.contents) {
      if (args.p_organization_id && c.organization_id !== args.p_organization_id) {
        continue;
      }
      if (c.created_at >= cutoff) {
        continue; // Too recent (within grace period)
      }
      // Re-check references
      const hasReference = this.files.some(
        (f) => f.organization_id === c.organization_id && f.hash === c.content_hash,
      );
      if (!hasReference) {
        eligible.push(c);
      }
    }

    // Take up to p_batch_size
    const toDelete = eligible.slice(0, args.p_batch_size);

    // Delete them
    for (const item of toDelete) {
      const idx = this.contents.findIndex(
        (c) => c.organization_id === item.organization_id && c.content_hash === item.content_hash,
      );
      if (idx !== -1) {
        this.contents.splice(idx, 1);
      }
    }

    return {
      data: toDelete.map((d) => ({
        organization_id: d.organization_id,
        content_hash: d.content_hash,
        size: d.size,
      })),
      error: null,
    };
  }
}

function makeDb(fake: FakeGcDb): Db {
  return fake as unknown as Db;
}

const NOW = Date.now();
const OLD_TIME = new Date(NOW - 48 * 60 * 60 * 1000).toISOString(); // 48h ago (older than 24h grace)
const RECENT_TIME = new Date(NOW - 1 * 60 * 60 * 1000).toISOString(); // 1h ago (within 24h grace)

async function main(): Promise<void> {
  // --- 1. Old unreferenced content is eligible and deleted ---
  {
    const fake = new FakeGcDb();
    fake.contents = [
      { organization_id: "org-1", content_hash: "hash-old-orphan", payload: "\\x01", size: 100, created_at: OLD_TIME },
    ];
    fake.files = []; // no references

    const stats = await garbageCollectOrphanedContent(makeDb(fake), {
      execute: true,
      organizationId: "org-1",
    });

    check("old unreferenced content is deleted", stats.rowsDeleted === 1);
    check("reclaimed bytes recorded accurately", stats.bytesReclaimed === 100);
    check("database content row was removed", fake.contents.length === 0);
  }

  // --- 2. Recently created content is retained (within grace period) ---
  {
    const fake = new FakeGcDb();
    fake.contents = [
      { organization_id: "org-1", content_hash: "hash-recent-orphan", payload: "\\x01", size: 100, created_at: RECENT_TIME },
    ];
    fake.files = []; // no references, but recent (in-flight indexing)

    const stats = await garbageCollectOrphanedContent(makeDb(fake), {
      execute: true,
      organizationId: "org-1",
    });

    check("recent unreferenced content within grace period is NOT deleted", stats.rowsDeleted === 0);
    check("content row remains in database", fake.contents.length === 1);
  }

  // --- 3. Referenced content is retained ---
  {
    const fake = new FakeGcDb();
    fake.contents = [
      { organization_id: "org-1", content_hash: "hash-referenced", payload: "\\x01", size: 100, created_at: OLD_TIME },
    ];
    fake.files = [
      { id: "file-1", organization_id: "org-1", hash: "hash-referenced" },
    ];

    const stats = await garbageCollectOrphanedContent(makeDb(fake), {
      execute: true,
      organizationId: "org-1",
    });

    check("referenced content is NOT deleted", stats.rowsDeleted === 0);
    check("referenced content row remains in database", fake.contents.length === 1);
  }

  // --- 4. Cross-organization isolation: references in org-2 do NOT protect org-1 ---
  {
    const fake = new FakeGcDb();
    // org-1 has old content
    fake.contents = [
      { organization_id: "org-1", content_hash: "shared-hash", payload: "\\x01", size: 100, created_at: OLD_TIME },
      { organization_id: "org-2", content_hash: "shared-hash", payload: "\\x01", size: 100, created_at: OLD_TIME },
    ];
    // org-2 has a file referencing it, but org-1 has no file
    fake.files = [
      { id: "file-2", organization_id: "org-2", hash: "shared-hash" },
    ];

    const stats = await garbageCollectOrphanedContent(makeDb(fake), {
      execute: true,
      organizationId: "org-1",
    });

    check("org-1 orphaned content is deleted even if org-2 references same hash", stats.rowsDeleted === 1);
    check("org-2 content remains preserved", fake.contents.length === 1 && fake.contents[0]!.organization_id === "org-2");
  }

  // --- 5. Dry-run never deletes ---
  {
    const fake = new FakeGcDb();
    fake.contents = [
      { organization_id: "org-1", content_hash: "hash-1", payload: "\\x01", size: 50, created_at: OLD_TIME },
      { organization_id: "org-1", content_hash: "hash-2", payload: "\\x02", size: 50, created_at: OLD_TIME },
    ];
    fake.files = [];

    // Dry run via execute: false
    const stats1 = await garbageCollectOrphanedContent(makeDb(fake), {
      execute: false,
      organizationId: "org-1",
    });

    check("execute: false defaults to dry-run", stats1.dryRun === true);
    check("dry-run identifies 2 eligible rows", stats1.rowsEligible === 2);
    check("dry-run deletes 0 rows", stats1.rowsDeleted === 0);
    check("database rows are still untouched", fake.contents.length === 2);

    // Dry run via dryRun: true (even if execute: true)
    const stats2 = await garbageCollectOrphanedContent(makeDb(fake), {
      execute: true,
      dryRun: true,
      organizationId: "org-1",
    });

    check("explicit dryRun: true overrides execute: true", stats2.dryRun === true);
    check("dry-run with execute: true deletes 0 rows", stats2.rowsDeleted === 0);
    check("database rows still untouched", fake.contents.length === 2);
  }

  // --- 6. Bounded batch behavior ---
  {
    const fake = new FakeGcDb();
    // 5 orphan rows
    fake.contents = [
      { organization_id: "org-1", content_hash: "h1", payload: "\\x01", size: 10, created_at: OLD_TIME },
      { organization_id: "org-1", content_hash: "h2", payload: "\\x01", size: 10, created_at: OLD_TIME },
      { organization_id: "org-1", content_hash: "h3", payload: "\\x01", size: 10, created_at: OLD_TIME },
      { organization_id: "org-1", content_hash: "h4", payload: "\\x01", size: 10, created_at: OLD_TIME },
      { organization_id: "org-1", content_hash: "h5", payload: "\\x01", size: 10, created_at: OLD_TIME },
    ];
    fake.files = [];

    // Set batchSize: 2, maxBatches: 2 (can process at most 4 rows)
    const stats = await garbageCollectOrphanedContent(makeDb(fake), {
      execute: true,
      organizationId: "org-1",
      batchSize: 2,
      maxBatches: 2,
    });

    check("bounded execution processed exactly 2 batches", stats.batchesProcessed === 2);
    check("bounded execution deleted exactly 4 rows (2 x 2)", stats.rowsDeleted === 4);
    check("1 row remains unprocessed due to batch bounds", fake.contents.length === 1);
  }

  // --- 7. Idempotency / repeated execution ---
  {
    const fake = new FakeGcDb();
    fake.contents = [
      { organization_id: "org-1", content_hash: "h1", payload: "\\x01", size: 10, created_at: OLD_TIME },
    ];
    fake.files = [];

    const firstRun = await garbageCollectOrphanedContent(makeDb(fake), {
      execute: true,
      organizationId: "org-1",
    });
    check("first run deletes the orphan", firstRun.rowsDeleted === 1);

    const secondRun = await garbageCollectOrphanedContent(makeDb(fake), {
      execute: true,
      organizationId: "org-1",
    });
    check("repeated run is safe and deletes 0 rows", secondRun.rowsDeleted === 0);
    check("repeated run encounters no errors", secondRun.errors.length === 0);
  }

  // --- 8. Cache invalidation on deletion ---
  {
    const fake = new FakeGcDb();
    const cache = new ContentCache();
    const hash = "hash-cached-orphan";
    const bytes = new Uint8Array([1, 2, 3]);

    cache.set("org-1", hash, bytes);
    check("item is initially cached", cache.get("org-1", hash) !== undefined);

    fake.contents = [
      { organization_id: "org-1", content_hash: hash, payload: "\\x01", size: 3, created_at: OLD_TIME },
    ];
    fake.files = [];

    await garbageCollectOrphanedContent(makeDb(fake), {
      execute: true,
      organizationId: "org-1",
      cache,
    });

    check("deleted item is evicted from process cache", cache.get("org-1", hash) === undefined);
  }

  // --- 9. Failure during batch handled gracefully ---
  {
    const fake = new FakeGcDb();
    fake.contents = [
      { organization_id: "org-1", content_hash: "h1", payload: "\\x01", size: 10, created_at: OLD_TIME },
    ];
    fake.failNextRpc = "database lock timeout";

    const stats = await garbageCollectOrphanedContent(makeDb(fake), {
      execute: true,
      organizationId: "org-1",
    });

    check("batch error is recorded in stats", stats.errors.length === 1 && stats.errors[0]!.includes("database lock timeout"));
    check("failed batch does not report deleted rows", stats.rowsDeleted === 0);
  }
}

main()
  .catch((error) => {
    console.error("Test failed with unexpected error:", error);
    fail(`unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  })
  .finally(() => {
    console.log("");
    for (const line of results) console.log(line);
    const failed = results.filter((r) => r.startsWith("FAIL")).length;
    console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
    process.exit(failed === 0 ? 0 : 1);
  });
