// Exercises the AI layer against a fake OpenAI-compatible endpoint, so the
// provider plumbing is proven without a real key.
//
//   node scripts/test-provider.ts            another provider
//   TEST_OPENAI=1 node scripts/test-provider.ts   OpenAI's own API

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const requests: Record<string, unknown>[] = [];
let rejectSchema = false;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    requests.push(parsed);

    if (rejectSchema && (parsed.response_format as { type?: string })?.type === "json_schema") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "response_format of type json_schema is not supported by this endpoint", type: "invalid_request_error" },
        }),
      );
      return;
    }

    const wantsJson = Boolean(parsed.response_format);
    const content = wantsJson
      ? JSON.stringify({ role: "util" })
      : "This file holds one helper.\n\n- It is used by `index.ts`.";

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: parsed.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

// Set the environment before the AI modules are loaded: the client reads it
// once, when it is first used.
//
// TEST_OPENAI=1 checks the OpenAI path. With no AI_BASE_URL the client would
// talk to OpenAI's own API, so only the parts that decide what to send are
// checked here, without a request.
const asOpenAI = process.env.TEST_OPENAI === "1";
if (!asOpenAI) {
  process.env.AI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.AI_MODEL_EXPLAIN = "test/explain-v1";
  process.env.AI_MODEL_CLASSIFY = "test/classify-v1";
}
process.env.AI_API_KEY = "test-key";
delete process.env.OPENAI_API_KEY;

const results: string[] = [];
const pass = (m: string) => {
  results.push(`ok    ${m}`);
};
const fail = (m: string) => {
  results.push(`FAIL  ${m}`);
};

function report(): void {
  console.log("");
  for (const line of results) console.log(line);
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
  server.close();
  process.exit(failed === 0 ? 0 : 1);
}

if (asOpenAI) {
  const { MODELS, openAIOnly } = await import("../lib/ai/client.ts");
  console.log("=== the OpenAI path ===");
  console.log(MODELS);
  console.log("");

  if (MODELS.explain === "gpt-5.5-2026-04-23") {
    pass("the explain model is pinned by default");
  } else {
    fail(`explain model is ${MODELS.explain}`);
  }
  if (MODELS.classify === "gpt-5.4-mini-2026-03-17") {
    pass("the classify model is pinned by default");
  } else {
    fail(`classify model is ${MODELS.classify}`);
  }
  const only = openAIOnly();
  if (only.verbosity === "low") {
    pass("verbosity is sent to OpenAI");
  } else {
    fail(`verbosity is ${String(only.verbosity)}`);
  }
  report();
}

	const { explainFile, classifyFile, cacheKey } = await import("../lib/ai/tasks.ts");
	const { MODELS, isOpenRouterBaseUrl, resolveBaseUrl } = await import("../lib/ai/client.ts");
	type EdgeKind = "import" | "re-export" | "dynamic-import" | "require";

// A cache that keeps answers in memory, so a second call can be seen to hit it.
const store = new Map<string, string>();
	const cache = {
	  async read(key: string) {
	    return store.get(key) ?? null;
	  },
	  async write(entry: { key: string; body: string }) {
	    store.set(entry.key, entry.body);
	  },
	};

	const edgeKinds: EdgeKind[] = ["import"];

	const question = {
	  path: "lib/thing.ts",
	  hash: "abc123",
	  role: null,
	  reachedBy: null,
	  exports: ["thing"],
	  imports: [{ path: "index.ts", role: null, exports: [], kinds: edgeKinds, typeOnly: false }],
	  importedBy: [],
	};

console.log("=== the configured models ===");
console.log(MODELS);
console.log("");

console.log("=== 1. explain, first call ===");
const first = await explainFile(question, { cache, source: async () => "export const thing = 1;" });
if (first.body.includes("helper")) {
  pass("the answer came back");
} else {
  fail(`unexpected body: ${first.body}`);
}
if (first.cached === false) {
  pass("reported as not cached");
} else {
  fail("reported as cached on the first call");
}
if (first.model === "test/explain-v1") {
  pass(`model is the configured one (${first.model})`);
} else {
  fail(`model is ${first.model}`);
}

console.log("");
console.log("=== 2. explain, second call (should hit the cache) ===");
const before = requests.length;
const second = await explainFile(question, { cache, source: async () => "export const thing = 1;" });
if (second.cached === true) {
  pass("reported as cached");
} else {
  fail("not reported as cached");
}
if (requests.length === before) {
  pass("no second model call was made");
} else {
  fail("made another model call");
}

