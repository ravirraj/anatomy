// The versioned language registry (Phase 5).
//
// One place that says which languages Anatomy recognizes, who owns each source
// extension, which manifest ecosystems speak to each language, and whether an
// adapter that actually parses the language exists. Recognition is NOT support:
// a language is supported only when `adapter` is non-null, and today that is
// exactly the JS/TS parser. A recognized-but-unsupported language is classified
// honestly — never reported as parsed, never given invented symbols or edges.
//
// The registry is closed within a release and open across releases: Phase 6
// adds a language by adding an entry (and an adapter id), never by scattering
// extension checks through the pipeline.

import { MANIFEST_ECOSYSTEMS, type ManifestEcosystem } from "../parser/types.ts";

export const LANGUAGE_REGISTRY_VERSION = 1;

export type LanguageId = "javascript" | "typescript" | "python" | "go" | "rust" | "java" | "c" | "cpp";

export const LANGUAGE_IDS: readonly LanguageId[] = [
  "javascript",
  "typescript",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
];

/** The one active source-code adapter: the existing JS/TS parser (ts-morph). */
export const JS_TS_ADAPTER = "js-ts-ts-morph";

export type LanguageEntry = {
  id: LanguageId;
  /** Display name. */
  name: string;
  /** Source extensions this language owns — dot-prefixed, lowercase, and globally unique in the registry. */
  extensions: readonly string[];
  /** Manifest ecosystems that declare this language. A subset of the parser's modeled ecosystems; empty when none is modeled yet. */
  manifestEcosystems: readonly ManifestEcosystem[];
  /** The adapter that parses this language, or null while it is recognized but unsupported. */
  adapter: string | null;
};

export const LANGUAGE_REGISTRY: readonly LanguageEntry[] = [
  {
    id: "javascript",
    name: "JavaScript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    manifestEcosystems: ["npm", "pnpm-workspace"],
    adapter: JS_TS_ADAPTER,
  },
  {
    id: "typescript",
    name: "TypeScript",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    manifestEcosystems: ["npm", "pnpm-workspace"],
    adapter: JS_TS_ADAPTER,
  },
  {
    id: "python",
    name: "Python",
    extensions: [".py", ".pyi"],
    manifestEcosystems: ["python-requirements", "python-project"],
    adapter: null,
  },
  {
    id: "go",
    name: "Go",
    extensions: [".go"],
    manifestEcosystems: ["go"],
    adapter: null,
  },
  {
    id: "rust",
    name: "Rust",
    extensions: [".rs"],
    manifestEcosystems: ["cargo"],
    adapter: null,
  },
  {
    id: "java",
    name: "Java",
    extensions: [".java"],
    // Maven/Gradle are not modeled manifest ecosystems yet; claiming none is
    // honest, inventing one is not.
    manifestEcosystems: [],
    adapter: null,
  },
  {
    id: "c",
    name: "C",
    // `.h` is deliberately owned by C, the language that defined it. It is
    // genuinely ambiguous between C and C++ (C++ projects use `.h` too), and
    // with no compiler in the pipeline the registry resolves it instead of
    // guessing. C++ owns the unambiguous `.cc`/`.cpp`/`.cxx`/`.hpp` family.
    extensions: [".c", ".h"],
    manifestEcosystems: [],
    adapter: null,
  },
  {
    id: "cpp",
    name: "C++",
    extensions: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
    manifestEcosystems: [],
    adapter: null,
  },
];

const EXTENSION_TO_LANGUAGE = new Map<string, LanguageId>();
for (const entry of LANGUAGE_REGISTRY) {
  for (const extension of entry.extensions) EXTENSION_TO_LANGUAGE.set(extension, entry.id);
}

/**
 * The language that owns this path's extension, or null when none does.
 * Extensions are matched case-insensitively (lowercased); a path with no
 * extension, or one the registry does not list, is not classified — an unknown
 * extension is unknown, not "some programming language".
 *
 * This answers *what language a path would be*, never *whether the file is
 * relevant*: relevance is the pipeline's recorded universe plus registry
 * recognition (see IrFileCoverage), and an unregistered extension is never
 * promoted to source code by context — a requirements.txt does not make
 * `.txt` files Python.
 */
export function detectLanguage(path: string): LanguageId | null {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot <= slash) return null;
  return EXTENSION_TO_LANGUAGE.get(path.slice(dot).toLowerCase()) ?? null;
}

/** The adapter that parses this language, or null when it is unsupported. */
export function languageAdapter(language: LanguageId | null): string | null {
  if (language === null) return null;
  return LANGUAGE_REGISTRY.find((entry) => entry.id === language)?.adapter ?? null;
}

/** True only when an adapter actually parses the language. Recognition is not support. */
export function isLanguageSupported(language: LanguageId): boolean {
  return languageAdapter(language) !== null;
}

/**
 * Self-check for the registry's own invariants. Pure data is checked once (in
 * tests, and cheaply anywhere else) rather than trusted.
 */
export function validateLanguageRegistry(): void {
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const seenExtensions = new Set<string>();
  const adapterLanguages = new Map<string, LanguageId[]>();
  for (const entry of LANGUAGE_REGISTRY) {
    if (seenIds.has(entry.id)) throw new Error(`language registry: duplicate id ${entry.id}`);
    seenIds.add(entry.id);
    if (entry.name.length === 0) throw new Error(`language registry: ${entry.id} has an empty display name`);
    if (seenNames.has(entry.name)) throw new Error(`language registry: duplicate display name ${entry.name}`);
    seenNames.add(entry.name);
    for (const extension of entry.extensions) {
      if (!/^\.[a-z0-9]+$/.test(extension)) {
        throw new Error(`language registry: ${entry.id} extension ${extension} must be a lowercase dot-prefixed form`);
      }
      if (seenExtensions.has(extension)) throw new Error(`language registry: extension ${extension} claimed twice`);
      seenExtensions.add(extension);
    }
    for (const ecosystem of entry.manifestEcosystems) {
      if (!(MANIFEST_ECOSYSTEMS as readonly string[]).includes(ecosystem)) {
        throw new Error(`language registry: ${entry.id} names unmodeled ecosystem ${ecosystem}`);
      }
    }
    if (entry.adapter !== null) {
      const languages = adapterLanguages.get(entry.adapter) ?? [];
      languages.push(entry.id);
      adapterLanguages.set(entry.adapter, languages);
    }
  }
  if (seenIds.size !== LANGUAGE_IDS.length) throw new Error("language registry: LANGUAGE_IDS and the registry disagree");
  // The current parser is the only active adapter, and it owns exactly JS/TS.
  const jsTs = adapterLanguages.get(JS_TS_ADAPTER);
  if (!jsTs || jsTs.length !== 2 || !jsTs.includes("javascript") || !jsTs.includes("typescript")) {
    throw new Error(`language registry: ${JS_TS_ADAPTER} must cover exactly JavaScript and TypeScript`);
  }
  for (const [adapter, languages] of adapterLanguages) {
    if (adapter !== JS_TS_ADAPTER && languages.length === 0) {
      throw new Error(`language registry: adapter ${adapter} claims no languages`);
    }
  }
}
