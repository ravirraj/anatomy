// Unit tests for Grounded Q&A task and hash-bound citation enforcement.
//
//   node scripts/test-qa.ts

import { answerQuestion, cacheKey, type Cache } from "../lib/ai/tasks.ts";
import { CitationError } from "../lib/ai/citations.ts";
import { QUESTION_SYSTEM, questionMessage, type QuestionInput } from "../lib/ai/prompts.ts";
import { loadPackagingEvidence } from "../lib/ai/packaging.ts";
import { formatRetrievedContext, type RetrievalResult, type RetrievedWindow } from "../lib/ai/retrieval.ts";
import { IntegrityError } from "../lib/content/store.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);
const check = (cond: boolean, m: string, detail?: unknown) => {
  if (cond) pass(m);
  else fail(detail === undefined ? m : `${m} :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};

async function run() {
  const store = new Map<string, string>();
  const mockCache: Cache = {
    async read(key: string) {
      return store.get(key) ?? null;
    },
    async write({ key, body }) {
      store.set(key, body);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };

  const sampleFiles = [
    {
      path: "lib/auth/session.ts",
      contentHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      totalLines: 120,
    },
    {
      path: "lib/db/client.ts",
      contentHash: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
      totalLines: 80,
    },
  ];

  const baseInput: QuestionInput = {
    question: "How does authentication establish a session?",
    contextText: "function createSession() { return db.query(); }",
    files: sampleFiles,
  };

  // Test 1: Grounded answer with valid citations passes and returns citations
  {
    let completeCalls = 0;
    const answer = await answerQuestion(baseInput, {
      cache: mockCache,
      complete: async () => {
        completeCalls++;
        return "Authentication creates a session via `lib/auth/session.ts#L10-L40`, which queries the database in `lib/db/client.ts#L15-L30`.";
      },
    });

    if (
      !answer.cached &&
      completeCalls === 1 &&
      answer.citations.length === 2 &&
      answer.citations[0].path === "lib/auth/session.ts" &&
      answer.citations[0].startLine === 10 &&
      answer.citations[0].endLine === 40
    ) {
      pass("grounded answer with valid citations succeeds and extracts citations");
    } else {
      fail(`grounded answer failed: ${JSON.stringify(answer)}`);
    }
  }

  // Test 1b: REST endpoint mentions in the answer are not file citations.
  // Live failure on the authsphere analysis: the grounded answer cited
  // `/sdk/register` and `/sdk/authorize` — real endpoints from the retrieved
  // controller source — and citation verification rejected them as unknown
  // files. Endpoint mentions must pass; invented file paths must not.
  {
    let completeCalls = 0;
    const endpointInput: QuestionInput = {
      ...baseInput,
      question: "Which endpoints does registration use?",
    };

    let threw: unknown;
    let answer: Awaited<ReturnType<typeof answerQuestion>> | null = null;
    try {
      answer = await answerQuestion(endpointInput, {
        cache: mockCache,
        complete: async () => {
          completeCalls++;
          return "Registration is served by the `POST /sdk/register` and `/sdk/authorize` endpoints, whose handlers live in `lib/auth/session.ts#L10-L40` and `lib/db/client.ts#L15-L30`.";
        },
      });
    } catch (err) {
      threw = err;
    }

    if (
      !threw &&
      answer &&
      completeCalls === 1 &&
      answer.citations.length === 2 &&
      answer.citations.every((c) => c.path === "lib/auth/session.ts" || c.path === "lib/db/client.ts")
    ) {
      pass("endpoint mentions pass Q&A citation verification with real citations intact");
    } else {
      fail(`endpoint mention handling wrong: threw=${String(threw)} answer=${JSON.stringify(answer)}`);
    }
  }

  // Test 2: Cache hit returns cached answer with citations verified
  {
    let completeCalls = 0;
    const cachedAnswer = await answerQuestion(baseInput, {
      cache: mockCache,
      complete: async () => {
        completeCalls++;
        return "unexpected model call";
      },
    });

    if (cachedAnswer.cached && completeCalls === 0 && cachedAnswer.citations.length === 2) {
      pass("cache hit returns verified answer without calling model");
    } else {
      fail(`cache hit failed: ${JSON.stringify(cachedAnswer)}`);
    }
  }

  // Test 3: A content edit changes the file's hash, which production renders
  // into the window header (`--- File: x [hash: …] ---`), so the rendered
  // context changes and the cache misses naturally. (The files list itself is
  // no longer a key component: the rendered message is the evidence identity.)
  {
    let completeCalls = 0;
    const modifiedInput: QuestionInput = {
      ...baseInput,
      files: [
        {
          ...sampleFiles[0],
          contentHash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        },
        sampleFiles[1],
      ],
      contextText:
        "--- File: lib/auth/session.ts (lines 10-40) [hash: ffffffffa] ---\nfunction createSession() { return db.query(); }",
    };

    const newAnswer = await answerQuestion(modifiedInput, {
      cache: mockCache,
      complete: async () => {
        completeCalls++;
        return "New answer after code edit: `lib/auth/session.ts#L1-L20`.";
      },
    });

    if (!newAnswer.cached && completeCalls === 1) {
      pass("content hash change naturally invalidates cache");
    } else {
      fail("content hash change did not invalidate cache");
    }
  }

  // Test 4: Answer naming non-existent file throws CitationError and is not cached
  {
    const badInput: QuestionInput = {
      ...baseInput,
      question: "Where is the secret key?",
    };

    let threw = false;
    try {
      await answerQuestion(badInput, {
        cache: mockCache,
        complete: async () => {
          return "The secret key is stored in `lib/secrets/fake.ts#L5-L10`.";
        },
      });
    } catch (err) {
      threw = err instanceof CitationError && err.paths.includes("lib/secrets/fake.ts#L5-L10");
    }

    if (threw) {
      pass("invented file in Q&A citation throws CitationError and is rejected");
    } else {
      fail("invented file did not trigger CitationError");
    }
  }

  // Test 5: Out of bounds line range throws CitationError
  {
    const badRangeInput: QuestionInput = {
      ...baseInput,
      question: "Explain error handling in db client.",
    };

    let threw = false;
    try {
      await answerQuestion(badRangeInput, {
        cache: mockCache,
        complete: async () => {
          // totalLines for db/client.ts is 80; line 200 is out of bounds
          return "Database errors are caught in `lib/db/client.ts#L100-L200`.";
        },
      });
    } catch (err) {
      threw = err instanceof CitationError && err.paths.some((p) => p.includes("lib/db/client.ts#L100-L200"));
    }

    if (threw) {
      pass("out of bounds line citation (> totalLines) throws CitationError");
    } else {
      fail("out of bounds line range did not trigger CitationError");
    }
  }

  // Test 6: Inverted line range (start > end) throws CitationError
  {
    const invertedInput: QuestionInput = {
      ...baseInput,
      question: "Explain session timeouts.",
    };

    let threw = false;
    try {
      await answerQuestion(invertedInput, {
        cache: mockCache,
        complete: async () => {
          return "Session timeouts are in `lib/auth/session.ts#L50-L20`.";
        },
      });
    } catch (err) {
      threw = err instanceof CitationError;
    }

    if (threw) {
      pass("inverted line range in Q&A citation throws CitationError");
    } else {
      fail("inverted line range did not trigger CitationError");
    }
  }

  // Test 7: Q&A answer with directories and npm packages in prose alongside valid citations passes cleanly
  {
    const onboardingInput: QuestionInput = {
      ...baseInput,
      question: "Explain repo structure and test runner.",
    };

    const answer = await answerQuestion(onboardingInput, {
      cache: mockCache,
      complete: async () => {
        return `
The repository structure is organized as:
- \`lib/auth/\` contains authentication helpers.
- \`lib/db/\` contains database connection logic.
Testing uses \`@testing-library/react\` and \`vitest\` (see package.json in prose).
For session management, see \`lib/auth/session.ts#L10-L40\`.
Database client initialization is in \`lib/db/client.ts#L5-L25\`.
`;
      },
    });

    const sessionCitation = answer.citations.find((c) => c.path === "lib/auth/session.ts");
    const dbCitation = answer.citations.find((c) => c.path === "lib/db/client.ts");

    if (
      sessionCitation &&
      sessionCitation.startLine === 10 &&
      sessionCitation.endLine === 40 &&
      dbCitation &&
      dbCitation.startLine === 5 &&
      dbCitation.endLine === 25
    ) {
      pass("Q&A answer with directory and package mentions in prose alongside valid citations passes");
    } else {
      fail(`Q&A answer with prose mentions failed: ${JSON.stringify(answer)}`);
    }
  }

  // Test 8: Citation outside retrieved evidence (even if file exists elsewhere in analysis) is rejected for line-range citation
  {
    const outsideInput: QuestionInput = {
      ...baseInput,
      question: "Where is the router?",
    };

    let threw = false;
    try {
      await answerQuestion(outsideInput, {
        cache: mockCache,
        allAnalysisFiles: new Set(["lib/auth/session.ts", "lib/db/client.ts", "lib/router.ts"]),
        complete: async () => {
          // lib/router.ts is in allAnalysisFiles, but NOT in retrieved evidence (outsideInput.files)
          return "Routing is configured in `lib/router.ts#L1-L20`.";
        },
      });
    } catch (err) {
      threw = err instanceof CitationError;
    }

    if (threw) {
      pass("line-range citation outside retrieved evidence throws CitationError");
    } else {
      fail("citation outside retrieved evidence did not throw CitationError");
    }
  }
  // Test 9: coverage-aware synthesis - the coverage summary reaches the model prompt
  {
    let seenUser = "";
    const coverageInput: QuestionInput = {
      ...baseInput,
      question: "How does authentication establish a session? (coverage-aware)",
      coverage: {
        verified: ["controllers", "frontend"],
        partial: ["routes"],
        unknown: ["models"],
        unknownNote: "\"unknown\" means the retrieved evidence does not establish the category; it is never proof that a feature does not exist.",
      },
    };

    const answer = await answerQuestion(coverageInput, {
      cache: mockCache,
      complete: async (_model, _system, user) => {
        seenUser = user;
        return "Verified controllers are in `lib/auth/session.ts#L10-L40`.";
      },
    });

    if (
      answer.citations.length === 1 &&
      seenUser.includes("Evidence coverage of the final retrieved package") &&
      seenUser.includes("Verified layers (source text establishes them): controllers, frontend") &&
      seenUser.includes("Partial layers") &&
      seenUser.includes("Unknown layers (no affiliated evidence was retrieved; NOT proof the feature is absent): models") &&
      seenUser.includes("never proof that a feature does not exist")
    ) {
      pass("coverage summary is passed into answer synthesis for verified/partial/unknown layers");
    } else {
      fail(`coverage synthesis failed: seenUser=${JSON.stringify(seenUser)} answer=${JSON.stringify(answer)}`);
    }
  }

  // Test 10: without coverage, no coverage section is added (backward compatible)
  {
    let seenUser = "";
    const noCovInput: QuestionInput = {
      ...baseInput,
      question: "How does authentication establish a session? (no coverage)",
    };
    await answerQuestion(noCovInput, {
      cache: mockCache,
      complete: async (_model, _system, user) => {
        seenUser = user;
        return "Answer in `lib/auth/session.ts#L10-L40`.";
      },
    });
    if (!seenUser.includes("Evidence coverage of the final retrieved package")) {
      pass("answer synthesis stays backward compatible without coverage input");
    } else {
      fail("coverage section leaked into a no-coverage request");
    }
  }

  // Test 11: SDK integration question - coverage-aware synthesis keeps client/server distinction guidance reachable
  {
    let seenUser = "";
    let seenSystem = "";
    const sdkInput: QuestionInput = {
      ...baseInput,
      question: "How does the SDK work in this project?",
      coverage: {
        verified: ["controllers", "frontend"],
        partial: ["routes"],
        unknown: ["models"],
        unknownNote: "\"unknown\" means the retrieved evidence does not establish the category; it is never proof that a feature does not exist.",
      },
    };

    const answer = await answerQuestion(sdkInput, {
      cache: mockCache,
      complete: async (_model, system, user) => {
        seenSystem = system;
        seenUser = user;
        return "Client SDK entry is in `lib/auth/session.ts#L1-L40`; server handlers in `lib/db/client.ts#L1-L30`.";
      },
    });

    if (
      answer.citations.length === 2 &&
      seenUser.includes("Evidence coverage of the final retrieved package") &&
      seenUser.includes("Verified layers (source text establishes them): controllers, frontend") &&
      seenSystem.includes("SDK and Client/Server Separation") &&
      seenSystem.includes("distinguish the two explicitly")
    ) {
      pass("SDK integration question carries coverage and client/server separation guidance");
    } else {
      fail(`SDK integration synthesis failed: systemHasRule=${seenSystem.includes("SDK and Client/Server Separation")} userHasCoverage=${seenUser.includes("Evidence coverage")} citations=${answer.citations.length}`);
    }
  }

  // ---- self-healing answer cache (CI-1) ----
  // A cached answer is verified before serving, exactly as before; the new
  // behavior is only what happens when that verification rejects it.

  // Test 12: an invalid cached answer is never served: it is deleted, the
  // answer is regenerated, verified, and cached like any miss.
  {
    const poisoned = "The session is built by `lib/ghost.ts#L1-L5`.";
    let readCalls = 0;
    let deleteCalls = 0;
    let writeCalls = 0;
    let completeCalls = 0;
    let writtenBody = "";
    const healing: Cache = {
      async read() {
        readCalls++;
        return readCalls === 1 ? poisoned : null;
      },
      async write({ body }) {
        writeCalls++;
        writtenBody = body;
      },
      async delete() {
        deleteCalls++;
      },
    };
    const answer = await answerQuestion(baseInput, {
      cache: healing,
      complete: async () => {
        completeCalls++;
        return "Session handling is established in `lib/auth/session.ts#L10-L40`.";
      },
    });
    const regenerated = "Session handling is established in `lib/auth/session.ts#L10-L40`.";
    if (
      deleteCalls === 1 &&
      completeCalls === 1 &&
      writeCalls === 1 &&
      writtenBody === regenerated &&
      answer.cached === false &&
      answer.body === regenerated &&
      answer.citations.length === 1 &&
      answer.citations[0].path === "lib/auth/session.ts"
    ) {
      pass("invalid cache hit self-heals: deleted, regenerated, verified, and cached");
    } else {
      fail(`self-heal failed: delete=${deleteCalls} complete=${completeCalls} write=${writeCalls} written=${JSON.stringify(writtenBody)} answer=${JSON.stringify(answer)}`);
    }
  }

  // Test 13: a valid cache hit is still served unchanged, without calling the
  // model, and never deleted.
  {
    const store = new Map<string, string>();
    let completeCalls = 0;
    let deleteCalls = 0;
    const validCache: Cache = {
      async read(key) {
        return store.get(key) ?? null;
      },
      async write({ key, body }) {
        store.set(key, body);
      },
      async delete() {
        deleteCalls++;
      },
    };
    const first = await answerQuestion(baseInput, {
      cache: validCache,
      complete: async () => {
        completeCalls++;
        return "Sessions live at `lib/auth/session.ts#L10-L40`.";
      },
    });
    const second = await answerQuestion(baseInput, {
      cache: validCache,
      complete: async () => {
        completeCalls++;
        return "never reachable";
      },
    });
    if (
      first.cached === false &&
      completeCalls === 1 &&
      second.cached === true &&
      completeCalls === 1 &&
      deleteCalls === 0 &&
      second.body === first.body
    ) {
      pass("valid cache hit is served without the model and without any deletion");
    } else {
      fail(`valid hit corrupted: complete=${completeCalls} delete=${deleteCalls} first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
    }
  }

  // Test 13/14 midpoint (CI-1 + CI-4): a cached answer whose citation was
  // legal for retrieval but lies outside the current general allowlist — say,
  // the file was quarantined (content_status left `stored`) since it was
  // written — fails verification on the cache-read check and triggers the CI-1
  // healing: the entry is dropped, the answer is regenerated, and only a
  // fresh, allowlist-verified body is served.
  {
    const staleCached = "The session helper lives in `lib/auth/session.ts#L10-L40`; internals in `lib/auth/excluded.ts`.";
    let readCalls = 0;
    let deleteCalls = 0;
    let writeCalls = 0;
    let completeCalls = 0;
    const regenerating: Cache = {
      async read() {
        readCalls++;
        return readCalls === 1 ? staleCached : null;
      },
      async write({ body }) {
        writeCalls++;
        void body;
      },
      async delete() {
        deleteCalls++;
      },
    };
    // allowedAnalysisPaths output: the quarantined path is not in the set.
    const allowlist: Set<string> = new Set(["lib/auth/session.ts", "lib/db/client.ts"]);
    const answer = await answerQuestion(baseInput, {
      cache: regenerating,
      allAnalysisFiles: allowlist,
      complete: async () => {
        completeCalls++;
        return "The session helper lives in `lib/auth/session.ts#L10-L40`.";
      },
    });
    if (
      deleteCalls === 1 &&
      completeCalls === 1 &&
      writeCalls === 1 &&
      answer.cached === false &&
      !answer.body.includes("lib/auth/excluded.ts") &&
      answer.citations.length === 1 &&
      answer.citations[0].path === "lib/auth/session.ts"
    ) {
      pass("a cached answer citing a later-quarantined file is refused, healed, and regenerated (CI-1 + CI-4)");
    } else {
      fail(`quarantine healing wrong: delete=${deleteCalls} complete=${completeCalls} write=${writeCalls} answer=${JSON.stringify(answer)}`);
    }
  }

  // Test 14: even after dropping the invalid entry, a regeneration that
  // fails verification is a controlled failure with no cache write.
  {
    const poisoned = "Cited at `lib/ghost.ts#L1-L5`.";
    let readCalls = 0;
    let deleteCalls = 0;
    let writeCalls = 0;
    let completeCalls = 0;
    let wrote = false;
    const failing: Cache = {
      async read() {
        readCalls++;
        return readCalls === 1 ? poisoned : null;
      },
      async write() {
        writeCalls++;
        wrote = true;
      },
      async delete() {
        deleteCalls++;
      },
    };
    let outcome: { ok: boolean; error?: unknown } = { ok: false };
    try {
      await answerQuestion(baseInput, {
        cache: failing,
        complete: async () => {
          completeCalls++;
          return "Still invented: `lib/ghost.ts#L1-L5`.";
        },
      });
      outcome = { ok: true };
    } catch (error) {
      outcome = { ok: true, error };
    }
    if (
      !outcome.ok ||
      (deleteCalls === 1 &&
        completeCalls === 1 &&
        writeCalls === 0 &&
        !wrote &&
        outcome.error instanceof CitationError)
    ) {
      pass("regeneration that fails verification is a controlled failure and nothing is cached");
    } else {
      fail(`regeneration contract broken: delete=${deleteCalls} complete=${completeCalls} write=${writeCalls} error=${JSON.stringify(outcome, Object.getOwnPropertyNames(outcome))}`);
    }
  }

  // Test 15: a failing deletion never surfaces the invalid answer; the ask
  // continues to regeneration and serves only the verified fresh body.
  {
    const poisoned = "The stale cached body says `lib/ghost.ts#L1-L5`.";
    let deleteCalls = 0;
    let writeCalls = 0;
    let completeCalls = 0;
    const brokenDelete: Cache = {
      async read() {
        return poisoned;
      },
      async write() {
        writeCalls++;
      },
      async delete() {
        deleteCalls++;
        throw new Error("delete refused");
      },
    };
    const answer = await answerQuestion(baseInput, {
      cache: brokenDelete,
      complete: async () => {
        completeCalls++;
        return "Fresh evidence: `lib/db/client.ts#L5-L25` connects the pool at session setup.";
      },
    });
    if (
      deleteCalls === 1 &&
      completeCalls === 1 &&
      writeCalls === 1 &&
      answer.cached === false &&
      !answer.body.includes("lib/ghost.ts") &&
      answer.citations.length === 1 &&
      answer.citations[0].path === "lib/db/client.ts"
    ) {
      pass("delete failure never serves the invalid answer; regeneration continues safely");
    } else {
      fail(`delete-failure handling wrong: delete=${deleteCalls} complete=${completeCalls} write=${writeCalls} answer=${JSON.stringify(answer)}`);
    }
  }

  // Test 16: a plain cache miss behaves exactly as before.
  {
    let completeCalls = 0;
    const missOnly: Cache = {
      async read() {
        return null;
      },
      async write() {},
      async delete() {},
    };
    const answer = await answerQuestion(baseInput, {
      cache: missOnly,
      complete: async () => {
        completeCalls++;
        return "Miss-path answer with `lib/auth/session.ts#L10-L40`.";
      },
    });
    if (completeCalls === 1 && answer.cached === false && answer.citations.length === 1) {
      pass("cache miss still generates, verifies, and serves normally");
    } else {
      fail(`cache miss behavior changed: complete=${completeCalls} answer=${JSON.stringify(answer)}`);
    }
  }

  // Test 17: a failing cache write follows the existing contract (the error
  // propagates; nothing is served from it).
  {
    let threw = false;
    try {
      await answerQuestion(baseInput, {
        cache: {
          async read() {
            return null;
          },
          async write() {
            throw new Error("cache write refused");
          },
          async delete() {},
        },
        complete: async () => "`lib/auth/session.ts#L10-L40` holds the session logic.",
      });
    } catch {
      threw = true;
    }
    if (threw) {
      pass("a cache write failure surfaces as an error, per the existing contract");
    } else {
      fail("cache write failure was silently swallowed");
    }
  }

  // ---- context-aware answer cache keys (CI-2) ----
  // The key is now a fingerprint of the exact system and user messages the
  // model receives, so anything that changes the effective input changes the
  // identity, and anything constant (sorted coverage lists, identical asks)
  // still hits. Each test drives its own isolated cache.

  const localCache = () => {
    const store = new Map<string, string>();
    const counts = { model: 0 };
    const cache: Cache = {
      async read(key) {
        return store.get(key) ?? null;
      },
      async write({ key, body }) {
        store.set(key, body);
      },
      async delete(key) {
        store.delete(key);
      },
    };
    return { store, counts, cache };
  };
  const sessionAnswer = "`lib/auth/session.ts#L10-L40` opens the session.";
  const wrap = (window1: string) =>
    `--- File: lib/auth/session.ts (${window1}) [hash: a1b2c3d4] ---\nsession code`;

  // Test 18: identical rendered context for identical files hits; a different
  // window composition (different line ranges) is a different input, a miss.
  {
    const { cache, counts } = localCache();
    const mk = (window1: string): QuestionInput => ({ ...baseInput, contextText: wrap(window1) });
    const first = await answerQuestion(mk("lines 1-30"), {
      cache,
      complete: async () => {
        counts.model++;
        return sessionAnswer;
      },
    });
    const afterFirst = counts.model;
    const repeat = await answerQuestion(mk("lines 1-30"), {
      cache,
      complete: async () => {
        counts.model++;
        return sessionAnswer;
      },
    });
    const afterRepeat = counts.model;
    const reranged = await answerQuestion(mk("lines 31-60"), {
      cache,
      complete: async () => {
        counts.model++;
        return sessionAnswer;
      },
    });
    const afterReranged = counts.model;
    if (
      first.cached === false &&
      afterFirst === 1 &&
      repeat.cached === true &&
      afterRepeat === 1 &&
      reranged.cached === false &&
      afterReranged === 2
    ) {
      pass("window/composition change misses; identical rendered context still hits");
    } else {
      fail(`window composition keys wrong: first=${first.cached}/${afterFirst} repeat=${repeat.cached}/${afterRepeat} reranged=${reranged.cached}/${afterReranged}`);
    }
  }

  // Test 19: identical file hashes with entirely different rendered context
  // are a miss: under the old files-list key the first answer would have been
  // served for a question whose effective evidence changed.
  {
    const { cache, counts } = localCache();
    const first = await answerQuestion(
      { ...baseInput, contextText: "window A: session bootstrap text" },
      { cache, complete: async () => { counts.model++; return sessionAnswer; } },
    );
    const afterFirst = counts.model;
    const second = await answerQuestion(
      { ...baseInput, contextText: "window B: a completely different attribution slice" },
      { cache, complete: async () => { counts.model++; return sessionAnswer; } },
    );
    if (first.cached === false && afterFirst === 1 && second.cached === false && counts.model === 2) {
      pass("identical file hashes with different context produce a cache miss");
    } else {
      fail(`context identity wrong: first=${first.cached}/${afterFirst} second=${second.cached}/${counts.model}`);
    }
  }

  // Test 20: changed coverage information renders into the message, so it
  // invalidates the cache.
  {
    const { cache, counts } = localCache();
    const cov = (verified: string[], unknown: string[]) => ({
      question: baseInput.question,
      contextText: baseInput.contextText,
      files: sampleFiles,
      coverage: { verified, partial: [], unknown, unknownNote: "unknown layers are not proof of absence" },
    });
    const first = await answerQuestion(cov(["controllers", "middleware"], ["models"]), {
      cache,
      complete: async () => {
        counts.model++;
        return sessionAnswer;
      },
    });
    const afterFirst = counts.model;
    const second = await answerQuestion(cov(["controllers"], ["middleware", "models"]), {
      cache,
      complete: async () => {
        counts.model++;
        return sessionAnswer;
      },
    });
    if (first.cached === false && afterFirst === 1 && second.cached === false && counts.model === 2) {
      pass("changed coverage information produces a cache miss");
    } else {
      fail(`coverage change ignored: first=${first.cached}/${afterFirst} second=${second.cached}/${counts.model}`);
    }
  }

  // Test 21: coverage list order alone cannot change the rendered message
  // (questionMessage sorts the lists), so reordering is a hit.
  {
    const { cache, counts } = localCache();
    const cov = (verified: string[], unknown: string[]) => ({
      question: baseInput.question,
      contextText: baseInput.contextText,
      files: sampleFiles,
      coverage: { verified, partial: [], unknown, unknownNote: "unknown layers are not proof of absence" },
    });
    await answerQuestion(cov(["middleware", "controllers"], ["models", "frontend"]), {
      cache,
      complete: async () => {
        counts.model++;
        return sessionAnswer;
      },
    });
    const reordered = await answerQuestion(cov(["controllers", "middleware"], ["frontend", "models"]), {
      cache,
      complete: async () => {
        counts.model++;
        return sessionAnswer;
      },
    });
    if (counts.model === 1 && reordered.cached === true) {
      pass("coverage list reordering alone is a cache hit");
    } else {
      fail(`reordering invalidated: model=${counts.model} reordered=${reordered.cached}`);
    }
  }

  // Test 22: added or changed packaging evidence changes the rendered input,
  // so it misses even with identical file hashes.
  {
    const { cache, counts } = localCache();
    const withPackaging = (pack: string): QuestionInput => ({
      ...baseInput,
      contextText: `${baseInput.contextText}\n\n${pack}`,
    });
    const first = await answerQuestion(baseInput, {
      cache,
      complete: async () => {
        counts.model++;
        return sessionAnswer;
      },
    });
    const afterFirst = counts.model;
    const packaged = await answerQuestion(
      withPackaging("[Manifests]\npackage.json declares pnpm workspaces"),
      {
        cache,
        complete: async () => {
          counts.model++;
          return sessionAnswer;
        },
      },
    );
    const afterPackaged = counts.model;
    const changed = await answerQuestion(withPackaging("[Manifests]\npackage.json declares npm workspaces"), {
      cache,
      complete: async () => {
        counts.model++;
        return sessionAnswer;
      },
    });
    if (first.cached === false && afterFirst === 1 && packaged.cached === false && afterPackaged === 2 && changed.cached === false && counts.model === 3) {
      pass("added or changed packaging evidence produces a cache miss");
    } else {
      fail(`packaging identity wrong: first=${first.cached}/${afterFirst} packaged=${packaged.cached}/${afterPackaged} changed=${changed.cached}/${counts.model}`);
    }
  }

  // Test 23: API-surface appendix text (signatures, documentation) is part of
  // the rendered input: a change there is a miss.
  {
    const { cache, counts } = localCache();
    const withApi = (signature: string): QuestionInput => ({
      ...baseInput,
      contextText: `${baseInput.contextText}\n[API surface]\n- createSession (function): ${signature}`,
    });
    const first = await answerQuestion(withApi("createSession(): void"), {
      cache,
      complete: async () => {
        counts.model++;
        return sessionAnswer;
      },
    });
    const afterFirst = counts.model;
    const second = await answerQuestion(withApi("createSession(config): Promise<Session>"), {
      cache,
      complete: async () => {
        counts.model++;
        return sessionAnswer;
      },
    });
    if (first.cached === false && afterFirst === 1 && second.cached === false && counts.model === 2) {
      pass("changed API-surface signature or documentation produces a cache miss");
    } else {
      fail(`api-surface identity wrong: first=${first.cached}/${afterFirst} second=${second.cached}/${counts.model}`);
    }
  }

  // Test 24: the identical complete model input — question, context, coverage
  // — still hits, with zero redundant invalidation.
  {
    const { cache, counts } = localCache();
    const full: QuestionInput = {
      ...baseInput,
      contextText: `${baseInput.contextText}\n\n[Dependencies]\nimported by 3 indexed files`,
      coverage: { verified: ["controllers"], partial: [], unknown: ["models"], unknownNote: "note stays identical" },
    };
    const first = await answerQuestion(full, {
      cache,
      complete: async () => {
        counts.model++;
        return sessionAnswer;
      },
    });
    const second = await answerQuestion(full, {
      cache,
      complete: async () => {
        counts.model++;
        return sessionAnswer;
      },
    });
    if (first.cached === false && counts.model === 1 && second.cached === true && counts.model === 1) {
      pass("identical complete model input produces a cache hit");
    } else {
      fail(`identical input invalidated: model=${counts.model} first=${first.cached} second=${second.cached}`);
    }
  }

  // Test 25: casing differences keep hitting the same answer as before; the
  // model still receives the original question text on the generating ask.
  {
    const { cache, counts } = localCache();
    let seenQuestionLine = "";
    const first = await answerQuestion(
      { ...baseInput, question: "How does authentication establish a session?" },
      {
        cache,
        complete: async (_model, _system, user) => {
          counts.model++;
          seenQuestionLine = user.split("\n")[0]!;
          return sessionAnswer;
        },
      },
    );
    const lowered = await answerQuestion(
      { ...baseInput, question: "how does authentication establish a session?" },
      {
        cache,
        complete: async () => {
          counts.model++;
          return sessionAnswer;
        },
      },
    );
    if (
      first.cached === false &&
      counts.model === 1 &&
      seenQuestionLine === "Question: How does authentication establish a session?" &&
      lowered.cached === true &&
      counts.model === 1
    ) {
      pass("question casing differences preserve case-insensitive cache hits");
    } else {
      fail(`casing semantics wrong: model=${counts.model} seen=${JSON.stringify(seenQuestionLine)} first=${first.cached} lowered=${lowered.cached}`);
    }
  }

  // Test 26 (unit): the system prompt is part of the key envelope, so a
  // changed system prompt can never serve under an unchanged identity.
  {
    const body = questionMessage(baseInput);
    const solved = cacheKey("answer-question", "test/explain-v1", { system: QUESTION_SYSTEM, body });
    const altered = cacheKey("answer-question", "test/explain-v1", { system: `${QUESTION_SYSTEM} changed`, body });
    const sameAgain = cacheKey("answer-question", "test/explain-v1", { system: QUESTION_SYSTEM, body });
    if (solved === sameAgain && solved !== altered) {
      pass("a changed system prompt produces a different cache key");
    } else {
      fail(`system prompt identity wrong: solved=${solved.slice(0, 8)} altered=${altered.slice(0, 8)}`);
    }
  }

  // Test 27 (CI-4 production flow): loadPackagingEvidence queries files table for authoritative content_status
  // and allows bare manifest citation only when stored in current analysis
  {
    const makeMockDb = (manifestFileStatus: string | null) => ({
      from: (table: string) => {
        if (table === "manifests") {
          return {
            select: () => ({
              eq: async () => ({
                data: [{ path: "package.json", dir: ".", ecosystem: "npm", name: "cartograph", workspaces: [], scripts: [], problems: [] }],
                error: null,
              }),
            }),
          };
        }
        if (table === "files") {
          return {
            select: () => ({
              eq: () => ({
                in: async (_col: string, paths: string[]) => ({
                  data: manifestFileStatus && paths.includes("package.json")
                    ? [{ path: "package.json", content_status: manifestFileStatus }]
                    : [],
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: async () => ({ data: [], error: null }),
          }),
        };
      },
    });

    const manifestInput: QuestionInput = {
      question: "What packages and dependencies are in package.json?",
      contextText: "[Manifests]\n- package.json (npm, declares \"cartograph\")",
      files: sampleFiles,
    };

    // 27a: Stored manifest in current analysis passes bare mention
    {
      const { cache } = localCache();
      const evidence = await loadPackagingEvidence(
        makeMockDb("stored") as unknown as Parameters<typeof loadPackagingEvidence>[0],
        "analysis-current",
        "What dependencies are listed in the package manifest?",
      );
      if (evidence.manifests && evidence.manifests.length === 1 && evidence.manifests[0].content_status === "stored" && evidence.manifests[0].rendered === true) {
        pass("production loadPackagingEvidence attaches authoritative content_status: stored and rendered: true");
      } else {
        fail("production loadPackagingEvidence failed to attach stored rendered manifest: " + JSON.stringify(evidence.manifests));
      }

      const manifestsByPath = new Map((evidence.manifests ?? []).map((m) => [m.path, m]));
      const answer = await answerQuestion(manifestInput, {
        cache,
        manifestsByPath,
        analysisId: "analysis-current",
        complete: async () => "The manifest is `package.json` and session is in `lib/auth/session.ts`.",
      });
      if (answer.citations.some((c) => c.path === "package.json")) {
        pass("production data flow authorizes bare mention of verified stored manifest");
      } else {
        fail("production data flow did not extract package.json citation: " + JSON.stringify(answer.citations));
      }
    }

    // 27b: Excluded/quarantined manifest in current analysis is rejected
    {
      const { cache } = localCache();
      const evidence = await loadPackagingEvidence(
        makeMockDb("excluded") as unknown as Parameters<typeof loadPackagingEvidence>[0],
        "analysis-current",
        "What dependencies are listed in the package manifest?",
      );
      if (evidence.manifests?.[0]?.content_status === "excluded") {
        pass("production loadPackagingEvidence resolves quarantined manifest as content_status: excluded");
      } else {
        fail("expected excluded content_status: " + JSON.stringify(evidence.manifests));
      }

      const manifestsByPath = new Map((evidence.manifests ?? []).map((m) => [m.path, m]));
      let thrown = false;
      try {
        await answerQuestion(manifestInput, {
          cache,
          manifestsByPath,
          analysisId: "analysis-current",
          complete: async () => "The manifest is `package.json`.",
        });
      } catch (err) {
        if (err instanceof CitationError && err.paths.includes("package.json")) {
          thrown = true;
        }
      }
      if (thrown) {
        pass("production data flow strictly rejects quarantined/excluded manifest citation");
      } else {
        fail("production data flow allowed excluded manifest citation!");
      }
    }

    // 27c: Absent from files table resolves as content_status: absent and is rejected
    {
      const { cache } = localCache();
      const evidence = await loadPackagingEvidence(
        makeMockDb(null) as unknown as Parameters<typeof loadPackagingEvidence>[0],
        "analysis-current",
        "What dependencies are listed in the package manifest?",
      );
      if (evidence.manifests?.[0]?.content_status === "absent") {
        pass("production loadPackagingEvidence resolves unindexed manifest as content_status: absent");
      } else {
        fail("expected absent content_status: " + JSON.stringify(evidence.manifests));
      }

      const manifestsByPath = new Map((evidence.manifests ?? []).map((m) => [m.path, m]));
      let thrown = false;
      try {
        await answerQuestion(manifestInput, {
          cache,
          manifestsByPath,
          analysisId: "analysis-current",
          complete: async () => "The manifest is `package.json`.",
        });
      } catch (err) {
        if (err instanceof CitationError && err.paths.includes("package.json")) {
          thrown = true;
        }
      }
      if (thrown) {
        pass("production data flow strictly rejects absent/unindexed manifest citation");
      } else {
        fail("production data flow allowed absent manifest citation!");
      }
    }

    // 27d: Cross-analysis manifest rejection
    {
      const { cache } = localCache();
      const evidence = await loadPackagingEvidence(
        makeMockDb("stored") as unknown as Parameters<typeof loadPackagingEvidence>[0],
        "analysis-foreign",
        "What dependencies are listed in the package manifest?",
      );
      const manifestsByPath = new Map((evidence.manifests ?? []).map((m) => [m.path, m]));
      let thrown = false;
      try {
        await answerQuestion(manifestInput, {
          cache,
          manifestsByPath,
          analysisId: "analysis-current",
          complete: async () => "The manifest is `package.json`.",
        });
      } catch (err) {
        if (err instanceof CitationError && err.paths.includes("package.json")) {
          thrown = true;
        }
      }
      if (thrown) {
        pass("production data flow strictly rejects cross-analysis manifest citation");
      } else {
        fail("production data flow allowed foreign manifest citation!");
      }
    }
  }

  // ---- Phase 2, B2: full-hash window identity (audit finding F6) ----
  // The old 8-hex header was grindable: regenerating content beyond the
  // served window to keep an 8-hex prefix left a stale answer cacheable as
  // if nothing changed. The header now embeds the full canonical sha256 and
  // the answer seam refuses evidence whose hash is missing or non-canonical.
  {
    // Two full hashes sharing their first eight characters. No cryptographic
    // collision is hunted: the grind worked at the prefix, so a same-prefix
    // pair is exactly the realistic threat-model fixture.
    const sharedPrefix = "a1b2c3d4";
    const hashBeforeEdit = sharedPrefix + "10".repeat(8) + "0".repeat(40);
    const hashAfterEdit = sharedPrefix + "20".repeat(8) + "2".repeat(40);
    const sessionPath = "lib/auth/session.ts";

    const mkWindow = (contentHash: string): RetrievedWindow => ({
      fileId: "f1",
      path: sessionPath,
      contentHash,
      totalLines: 120,
      startLine: 10,
      endLine: 40,
      text: "function createSession() { return db.query(); }",
      score: 1,
      reason: "B2 identity fixture",
    });
    const mockPlan = {
      query: "authentication",
      isOnboarding: false,
      intent: "explain-architecture" as const,
      intentReason: "B2 fixture",
      concepts: [],
      unusedTokens: [],
      expectedEvidence: [],
      isAnswerable: true,
    };
    const mkResult = (contentHash: string): RetrievalResult => ({
      analysisId: "analysis-b2",
      query: "authentication",
      tokens: ["auth"],
      plan: mockPlan,
      windows: [mkWindow(contentHash)],
      files: [
        { fileId: "f1", path: sessionPath, contentHash, totalLines: 120, windows: [{ startLine: 10, endLine: 40 }] },
      ],
      totalCharacters: 0,
      totalTokens: 0,
      renderedCharacters: 0,
      insufficientEvidence: false,
    });
    const mkInput = (hash: string, contextText: string): QuestionInput => ({
      question: "How does authentication establish a session?",
      contextText,
      files: [{ path: sessionPath, contentHash: hash, totalLines: 120, windows: [{ startLine: 10, endLine: 40 }] }],
    });

    // 1. Producer: the header carries the full hash and never the 8-hex
    //    prefix — neither the new one nor any shorter grain.
    const rendered = formatRetrievedContext(mkResult(hashBeforeEdit));
    check(
      rendered.includes(`[hash: ${hashBeforeEdit}]`),
      "window headers embed the full canonical content hash",
      rendered,
    );
    check(
      !rendered.includes("[hash: a1b2c3d4]") && !rendered.includes(`[hash: ${hashBeforeEdit.slice(0, 8)}]`),
      "window headers no longer render an 8-hex hash prefix",
      rendered,
    );

    // 5 (identity form). An old abbreviated-style render is simply a
    // different identity: it can neither be served as, nor collide with, the
    // current full-hash identity.
    const inputOldStyle = mkInput(hashBeforeEdit, wrap("lines 10-40"));
    const inputNewStyle = mkInput(hashBeforeEdit, rendered);
    check(
      cacheKey("answer-question", "m", { system: QUESTION_SYSTEM, body: questionMessage(inputOldStyle) }) !==
        cacheKey("answer-question", "m", { system: QUESTION_SYSTEM, body: questionMessage(inputNewStyle) }),
      "a pre-B2 abbreviated-header render is a distinct identity from the full-hash render",
    );

    // 2 + 3 + 4. Behavioural: two windows whose full hashes differ only
    // beyond the shared 8-hex prefix are different evidence — the same
    // served window bounds answer from a different identity (out-of-window
    // content changed the file hash), so the stale answer cannot be reused.
    const {
      store: b2Store,
      counts: b2Counts,
      cache: b2Cache,
    } = localCache();
    const b2Complete = async () => {
      b2Counts.model++;
      return sessionAnswer;
    };
    const answerBefore = await answerQuestion(mkInput(hashBeforeEdit, rendered), { cache: b2Cache, complete: b2Complete });
    check(answerBefore.cached === false, "B2: the pre-edit evidence generates fresh", JSON.stringify(answerBefore));
    const afterBefore = b2Counts.model;
    await answerQuestion(mkInput(hashAfterEdit, formatRetrievedContext(mkResult(hashAfterEdit))), {
      cache: b2Cache,
      complete: b2Complete,
    });
    check(
      b2Counts.model === afterBefore + 1 && b2Store.size === 2,
      "matching 8-hex prefixes do not collapse evidence identity - the post-edit ask regenerates and caches separately",
    );
    const afterAfter = b2Counts.model;
    const revisitBefore = await answerQuestion(mkInput(hashBeforeEdit, rendered), { cache: b2Cache, complete: b2Complete });
    check(
      revisitBefore.cached === true && b2Counts.model === afterAfter,
      "the exact pre-edit identity still hits its own cache entry (per-identity, not per-prefix)",
    );

    // 6. Missing or malformed hashes fail closed at the answer seam: no
    //    model call, no cache write, a typed integrity error.
    for (const [label, bad] of [
      ["an 8-hex truncated hash", "a1b2c3d4"],
      ["an empty hash", ""],
      ["a non-hex hash", "dead beef"],
    ] as const) {
      let thrown: unknown = null;
      const { store: badStore, counts: badCounts, cache: badCache } = localCache();
      try {
        await answerQuestion({ ...baseInput, contextText: rendered, files: [{ ...sampleFiles[0], contentHash: bad }] }, {
          cache: badCache,
          complete: async () => {
            badCounts.model++;
            return sessionAnswer;
          },
        });
      } catch (err) {
        thrown = err;
      }
      check(
        thrown instanceof IntegrityError && badCounts.model === 0 && badStore.size === 0,
        `evidence with ${label} is refused with IntegrityError, uncached, no model call`,
        String(thrown),
      );
    }
    let missingThrown: unknown = null;
    const { store: missingStore, counts: missingCounts, cache: missingCache } = localCache();
    try {
      await answerQuestion(
        {
          ...baseInput,
          contextText: rendered,
          files: [{ path: sessionPath, contentHash: undefined as unknown as string, totalLines: 120 }],
        },
        {
          cache: missingCache,
          complete: async () => {
            missingCounts.model++;
            return sessionAnswer;
          },
        },
      );
    } catch (err) {
      missingThrown = err;
    }
    check(
      missingThrown instanceof IntegrityError && missingCounts.model === 0 && missingStore.size === 0,
      "evidence with a missing hash is refused with IntegrityError, uncached, no model call",
      String(missingThrown),
    );

    // 7 + 8. Union-coverage merging and fail-closed citation verification are
    // covered unchanged above and in test-citations.ts / test-retrieval-loop.ts;
    // the answer seam guard above is itself fail-closed (refuse; never
    // generate). Cached-answer verification paths are exercised by the
    // poisoned-cache and staleness tests earlier in this file.
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
    console.error("Test runner threw:", err);
    process.exit(1);
  });
