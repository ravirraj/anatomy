# Decisions ledger

The important technical decisions behind Anatomy, with reasons, trade-offs,
and the alternatives that were rejected. Deep background lives in
[project-doc.md](project-doc.md) and [architecture/decisions/](architecture/decisions/);
this ledger is the index an agent reads to avoid silently reopening a
settled question.

Statuses: **Adopted** (in force, evidenced), **Pending** (unresolved — an
agent must not decide these alone), **Historical** (superseded by an adopted
decision).

Recorded 2026-11-04; evidence pointers verified against the repository on
that date. Updated 2026-11-06 (Phase 1D closure): D8 (glue-term breadth cap)
and D9 (explicit-anchor stop) added. Updated later on 2026-11-06: P5 and the
1C/1D status rows corrected to the verified committed-and-pushed state
(`7262316`, `e78ee56` at `origin/ravi`).

---

## Adopted

### D1. Retrieval is deterministic — no LLM, no embeddings
- **Code:** `lib/ai/retrieval.ts`, `lib/ai/planner.ts`, `lib/ai/coverage.ts`,
  `lib/ai/retrieval-loop.ts`.
- **Reason:** the retrieval path must be reproducible, inspectable and
  cheap; the model only ever writes prose over evidence already selected by
  deterministic code.
- **Trade-off / rejected alternative:** no semantic/embedding retrieval —
  recorded in [coverage-audit.md](coverage-audit.md) §6: phase 3 of that plan
  stays lexical/symbol/path/role. Cost: recall is bounded by vocabulary
  matching (e.g. the `authorize`/`authorization` prefix leak).

### D2. Every citation is hash-bound and fail-closed
- **Code:** `lib/ai/citations.ts`; enforced in `lib/ai/tasks.ts`
  (`answerQuestion` verifies on cache hit and before cache write).
- **Reason:** the product's core promise — answers cite lines that exist in
  the analysed commit. A `CitationError` blocks serving and caching.
- **Trade-off:** strictness occasionally rejects defensible phrasings; that
  is preferred over the risk of showing invented evidence. Never weaken this
  check.

### D3. Convention owns roles; the model may only label non-routable leftovers
- **Code:** `lib/roles.ts` (`ROLES`, `MODEL_ROLES` — 7 model roles, none
  routable); enforced at storage time (`source = 'model'` never overwrites).
- **Reason:** roles decide routable surfaces and entry points; a model must
  never decide structure.
- **Rejected alternative:** letting the model classify all roles
  ([TODO.md](../TODO.md) §3.1 records the decision trail).

### D4. Source content is stored content-addressed in Postgres
- **Design:** [ADR-0001](architecture/decisions/0001-source-content-storage.md)
  and [file-content-storage.md](architecture/file-content-storage.md);
  implementation notes in
  [content-pipeline-integration.md](architecture/content-pipeline-integration.md)
  (ADR Phase 2 implemented on `ravi`).
- **Reason:** the answer path must not borrow source back from GitHub.
- **Trade-off:** payload rows ≤ 1 MB in Postgres; large-file/object-storage
  handling remains a pending question (P2 below).

### D5. The coverage loop is append-only, with atomic bounded replacement
- **Code:** `lib/ai/retrieval-loop.ts`; introduced in the coverage-driven
  plan, rebuilt atomically in Phase 1B (commit `c1ac975`).
- **Reason:** iterative passes must never duplicate evidence, pad with weak
  windows, or displace stronger direct evidence; every package reports its
  served character cost.
- **Trade-off:** replacement needs explicit margins and protections, which
  makes the merge code subtle — the extensive §2/§4/§5 assertions in
  `scripts/test-retrieval-loop.ts` are the price of that subtlety.

### D6. Retrieval must match the parser's role taxonomy, legacy values included
- **Code (Phase 1C, committed at `7262316`):** `ROLE_HINTS` one conservative
  entry per producible role; `FRONTEND_ROLES` decay; entry seeding recognises
  modern routable roles; `CATEGORY_AFFILIATION` and `CATEGORY_QUERY_WORDS`
  aligned, adaptive categories are raw role ids.
- **Reason:** missed role hints silently starve whole architectural layers
  (repositories, endpoints, guards) out of the evidence package.
- **Trade-off:** every hint is a recall/precision bet; words kept
  conservative, one hint per role to avoid double seeding; legacy role
  values (`route`, `frontend`, `cli`, legacy `store`) kept for stored
  analyses under the old taxonomy.
- **Deferred:** F5 planner `guards` category — planner semantics out of that
  subphase's scope.

### D7. One AI client, pinned models, cache-never-evicted (until challenged)
- **Code:** `lib/ai/client.ts` (single wrapped client), pinned profiles in
  `lib/ai/budget.ts`; the answer cache never evicts by design
  ([ai-system.md](ai-system.md) §4.3).
- **Trade-off:** unbounded cache growth; invalidation currently re-verifies
  source hashes — [architecture.md](architecture.md) §10.3 leaves the longer
  term policy open (feeds Phase 2).

