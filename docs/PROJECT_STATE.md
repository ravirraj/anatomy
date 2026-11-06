# Project state

**The first document every agent reads, and the first one every agent must
re-verify.** It records what is true right now: current stage, Git state,
uncommitted work, the exact next approved task, and blockers. It is updated
after every approved subphase (see the maintenance rules in
[../AGENTS.md](../AGENTS.md)).

If this document and the repository disagree, the repository is right — fix
this document and record what differed.

**Last updated: 2026-11-06** (verification of every factual claim in this
file is listed alongside the claim).

---

## 1. Current stage

The product's shipped capability set matches [features.md](features.md).
Development is in **Phase 1 of the delivery programme**
([ROADMAP.md](ROADMAP.md)): retrieval & answer reliability for
JavaScript/TypeScript repositories, on branch `ravi`, done as a sequence of
audit-driven subphases (1A, 1B, 1C, …).

## 2. Verified Git state

Verified 2026-11-06 via `git log --oneline`, `git branch --show-current`,
`git status --porcelain` (re-verified after the Phase 1D work):

| Fact | Value |
|---|---|
| Branch | `ravi` |
| HEAD | `c1ac975` — *fix(retrieval): role-scoped concept affiliation, atomic iterative merge replacement, and served-cost accounting* (Phases 1A + 1B) |
| Remote | `https://github.com/ravirraj/anatomy.git` (`origin`) |
| Unpushed commits | **1** (`c1ac975` is ahead of `origin/ravi`) |
| Previous commits | `f05af36` (CLI flow/budget), `3fa177c` (cli-execution intent), `913e9d0`, `d1098bc`, `159dede`, `df85638` |
| Working tree | 23 modified files (Phase 1C, Phase 1D lib/scripts/docs, `package.json`, `.env.example`, `AGENTS.md`) and 5 new untracked files: `docs/DECISIONS.md`, `docs/PROJECT_STATE.md`, `docs/phase-1d-qa-audit.md`, `scripts/eval-answer-quality.ts`, `eval-answer-baseline.txt` (raw answer-stage run output, UTF-16LE) |
| Commits | **None made during Phase 1C/1D** — per-batch approvals covered implementation only; commit/push still require explicit user approval |

## 3. Work state

### Done and committed

- **Phase 1A + 1B** — commit `c1ac975` on `ravi`: role-scoped concept
  affiliation and atomic iterative-merge replacement with served-cost
  accounting in the coverage loop. Evidence: the commit itself; the suites
  listed in its message scope (`lib/ai/retrieval-loop.ts`,
  `lib/ai/coverage.ts`, `lib/ai/retrieval.ts` and their test scripts).

### Implemented and verified, NOT committed (Phase 1C)

Audit fixes F1–F4 aligning retrieval with the parser role taxonomy
(`lib/roles.ts`, 28 roles), plus their regression tests — 6 modified files,
uncommitted in the working tree:

| File | Content |
|---|---|
| `lib/ai/retrieval.ts` | F1: `ROLE_HINTS` completed (13 new role hints; the dead `store` entry retargeted to `hook` — 7 → 20 entries; one hint per role); F2: `FRONTEND_ROLES` decay set applied at both CLI-execution sites, modern routable roles added to broad-query entry seeding |
| `lib/ai/coverage.ts` | F3: `CATEGORY_AFFILIATION` role lists recognise the modern taxonomy roles, legacy values kept |
| `lib/ai/retrieval-loop.ts` | F4: `CATEGORY_QUERY_WORDS` extended with singular parity and curated role-id vocabulary |
| `scripts/test-retrieval.ts` | New section 6: role seeding, entry routing, CLI decay, no-duplicate/no-inflation checks |
| `scripts/test-coverage.ts` | New section 16: non-adaptive role affiliation for modern + legacy values |
| `scripts/test-retrieval-loop.ts` | Section 2 updated: curated focused-query vocabulary assertions |

**Verification evidence (2026-11-04, after the last change):**

- `pnpm test` — exit 0, all suites "Every check passed."
- `pnpm test:budget` — exit 0.
- `pnpm typecheck` — exit 0.
- `pnpm lint` — 0 errors, 55 warnings (all pre-existing).
- Old-implementation demonstration: with the three `lib/ai` changes stashed,
  the new tests fail — `test-retrieval.ts` §6: 8 FAILs; `test-retrieval-loop.ts`
  §2: 2 FAILs; `test-coverage.ts` §16: 2 FAILs — and pass again after restore.

