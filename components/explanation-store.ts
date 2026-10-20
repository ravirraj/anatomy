// The answers fetched on a page, kept in the browser's session storage so they
// outlive the render that fetched them.
//
// A server action re-renders the page it was called from, and an answer that
// took a minute to fetch should not be lost to that. The server keeps its own
// cache of answers, so asking again is instant; this is what makes the answer
// there without asking again.
//
// Only a finished answer is kept on disk. A request still in flight when the
// page went away died with it, so keeping that would leave a pane explaining
// something nobody is fetching any more.

import { useSyncExternalStore } from "react";
import type { ExplanationState } from "./explanation-panel";

const STORE = "anatomy.explanations";

// Enough answers to walk a whole repository without the store growing without
// end. The oldest go first.
const LIMIT = 100;

type Entry = { id: string; analysisId: string; state: ExplanationState };

const listeners = new Set<() => void>();

// What the store holds, per analysis. The reference only changes when an
// answer does, so React can tell a new answer from the same one again.
let held: { analysisId: string; entries: ReadonlyMap<string, ExplanationState> } | null = null;

// What the server rendered: no answers, because the browser's storage is not
// the server's to read.
const NONE: ReadonlyMap<string, ExplanationState> = new Map();

function available(): boolean {
  return typeof sessionStorage !== "undefined";
}

function readStored(analysisId: string): Map<string, ExplanationState> {
  const out = new Map<string, ExplanationState>();
  if (!available()) return out;
  try {
    const raw = sessionStorage.getItem(STORE);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return out;
    for (const entry of parsed as Entry[]) {
      if (entry.analysisId !== analysisId) continue;
      if (entry.state.status === "loading") continue;
      out.set(entry.id, entry.state);
    }
  } catch {
    // A store that can't be read is a store that isn't there.
  }
  return out;
}

function persist(analysisId: string, entries: ReadonlyMap<string, ExplanationState>): void {
  if (!available()) return;
  try {
    const previous = readStored(analysisId);
    const all: Entry[] = [];
    const raw = sessionStorage.getItem(STORE);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const entry of parsed as Entry[]) {
        if (entry.analysisId !== analysisId) all.push(entry);
      }
    }
    for (const [id, state] of entries) {
      // An answer being replaced is still the last one fetched, and a reload
      // in the middle of a request should find it rather than nothing.
      if (state.status === "loading") {
        const old = previous.get(id);
        if (old) all.push({ id, analysisId, state: old });
        continue;
      }
      all.push({ id, analysisId, state });
    }
    sessionStorage.setItem(STORE, JSON.stringify(all.slice(-LIMIT)));
  } catch {
    // A store that can't be written is a store that isn't there.
  }
}

/** The answers fetched for one analysis, by target. */
export function explanationsFor(analysisId: string): ReadonlyMap<string, ExplanationState> {
  if (held && held.analysisId === analysisId) return held.entries;
  const entries = readStored(analysisId);
  held = { analysisId, entries };
  return entries;
}

/** Records one answer and tells anyone watching that it changed. */
export function setExplanation(analysisId: string, target: string, state: ExplanationState): void {
  const entries = new Map(explanationsFor(analysisId));
  entries.set(target, state);
  held = { analysisId, entries };
  // A request in flight isn't an answer, so it isn't written down.
  if (state.status !== "loading") persist(analysisId, entries);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The answers, as React wants them: read from the store and kept in step with
 * it. The server's snapshot is empty, so the first render agrees with the
 * markup the server sent; the stored answers arrive right after.
 */
export function useExplanations(analysisId: string): ReadonlyMap<string, ExplanationState> {
  return useSyncExternalStore(
    subscribe,
    () => explanationsFor(analysisId),
    () => NONE,
  );
}
