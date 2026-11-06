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
Q&A engine. Tree-sitter is a *candidate* technology to evaluate during the
architecture research for Phase 5 — it has **not** been selected.

### The phases

| # | Phase | Status (2026-11-04) | Depends on |
|---|---|---|---|
| 1 | **Retrieval & answer reliability** (JavaScript/TypeScript) | **In progress** on branch `ravi` | — |
| 2 | **Answer integrity & safety hardening** | Planned | Phase 1 |
| 3 | **Retrieval quality & performance measurement** | Planned | Phase 1 |
| 4 | **Source-content & search completion** (symbol and full-text search) | Planned | Phase 1 |
| 5 | **Language-neutral intermediate representation** | Planned | Phase 1 |
| 6 | **Multi-language parser adapters** (Python, Go, Java, Rust) | Planned | Phase 5 |
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
| 1C | **Role-taxonomy audit fixes F1–F4** — completed `ROLE_HINTS`, corrected stale role checks and `CATEGORY_AFFILIATION`, curated focused-query vocabulary for role-valued categories | **Implemented and verified, uncommitted** — see [PROJECT_STATE.md](PROJECT_STATE.md) |
| 1D | **Q&A reliability batches** (audit-driven): B retrieval families → E budget/profile plumbing → C citation span-merge → A coverage/loop oov semantics → D golden-eval loop swap + fixture adapter role → G glue-term breadth cap + explicit-anchor stop → F answer-stage evaluation | **Implemented and verified, uncommitted** — see [PROJECT_STATE.md](PROJECT_STATE.md) |

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

#### Phase 1D batch notes (implemented 2026-11-04…06, uncommitted)

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

### Phase 2 — Answer integrity & safety hardening (planned)

Untrusted repository content today reaches a powerful model with limited
defences. Planned (not started): prompt-injection defences for retrieved
content ([TODO.md](../TODO.md) near-term P1), an eviction/invalidation policy
for the answer cache (the cache currently never evicts —
[architecture.md](architecture.md) §10.2), and evolve hash-bound citations
without ever weakening their fail-closed property. Acceptance: the existing
citation and cache tests still pass, plus new tests demonstrating a poisoned
repository cannot make the answer cite or reveal what the evidence does not
contain.

### Phase 3 — Retrieval quality & performance measurement (planned)

Formalise what has so far been measured ad hoc (`scripts/measure-authsphere.ts`,
the baseline tables in [coverage-audit.md](coverage-audit.md)): a repeatable
retrieval-quality and latency benchmark over fixture repositories at
realistic sizes, and budget-constrained performance ceilings for large
repositories ([TODO.md](../TODO.md) §2.4). Acceptance: benchmark numbers in
the documentation are produced by the benchmark, not written by hand.

### Phase 4 — Source-content & search completion (planned)

Source content is stored content-addressed ([ADR-0001](architecture/decisions/0001-source-content-storage.md));
the retrieval engine remains lexical/symbol/path/role. Planned: symbol search
and full-text search over the stored content, in the measured, budgeted
retrieval path. Acceptance at the project's own bar: "no feature appears in
the README that the fixtures do not demonstrate."

### Phase 5 — Language-neutral intermediate representation (planned, do-first)

The prerequisite for every language below ([TODO.md](../TODO.md) §4.1): one
canonical repository model — files, modules, symbols, imports, exports,
unresolved references — that the graph engine and the retrieval/AI layer
consume without knowing which language produced it. The existing TypeScript
parser must produce it with unchanged behaviour; the graph engine's results
must be identical. Architecture research during this phase evaluates parsing
technologies (including tree-sitter, as a candidate only) against the
existing ts-morph pipeline. Effort estimate: XL.

### Phase 6 — Multi-language parser adapters (planned)

One parser adapter per language, each producing the Phase 5 representation
with its own resolver reasons, symbol extraction, graph integration and
fixture corpus ([TODO.md](../TODO.md) §4.2): **Python, Go, Java, Rust**, in
that order of demand. Nothing is promised before its fixtures demonstrate it.

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
| **P1** | Prompt-injection defences for untrusted repository content | Phase 2 |
| **P1** | A public demo deployment, with screenshots and a recorded demo | Phase 8 |

---

## Longer-term direction

- **More languages.** The parser is built on one grammar. Making it
  multi-language means a language-neutral intermediate representation first, so
  the graph engine, the adapters and the AI layer never need to know which
  language a file is in. Python, Go, Java and Rust are the candidates, in that
  order of how much they are wanted.
- **More frameworks.** Django, FastAPI, Gin and Spring Boot, as their
  languages arrive.
- **Repository evolution.** Compare two commits, see the dependency edges that
  changed, recalculate the blast radius for a change set, and track whether the
  shape of a codebase is getting worse.
- **Call graphs.** The import graph is not the call graph. Recovering function
  calls exactly — or not at all — is its own project.
- **A language-neutral intermediate representation**, which is the
  prerequisite for all of the above.

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