**Explicitly out of scope in 1C (recorded, not forgotten):** F5 (a planner
`guards` category) was deferred — planner semantics outside Phase 1C scope.

### Uncommitted documentation (this task)

The project-documentation files themselves (this document, ROADMAP/AGENTS/
DECISIONS/architecture/README updates) are also uncommitted. They should be
committed together with, or after, the Phase 1C fix — see the pending
decisions below.

### Phase 1D Q&A quality audit — completed (2026-11-04, read-only)

Delivered [phase-1d-qa-audit.md](phase-1d-qa-audit.md): a full end-to-end Q&A
pipeline audit with per-finding evidence (file + line), severity, and
recommendations, split into verified issues / potential risks / strengths /
verified non-issues. Ten verified issues (V1–V10; headline: vacuous planner
expected-evidence for out-of-vocabulary concepts, golden eval driving the
single-pass entrypoint rather than the production coverage loop, span-tight
multi-window citation rejection, silent fallback-profile evidence-budget
shrink), five potential risks, ten strength clusters, and a proposed Phase 1D
scope (§14) that was **approved and implemented** in the batches below
(2026-11-05–06). No application source, tests or migrations were touched by
the audit itself; the only audit-time repo changes are this document and the
audit file. Links verified via
`node scripts/check-links.mjs` (235 links / 35 files, all resolve).

### Implemented and verified, NOT committed (Phase 1D, 2026-11-05–06)

Executed as the approved consolidated batch plan **B → E → C → A → D → G →
F** (scope: [phase-1d-qa-audit.md](phase-1d-qa-audit.md) §14 findings V1–V10
plus the answer-stage evaluation). Batch isolation was honoured: each batch
landed with its own regression tests before the next started. No commits
were made at any point.

| Batch | Files (beyond tests) | Content |
|---|---|---|
| B | `lib/ai/retrieval.ts` | V3 match-family tightening: `sameFamily`'s one-sided tail accepts only true inflections (`s/d/es/ed/ing/ies/ied`) — loose 2-char agentive tails ("author" of "auth", "scheduler" of "schedule") no longer family-match |
| E | `lib/ai/budget.ts`, `lib/ai/tasks.ts` | V4 fallback-profile visibility (one warning exactly where a fallback profile shrinks the evidence budget) and prompt-budget assertions where generated prompts are assembled |
| C | `lib/ai/citations.ts` | Adjacent window ranges verify as one merged span (V3, span-tight multi-window rejection) |
| A | `lib/ai/coverage.ts`, `lib/ai/retrieval-loop.ts` | V1: self-named (out-of-vocabulary) concepts evaluate against their own name; `selfNamedPositive` echo rule kills phantom partials; V7b: a dry self-named pair drills once, then stays unknown |
| D | `scripts/eval-golden-qa.ts`, `scripts/eval-fixture-adapter.ts` | Golden eval runs the production loop (`--single-pass` opt-out); fixture adapter assigns parser roles to code files (`role: f.role ?? undefined`) |
| G | `lib/ai/concepts/discovery.ts`, `lib/ai/retrieval-loop.ts` | V7a glue-term breadth cap (`MAX_TERM_FILE_FRACTION = 0.4`, floor `GLUE_TERM_MIN_FILES = 4` — D8) and V10 explicit-anchor stop, `stoppedBecause: "explicit-anchor"` (D9) |
| F | `scripts/eval-answer-quality.ts` (new), `package.json` (`test:qa-answer` alias) | Answer-stage evaluation: provider-gated (AI_API_KEY/OPENROUTER_API_KEY/OPENAI_API_KEY), opt-in, quota-costing, never gates CI; `--no-cache`, `--budget-csv`, `--json`, `-c`/`-f`, `--fail-on-warn`; in-process cache only |