### D8. Glue terms are dropped from concept clustering once the repository is
big enough to distinguish noise from a real concept (Phase 1D, V7a)
- **Code:** `lib/ai/concepts/discovery.ts` — `MAX_TERM_FILE_FRACTION = 0.4`
  with a `GLUE_TERM_MIN_FILES = 4` small-repository floor, applied as a
  pre-clustering Step 2b in `buildConceptIndex`.
- **Reason:** a term spread over more than 40% of the indexed files co-occurs
  with almost everything and unions unrelated domains into one
  franken-cluster whose category list spans many roles (audit §7.1). In the
  `two-framework-monorepo` fixture the structural term `packages` produced a
  repo-wide concept that pulled controller/service files into answer packages
  for manifest questions (QA-07's loop-mode precision dilution).
- **Trade-off / rejected alternative:** isolating glue terms instead of
  dropping them was rejected — an isolated glue term still owns a concept
  row and still matches question tokens, so QA-07's noise survived. Drop
  also removes the term from `termToConcepts`, which is the intended effect.
  Demonstrated pre/post-fix: pre-fix the clustering union produced a single
  `packages` concept swallowing `data`/`auth`/`billing`/`web`, with the real
  domains invisible as separate concepts; post-fix each domain forms exactly.
- **Floor:** below 4 files a whole-span term is likely the repository's one
  real domain concept ("telemetry" spanning its only three files), so the
  cap does not apply; regression-tested in `scripts/test-concepts.ts` §6 and
  `scripts/test-retrieval-loop.ts` §14.

### D9. An explicitly-named file is the question's scope: no speculative
coverage-loop drills once it is served (Phase 1D, V10)
- **Code:** `lib/ai/retrieval-loop.ts` — when pass 0 already served a window
  whose reason starts with `file explicitly named in query`, the loop stops
  with `stoppedBecause: "explicit-anchor"`; leftover missing categories stay
  honestly unknown in the coverage block and nothing new enters the package.
- **Reason:** even after D8 the golden QA-07 case still degraded (10.3%
  loop-mode precision vs the frozen single-pass baseline 44.4%): the loop's
  self-named oov token (`package`) and adaptive glossary category pairs
  pulled monorepo source files into a manifest question. A question that
  names its file outright carries its own scope; every speculative drill
  only matches broad path or glossary noise.
- **Trade-off / rejected alternatives:** suppressing only self-named pairs
  left adaptive drills adding the same monorepo files (10.3%, still worse
  than the approved 11.8% WARN floor); extending the stop rule to all pairs
  restored the frozen baseline exactly (14 PASS / 1 WARN). A rule keyed on
  missing-category type instead of the anchor was rejected as over-clever
  and un-auditable. This supersedes the earlier approved QA-07 WARN
  trade-off (see PROJECT_STATE §Phase 1D): QA-07 is PASS again in both
  modes, and the rule is strictly narrower than "never drill".

## Pending (unresolved — do not decide unilaterally)

| # | Decision | Where it is discussed |
|---|---|---|
| P1 | **Test framework adoption** — the suites are plain scripts with no runner. | [TODO.md](../TODO.md) §2.1 (needs verification) |
| P2 | **Non-literal import specifiers** — how computed/template specifiers are classified. | [TODO.md](../TODO.md) §2.3 |
| P3 | **Licence** — the repository is not licensed for reuse yet. | [TODO.md](../TODO.md) §2.9 |
| P4 | **Object storage swap** for content payloads (and large-file handling). | [file-content-storage.md](architecture/file-content-storage.md), ADR-0001 |
| P5 | **Phase 1D scope and follow-on answer-quality questions** — Phase 1D is implemented and verified 2026-11-06 (batches B, E, C, A, D, G, F), committed and pushed (`e78ee56` at `origin/ravi`; approval for that commit/push was recorded at closure). Open follow-ups: whether to schedule a fresh full answer-quality run (the scorer's fact gaps were fixed after the first baseline run), and a QA-07 retry to replace its final state (the original run's FAIL was pure provider 429 quota exhaustion). | [PROJECT_STATE.md](PROJECT_STATE.md), [phase-1d-qa-audit.md](phase-1d-qa-audit.md) |
| P6 | **Where the pipeline runs** for large repositories. | [architecture.md](architecture.md) §10.3 |
| P7 | **Prompt-injection defence design** for retrieved repository content. | [ROADMAP.md](ROADMAP.md) Phase 2 |

## Historical (context for earlier work)

- **Deterministic planning without an extra LLM call** — the planner uses
  `extractQueryTokens`, `tokenVariants` and onboarding patterns only
  ([coverage-audit.md](coverage-audit.md) §6.5).
- **No new ingestion or schema for derived relationships** — Phase 4 of the
  coverage-driven plan derives call-like relationships at query time from
  retrieved windows; nothing is ever presented as an indexed edge
  ([coverage-audit.md](coverage-audit.md) §4).
- **Entry-point fallback scoring demoted** (30 vs the old 85) so bootstrap
  files cannot outrank real concept matches — recorded in
  [TODO.md](../TODO.md) §3.1.
- **Tree-sitter is a candidate, not a selection** — evaluate during Phase 5
  architecture research; the current parser is ts-morph-based and no
  technology decision has been made for other languages.
