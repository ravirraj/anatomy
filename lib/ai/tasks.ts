import { createHash } from "node:crypto";
import { isModelRole, MODEL_ROLES, type ModelRole } from "../roles.ts";
import { traceable } from "langsmith/traceable";
import { ai, MODELS, openAIOnly, traceConfig } from "./client.ts";
import { verifyCitations, CitationError, extractCitations, type FileEvidence, type ParsedCitation } from "./citations.ts";
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
  deps: { cache: Cache; complete?: (model: string, system: string, user: string) => Promise<string> },
): Promise<QuestionAnswer> {
  const model = MODELS.question;
  const allowedEvidence = new Map<string, FileEvidence>();
  for (const f of input.files) {
    allowedEvidence.set(f.path, { lines: f.totalLines, contentHash: f.contentHash });
  }

  const run = traceable(async (question: QuestionInput): Promise<QuestionAnswer> => {
    const key = cacheKey("answer-question", model, {
      q: question.question.trim().toLowerCase(),
      files: [...question.files]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((f) => ({ path: f.path, hash: f.contentHash })),
    });

    const hit = await deps.cache.read(key);
    if (hit !== null) {
      verifyCitationsEvidence(hit, allowedEvidence);
      return { body: hit, model, cached: true, citations: extractCitations(hit) };
    }

    const completer = deps.complete ?? complete;
    const body = await completer(model, QUESTION_SYSTEM, questionMessage(question));
    verifyCitationsEvidence(body, allowedEvidence);
    await deps.cache.write({ key, task: "answer-question", model, body });
    return { body, model, cached: false, citations: extractCitations(body) };
  }, traceConfig("answer-question"));

  return run(input);
}

function verifyCitationsEvidence(body: string, allowed: Map<string, FileEvidence>): void {
  const failing = verifyCitations(body, allowed);
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
  const response = await ai().chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    reasoning_effort: "low",
    ...openAIOnly(),
  });
  const body = response.choices[0]?.message.content?.trim();
  if (!body) throw new Error(`${model} returned an empty answer (finish reason: ${response.choices[0]?.finish_reason ?? "none"})`);
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
    return response.choices[0]?.message.content ?? null;
  } catch (error) {
    if (!schemaRefused(error)) throw error;
    const response = await ai().chat.completions.create({
      ...base,
      response_format: { type: "json_object" },
    });
    return response.choices[0]?.message.content ?? null;
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
