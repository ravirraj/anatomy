import type { SupabaseClient } from "@supabase/supabase-js";
import { getFileLines } from "../content/read.ts";
import type { Database } from "../supabase/database.types.ts";

export type Db = SupabaseClient<Database>;

export type RetrievalBudget = {
  maxCharacters?: number;
  maxFiles?: number;
  maxWindowsPerFile?: number;
  seedLimit?: number;
};

export const DEFAULT_BUDGET: Required<RetrievalBudget> = {
  maxCharacters: 30000,
  maxFiles: 8,
  maxWindowsPerFile: 3,
  seedLimit: 6,
};

export type TargetWindow = {
  fileId: string;
  path: string;
  contentHash: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  score: number;
  reason: string;
};

export type RetrievedWindow = {
  fileId: string;
  path: string;
  contentHash: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
  reason: string;
};

export type RetrievalResult = {
  analysisId: string;
  query: string;
  tokens: string[];
  windows: RetrievedWindow[];
  files: { fileId: string; path: string; contentHash: string; totalLines: number }[];
  totalCharacters: number;
  insufficientEvidence: boolean;
};

// Common English question words and stop-words to exclude from seed token matching
const STOP_WORDS = new Set([
  "a", "about", "across", "all", "an", "and", "any", "are", "as", "at",
  "be", "between", "both", "but", "by", "can", "do", "does", "each",
  "explain", "file", "files", "for", "from", "get", "has", "have", "how",
  "in", "is", "it", "its", "make", "of", "on", "or", "over", "repository",
  "repo", "show", "tell", "that", "the", "their", "there", "this", "through",
  "to", "under", "up", "used", "what", "when", "where", "which", "who", "why",
  "with", "work", "works",
]);

/**
 * Normalizes query string and extracts candidate identifier tokens, path fragments,
 * and keywords across camelCase, snake_case, and kebab-case.
 */
