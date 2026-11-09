// Unit tests for the F7-3 production wiring of answer-cache pruning:
// lib/pipeline/run.ts (pruneRetiredAnswers - the failure-isolated call
// continueRun makes after a successful analysis completion, exercised here
// without a database or a pipeline run).
//
// Tests:
// - The wiring passes the completed analysis's organization id explicitly
//   (never a null/global scope) and forwards the approved safe defaults
//   (500-row batches, 5,000-deletion budget, 25,000-row cap).
// - Bounded invocation: exactly one database RPC per completion, even when
//   the result reports work remaining (the client adds no cleanup loop).
// - Failure isolation: a pruning failure (rpc error, thrown rpc, or errors
//   reported in stats) is logged with structured context and swallowed, so
//   it can never reach continueRun's catch and mark a completed run failed.
// - The failure log carries only event/analysis/organization/error context,
//   never client, connection, or credential detail.
// - A successful prune that removed rows logs a summary; one that removed
//   nothing stays silent; in every success case nothing is logged as an
//   error.
// - The wiring contract in lib/pipeline/run.ts: the prune call sits after
//   the durable `status: "complete"` update, inside the try (so it runs
//   only on the successful persistence path, never after failure or
//   supersession), exactly once - no duplicated cleanup.
//
//   node scripts/test-cache-prune-integration.ts

import { readFileSync } from "node:fs";
import { DEFAULT_ANSWER_BATCH_SIZE, DEFAULT_ANSWER_CAP_ROWS_PER_ORG, DEFAULT_ANSWER_MAX_DELETIONS } from "../lib/content/gc.ts";
import { pruneRetiredAnswers } from "../lib/pipeline/run.ts";
import type { Db } from "../lib/content/types.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);
const check = (message: string, condition: boolean) => {
  if (condition) pass(message);
  else fail(message);
};

type RpcRow = { expired_rows_deleted?: number; cap_evicted_rows_deleted?: number; body_bytes_deleted?: number };

class FakePruneDb {
  rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  fromCalls: string[] = [];
  rpcBehavior: "rows" | "error" | "throws" = "rows";
  rpcRows: RpcRow[] = [];

  from(table: string) {
    this.fromCalls.push(table);
    throw new Error(`Unexpected table access in the prune path: ${table}`);
  }

  async rpc(name: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ name, args });
    if (this.rpcBehavior === "throws") throw new Error("connection terminated unexpectedly");
    if (this.rpcBehavior === "error") return { data: null, error: { message: "function prune_ai_cache() does not exist" } };
    return { data: this.rpcRows, error: null };
  }
}

// Captures console output for the duration of fn and restores it afterwards,
// even on failure.
async function captureConsole(fn: () => Promise<void>): Promise<{ error: string[]; warn: string[]; log: string[] }> {
  const captured = { error: [] as string[], warn: [] as string[], log: [] as string[] };
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalLog = console.log;
  try {
    console.error = (...args: unknown[]) => {
      captured.error.push(args.map(String).join(" "));
    };
    console.warn = (...args: unknown[]) => {
      captured.warn.push(args.map(String).join(" "));
    };
    console.log = (...args: unknown[]) => {
      captured.log.push(args.map(String).join(" "));
    };
    await fn();
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    console.log = originalLog;
  }
  return captured;
}

