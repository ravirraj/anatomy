# Roadmap

The public-facing view. For the authoritative task list, see
[TODO.md](../TODO.md); for what is true *right now* — branch, uncommitted
work, next approved task — see [PROJECT_STATE.md](PROJECT_STATE.md).

Anatomy turns a public repository into an interactive dependency map, from
real parsing, with answers that cite the code. This is where it is going.

---

## The delivery programme — eight phases

The approved ordering (November 2026):

1. **First**, make JavaScript/TypeScript question answering reliable and
   excellent — it is the only capability real users can exercise today.
2. **Next**, make the platform's architecture language-independent, so that
   no later language work has to change the graph engine, the retrieval
   engine or the answer path.
3. **Later**, introduce language adapters and expand ingestion, parsing,
   symbol extraction, dependency analysis, repository understanding and Q&A
   to multiple languages.

Long-term target: one shared ingestion infrastructure, multiple
language-specific parser adapters, framework-specific adapters, one canonical
repository model, one shared relationship graph, one shared retrieval and
Q&A engine. Tree-sitter remains a *candidate* technology for future
language adapters — it has **not** been selected (pending decision P9 in
[DECISIONS.md](DECISIONS.md)).

### The phases

| # | Phase | Status (2026-11-14) | Depends on |
|---|---|---|---|
| 1 | **Retrieval & answer reliability** (JavaScript/TypeScript) | **In progress** on branch `ravi` | — |
| 2 | **Answer integrity & safety hardening** | Planned | Phase 1 |
| 3 | **Retrieval quality & performance measurement** | Planned | Phase 1 |
| 4 | **Source-content & search completion** (symbol and full-text search) | **Complete** (2026-11-12, branch `ravi`) | Phase 1 |
| 5 | **Language-neutral intermediate representation** | **Complete** (2026-11-14, branch `ravi`) | Phase 1 |
| 6 | **Multi-language parser adapters** (Python, Go, Java, Rust) | **Next planned** | Phase 5 |
| 7 | **Framework adapters** (Django, FastAPI, Gin, Spring) | Planned | Phase 6, per language |
| 8 | **Product completion & public release** (demo deployment, licence, repository evolution) | Planned | Phases 1–4 |

Statuses above are verified against Git and the recorded test runs — see the
phase notes below and [PROJECT_STATE.md](PROJECT_STATE.md). Nothing is marked
done without evidence.

### Phase 1 — Retrieval & answer reliability (in progress)

Make repository-wide Q&A answer *the question that was asked*, grounded and
complete, for JavaScript/TypeScript repositories. The work sequence is
audit-driven: audit a behaviour, fix it, prove the fix with regression tests
that fail against the old implementation.

| Subphase | Content | Status |
|---|---|---|
| 1A | **Role-scoped concept affiliation** — coverage categories and loop-focused queries work off the raw taxonomy role ids | **Done, committed** (`c1ac975`) |
| 1B | **Atomic iterative-merge replacement + served-cost accounting** — the coverage loop replaces weak evidence atomically and every package carries a served-size ledger | **Done, committed** (`c1ac975`) |
| 1C | **Role-taxonomy audit fixes F1–F4** — completed `ROLE_HINTS`, corrected stale role checks and `CATEGORY_AFFILIATION`, curated focused-query vocabulary for role-valued categories | **Committed** (`7262316`, pushed to `origin/ravi`) — see [PROJECT_STATE.md](PROJECT_STATE.md) |
| 1D | **Q&A reliability batches** (audit-driven): B retrieval families → E budget/profile plumbing → C citation span-merge → A coverage/loop oov semantics → D golden-eval loop swap + fixture adapter role → G glue-term breadth cap + explicit-anchor stop → F answer-stage evaluation | **Committed and pushed** (`e78ee56` on `origin/ravi`) — see [PROJECT_STATE.md](PROJECT_STATE.md) |

**Deliverables per subphase:** targeted fixes in `lib/ai/retrieval.ts`,
`lib/ai/coverage.ts`, `lib/ai/retrieval-loop.ts` (and planner only when an
audit item names it), plus regression tests in `scripts/test-retrieval.ts`,
`scripts/test-coverage.ts`, `scripts/test-retrieval-loop.ts`.

