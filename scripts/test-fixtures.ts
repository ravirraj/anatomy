// Runs the parser over every fixture repository and compares the result with
// the fixture's expected.json. A fixture that changes is a failing test, not a
// diff to review; when a change to the parser is intended, re-baseline the
// deliberately and per fixture:
//
//   node scripts/test-fixtures.ts --update <name>
//
// The expected file is the parser's own serializeParseResult output with the
// absolute root replaced by "<repo>", so it is stable across machines and
// round-trips through the contract validator.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deserializeParseResult, serializeParseResult } from "../lib/parser/contract.ts";
import { parseRepository } from "../lib/parser/index.ts";

const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");
const ROOT_PLACEHOLDER = "<repo>";

function baseline(result: ReturnType<typeof parseRepository>): string {
  const text = serializeParseResult(result);
  // Only the root is machine-specific; it is the absolute path parsed from.
  return text.replace(new RegExp(JSON.stringify(result.root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), JSON.stringify(ROOT_PLACEHOLDER));
}

function fromBaseline(text: string): { result: ReturnType<typeof parseRepository> | null; error: unknown } {
  try {
    const expanded = text.replace(JSON.stringify(ROOT_PLACEHOLDER), JSON.stringify(FIXTURES));
    return { result: deserializeParseResult(expanded), error: null };
  } catch (error) {
    return { result: null, error };
  }
}

function firstDifference(before: string, after: string): number {
  const a = before.split("\n");
  const b = after.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return -1;
}

const ok: string[] = [];
const failed: string[] = [];

const updateNames = process.argv.includes("--update") ? new Set(process.argv.slice(process.argv.indexOf("--update") + 1)) : null;

for (const name of readdirSync(FIXTURES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
  const repo = path.join(FIXTURES, name, "repo");
  const expectedPath = path.join(FIXTURES, name, "expected.json");
  if (!updateNames || (updateNames.size && !updateNames.has(name))) {
    let text: string;
    try {
      text = readFileSync(expectedPath, "utf8");
    } catch {
      failed.push(`${name}: no expected.json (run: node scripts/test-fixtures.ts --update ${name})`);
      continue;
    }
    const { result, error } = fromBaseline(text);
    if (!result) {
      failed.push(`${name}: expected.json does not pass the contract validator: ${String(error)}`);
      continue;
    }
    const actual = baseline(parseRepository(repo));
    if (actual === text) {
      ok.push(`${name} (${result.files.length} files, ${result.edges.length} edges, ${result.routes.length} routes, ${result.symbols.length} symbols)`);
      continue;
    }
    const a = text.split("\n");
    const b = actual.split("\n");
    let i = firstDifference(text, actual);
    if (i === -1) i = Math.min(a.length, b.length);
    const context = 2;
    let shown = `${name}: result differs from expected.json, first at line ${i + 1}\n`;
    for (let d = Math.max(0, i - context); d <= Math.min(Math.max(a.length, b.length) - 1, i + context); d += 1) {
      shown += `  ${d === i ? ">" : " "} line ${d + 1}\n`;
      if (a[d] !== b[d]) {
        shown += `    expected: ${a[d] ?? "(none)"}\n    now:      ${b[d] ?? "(none)"}\n`;
      }
    }
    shown += `  An intended change is re-baselined with: node scripts/test-fixtures.ts --update ${name}`;
    failed.push(shown);
  } else {
    const actual = baseline(parseRepository(repo));
    writeFileSync(expectedPath, actual);
    const { error } = fromBaseline(actual);
    if (error) {
      failed.push(`${name}: written baseline does not round-trip: ${String(error)}`);
    } else {
      ok.push(`${name}: baseline written and it round-trips`);
    }
  }
}

function report(): void {
  console.log(`Fixtures   ${ok.length} passed, ${failed.length} failed`);
  for (const line of ok) console.log(`   pass    ${line}`);
  for (const line of failed) console.log(`   FAIL    ${line}`);
  process.exit(failed.length ? 1 : 0);
}

report();
