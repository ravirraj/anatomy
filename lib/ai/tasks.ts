import { createHash } from "node:crypto";
import { isModelRole, MODEL_ROLES, type ModelRole } from "../roles.ts";
import { traceable } from "langsmith/traceable";
import { ai, MODELS, openAIOnly, traceConfig } from "./client.ts";
import { verifyCitations, CitationError, extractCitations, type FileEvidence, type ManifestFile, type ParsedCitation } from "./citations.ts";
import {
  CLASSIFY_SYSTEM,
  classifyMessage,
  EXPLAIN_FILE_SYSTEM,
  EXPLAIN_FOLDER_SYSTEM,
  explainFileMessage,
  explainFolderMessage,
  QUESTION_SYSTEM,
  questionMessage,
  PROMPT_VERSION,
  type ClassifyInput,
  type FileInput,
  type FolderInput,
  type QuestionInput,
} from "./prompts.ts";

// The model calls, each behind its cache. The cache read is the first thing
// inside the traced function, so a hit is still a recorded run, one with no
// model call in it, and a broken cache is visible as a trace full of calls.

export type Task = "explain-file" | "explain-folder" | "classify-file" | "answer-question";

export type Cache = {
  read: (key: string) => Promise<string | null>;
  write: (entry: { key: string; task: Task; model: string; body: string }) => Promise<void>;
  /** Removes one entry. Best effort from the caller's side: a failed delete never blocks serving, because every read re-verifies. */
  delete: (key: string) => Promise<void>;
};

export type Explanation = { body: string; model: string; cached: boolean };
export type QuestionAnswer = { body: string; model: string; cached: boolean; citations: ParsedCitation[] };

// The source is only fetched on a miss: a hit answers from the stored hash alone.
export type SourceOf = () => Promise<string>;

// The largest file the parser reads is well under this; it's a backstop
// against an unexpectedly huge prompt, and the model is told when it applies.
const MAX_SOURCE_CHARS = 120_000;
const EXCERPT_LINES = 60;

export function cacheKey(task: Task, model: string, input: unknown): string {
  return createHash("sha256").update(JSON.stringify({ task, version: PROMPT_VERSION, model, input })).digest("hex");
}

export async function explainFile(input: FileInput, deps: { cache: Cache; source: SourceOf }): Promise<Explanation> {
  const model = MODELS.explain;
  const allowed = fileCitationsAllowed(input);
  const run = traceable(async (question: FileInput): Promise<Explanation> => {
    const key = cacheKey("explain-file", model, question);
    const hit = await deps.cache.read(key);
    if (hit !== null) {
      // A cached answer is still an answer: verify it before serving it.
      verifyCitationsBody(hit, allowed);
      return { body: hit, model, cached: true };
    }
    const body = await complete(model, EXPLAIN_FILE_SYSTEM, explainFileMessage(question, capped(await deps.source())));
    verifyCitationsBody(body, allowed);
    await deps.cache.write({ key, task: "explain-file", model, body });
    return { body, model, cached: false };
  }, traceConfig("explain-file"));
  return run(input);
}

export async function explainFolder(input: FolderInput, deps: { cache: Cache }): Promise<Explanation> {
  const model = MODELS.explain;
  const allowed = folderCitationsAllowed(input);
  const run = traceable(async (question: FolderInput): Promise<Explanation> => {
    const key = cacheKey("explain-folder", model, question);
    const hit = await deps.cache.read(key);
    if (hit !== null) {
      verifyCitationsBody(hit, allowed);
      return { body: hit, model, cached: true };
    }
    const body = await complete(model, EXPLAIN_FOLDER_SYSTEM, explainFolderMessage(question));
    verifyCitationsBody(body, allowed);
    await deps.cache.write({ key, task: "explain-folder", model, body });
    return { body, model, cached: false };
  }, traceConfig("explain-folder"));
  return run(input);
}

