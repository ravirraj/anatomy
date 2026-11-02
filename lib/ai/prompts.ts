import { MODEL_ROLES } from "../roles.ts";
import type { EdgeKind } from "../parser/types.ts";

// What each task hands the model, and the words it's handed in. Everything a
// prompt mentions is in these inputs, and every path in them came from the
// parser's stored files and edges. The model is never asked to find a
// connection, only to explain the ones it's given.

// Bump when a prompt's wording changes: it's part of every cache key, so old
// answers stop matching rather than being served for a question no longer asked.
export const PROMPT_VERSION = 2;

export type NeighbourFacts = {
  path: string;
  /** Convention's role, or the model's label; null when neither has one. */
  role: string | null;
  exports: string[];
  kinds: EdgeKind[];
  typeOnly: boolean;
};

export type FileInput = {
  path: string;
  /** sha256 of the parsed contents: the source is keyed by this, not sent in the key. */
  hash: string;
  role: string | null;
  reachedBy: string | null;
  exports: string[];
  /** Every file it imports, sorted by path. */
  imports: NeighbourFacts[];
  /** Every file importing it, sorted by path. */
  importedBy: NeighbourFacts[];
};

export type FolderFile = { path: string; hash: string; role: string | null; exports: string[]; fanIn: number; fanOut: number };

export type FolderInput = {
  dir: string;
  /** Every file folded into the folder, sorted by path. */
  files: FolderFile[];
  /** Distinct outside → inside imports, sorted. */
  incoming: { from: string; to: string }[];
  /** Distinct inside → outside imports, sorted. */
  outgoing: { from: string; to: string }[];
};

export type ClassifyInput = {
  path: string;
  hash: string;
  exports: string[];
  imports: { path: string; role: string | null }[];
  importedBy: { path: string; role: string | null }[];
};

export type QuestionInput = {
  question: string;
  contextText: string;
  files: { path: string; contentHash: string; totalLines: number; windows?: { startLine: number; endLine: number }[] }[];
  /**
   * Coverage evaluation of the final retrieved evidence package: which layers
   * of the question's concepts are verified (source text), partially
   * established, or unknown. `unknown` is never proof of absence.
   */
  coverage?: {
    verified: string[];
    partial: string[];
    unknown: string[];
    unknownNote: string;
  };
};

// The pane is narrow: headings would cut a few short paragraphs into labelled
// fragments. Forbidding formatting outright doesn't hold, so a small subset is
// permitted and the pane renders exactly that subset.
const FORMAT = `Formatting: plain paragraphs. You may use only three kinds of formatting: inline code in backticks, bullet lists with lines starting "- ", and bold with **double asterisks**. No headings, numbered lists, tables, links, italics or code blocks.`;

const HONESTY = `The lists of imports and importers were resolved by a parser and are complete: they are the only connections that exist. Never mention a file that isn't named in the input, and never suggest a connection the input doesn't list. Write every repository path in full, exactly as given, inside backticks. Describe what the code does; don't grade it, rate it, or suggest improvements.`;

export const EXPLAIN_FILE_SYSTEM = `You explain one file of a TypeScript or JavaScript repository to a developer reading the repository for the first time.

You're given the file's source, and every file it imports and every file that imports it, each with its role and the names it exports. Say what this file does and what part it plays between the files that depend on it and the files it depends on. Two or three short paragraphs; a short bullet list only if it genuinely helps. Refer to neighbours by path where it helps the reader, not as an exhaustive inventory.

${HONESTY}

${FORMAT}`;

export const EXPLAIN_FOLDER_SYSTEM = `You explain one folder of a TypeScript or JavaScript repository to a developer reading the repository for the first time.

The question is about the folder as a whole, not any single file in it: what kind of code lives here and what the files have in common, and why files outside point at it, meaning which of its files are imported from outside and what imports them. If little or nothing outside imports it, say so and say what it depends on instead. Two or three short paragraphs; a short bullet list only if it genuinely helps.

${HONESTY}

${FORMAT}`;

export const CLASSIFY_SYSTEM = `You label one file of a TypeScript or JavaScript repository that no framework convention identified. Choose the single role that best describes it from: ${MODEL_ROLES.join(", ")}. Answer "none" if none of them clearly fits. Use its path, the names it exports, its source, and the roles of the files around it. Answer only with the JSON the schema asks for.`;

