# Decisions ledger

The important technical decisions behind Anatomy, with reasons, trade-offs,
and the alternatives that were rejected. Deep background lives in
[project-doc.md](project-doc.md) and [architecture/decisions/](architecture/decisions/);
this ledger is the index an agent reads to avoid silently reopening a
settled question.

Statuses: **Adopted** (in force, evidenced), **Pending** (unresolved — an
agent must not decide these alone), **Historical** (superseded by an adopted
decision).

Recording 2026-11-04; evidence pointers verified against the repository on
that date. Updated 2026-11-06 (Phase 1D closure): D8 (glue-term breadth cap)
and D9 (explicit-anchor stop) added. Updated later on 2026-11-06: P5 and the
1C/1D status rows corrected to the verified committed-and-pushed state
(`7262316`, `e78ee56` at `origin/ravi`). Updated 2026-11-09 (F7 closure):
D7 rewritten from "cache-never-evicted" to the implemented bounded-retention
policy (90-day eligibility, 25,000-row org pruning target, service-role
pruning once per successful analysis completion). Updated 2026-11-09
(F5 closure): D10 added — the `contextText` bare-path rescue removed from
citation verification. Updated 2026-11-09 (F8 closure): D11 added — the
explain tasks' legacy Set tier verifies whole-file paths only and rejects
line-bound citations.

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

### D7. One AI client, pinned models, bounded answer retention (F7)
- **Code:** `lib/ai/client.ts` (single wrapped client), pinned profiles in
  `lib/ai/budget.ts`. Retention (F7, approved 2026-11-09): every `ai_cache`
  row carries `expires_at` (default `now() + 90 days`), pruning lives in
  `prune_ai_cache` (`supabase/migrations/20261109000000_ai_cache_retention.sql`),
  is invoked through `garbageCollectExpiredAnswers` (`lib/content/gc.ts`) and
  wired into the analysis lifecycle via `pruneRetiredAnswers`
  (`lib/pipeline/run.ts`). Full lifecycle: [architecture.md](architecture.md)
  §11.6. Supersedes the earlier "cache never evicted (until challenged)"
  stance — this is the challenge.
- **Retention policy:** 90-day expiration eligibility, a 25,000-row
  per-organization pruning target, 500-row deletion batches, a 5,000-row
  maximum per invocation, and service-role-only pruning.
- **What retention is not:** `expires_at` is *cleanup eligibility*, never
  answer validity. An expired row is storage to reclaim; an unexpired row is
  not evidence of correctness. Verification remains mandatory on every hit
  — a cached answer is never served without re-verifying its citations
  against the current evidence (D2), so retention changes nothing about what
  a cache hit can claim.
- **The cap is a pruning target, not a hard bound:** ordinary cache inserts
  never take the prune lock and are never rejected for exceeding the cap;
  an organization pushed past 25,000 rows converges on the next pruning
  invocation. Verified live against the local database (an insert completed
  in 85 ms while a prune lock was held for 6 s).
- **No scheduler:** pruning happens exactly once per successful analysis
  completion (inside `after()` in the app, awaited in the CLI), bounded by
  the deletion budget; there are no background workers and no retries
  between completions — an organization over budget is trimmed further by
  subsequent completions.
- **Deployment status:** migration applied and catalog-verified against the
  **local** Supabase only; the linked remote project has not received it
  yet.
- **Trade-off:** eviction can cost one regeneration (the cache is a
  performance layer, never a correctness one); rows rendered stale by
  `PROMPT_VERSION`/model changes still occupy storage for up to 90 days
  because their keys can never match again — accepted, bounded waste.

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

### D10. Only served evidence grounds a bare citation — textual mention is never evidence (Phase 2, F5)
- **Code (2026-11-09):** `lib/ai/citations.ts` — the bare-path branch of
  `verifyCitations` no longer accepts a citation because its path string
  appears verbatim anywhere in `contextText`; the `CitationOptions.contextText`
  option and the `verifyCitationsEvidence` text-forwarding parameter were
  removed. A bare path is grounded only by (a) membership in the structured
  served-evidence map (`allowedEvidence`) or (b) the manifest gate
  (`isManifestFileGrounded`: tracked, `stored`, `rendered`, current analysis —
  expanded nowhere).