export async function answerQuestion(
  input: QuestionInput,
  deps: {
    cache: Cache;
    complete?: (model: string, system: string, user: string) => Promise<string>;
    allAnalysisFiles?: Set<string>;
    manifestsByPath?: Map<string, ManifestFile>;
    analysisId?: string;
  },
): Promise<QuestionAnswer> {
  const model = MODELS.question;
  const allowedEvidence = new Map<string, FileEvidence>();
  for (const f of input.files) {
    allowedEvidence.set(f.path, {
      lines: f.totalLines,
      contentHash: f.contentHash,
      ...(f.windows ? { windows: f.windows } : {}),
    });
  }

  const run = traceable(async (question: QuestionInput): Promise<QuestionAnswer> => {
    // Cache identity is the exact input the model sees: the system prompt and
    // the rendered user message. The message carries the question, the whole
    // formatted context (windows, packaging, API surface, formatting) and the
    // coverage block, so packaging or coverage changes that leave the file
    // hashes untouched still change the key. The task's old files list is not
    // in the payload: everything citable is rendered into the message, whose
    // window headers name each file and its hash. The question is keyed in
    // lower case — the model still receives the original text — so a casing
    // difference keeps hitting the same answer, as before. Both renders come
    // from the same questionMessage; only the question field differs.
    const key = cacheKey("answer-question", model, {
      system: QUESTION_SYSTEM,
      body: questionMessage({
        ...question,
        question: question.question.trim().toLowerCase(),
      }),
    });

    const hit = await deps.cache.read(key);
    if (hit !== null) {
      try {
        verifyCitationsEvidence(hit, allowedEvidence, deps.allAnalysisFiles, deps.manifestsByPath, deps.analysisId);
        return {
          body: hit,
          model,
          cached: true,
          citations: extractCitations(hit, {
            allAnalysisFiles: deps.allAnalysisFiles,
            manifestsByPath: deps.manifestsByPath,
            analysisId: deps.analysisId,
          }),
        };
      } catch (error) {
        // A cached answer whose evidence no longer verifies is never served:
        // not as the answer, and not as a citation set. Drop the entry (best
        // effort) and regenerate; the fresh answer faces the same verification
        // below before it is served or cached. One regeneration per ask — the
        // hit path never recurses into itself, so a poisoned entry cannot
        // loop.
        if (!(error instanceof CitationError)) throw error;
        try {
          await deps.cache.delete(key);
        } catch {
          // Deletion failing is not a reason to fail the ask: the entry, if
          // it somehow remains, is also never served, because reads
          // re-verify every time. (If the write below also lands, the cached
          // spot may keep the old row when the cache stores ignore
          // duplicates — the verification here is what keeps it inert.)
        }
      }
    }

    const completer = deps.complete ?? complete;
    const body = await completer(model, QUESTION_SYSTEM, questionMessage(question));
    verifyCitationsEvidence(body, allowedEvidence, deps.allAnalysisFiles, deps.manifestsByPath, deps.analysisId);
    await deps.cache.write({ key, task: "answer-question", model, body });
    return {
      body,
      model,
      cached: false,
      citations: extractCitations(body, {
        allAnalysisFiles: deps.allAnalysisFiles,
        manifestsByPath: deps.manifestsByPath,
        analysisId: deps.analysisId,
      }),
    };
  }, traceConfig("answer-question"));

  return run(input);
}

function verifyCitationsEvidence(
  body: string,
  allowed: Map<string, FileEvidence>,
  allAnalysisFiles?: Set<string>,
  manifestsByPath?: Map<string, ManifestFile>,
  analysisId?: string,
): void {
  const failing = verifyCitations(body, allowed, { allAnalysisFiles, manifestsByPath, analysisId });
  if (failing.paths.length) throw new CitationError(failing.paths, failing.details);
}

