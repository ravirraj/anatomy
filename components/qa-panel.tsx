"use client";

import { useState, useTransition, type FormEvent } from "react";
import { askQuestionAction, type QAResult } from "@/app/(workspace)/analyses/[id]/actions";
import { parseCitation, stripLineSuffix, type ParsedCitation } from "@/lib/ai/citations";
import { ExplanationText } from "./explanation-text";

type Props = {
  analysisId: string;
  onReveal: (path: string) => void;
  isPath: (path: string) => boolean;
};

const SUGGESTIONS = [
  "How does authentication work?",
  "Where is the database initialized?",
  "What API routes are exposed?",
  "How does request handling flow?",
];

export function QAPanel({ analysisId, onReveal, isPath }: Props) {
  const [question, setQuestion] = useState("");
  const [activeQuestion, setActiveQuestion] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<Extract<QAResult, { ok: true }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (qToAsk?: string) => {
    const q = (qToAsk ?? question).trim();
    if (!q || isPending) return;

    setActiveQuestion(q);
    setError(null);

    startTransition(async () => {
      const res = await askQuestionAction(analysisId, q);
      if (res.ok) {
        setResult(res);
      } else {
        setError(res.error);
      }
    });
  };

  const handleForm = (e: FormEvent) => {
    e.preventDefault();
    handleSubmit();
  };

  // Checks whether a path or citation token refers to a known repository file
  const checkIsPath = (token: string): boolean => {
    const base = stripLineSuffix(token);
    return isPath(base) || isPath(token);
  };

  const renderCitation = (token: string) => {
    const parsed: ParsedCitation = parseCitation(token);
    return (
      <button
        type="button"
        onClick={() => onReveal(parsed.path)}
        className="inline-flex items-center gap-0.5 rounded-[2px] bg-raised px-1 py-0.2 font-mono text-[11px] text-accent hover:underline"
        title={`Reveal ${parsed.path}${parsed.startLine ? ` at lines ${parsed.startLine}-${parsed.endLine}` : ""}`}
      >
        <span>{parsed.path}</span>
        {parsed.startLine !== undefined && (
          <span className="font-sans text-[10px] text-fg-muted">
            :{parsed.startLine}
            {parsed.endLine && parsed.endLine !== parsed.startLine ? `-${parsed.endLine}` : ""}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="flex flex-col space-y-3 px-3 py-3 text-[11px]">
      <form onSubmit={handleForm} className="space-y-1.5">
        <label htmlFor="repo-qa-input" className="block text-fg font-medium">
          Ask this repository
        </label>
        <div className="flex gap-1.5">
          <input
            id="repo-qa-input"
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. How does authentication work?"
            disabled={isPending}
            className="min-w-0 flex-1 rounded-[3px] border border-line bg-surface px-2 py-1 text-[11px] placeholder:text-fg-muted focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={isPending || !question.trim()}
            className="rounded-[3px] border border-line px-2.5 py-1 text-[11px] font-medium hover:bg-raised disabled:opacity-50"
          >
            {isPending ? "Asking…" : "Ask"}
          </button>
        </div>
      </form>

      {!result && !isPending && (
        <div className="space-y-1">
          <p className="text-[10px] text-fg-muted">Suggested questions:</p>
          <div className="flex flex-wrap gap-1">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setQuestion(s);
                  handleSubmit(s);
                }}
                className="rounded-[2px] border border-line/60 bg-raised/50 px-1.5 py-0.5 text-left text-[10px] text-fg-muted hover:border-line hover:text-fg"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {isPending && (
        <div className="rounded-[3px] border border-line bg-raised/30 px-3 py-3">
          <p className="text-fg-muted">Grounding question and verifying source code citations…</p>
        </div>
      )}

      {error && !isPending && (
        <div className="rounded-[3px] border border-line bg-raised px-3 py-2 text-[11px]">
          <p className="font-semibold text-fg">Couldn&apos;t answer question.</p>
          <p className="mt-0.5 break-words text-fg-muted">{error}</p>
          <button
            type="button"
            onClick={() => handleSubmit()}
            className="mt-2 rounded-[3px] border border-line px-2 py-0.5 text-[10px] hover:bg-raised"
          >
            Try again
          </button>
        </div>
      )}

      {result && !isPending && (
        <div className="space-y-3">
          {activeQuestion && (
            <p className="text-[11px] font-medium text-fg border-b border-line pb-1">
              Q: {activeQuestion}
            </p>
          )}

          {result.retrieval.insufficientEvidence && (
            <div className="rounded-[3px] border border-line bg-raised px-2.5 py-1.5 text-[10px] text-fg-muted">
              Note: The stored analysis contains limited evidence matching this query.
            </div>
          )}

          <ExplanationText
            text={result.body}
            isPath={checkIsPath}
            onPath={renderCitation}
          />

          {result.citations.length > 0 && (
            <div className="border-t border-line pt-2">
              <p className="text-[10px] font-medium text-fg-muted mb-1">Cited evidence:</p>
              <div className="flex flex-wrap gap-1">
                {result.citations.map((c, idx) => (
                  <button
                    key={`${c.raw}-${idx}`}
                    type="button"
                    onClick={() => onReveal(c.path)}
                    className="inline-flex items-center gap-1 rounded-[2px] border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-accent hover:bg-raised"
                    title={`Highlight ${c.path} on canvas`}
                  >
                    <span>{c.path}</span>
                    {c.startLine !== undefined && (
                      <span className="font-sans text-fg-muted">
                        L{c.startLine}{c.endLine && c.endLine !== c.startLine ? `-L${c.endLine}` : ""}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-0.5 border-t border-line pt-2 text-[10px] text-fg-muted">
            <p>
              <span className="font-mono">{result.model}</span> ·{" "}
              {result.cached ? "from cache, no model call" : "new answer"}
            </p>
            <p>
              Examined {result.retrieval.files.length} {result.retrieval.files.length === 1 ? "file" : "files"} ({result.retrieval.totalCharacters.toLocaleString()} characters)
            </p>
            <p>
              {result.tracing.on
                ? `Traced to LangSmith project ${result.tracing.project}`
                : `Not traced: ${result.tracing.reason}`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
