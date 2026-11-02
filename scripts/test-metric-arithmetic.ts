// Deterministic unit test for interval merging, line overlap, and micro/macro arithmetic.

import {
  mergeIntervals,
  countIntervalLines,
  calculateIntervalOverlap,
} from "./eval-golden-qa.ts";

const results: string[] = [];
const pass = (m: string) => {
  results.push(`ok    ${m}`);
  console.log(`ok    ${m}`);
};
const fail = (m: string) => {
  results.push(`FAIL  ${m}`);
  console.error(`FAIL  ${m}`);
};

console.log("=== Deterministic Metric Arithmetic Self-Test ===");

// 1. Merging overlapping and adjacent intervals
const intervals1: [number, number][] = [[1, 5], [3, 8], [10, 12]];
const merged1 = mergeIntervals(intervals1);
if (merged1.length === 2 && merged1[0]![0] === 1 && merged1[0]![1] === 8 && merged1[1]![0] === 10 && merged1[1]![1] === 12) {
  pass("overlapping intervals [1,5] and [3,8] merged to [1,8] without double-counting");
} else {
  fail(`unexpected merge: ${JSON.stringify(merged1)}`);
}

const lines1 = countIntervalLines(merged1);
if (lines1 === 11) { // 8 lines (1..8) + 3 lines (10..12) = 11
  pass("countIntervalLines correctly counts 11 unique disjoint lines");
} else {
  fail(`expected 11 lines, got ${lines1}`);
}

// 2. Adjacent intervals merge
const intervals2: [number, number][] = [[1, 3], [4, 6]];
const merged2 = mergeIntervals(intervals2);
if (merged2.length === 1 && merged2[0]![0] === 1 && merged2[0]![1] === 6) {
  pass("adjacent intervals [1,3] and [4,6] merged to [1,6]");
} else {
  fail(`unexpected adjacent merge: ${JSON.stringify(merged2)}`);
}

// 3. Overlap calculation
const ret: [number, number][] = [[1, 10]]; // 10 lines
const gold: [number, number][] = [[4, 6], [8, 9]]; // 3 + 2 = 5 lines
const overlap = calculateIntervalOverlap(ret, gold);
if (overlap === 5) {
  pass("calculateIntervalOverlap correctly computes 5 overlapping lines");
} else {
  fail(`expected overlap 5, got ${overlap}`);
}

// 4. Micro and Macro formulas
const microOverlap = 89;
const microRetrieved = 393;
const microGold = 94;

const microPrec = microOverlap / microRetrieved;
const microRec = microOverlap / microGold;
const microF1 = (2 * microPrec * microRec) / (microPrec + microRec);

if (Math.abs(microPrec - 0.226463) < 1e-4) {
  pass(`micro-precision formula verified: 89/393 = ${(microPrec * 100).toFixed(1)}%`);
} else {
  fail(`micro-precision mismatch: ${microPrec}`);
}

if (Math.abs(microRec - 0.946808) < 1e-4) {
  pass(`micro-recall formula verified: 89/94 = ${(microRec * 100).toFixed(1)}%`);
} else {
  fail(`micro-recall mismatch: ${microRec}`);
}

if (Math.abs(microF1 - 0.365585) < 1e-4) {
  pass(`micro-F1 formula verified: ${(microF1 * 100).toFixed(1)}%`);
} else {
  fail(`micro-F1 mismatch: ${microF1}`);
}

const fails = results.filter((r) => r.startsWith("FAIL"));
if (fails.length > 0) {
  process.exit(1);
}
console.log(`\nAll metric arithmetic checks passed cleanly.`);