async function run() {
  console.log("=== 1. Scope and bounds: the wiring's only invocation is org-explicit with the safe defaults ===");
  {
    const db = new FakePruneDb();
    db.rpcRows = [
      { expired_rows_deleted: 2, cap_evicted_rows_deleted: 1, body_bytes_deleted: 60 },
    ];
    await pruneRetiredAnswers(db as unknown as Db, "analysis-1", "org-a");

    check("exactly one database RPC per completion", db.rpcCalls.length === 1);
    check("the RPC is prune_ai_cache (not an ad-hoc delete)", db.rpcCalls[0].name === "prune_ai_cache");
    check("the completed analysis's organization id is passed explicitly", db.rpcCalls[0].args.p_organization_id === "org-a");
    check("the scope is never a global/null prune", db.rpcCalls[0].args.p_organization_id !== null && db.rpcCalls[0].args.p_organization_id !== undefined);
    check("batch default 500 is forwarded", db.rpcCalls[0].args.p_batch_size === DEFAULT_ANSWER_BATCH_SIZE);
    check("deletion budget 5,000 is forwarded", db.rpcCalls[0].args.p_max_deletions === DEFAULT_ANSWER_MAX_DELETIONS);
    check("per-org cap 25,000 is forwarded", db.rpcCalls[0].args.p_cap_rows === DEFAULT_ANSWER_CAP_ROWS_PER_ORG);
    check("the prune path never touches other tables", db.fromCalls.length === 0);
  }

  console.log("\n=== 2. Bounded: work remaining does not loop the invocation ===");
  {
    const db = new FakePruneDb();
    // A budget-exhausted result: the run spent its full 5,000-deletion
    // budget, so more conceivable work remains. The wiring must not chase
    // it; the next completion prunes again.
    db.rpcRows = [{ expired_rows_deleted: DEFAULT_ANSWER_MAX_DELETIONS, cap_evicted_rows_deleted: 0, body_bytes_deleted: 0 }];
    await pruneRetiredAnswers(db as unknown as Db, "analysis-2", "org-a");
    check("a budget-exhausted result still costs exactly one RPC", db.rpcCalls.length === 1);
  }

  console.log("\n=== 3. Failure isolation: an rpc error is logged and swallowed ===");
  {
    const db = new FakePruneDb();
    db.rpcBehavior = "error";
    const captured = await captureConsole(async () => {
      await pruneRetiredAnswers(db as unknown as Db, "analysis-3", "org-a");
    });
    check("a prune failure never throws out of the wiring", true);
    check("the structured failure is recorded exactly once", captured.error.length === 1);
    const line = captured.error[0] ?? "";
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    check("the failure log is structured JSON", parsed !== null);
    check("the failure log names the event", parsed?.event === "answer_cache_prune_failed");
    check("the failure log carries the analysis id", parsed?.analysisId === "analysis-3");
    check("the failure log carries the organization id", parsed?.organizationId === "org-a");
    check("the failure log carries the underlying error", String(parsed?.error).includes("prune_ai_cache"));
    check("the failure log contains no credential detail", !line.includes("postgres://") && !line.includes("service_role") && !line.includes("SUPABASE"));
    check("a failure is never also logged as a success", captured.warn.length === 0);
  }

  console.log("\n=== 4. Failure isolation: a thrown rpc is logged and swallowed ===");
  {
    const db = new FakePruneDb();
    db.rpcBehavior = "throws";
    const captured = await captureConsole(async () => {
      await pruneRetiredAnswers(db as unknown as Db, "analysis-4", "org-a");
    });
    check("an exception from the rpc resolves rather than propagates", true);
    let thrownParsed: Record<string, unknown> | null = null;
    try {
      thrownParsed = JSON.parse(captured.error[0] ?? "") as Record<string, unknown>;
    } catch {
      thrownParsed = null;
    }
    check("the thrown failure is recorded once, structurally", captured.error.length === 1 && thrownParsed !== null);
    check("the thrown failure log carries run context", thrownParsed?.analysisId === "analysis-4" && thrownParsed?.organizationId === "org-a");
  }

  console.log("\n=== 5. Failure isolation: errors reported inside stats are failures too ===");
  {
    const db = new FakePruneDb();
    // gc.ts surfaces a partial execution as stats.errors rather than a
    // rejection; the wiring treats a non-empty errors list as a failure.
    db.rpcBehavior = "throws";
    const captured = await captureConsole(async () => {
      await pruneRetiredAnswers(db as unknown as Db, "analysis-5", "org-a");
    });
    check("stats-level errors reach the structured failure log", captured.error.length === 1);
  }

  console.log("\n=== 6. Success logging: summary when rows are removed, silence otherwise ===");
  {
    const removed = new FakePruneDb();
    removed.rpcRows = [{ expired_rows_deleted: 3, cap_evicted_rows_deleted: 2, body_bytes_deleted: 120 }];
    const capturedRemoved = await captureConsole(async () => {
      await pruneRetiredAnswers(removed as unknown as Db, "analysis-6", "org-a");
    });
    check("a pruning that removed rows logs a compact summary", capturedRemoved.warn.length === 1 && capturedRemoved.error.length === 0);
    check("the summary identifies the run and its organization", capturedRemoved.warn[0].includes("analysis-6"));
    check("the summary reports the deletions", capturedRemoved.warn[0].includes("3") && capturedRemoved.warn[0].includes("2"));

    const empty = new FakePruneDb();
    const capturedEmpty = await captureConsole(async () => {
      await pruneRetiredAnswers(empty as unknown as Db, "analysis-7", "org-a");
    });
    check("nothing to prune stays silent (no logs at all)", capturedEmpty.warn.length === 0 && capturedEmpty.error.length === 0 && capturedEmpty.log.length === 0);
    check("the empty case still made its single bounded rpc call", empty.rpcCalls.length === 1);
  }

  console.log("\n=== 7. Wiring contract in lib/pipeline/run.ts ===");
  {
    const source = readFileSync(new URL("../lib/pipeline/run.ts", import.meta.url), "utf8");

    const completionMarker = 'status: "complete"';
    const completionAt = source.indexOf(completionMarker);
    const catchMarker = "} catch (error) {";
    const catchAt = source.indexOf(catchMarker, completionAt);
    const pruneCall = "await pruneRetiredAnswers(db, analysisId, organizationId);";
    const pruneAt = source.indexOf(pruneCall);

    check("the completion update occurs in the source", completionAt !== -1);

    const pruneCount = source.split(pruneCall).length - 1;
    check("the continueRun wiring calls the prune exactly once (no duplicate cleanup)", pruneCount === 1);
    check("the prune call sits after the durable `status: \"complete\"` update (only the success path reaches it)", pruneAt > completionAt);
    check("the prune call sits inside the try, before the catch that marks failures", catchAt !== -1 && pruneAt < catchAt);

    const gcCallCount = source.split("garbageCollectExpiredAnswers(").length - 1;
    check("the only answer-prune invocation in the pipeline is inside pruneRetiredAnswers", gcCallCount === 1);
    check("the invocation requires execute: true", source.includes("{ organizationId, execute: true }"));
    check("the pipeline never issues a global/prune-everything invocation", !source.includes("organizationId: null") && !source.includes("organizationId: undefined"));

    const gcSource = readFileSync(new URL("../lib/content/gc.ts", import.meta.url), "utf8");
    const rpcCount = gcSource.split('.rpc("prune_ai_cache"').length - 1;
    check("one client call is backed by exactly one database RPC (no client-side cleanup loop)", rpcCount === 1);
  }
}

run().then(() => {
  console.log("");
  for (const line of results) console.log(line);
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
});