**Acceptance criteria (every subphase):** `pnpm test`, `pnpm test:budget`,
`pnpm typecheck` and `pnpm lint` all pass after the last change; the new
tests are demonstrated to fail against the pre-fix implementation; no
scoring redesign, no new dependencies, no weakening of content-trust or
citation checks; changes are backward-compatible with analyses stored under
the legacy role values.

#### Phase 1D batch notes (implemented 2026-11-04…06, committed at `e78ee56`)

Executed as the approved consolidated plan (order B → E → C → A → D → G → F),
scope drawn from [phase-1d-qa-audit.md](phase-1d-qa-audit.md). Evidence and
baselines are recorded in [PROJECT_STATE.md](PROJECT_STATE.md); decision
records D8 and D9 in [DECISIONS.md](DECISIONS.md).

- **B** — retrieval match-family fixes (`lib/ai/retrieval.ts`): symbol-echo
  and path-token scoring so question wording cannot double-count a file.
- **E** — budget/profile plumbing: fallback-profile visibility (V4) and
  prompt-budget assertions where generated prompts are assembled.
- **C** — citation span-merge: adjacent window ranges verify as one span
  instead of failing on gap arithmetic.
- **A** — coverage `oov` semantics: self-named concepts evaluate by their own
  name (`lib/ai/coverage.ts` `selfNamedPositive` echo rule), and the loop
  drills a dry self-named pair once before leaving it unknown
  (`lib/ai/retrieval-loop.ts` V1/V7b).
- **D** — golden eval runs the production loop (`--single-pass` opt-out) and
  the fixture adapter assigns parser roles to code files; frozen baseline
  15 PASS / 1 WARN (QA-05), recorded byte-for-byte.
- **G** — V7a glue-term breadth cap (`MAX_TERM_FILE_FRACTION`/floor, D8) and
  V10 explicit-anchor stop (D9): the golden set is identical in loop and
  single-pass modes (15 PASS / 1 WARN, micro-precision 43.2%), QA-07 back to
  PASS in both modes, superseding the earlier approved QA-07 WARN trade-off.
- **F** — answer-stage evaluation (`scripts/eval-answer-quality.ts`,
  `pnpm test:qa-answer`): provider-gated, opt-in, quota-costing, never gates
  CI; scores answer bodies against expected facts and completion policies.
  First full baseline run recorded in [PROJECT_STATE.md](PROJECT_STATE.md),
  with fact-scoring gaps (`reads_config`, wildcard `imports`) fixed
  afterwards and the affected cases re-run PASS.

### Phase 2 — Answer integrity & safety hardening (implemented 2026-11-06…09; F5 and F8 resolved 2026-11-09)

Untrusted repository content today reaches a powerful model with limited
defences. Implemented: prompt-injection defences for retrieved content
(audit batches B1–B4 — trust-boundary system prompt rule with
`PROMPT_VERSION` 2→3, full-hash window headers, packaging-line sanitizing,
JSDoc appendix cap — committed as `9f4f942`, tests in
`scripts/test-prompt-hardening.ts` and [TODO.md](../TODO.md) near-term P1),
a bounded eviction/retention policy for the answer cache (F7-1…F7-3:
90-day `expires_at`, per-organization pruning target of 25,000 rows,
service-role pruning once per successful analysis completion — implemented,
DB-verified against the local Supabase and committed as `3e6c7ff`;
lifecycle in [architecture.md](architecture.md) §11.6, decision in
[DECISIONS.md](DECISIONS.md) D7), and the closure of audit finding F5
(2026-11-09): the `contextText` bare-path rescue removed — a bare citation is
grounded only by the structured served-evidence map or the manifest gate, so
a comment, string literal or packaging row can no longer authorize a citation
to a file whose content was never served (decision D10; regression coverage
in `scripts/test-citations.ts`, `scripts/test-citation-context-integration.ts`
and `scripts/test-qa.ts`). Audit finding F8 (2026-11-09): the explain tasks'
legacy Set tier was formally accepted for whole-path naming (D11) while every
line-bound citation token is now rejected there — explain tasks serve no
line-addressable evidence, so fabricated or hallucinated line ranges can no
longer pass verification and be cached. Hash-bound citations evolved without
weakening their fail-closed property (B2/B1 re-keying). Acceptance: the existing
citation and cache tests still pass, plus new tests demonstrating a
poisoned repository cannot make the answer cite or reveal what the
evidence does not contain (prompt-hardening and golden-QA suites).

