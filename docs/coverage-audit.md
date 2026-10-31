# Phase 1 — Audit and baseline (coverage-driven repository Q&A)

Recorded before any implementation of the coverage-driven Q&A plan. Branch: `ravi`.

## 1. Current Q&A pipeline (traced end to end)

```
UI question
  → askQuestionAction            app/(workspace)/analyses/[id]/actions.ts
  → retrieveGroundedContext      lib/ai/retrieval.ts     (deterministic, no LLM)
  → formatRetrievedContext       lib/ai/retrieval.ts
  → answerQuestion               lib/ai/tasks.ts
      cache read (sha256 of task+PROMPT_VERSION+model+normalised input)
        hit  → re-verify citations before serving
        miss → complete() LLM call → verify → cache write
  → verifyCitationsEvidence      lib/ai/citations.ts     (line- + hash-bound)
  → extractCitations (UI: components/qa-panel.tsx renders result.citations)
```

- `answerQuestion` never runs without citation verification: verified on hit,
  verified before cache write on miss. Verification cannot be bypassed —
  Phase 7 must preserve this property, not re-implement it.
- Context windows are served through `lib/content/read.ts`: file row → hash →
  content-addressed store keyed by `(organization_id, content_hash)`,
  size- and hash-verified before use, GitHub backfill at the analysed commit
  when `absent`. Q&A is built on verified bytes.

## 2. Existing retrieval strategies (all inside `lib/ai/retrieval.ts`)

| # | Strategy | Rank band |
|---|----------|-----------|
| A | Route table matching (`routes` rows vs concepts) | 100-tier, role +10 |
| B | Symbol matching (exact `95`–`100`, bidirectional prefix ≥4, role +5/+10) | 81–100 |
| C | Path matching (filename `80`, segment `70`, substring `45`, glossary penalties, two-variant corroboration +14, role +10) | 45–80 |
| C2 | Role seeding via indexed `file_roles` (ROLE_HINTS vocabulary → role) | 55 |
| D | Entry-point fallback (onboarding/bare queries only) | 30 (down from `85`) |
| — | Graph expansion: 1-hop in+out of the top `seedLimit=5` seeds | 30–35 |
| — | Merge/dedupe (`mergeCandidateWindows`), then budget | — |

Stop words include trivial verbs (`use`, `uses`, `using` — added after they
flooded hook-heavy getters at score 100). Budget: 16 files / 28,000 chars /
2 windows per file, greedy breadth-first with a round cap of 1 file per
directory (skipped candidates resume score order). The budget shape is
configurable via `RetrievalBudget`, which Phase 5's loop can reuse.

Semantic (vector) retrieval: **not supported** by the current schema or
index — "semantic retrieval if already supported" does not apply and will not
be invented as new infrastructure.

## 3. Indexed data inventory (verified against live data)

`files` (path, hash, lines, content_status, skip_reason), `symbols`
(name, kind, line, exported), `edges` (source, target, kind),
`routes` (`method`, `path`), `file_roles` (role, source=convention; keyed by
file id, joined through `files`).

authsphere analysis `2af1dcb5-31a0-4f99-a8b6-8e6c98d54bf2`:
222 files, 643 symbols, 559 edges, 152 file roles, **0 routes**.

| Kind | Values (live counts) |
|------|----------------------|
| `edges.kind` | `import` (532), `dynamic-import` (15), `re-export` (12) |
| `symbols.kind` | `const` (391), `function` (220), `class` (17), `interface` (8), `let` (6), `type` (1) |
| `file_roles.role` | `config`, `test`, `controller`, `model`, `router`, `service`, `middleware`, … (convention-sourced) |

Schema truth: `EDGE_KINDS = ["import", "re-export", "dynamic-import", "require"]`
(`lib/parser/types.ts:10`). There is **no call graph, no route edges, no
controller/model edges in the schema** — any Phase 4 "relationship expansion"
beyond imports must be *derived at query time from already-indexed evidence*,
not stored, and must never be presented as an indexed relationship.

## 4. Phase 4 relationship gap analysis

| Required relationship | Status in data | Phase 4 approach |
|---|---|---|
| Imports | **exists** (`edges`) | already traversed 1-hop; keep bounded |
| Function calls | not indexed (no call graph, symbols have no bodies) | derive at query time from symbol names appearing inside *retrieved* windows (text evidence); never claim an indexed edge |
| Route → controller, controller → model | `routes` is the intended home, but authsphere has 0 route rows (parser finds none for its Express style) | derive from directory role adjacency (controllers/models) across `import` edges only where edges actually connect; otherwise mark **partial/unknown** |
| Middleware dependencies | import edges reach middleware files | same edge traversal; no new data |
| Frontend → backend API calls | not indexed; graphs are disconnected (49 edges internal to `packages/src`, none into it) | derive from fetch/axios client text *inside retrieved windows* + `SDKAPI`-style route naming; never invent an edge that isn't evidenced |
| Database interactions | not indexed | derive from model symbols/query names within retrieved windows |
| Concept islands (SDK client package) | unreachable by edges | reachable only through concept vocabulary (sdk→client/package/library glossary) — already fixed |

Decision: **no new ingestion, no schema migration** in Phase 4. Bounded
expansion over existing edges plus query-time derivation, each derivation
labelled by its evidence kind so the coverage evaluator (Phase 5) can
distinguish indexed relationships from derived hints.

## 5. Baseline measurements (current code, this branch)

| Query | Files | Windows | Chars | Retrieval | Answer (earlier verified run) |
|---|---|---|---|---|---|
| "How does authentication work?" | 16 | 17 | 21,387 | ~149 ms | ≈9 s, ≈5.7–6.1k prompt tokens, 14 verified citations |
| "How does the SDK work …?" | 16 | 19 | 24,845 | ~160 ms | blocked by provider quota (429) on final LLM call |

Symbols surfacing in the auth run's top windows: `registerDeveloper`,
`loginDeveloper`, `handleSDKCallback`, `verifyJWT`-family, `sdkCors`,
session/valid/JWT validators — the full auth story, spread across
controllers/middleware/jwt/session model/validators/login page/client SDK.

## 6. Known limitations recorded for later phases

1. `packages/src/*` is a graph island — reachable via concept vocabulary only.
2. Bidirectional prefix matching at length ≥4 lets `authorize` match
   `authorization`-family queries (cross-concept leak, pre-existing).
3. Route ingestion produced 0 rows for an Express repo — route table is a
   potential retrieval axis that is empty for this repo.
4. No semantic retrieval exists; Phase 3 stays lexical/symbol/path/role.
5. Planner (Phase 2) must be deterministic using `extractQueryTokens`,
   `tokenVariants`, and onboarding patterns — no extra LLM call.

## 7. Do-not-duplicate notes

- Verified content reads, role graph, import edges, citation verification,
  and the answer cache are all existing infrastructure to reuse as-is.
- The retrieval budget already has configuration seams (`RetrievalBudget`);
  Phase 5 reuses them instead of adding a parallel budget system.
