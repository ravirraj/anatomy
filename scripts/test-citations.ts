// Verifies citation checking: an answer that names a file not in the analysis
// is rejected, and honest answers pass.
//
//   node scripts/test-citations.ts

import { pathTokens, verifyCitations, CitationError } from "../lib/ai/citations.ts";
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

console.log("");
for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

// A module, so the awaits above are allowed.
export {};