### Phase 3 — Retrieval quality & performance measurement (planned)

Formalise what has so far been measured ad hoc (`scripts/measure-authsphere.ts`,
the baseline tables in [coverage-audit.md](coverage-audit.md)): a repeatable
retrieval-quality and latency benchmark over fixture repositories at
realistic sizes, and budget-constrained performance ceilings for large
repositories ([TODO.md](../TODO.md) §2.4). Acceptance: benchmark numbers in
the documentation are produced by the benchmark, not written by hand.

### Phase 4 — Source-content & search completion (complete 2026-11-12)

Source content is stored content-addressed ([ADR-0001](architecture/decisions/0001-source-content-storage.md));
the retrieval engine remains lexical/symbol/path/role. Delivered as five
audited, test-first batches on branch `ravi`, each gated by the full
verification battery and committed against the frozen golden-QA baseline
(15 PASS / 1 WARN / 0 FAIL — byte-identical after every batch):

| Batch | Commit | Content |
|---|---|---|
| 1 | `230c99a` | **Qualified-name search** — symbols matched by their qualified names and identifier subtokens in retrieval |
| 2 | `c44cdf2` | **Method and nested-function indexing** — the parser indexes methods and nested functions as searchable symbols |
| 3 | `a0c4466` | **Search-strategy evaluation hardening** — `scripts/eval-search-strategy.ts` attributes each served file to the strategies that found it (discovery vs ranking split) |
| 4 | `0a61d77` | **Express route indexing** — Express routes recovered by static analysis, with conservative withholding when unparsed files exist |
| 5 | `508dd03` | **Entry-point and packaging discovery** — declared/inferred entry points seed retrieval candidates for startup queries; workspace globs resolve to member packages (negation honoured); packaging relevance also fires on declared dependency/manifest/config names, not only on vocabulary |

Documented limitations: uppercase-only explicit HTTP-method detection in
queries; the golden dataset has zero unanchored discovery cases, so the
strategy diagnostics measure only path-anchored discovery; `isPublicApi`
remains deferred (no `symbols` column, no persistence — see
[PROJECT_STATE.md](PROJECT_STATE.md)). Full-text search over the stored
content was not part of the delivered batch scope.

Acceptance at the project's own bar: "no feature appears in the README that
the fixtures do not demonstrate."

### Phase 5 — Language-neutral intermediate representation (complete 2026-11-14)

The prerequisite for every language below ([TODO.md](../TODO.md) §4.1):
one canonical repository model — files, modules, symbols, imports, exports,
unresolved references — that the graph engine and the retrieval/AI layer
consume without knowing which language produced it. Delivered in audited,
test-first batches on branch `ravi` (commits `59e320b`…`b66350d` plus one
verified uncommitted change set; evidence and the verification battery in
[PROJECT_STATE.md](PROJECT_STATE.md) §3 Phase 5):

- **5.1 — Canonical IR v1 contract** (`IR_VERSION` 1, `lib/ir/`): the
  language-neutral repository contract with a round-trip projection against
  the parser's `ParseResult` (schema v7).
- **5.2 — Eight-language registry** (`lib/ir/languages.ts`): JavaScript,
  TypeScript, Python, Go, Rust, Java, C, C++ — with extraction coverage
  stated honestly: **only JS/TS has an extraction adapter today**. The
  registry recognises the other languages; no parser produces IR for them
  yet.
