"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { searchAnalysis, type SearchHit } from "@/lib/graph/search";
import type { ParsedFile, ParsedSymbol } from "@/lib/parser/types";

// Search over the analysis that is already in the browser: file paths and
// symbol names, no request. Picking a hit reveals its file on the map — the
// same reveal a path in the pane uses — and the dropdown closes.

export function SearchBox({
  files,
  symbols,
  onReveal,
}: {
  files: ParsedFile[];
  symbols: ParsedSymbol[];
  onReveal: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const hits = useMemo(() => searchAnalysis(files, symbols, query), [files, symbols, query]);
  // The highlighted row follows the hits as the query narrows them: clamped
  // here rather than reset in an effect, so a query change never needs a
  // second render to be consistent.
  const current = Math.min(active, Math.max(0, hits.length - 1));

  // Clicking anywhere outside closes the dropdown, like the rest of the pane.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const pick = (hit: SearchHit) => {
    onReveal(hit.path);
    setQuery("");
    setOpen(false);
    input.current?.blur();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      setQuery("");
      setOpen(false);
      input.current?.blur();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((n) => Math.min(n + 1, Math.max(0, hits.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((n) => Math.max(n - 1, 0));
    } else if (event.key === "Enter" && hits[current]) {
      pick(hits[current]);
    }
  };

  return (
    <div ref={box} className="relative">
      <input
        ref={input}
        type="text"
        value={query}
        placeholder="Search files and symbols"
        aria-label="Search files and symbols"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="h-5 w-40 rounded-[2px] border border-line bg-canvas px-1.5 text-[11px] placeholder:text-fg-muted focus:outline-none"
      />
      {open && query.trim() && (
        <ul
          role="listbox"
          aria-label="Search results"
          className="absolute right-0 top-6 z-20 max-h-64 w-72 overflow-y-auto rounded-[2px] border border-line bg-surface py-1 shadow-lg"
        >
          {hits.length === 0 ? (
            <li className="px-2 py-1 text-[11px] text-fg-muted">Nothing matches.</li>
          ) : (
            hits.map((hit, i) => (
              <li key={hit.kind === "file" ? `f${hit.path}` : `s${hit.path}:${hit.name}:${hit.line}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === current}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(hit)}
                  className={`flex w-full items-baseline gap-2 px-2 py-0.5 text-left text-[11px] ${i === current ? "bg-raised" : ""}`}
                >
                  {hit.kind === "file" ? (
                    <>
                      <span className="font-mono break-all">{hit.path}</span>
                      <span className="ml-auto shrink-0 text-fg-muted">file</span>
                    </>
                  ) : (
                    <>
                      <span className="font-mono break-all">{hit.name}</span>
                      <span className="ml-auto shrink-0 text-fg-muted">
                        {hit.symbolKind}
                        {!hit.exported && " · internal"} · {hit.path}:{hit.line}
                      </span>
                    </>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
