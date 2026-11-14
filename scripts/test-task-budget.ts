// scripts/test-task-budget.ts
// CI-8D: Deterministic unit and integration tests for task budget integration,
// output token reservations, provider overflow handling, and usage telemetry.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type ProviderRequest = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_completion_tokens?: number;
  response_format?: { type: string; json_schema?: unknown };
  reasoning_effort?: string;
};

let capturedRequests: ProviderRequest[] = [];
let endpointMode:
  | "normal"
  | "missing_usage"
  | "partial_usage"
  | "context_overflow_code"
  | "context_overflow_message"
  | "refuse_schema_then_overflow"
  | "refuse_schema_400"
  | "refuse_schema_404"
  | "refuse_schema_422"
  | "transient_503" = "normal";
let transientAttempts = 0;

const server: Server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    const parsed = JSON.parse(body) as ProviderRequest;
    capturedRequests.push(parsed);

    if (endpointMode === "transient_503") {
      transientAttempts++;
      if (transientAttempts < 2) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Service Unavailable", type: "server_error" } }));
        return;
      }
    }

    if (endpointMode === "context_overflow_code") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "This model's maximum context length is 8192 tokens. However, your request resulted in 8500 tokens.",
            type: "invalid_request_error",
            code: "context_length_exceeded",
          },
        }),
      );
      return;
    }

    if (endpointMode === "context_overflow_message") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Prompt is too long: requested 10000 tokens but context window is 8192",
            type: "invalid_request_error",
          },
        }),
      );
      return;
    }

    if (endpointMode === "refuse_schema_400" && parsed.response_format?.type === "json_schema") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "response_format of type json_schema is not supported by this endpoint",
            type: "invalid_request_error",
          },
        }),
      );
      return;
    }

    if (endpointMode === "refuse_schema_404" && parsed.response_format?.type === "json_schema") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Structured outputs endpoint not found for this model",
            type: "invalid_request_error",
          },
        }),
      );
      return;
    }

    if (endpointMode === "refuse_schema_422" && parsed.response_format?.type === "json_schema") {
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Unprocessable entity: structured output schema rejected",
            type: "invalid_request_error",
          },
        }),
      );
      return;
    }

    if (endpointMode === "refuse_schema_then_overflow") {
      if (parsed.response_format?.type === "json_schema") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "response_format of type json_schema is not supported",
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "maximum context length exceeded in fallback call",
            type: "invalid_request_error",
            code: "context_length_exceeded",
          },
        }),
      );
      return;
    }

    const wantsJson = Boolean(parsed.response_format);
    const content = wantsJson
      ? JSON.stringify({ role: "util" })
      : "Summary of module.\n\n- Uses `src/helper.ts`.";

    const baseResponse: Record<string, unknown> = {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: parsed.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
    };

    if (endpointMode === "missing_usage") {
      // omit usage
    } else if (endpointMode === "partial_usage") {
      baseResponse.usage = { total_tokens: 50 };
    } else {
      baseResponse.usage = { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 };
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(baseResponse));
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

// Configure test environment before importing tasks/client
process.env.AI_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.AI_API_KEY = "test-ci8d-key";
process.env.AI_MODEL_EXPLAIN = "test-model";
process.env.AI_MODEL_CLASSIFY = "test-model";
process.env.AI_MODEL_QUESTION = "test-model";
delete process.env.OPENAI_API_KEY;

// Now import AI task and budget modules
const {
  explainFile,
  explainFolder,
  classifyFile,
  answerQuestion,
  onTaskTelemetry,
  isContextLengthExceededError,
  TASK_MAX_OUTPUT_TOKENS,
  BudgetExhaustedError,
  BudgetOverflowError,
} = await import("../lib/ai/tasks.ts");
const { resolveModelProfile } = await import("../lib/ai/budget.ts");

let passed = 0;
let failed = 0;

