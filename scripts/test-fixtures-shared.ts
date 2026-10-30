// Constants and helpers both fixture scripts share: scripts/test-fixtures.ts
// (the regression suite) and scripts/accuracy-fixtures.ts (the accuracy
// evaluation). Nothing here runs either suite.

import path from "node:path";
import { readFileSync } from "node:fs";
import { deserializeParseResult, serializeParseResult } from "../lib/parser/contract.ts";
import type { ParseResult } from "../lib/parser/types.ts";

/** Where the corpus lives: fixtures/<name>/repo plus fixtures/<name>/expected.json. */
export const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");

const ROOT_PLACEHOLDER = "<repo>";

/**
 * The parser's own serialized output for a result, with the absolute root
 * replaced by a placeholder, so an expected file is machine-independent.
 */
export function baseline(result: ParseResult): string {
  const text = serializeParseResult(result);
  return text.replace(new RegExp(JSON.stringify(result.root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), JSON.stringify(ROOT_PLACEHOLDER));
}

/**
 * Git may hold an expected file with CRLF line endings (core.autocrlf), so it
 * is read back normalised to LF before it is compared: the parser's output is
 * LF, and a line-ending difference is not a parser change.
 */
export function readBaseline(expectedPath: string): string {
  return readFileSync(expectedPath, "utf8").replace(/\r\n/g, "\n");
}

/** A baseline expanded back to an absolute root, and checkable by the contract. */
export function expandBaseline(text: string): ParseResult {
  const expanded = text.replace(JSON.stringify(ROOT_PLACEHOLDER), JSON.stringify(FIXTURES));
  return deserializeParseResult(expanded);
}

export { ROOT_PLACEHOLDER };