- **5.3 — FrameworkView foundation** (`FRAMEWORK_VIEW_VERSION` 1,
  `lib/parser/adapters/view.ts`): framework detection, role detection and
  route recovery (Express, NestJS, and Next.js in the uncommitted change
  set) decoupled from ts-morph structures, with the production adapter
  registry pinned by the harness (`scripts/test-adapter-view.ts`,
  Section 12 invariant).
- **5.4 — Persistence-seam audit**: closed with **no implementation and no
  schema changes** (decision D12).
- **5.5 — Retrieval & graph integration audit**: closed with **no
  implementation changes** (decision D13).

Architectural conclusions (recorded in [DECISIONS.md](DECISIONS.md)
D12–D13): the canonical IR is an **in-process normalization contract** —
the existing database tables remain the persistence source of truth
(`ParseResult` schema v7 is the current persistence input; `toIr()` is not
on the production ingestion path); **no separate retrieval, graph or Q&A
engine is needed per language** — the existing engines are already
language-neutral in scoring, expansion, serving, coverage and citations;
language-specific semantics belong in adapters and IR extensions, never
flattened into misleading common edges; and no speculative persistence
abstraction or database migration was introduced. No new parsing
technology was adopted in this phase; tree-sitter remains an unselected
candidate (pending decision P9).

### Phase 6 — Multi-language parser adapters (next planned)

One parser adapter per language, each producing the Phase 5 representation
with its own resolver reasons, symbol extraction, graph integration and
fixture corpus ([TODO.md](../TODO.md) §4.2): **Python, Go, Java, Rust**, in
that order of demand. Nothing is promised before its fixtures demonstrate it.
Phase 6 has not started.

Prerequisites verified by the Phase 5 audits (5.4/5.5; decisions D12–D13;
full detail in [PROJECT_STATE.md](PROJECT_STATE.md) §4):

1. **Registry-aware file admission** — `lib/parser/walk.ts`
   (`CODE_EXTENSIONS` / `isCodeFile`).
2. **Registry-aware parsed-file reconstruction** — `lib/analysis/load.ts`.
3. **Registry-aware retrieval Stage 1 admission** — `lib/ai/retrieval.ts`.

Plus one design checkpoint before the first adapter: resolve the
adapter-to-persistence seam (pending decision P8) — `ParseResult` schema v7
stays the persistence input, `toIr()` is not added to the ingestion path
without an explicit decision, and no second persistence path is introduced.
Schema changes stay conditional on actual adapter requirements (the
`symbols.kind` and `manifests.ecosystem` constraints are the known
candidates). First-adapter recommendation: **Python**, followed by
end-to-end retrieval and QA evaluation — one adapter proving the complete
pipeline, not several languages in parallel.

### Phase 7 — Framework adapters (planned)

Framework-specific adapters over the Phase 6 parsers ([TODO.md](../TODO.md)
§4.3): Django and FastAPI (Python), Gin (Go), Spring Boot (Java). A framework
adapter is six methods — detection, roles, route recovery, route withholding
with reasons, conventions, and stated limitations — following the existing
adapters (Next.js, NestJS, Express, Docusaurus, React).

### Phase 8 — Product completion & public release (planned)

Public demo deployment with a recorded walkthrough, a licence decision, and
repository-evolution features (impact analysis beyond a fixed depth,
commit-to-commit comparison — [TODO.md](../TODO.md) §6). Acceptance: a
deployed instance whose claims are the ones the documentation makes.

### 8-phase numbering — read this once

Three numbering systems exist in this repository. They are different things:

| System | Where | Meaning |
|---|---|---|
| **Build phases 01–10** | [docs/specs/](specs/) | The original construction of the product (auth, parser, canvas, …). **Historical.** |
| **Coverage-driven Q&A plan, Phases 1–6** | [coverage-audit.md](coverage-audit.md) | The plan behind repository-wide Q&A: audit → retrieval → coverage → loop. Historical record of that work. |
| **Delivery phases 1–8** | this section | The current delivery programme, approved November 2026. |

When a document says "Phase N", check which of the three it means.

---

## Shipped milestones

### *A map you can trust*

