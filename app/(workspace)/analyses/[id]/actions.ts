"use server";

import { createHash } from "node:crypto";
import { MODELS, tracingStatus, type TracingStatus } from "@/lib/ai/client";
import { type ManifestFile, type ParsedCitation } from "@/lib/ai/citations";
import { type QuestionInput } from "@/lib/ai/prompts";
import { formatRetrievedContext } from "@/lib/ai/retrieval";
import { retrieveWithCoverageLoop, type IterativeRetrievalResult } from "@/lib/ai/retrieval-loop";
import { answerQuestion, classifyFile, explainFile, explainFolder, INSUFFICIENT_EVIDENCE_ANSWER } from "@/lib/ai/tasks";
import { allowedAnalysisPaths, loadFileInput, loadFolderInput } from "@/lib/analysis/context";
import { getFileContent } from "@/lib/content/read";
import { fetchFileAt, resolveHeadCommit } from "@/lib/pipeline/github";
import type { ModelRole } from "@/lib/roles";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createAiCache } from "@/lib/supabase/cache";
import { createServerSupabase } from "@/lib/supabase/server";

export type ExplainResult =
  | {
      ok: true;
      body: string;
      model: string;
      cached: boolean;
      tracing: TracingStatus;
      /** Set when this call labelled a file no convention identified. */
      labelled: { role: ModelRole | null } | null;
      /** Why labelling failed, when it did; the explanation still stands. */
      labelError: string | null;
    }
  | { ok: false; error: string };

export type QAResult =
  | {
      ok: true;
      body: string;
      model: string;
      cached: boolean;
      tracing: TracingStatus;
      citations: ParsedCitation[];
      retrieval: {
        totalCharacters: number;
        files: { fileId: string; path: string; totalLines: number }[];
        insufficientEvidence: boolean;
        /** Category counts from the coverage evaluation of the final package. */
        coverage: { found: number; partial: number; unknown: number };
        /** Why the bounded retrieval loop stopped. */
        stoppedBecause: IterativeRetrievalResult["stoppedBecause"];
        passes: number;
      };
    }
  | { ok: false; error: string };

export type HeadResult = { ok: true; head: string; analysed: string } | { ok: false; error: string };
export type FileAtHead = { ok: true; state: "unchanged" | "changed" | "deleted" } | { ok: false; error: string };

type Db = Awaited<ReturnType<typeof createServerSupabase>>;
type Analysis = { id: string; organizationId: string; commitSha: string; repository: { owner: string; name: string } };

export async function explainFileAction(analysisId: string, path: string): Promise<ExplainResult> {
  try {
    const db = await createServerSupabase();
    const analysis = await readAnalysis(db, analysisId);
    const loaded = await loadFileInput(db, analysis.id, path);
    if (!loaded) return { ok: false, error: `${path} isn't a file in this analysis` };
    const cache = cacheFor(db, analysis.organizationId);
    const source = sourceForFile(db, loaded.file.id, path);

    // Labelling comes first so the explanation's question includes the role,
    // and asks the same question next time, when the role is read back stored.
    let labelled: { role: ModelRole | null } | null = null;
    let labelError: string | null = null;
    const input = loaded.input;
    if (input.role === null) {
      try {
        const { role } = await classifyFile(loaded.classify, { cache, source });
        labelled = { role };
        if (role !== null) {
          await storeModelRole(analysis.organizationId, loaded.file.id, role);
          input.role = role;
        }
      } catch (error) {
        labelError = messageOf(error);
      }
    }

    const answer = await explainFile(input, { cache, source });
    return { ok: true, ...answer, tracing: tracingStatus(), labelled, labelError };
  } catch (error) {
    console.error(`Explaining ${path} failed:`, error);
    return { ok: false, error: messageOf(error) };
  }
}

export async function explainFolderAction(analysisId: string, dir: string): Promise<ExplainResult> {
  try {
    const db = await createServerSupabase();
    const analysis = await readAnalysis(db, analysisId);
    const input = await loadFolderInput(db, analysis.id, dir);
    if (!input) return { ok: false, error: `${dir} isn't a folder on this map` };
    const answer = await explainFolder(input, { cache: cacheFor(db, analysis.organizationId) });
    return { ok: true, ...answer, tracing: tracingStatus(), labelled: null, labelError: null };
  } catch (error) {
    console.error(`Explaining folder ${dir} failed:`, error);
    return { ok: false, error: messageOf(error) };
  }
}

