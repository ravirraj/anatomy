// Integration regression tests for the Q&A citation verification contract:
// evidence must flow end-to-end from retrieval to verification.
//
//   node scripts/test-citation-context-integration.ts
//
// These drive the real production path — `answerQuestion()` →
// `verifyCitationsEvidence()` → `verifyCitations()` — with a mock completion
// and cache, so no model or database is involved. They hold the hard
// invariant that the text verification can rescue tokens from is exactly the
// text the generation prompt contained, and nothing more.

import { answerQuestion, type Cache } from "../lib/ai/tasks.ts";
import { CitationError, type ManifestFile } from "../lib/ai/citations.ts";
import type { QuestionInput } from "../lib/ai/prompts.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

// The mock completion: it records each (system, user) prompt it is asked to
// answer, and returns a pre-scripted body per call. This is where generation
// and verification meet in production — the prompt it was given is the only
// evidence any rescue check may consult.
type RecordedCall = { model: string; system: string; user: string };

function makeHarness(bodies: string[]) {
  const calls: RecordedCall[] = [];
  const cacheStore = new Map<string, string>();
  const cache: Cache = {
    async read(key) {
      return cacheStore.get(key) ?? null;
    },
    async write({ key, body }) {
      cacheStore.set(key, body);
    },
    async delete(key) {
      cacheStore.delete(key);
    },
  };
  let call = 0;
  const complete = async (model: string, system: string, user: string): Promise<string> => {
    calls.push({ model, system, user });
    const body = bodies[call] ?? "";
    call++;
    if (!body) throw new Error(`test misconfigured: no scripted body for completion call ${call}`);
    return body;
  };
  return { calls, cache, cacheStore, complete, nextBody: () => bodies[call] ?? "" };
}

// A rendering of a small lithos-shaped analysis: two retrieved windows, one
// of which quotes a config filename and a default directory as string
// literals. The quoted literals live in the evidence text, not in the
// evidence MAP — this exact asymmetry is what the context forwarding must
// reconcile.
//
//   node scripts/test-citation-context-integration.ts runs with a strict
// allowlist note: `src/stored/never-sent.ts` is a stored-but-unretrieved file
// that is deliberately NOT rendered into any prompt.
const CONTEXT_TEXT = [
  "--- File: src/cli/add.ts (lines 1-40) [hash: ab12cd34] ---",
  `import { readConfig } from './config';
const CONFIG_FILE = readConfig('lithos.json');
const DEFAULT_DIR = './src/components/ui';
const FALLBACK = 'src/boot/defaults.ts';
export function add() { ... }`,
  "",
  "--- File: src/cli/utils.ts (lines 1-20) [hash: ef45ab67] ---",
  "export function readConfig(name) { return name; }",
].join("\n");

const RETRIEVED_FILES = [
  {
    path: "src/cli/add.ts",
    contentHash: "ab12cd34ef45ab67fe12cd34ef45ab67fe12cd34ef45ab67fe12cd34ef45ab67",
    totalLines: 40,
    windows: [{ startLine: 1, endLine: 20 }],
  },
  {
    path: "src/cli/utils.ts",
    contentHash: "ef45ab67fe12cd34ef45ab67fe12cd34ef45ab67fe12cd34ef45ab67fe12cd34",
    totalLines: 20,
  },
];

// Repository-wide stored paths (what allowedAnalysisPaths returns in
// production): superset of the retrieved evidence, on purpose.
const ALL_ANALYSIS_FILES = new Set([
  "src/cli/add.ts",
  "src/cli/utils.ts",
  "src/stored/never-sent.ts",
]);

function baseInput(): QuestionInput {
  return {
    question: "How does the CLI resolve transitive dependencies?",
    contextText: CONTEXT_TEXT,
    files: RETRIEVED_FILES,
  };
}

async function expectError(
  label: string,
  run: () => Promise<unknown>,
  asserted: (err: CitationError) => boolean,
) {
  try {
    await run();
    fail(`${label}: no CitationError was thrown`);
  } catch (err) {
    if (err instanceof CitationError && asserted(err)) {
      pass(label);
    } else {
      fail(`${label}: wrong error — ${(err as Error).message}`);
    }
  }
}