// Every path the model was allowed to name: the file itself, what reaches it,
// and everything it imports or is imported by.
function fileCitationsAllowed(input: FileInput): Set<string> {
  const allowed = new Set<string>([input.path]);
  if (input.reachedBy) allowed.add(input.reachedBy);
  for (const n of input.imports) allowed.add(n.path);
  for (const n of input.importedBy) allowed.add(n.path);
  return allowed;
}

// Every path the model was allowed to name for a folder: the folder, its
// files, and both ends of every edge crossing the folder boundary.
function folderCitationsAllowed(input: FolderInput): Set<string> {
  const allowed = new Set<string>([input.dir]);
  for (const f of input.files) allowed.add(f.path);
  for (const e of input.incoming) {
    allowed.add(e.from);
    allowed.add(e.to);
  }
  for (const e of input.outgoing) {
    allowed.add(e.from);
    allowed.add(e.to);
  }
  return allowed;
}

function verifyCitationsBody(body: string, allowed: Set<string>): void {
  const failing = verifyCitations(body, allowed);
  if (failing.paths.length) throw new CitationError(failing.paths);
}

// "none" is a real answer, and cached like any other: the model wasn't made
// to pick something when nothing fits, and the file stays unclassified.
const NONE = "none";

// The role the model may give, as a schema. The answer is checked against it
// afterwards, so a model that answers outside it is refused rather than stored.
const ROLE_SCHEMA = {
  type: "object",
  properties: { role: { type: "string", enum: [...MODEL_ROLES, NONE] } },
  required: ["role"],
  additionalProperties: false,
} as const;

export async function classifyFile(input: ClassifyInput, deps: { cache: Cache; source: SourceOf }): Promise<{ role: ModelRole | null; cached: boolean }> {
  const model = MODELS.classify;
  const run = traceable(async (question: ClassifyInput): Promise<{ role: ModelRole | null; cached: boolean }> => {
    const key = cacheKey("classify-file", model, question);
    const hit = await deps.cache.read(key);
    if (hit !== null) return { role: parseRole(hit), cached: true };
    const excerpt = (await deps.source()).split("\n").slice(0, EXCERPT_LINES).join("\n");
    const answer = readRole(await askForRole(model, CLASSIFY_SYSTEM, classifyMessage(question, excerpt)));
    // Parsed before caching, so a refused answer is never stored and served.
    const role = parseRole(answer);
    await deps.cache.write({ key, task: "classify-file", model, body: answer });
    return { role, cached: false };
  }, traceConfig("classify-file"));
  return run(input);
}

function parseRole(answer: string): ModelRole | null {
  if (answer === NONE) return null;
  // Structural roles aren't in the schema, but the answer is checked rather
  // than trusted: convention alone decides what's routable.
  if (!isModelRole(answer)) throw new Error(`The model answered the role "${answer}", which it isn't allowed to give`);
  return answer;
}

function readRole(content: string | null): string {
  if (!content) throw new Error("The model returned no role");
  const parsed: unknown = JSON.parse(content);
  const role: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "role") : undefined;
  if (typeof role !== "string") throw new Error(`The model's answer had no role: ${content}`);
  return role;
}

