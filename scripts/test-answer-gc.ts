// Unit tests for answer-cache retention pruning: lib/content/gc.ts
// (garbageCollectExpiredAnswers - the application side of the database's
// prune_ai_cache function, exercised here without a database)
//
// Tests:
// - Dry run is the default: no deletion request is ever made.
// - An explicit dryRun blocks deletion even alongside execute: true.
// - An active run (execute: true) forwards scope and bounds to the database
//   function and aggregates its per-organization statistics.
// - Organization scoping: a scoped request passes the organization id; a
//   null scope asks for all organizations (service-role operator use).
// - Configured bounds (batch size, deletion budget, org cap) are forwarded
//   untouched; omitted bounds fall back to the approved defaults.
// - A database error is captured in structured stats.errors and leaves zero
//   deletion counts.
// - An empty database result (nothing pruned) yields zero stats, not an error.
// - The cap judgement is exact for a scoped dry run and honest (null,
//   never invented) for a global one.
//
//   node scripts/test-answer-gc.ts

import {
  DEFAULT_ANSWER_BATCH_SIZE,
  DEFAULT_ANSWER_CAP_ROWS_PER_ORG,
  DEFAULT_ANSWER_MAX_DELETIONS,
  garbageCollectExpiredAnswers,
} from "../lib/content/gc.ts";
import type { Db } from "../lib/content/types.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);
const check = (message: string, condition: boolean) => {
  if (condition) pass(message);
  else fail(message);
};

type FakeAnswerRow = { organization_id: string; expires_at: string; body: string };

class FakeAnswerDb {
  rows: FakeAnswerRow[] = [];
  rpcCalls: { name: string; args: Record<string, unknown> | null }[] = [];
  rpcResult: { data: Record<string, unknown>[] | null; error: { message: string } | null } = {
    data: null,
    error: null,
  };

  from(table: string) {
    if (table !== "ai_cache") throw new Error(`Unknown table: ${table}`);

    const filters: { col: string; op: string; val: unknown }[] = [];

    const builder = {
      select: () => builder,
      lt: (col: string, val: unknown) => {
        filters.push({ col, op: "lt", val });
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push({ col, op: "eq", val });
        return builder;
      },
    };

    // Supabase query builders are thenable; resolve the aggregated count
    // against this instance's rows.
    Object.assign(builder, {
      then: (onFulfilled: (v: { count: number; error: null }) => unknown) => {
        let matching = this.rows;
        for (const f of filters) {
          if (f.op === "eq" && f.col === "organization_id") {
            matching = matching.filter((r) => r.organization_id === f.val);
          }
          if (f.op === "lt" && f.col === "expires_at") {
            const cutoff = new Date(f.val as string).getTime();
            matching = matching.filter((r) => new Date(r.expires_at).getTime() < cutoff);
          }
        }
        return Promise.resolve(onFulfilled({ count: matching.length, error: null }));
      },
    });
    return builder;
  }

  async rpc(name: string, args: Record<string, unknown> | null) {
    this.rpcCalls.push({ name, args });
    return this.rpcResult;
  }
}

function freshDb(): FakeAnswerDb {
  // Two scoped rows in org-a, one fresh row in org-b: enough to
  // distinguish scoped from global behavior.
  const now = Date.now();
  const db = new FakeAnswerDb();
  db.rows = [
    { organization_id: "org-a", expires_at: new Date(now - 1000).toISOString(), body: "old" },
    { organization_id: "org-a", expires_at: new Date(now + 90 * 24 * 3600 * 1000).toISOString(), body: "new" },
    { organization_id: "org-b", expires_at: new Date(now + 90 * 24 * 3600 * 1000).toISOString(), body: "other" },
  ];
  return db;
}

