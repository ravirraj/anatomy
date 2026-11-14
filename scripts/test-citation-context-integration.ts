// Integration regression tests for the Q&A citation verification contract:
// evidence must flow end-to-end from retrieval to verification.
//
//   node scripts/test-citation-context-integration.ts
//
// These drive the real production path — `answerQuestion()` →
// `verifyCitationsEvidence()` → `verifyCitations()` — with a mock completion
// and cache, so no model or database is involved. They hold the hard
// invariant that only the structured evidence map and the manifest gate ground
// citations: a path's textual appearance in the rendered prompt (a quoted
// string literal, a comment, packaging text) is never evidence (Phase 2, F5).
// The prompt itself still embeds the caller's context text verbatim — that is
// generation input, not a verification source.

import { answerQuestion, explainFile, explainFolder, type Cache } from "../lib/ai/tasks.ts";
import { CitationError, type ManifestFile } from "../lib/ai/citations.ts";
import type { FileInput, FolderInput, QuestionInput } from "../lib/ai/prompts.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

// The mock completion: it records each (system, user) prompt it is asked to
// answer, and returns a pre-scripted body per call. This is where generation
// meets verification: the prompt it was given is generation input only —
// verification consults no rendered text at all.
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
// literals. The quoted literals live in the prompt text — and, since the F5
// fix, in NO verification input: only served evidence and the manifest gate
// decide.
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
  // rejected (F5): `src/boot/defaults.ts` is quoted in the prompt text but
  // exists in neither the evidence map nor the analysis-wide set — a text
  // mention is not evidence, and a nonexistent-file reference is refused.
  await expectError(
    "a string literal quoted in retrieved source is no longer a discussion reference (F5)",
    () => {
      const h = makeHarness([
        "The loader falls back to loading `src/boot/defaults.ts` itself when no config is found.",
      ]);
      return answerQuestion(baseInput(), { cache: h.cache, complete: h.complete, allAnalysisFiles: ALL_ANALYSIS_FILES, analysisId: "a1" });
    },
    (err) => err.details?.[0]?.includes("Unknown file path") === true && err.paths[0] === "src/boot/defaults.ts",
  );

  // Case 2: `lithos.json` — mentioned only inside retrieved source code — is
  // rejected (F5). Trade-off, recorded: this downstream config filename is
  // neither served evidence nor a tracked standard manifest, so a code-span
  // quote of it no longer passes; the filename remains discussable in prose
  // without a code span (not a citation shape). Supporting it citably would
  // require the parser to track and render it as manifest evidence — out of
  // the F5 scope.
  await expectError(
    "lithos.json quoted in retrieved source no longer triggers a pass (F5 trade-off)",
    () => {
      const h = makeHarness(["Configuration is read from `lithos.json` in `src/cli/add.ts#L1-L20`."]);
      return answerQuestion(baseInput(), { cache: h.cache, complete: h.complete, allAnalysisFiles: ALL_ANALYSIS_FILES, analysisId: "a1" });
    },
    (err) => err.paths.includes("lithos.json") === true,
  );

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
  // rejected. Strongest form: the path text IS verbatim in the prompt text
  // (the comment line), yet an explicit line-range citation is still
  // forbidden — rendered text is not a verification input at all (F5), for
  // bare mentions and line citations alike.
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
  //   7c) a cached body is re-verified against the *structured* evidence
  //       before it is served: a body whose citations pass only because of
  //       rendered text (the F5 rescue shape) is invalidated, the entry is
  //       deleted, and exactly one fresh completion runs — no recursion.
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

    // 7c: a pre-seeded cache body that verifies only against rendered text
    // (`src/boot/defaults.ts` quoted from served source but in no evidence
    // structure) is refuted on the hit path, the entry is deleted, and one
    // fresh regeneration runs; the fresh body faces the same verification
    // before it is served or cached.
    let deletes = 0;
    const completes: string[] = [];
    let written: string | undefined;
    const cache: Cache = {
      async read() {
        return "The loader falls back to loading `src/boot/defaults.ts` itself when no config is found.";
      },
      async write({ body }) {
        written = body;
      },
      async delete() {
        deletes++;
      },
    };
    const complete = async (): Promise<string> => {
      const body = "The resolver walks dependencies in `src/cli/add.ts#L1-L20` and reads its defaults in `src/cli/utils.ts`.";
      completes.push(body);
      return body;
    };
    {
      const answer = await answerQuestion(baseInput(), { cache, complete, allAnalysisFiles: ALL_ANALYSIS_FILES, analysisId: "a1" });
      if (
        deletes === 1 &&
        completes.length === 1 &&
        answer.cached === false &&
        answer.body.includes("`src/cli/utils.ts`") &&
        written === answer.body
      ) {
        pass("a text-anchored cached body is invalidated, deleted, and regenerated exactly once (F5)");
      } else {
        fail(`7c contract wrong (deletes=${deletes}, completes=${completes.length}, cached=${answer.cached})`);
      }
    }

    // 7d: if the fresh body has the same flaw, the ask refuses entirely and
    // nothing new is written to the cache.
    {
      deletes = 0;
      completes.length = 0;
      const refusing: Cache = {
        async read() {
          return null;
        },
        async write() {
          throw new Error("case 7d must never cache a refused body");
        },
        async delete() {
          deletes++;
        },
      };
      const badComplete = async (): Promise<string> => {
        const body = "The loader falls back to loading `src/boot/defaults.ts` itself when no config is found.";
        completes.push(body);
        return body;
      };
      await expectError(
        "a fresh body whose only grounding is rendered text is refused and not cached (F5)",
        () => answerQuestion(baseInput(), { cache: refusing, complete: badComplete, allAnalysisFiles: ALL_ANALYSIS_FILES, analysisId: "a1" }),
        (err) => err.details?.[0]?.includes("Unknown file path") === true,
      );
      if (deletes === 0 && completes.length === 1) {
        pass("the refused fresh answer wrote nothing to the cache and regenerated at most once");
      } else {
        fail(`7d singles wrong (deletes=${deletes}, completes=${completes.length})`);
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

// ---- Phase 2, F8: the explain legacy tier verifies whole-file paths only. --
// explainFile/explainFolder have no completions DI seam (unlike
// answerQuestion, which takes `complete` in deps), so the OpenAI-compatible
// transport is intercepted at globalThis.fetch with a canned completion: the
// real pinned-model path, prompt-budget assertions, termination checks and the
// internal verify-then-write order all still run; no request leaves the
// process and no cached store is consulted.
//
//   F8 fixture contract: `lib/auth/session.ts` is the explained file whose
//   source is woven into the message; `lib/db/client.ts` is an import
//   neighbour whose NAME is supplied but whose source never is; the folder
//   message carries no source at all. Line numbers are therefore never
//   line-addressable evidence in either task, and a line-cited token must be
//   refused at write time (fresh) and at serve time (cache hit).
{
  const fileInput: FileInput = {
    path: "lib/auth/session.ts",
    hash: "f8-fixture-hash",
    role: "session",
    reachedBy: null,
    exports: ["createSession"],
    imports: [{ path: "lib/db/client.ts", role: "store", exports: ["db"], kinds: [], typeOnly: false }],
    importedBy: [],
  };
  const folderInput: FolderInput = {
    dir: "src/auth",
    files: [
      { path: "src/auth/session.ts", hash: "h1", role: "session", exports: ["createSession"], fanIn: 1, fanOut: 1 },
      { path: "src/auth/token.ts", hash: "h2", role: null, exports: [], fanIn: 0, fanOut: 0 },
    ],
    incoming: [{ from: "app/middleware.ts", to: "src/auth/session.ts" }],
    outgoing: [{ from: "src/auth/session.ts", to: "lib/db/client.ts" }],
  };

  const stubbedBody: { text: string } = { text: "" };
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls++;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/chat/completions")) return new Response(JSON.stringify({ error: "unexpected request" }), { status: 400 });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: stubbedBody.text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    // The client is constructed on first use and would throw before any
    // fetch if no key were resolvable; the stub itself receives every
    // request, so no endpoint is contacted regardless of the key's value.
    process.env.OPENAI_API_KEY ||= "f8-integration-stub-key";

    // F8-1: a fresh explanation whose model output carries a line-cited
    // citation is refused BEFORE anything is cached: one generation, an
    // empty write path, nothing deleted.
    {
      stubbedBody.text = "Sessions execute via `lib/auth/session.ts#L1-L20`.";
      let wrote: string | undefined;
      let deleted = 0;
      const cache: Cache = {
        async read() {
          return null;
        },
        async write({ body }) {
          wrote = body;
        },
        async delete() {
          deleted++;
        },
      };
      await expectError(
        "a fresh explanation with a line-bound citation is refused and not cached (F8)",
        () => explainFile(fileInput, { cache, source: async () => "export function createSession() { return null; }" }),
        (err) =>
          err.paths.includes("lib/auth/session.ts#L1-L20") === true &&
          (err.details?.[0] ?? "").includes("Unverifiable line citation") === true,
      );
      if (fetchCalls === 1 && wrote === undefined && deleted === 0) {
        pass("the refused fresh explanation generated exactly once, cached nothing, deleted nothing");      } else {
        fail(`F8-1 cache seam wrong (fetch=${fetchCalls}, wrote=${wrote ? "set" : "none"}, deleted=${deleted})`);
      }
    }

    // Control (F8-1b): the same transport answering a whole-path body is
    // served and cached — the refusal is the line token, not the mouth.
    {
      stubbedBody.text = "Sessions execute in `lib/auth/session.ts`, storing tokens in `lib/db/client.ts`.";
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
      const answer = await explainFile(fileInput, { cache, source: async () => "export function createSession() { return null; }" });
      if (answer.cached === false && fetchCalls === 2 && cacheStore.size === 1) {
        pass("a whole-path fresh explanation is served and cached (F8 control)");
      } else {
        fail(`F8-1b control wrong (cached=${answer.cached}, fetch=${fetchCalls}, store=${cacheStore.size})`);
      }
    }

    // F8-2: a poisoned cached explain-file body with a fabricated line
    // citation is refused at serve time — and stays fail-closed without
    // healing: no delete, no regeneration (the explain tasks have no healing
    // seam; unchanged behaviour, superseded only in what passes).
    {
      const preCalls = fetchCalls;
      let deleted = 0;
      const cache: Cache = {
        async read() {
          return "Sessions execute via `lib/auth/session.ts#L1-L20`.";
        },
        async write() {
          throw new Error("F8-2 must never write on a refused hit");
        },
        async delete() {
          deleted++;
        },
      };
      await expectError(
        "an explain-file cached answer with a fabricated line citation is refused on the hit path (F8)",
        () =>
          explainFile(fileInput, {
            cache,
            source: async () => {
              throw new Error("the source must not be read while serving a cache hit");
            },
          }),
        (err) =>
          err.paths.includes("lib/auth/session.ts#L1-L20") === true &&
          (err.details?.[0] ?? "").includes("Unverifiable line citation") === true,
      );
      if (fetchCalls === preCalls && deleted === 0) {
        pass("the refused explain-file hit made no model call and left the cache intact (fail-closed, no healing)");
      } else {
        fail(`F8-2 seam wrong (modelDelta=${fetchCalls - preCalls}, deleted=${deleted})`);
      }
    }

    // F8-3: the same for explain-folder — the folder message serves no source
    // at all, so a fabricated member line range is refused on the hit path.
    {
      let deleted = 0;
      const cache: Cache = {
        async read() {
          return "Auth lives in `src/auth`; the token logic runs in `src/auth/token.ts#L1-L40`.";
        },
        async write() {
          throw new Error("F8-3 must never write on a refused hit");
        },
        async delete() {
          deleted++;
        },
      };
      await expectError(
        "an explain-folder cached answer with a fabricated line citation is refused on the hit path (F8)",
        () => explainFolder(folderInput, { cache }),
        (err) =>
          err.paths.includes("src/auth/token.ts#L1-L40") === true &&
          (err.details?.[0] ?? "").includes("Unverifiable line citation") === true,
      );
      if (deleted === 0) {
        pass("the refused explain-folder hit left the cache intact (fail-closed, no healing)");
      } else {
        fail(`F8-3 seam wrong (deleted=${deleted})`);
      }
    }

    // Control (F8-3b): a cached whole-path folder body still serves from the
    // cache with no model call — the whole-path contract is intact.
    {
      const preCalls = fetchCalls;
      const cache: Cache = {
        async read() {
          return "Auth lives in `src/auth`; its entry point `src/auth/session.ts` is used by `app/middleware.ts` and stores tokens in `lib/db/client.ts`.";
        },
        async write() {
          throw new Error("F8-3b control must not write");
        },
        async delete() {
          throw new Error("F8-3b control must not delete");
        },
      };
      const answer = await explainFolder(folderInput, { cache });
      if (answer.cached === true && fetchCalls === preCalls) {
        pass("a cached whole-path folder explanation still serves with no model call (F8 control)");
      } else {
        fail(`F8-3b control wrong (cached=${answer.cached}, modelDelta=${fetchCalls - preCalls})`);
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
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