async function complete(model: string, system: string, user: string): Promise<string> {
  let attempts = 0;
  while (true) {
    attempts++;
    const t0 = performance.now();
    try {
      const response = await ai().chat.completions.create({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        reasoning_effort: "low",
        max_completion_tokens: 3500,
        ...openAIOnly(),
      });
      const elapsed = Math.round(performance.now() - t0);
      const usage = response.usage;
      if (usage) {
        console.log(
          `[AI complete] model=${model} elapsed=${elapsed}ms promptTokens=${usage.prompt_tokens} completionTokens=${usage.completion_tokens}`,
        );
      }
      const body = takeCompletion(model, response.choices[0]);
      return body;
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      const isTransient = status === 503 || status === 429 || status === 502;
      if (isTransient && attempts <= 3) {
        const delayMs = attempts * 3000;
        console.warn(`[AI complete] Transient ${status} error, retrying attempt ${attempts}/3 in ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
}

// A completion's text is taken only together with what the endpoint says
// about how it ended. These answers are cached, so a body the endpoint cut
// off mid-flight would be poisoning, not just one bad answer — and a
// termination reason that can't be interpreted can't be trusted either.
//
//   stop                         accepted
//   length / max_tokens          refused: cut off by the token limit
//   content_filter               refused: withheld by a filter (refusal, not truncation)
//   tool_calls / function_call   refused: no way to end a text answer
//   missing / null / ""          accepted with a warning: absence is not
//                                evidence of truncation, and plenty of
//                                OpenAI-compatible endpoints send none
//   anything else                refused: an unknown reason may well mean
//                                "cut off", and cannot be read as complete
// ("max_tokens" is the native stop name several OpenAI-compatible shims
// expose for their own token cap; OpenAI itself uses "length".)
type CompletionChoice = { message: { content: string | null }; finish_reason: string | null | undefined };

function takeCompletion(model: string, choice: CompletionChoice): string {
  if (!choice) throw new Error(`${model} returned an empty answer (finish reason: none)`);
  const reason: string | null | undefined = choice.finish_reason;
  const body = choice.message.content?.trim();
  if (reason === undefined || reason === null || reason === "") {
    // Missing metadata is compatible, not trustworthy: accept loudly rather
    // than pattern-matching it into a pretend stop.
    console.warn(`[AI complete] ${model} gave no termination reason; accepting its answer by convention`);
  } else {
    switch (reason) {
      case "stop":
        break;
      case "length":
      case "max_tokens":
        throw new Error(
          `${model} was cut off by the completion-token limit (finish reason "${reason}"): the incomplete answer was neither served nor stored`,
        );
      case "content_filter":
        throw new Error(
          `${model} stopped on a content filter (finish reason "content_filter"): the withheld answer was neither served nor stored`,
        );
      case "tool_calls":
        throw new Error(
          `${model} ended with a tool call (finish reason "tool_calls"), not a text answer: nothing was served or stored`,
        );
      case "function_call":
        throw new Error(
          `${model} ended with a function call (finish reason "function_call"), not a text answer: nothing was served or stored`,
        );
      default:
        throw new Error(
          `${model} ended with the unrecognized termination reason "${reason}", which cannot be read as a complete answer: nothing was served or stored`,
        );
    }
  }
  if (!body) throw new Error(`${model} returned an empty answer (finish reason: ${reason ?? "none"})`);
  return body;
}

// The role is asked for as a strict JSON schema. Not every endpoint
// implements that, so a refusal falls back to plain JSON mode, which every
// one of them does. Either way the answer is checked before it is stored.
async function askForRole(model: string, system: string, user: string): Promise<string | null> {
  const base = {
    model,
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
    reasoning_effort: "low" as const,
    ...openAIOnly(),
  };
  try {
    const response = await ai().chat.completions.create({
      ...base,
      response_format: {
        type: "json_schema",
        json_schema: { name: "file_role", strict: true, schema: ROLE_SCHEMA },
      },
    });
    return takeCompletion(model, response.choices[0]);
  } catch (error) {
    if (!schemaRefused(error)) throw error;
    const response = await ai().chat.completions.create({
      ...base,
      response_format: { type: "json_object" },
    });
    return takeCompletion(model, response.choices[0]);
  }
}

// An endpoint that doesn't implement the schema says so, usually with a 400.
// Anything else is a real failure and is not retried.
function schemaRefused(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: number }).status;
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return /json_schema|response_format|structured output|schema/i.test(error.message);
}

function capped(source: string): string {
  if (source.length <= MAX_SOURCE_CHARS) return source;
  const kept = source.slice(0, MAX_SOURCE_CHARS);
  return `${kept}\n[… source truncated here: ${source.length - MAX_SOURCE_CHARS} more characters not shown]`;
}
