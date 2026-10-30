// Unit tests for Grounded Q&A task and hash-bound citation enforcement.
//
//   node scripts/test-qa.ts

import { answerQuestion, type Cache } from "../lib/ai/tasks.ts";
import { CitationError } from "../lib/ai/citations.ts";
import type { QuestionInput } from "../lib/ai/prompts.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

async function run() {
  const store = new Map<string, string>();
  const mockCache: Cache = {
    async read(key: string) {
      return store.get(key) ?? null;
    },
    async write({ key, body }) {
      store.set(key, body);
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

  // Test 3: Changing file content hash invalidates cache (produces miss)
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