**Shipped.** The pipeline runs end to end against live repositories, the map
renders a real dependency graph, and the routes are recovered from syntax or
withheld with a stated reason.

- TypeScript and JavaScript, parsed with ts-morph
- Next.js, NestJS, Express, Docusaurus and React recognised
- Blast radius and dependency chain, computed in the browser from the edge list
- Explanations for a file or a folder, cached and traced
- Row-level security on every table, verified against a live database

**What that list left out, as written at the time:** no repository-wide
questions, no symbol search, no other languages, no call graph, no public
deployment. The first of those has since shipped (next milestone); symbol
search, other languages, the call graph and a public deployment are still
not shipped, and are sequenced in the delivery programme above.

---

## Milestone (shipped) — *Answers that cite code*

**Shipped (Phase 5).** Repository-wide question answering grounded in real code, with hash-bound verifiable line citations.

### 1. A parser we can measure

A fixture corpus of real repositories (`fixtures/`), checked on every build (`scripts/test-fixtures.ts`), with an F1 score of 1.0 against ground truth (`scripts/accuracy-fixtures.ts`).

### 2. Questions across the whole repository

> *How does authentication work in this repository?*

An interactive question interface over a whole analysis. Answers cite real files and line ranges (`lib/auth/session.ts#L10-L40`), open in the map, and highlight the nodes on the canvas. When the stored analysis does not contain sufficient evidence, the answer clearly states so.

**Hash-bound citation verifier:** Every citation is verified against the stored analysis, valid line ranges, and SHA-256 content hashes (`lib/ai/citations.ts`). Any invented or out-of-bounds citation produces a `CitationError` and prevents caching.

---

## Near-term priorities

The two P0 rows below are done (verified in [TODO.md](../TODO.md) §3.1);
the rest live in the delivery programme above.

| | Deliverable | Programme phase |
|---|---|---|
| **P0** | ~~Parser fixtures, regressions and an accuracy measurement~~ — **done** | Phase 1 |
| **P0** | ~~Verify every citation against the stored analysis~~ — **done** | shipped |
| **P0** | Tenant-isolation tests, runnable against a test database | Phase 2 |
| **P1** | Symbol and full-text search | Phase 4 |
| **P1** | Change impact analysis beyond a fixed depth | Phase 8 |
| **P1** | ~~Prompt-injection defences for untrusted repository content~~ — **done** (audit batches B1–B4, committed `9f4f942`) | Phase 2 |
| **P1** | A public demo deployment, with screenshots and a recorded demo | Phase 8 |

---

## Longer-term direction

- **More languages.** The parser is built on one grammar. Making it
  multi-language now means language adapters over the delivered Phase 5
  intermediate representation and registry ([DECISIONS.md](DECISIONS.md)
  D12–D13), so the graph engine, the adapters and the AI layer never need to
  know which language a file is in. Python, Go, Java and Rust are the
  candidates, in that order of how much they are wanted.
- **More frameworks.** Django, FastAPI, Gin and Spring Boot, as their
  languages arrive.
- **Repository evolution.** Compare two commits, see the dependency edges that
  changed, recalculate the blast radius for a change set, and track whether the
  shape of a codebase is getting worse.
- **Call graphs.** The import graph is not the call graph. Recovering function
  calls exactly — or not at all — is its own project.

---

## What is deliberately not planned

**Autonomous code modification, and multi-agent orchestration.** Neither has a
demonstrated user need here, and both would put a model in a position to decide
structure — the one thing the model is never allowed to do in this product. If
a proposal arrives, it is evaluated against a real need, not against novelty.

---

## Reading the details

| | |
|---|---|
| [TODO.md](../TODO.md) | Every task, with status, acceptance criteria and effort |
| [docs/features.md](features.md) | What exists today, and what does not |
| [docs/architecture.md](architecture.md) | How it is built |
| [docs/development.md](development.md) | How to run it, and how to extend it |
| [docs/ai-system.md](ai-system.md) | The AI layer, and the design for repository-wide Q&A |
| [docs/security.md](security.md) | Trust boundaries, data flow, known limitations |
