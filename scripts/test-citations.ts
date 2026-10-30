// Verifies citation checking: an answer that names a file not in the analysis
// is rejected, and honest answers pass.
//
//   node scripts/test-citations.ts

import {
  pathTokens,
  verifyCitations,
  CitationError,
  parseCitation,
  extractCitations,
  type FileEvidence,
} from "../lib/ai/citations.ts";
import { explainFile } from "../lib/ai/tasks.ts";
import type { FileInput } from "../lib/ai/prompts.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

const allowed = new Set([
  "lib/ai/tasks.ts",
  "lib/ai/prompts.ts",
  "components/explanation-text.tsx",
  "app/(workspace)/analyses/[id]/actions.ts",
]);

{
  // Code-span mentions of real paths pass.
  const bad = verifyCitations("See `lib/ai/tasks.ts` and `components/explanation-text.tsx`.", allowed);
  if (bad.paths.length === 0) pass("real code-span paths are allowed");
  else fail(`real paths flagged: ${JSON.stringify(bad.paths)}`);
}

{
  // A made-up filename spliced into an honest answer is rejected — the exact
  // acceptance criterion from TODO §3.1.
  const bad = verifyCitations(
    "This file holds one helper. It is used by `does-not-exist.ts`.",
    allowed,
  );
  if (bad.paths.length === 1 && bad.paths[0] === "does-not-exist.ts") {
    pass("an invented path is caught and named");
  } else {
    fail(`invented path not caught: ${JSON.stringify(bad.paths)}`);
  }
}

{
  // Bare (unbackticked) paths are caught too — the renderer links them.
  const bad = verifyCitations("Read lib/ai/prompts.ts for the wording.", allowed);
  if (bad.paths.length === 0) pass("a real bare path is allowed");
  else fail(`real bare path flagged: ${JSON.stringify(bad.paths)}`);
}

{
  const bad = verifyCitations("Read lib/ai/fake.ts for the wording.", allowed);
  if (bad.paths.length === 1 && bad.paths[0] === "lib/ai/fake.ts") {
    pass("an invented bare path is caught");
  } else {
    fail(`invented bare path not caught: ${JSON.stringify(bad.paths)}`);
  }
}

{
  // Punctuation-adjacent mentions are not false positives.
  const bad = verifyCitations("See `lib/ai/tasks.ts`.", allowed);
  if (bad.paths.length === 0) pass("trailing punctuation is stripped");
  else fail(`punctuation-adjacent real path flagged: ${JSON.stringify(bad.paths)}`);
}

{
  // Bold and inline code inside bold are still scanned.
  const bad = verifyCitations("See **`lib/ai/tasks.ts`** and **`lib/ai/ghost.ts`**.", allowed);
  if (bad.paths.length === 1 && bad.paths[0] === "lib/ai/ghost.ts") {
    pass("invented path inside bold code span is caught");
  } else {
    fail(`bold code-span check wrong: ${JSON.stringify(bad.paths)}`);
  }
}

{
  // Italics lose their markers and don't create false positives.
  const bad = verifyCitations("The *lib/ai/tasks.ts* file does the work.", allowed);
  if (bad.paths.length === 0) pass("italic real path allowed");
  else fail(`italic real path flagged: ${JSON.stringify(bad.paths)}`);
}

{
  // Relative forms normalize to stored paths.
  const bad = verifyCitations("See `./lib/ai/tasks.ts`.", allowed);
  if (bad.paths.length === 0) pass("relative form normalizes");
  else fail(`relative form flagged: ${JSON.stringify(bad.paths)}`);
}

{
  // A directory that isn't itself in the allowed set is still flagged.
  const bad = verifyCitations("See `lib/ai/`.", allowed);
  if (bad.paths.length === 1 && bad.paths[0] === "lib/ai/") {
    pass("a directory not in the allowed set is flagged");
  } else {
    fail(`directory check wrong: ${JSON.stringify(bad.paths)}`);
  }
}

{
  // pathTokens collects candidates without the allowed-set gate.
  const tokens = pathTokens("`lib/ai/tasks.ts` and `components/explanation-text.tsx`");
  if (tokens.length === 2 && tokens[0] === "lib/ai/tasks.ts") pass("pathTokens extracts code spans");
  else fail(`pathTokens wrong: ${JSON.stringify(tokens)}`);
}

{
  // CitationError names the offending paths.
  try {
    throw new CitationError(["ghost.ts", "phantom.ts"]);
  } catch (error) {
    if (error instanceof CitationError && error.paths.join(",") === "ghost.ts,phantom.ts") {
      pass("CitationError carries its paths");
    } else {
      fail(`CitationError malformed: ${(error as Error).message}`);
    }
  }
}

