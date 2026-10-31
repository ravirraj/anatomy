// Packaging, configuration and entry-point evidence for retrieval.
//
// This module answers one question: given a query and an analysis, which of
// the repository's *declared* facts are worth putting in front of the model?
//
// It is deliberately not a second retrieval engine. It reads the same
// analysis, ranks with the same token machinery the file retrieval uses, and
// hands back plain text blocks that travel alongside the code windows. The
// model is told, in the block itself, whether a fact was declared or inferred
// and whether a dependency was merely listed or actually imported — so an
// answer can never quietly upgrade a declaration into a usage claim.
//
// Nothing here is keyed to a question's wording. A query that mentions no
// packaging vocabulary gets no packaging block; a query that does gets the
// facts, ranked by how well they match, not by which question was asked.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types.ts";
import { extractQueryTokens, identifierSubtokens, tokenVariants } from "./retrieval.ts";

type Db = SupabaseClient<Database>;

/**
 * Vocabulary that makes packaging facts relevant to a question. These are
 * *concepts*, not question templates: any question touching one of them gets
 * the same evidence, and a question touching none gets none. Kept small and
 * generic — every entry is a word about how software is packaged, configured
 * or started, not about any particular repository.
 */
const PACKAGING_TERMS = new Set([
  "dependency", "dependencies", "depend", "package", "packages", "manifest",
  "install", "installation", "version", "versions", "requirement", "requirements",
  "library", "libraries", "module", "modules", "npm", "pnpm", "yarn", "cargo",
  "golang", "python", "pip", "poetry", "workspace", "workspaces", "monorepo",
  "config", "configuration", "configure", "configured", "environment", "env",
  "variable", "variables", "setting", "settings", "secret", "secrets", "dotenv",
  "entry", "entrypoint", "entrypoints", "start", "starts", "starting", "run",
  "runs", "running", "boot", "bootstrap", "main", "bin", "cli", "executable",
  "export", "exports", "expose", "exposes", "exposed", "publish", "published",
  "integrate", "integration", "consume", "consumer", "usage", "use", "setup",
]);

/** How many rows of each kind one retrieval may carry. */
const MAX_DEPENDENCIES = 40;
const MAX_CONFIG = 30;
const MAX_ENTRIES = 20;
const MAX_MANIFESTS = 8;

export type PackagingEvidence = {
  /** True when the query touched packaging vocabulary at all. */
  relevant: boolean;
  /** Rendered blocks, in the order they should appear. */
  blocks: string[];
  /** What was included, for the retrieval result's own accounting. */
  counts: { manifests: number; dependencies: number; config: number; entries: number };
};

const NOT_RELEVANT: PackagingEvidence = {
  relevant: false,
  blocks: [],
  counts: { manifests: 0, dependencies: 0, config: 0, entries: 0 },
};

/**
 * True when the query names something this module knows about. Exported so a
 * caller can decide whether to pay for the queries at all.
 */
export function queryTouchesPackaging(rawQuery: string): boolean {
  for (const token of extractQueryTokens(rawQuery)) {
    if (PACKAGING_TERMS.has(token)) return true;
    for (const sub of identifierSubtokens(token)) if (PACKAGING_TERMS.has(sub)) return true;
    for (const variant of tokenVariants(token)) if (PACKAGING_TERMS.has(variant.text)) return true;
  }
  return false;
}

/** A JSONB column read back as the string array it was written as, or []. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** A JSONB scripts column read back as { name, command } pairs. */
function scriptList(value: unknown): { name: string; command: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const name = Reflect.get(entry, "name");
    const command = Reflect.get(entry, "command");
    return typeof name === "string" && typeof command === "string" ? [{ name, command }] : [];
  });
}

/**
 * Scores a row against the query tokens. The same shape as file retrieval's
 * name matching, so a dependency called "react" scores highest for the token
 * "react" and a manifest named "package.json" scores for "package".
 */