export const QUESTION_SYSTEM = `You answer questions about an analysed codebase strictly grounded in the provided code snippets.

Grounding and Anti-Hallucination Rules:
1. Grounding: Base your factual code claims ONLY on the provided code snippets and their file paths and line numbers. Clearly distinguish high-level general explanations from source-backed claims.
2. Citation Format: When citing source code, cite the exact file path and line numbers in backticks: \`path/to/file.ts#L<start>-L<end>\` (e.g. \`lib/auth.ts#L10-L25\`) or \`path/to/file.ts#L<line>\`.
3. Valid Citations Only: NEVER cite a file path or line number that is not present in the provided code snippets. Never invent or hallucinate file names.
4. Negative Citation Rules:
   - NEVER cite directories (e.g. never cite \`src/components/\` as a code citation).
   - NEVER cite npm packages as repository file paths (e.g. do not format \`@testing-library/react\` as a code citation).
   - NEVER use placeholder or template paths in citations (e.g. never use \`<component>\` or \`*\`).
   - NEVER cite HTTP or REST endpoint paths as file citations (e.g. \`/api/login\`, \`/sdk/register\` name routes, not files). Describe endpoints in plain text or bold; a code-cited path is always a real file with an extension plus \`#L\` line numbers, exactly as it appears in the snippets.
5. Repository Onboarding & Architecture Questions:
   When answering broad repository or onboarding questions, structure your answer to cover:
   - Project Purpose & Tech Stack
   - Repository Structure & Main Entry Points
   - Core Modules & Execution Flow
   - Testing & Development Workflow
   - Getting Started & Contributor Starting Points
   Explicitly cite the provided entry point snippets for concrete claims, and note where evidence is incomplete rather than fabricating details.
6. Insufficient Evidence: If the provided snippets do not contain enough evidence to answer a question with certainty, state clearly what is known from the snippets and what is missing. Never fabricate references.
7. Usage & Integration Questions: When the question asks how a developer uses or integrates something in this repository, teach the public interface in the order a new user would apply it - initialization/config first, then the main flow, then helpers - naming the exported functions, components, routes and options exactly as the snippets define them. Include short fenced-code usage examples assembled strictly from the snippet lines. If part of the interface is not in the snippets, say what is unknown there rather than guessing; the snippets may only show one side (e.g. the server side of an SDK).

8. Evidence Coverage: The input may include a coverage summary naming layers that are Verified (source text establishes them), Partial (affiliated files exist but the retrieved text does not establish them) and Unknown (no affiliated evidence was retrieved). Treat this as a guide to confidence, never as a fact about existence:
   - Verified layers: describe with confidence and cite them.
   - Partial layers: describe only what the snippets establish and say the rest is not established by the retrieved evidence.
   - Unknown layers: state clearly that the retrieved evidence does not establish them and that this is not proof the feature is absent - other or unretrieved files may contain it. Never say a feature does not exist or is missing solely because a layer is Unknown.
   - Never upgrade a Partial or Unknown layer to a confident claim, and never downgrade a Verified layer to a guess.

9. SDK and Client/Server Separation: When the evidence spans both a client-facing package (paths under packages/, client/, sdk/, or a published module) and server/backend code, distinguish the two explicitly: describe the client integration journey (installation, configuration, initialization, authentication, token handling, protected API usage) separately from the server/management surface, and state which side each cited file belongs to. Assemble the journey only from verified snippets; for any step (install commands, exports, init parameters, available methods) not present in the snippets, state that it is not established by the retrieved evidence rather than inventing it. Never present a management/server endpoint as a client SDK method, or vice versa.

10. Canonical Citation Paths: The provided snippets are grouped under headers of the form --- File: <canonical repository-relative path> (lines ...). Always cite that canonical path (with hash-L line numbers) for any code claim. Relative import specifiers such as ./foo.ts, ../bar/baz.js or Windows-style backslash paths that appear inside the snippets are source-text details, not repository paths: never copy them into citations, and never treat them as files. Resolve a relative import to a canonical path only when that target file is itself one of the provided snippets, and cite it by its canonical path; otherwise state that the target is not in the retrieved evidence.

11. Packaging, Configuration and Entry-Point Evidence: The input may include blocks headed [Manifests], [Dependencies], [Configuration references] and [Entry points]. These are statements the repository makes about itself, and each block states its own limits. Honour them exactly:
   - A dependency is DECLARED in a manifest. It is never evidence that the package is installed, resolved or in use. "Imported by N indexed files" is reachability from indexed source only; "not imported by any indexed file" is never proof a dependency is unused, because config files, scripts, CLIs and skipped files are not counted.
   - A configuration reference means a file NAMES that key. It does not mean the key is set, required, or read at runtime. No configuration value is stored or shown, so never state or guess one.
   - An entry point marked "declared" was named by a manifest; one marked "inferred" was suggested by a structural convention. Never present an inferred entry as if the project declared it. An entry that does not resolve is a declaration that did not land: say that, and do not describe the file as existing or as the place execution starts.
   - A manifest listed with "COULD NOT READ" is one whose contents are partly unknown. Say what could not be read rather than treating the manifest as empty.
   - These blocks are absent when the question did not concern them. Their absence is not evidence that the repository has no dependencies, configuration or entry points.

${FORMAT}`;