- **Reason:** the audit (phase-2-audit.md F5, confirmed by an end-to-end
  reproduction at `3e6c7ff`) showed the rescue accepted citations to a real
  but unretrieved file whose name appeared as a string literal or comment in
  served text — even to a *nonexistent* planned-path mention. A mention can
  be committed by any repository text; only retrieval membership proves the
  file's content was served. This is D2's fail-closed rule applied without
  exception: quoting evidence text is not serving the file.
- **Trade-off (deliberately accepted, not silent):** downstream config names
  that live outside the parser's tracked manifest universe (e.g.
  `lithos.json` quoted inside served source) are no longer citable in
  code-span/path form; the mention remains discussable in ordinary prose
  (which is not a citation shape). Supporting such names citably would
  require the parser to track and render them as manifest evidence — a
  separate, unscheduled scope. Cached answers that passed only through the
  rescue self-heal: hit-path verification now rejects, the entry is deleted
  and regenerated once, before serving.
- **Regression coverage:** `scripts/test-citations.ts` ("F5 (Phase 2)"
  section — comment/string-literal/markdown/prose/packaging-shape mentions and
  nonexistent mentions rejected, window bounds unchanged),
  `scripts/test-citation-context-integration.ts` (prompt still embeds
  `contextText` verbatim as *generation* input, while verification consults
  only structure; cache invalidation of rescue-shaped entries),
  `scripts/test-qa.ts` (answer-seam: refusal + no caching, single
  regeneration, citations leaking no unserved path).

### D11. Explain tasks verify whole-file paths; line-bound citations are not verifiable there (Phase 2, F8)

- **Code (2026-11-09):** `lib/ai/citations.ts` — inside
  `verifyCitations`'s line-bound branch, after path matching, the legacy Set
  tier (`isLegacySet`: a plain `Set` with no options — `explainFile` and
  `explainFolder`) rejects every line-cited token (`path#L10-L25`, `path:2-2`,
  single-line `path#L10`) with an `Unverifiable line citation` failure detail,
  instead of silently skipping the evidence-map range checks
  (`start ≥ 1`, `start ≤ end`, `end ≤ lines`, window containment) that only a
  `Map` of `FileEvidence` can run. `lib/ai/tasks.ts`'s `verifyCitationsBody`
  now throws the `CitationError` with its details, so explain refusals reach
  the UI explainable.
- **Two-tier contract (why bare naming is safe, line claims are not):** a
  bare path citation in an explain task names a file whose path and structural
  metadata (role, exports, import/importer edges, folder membership, boundary
  endpoints) were explicitly supplied by parser-resolved input, and the
  prompts sanction exactly those names (`HONESTY`: every repository path in
  full, in backticks; no line references are ever requested). A line-bound
  citation claims specific source evidence, and explain tasks never serve
  line-addressable evidence: the file source is sent unnumbered (and capped at
  `MAX_SOURCE_CHARS`), and the folder message carries no source at all. Any
  line number in an explanation is therefore founded on nothing. Pre-fix, the
  legacy branch accepted those tokens unchecked — verified reproduction: an
  answer citing `path#L1-L9999`, an inverted `#L40-L1`, a zero-start
  `#L0-L1` or a beyond-EOF `#L777` passed verification, was written to the
  cache and re-served on every hit. Now such an answer is refused at write
  time, and a previously poisoned entry fails closed on its next hit.
- **Q&A unchanged:** the Map tier keeps all of its bounds, file-length and
  union-window checks verbatim; `isLegacySet` still governs directory-span
  candidate extraction; the manifest gate is untouched.
- **Trade-off (deliberate):** cached explanations containing line citations —
  rare, since prompts never request that shape — now refuse on their next hit
  and are not healed by the task (explain tasks have no delete-and-regenerate
  seam; F7 retention bounds the pollution window). Explanations gain no line
  precision from this change; the whole-path contract stands unweakened.
- **Regression coverage:** `scripts/test-citations.ts` ("F8 (Phase 2)"
  section: bare target/neighbour/folder-member and directory-span acceptance
  preserved, five line-citation shapes rejected, foreign paths unchanged,
  single-line Map-tier bounds regression) and a rewritten legacy-line case
  asserting the previously accepted `#L10-L25` token now rejects;
  `scripts/test-citation-context-integration.ts` ("Phase 2, F8" block: fresh
  line-cited explanation refused before caching via the intercepted
  OpenAI-compatible transport, whole-path fresh control served and cached,
  poisoned explain-file and explain-folder hits refused with the detail and
  no healing, whole-path cached control serving unchanged).

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