async function run() {
  console.log("=== 1. Dry run is the default ===");
  {
    const db = freshDb();
    const stats = await garbageCollectExpiredAnswers(db as unknown as Db, { organizationId: "org-a" });
    check("default invocation makes zero database deletion requests", db.rpcCalls.length === 0);
    check("default invocation reports dryRun", stats.dryRun === true);
    check("dry run counts expired rows in scope", stats.expiredRowsEligible === 1);
    check("dry run counts rows in scope", stats.rowsExamined === 2);
    check("scoped dry run floors the over-cap figure at 0 when under cap", stats.overCapRowsEligible === 0);
    check("dry run deletes nothing", stats.expiredRowsDeleted === 0 && stats.capEvictedRowsDeleted === 0);
    check("dry run reports no reclaimed bytes rather than inventing them", stats.bodyBytesDeleted === 0);
    check("dry run reports no errors", stats.errors.length === 0);
  }

  console.log("\n=== 2. Explicit dryRun blocks execute: true ===");
  {
    const db = freshDb();
    const stats = await garbageCollectExpiredAnswers(db as unknown as Db, {
      organizationId: "org-a",
      dryRun: true,
      execute: true,
    });
    check("dryRun: true wins over execute: true and deletes nothing", db.rpcCalls.length === 0 && stats.dryRun === true);
  }

  console.log("\n=== 3. Active run forwards scope and bounds ===");
  {
    const db = freshDb();
    db.rpcResult = {
      data: [
        { organization_id: "org-a", expired_rows_deleted: 1, cap_evicted_rows_deleted: 0, body_bytes_deleted: 1200 },
        { organization_id: "org-b", expired_rows_deleted: 0, cap_evicted_rows_deleted: 2, body_bytes_deleted: 4800 },
      ],
      error: null,
    };
    const stats = await garbageCollectExpiredAnswers(db as unknown as Db, {
      organizationId: "org-a",
      execute: true,
    });
    check("active run invokes the database pruner exactly once", db.rpcCalls.length === 1);
    check("pruner invoked by its real name", db.rpcCalls[0]?.name === "prune_ai_cache");
    const args = db.rpcCalls[0]?.args ?? {};
    check("active run passes the requested organization scope", args.p_organization_id === "org-a");
    check(
      "active run uses the approved default bounds (batch 500 / budget 5000 / cap 25000)",
      args.p_batch_size === DEFAULT_ANSWER_BATCH_SIZE &&
        DEFAULT_ANSWER_BATCH_SIZE === 500 &&
        args.p_max_deletions === DEFAULT_ANSWER_MAX_DELETIONS &&
        DEFAULT_ANSWER_MAX_DELETIONS === 5000 &&
        args.p_cap_rows === DEFAULT_ANSWER_CAP_ROWS_PER_ORG &&
        DEFAULT_ANSWER_CAP_ROWS_PER_ORG === 25000,
    );
    check("active run reports deletions", stats.expiredRowsDeleted === 1 && stats.capEvictedRowsDeleted === 2);
    check(
      "active run aggregates per-organization byte totals exactly",
      stats.bodyBytesDeleted === 1200 + 4800 && stats.rowsExamined === 3,
    );
    check("active run reports errors only if the database failed", stats.errors.length === 0);
  }

  console.log("\n=== 4. Custom bounds are forwarded untouched ===");
  {
    const db = freshDb();
    db.rpcResult = { data: [], error: null };
    await garbageCollectExpiredAnswers(db as unknown as Db, {
      organizationId: "org-a",
      batchSize: 50,
      maxDeletions: 100,
      capRowsPerOrg: 10,
      execute: true,
    });
    const args = db.rpcCalls[0]?.args ?? {};
    check(
      "batch size, deletion budget and org cap forwarded verbatim",
      args.p_batch_size === 50 && args.p_max_deletions === 100 && args.p_cap_rows === 10,
    );
  }

  console.log("\n=== 5. Null scope targets all organizations ===");
  {
    const db = freshDb();
    db.rpcResult = { data: [], error: null };
    await garbageCollectExpiredAnswers(db as unknown as Db, { execute: true });
    const args = db.rpcCalls[0]?.args ?? {};
    check(
      "null organization scope reaches the pruner as unspecified (all orgs)",
      args.p_organization_id === undefined,
    );
  }

  console.log("\n=== 6. Database failure is captured, not thrown past the stats ===");
  {
    const db = freshDb();
    db.rpcResult = { data: null, error: { message: "advisory lock timeout" } };
    const stats = await garbageCollectExpiredAnswers(db as unknown as Db, {
      organizationId: "org-a",
      execute: true,
    });
    check(
      "rpc error surfaces in structured stats.errors",
      stats.errors.length === 1 && stats.errors[0]?.includes("advisory lock timeout") === true,
    );
    check(
      "failed run reports zero deletions",
      stats.expiredRowsDeleted === 0 && stats.capEvictedRowsDeleted === 0 && stats.bodyBytesDeleted === 0,
    );
  }

  console.log("\n=== 7. Empty database result is empty stats, not an error ===");
  {
    const db = freshDb();
    db.rpcResult = { data: null, error: null };
    const stats = await garbageCollectExpiredAnswers(db as unknown as Db, {
      organizationId: "org-b",
      execute: true,
    });
    check(
      "no work to do yields zero counts and no errors",
      stats.expiredRowsDeleted === 0 && stats.capEvictedRowsDeleted === 0 && stats.errors.length === 0,
    );
    check("scope is echoed in stats", stats.organizationId === "org-b");
  }

  console.log("\n=== 8. Global active run sums every organization's rows ===");
  {
    const db = freshDb();
    db.rpcResult = {
      data: [
        { organization_id: "a", expired_rows_deleted: 3, cap_evicted_rows_deleted: 1, body_bytes_deleted: 300 },
        { organization_id: "b", expired_rows_deleted: 0, cap_evicted_rows_deleted: 0, body_bytes_deleted: 0 },
        { organization_id: "c", expired_rows_deleted: 2, cap_evicted_rows_deleted: 4, body_bytes_deleted: 600 },
      ],
      error: null,
    };
    const stats = await garbageCollectExpiredAnswers(db as unknown as Db, { execute: true });
    check("global run sums all organizations", stats.expiredRowsDeleted === 5 && stats.capEvictedRowsDeleted === 5);
    check("global run reports null scope", stats.organizationId === null);
    check("global run sums bytes exactly (no invented row-overhead estimates)", stats.bodyBytesDeleted === 900);
  }

  console.log("\n=== 9. Scoped dry run over the cap reports the exact excess ===");
  {
    const db = new FakeAnswerDb();
    for (let i = 0; i < 15; i++) {
      db.rows.push({ organization_id: "org-a", expires_at: new Date(Date.now() + 3600_000).toISOString(), body: `body-${i}` });
    }
    const stats = await garbageCollectExpiredAnswers(db as unknown as Db, {
      organizationId: "org-a",
      capRowsPerOrg: 10,
    });
    check("over-cap count is rows minus cap (15 in scope, cap 10)", stats.overCapRowsEligible === 5);
    check("dry run still deleted nothing", stats.dryRun === true && db.rpcCalls.length === 0);
    check("expired report stays 0 because all rows are within retention", stats.expiredRowsEligible === 0);
  }
}

run().then(() => {
  console.log("");
  for (const line of results) console.log(line);
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
});