async function run() {
  // Case 1: a path quoted as a string literal in retrieved source code is
  // allowed as a discussion reference. `src/boot/defaults.ts` is quoted in
  // the evidence text but exists in neither the evidence map nor the
  // analysis-wide set.
  {
    const h = makeHarness([
      "The loader falls back to loading `src/boot/defaults.ts` itself when no config is found.",
    ]);
    try {
      const answer = await answerQuestion(baseInput(), { cache: h.cache, complete: h.complete, allAnalysisFiles: ALL_ANALYSIS_FILES, analysisId: "a1" });
      if (!answer.cached) {
        pass("a string literal quoted in retrieved source is allowed as a discussion reference");
      } else {
        fail("case 1 unexpectedly served from cache");
      }
    } catch (err) {
      fail(`case 1 incorrectly rejected: ${(err as Error).message}`);
    }
  }

  // Case 2: `lithos.json` — mentioned only inside retrieved source code —
  // does not trigger a citation error.
  {
    const h = makeHarness(["Configuration is read from `lithos.json` in `src/cli/add.ts#L1-L20`."]);
    try {
      await answerQuestion(baseInput(), { cache: h.cache, complete: h.complete, allAnalysisFiles: ALL_ANALYSIS_FILES, analysisId: "a1" });
      pass("lithos.json quoted in retrieved source does not trigger a citation error");
    } catch (err) {
      fail(`case 2 incorrectly rejected: ${(err as Error).message}`);
    }
  }

  // Case 3: a fabricated, unretrieved path (in neither the evidence map, the
  // analysis-wide set, nor the evidence text) is rejected.
  await expectError(
    "a fabricated unretrieved path is rejected",
    () => {
      const h = makeHarness(["See `src/never/fabricated.ts` for the resolver."]);
      return answerQuestion(baseInput(), { cache: h.cache, complete: h.complete, allAnalysisFiles: ALL_ANALYSIS_FILES, analysisId: "a1" });
    },
    (err) => err.details?.[0]?.includes("Unknown file path") === true && err.paths[0] === "src/never/fabricated.ts",
  );

  // Case 4: an explicit line-cited path that is stored but unretrieved is
  // rejected. Strongest form: the path text IS verbatim in the evidence text
  // (the comment line), yet an explicit line-range citation is still
  // forbidden — the contextText rescue is reserved for bare discussion
  // references and must never route around the evidence map for line
  // citations.
  await expectError(
    "an explicit citation to an unretrieved file is rejected even when its basename is quoted in evidence text",
    () => {
      const h = makeHarness(["See `src/stored/never-sent.ts#L1-L10` for the resolver."]);
      return answerQuestion(baseInput(), { cache: h.cache, complete: h.complete, allAnalysisFiles: ALL_ANALYSIS_FILES, analysisId: "a1" });
    },
    (err) => err.details?.[0]?.includes("not in retrieved evidence") === true && err.paths[0] === "src/stored/never-sent.ts#L1-L10",
  );

  // Case 5: valid retrieved file citations with correct line ranges pass.
  {
    const h = makeHarness([
      "The resolver walks dependencies in `src/cli/add.ts#L1-L20` and reads its defaults in `src/cli/utils.ts`.",
    ]);
    try {
      await answerQuestion(baseInput(), { cache: h.cache, complete: h.complete, allAnalysisFiles: ALL_ANALYSIS_FILES, analysisId: "a1" });
      pass("valid retrieved citations with correct line ranges pass");
    } catch (err) {
      fail(`case 5 incorrectly rejected: ${(err as Error).message}`);
    }
  }

  // Case 6a: an end line beyond the file's known length is rejected.
  await expectError(
    "an end line beyond the file length is rejected",
    () => {
      const h = makeHarness(["The resolver spans `src/cli/add.ts#L1-L99`."]);
      return answerQuestion(baseInput(), { cache: h.cache, complete: h.complete, allAnalysisFiles: ALL_ANALYSIS_FILES, analysisId: "a1" });
    },
    (err) => err.details?.[0]?.includes("exceeds file length") === true,
  );

  // Case 6b: a range retrieved for one file is cited against its own window:
  // file length is fine but the cited range must fall inside the retrieved
  // window(s) for that file.
  await expectError(
    "a line range outside the retrieved window is rejected",
    () => {
      const h = makeHarness(["The resolver spans `src/cli/add.ts#L25-L30`."]);
      return answerQuestion(baseInput(), { cache: h.cache, complete: h.complete, allAnalysisFiles: ALL_ANALYSIS_FILES, analysisId: "a1" });
    },
    (err) => err.details?.[0]?.includes("not within retrieved window(s)") === true,
  );

  // Case 7: the evidence used for verification is exactly the evidence
  // supplied to generation — nothing more. Three assertions:
  //   7a) the rendered prompt contains the caller's contextText verbatim;
  //   7b) a stored-but-never-rendered path is rejected even though it is in
  //       the analysis-wide set (verification may not lean on the repo);
  //   7c) a token rescued by contextText would NOT have been rescued had only
  //       the file-map been consulted — i.e. the rescue is bound to the same
  //       text generation saw.
  {
    // 7a
    const h = makeHarness(["The resolver reads `src/cli/add.ts#L1-L20`."]);
    const question = baseInput();
    await answerQuestion(question, { cache: h.cache, complete: h.complete, allAnalysisFiles: ALL_ANALYSIS_FILES, analysisId: "a1" });
    const sentToGeneration = h.calls[0];
    const rendered = question.contextText.trim();
    if (
      sentToGeneration.system.length > 0 &&
      sentToGeneration.user.includes("<<<") &&
      sentToGeneration.user.includes(rendered)
    ) {
      pass("the prompt sent to generation embeds the caller's evidence text verbatim");
    } else {
      fail("evidence text in the generation prompt differs from question.contextText");
    }

    // 7b: `src/stored/never-sent.ts` is stored (in allAnalysisFiles) but was
    // never rendered into the prompt; verify it stays rejected.
    await expectError(
      "a stored-but-never-rendered path stays rejected even though it is in the analysis-wide set",
      () => {
        const h2 = makeHarness(["Also relevant: `src/stored/never-sent.ts`."]);
        return answerQuestion(baseInput(), { cache: h2.cache, complete: h2.complete, allAnalysisFiles: ALL_ANALYSIS_FILES, analysisId: "a1" });
      },
      (err) => err.details?.[0]?.includes("Unretrieved repository file") === true,
    );

    // 7c: the cached-hit path uses the same forwarded context. Seed the cache
    // with a body that only verifies when the string literal
    // (`src/boot/defaults.ts`, quoted in evidence but absent from the file
    // map) is rescued through the forwarded contextText; a cached body is
    // re-verified against the generation evidence before it is served.
    {
      const cache: Cache = {
        async read() {
          return "The loader falls back to loading `src/boot/defaults.ts` itself when no config is found.";
        },
        async write() {
          /* unreachable */
        },
        async delete() {
          /* unreachable */
        },
      };
      const complete = async (): Promise<string> => {
        throw new Error("case 7c must not call the model for a cache hit");
      };
      try {
        const answer = await answerQuestion(baseInput(), { cache, complete, allAnalysisFiles: ALL_ANALYSIS_FILES, analysisId: "a1" });
        if (answer.cached === true) {
          pass("a cached body quoting an in-evidence string literal verifies with the forwarded context");
        } else {
          fail(`case 7c served non-cached answer: ${JSON.stringify(answer)}`);
        }
      } catch (err) {
        fail(`case 7c cached body rejected: ${(err as Error).message}`);
      }
    }
  }

  // Case 8: standard manifest filenames are never rescued by contextText.
  // The packaging block renders their names unconditionally, so a bare
  // `package.json` mention stays governed by the manifest table
  // (content_status gating through manifestsByPath), not by textual presence.
  const manifestContext = "[Manifests]\n- package.json (npm, declares \"cartograph\")";
  const manifestFiles = [
    {
      path: "lib/auth/session.ts",
      contentHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      totalLines: 120,
    },
  ];
  const manifestInput: QuestionInput = {
    question: "What does package.json declare?",
    contextText: manifestContext,
    files: manifestFiles,
  };
  const manifestRow = (status: ManifestFile["content_status"], analysisId: string): ManifestFile => ({
    path: "package.json",
    content_status: status,
    analysis_id: analysisId,
    rendered: true,
  });

  // 8a: stored + rendered + current analysis — authorized through the gate.
  {
    const h = makeHarness(["The manifest is `package.json` and sessions live in `lib/auth/session.ts`."]);
    try {
      const answer = await answerQuestion(manifestInput, {
        cache: h.cache,
        complete: h.complete,
        manifestsByPath: new Map([["package.json", manifestRow("stored", "a1")]]),
        allAnalysisFiles: ALL_ANALYSIS_FILES,
        analysisId: "a1",
      });
      if (answer.citations.some((c) => c.path === "package.json")) {
        pass("a stored, rendered manifest bare mention passes through the manifest gate");
      } else {
        fail("case 8a did not extract the manifest citation");
      }
    } catch (err) {
      fail(`case 8a incorrectly rejected: ${(err as Error).message}`);
    }
  }

  // 8b: excluded (quarantined) manifest — rejected even though its name is
  // verbatim in the evidence context.
  await expectError(
    "an excluded manifest bare mention stays rejected despite its name being rendered in evidence text",
    () => {
      const h = makeHarness(["The manifest is `package.json`."]);
      return answerQuestion(manifestInput, {
        cache: h.cache,
        complete: h.complete,
        manifestsByPath: new Map([["package.json", manifestRow("excluded", "a1")]]),
        allAnalysisFiles: ALL_ANALYSIS_FILES,
        analysisId: "a1",
      });
    },
    (err) => err.paths.includes("package.json") === true,
  );

  // 8c: absent manifest — rejected.
  await expectError(
    "an absent manifest bare mention stays rejected despite its name being rendered in evidence text",
    () => {
      const h = makeHarness(["The manifest is `package.json`."]);
      return answerQuestion(manifestInput, {
        cache: h.cache,
        complete: h.complete,
        manifestsByPath: new Map([["package.json", manifestRow("absent", "a1")]]),
        allAnalysisFiles: ALL_ANALYSIS_FILES,
        analysisId: "a1",
      });
    },
    (err) => err.paths.includes("package.json"),
  );

  // 8d: foreign analysis lineage — rejected.
  await expectError(
    "a foreign-analysis manifest bare mention stays rejected despite its name being rendered in evidence text",
    () => {
      const h = makeHarness(["The manifest is `package.json`."]);
      return answerQuestion(manifestInput, {
        cache: h.cache,
        complete: h.complete,
        manifestsByPath: new Map([["package.json", manifestRow("stored", "analysis-foreign")]]),
        allAnalysisFiles: ALL_ANALYSIS_FILES,
        analysisId: "a1",
      });
    },
    (err) => err.paths.includes("package.json"),
  );
}

run()
  .then(() => {
    console.log("");
    for (const line of results) console.log(line);
    const failed = results.filter((r) => r.startsWith("FAIL")).length;
    console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
