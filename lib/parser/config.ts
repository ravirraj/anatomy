// Configuration and environment references.
//
// The one hard rule in this module: it records *names*, never values. Every
// reader below matches a name-shaped token and stops at the name. Nothing here
// reads the right-hand side of an assignment, so a repository whose
// .env.example ships a real key cannot leak it through this path — there is no
// code here that could carry a value into the output even if it wanted to.
//
// What a reference means, precisely: this file names this configuration key at
// this line. It does not mean the key is set, required, or read at runtime —
// `process.env.X` inside a branch that never runs is still a reference.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ConfigReference, EnvDeclaration } from "./types.ts";

/** Environment template files, by exact name. */
const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist|defaults?)$/i;

/** Directories never descended into when looking for template files. */
const SKIP_DIRS = new Set(["node_modules", "vendor", "target", "dist", "build", ".git"]);

export type ConfigScan = {
  references: ConfigReference[];
  declarations: EnvDeclaration[];
};

/**
 * Scans one parsed file's text for configuration references. `path` is the
 * repository-relative path the reference is recorded against.
 *
 * Deliberately textual rather than AST-driven: the same three shapes appear in
 * TypeScript, JavaScript and the JSON/YAML the parser does not parse, and a
 * regex over a name token cannot accidentally capture a value the way a
 * hand-written expression walker could.
 */
export function scanSourceConfig(path: string, text: string): ConfigReference[] {
  const out: ConfigReference[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Cheap rejection: most lines mention no environment at all.
    if (!line.includes("env")) continue;
    const lineNumber = i + 1;

    // process.env.NAME — the dotted form.
    for (const m of line.matchAll(/\bprocess\s*\.\s*env\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
      out.push({ file: path, variable: m[1]!, line: lineNumber, kind: "process.env" });
    }
    // process.env["NAME"] and process.env['NAME'] — the bracket form. Only a
    // string literal is a name; process.env[key] is a computed lookup and is
    // not recorded, because the name is not written down.
    for (const m of line.matchAll(/\bprocess\s*\.\s*env\s*\[\s*["'`]([A-Za-z_$][A-Za-z0-9_$]*)["'`]\s*\]/g)) {
      out.push({ file: path, variable: m[1]!, line: lineNumber, kind: "env-bracket" });
    }
    // import.meta.env.NAME — Vite and friends.
    for (const m of line.matchAll(/\bimport\s*\.\s*meta\s*\.\s*env\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
      out.push({ file: path, variable: m[1]!, line: lineNumber, kind: "import.meta.env" });
    }
  }
  return out;
}

/**
 * Scans a parsed file for configuration *object* declarations: a top-level
 * object literal whose keys are configuration names. This catches the common
 * shape where a project centralises its settings:
 *
 *   export const config = { databaseUrl: ..., port: ... }
 *
 * Only the keys are recorded, and only for an object literal bound to a name
 * that reads as configuration. The values are never touched.
 */
export function scanConfigObjects(path: string, text: string): ConfigReference[] {
  const out: ConfigReference[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // `const config = {` / `export const settings = {` / `const CONFIG: X = {`
    const head = line.match(
      /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*\{/,
    );
    if (!head) continue;
    const objectName = head[1]!;
    if (!/config|settings|options|env|environment/i.test(objectName)) continue;

    // Walk forward to the matching brace, recording depth-1 keys only, so a
    // nested object's keys are not mistaken for the config's own.
    let depth = 0;
    let opened = false;
    for (let j = i; j < lines.length; j++) {
      const current = j === i ? lines[j]!.slice(lines[j]!.indexOf("{", head.index ?? 0)) : lines[j]!;
      for (let k = 0; k < current.length; k++) {
        const ch = current[k];
        if (ch === "{") {
          depth++;
          opened = true;
          continue;
        }
        if (ch === "}") {
          depth--;
          if (opened && depth === 0) return out;
          continue;
        }
      }
      if (depth === 1) {
        // A key at depth 1: `name:` or `"name":`, optionally quoted.
        const key = current.match(/^\s*["']?([A-Za-z_$][A-Za-z0-9_$]*)["']?\s*:/);
        if (key) {
          out.push({
            file: path,
            variable: key[1]!,
            line: j + 1,
            kind: "config-object",
            detail: objectName,
          });
        }
      }
      if (j - i > 200) break; // a runaway object is not a config literal
    }
  }
  return out;
}

/**
 * Finds environment template files under the repository root and records the
 * keys each declares. Values are never read: the line is split at the first
 * `=` and only the left side is kept.
 */
export function scanEnvTemplates(root: string): ConfigScan {
  const references: ConfigReference[] = [];
  const declarations: EnvDeclaration[] = [];

  const visit = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        visit(path.join(dir, entry.name), relative);
        continue;
      }
      if (!entry.isFile() || !ENV_TEMPLATE.test(entry.name)) continue;
      let text: string;
      try {
        text = readFileSync(path.join(dir, entry.name), "utf8");
      } catch {
        continue;
      }
      const keys: string[] = [];
      for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        // `export NAME=value` and `NAME=value` both declare NAME.
        const withoutExport = line.replace(/^export\s+/, "");
        const eq = withoutExport.indexOf("=");
        const key = (eq === -1 ? withoutExport : withoutExport.slice(0, eq)).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        // The right-hand side is deliberately never read.
        keys.push(key);
        references.push({ file: relative, variable: key, line: 0, kind: "env-example" });
      }
      if (keys.length > 0) declarations.push({ path: relative, keys });
    }
  };

  visit(root, "");
  return { references, declarations };
}

/**
 * Collapses references to one entry per (file, variable, kind, line) and sorts
 * them, so the stored list is stable across runs and machines.
 */
export function dedupeConfigReferences(references: readonly ConfigReference[]): ConfigReference[] {
  const seen = new Map<string, ConfigReference>();
  for (const ref of references) {
    const key = `${ref.file}\0${ref.variable}\0${ref.kind}\0${ref.line}`;
    if (!seen.has(key)) seen.set(key, ref);
  }
  return [...seen.values()].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.variable.localeCompare(b.variable) ||
      a.kind.localeCompare(b.kind),
  );
}