export async function askQuestionAction(analysisId: string, question: string): Promise<QAResult> {
  const t0 = performance.now();
  try {
    const trimmed = question.trim();
    if (!trimmed) {
      return { ok: false, error: "Question cannot be empty" };
    }

    const db = await createServerSupabase();
    const analysis = await readAnalysis(db, analysisId);

    // 1. Deterministic retrieval, then bounded targeted passes for any
    //    category the coverage evaluation could not establish. No model call.
    const loop = await retrieveWithCoverageLoop(db, analysis.id, trimmed, {
      model: MODELS.question,
    });
    const retrieved = loop.result;
    const tRetrieval = performance.now();

    // Deterministic abstention: when retrieval finds genuinely no usable evidence
    // (zero code windows AND zero packaging facts), return immediately without
    // dispatching an LLM request or writing to cache.
    if (retrieved.insufficientEvidence) {
      const tTotal = performance.now();
      console.log(
        `[Q&A Timing] analysisId=${analysisId} retrievalMs=${Math.round(tRetrieval - t0)} llmMs=0 totalMs=${Math.round(tTotal - t0)} retrievedFiles=0 insufficientEvidence=true passes=${loop.passes.length} stop=${loop.stoppedBecause} (abstained)`,
      );
      return {
        ok: true,
        body: INSUFFICIENT_EVIDENCE_ANSWER,
        model: MODELS.question,
        cached: false,
        tracing: tracingStatus(),
        citations: [],
        retrieval: {
          totalCharacters: 0,
          files: [],
          insufficientEvidence: true,
          coverage: loop.coverage.summary,
          stoppedBecause: loop.stoppedBecause,
          passes: loop.passes.length,
        },
      };
    }

    const contextText = formatRetrievedContext(retrieved);

    // Coverage -> synthesis-friendly layer lists (concept-agnostic union).
    const coverageLayers = { verified: new Set<string>(), partial: new Set<string>(), unknown: new Set<string>() };
    for (const concept of loop.coverage.concepts) {
      for (const cat of concept.categories) {
        if (cat.status === "found") coverageLayers.verified.add(cat.category);
        else if (cat.status === "partial") coverageLayers.partial.add(cat.category);
        else coverageLayers.unknown.add(cat.category);
      }
    }
    // A layer is only "unknown" if no concept verified or partially found it.
    for (const layer of coverageLayers.verified) coverageLayers.partial.delete(layer);
    for (const layer of coverageLayers.verified) coverageLayers.unknown.delete(layer);
    for (const layer of coverageLayers.partial) coverageLayers.unknown.delete(layer);

    // 2. The citation allowlist, read after the retrieval loop completes: only
    // `stored`, non-skipped paths of this analysis may be cited outside the
    // evidence actually retrieved. Excluded and legacy-unclassified paths are
    // never in this set, and an absent path only becomes citable by being
    // successfully read into the answer's evidence map (the first tier of the
    // verification below).
    const allAnalysisFiles = await allowedAnalysisPaths(db, analysis.id);
    const manifestsByPath = new Map<string, ManifestFile>(
      (retrieved.manifests ?? []).map((m) => [m.path, m]),
    );

    // 3. Answer question using bounded grounded context
    const questionInput: QuestionInput = {
      question: trimmed,
      contextText,
      files: retrieved.files.map((f) => ({
        path: f.path,
        contentHash: f.contentHash,
        totalLines: f.totalLines,
        ...(f.windows ? { windows: f.windows } : {}),
      })),
      coverage: {
        verified: [...coverageLayers.verified].sort(),
        partial: [...coverageLayers.partial].sort(),
        unknown: [...coverageLayers.unknown].sort(),
        unknownNote: loop.coverage.unknownNote,
      },
      insufficientEvidence: retrieved.insufficientEvidence,
    };

    const cache = cacheFor(db, analysis.organizationId);
    const tLlm = performance.now();
    const answer = await answerQuestion(questionInput, {
      cache,
      allAnalysisFiles,
      manifestsByPath,
      analysisId: analysis.id,
    });
    const tLlmEnd = performance.now();
    const tTotal = performance.now();

    console.log(
      `[Q&A Timing] analysisId=${analysisId} retrievalMs=${Math.round(tRetrieval - t0)} llmMs=${Math.round(tLlmEnd - tLlm)} totalMs=${Math.round(tTotal - t0)} retrievedFiles=${retrieved.files.length} insufficientEvidence=${retrieved.insufficientEvidence} passes=${loop.passes.length} stop=${loop.stoppedBecause}`,
    );

    return {
      ok: true,
      body: answer.body,
      model: answer.model,
      cached: answer.cached,
      tracing: tracingStatus(),
      citations: answer.citations,
      retrieval: {
        totalCharacters: retrieved.totalCharacters,
        files: retrieved.files.map((f) => ({
          fileId: f.fileId,
          path: f.path,
          totalLines: f.totalLines,
          ...(f.windows ? { windows: f.windows } : {}),
        })),
        insufficientEvidence: retrieved.insufficientEvidence,
        coverage: loop.coverage.summary,
        stoppedBecause: loop.stoppedBecause,
        passes: loop.passes.length,
      },
    };
  } catch (error) {
    console.error(`Asking question on ${analysisId} failed:`, error);
    return { ok: false, error: messageOf(error) };
  }
}

