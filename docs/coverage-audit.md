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

## 8. Phase 6 - Bounded iterative retrieval (results, this branch)

`lib/ai/retrieval-loop.ts` (`retrieveWithCoverageLoop`) runs the unchanged
Phase 3/4 pipeline as pass 0, evaluates coverage (`lib/ai/coverage.ts`),
and while a category is partial/unknown issues at most two focused
retrievals per pass (`concept token + category vocabulary`), merges their
windows append-only, and re-evaluates. No LLM, no ingestion changes.

Merge and stop rules (all tested in `scripts/test-retrieval-loop.ts`):
- append-only: an exact/overlapping window (retrieval's own 5-line merge
  gap counts as overlap) is never re-served; per-file window cap and the
  16-file / 28k-character budget hold across every pass; a new file needs
  a candidate score >= 50, so relationship-only skips and weak hops never
  pad or displace stronger direct evidence; provenance and content hashes
  flow through verbatim (indexed/derived/direct tested).
- stop reasons: `sufficient-coverage`, `no-candidates`, `budget-exhausted`,
  `max-passes` (<= 3 additional passes). `unknown` never blocks as proof of
  nonexistence - it only feeds the next targeted pass, and the fixed
  unknown-note still ships with every evaluation.

Before/after against the live authsphere analysis
(`2af1dcb5-31a0-4f99-a8b6-8e6c98d54bf2`; provider quota 429 still blocks
final answer runs, so the report stays at the retrieval/coverage level):

| Query | Before (Phase 5 single pass) | After (coverage-loop) |
|---|---|---|
| "How does authentication work in this repository?" | found 4 / partial 0 / unknown 0, one retrieval | same coverage, 0 extra passes, loop stops `sufficient-coverage` immediately, no regression (loop ms ~296, single call) |
| "How does the developer SDK work?" | found 1 (frontend) / partial 2 (routes, controllers) / unknown 0 | same coverage, 1 pass (ms ~185) issuing 2 focused queries (`sdk route router endpoint`, `sdk controller handler`), 0 windows added -> loop stops `budget-exhausted`; loop ms ~376; package stays 16 files / ~26.3k chars |

Interpretation of the SDK after-state: the targeted retrievals DO surface
strong evidence the base package missed - `backend/src/routes/sdk.routes.js`
(1-50, indexed, score 94, `sdk` controllers/validator imports in text) and
`backend/src/controllers/sdk.controller.js` (score 116) - but the question's
own package already pins all 16 file slots, so the loop honestly refuses to
displace them and reports `budget-exhausted` instead of inventing space.
Coverage therefore did not regress, and the improvement mechanics are
demonstrated end-to-end on the fixture suites (routes flips
partial -> found and controllers partial -> found through a route-table and a
header-window drill; two-pass exhaustion, no-candidate and
max-passes stops are each pinned by tests). Candidate displacement of
weaker evidence is deliberately out of Phase 6 scope and recorded for a
later phase. `node scripts/test-retrieval-loop.ts` is wired into `pnpm test`
after the Phase 5 suite.