Test surfaces added: `scripts/test-planner.ts` sameFamily one-sided units
(B), `scripts/test-citations.ts` span-merge (C), `scripts/test-budget-edge-cases.ts`
fallback-profile (E), the §9 developer-concept expectation flip and §17–§19
in `scripts/test-coverage.ts` (A), §3–§5 baseline updates plus §11–§14 in
`scripts/test-retrieval-loop.ts` (A/G), and `scripts/test-concepts.ts` §6
(9 checks, breadth cap). The 1C test surfaces (`test-retrieval.ts` §6,
`test-coverage.ts` §16, `test-retrieval-loop.ts` §2) are listed in the 1C
section above.

**Frozen golden baseline (2026-11-06, `pnpm test:qa-eval`; loop mode ==
`--single-pass` for all 16 cases):**

| Case | Fixture | Win | Prec | Facts | Verdict |
|---|---|---|---|---|---|
| QA-01 | barrel-index | 2 | 50.0% | 1/1 | PASS |
| QA-02 | barrel-index | 2 | 50.0% | 1/1 | PASS |
| QA-03 | barrel-index | 5 | 37.5% | 2/2 | PASS |
| QA-04 | commonjs | 2 | 100.0% | 3/3 | PASS |
| QA-05 | barrel-index | 5 | 18.8% | 2/2 | WARN (low precision) |
| QA-06 | path-aliases | 2 | 100.0% | 2/2 | PASS (recall 61.5%) |
| QA-07 | two-framework-monorepo | 1 | 44.4% | 3/3 | PASS |
| QA-08 | nextjs-app-router | 5 | 24.2% | 3/3 | PASS |
| QA-09 | polyglot-manifests (Rust) | 1 | 42.9% | 4/4 | PASS |
| QA-10 | polyglot-manifests (TS) | 3 | 41.7% | 4/4 | PASS |
| QA-11 | dynamic-import | 2 | 90.0% | 3/3 | PASS |
| QA-12 | declared-entries | 3 | 25.9% | 3/3 | PASS |
| QA-13/14 | abstention cases | 0 | N/A | 0/0 | PASS |
| QA-15 | polyglot-manifests (Go) | 1 | 60.0% | 3/3 | PASS |
| QA-16 | polyglot-manifests (Python) | 1 | 30.0% | 3/3 | PASS |

Micro-precision 43.2% (89/206), micro-recall 94.7% (89/94), micro-F1 59.3%;
fact grounding 37/37; abstention policy 2/2 (0 fabricated citations).
Compared with the pre-1D loop baseline: +8.2 pp micro-precision with
no recall loss and no new WARN.