export function extractQueryTokens(rawQuery: string): string[] {
  const query = rawQuery.trim();
  if (!query) return [];

  const tokens = new Set<string>();

  // Extract explicit path-like or dot-like tokens (e.g. "auth/session.ts", "lib/ai", "route.ts")
  const pathMatches = query.match(/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+/g) ?? [];
  for (const m of pathMatches) {
    tokens.add(m.toLowerCase());
  }

  // Split into whitespace and punctuation separated words
  const words = query
    .replace(/[^\w\s\-./]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  for (const word of words) {
    const lower = word.toLowerCase();
    if (lower.length >= 2 && !STOP_WORDS.has(lower)) {
      tokens.add(lower);
    }

    // Split camelCase and PascalCase identifiers (e.g. "createAdminSupabase" -> "create", "admin", "supabase")
    const camelParts = word.replace(/([a-z])([A-Z])/g, "$1 $2").split(/\s+/);
    if (camelParts.length > 1) {
      for (const part of camelParts) {
        const pLower = part.toLowerCase();
        if (pLower.length >= 2 && !STOP_WORDS.has(pLower)) {
          tokens.add(pLower);
        }
      }
    }

    // Split snake_case and kebab-case identifiers (e.g. "auth_middleware" -> "auth", "middleware")
    const splitParts = word.split(/[-_]/);
    if (splitParts.length > 1) {
      for (const part of splitParts) {
        const pLower = part.toLowerCase();
        if (pLower.length >= 2 && !STOP_WORDS.has(pLower)) {
          tokens.add(pLower);
        }
      }
    }
  }

  return [...tokens];
}

/**
 * Core deterministic retrieval engine:
 * 1. Discovers seeds across symbols, routes, and file paths.
 * 2. Ranks candidates by evidence match strength.
 * 3. Expands seeds through 1-hop dependency relationships.
 * 4. Merges overlapping windows.
 * 5. Retrieves bounded source code windows using the content read service.
 */
export async function retrieveGroundedContext(
  db: Db,
  analysisId: string,
  rawQuery: string,
  budget: RetrievalBudget = {},
): Promise<RetrievalResult> {
  const config = { ...DEFAULT_BUDGET, ...budget };
  const tokens = extractQueryTokens(rawQuery);

  if (tokens.length === 0) {
    return {
      analysisId,
      query: rawQuery,
      tokens: [],
      windows: [],
      files: [],
      totalCharacters: 0,
      insufficientEvidence: true,
    };
  }

  // Stage 1: Load indexed files for this analysis
  const { data: filesData, error: filesError } = await db
    .from("files")
    .select("id, path, hash, lines, content_status, file_roles(role, source)")
    .eq("analysis_id", analysisId)
    .is("skip_reason", null);

  if (filesError) {
    throw new Error(`Failed to load files for analysis ${analysisId}: ${filesError.message}`);
  }

  const fileMap = new Map<
    string,
    {
      id: string;
      path: string;
      hash: string;
      lines: number;
      role: string | null;
    }
  >();

  for (const f of filesData ?? []) {
    if (f.hash && typeof f.lines === "number") {
      const roleRow = f.file_roles?.[0];
      fileMap.set(f.id, {
        id: f.id,
        path: f.path,
        hash: f.hash,
        lines: f.lines,
        role: roleRow?.role ?? null,
      });
    }
  }

  if (fileMap.size === 0) {
    return {
      analysisId,
      query: rawQuery,
      tokens,
      windows: [],
      files: [],
      totalCharacters: 0,
      insufficientEvidence: true,
    };
  }

  // Stage 2: Discover candidate seeds from symbols, routes, and files
  const seedWindows: TargetWindow[] = [];

  // A. Search symbols
  const { data: symbolsData, error: symbolsError } = await db
    .from("symbols")
    .select("file_id, name, kind, line, exported")
    .eq("analysis_id", analysisId);

  if (!symbolsError && symbolsData) {
    for (const sym of symbolsData) {
      const file = fileMap.get(sym.file_id);
      if (!file) continue;

      const symNameLower = sym.name.toLowerCase();
      let bestScore = 0;
      let matchedToken = "";

      for (const token of tokens) {
        if (symNameLower === token) {
          bestScore = Math.max(bestScore, 100);
          matchedToken = token;
        } else if (symNameLower.startsWith(token)) {
          bestScore = Math.max(bestScore, 70);
          matchedToken = token;
        } else if (token.length >= 3 && symNameLower.includes(token)) {
          bestScore = Math.max(bestScore, 40);
          matchedToken = token;
        }
      }

      if (bestScore > 0) {
        if (sym.exported) bestScore += 5;
        const startLine = Math.max(1, sym.line - 15);
        const endLine = Math.min(file.lines, sym.line + 25);
        seedWindows.push({
          fileId: file.id,
          path: file.path,
          contentHash: file.hash,
          totalLines: file.lines,
          startLine,
          endLine,
          score: bestScore,
          reason: `symbol "${sym.name}" (${sym.kind}) matches token "${matchedToken}"`,
        });
      }
    }
  }

  // B. Search routes
  const { data: routesData, error: routesError } = await db
    .from("routes")
    .select("file_id, method, path, line")
    .eq("analysis_id", analysisId);

  if (!routesError && routesData) {
    for (const route of routesData) {
      const file = fileMap.get(route.file_id);
      if (!file) continue;

      const routeLower = route.path.toLowerCase();
      const methodLower = route.method.toLowerCase();
      let bestScore = 0;
      let matchedToken = "";

      for (const token of tokens) {
        if (routeLower === token || routeLower === `/${token}`) {
          bestScore = Math.max(bestScore, 90);
          matchedToken = token;
        } else if (token.length >= 3 && routeLower.includes(token)) {
          bestScore = Math.max(bestScore, 65);
          matchedToken = token;
        } else if (methodLower === token) {
          bestScore = Math.max(bestScore, 50);
          matchedToken = token;
        }
      }

      if (bestScore > 0) {
        const startLine = Math.max(1, route.line - 10);
        const endLine = Math.min(file.lines, route.line + 30);
        seedWindows.push({
          fileId: file.id,
          path: file.path,
          contentHash: file.hash,
          totalLines: file.lines,
          startLine,
          endLine,
          score: bestScore,
          reason: `route "${route.method} ${route.path}" matches token "${matchedToken}"`,
        });
      }
    }
  }

  // C. Search file paths
  for (const file of fileMap.values()) {
    const pathLower = file.path.toLowerCase();
    const filename = pathLower.split("/").pop() ?? pathLower;
    let bestScore = 0;
    let matchedToken = "";

    for (const token of tokens) {
      if (filename === token || filename.startsWith(`${token}.`)) {
        bestScore = Math.max(bestScore, 80);
        matchedToken = token;
      } else if (pathLower.includes(token)) {
        bestScore = Math.max(bestScore, 45);
        matchedToken = token;
      }
    }

    if (bestScore > 0) {
      if (file.role) bestScore += 10;
      const endLine = Math.min(file.lines, 50);
      seedWindows.push({
        fileId: file.id,
        path: file.path,
        contentHash: file.hash,
        totalLines: file.lines,
        startLine: 1,
        endLine,
        score: bestScore,
        reason: `file path matches token "${matchedToken}"`,
      });
    }
  }

  // If no seeds found at all, return insufficient evidence early
  if (seedWindows.length === 0) {
    return {
      analysisId,
      query: rawQuery,
      tokens,
      windows: [],
      files: [],
      totalCharacters: 0,
      insufficientEvidence: true,
    };
  }

  // Sort seed windows by score descending, then path ascending
  seedWindows.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  // Stage 3: Dependency Graph Expansion
  // Expand the top seed files to their 1-hop neighbours
  const topSeedFiles = [
    ...new Set(seedWindows.slice(0, config.seedLimit).map((s) => s.fileId)),
  ];

  const expandedWindows: TargetWindow[] = [];
  if (topSeedFiles.length > 0) {
    const { data: edgesData, error: edgesError } = await db
      .from("edges")
      .select("source_file_id, target_file_id, kind")
      .eq("analysis_id", analysisId)
      .or(
        `source_file_id.in.(${topSeedFiles.join(",")}),target_file_id.in.(${topSeedFiles.join(",")})`,
      );

    if (!edgesError && edgesData) {
      const topSeedSet = new Set(topSeedFiles);
      const visitedNeighbourIds = new Set<string>();

      for (const edge of edgesData) {
        // Find the neighbour file
        const isOutgoing = topSeedSet.has(edge.source_file_id);
        const seedId = isOutgoing ? edge.source_file_id : edge.target_file_id;
        const neighbourId = isOutgoing ? edge.target_file_id : edge.source_file_id;

        if (topSeedSet.has(neighbourId) || visitedNeighbourIds.has(neighbourId)) {
          continue;
        }
        visitedNeighbourIds.add(neighbourId);

        const neighbour = fileMap.get(neighbourId);
        const seedFile = fileMap.get(seedId);
        if (!neighbour || !seedFile) continue;

        // Bounded decayed score for 1-hop neighbour
        const decayScore = Math.round((isOutgoing ? 35 : 30));
        const endLine = Math.min(neighbour.lines, 45);

        expandedWindows.push({
          fileId: neighbour.id,
          path: neighbour.path,
          contentHash: neighbour.hash,
          totalLines: neighbour.lines,
          startLine: 1,
          endLine,
          score: decayScore,
          reason: `1-hop dependency connected to seed "${seedFile.path}"`,
        });
      }
    }
  }

  // Stage 4: Deduplicate and merge overlapping line ranges per file
  const allWindows = [...seedWindows, ...expandedWindows];
  const mergedWindows = mergeCandidateWindows(allWindows);

  // Sort merged windows by score descending
  mergedWindows.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  // Stage 5: Retrieve actual source text and enforce budget
  const retrievedWindows: RetrievedWindow[] = [];
  const includedFilesMap = new Map<
    string,
    { fileId: string; path: string; contentHash: string; totalLines: number }
  >();
  const fileWindowCounts = new Map<string, number>();
  let currentCharacters = 0;

  for (const win of mergedWindows) {
    if (currentCharacters >= config.maxCharacters) break;

    const fileCount = includedFilesMap.has(win.fileId)
      ? includedFilesMap.size
      : includedFilesMap.size + 1;
    if (fileCount > config.maxFiles && !includedFilesMap.has(win.fileId)) {
      continue;
    }

    const currentWindowsForFile = fileWindowCounts.get(win.fileId) ?? 0;
    if (currentWindowsForFile >= config.maxWindowsPerFile) {
      continue;
    }

    try {
      const text = await getFileLines(db, win.fileId, win.startLine, win.endLine);
      if (text === null) continue;

      const windowLength = text.length;
      if (currentCharacters + windowLength > config.maxCharacters && retrievedWindows.length > 0) {
        continue;
      }

      currentCharacters += windowLength;
      fileWindowCounts.set(win.fileId, currentWindowsForFile + 1);
      includedFilesMap.set(win.fileId, {
        fileId: win.fileId,
        path: win.path,
        contentHash: win.contentHash,
        totalLines: win.totalLines,
      });

      retrievedWindows.push({
        fileId: win.fileId,
        path: win.path,
        contentHash: win.contentHash,
        totalLines: win.totalLines,
        startLine: win.startLine,
        endLine: win.endLine,
        score: win.score,
        text,
        reason: win.reason,
      });
    } catch {
      // Content unavailable or unreadable, continue to next candidate
      continue;
    }
  }

  return {
    analysisId,
    query: rawQuery,
    tokens,
    windows: retrievedWindows,
    files: [...includedFilesMap.values()],
    totalCharacters: currentCharacters,
    insufficientEvidence: retrievedWindows.length === 0,
  };
}

/**
 * Merges overlapping or close line windows on the same file.
 */
export function mergeCandidateWindows(windows: TargetWindow[]): TargetWindow[] {
  const byFile = new Map<string, TargetWindow[]>();

  for (const win of windows) {
    const list = byFile.get(win.fileId) ?? [];
    list.push(win);
    byFile.set(win.fileId, list);
  }

  const merged: TargetWindow[] = [];

  for (const list of byFile.values()) {
    // Sort by start line ascending
    list.sort((a, b) => a.startLine - b.startLine);

    let current = list[0]!;
    for (let i = 1; i < list.length; i++) {
      const next = list[i]!;
      // If windows overlap or are within 5 lines of each other, merge them
      if (next.startLine <= current.endLine + 5) {
        current = {
          fileId: current.fileId,
          path: current.path,
          contentHash: current.contentHash,
          totalLines: current.totalLines,
          startLine: Math.min(current.startLine, next.startLine),
          endLine: Math.max(current.endLine, next.endLine),
          score: Math.max(current.score, next.score),
          reason: `${current.reason}; ${next.reason}`,
        };
      } else {
        merged.push(current);
        current = next;
      }
    }
    merged.push(current);
  }

  return merged;
}

/**
 * Formats retrieved code windows into structured markdown context for the prompt.
 */
export function formatRetrievedContext(result: RetrievalResult): string {
  if (result.windows.length === 0) {
    return "No relevant code snippets were found in the stored analysis for this query.";
  }

  const sections: string[] = [];
  for (const win of result.windows) {
    sections.push(
      `--- File: ${win.path} (lines ${win.startLine}-${win.endLine}) [hash: ${win.contentHash.slice(0, 8)}] ---\n${win.text}`,
    );
  }

  return sections.join("\n\n");
}