function scoreAgainst(tokens: readonly string[], fields: readonly string[]): number {
  let best = 0;
  const lowered = fields.map((f) => f.toLowerCase());
  for (const token of tokens) {
    for (const { text: variant, kind } of tokenVariants(token)) {
      const penalty = kind === "original" ? 0 : kind === "stem" ? 6 : 14;
      for (const field of lowered) {
        let score = 0;
        if (field === variant) score = 100;
        else if (identifierSubtokens(field).includes(variant)) score = 90;
        else if (field.includes(variant) && variant.length >= 3) score = 50;
        if (score - penalty > best) best = score - penalty;
      }
    }
  }
  return best;
}

/**
 * Loads the packaging evidence for one query. Reads with the caller's client,
 * so the analysis's organization policy decides what comes back.
 *
 * Every query filters by analysis_id, so nothing from another organization's
 * analysis can be reached even if an id were guessed.
 */
export async function loadPackagingEvidence(
  db: Db,
  analysisId: string,
  rawQuery: string,
): Promise<PackagingEvidence> {
  if (!queryTouchesPackaging(rawQuery)) return NOT_RELEVANT;
  const tokens = extractQueryTokens(rawQuery);
  if (tokens.length === 0) return NOT_RELEVANT;

  const [manifestsResult, dependenciesResult, configResult, entriesResult] = await Promise.all([
    db
      .from("manifests")
      .select("path, dir, ecosystem, name, workspaces, scripts, problems")
      .eq("analysis_id", analysisId),
    db
      .from("dependencies")
      .select("name, version, kind, manifest_path, dir, imported_by")
      .eq("analysis_id", analysisId),
    db
      .from("config_references")
      .select("file_path, variable, line, kind, detail")
      .eq("analysis_id", analysisId),
    db
      .from("entry_points")
      .select("path, kind, source, manifest_path, detail, resolved, unresolved_reason, via")
      .eq("analysis_id", analysisId),
  ]);

  // A failed read is not an empty repository. Each block is omitted rather
  // than rendered as "none", so an answer can never claim absence from a
  // query that did not run.
  const manifests = manifestsResult.error ? null : (manifestsResult.data ?? []);
  const dependencies = dependenciesResult.error ? null : (dependenciesResult.data ?? []);
  const config = configResult.error ? null : (configResult.data ?? []);
  const entries = entriesResult.error ? null : (entriesResult.data ?? []);

  const blocks: string[] = [];
  const counts = { manifests: 0, dependencies: 0, config: 0, entries: 0 };

  // ---- Manifests ----
  if (manifests && manifests.length > 0) {
    const ranked = manifests
      .map((m) => ({ m, score: scoreAgainst(tokens, [m.path, m.ecosystem, m.name ?? "", m.dir]) }))
      .sort((a, b) => b.score - a.score || a.m.path.localeCompare(b.m.path))
      .slice(0, MAX_MANIFESTS);
    const lines = ranked.map(({ m }) => {
      const parts = [`- ${m.path} (${m.ecosystem}${m.name ? `, declares "${m.name}"` : ""})`];
      const workspaces = stringArray(m.workspaces);
      const scripts = scriptList(m.scripts);
      const problems = stringArray(m.problems);
      if (workspaces.length > 0) parts.push(`workspaces: ${workspaces.join(", ")}`);
      if (scripts.length > 0) parts.push(`commands: ${scripts.map((s) => s.name).join(", ")}`);
      if (problems.length > 0) parts.push(`COULD NOT READ: ${problems.join("; ")}`);
      return parts.join("; ");
    });
    blocks.push(
      `[Manifests — declared by the repository]\n${lines.join("\n")}\n` +
        `A manifest states what the repository asks for. It does not show what is installed.`,
    );
    counts.manifests = ranked.length;
  }

  // ---- Dependencies ----
  if (dependencies && dependencies.length > 0) {
    const ranked = dependencies
      .map((d) => ({
        d,
        score: scoreAgainst(tokens, [d.name, d.kind, d.dir, d.manifest_path]),
      }))
      .sort((a, b) => b.score - a.score || b.d.imported_by - a.d.imported_by || a.d.name.localeCompare(b.d.name))
      .slice(0, MAX_DEPENDENCIES);
    const lines = ranked.map(({ d }) => {
      const version = d.version === null ? "no version declared" : d.version;
      const reach =
        d.imported_by > 0
          ? `imported by ${d.imported_by} indexed file${d.imported_by === 1 ? "" : "s"}`
          : "not imported by any indexed file (this does not prove it is unused)";
      return `- ${d.name} ${version} [${d.kind}] declared in ${d.manifest_path}; ${reach}`;
    });
    blocks.push(
      `[Dependencies — declared in manifests, not verified as installed]\n${lines.join("\n")}\n` +
        `These are declarations. Nothing here was read from a lockfile or an installed package tree, ` +
        `so "declared" never means "installed", and "not imported by any indexed file" never means "unused".`,
    );
    counts.dependencies = ranked.length;
  }

  // ---- Configuration ----
  if (config && config.length > 0) {
    const ranked = config
      .map((c) => ({ c, score: scoreAgainst(tokens, [c.variable, c.kind, c.file_path, c.detail ?? ""]) }))
      .sort((a, b) => b.score - a.score || a.c.variable.localeCompare(b.c.variable) || a.c.file_path.localeCompare(b.c.file_path))
      .slice(0, MAX_CONFIG);
    const lines = ranked.map(({ c }) => {
      const where = c.line > 0 ? `${c.file_path}#L${c.line}` : c.file_path;
      const detail = c.detail ? ` (${c.detail})` : "";
      return `- ${c.variable} — ${c.kind}${detail} at ${where}`;
    });
    blocks.push(
      `[Configuration references — variable NAMES only, never values]\n${lines.join("\n")}\n` +
        `A reference means this file names this key. It does not mean the key is set, required or read at runtime. ` +
        `No configuration value is stored or shown.`,
    );
    counts.config = ranked.length;
  }

  // ---- Entry points ----
  if (entries && entries.length > 0) {
    const ranked = entries
      .map((e) => ({
        e,
        score: scoreAgainst(tokens, [e.path, e.source, e.kind, e.detail ?? ""]),
      }))
      // Declared entries outrank inferred ones at equal relevance: a manifest
      // naming a file is stronger evidence than a convention suggesting one.
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(b.e.kind === "declared") - Number(a.e.kind === "declared") ||
          a.e.path.localeCompare(b.e.path),
      )
      .slice(0, MAX_ENTRIES);
    const lines = ranked.map(({ e }) => {
      const state = e.resolved
        ? "resolves to an indexed file"
        : e.unresolved_reason === "not-indexed"
          ? "exists but is not code this parser indexes"
          : "nothing is at that path";
      const detail = e.detail ? ` (${e.detail})` : "";
      const via = Array.isArray(e.via) && e.via.length > 0 ? `; re-exports ${e.via.join(", ")}` : "";
      return `- ${e.path} — ${e.kind} by ${e.source}${detail}; ${state}${via}`;
    });
    blocks.push(
      `[Entry points — declared and inferred, kept distinct]\n${lines.join("\n")}\n` +
        `"declared" means a manifest names this file. "inferred" means a structural convention does. ` +
        `An entry that does not resolve is a declaration that did not land, not an absence of one.`,
    );
    counts.entries = ranked.length;
  }

  return { relevant: true, blocks, counts };
}

/**
 * Renders the evidence for the model. Empty string when there is nothing to
 * say, which is different from saying "there is nothing".
 */
export function formatPackagingEvidence(evidence: PackagingEvidence): string {
  return evidence.blocks.join("\n\n");
}