**QA-07 trajectory (loop mode):** PASS at baseline → WARN 11.8% under the
narrow V10 (trade-off #1, facts 3/3, user-approved) → 7 windows / 7.0% after
the Batch G cap alone → **PASS 44.4%, byte-identical to the single-pass
baseline, after V10 was widened to suppress all speculative drills for
explicitly-named questions** (D9). Trade-off #1 is thereby superseded — its
approval remains on record; the shipped state is strictly better.

**Batch F answer-stage baseline.** Single sanctioned run (2026-11-06,
`--no-cache --budget-csv`; raw output `eval-answer-baseline.txt`, UTF-16LE;
model `gemini-3.5-flash`, fallback profile):

- First-pass verdicts **11 PASS / 2 WARN / 3 FAIL**; body facts 24/37;
  avg llm 7,664 ms; intermittent 429 retries (free tier, 5 req/min).
- FAIL causes: **QA-06** — generation aborted fail-closed (*Citation
  verification failed: Unknown file path: "tsconfig.json"* — the model
  cited a file outside the served package; facts 0/2); **QA-07** — provider
  429 quota exhaustion, not a determinism issue; **QA-12** — policy
  violation: body citations failed verification (`src/cli.ts`,
  `src/index.ts`, `src/theme.ts` cited beyond the package).
- The two WARNs were scorer gaps, not answer failures: the fixture datasets
  contain the predicate `reads_config` (QA-10/QA-12), which the scorer did
  not measure, and QA-11's wildcard `imports: ["*"]` derived no substring.
  Fixed 2026-11-06 in `scripts/eval-answer-quality.ts` (`reads_config` →
  word-boundary match on the variable, so `main`/`bin` cannot false-positive
  inside unrelated words; wildcard imports fall back to the specifier).
- Re-run of the affected cases after the fix (single-case processes, fresh
  model calls): **QA-10 4/4 PASS, QA-11 3/3 PASS, QA-12 3/3 PASS with
  citations ok** (QA-12's earlier citation violation did not recur on a
  fresh generation). Caveat recorded: a fresh full-16 run on the fixed
  scorer would replace the mixed-vintage numbers above; LLM variance means
  single-case re-runs are not a full baseline.

**Verification evidence (2026-11-06, after the last relevant change):**

- `pnpm test` — exit 0 (planner 51/0, stabilization 123/0, CI-4 17/17).
- `pnpm test:budget` — exit 0.
- `pnpm typecheck` — exit 0 (re-run after the last scorer change).
- `pnpm lint` — 0 errors, 56 warnings (all pre-existing style warnings).
- `pnpm test:qa-eval` — table above, re-run 2026-11-06.
- Old-implementation demonstrations: Batch A (new coverage/loop sections
  fail with the two lib files stashed — with the caveat that the stash also
  reverts uncommitted 1C hunks living in the same files, so the two §16
  `frontend`/`routes` failures witnessed were 1C reversion, not Batch A);
  Batch G (pre-cap clustering produced one `packages` franken-cluster
  swallowing `data`/`auth`/`billing`/`web` with the real domains invisible).

## 4. Exact next approved task

**Phase 1D implementation is complete; the repository awaits one user
decision: commit (and optionally push) the verified Phase 1C + Phase 1D
changes together with the documentation.** Nothing else is in progress. All
verification gates for every batch are recorded in §3; the working tree is
the exact state those gates certify.

Optional follow-ups, **not approved and not started** (each needs its own
approval):

- A fresh full-16 run of `scripts/eval-answer-quality.ts` on the fixed
  scorer, to replace the mixed-vintage answer-stage baseline (§3, Batch F).
- A QA-07 single-case answer-stage retry, to replace its first-run state
  (the FAIL there was pure provider 429 quota exhaustion).
- Retrieval-side precision work for QA-05 (18.8% WARN) and QA-08 (24.2%),
  if the user wants the frozen-baseline WARN count reduced — this would be
  a new mini-batch, not a reopening of 1D.

## 5. Blockers and outstanding issues

| Item | Type | Note |
|---|---|---|
| Commit approval for 1C + 1D + docs | **Pending user decision** | Working tree holds verified, uncommitted work (§2, §3). |
| Push approval for `c1ac975` (+ whatever is committed next) | Pending user decision | `origin/ravi` is 1 behind. |
| Retrieval-side precision for QA-05 / QA-08 | Awaiting approval | QA-05 is the one frozen WARN (18.8% < 20%); QA-08 passes but is adjacent (24.2%). Not 1D scope. |
| LLM provider quota (`429`, 5 req/min free tier) | Environmental | Limited the Batch F answer-stage run (QA-07's FAIL was pure quota; several cases needed retries). Deterministic suites and the golden retrieval eval are unaffected. |
| `authorize` → `authorization` cross-concept prefix leak | Known defect, pre-existing | [coverage-audit.md](coverage-audit.md) §6.2 — bidirectional prefix matching at length ≥ 4. Candidate for a later Phase 1 subphase. |
| Graph islands (`packages/src/*`) unreachable by edges | Known limitation | Only reachable via concept vocabulary; see [coverage-audit.md](coverage-audit.md) §6.1. |
| Explicit-anchor under-coverage beyond the named file | Accepted limitation (D9) | A question naming a file gets that file's scope; unestablished claims render honestly unknown. Drilling resumes when no file is named. |

## 6. Environment quick reference

- Package manager **pnpm**; tests run under plain `node` — **no minimum Node
  version is declared in `package.json`**; verification here used
  **Node 24.21**. A Node 22/24 CI matrix is **planned**, not implemented
  ([TODO.md](../TODO.md) §2.1).
- `pnpm test` runs the full script suite; `pnpm test:budget` runs the
  four budget suites separately. The suites are plain `node scripts/*.ts`
  scripts with no runner — a pending decision ([DECISIONS.md](DECISIONS.md) P1).
- `pnpm typecheck` = `next typegen && tsc --noEmit`.
- `AGENTS.md`'s first block is auto-managed by `next dev` — do not hand-edit
  or remove it.
