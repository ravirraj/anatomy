// Accuracy evaluation over the fixture corpus.
//
//   pnpm accuracy
//
// This is not the regression suite: scripts/test-fixtures.ts asks "is the
// parser's output byte-for-byte what it was", this asks "did the parser find
// the dependency relationships that are actually there". The relationships
// that are actually there are hand-verified ground truth, one per fixture, in
// fixtures/accuracy.json.
//
// Both sides are compared at the level of (source, target) pairs, deduplicated
// — which edge kind carries a relationship is the regression suite's business,
// not this. Unresolved, external and excluded imports produce no internal edge
// and are therefore out of scope on both sides by definition. A pair counts
// once however many edge kinds carry it.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseRepository } from "../lib/parser/index.ts";
import { FIXTURES } from "./test-fixtures-shared.ts";

type Counts = { tp: number; fp: number; fn: number };

type Truth = {
  version: number;
  method: string;
  convention: string;
  /** Fixture directory name → the internal dependency pairs it truly holds. */
  fixtures: Record<string, { edges: [string, string][] }>;
};

/**
 * The initial accuracy floor, set to the observed baseline of the completed
 * ten-fixture corpus: the parser found every hand-verified relationship
 * (20/20), invented none, and missed none, so precision, recall and F1 are
 * all 1. A change that falls below this floor fails the evaluation. Raising
 * or lowering it is an edit to this line, deliberate and visible in review,
 * never a silent consequence of anything.
 */
export const MINIMUM_F1 = 1;

/** "no predictions and no truths" is precision, recall and F1 of 1; only one side empty can still yield zero. */
function safeRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function scores({ tp, fp, fn }: Counts): { precision: number; recall: number; f1: number } {
  const precision = safeRatio(tp, tp + fp);
  const recall = safeRatio(tp, tp + fn);
  const f1 = safeRatio(2 * precision * recall, precision + recall);
  return { precision, recall, f1 };
}

/** A comparable identity of an internal dependency relationship. */
function pairOf(source: string, target: string): string {
  return `${source} -> ${target}`;
}

function main(): void {
  let truth: Truth;
  try {
    truth = JSON.parse(readFileSync(path.join(FIXTURES, "accuracy.json"), "utf8")) as Truth;
  } catch (error) {
    console.error(`fixtures/accuracy.json could not be read: ${String(error)}`);
    process.exit(1);
  }

  const fixtureNames = readdirSync(FIXTURES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const name of fixtureNames) {
    if (!(name in truth.fixtures)) {
      console.error(`${name} has repository fixtures but no ground truth in fixtures/accuracy.json.`);
      console.error(`Add hand-verified edges for it — write the fixture, decide from its own sources what its internal relationships are, and record only those.`);
      process.exit(1);
    }
  }
  for (const name of Object.keys(truth.fixtures)) {
    if (!fixtureNames.includes(name)) {
      console.error(`${name} has ground truth but no fixtures/${name}/repo directory.`);
      process.exit(1);
    }
  }

  const counts = new Map<string, Counts>();
  const extra: string[] = [];
  const missed: string[] = [];
  for (const name of fixtureNames) {
    const truthPairs = new Set(truth.fixtures[name].edges.map(([source, target]) => pairOf(source, target)));
    const actual = parseRepository(path.join(FIXTURES, name, "repo"));
    const producedPairs = new Set(actual.edges.map((edge) => pairOf(edge.source, edge.target)));
    const fixtureCounts: Counts = { tp: 0, fp: 0, fn: 0 };
    for (const truthPair of truthPairs) {
      if (producedPairs.has(truthPair)) {
        fixtureCounts.tp += 1;
      } else {
        fixtureCounts.fn += 1;
        missed.push(`  ${name}: ${truthPair}`);
      }
    }
    for (const produced of producedPairs) {
      if (!truthPairs.has(produced)) {
        fixtureCounts.fp += 1;
        extra.push(`  ${name}: ${produced}`);
      }
    }
    counts.set(name, fixtureCounts);
  }

  const aggregate: Counts = { tp: 0, fp: 0, fn: 0 };
  for (const c of counts.values()) {
    aggregate.tp += c.tp;
    aggregate.fp += c.fp;
    aggregate.fn += c.fn;
  }

  const format = (value: number): string => (value === 1 ? "1" : value.toFixed(4));

  console.log("Per fixture");
  console.log(
    `  ${"fixture".padEnd(24)} ${"TP".padStart(2)} ${"FP".padStart(2)} ${"FN".padStart(2)} ${"precision".padStart(9)} ${"recall".padStart(7)} ${"F1".padStart(7)}`,
  );
  for (const name of fixtureNames) {
    const c = counts.get(name)!;
    const { precision, recall, f1 } = scores(c);
    console.log(
      `  ${name.padEnd(24)} ${String(c.tp).padStart(2)} ${String(c.fp).padStart(2)} ${String(c.fn).padStart(2)} ${format(precision).padStart(9)} ${format(recall).padStart(7)} ${format(f1).padStart(7)}`,
    );
  }

  console.log("\nAggregate over all fixtures");
  const overall = scores(aggregate);
  console.log(`  TP ${aggregate.tp}  FP ${aggregate.fp}  FN ${aggregate.fn}`);
  console.log(`  precision ${format(overall.precision)}  recall ${format(overall.recall)}  F1 ${format(overall.f1)}`);
  console.log(`  floor ${format(MINIMUM_F1)} ${overall.f1 >= MINIMUM_F1 ? "met" : "NOT met"}`);

  if (extra.length) {
    console.log("\nFalse positives (internal edges the parser produced and the truth does not hold):");
    console.log(extra.join("\n"));
  }
  if (missed.length) {
    console.log("\nFalse negatives (internal relationships the truth holds and the parser produced no edge for):");
    console.log(missed.join("\n"));
  }

  const best = aggregate.fp === 0 && aggregate.fn === 0;
  console.log(`\nAccuracy   ${fixtureNames.length} fixtures, ${best ? "every hand-verified relationship found, none invented" : `${aggregate.fp} false positives, ${aggregate.fn} false negatives`}`);
  process.exit(overall.f1 >= MINIMUM_F1 ? 0 : 1);
}

main();