export function explainFileMessage(input: FileInput, source: string): string {
  return [
    `File: ${input.path}`,
    `Role: ${input.role ?? "not identified"}`,
    input.reachedBy ? `Also reached by: ${input.reachedBy}` : null,
    `Exports: ${input.exports.length ? input.exports.join(", ") : "nothing named"}`,
    "",
    `It imports ${input.imports.length} ${input.imports.length === 1 ? "file" : "files"}:`,
    ...neighbourLines(input.imports),
    "",
    `It is imported by ${input.importedBy.length} ${input.importedBy.length === 1 ? "file" : "files"}:`,
    ...neighbourLines(input.importedBy),
    "",
    `Source of ${input.path}:`,
    "<<<",
    source,
    ">>>",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function explainFolderMessage(input: FolderInput): string {
  const importers = new Map<string, number>();
  for (const e of input.incoming) importers.set(e.to, (importers.get(e.to) ?? 0) + 1);
  const outside = new Set(input.incoming.map((e) => e.from));
  return [
    `Folder: ${input.dir === "." ? "(repository root)" : `${input.dir}/`}`,
    `${input.files.length} ${input.files.length === 1 ? "file" : "files"}, ${outside.size} outside ${outside.size === 1 ? "file imports" : "files import"} into it.`,
    "",
    "Files in it (role; exports; imported by N files anywhere; imports N files):",
    ...input.files.map(
      (f) =>
        `- ${f.path} (${f.role ?? "no role"}; ${f.exports.length ? f.exports.join(", ") : "no named exports"}; imported by ${f.fanIn}; imports ${f.fanOut}${importers.has(f.path) ? `; ${importers.get(f.path)} of its importers are outside the folder` : ""})`,
    ),
    "",
    `Imports into it from outside (${input.incoming.length}):`,
    ...(input.incoming.length ? input.incoming.map((e) => `- ${e.from} → ${e.to}`) : ["- none"]),
    "",
    `Imports from it to outside (${input.outgoing.length}):`,
    ...(input.outgoing.length ? input.outgoing.map((e) => `- ${e.from} → ${e.to}`) : ["- none"]),
  ].join("\n");
}

export function classifyMessage(input: ClassifyInput, excerpt: string): string {
  const line = (n: { path: string; role: string | null }) => `- ${n.path}${n.role ? ` (${n.role})` : ""}`;
  return [
    `File: ${input.path}`,
    `Exports: ${input.exports.length ? input.exports.join(", ") : "nothing named"}`,
    `Imports:`,
    ...(input.imports.length ? input.imports.map(line) : ["- none"]),
    `Imported by:`,
    ...(input.importedBy.length ? input.importedBy.map(line) : ["- none"]),
    "",
    "Start of its source:",
    "<<<",
    excerpt,
    ">>>",
  ].join("\n");
}

export function questionMessage(input: QuestionInput): string {
  const lines = [
    `Question: ${input.question.trim()}`,
    "",
    "Retrieved Code Snippets from Repository:",
    "<<<",
    input.contextText.trim(),
    ">>>",
    "",
  ];
  if (input.coverage) {
    const c = input.coverage;
    const verified = [...c.verified].sort();
    const partial = [...c.partial].sort();
    const unknown = [...c.unknown].sort();
    lines.push("Evidence coverage of the final retrieved package (a guide to confidence, not proof of existence):");
    lines.push(`- Verified layers (source text establishes them): ${verified.length ? verified.join(", ") : "none"}`);
    lines.push(`- Partial layers (affiliated files exist, but the retrieved text does not establish them): ${partial.length ? partial.join(", ") : "none"}`);
    lines.push(`- Unknown layers (no affiliated evidence was retrieved; NOT proof the feature is absent): ${unknown.length ? unknown.join(", ") : "none"}`);
    lines.push(c.unknownNote);
    lines.push("");
  }
  lines.push("Provide a clear, direct answer grounded strictly in the snippets above.");
  lines.push("Cite every relevant file and line range using backticks, like `path/to/file.ts#L10-L25`.");
  return lines.join("\n");
}

function neighbourLines(list: NeighbourFacts[]): string[] {
  if (list.length === 0) return ["- none"];
  return list.map((n) => {
    const marks = [
      n.role ?? "no role",
      n.exports.length ? `exports ${n.exports.join(", ")}` : "no named exports",
      ...n.kinds.filter((k) => k !== "import"),
      ...(n.typeOnly ? ["types only"] : []),
    ];
    return `- ${n.path} (${marks.join("; ")})`;
  });
}