{
  // A cache hit is verified before being served — no model call happens.
  const question: FileInput = {
    path: "lib/thing.ts",
    hash: "abc123",
    role: null,
    reachedBy: null,
    exports: [],
    imports: [],
    importedBy: [],
  };
  const badCache = {
    async read() {
      return "This answer names `lib/ghost.ts`, which was never parsed.";
    },
    async write() {
      fail("a failing answer must never be written to the cache");
    },
  };
  let threw = false;
  try {
    await explainFile(question, { cache: badCache, source: async () => "export const thing = 1;" });
  } catch (error) {
    threw = error instanceof CitationError && error.paths.join(",") === "lib/ghost.ts";
  }
  if (threw) pass("a cached answer with an invented path is refused");
  else fail("a cached bad answer was served");
}

{
  // parseCitation handles all supported line range formats.
  const c1 = parseCitation("lib/ai/tasks.ts#L10-L25");
  if (c1.path === "lib/ai/tasks.ts" && c1.startLine === 10 && c1.endLine === 25) {
    pass("parseCitation parses #L10-L25 format");
  } else {
    fail(`parseCitation #L10-L25 failed: ${JSON.stringify(c1)}`);
  }

  const c2 = parseCitation("lib/ai/tasks.ts:15-30");
  if (c2.path === "lib/ai/tasks.ts" && c2.startLine === 15 && c2.endLine === 30) {
    pass("parseCitation parses :15-30 format");
  } else {
    fail(`parseCitation :15-30 failed: ${JSON.stringify(c2)}`);
  }

  const c3 = parseCitation("lib/ai/tasks.ts#L42");
  if (c3.path === "lib/ai/tasks.ts" && c3.startLine === 42 && c3.endLine === 42) {
    pass("parseCitation parses single line #L42 format");
  } else {
    fail(`parseCitation #L42 failed: ${JSON.stringify(c3)}`);
  }

  const c4 = parseCitation("./lib/ai/tasks.ts");
  if (c4.path === "lib/ai/tasks.ts" && c4.startLine === undefined) {
    pass("parseCitation normalizes bare path without line numbers");
  } else {
    fail(`parseCitation bare path failed: ${JSON.stringify(c4)}`);
  }
}

{
  // extractCitations extracts distinct citations with line ranges from markdown.
  const md = "See `lib/ai/tasks.ts#L10-L25` and also `components/explanation-text.tsx:5-15`. Again `lib/ai/tasks.ts#L10-L25`.";
  const extracted = extractCitations(md);
  if (extracted.length === 2 && extracted[0].startLine === 10 && extracted[1].startLine === 5) {
    pass("extractCitations extracts and deduplicates citations");
  } else {
    fail(`extractCitations failed: ${JSON.stringify(extracted)}`);
  }
}

{
  // Line range checks with Map<string, FileEvidence>
  const evidenceMap = new Map<string, FileEvidence>([
    ["lib/ai/tasks.ts", { lines: 100, contentHash: "hash1" }],
    ["components/explanation-text.tsx", { lines: 50, contentHash: "hash2" }],
  ]);

  // Valid citation within file line bounds
  const valid = verifyCitations("See `lib/ai/tasks.ts#L10-L25` and `components/explanation-text.tsx#L5-L50`.", evidenceMap);
  if (valid.paths.length === 0) {
    pass("valid line ranges within file bounds are accepted");
  } else {
    fail(`valid line ranges flagged: ${JSON.stringify(valid)}`);
  }

  // Out of bounds end line (> maxLines)
  const outOfBounds = verifyCitations("See `lib/ai/tasks.ts#L10-L150`.", evidenceMap);
  if (outOfBounds.paths.length === 1 && outOfBounds.paths[0] === "lib/ai/tasks.ts#L10-L150") {
    pass("out of bounds line range (> file lines) is rejected");
  } else {
    fail(`out of bounds line range not caught: ${JSON.stringify(outOfBounds)}`);
  }

  // Inverted line range (start > end)
  const inverted = verifyCitations("See `lib/ai/tasks.ts#L30-L20`.", evidenceMap);
  if (inverted.paths.length === 1) {
    pass("inverted line range (start > end) is rejected");
  } else {
    fail(`inverted line range not caught: ${JSON.stringify(inverted)}`);
  }

  // Start line < 1
  const zeroLine = verifyCitations("See `lib/ai/tasks.ts#L0-L20`.", evidenceMap);
  if (zeroLine.paths.length === 1) {
    pass("zero line number (start < 1) is rejected");
  } else {
    fail(`zero line number not caught: ${JSON.stringify(zeroLine)}`);
  }

  // Unknown file with line range
  const unknownWithRange = verifyCitations("See `lib/ai/unknown.ts#L10-L20`.", evidenceMap);
  if (unknownWithRange.paths.length === 1 && unknownWithRange.paths[0] === "lib/ai/unknown.ts#L10-L20") {
    pass("unknown file with line range is rejected");
  } else {
    fail(`unknown file with line range not caught: ${JSON.stringify(unknownWithRange)}`);
  }
}

console.log("");
for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

// A module, so the awaits above are allowed.
export {};