function check(cond: boolean, name: string, detail?: string) {
  if (cond) {
    passed += 1;
    console.log(`ok    ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

class MemoryCache {
  public store = new Map<string, string>();
  public writeCount = 0;
  public readCount = 0;

  async read(key: string): Promise<string | null> {
    this.readCount++;
    return this.store.get(key) ?? null;
  }
  async write(entry: { key: string; task: string; model: string; body: string }): Promise<void> {
    this.writeCount++;
    this.store.set(entry.key, entry.body);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

console.log("=== 1. Reconciled Output Token Reservations (CI-8A Alignment) ===");
{
  check(TASK_MAX_OUTPUT_TOKENS["answer-question"] === 3500, "answer-question target is 3500 tokens");
  check(TASK_MAX_OUTPUT_TOKENS["explain-file"] === 1500, "explain-file target is 1500 tokens (reconciled)");
  check(TASK_MAX_OUTPUT_TOKENS["explain-folder"] === 1500, "explain-folder target is 1500 tokens (reconciled)");
  check(TASK_MAX_OUTPUT_TOKENS["classify-file"] === 100, "classify-file target is 100 tokens (reconciled)");
}

console.log("\n=== 2. Pre-Flight Refusal: BudgetExhaustedError (Zero Provider Calls, Zero Cache Writes) ===");
{
  // 2.1 explainFile with oversized file source exceeding unknown profile ceiling (13,500 chars)
  {
    capturedRequests = [];
    const cache = new MemoryCache();
    const oversizedSource = "const x = 1;\n".repeat(2000); // 26,000 chars

    let caughtError: unknown = null;
    try {
      await explainFile(
        {
          path: "src/big.ts",
          hash: "abc1",
          role: null,
          reachedBy: null,
          exports: [],
          imports: [],
          importedBy: [],
        },
        { cache, source: async () => oversizedSource },
      );
    } catch (err) {
      caughtError = err;
    }

    check(caughtError instanceof BudgetExhaustedError, "explainFile throws BudgetExhaustedError on oversized prompt", String(caughtError));
    check(capturedRequests.length === 0, "explainFile made 0 provider calls on pre-flight refusal");
    check(cache.writeCount === 0, "explainFile made 0 cache writes on pre-flight refusal");
  }

  // 2.2 explainFolder with oversized folder structure exceeding budget
  {
    capturedRequests = [];
    const cache = new MemoryCache();
    const hugeIncoming = Array.from({ length: 500 }, (_, i) => ({
      from: `src/deeply/nested/module/path/number/${i}/service/handler.ts`,
      to: "src/target.ts",
    }));

    let caughtError: unknown = null;
    try {
      await explainFolder(
        {
          dir: "src",
          files: [{ path: "src/target.ts", hash: "t1", role: null, exports: [], fanIn: 1, fanOut: 0 }],
          incoming: hugeIncoming,
          outgoing: [],
        },
        { cache },
      );
    } catch (err) {
      caughtError = err;
    }

    check(caughtError instanceof BudgetExhaustedError, "explainFolder throws BudgetExhaustedError on oversized prompt", String(caughtError));
    check(capturedRequests.length === 0, "explainFolder made 0 provider calls on pre-flight refusal");
    check(cache.writeCount === 0, "explainFolder made 0 cache writes on pre-flight refusal");
  }

  // 2.3 classifyFile with oversized excerpt exceeding budget
  {
    capturedRequests = [];
    const cache = new MemoryCache();
    const hugeLine = "x".repeat(300);
    const oversizedSource = `${hugeLine}\n`.repeat(60); // 18,060 chars

    let caughtError: unknown = null;
    try {
      await classifyFile(
        {
          path: "src/huge.ts",
          hash: "h1",
          exports: [],
          imports: [],
          importedBy: [],
        },
        { cache, source: async () => oversizedSource },
      );
    } catch (err) {
      caughtError = err;
    }

    check(caughtError instanceof BudgetExhaustedError, "classifyFile throws BudgetExhaustedError on oversized prompt", String(caughtError));
    check(capturedRequests.length === 0, "classifyFile made 0 provider calls on pre-flight refusal");
    check(cache.writeCount === 0, "classifyFile made 0 cache writes on pre-flight refusal");
  }

  // 2.4 answerQuestion with oversized question/context exceeding budget
  {
    capturedRequests = [];
    const cache = new MemoryCache();
    const oversizedQuestion = "Explain this system: " + "query detail ".repeat(1500); // ~19,500 chars

    let caughtError: unknown = null;
    try {
      await answerQuestion(
        { question: oversizedQuestion, contextText: "", files: [] },
        { cache },
      );
    } catch (err) {
      caughtError = err;
    }

    check(caughtError instanceof BudgetExhaustedError, "answerQuestion throws BudgetExhaustedError on oversized prompt", String(caughtError));
    check(capturedRequests.length === 0, "answerQuestion made 0 provider calls on pre-flight refusal");
    check(cache.writeCount === 0, "answerQuestion made 0 cache writes on pre-flight refusal");
  }
}

console.log("\n=== 3. Critical classifyFile Fallback & Overflow Separation ===");
{
  // 3.1 Primary call encounters context_length_exceeded -> MUST NOT trigger fallback!
  {
    capturedRequests = [];
    endpointMode = "context_overflow_code";
    const cache = new MemoryCache();

    let caughtError: unknown = null;
    try {
      await classifyFile(
        { path: "src/helper.ts", hash: "h1", exports: ["help"], imports: [], importedBy: [] },
        { cache, source: async () => "export function help() {}" },
      );
    } catch (err) {
      caughtError = err;
    }

    check(caughtError instanceof BudgetOverflowError, "classifyFile primary context overflow throws BudgetOverflowError immediately");
    check(capturedRequests.length === 1, "classifyFile primary context overflow made exactly 1 provider call (zero fallback attempts)");
    check(cache.writeCount === 0, "classifyFile primary context overflow made zero cache writes");
  }

  // 3.2 Primary call schema refusal (400) -> DOES trigger JSON fallback
  {
    capturedRequests = [];
    endpointMode = "refuse_schema_400";
    const cache = new MemoryCache();

    const result = await classifyFile(
      { path: "src/helper.ts", hash: "h1", exports: ["help"], imports: [], importedBy: [] },
      { cache, source: async () => "export function help() {}" },
    );

    check(result.role === "util", "classifyFile schema refusal (400) recovered via JSON fallback");
    check(capturedRequests.length === 2, "classifyFile schema refusal made exactly 2 provider calls (primary + fallback)");
    check(capturedRequests[0].response_format?.type === "json_schema", "primary request attempted json_schema");
    check(capturedRequests[1].response_format?.type === "json_object", "fallback request used json_object");
    check(cache.writeCount === 1, "successful fallback wrote to cache");
  }

  // 3.3 Primary call schema refusal (404) -> DOES trigger JSON fallback
  {
    capturedRequests = [];
    endpointMode = "refuse_schema_404";
    const cache = new MemoryCache();

    const result = await classifyFile(
      { path: "src/helper.ts", hash: "h1", exports: ["help"], imports: [], importedBy: [] },
      { cache, source: async () => "export function help() {}" },
    );

    check(result.role === "util", "classifyFile schema refusal (404) recovered via JSON fallback");
    check(capturedRequests.length === 2, "classifyFile 404 schema refusal made exactly 2 provider calls");
  }

  // 3.4 Primary call schema refusal (422) -> DOES trigger JSON fallback
  {
    capturedRequests = [];
    endpointMode = "refuse_schema_422";
    const cache = new MemoryCache();

    const result = await classifyFile(
      { path: "src/helper.ts", hash: "h1", exports: ["help"], imports: [], importedBy: [] },
      { cache, source: async () => "export function help() {}" },
    );

    check(result.role === "util", "classifyFile schema refusal (422) recovered via JSON fallback");
    check(capturedRequests.length === 2, "classifyFile 422 schema refusal made exactly 2 provider calls");
  }

  // 3.5 Fallback call encounters context length overflow -> throws BudgetOverflowError
  {
    capturedRequests = [];
    endpointMode = "refuse_schema_then_overflow";
    const cache = new MemoryCache();

    let caughtError: unknown = null;
    try {
      await classifyFile(
        { path: "src/helper.ts", hash: "h1", exports: ["help"], imports: [], importedBy: [] },
        { cache, source: async () => "export function help() {}" },
      );
    } catch (err) {
      caughtError = err;
    }

    check(caughtError instanceof BudgetOverflowError, "classifyFile fallback context overflow throws BudgetOverflowError");
    check(capturedRequests.length === 2, "classifyFile dispatched primary schema then fallback, failing on fallback");
    check(cache.writeCount === 0, "fallback context overflow made zero cache writes");
  }
}

console.log("\n=== 4. Exact Output Reservations Sent to Provider ===");
{
  const profile = resolveModelProfile("test-model", process.env.AI_BASE_URL);
  check(profile.maxOutputTokens === 1500, "unknown profile maxOutputTokens is 1500");

  // 4.1 explainFile: target 1500, profile 1500 -> min(1500, 1500) = 1500
  {
    capturedRequests = [];
    endpointMode = "normal";
    const cache = new MemoryCache();
    const res = await explainFile(
      { path: "src/helper.ts", hash: "help1", role: null, reachedBy: null, exports: ["help"], imports: [], importedBy: [] },
      { cache, source: async () => "export function help() { return 42; }" },
    );
    check(res.cached === false, "explainFile succeeded fresh");
    check(capturedRequests.length === 1, "explainFile dispatched 1 provider call");
    check(capturedRequests[0].max_completion_tokens === 1500, "explainFile sent exact max_completion_tokens=1500");
    check(cache.writeCount === 1, "explainFile cached successful answer");
  }

  // 4.2 explainFolder: target 1500, profile 1500 -> min(1500, 1500) = 1500
  {
    capturedRequests = [];
    endpointMode = "normal";
    const cache = new MemoryCache();
    const res = await explainFolder(
      { dir: "src", files: [{ path: "src/helper.ts", hash: "h1", role: null, exports: ["help"], fanIn: 0, fanOut: 0 }], incoming: [], outgoing: [] },
      { cache },
    );
    check(res.cached === false, "explainFolder succeeded fresh");
    check(capturedRequests.length === 1, "explainFolder dispatched 1 provider call");
    check(capturedRequests[0].max_completion_tokens === 1500, "explainFolder sent exact max_completion_tokens=1500");
    check(cache.writeCount === 1, "explainFolder cached successful answer");
  }

  // 4.3 classifyFile: target 100, profile 1500 -> min(1500, 100) = 100
  {
    capturedRequests = [];
    endpointMode = "normal";
    const cache = new MemoryCache();
    const res = await classifyFile(
      { path: "src/helper.ts", hash: "h1", exports: ["help"], imports: [], importedBy: [] },
      { cache, source: async () => "export function help() { return 42; }" },
    );
    check(res.role === "util", "classifyFile returned expected role 'util'");
    check(capturedRequests.length === 1, "classifyFile dispatched 1 provider call");
    check(capturedRequests[0].max_completion_tokens === 100, "classifyFile sent exact max_completion_tokens=100");
    check(cache.writeCount === 1, "classifyFile cached successful answer");
  }

  // 4.4 answerQuestion: target 3500, profile 1500 -> min(1500, 3500) = 1500 (clamped)
  {
    capturedRequests = [];
    endpointMode = "normal";
    const cache = new MemoryCache();
    const res = await answerQuestion(
      {
        question: "How does helper work?",
        contextText: "--- File: src/helper.ts (lines 1-1)\nexport function help() { return 42; }\n",
        files: [{ path: "src/helper.ts", contentHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", totalLines: 1, windows: [{ startLine: 1, endLine: 1 }] }],
      },
      { cache },
    );
    check(res.cached === false, "answerQuestion succeeded fresh");
    check(capturedRequests.length === 1, "answerQuestion dispatched 1 provider call");
    check(capturedRequests[0].max_completion_tokens === 1500, "answerQuestion clamped to unknown profile ceiling 1500");
    check(cache.writeCount === 1, "answerQuestion cached successful answer");
  }

  // 4.5 Generous Context Window Override (AI_MAX_OUTPUT_TOKENS=4000)
  {
    process.env.AI_CONTEXT_WINDOW_TOKENS = "16384";
    process.env.AI_MAX_OUTPUT_TOKENS = "4000";

    capturedRequests = [];
    const cache = new MemoryCache();
    await answerQuestion(
      {
        question: "How does helper work under override?",
        contextText: "--- File: src/helper.ts (lines 1-1)\nexport function help() { return 42; }\n",
        files: [{ path: "src/helper.ts", contentHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", totalLines: 1, windows: [{ startLine: 1, endLine: 1 }] }],
      },
      { cache },
    );
    check(capturedRequests.length === 1, "answerQuestion dispatched under override");
    check(capturedRequests[0].max_completion_tokens === 3500, "answerQuestion sent full target 3500 when profile allows 4000");

    delete process.env.AI_CONTEXT_WINDOW_TOKENS;
    delete process.env.AI_MAX_OUTPUT_TOKENS;
  }

  // 4.6 Constrained Profile Override (AI_MAX_OUTPUT_TOKENS=50)
  {
    process.env.AI_CONTEXT_WINDOW_TOKENS = "8192";
    process.env.AI_MAX_OUTPUT_TOKENS = "50";

    capturedRequests = [];
    const cache = new MemoryCache();
    await classifyFile(
      { path: "src/helper.ts", hash: "h1", exports: ["help"], imports: [], importedBy: [] },
      { cache, source: async () => "export function help() { return 42; }" },
    );
    check(capturedRequests[0].max_completion_tokens === 50, "classifyFile clamped to constrained profile maxOutputTokens=50");

    delete process.env.AI_CONTEXT_WINDOW_TOKENS;
    delete process.env.AI_MAX_OUTPUT_TOKENS;
  }
}

console.log("\n=== 5. Upstream Context Length Exceeded: BudgetOverflowError Conversion ===");
{
  // 5.1 Helper detection
  check(isContextLengthExceededError(new BudgetOverflowError("m", "detail")), "isContextLengthExceededError on BudgetOverflowError");
  check(
    isContextLengthExceededError({ status: 400, code: "context_length_exceeded", message: "too long" }),
    "isContextLengthExceededError on code: context_length_exceeded",
  );
  check(
    isContextLengthExceededError({ status: 400, message: "maximum context length exceeded" }),
    "isContextLengthExceededError on message match",
  );
  check(
    isContextLengthExceededError({ status: 503, message: "Service Unavailable" }) === false,
    "isContextLengthExceededError returns false for 503",
  );

  // 5.2 complete() tasks with upstream 400 context_length_exceeded
  {
    capturedRequests = [];
    endpointMode = "context_overflow_code";
    const cache = new MemoryCache();

    let caughtError: unknown = null;
    try {
      await explainFile(
        { path: "src/helper.ts", hash: "help1", role: "util", reachedBy: null, exports: ["help"], imports: [], importedBy: [] },
        { cache, source: async () => "export const a = 1;" },
      );
    } catch (err) {
      caughtError = err;
    }

    check(caughtError instanceof BudgetOverflowError, "explainFile converted HTTP 400 context overflow to BudgetOverflowError");
    check(capturedRequests.length === 1, "context overflow failed immediately without retrying (attempts === 1)");
    check(cache.writeCount === 0, "context overflow did not write to cache");
  }

  // 5.3 complete() tasks with upstream regex message context overflow
  {
    capturedRequests = [];
    endpointMode = "context_overflow_message";
    const cache = new MemoryCache();

    let caughtError: unknown = null;
    try {
      await answerQuestion(
        {
          question: "How does it work?",
          contextText: "--- File: src/helper.ts (lines 1-20)\nexport function help() { return 42; }\n",
          files: [{ path: "src/helper.ts", contentHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", totalLines: 20, windows: [{ startLine: 1, endLine: 20 }] }],
        },
        { cache },
      );
    } catch (err) {
      caughtError = err;
    }

    check(caughtError instanceof BudgetOverflowError, "answerQuestion converted message overflow to BudgetOverflowError");
    check(capturedRequests.length === 1, "answerQuestion context overflow failed immediately without retrying");
    check(cache.writeCount === 0, "answerQuestion context overflow did not write to cache");
  }

  // 5.4 Transient 503 still retries up to 3 times as before
  {
    capturedRequests = [];
    endpointMode = "transient_503";
    transientAttempts = 0;
    const cache = new MemoryCache();

    const result = await explainFolder(
      {
        dir: "src",
        files: [{ path: "src/helper.ts", hash: "h1", role: "util", exports: ["help"], fanIn: 1, fanOut: 0 }],
        incoming: [],
        outgoing: [],
      },
      { cache },
    );

    check(result.cached === false, "explainFolder succeeded after transient 503 retry");
    check(transientAttempts === 2, "explainFolder retried 503 error as expected");
    check(cache.writeCount === 1, "explainFolder cached after successful retry");
  }
}

console.log("\n=== 6. Telemetry Isolation & Secret Scrubbing ===");
{
  // 6.1 Telemetry payload fields verification
  {
    let receivedPayload: unknown = null;
    const unsubscribe = onTaskTelemetry((usage) => {
      receivedPayload = usage;
    });

    endpointMode = "normal";
    const cache = new MemoryCache();
    await explainFile(
      { path: "src/helper.ts", hash: "help1", role: "util", reachedBy: null, exports: ["help"], imports: [], importedBy: [] },
      { cache, source: async () => "export function help() { return 42; }" },
    );

    const event = receivedPayload as {
      task?: string;
      model?: string;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      elapsedMs?: number;
    };
    check(Boolean(event), "telemetry event was received");
    check(event.task === "explain-file", "telemetry recorded task 'explain-file'");
    check(event.model === "test-model", "telemetry recorded correct model");
    check(event.promptTokens === 120, "telemetry recorded prompt_tokens");
    check(event.completionTokens === 45, "telemetry recorded completion_tokens");
    check(event.totalTokens === 165, "telemetry recorded total_tokens");
    check(typeof event.elapsedMs === "number" && event.elapsedMs >= 0, "telemetry recorded elapsedMs");

    unsubscribe();
  }

  // 6.2 Unsubscribe verification
  {
    let callCount = 0;
    const unsubscribe = onTaskTelemetry(() => {
      callCount++;
    });

    endpointMode = "normal";
    const cache = new MemoryCache();
    await explainFile(
      { path: "src/helper.ts", hash: "help1", role: "util", reachedBy: null, exports: ["help"], imports: [], importedBy: [] },
      { cache, source: async () => "export function help() { return 42; }" },
    );
    check(callCount === 1, "telemetry listener received event before unsubscribe");

    unsubscribe();
    await explainFile(
      { path: "src/helper.ts", hash: "help1", role: "util", reachedBy: null, exports: ["help"], imports: [], importedBy: [] },
      { cache, source: async () => "export function help() { return 42; }" },
    );
    check(callCount === 1, "unsubscribed listener received no new events");
  }

  // 6.3 Listener exception does not fail task and scrubs secrets from message and name
  {
    const FAKE_SECRET_MSG = "SUPER_SECRET_LEAK_TEST_KEY_XYZ_987654";
    const FAKE_SECRET_NAME = "SECRET_TOKEN_IN_NAME_456789";
    const loggedErrors: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args.map(String).join(" "));
      originalConsoleError(...args);
    };

    const unsubscribe = onTaskTelemetry(() => {
      const err = new Error(`Failure exposing secret token in message: ${FAKE_SECRET_MSG}`);
      err.name = FAKE_SECRET_NAME;
      throw err;
    });

    endpointMode = "normal";
    const cache = new MemoryCache();
    let result: unknown = null;
    let thrown = false;
    try {
      result = await explainFolder(
        { dir: "src", files: [{ path: "src/helper.ts", hash: "help", role: null, exports: ["help"], fanIn: 0, fanOut: 0 }], incoming: [], outgoing: [] },
        { cache },
      );
    } catch {
      thrown = true;
    } finally {
      console.error = originalConsoleError;
      unsubscribe();
    }

    check(!thrown, "listener exception did NOT cause task to throw");
    check(Boolean(result && (result as { body?: string }).body), "task completed successfully despite listener failure");
    check(cache.writeCount === 1, "successful answer cached despite listener failure");

    // Secret privacy verification
    const errorLog = loggedErrors.join("\n");
    check(!errorLog.includes(FAKE_SECRET_MSG), "telemetry error log strictly excludes fake secret in message");
    check(!errorLog.includes(FAKE_SECRET_NAME), "telemetry error log strictly excludes fake secret in name");
    check(
      errorLog.includes("[Telemetry] A telemetry listener threw an exception"),
      "telemetry logs sanitized fixed message without inspecting error",
    );
  }

  // 6.4 Malicious Proxy whose property/prototype inspection throws does not fail task
  {
    const explosiveProxy = new Proxy(
      {},
      {
        get(_target, prop) {
          throw new Error(`Explosive property access: ${String(prop)}`);
        },
        getPrototypeOf() {
          throw new Error("Explosive prototype inspection");
        },
        has() {
          throw new Error("Explosive has check");
        },
      },
    );

    const unsubscribe = onTaskTelemetry(() => {
      throw explosiveProxy;
    });

    endpointMode = "normal";
    const cache = new MemoryCache();
    let result: unknown = null;
    let thrown = false;
    try {
      result = await explainFolder(
        { dir: "src", files: [{ path: "src/helper.ts", hash: "help", role: null, exports: ["help"], fanIn: 0, fanOut: 0 }], incoming: [], outgoing: [] },
        { cache },
      );
    } catch {
      thrown = true;
    } finally {
      unsubscribe();
    }

    check(!thrown, "explosive proxy exception did NOT cause task to throw");
    check(Boolean(result && (result as { body?: string }).body), "task completed successfully despite explosive proxy");
    check(cache.writeCount === 1, "successful answer cached despite explosive proxy");
  }

  // 6.5 console.error itself throwing during telemetry error handling does not fail task
  {
    const originalConsoleError = console.error;
    console.error = () => {
      throw new Error("Catastrophic console.error stream failure!");
    };

    const unsubscribe = onTaskTelemetry(() => {
      throw new Error("Telemetry listener exploded!");
    });

    endpointMode = "normal";
    const cache = new MemoryCache();
    let result: unknown = null;
    let thrown = false;
    try {
      result = await explainFile(
        { path: "src/helper.ts", hash: "help1", role: "util", reachedBy: null, exports: ["help"], imports: [], importedBy: [] },
        { cache, source: async () => "export function help() { return 42; }" },
      );
    } catch {
      thrown = true;
    } finally {
      console.error = originalConsoleError;
      unsubscribe();
    }

    check(!thrown, "throwing console.error did NOT cause task to throw");
    check(Boolean(result && (result as { body?: string }).body), "task completed successfully despite console.error throwing");
    check(cache.writeCount === 1, "successful answer cached despite console.error throwing");
  }

  // 6.6 Missing response.usage does not crash task or telemetry
  {
    let telemetryFired = false;
    const unsubscribe = onTaskTelemetry(() => {
      telemetryFired = true;
    });

    endpointMode = "missing_usage";
    const cache = new MemoryCache();
    let result: unknown = null;
    let thrown = false;
    try {
      result = await explainFolder(
        { dir: "src", files: [{ path: "src/helper.ts", hash: "help", role: null, exports: ["help"], fanIn: 0, fanOut: 0 }], incoming: [], outgoing: [] },
        { cache },
      );
    } catch {
      thrown = true;
    }

    check(!thrown, "missing response.usage did NOT crash complete()");
    check(!telemetryFired, "telemetry skipped cleanly when response.usage is omitted");
    check(Boolean(result && (result as { body?: string }).body), "explainFolder completed cleanly without usage metadata");
    unsubscribe();
  }

  // 6.7 Partial response.usage (missing prompt_tokens / completion_tokens) handles safely
  {
    let receivedPayload: unknown = null;
    const unsubscribe = onTaskTelemetry((usage) => {
      receivedPayload = usage;
    });

    endpointMode = "partial_usage";
    const cache = new MemoryCache();
    let thrown = false;
    try {
      await answerQuestion(
        {
          question: "Query with partial usage",
          contextText: "--- File: src/helper.ts (lines 1-1)\nexport function help() { return 42; }\n",
          files: [{ path: "src/helper.ts", contentHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", totalLines: 1, windows: [{ startLine: 1, endLine: 1 }] }],
        },
        { cache },
      );
    } catch {
      thrown = true;
    }

    check(!thrown, "partial usage did not crash task");
    check(
      Boolean(receivedPayload && (receivedPayload as { promptTokens?: number }).promptTokens === 0),
      "partial usage defaulted promptTokens to 0",
    );
    check(
      Boolean(receivedPayload && (receivedPayload as { completionTokens?: number }).completionTokens === 0),
      "partial usage defaulted completionTokens to 0",
    );
    check(
      Boolean(receivedPayload && (receivedPayload as { totalTokens?: number }).totalTokens === 50),
      "partial usage preserved totalTokens",
    );
    unsubscribe();
  }

  // 6.8 Cache hit serves identical verified answer without dispatching provider call
  {
    endpointMode = "normal";
    const cache = new MemoryCache();
    const input = {
      question: "Cached query",
      contextText: "--- File: src/helper.ts (lines 1-1)\nexport function help() { return 42; }\n",
      files: [{ path: "src/helper.ts", contentHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", totalLines: 1, windows: [{ startLine: 1, endLine: 1 }] }],
    };

    // First call: fresh
    capturedRequests = [];
    const first = await answerQuestion(input, { cache });
    check(first.cached === false, "first call answered fresh");
    check(capturedRequests.length === 1, "first call made 1 provider call");

    // Second call: cache hit
    capturedRequests = [];
    const second = await answerQuestion(input, { cache });
    check(second.cached === true, "second call was a cache hit");
    check(capturedRequests.length === 0, "cache hit made 0 provider calls");
    check(second.body === first.body, "cache hit returned identical body");
  }
}

server.close();

console.log("\n========================================================");
console.log(`Task Budget Integration Results: ${passed} passed, ${failed} failed`);
console.log("========================================================");

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