console.log("");
console.log("=== 3. the request that was sent ===");
const sent = requests[0];
console.log(
  JSON.stringify(
    {
      model: sent.model,
      reasoning_effort: sent.reasoning_effort,
      verbosity: sent.verbosity,
      hasSystem: (sent.messages as { role: string }[])[0].role === "system",
    },
    null,
    2,
  ),
);
if (sent.model === "test/explain-v1") {
  pass("the request used the configured model");
} else {
  fail("wrong model in the request");
}
if (sent.verbosity === undefined) {
  pass("verbosity was left out (not OpenAI)");
} else {
  fail("verbosity was sent to a non-OpenAI endpoint");
}
if (sent.reasoning_effort === "low") {
  pass("reasoning_effort was sent");
} else {
  fail("reasoning_effort missing");
}

console.log("");
console.log("=== 4. classify, with a strict JSON schema ===");
const classified = await classifyFile(
  { path: "lib/thing.ts", hash: "abc123", exports: ["thing"], imports: [], importedBy: [] },
  { cache, source: async () => "export const thing = 1;" },
);
if (classified.role === "util") {
  pass(`the role came back (${classified.role})`);
} else {
  fail(`role is ${classified.role}`);
}
const classifyRequest = requests.find((r) => (r.response_format as { type?: string })?.type === "json_schema");
if (classifyRequest) {
  pass("the strict schema was requested");
} else {
  fail("the strict schema was not requested");
}

console.log("");
console.log("=== 5. classify, when the endpoint refuses the schema ===");
rejectSchema = true;
store.clear();
const classified2 = await classifyFile(
  { path: "lib/other.ts", hash: "def456", exports: ["other"], imports: [], importedBy: [] },
  { cache, source: async () => "export const other = 2;" },
);
if (classified2.role === "util") {
  pass(`it fell back to plain JSON and still worked (${classified2.role})`);
} else {
  fail(`role is ${classified2.role}`);
}
const fallback = requests.find((r) => (r.response_format as { type?: string })?.type === "json_object");
if (fallback) {
  pass("the fallback used json_object");
} else {
  fail("no json_object fallback was tried");
}

console.log("");
console.log("=== 6. the cache key includes the model ===");
const keyA = cacheKey("explain-file", "test/explain-v1", question);
const keyB = cacheKey("explain-file", "test/explain-v2", question);
if (keyA !== keyB) {
  pass("a different model makes a different key");
} else {
  fail("the model is not part of the key");
}

console.log("");
console.log("=== 7. provider detection: OpenAI, OpenRouter, and Gemini/custom endpoints ===");

// A. OpenAI detection (no custom URL)
if (!isOpenRouterBaseUrl(undefined) && resolveBaseUrl({}) === undefined) {
  pass("OpenAI default detection is correct");
} else {
  fail("OpenAI default detection failed");
}

// B. OpenRouter detection
const orUrl = resolveBaseUrl({ OPENROUTER_API_KEY: "sk-or-test-key" });
if (orUrl === "https://openrouter.ai/api/v1" && isOpenRouterBaseUrl(orUrl)) {
  pass("OpenRouter auto-configuration from OPENROUTER_API_KEY holds");
} else {
  fail(`OpenRouter auto-configuration failed: url=${orUrl}`);
}
if (isOpenRouterBaseUrl("https://openrouter.ai/api/v1") && isOpenRouterBaseUrl("https://sub.openrouter.ai/v1")) {
  pass("OpenRouter hostname pattern matching holds");
} else {
  fail("OpenRouter hostname matching failed");
}

// C. Gemini / custom base URLs take priority and are NOT misidentified as OpenRouter
const geminiUrl = "https://generativelanguage.googleapis.com/v1beta/openai/";
const resolvedGemini = resolveBaseUrl({ AI_BASE_URL: geminiUrl, OPENROUTER_API_KEY: "sk-or-test-key" });
if (resolvedGemini === geminiUrl) {
  pass("explicit AI_BASE_URL takes priority over OPENROUTER_API_KEY");
} else {
  fail(`priority resolution failed: got ${resolvedGemini}`);
}
if (!isOpenRouterBaseUrl(geminiUrl)) {
  pass("Gemini base URL is not detected as OpenRouter");
} else {
  fail("Gemini was misclassified as OpenRouter");
}
if (!isOpenRouterBaseUrl("http://localhost:11434/v1") && !isOpenRouterBaseUrl("https://api.together.xyz/v1")) {
  pass("other custom provider URLs are not detected as OpenRouter");
} else {
  fail("custom provider was misclassified as OpenRouter");
}

report();