// One GitHub API call; the pane asks once per page load, not once per file.
export async function repositoryHeadAction(analysisId: string): Promise<HeadResult> {
  try {
    const analysis = await readAnalysis(await createServerSupabase(), analysisId);
    return { ok: true, head: await resolveHeadCommit(analysis.repository), analysed: analysis.commitSha };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

// Only asked once the repository has moved past the analysed commit: the
// file's bytes at the new head, against the hash the parser stored.
export async function fileAtHeadAction(analysisId: string, path: string, head: string): Promise<FileAtHead> {
  try {
    if (!/^[0-9a-f]{40}$/.test(head)) return { ok: false, error: "That isn't a commit" };
    const db = await createServerSupabase();
    const analysis = await readAnalysis(db, analysisId);
    const { data: file, error } = await db.from("files").select("hash").eq("analysis_id", analysis.id).eq("path", path).maybeSingle();
    if (error) throw new Error(`Reading ${path} failed: ${error.message}`);
    if (!file?.hash) return { ok: false, error: `${path} isn't a parsed file in this analysis` };
    const bytes = await fetchFileAt(analysis.repository, head, path);
    if (bytes === null) return { ok: true, state: "deleted" };
    return { ok: true, state: sha256(bytes) === file.hash ? "unchanged" : "changed" };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

// Read under the caller's policies: another organization's analysis isn't
// there, and nothing after this runs for it.
async function readAnalysis(db: Db, analysisId: string): Promise<Analysis> {
  const { data, error } = await db
    .from("analyses")
    .select("id, organization_id, status, commit_sha, project:projects(repo_owner, repo_name)")
    .eq("id", analysisId)
    .maybeSingle();
  if (error) throw new Error(`Reading the analysis failed: ${error.message}`);
  if (!data?.project) throw new Error("Analysis not found");
  if (data.status !== "complete" || !data.commit_sha) throw new Error("This analysis isn't complete");
  return {
    id: data.id,
    organizationId: data.organization_id,
    commitSha: data.commit_sha,
    repository: { owner: data.project.repo_owner, name: data.project.repo_name },
  };
}

const cacheFor = createAiCache;

async function storeModelRole(organizationId: string, fileId: string, role: ModelRole): Promise<void> {
  // A convention role is never replaced: the file only reaches here without one.
  const { error } = await createAdminSupabase()
    .from("file_roles")
    .upsert({ organization_id: organizationId, file_id: fileId, role, source: "model" }, { onConflict: "file_id", ignoreDuplicates: true });
  if (error) throw new Error(`Storing the role failed: ${error.message}`);
}

// Fetched at most once per request, and only if a cache miss needs it. The
// bytes must be the ones the parser read; if GitHub's copy hashes differently,
// explaining it would describe code that isn't on the map.
function sourceForFile(db: Db, fileId: string, path: string): () => Promise<string> {
  let pending: Promise<string> | null = null;
  return () => {
    pending ??= (async () => {
      const text = await getFileContent(db, fileId);
      if (text === null) {
        throw new Error(`Content for ${path} is unavailable in this analysis`);
      }
      return text;
    })();
    return pending;
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
