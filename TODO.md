# TODO

The authoritative task list for Anatomy.

**This file describes what Anatomy should do next. It does not describe what it
does today.** For that, see [docs/features.md](docs/features.md) and
[docs/architecture.md](docs/architecture.md).

## How to read this

Each item has a status, and the status is the point:

| Status | Means |
|---|---|
| **Done** | Implemented and verified. |
| **In progress** | Active work with a partial implementation. |
| **Planned** | Accepted for future implementation. |
| **Needs verification** | The implementation or the documentation is inconclusive and somebody has to look. |
| **Blocked** | Depends on an unresolved prerequisite. |
| **Deferred** | Deliberately postponed. |

Priorities:

| Priority | Means |
|---|---|
| **P0** | Essential for a reliable, demonstrable core product. |
| **P1** | High-value features for the next milestone. |
| **P2** | Useful improvements after the core is stable. |
| **P3** | Experimental or long-term. |

Effort is **S / M / L / XL** and is an **estimate**, not a deadline. Every
estimate is subject to what implementation turns up.

**Conventions**

- A checkbox is unticked unless there is evidence it is done.
- Completed work moves to [CHANGELOG.md](CHANGELOG.md) and out of this file.
- A feature is not "Done" because a function or a UI component exists. It is
  Done when its acceptance criteria are met.
- Documentation changes are tasks too, and are marked as such.

---

## 1. Current project status

### 1.1 Maturity

Anatomy is a **working application**, not a prototype. The pipeline runs
end-to-end against live public repositories, the map renders a real dependency
graph, row-level security has been exercised directly against the production
database, and AI answers are cached and traced.

It is **not finished**. The largest missing capability is repository-wide
question answering, and the largest missing engineering foundation is a
fixture corpus for the parser.

| Area | State |
|---|---|
| Repository ingestion | Working, with limits stated (100 MB archive, 5-minute timeout). |
| Parsing | Working for TypeScript and JavaScript. |
| Graph and canvas | Working. |
| Route recovery | Working for Next.js App Router handlers and NestJS controllers. Express is withheld by design. |
| AI explanations | Working for a file or a folder. |
| Multi-tenancy | Working, verified against the live database. |
| Progress reporting | Working over a private realtime channel. |
| Testing | Fixture regression suite over the parser — ten repositories, byte-compared against pinned results, and an accuracy evaluation against hand-verified ground truth — alongside the two suites of 24 checks. |
| Documentation | This set. |
| Deployment | None. No public instance, no recorded demo. |
| Licensing | None. |

### 1.2 Verified supported languages and frameworks

**Language: TypeScript and JavaScript only.**
`CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]`
in `lib/parser/walk.ts`. There is no other grammar in the repository, and no
language field in the data model.

**Frameworks**, by dependency in the project's `package.json`:

| Framework | Detected by | Roles assigned | Routes recovered |
|---|---|---|---|
| Next.js | `next` | Yes | App Router route handlers only |
| NestJS | `@nestjs/core` | Yes | Controller and method decorators |
| Express | `express` | Yes (folder-based) | Never — always withheld |
| Docusaurus | `@docusaurus/core` | Yes | None |
| React | `react` | Yes (component, hook) | None |
| *fallback* | always | Config and test files only | None |

### 1.3 Current limitations

1. **No repository-wide question answering.** Explanations are per file or per
   folder.
2. **TypeScript and JavaScript only.**
3. **No call graph.** Only import and re-export relationships. Top-level
   declarations are extracted with their kind, line and exported flag, but
   which function calls which is not.
4. **The route table covers a minority of frameworks.** Express never,
   Next.js Pages Router pages never, and Docusaurus never.
5. **The blast radius stops at two steps.** Files further out are counted, not
   listed.
6. **A panel shows 14 rows at a time.**
7. **The answer cache never evicts.**
8. **No public deployment and no recorded demonstration.**

### 1.4 Important technical debt

| Debt | Where | Why it matters |
|---|---|---|
| The parser's data writes are not fenced by the run's claim | `lib/pipeline/store.ts` | Two overlapping runs on one analysis can rewrite each other's rows. |
| `createRouteMatcher` is deprecated by Clerk | `proxy.ts` | It still works, and it logs a deprecation warning on every boot. |
| The `neighboursOf` kinds are in encounter order, not contract order | `lib/graph/detail.ts` | The comment says otherwise. Cosmetic, but the comment is wrong. |
| `clampOffset` returns `NaN` for a `NaN` request | `lib/graph/view.ts` | Not reachable today, but it is a `NaN` in a position. |
| `categoryOf` is called twice per path in `countByCategory` | `lib/graph/categories.ts` | Trivial. |
| The archive timeout and the stale window are both five minutes | `lib/pipeline/github.ts`, `stages.ts` | A slow download can be overtaken by a re-claim. |
| The RLS event trigger is duplicated | Clerk's dashboard installs one; the migration's `do $$` block skips creating one if it exists | The upstream function replaces the dashboard's, which is intended, but the interaction is subtle. |

### 1.5 The most important next milestone

**A parser fixture corpus, and a repository-wide question-answering path that
cites real files.**

The corpus first, because everything else is measured against it. The Q&A
second, because it is the capability the product exists for and the one the
map cannot substitute for. Between them stands source-content storage
(3.4): the contents are the Q&A retrieval's raw material, and it is
designed in [docs/architecture/file-content-storage.md](docs/architecture/file-content-storage.md).

---

## 2. Implementation and validation

### 2.1 Build, lint, type-check and test reliability

- [ ] **Add a `typecheck` script** that runs `tsc --noEmit` after a build has
      generated the route types
  - **Status:** Planned
  - **Problem:** `npx tsc --noEmit` fails on `PageProps` and `LayoutProps`,
    which Next.js generates into `.next/types`. There is no way to type-check
    without building first, and the failure looks like a real error.
  - **Outcome:** `pnpm typecheck` is a single command that works.
  - **Acceptance criteria:**
    - [ ] The script runs `next build` (or `next typegen`) before `tsc`.
    - [ ] It exits non-zero on a type error.
    - [ ] It is documented in [docs/development.md](docs/development.md).
  - **Dependencies:** None.
  - **Effort:** S.

- [ ] **Add continuous integration running build, lint and test**
  - **Status:** Planned
  - **Problem:** Nothing runs the checks automatically. The only evidence they
    pass is a person running them.
  - **Outcome:** Every push is checked.
  - **Acceptance criteria:**
    - [ ] A workflow runs `pnpm install`, `pnpm lint`, `pnpm test` and
          `pnpm build` on Node 22 and Node 24.
    - [ ] A failure is visible on the pull request.
  - **Dependencies:** None.
  - **Effort:** S.

- [ ] **Decide whether to adopt a test framework**
  - **Status:** Needs verification
  - **Problem:** The two suites are plain scripts. They work and they assert on
    real behaviour, but they have no runner, no watch mode, no fixtures
    directory and no reporting.
  - **Outcome:** A decision, recorded, with the reasoning.
  - **Acceptance criteria:**
    - [ ] The decision is written down in [docs/development.md](docs/development.md).
    - [ ] If a framework is adopted, the existing suites are ported and still
          pass.
  - **Dependencies:** None.
  - **Effort:** S (the decision) / M (the port).

### 2.2 Parser accuracy and unresolved imports

- [x] **[P0] Build a fixture corpus of real repositories**
  - **Status:** Done — ten fixtures, one per kind the criteria name, in
    `fixtures/`, each with its expected result and hand-verified ground truth;
    the runner is `node scripts/test-fixtures.ts`, re-baselined with
    `--update <name>`; documented in [fixtures/README.md](fixtures/README.md).
  - **Problem:** The parser has no regression suite. Every change to the
    resolver is a change to a product nobody can test.
  - **Outcome:** A directory of repositories with their expected results,
    checked on every build.
  - **Acceptance criteria:**
    - [x] At least ten fixture repositories, spanning at least: a Next.js App
          Router app, a Next.js Pages Router app, a monorepo with two
          frameworks, a CommonJS project, a project with path aliases, a
          project with a barrel-file-heavy `index.ts` layout, a project with
          `require()`, a project with dynamic `import()`, a project with a
          `tsconfig` `baseUrl`, and a project with unlinked workspace packages.
    - [x] Each fixture has an expected result: files, edges, routes, roles and
          the set of unresolved reasons.
    - [x] A test runs the parser over every fixture and compares.
    - [x] A fixture that changes is a **failing** test, not a diff to review.
  - **Dependencies:** None. This is the first thing to build.
  - **Effort:** Done.

- [x] **[P0] Measure dependency-extraction accuracy**
  - **Status:** Done — `pnpm accuracy` criterion, against the hand-verified
    ground truth in [fixtures/accuracy.json](fixtures/accuracy.json). Every
    internal dependency relationship in the ten fixtures was found (TP 20,
    FP 0, FN 0), so precision, recall and F1 are all 1 as the observed
    baseline; the floor below which a change is a regression is the constant
    `MINIMUM_F1` in [scripts/accuracy-fixtures.ts](scripts/accuracy-fixtures.ts),
    set to that baseline, and a change below it fails the run.
  - **Problem:** "The parser is accurate" is not a number.
  - **Outcome:** A published measurement with a stated method.
  - **Acceptance criteria:**
    - [x] For each fixture, a hand-counted ground truth of its internal edges.
    - [x] Precision and recall reported, with the method stated.
    - [x] A stated threshold below which a change is a regression.
  - **Dependencies:** The fixture corpus.
  - **Effort:** Done.

- [ ] **State the supported-language boundary in the UI, not only in the docs**
  - **Status:** Planned
  - **Problem:** A Go repository produces "found 0 files" with no explanation in
    the product. The user cannot tell whether the tool is broken or the
    repository is not JavaScript.
  - **Outcome:** The dashboard says which languages it parses, and a repository
    with no parseable files says so plainly.
  - **Acceptance criteria:**
    - [ ] The dashboard states the supported extensions.
    - [ ] An analysis with zero parseable files says why.
  - **Dependencies:** None.
  - **Effort:** S.

- [ ] **Report import forms separately in the coverage report**
  - **Status:** Planned
  - **Problem:** `byKind` already separates import, re-export, dynamic-import
    and require, but the summary line does not surface it, so the proportion of
    the four forms in a repository is invisible.
  - **Outcome:** The proportion of each form is visible.
  - **Acceptance criteria:**
    - [ ] The coverage summary shows the four counts.
    - [ ] The UI shows them.
  - **Dependencies:** None.
  - **Effort:** S.

### 2.3 Dynamic imports and other dependency patterns

- [ ] **Decide what to do about non-literal specifiers**
  - **Status:** Deferred
  - **Problem:** `import(someVar)` and `require(someVar)` are reported as
    unresolved, correctly — the path is computed at runtime. But a repository
    with a dynamic import table has a real dependency structure that Anatomy
    cannot see.
  - **Outcome:** A decision. Either a stated limitation, or a defined subset
    that can be resolved (for example, a literal in an object literal).
  - **Acceptance criteria:**
    - [ ] The decision is recorded.
    - [ ] If a subset is supported, it is covered by a fixture.
  - **Dependencies:** The fixture corpus.
  - **Effort:** S (the decision) / L (the subset).

- [ ] **Cover `export =` and `import =` in the fixture corpus**
  - **Status:** Planned
  - **Problem:** The extractor handles `export =` and TypeScript import-equals,
    and neither is covered by a fixture.
  - **Outcome:** Both are covered.
  - **Acceptance criteria:**
    - [ ] A CommonJS fixture with `export =` and one with `import x = require()`.
  - **Dependencies:** The fixture corpus.
  - **Effort:** S.

### 2.4 Graph correctness and large-repository performance

- [ ] **Measure the cost of a large repository end to end**
  - **Status:** Planned
  - **Problem:** The browser holds the whole file list and rescans every edge
    on each rebuild. Nobody has measured what that costs on a repository with
    ten thousand files.
  - **Outcome:** A number, and a decision about what to do about it.
  - **Acceptance criteria:**
    - [ ] A benchmark over a repository of at least 5,000 files.
    - [ ] Parse time, store time, read-back time and first-render time
          reported separately.
    - [ ] A decision about server-side rendering of the map view, or a stated
          limit.
  - **Dependencies:** A known large repository to benchmark against.
  - **Effort:** M.

- [ ] **Measure the parser's throughput**
  - **Status:** Planned
  - **Problem:** No number exists for how long parsing takes per thousand
    files.
  - **Outcome:** A number, and a documented expectation.
  - **Acceptance criteria:**
    - [ ] Files per second reported for at least three repositories.
    - [ ] The expectation is written into [docs/development.md](docs/development.md).
  - **Dependencies:** None.
  - **Effort:** S.

- [ ] **Add a guard for the `beyond` count in a very large graph**
  - **Status:** Needs verification
  - **Problem:** `reach` traverses the whole reachable component even though it
    reports only two steps. On a very large graph that is work for a number.
  - **Outcome:** Either a bounded traversal, or a measurement showing it does
    not matter.
  - **Acceptance criteria:**
    - [ ] The traversal's cost is measured on a large graph.
    - [ ] If it matters, the traversal is bounded and the count is stated as
          approximate.
  - **Dependencies:** The large-repository benchmark.
  - **Effort:** S.

- [ ] **Test the folding threshold against real repository shapes**
  - **Status:** Planned
  - **Problem:** `foldDirectories` picks a threshold so that at most 24 groups
    remain. Nobody has checked that this produces a *readable* map on a
    real repository, rather than one enormous group.
  - **Outcome:** A checked rule.
  - **Acceptance criteria:**
    - [ ] At least three real repositories folded, and the group sizes
          inspected.
    - [ ] A rule that avoids a group holding most of the repository.
  - **Dependencies:** The fixture corpus.
  - **Effort:** S.

### 2.5 Error handling and analysis progress

- [ ] **Fence the parser's data writes by the run's claim**
  - **Status:** Planned
  - **Problem:** `analyses` updates are scoped by `started_at`, but the
    `files`, `edges`, `routes` and `file_roles` writes are not. Two
    overlapping runs on one analysis can rewrite each other's rows.
  - **Outcome:** A superseded run cannot touch the newer run's data.
  - **Acceptance criteria:**
    - [ ] The store functions take the claim and scope their writes by it.
    - [ ] A test starts two runs against one analysis and shows the loser
          changes nothing.
  - **Dependencies:** None.
  - **Effort:** M.

- [ ] **Show a failed run's stage in the dashboard**
  - **Status:** Planned
  - **Problem:** The dashboard shows the state, but a failed run's reason is
    only visible on the analysis page.
  - **Outcome:** The reason is on the dashboard.
  - **Acceptance criteria:**
    - [ ] A failed row shows the error.
  - **Dependencies:** None.
  - **Effort:** S.

- [ ] **Give the pipeline a way to be cancelled**
  - **Status:** Planned
  - **Problem:** There is no way to stop a run other than waiting for it to
    fail or be taken over.
  - **Outcome:** A person can abandon a run.
  - **Acceptance criteria:**
    - [ ] A cancel action that marks the row failed with a stated reason.
    - [ ] A cancelled run stops writing.
  - **Dependencies:** The claim fencing.
  - **Effort:** M.

- [ ] **Bound the parser's memory use on a large repository**
  - **Status:** Planned
  - **Problem:** Every file's content is held in memory at once
    (`sourceFiles` is built before parsing begins).
  - **Outcome:** A stated limit, or a streaming parse.
  - **Acceptance criteria:**
    - [ ] The memory used for a large repository is measured.
    - [ ] Either a limit is enforced and stated, or the parse is streamed.
  - **Dependencies:** The large-repository benchmark.
  - **Effort:** M to L.

### 2.6 Authentication and authorization verification

- [ ] **Replace the deprecated `createRouteMatcher`**
  - **Status:** Planned
  - **Problem:** Clerk deprecated it. It works and logs a deprecation warning
    on every boot.
  - **Outcome:** No warning, and the same protection.
  - **Acceptance criteria:**
    - [ ] The public routes are matched by the native Next.js matcher.
    - [ ] A signed-out request to a protected route is still redirected.
  - **Dependencies:** None.
  - **Effort:** S.

- [ ] **Automate the isolation checks as a test**
  - **Status:** Planned
  - **Problem:** Tenant isolation has been verified by hand against the live
    database. That is not repeatable.
  - **Outcome:** A test that proves isolation, runnable against a test
    database.
  - **Acceptance criteria:**
    - [ ] Two organizations' rows, read through the RLS path, with the
          expected visibility for each.
    - [ ] `anon` and `authenticated` write attempts are refused.
  - **Dependencies:** A test database. The Supabase local stack
    (`supabase start`) is the obvious one, and needs Docker.
  - **Effort:** M.

### 2.7 Organization isolation and database security

- [ ] **Give the answer cache an eviction policy**
  - **Status:** Planned
  - **Problem:** `ai_cache` grows without bound, and an answer can contain
    quoted source code.
  - **Outcome:** A retention rule.
  - **Acceptance criteria:**
    - [ ] A stated maximum age or size.
    - [ ] A scheduled job, or a rule applied on write.
    - [ ] The rule is in the security documentation.
  - **Dependencies:** None.
  - **Effort:** S.

- [ ] **Audit every table against the "least privilege" list**
  - **Status:** Planned
  - **Problem:** The grants are correct today. Nothing checks that they stay
    correct as migrations are added.
  - **Outcome:** A check that fails when a new table is added without a
    policy.
  - **Acceptance criteria:**
    - [ ] A test asserting every public table has RLS on and at least one
          policy.
    - [ ] A test asserting no table grants anything to `anon`.
  - **Dependencies:** The isolation test.
  - **Effort:** S.

- [ ] **Clear the browser's session store on sign-out**
  - **Status:** Planned
  - **Problem:** `sessionStorage` holds fetched explanations and is not
    cleared when the person signs out. On a shared machine the next person to
    use the tab could read them.
  - **Outcome:** Signing out clears the store.
  - **Acceptance criteria:**
    - [ ] The store is cleared on sign-out.
    - [ ] It is covered by the security checklist.
  - **Dependencies:** None.
  - **Effort:** S.

### 2.8 AI caching, observability and error handling

- [ ] **Make the answer cache invalidatable by repository head**
  - **Status:** Planned
  - **Problem:** The cache key is the question, not the repository's state. A
    repository that moved can have a stale answer served.
  - **Outcome:** A key that includes what the answer depends on.
  - **Acceptance criteria:**
    - [ ] A change to the file or its neighbours produces a different key.
    - [ ] An unchanged file keeps its cached answer.
  - **Dependencies:** None.
  - **Effort:** M.

- [ ] **Report the provider's failure modes distinctly**
  - **Status:** Planned
  - **Problem:** A rate limit, an authentication failure and a malformed
    response all arrive as one error message.
  - **Outcome:** The pane says which it was.
  - **Acceptance criteria:**
    - [ ] Rate limiting, authentication failure, and an empty answer are
          distinguished.
  - **Dependencies:** None.
  - **Effort:** S.

- [ ] **Show which answer came from the cache and which did not, in the
      tracing dashboard as well as the pane**
  - **Status:** Done
  - **Problem:** — none outstanding.
  - **Outcome:** The cache read is inside the traced call, so a hit is a
    recorded run with no model call under it. A broken cache is visible as a
    trace full of calls.
  - **Acceptance criteria:**
    - [x] The cache read is the first thing inside the traced function.
    - [x] The pane reports `cached` and the model.
    - [x] Covered by `scripts/test-provider.ts`.
  - **Dependencies:** None.
  - **Effort:** Done.

### 2.9 Documentation and setup reproducibility

- [ ] **Add a LICENSE**
  - **Status:** Planned
  - **Problem:** The repository is not licensed for reuse.
  - **Outcome:** A license, and a `license` field in `package.json`.
  - **Acceptance criteria:**
    - [ ] A `LICENSE` file at the root.
    - [ ] `package.json` carries the matching `license` field.
    - [ ] The README's License section says what it is.
  - **Dependencies:** A decision about which license.
  - **Effort:** S.

- [ ] **Verify the setup instructions on a clean machine**
  - **Status:** Planned
  - **Problem:** The instructions in this documentation have been followed on
    one machine, by one person, with the services already configured.
  - **Outcome:** A second person follows them from nothing and gets a working
    app.
  - **Acceptance criteria:**
    - [ ] Someone who has not set it up before follows
          [docs/development.md](docs/development.md) and reaches a working map.
    - [ ] Every step that needed correction is corrected.
  - **Dependencies:** A second machine, or a clean container.
  - **Effort:** M.

- [ ] **Keep the documentation in step with the code**
  - **Status:** In progress
  - **Problem:** Documentation drifts. This set was written against a specific
    revision.
  - **Outcome:** A check that the documentation's claims still hold.
  - **Acceptance criteria:**
    - [ ] A checklist in [CONTRIBUTING.md](CONTRIBUTING.md) for updating the
          documentation with a feature.
    - [ ] The constants quoted in the documentation are checked against the
          code, in a test.
  - **Dependencies:** None.
  - **Effort:** S.

---

## 3. High-priority features

### 3.1 [P0] Repository-wide AI question answering

- [ ] **[P0] Repository-wide Q&A — source-grounded retrieval**
  - **Status:** Planned
  - **Problem:** Developers cannot trace behaviour across multiple files. The
    map answers "what is connected to this"; the missing capability is "what
    is the story across these".
  - **Outcome:** A question interface over a whole analysis. Answers cite real
    source locations, explain only relationships the stored graph contains, and
    say so when the evidence is insufficient.
  - **Acceptance criteria:**
    - [ ] Retrieve relevant files for a cross-file question.
    - [ ] Include file and line-range citations.
    - [ ] Open citations in the map.
    - [ ] Highlight the cited files and the edges between them on the canvas.
    - [ ] Support conversational follow-up questions.
    - [ ] Return an uncertainty response when the evidence is insufficient.
    - [ ] Pass a curated set of correctness and citation tests.
  - **Dependencies:** Symbol search (3.4), text retrieval over stored files
    (3.5), and the citation format in the renderer (3.6).
  - **Effort:** XL.
  - **Design:** [docs/ai-system.md](docs/ai-system.md#9-proposed-repository-wide-question-answering).

- [x] **[P0] Verify every citation against the stored analysis**
  - **Status:** Done
  - **Problem:** Nothing checks that an answer does not name a file that does
    not exist. The prompt forbids it; the renderer degrades gracefully; nothing
    verifies it. This is the failure the whole product exists to prevent.
  - **Outcome:** An answer that names a file that is not in the analysis is
    treated as a failure, not shown.
  - **Acceptance criteria:**
    - [x] Every path-shaped token in an answer is tested against the set of
          paths the model was shown.
    - [x] A failure is caught by a test with a made-up filename spliced in.
    - [x] The check runs as a live evaluator, not only against a saved
          dataset.
  - **Dependencies:** None. This can be built before the Q&A feature and will
    protect the explanations that already exist.
  - **Effort:** Done.

- [ ] **[P0] Ask the model to classify files only when convention has not**
  - **Status:** Done
  - **Problem:** A file's role decides what is routable, and that must not come
    from a model.
  - **Outcome:** Convention owns the routable roles; the model labels only
    what convention left blank, and the answer is checked.
  - **Acceptance criteria:**
    - [x] Seven model roles, none of them routable.
    - [x] A role outside the list is refused and never cached.
    - [x] The classification is stored with `source = 'model'`, so a later
          convention role is never overwritten and a model role is never
          mistaken for one.
  - **Dependencies:** None.
  - **Effort:** Done.

### 3.2 [P0] Parser reliability and coverage

- [ ] **[P0] Parser reliability — fixtures, regressions, accuracy**
  - **Status:** Planned
  - **Problem:** There is no regression suite and no accuracy measurement for
    the component the whole product rests on.
  - **Outcome:** Changes to the resolver are caught by a test, and the
    extraction accuracy is a number.
  - **Acceptance criteria:**
    - [ ] Report parsed, skipped and unsupported files separately, with the
          reason for each.
    - [ ] Track resolved and unresolved dependencies by reason.
    - [ ] Explain parsing failures and unsupported constructs in the product,
          not only in the raw report.
    - [ ] Build fixture repositories and regression tests over them.
    - [ ] Measure dependency-extraction accuracy against hand-counted ground
          truth.
    - [ ] Define the supported-language boundary in one place, and use it
          everywhere.
  - **Dependencies:** None. This is the first thing to build.
  - **Effort:** L. Detailed in section 2.2.

### 3.3 [P1] Change impact analysis

- [ ] **[P1] Change impact analysis beyond a fixed depth**
  - **Status:** Planned
  - **Problem:** The blast radius stops at two steps and lists nothing beyond
    it. For a change to a widely-imported file, two steps is not the answer.
  - **Outcome:** The impact of a change is shown at a depth the person chooses,
    with the full set available.
  - **Acceptance criteria:**
    - [ ] Identify direct and transitive dependants at a chosen depth.
    - [ ] Visualise the dependency paths, not just the set.
    - [ ] Explain the potential impact in prose, grounded in the graph.
    - [ ] Identify highly connected modules and circular dependencies
          separately.
    - [ ] Test the results against known dependency graphs.
  - **Dependencies:** The fixture corpus, for the tests.
  - **Effort:** L.

### 3.4 [P0] Source-content storage

Everything is designed in [docs/architecture/file-content-storage.md](docs/architecture/file-content-storage.md) and decided in [docs/architecture/decisions/0001-source-content-storage.md](docs/architecture/decisions/0001-source-content-storage.md). Nothing here is implemented.

- [ ] **[P0] The `file_contents` table and the content store**
  - **Status:** Planned
  - **Problem:** The database holds a file's hash and never its contents, so nothing downstream can read code, and the answer path borrows source from GitHub.
  - **Outcome:** Content-addressed, immutable, deduplicated storage inside Supabase, behind a module boundary.
  - **Acceptance criteria:**
    - [ ] A migration adds `file_contents (organization_id, content_hash, payload bytea, size, created_at)`, PK-ied by org+hash, RLS'd, and `files.content_status` (`absent` | `stored`).
    - [ ] `lib/content` implements `putContents` (chunked, idempotent `ON CONFLICT DO NOTHING`), `getContent`, `existsContent`, `deleteOrphaned`; members have no write grant.
    - [ ] The payload of every file in `ParseResult.files` is stored; nothing the parser skipped (declaration, binary, too-large, unreadable, syntax-error) ever is.
    - [ ] The module boundary is spec'd so an object-storage backend can be swapped in — the ADR names it as the deferred decision it is.
  - **Dependencies:** None. This is the first thing to build.
  - **Effort:** M.

- [ ] **[P0] The pipeline writes content during indexing**
  - **Status:** Planned
  - **Problem:** Contents currently die at the `finally { rm(workdir) }` (`lib/pipeline/run.ts`); the store phase is the last place they exist.
  - **Outcome:** A run's parsed files have content in the same pass, without breaking the 5-minute stage budget.
  - **Acceptance criteria:**
    - [ ] `storeResult` writes content chunks before (or with) the `files` chunk that references them, reusing the existing chunking discipline.
    - [ ] A re-run of an unchanged repository writes near-zero new content rows (dedup holds).
    - [ ] The pipeline is measured on a 10k-file fixture repository against the 5-minute budget.
  - **Dependencies:** The table and store.
  - **Effort:** S.

- [ ] **[P0] The read side: `getFileContent` / `getFileLines`**
  - **Status:** Planned
  - **Problem:** Citations promise line precision; nothing can show a line without the network.
  - **Outcome:** A read API that answers by file id, with 1-based line ranges that match the parser's recorded line numbers exactly.
  - **Acceptance criteria:**
    - [ ] `lib/content/read.ts` exposes `getFileContent(fileId)` and `getFileLines(fileId, start, end)`, both returning a typed `null` for `content_status = 'absent'`.
    - [ ] A read of a file's lines agrees with the `line` the parser recorded for its routes, edges and symbols (proved by a test reading a fixture back).
    - [ ] Lazy backfill: a read that finds an absent payload for a hash-known file goes through the hash-verified `fetchFileAt` path and stores it, per the migration section — no separate backfill needed.
  - **Dependencies:** The store; the pipeline write for any new analysis.
  - **Effort:** M.

- [ ] **[P1] A bounded process cache on the answer path**
  - **Status:** Planned
  - **Problem:** Every retrieval reaching the DB is one more round trip on latency-critical answer time; unbounded caching is not allowed.
  - **Outcome:** LRU keyed `(fileId, hash)`, 32 MB budget, max entry = the parser's 1 MB limit.
  - **Acceptance criteria:**
    - [ ] The key includes the content hash, so a re-index invalidates by missing, not by purging.
    - [ ] Metrics record hits, misses and budget-highwater; a test proves the budget is never exceeded.
    - [ ] Reads that miss fall through to the store; the store remains the only authority.
  - **Dependencies:** The read side.
  - **Effort:** S.

- [ ] **[P1] Garbage collection of orphaned content**
  - **Status:** Planned
  - **Problem:** Content rows outlive the files rows that referenced them (write-before-reference, crashed runs).
  - **Outcome:** Orphans collected on a schedule; no leak.
  - **Acceptance criteria:**
    - [ ] A job deletes content rows with zero referencing `files` rows, at a 24 h cadence.
    - [ ] A test exercises: write content → delete referencing files → GC collects exactly that row.
    - [ ] GC never deletes a row a live run could still reference (write-before-reference means a 24 h grace is inherently safe, and the test proves it).
  - **Dependencies:** The store and the pipeline write.
  - **Effort:** S.

- [ ] **[P1] Benchmarks before any production reliance**
  - **Status:** Planned
  - **Problem:** §10 of the design document is estimates, not measurements.
  - **Outcome:** The five named benchmarks have numbers, and the design's compression and latency claims are either confirmed or the policy revisited.
  - **Acceptance criteria:**
    - [ ] Index-time content write throughput on a real 10k-file repository.
    - [ ] p95 `getFileLines`, hot and cold cache, for a ~100 KB and a ~1 MB file.
    - [ ] Measured TOAST/`pglz` compression ratio on a real corpus, to confirm (or revise) the estimate of ~2.5–3×.
    - [ ] DB size after N re-runs of the same repository (dedup + GC keeps it bounded).
    - [ ] A concurrent re-index + read mix, to validate immutability's claimed lack of contention.
  - **Dependencies:** The store; a repository of at least 10k files.
  - **Effort:** M.

- [ ] **[P2] Citations bound to content hashes**
  - **Status:** Planned
  - **Problem:** A re-index that changes a file's hash can leave a served answer describing code that is no longer on the map — detected only by manual inspection today.
  - **Outcome:** Answers carry `(fileId, content_hash)` bindings; stale bindings are refused, never abbreviated silently.
  - **Acceptance criteria:**
    - [ ] A citation binding names a hash the current analysis does not record → the answer is refused, per the existing refusal-and-never-cache rule for a hallucinated path.
    - [ ] Coverage: the citation tester gains a fixture where the answer is grounded at commit N and judged at commit N+1.
  - **Dependencies:** The read side and the existing verifier.
  - **Effort:** M.

- [ ] **[P2] Full-text search over stored contents**
  - **Status:** Planned
  - **Problem:** Search is path- and symbol-name-only today, because there is nothing to search.
  - **Outcome:** Content-aware retrieval for Q&A, over the stored payloads.
  - **Acceptance criteria:**
    - [ ] The repository-wide search explores at least (a clause-level) instructions, and the indexes it needs exist.
    - [ ] A retrieval-quality measure is defined at the same time the index lands, or the feature defers one more time explicitly.
  - **Dependencies:** The read side; Q&A retrieval task 7 "Measure retrieval quality".
  - **Effort:** L.

---

## 4. Multi-language and framework support

### 4.1 The intermediate representation — do this first

- [ ] **[P0] Define a language-neutral intermediate representation**
  - **Status:** Planned
  - **Problem:** Every part of the system currently assumes TypeScript.
    `ParsedFile` has no language field, the resolver is TypeScript's, the
    extractor is ts-morph's, and the adapters read TypeScript syntax.
  - **Outcome:** A representation that the graph engine, the AI layer and the
    adapters can consume without knowing which language produced it.
  - **Acceptance criteria:**
    - [ ] Common entities defined for files, modules, symbols, imports,
          exports and unresolved references.
    - [ ] The existing TypeScript parser produces it, unchanged in behaviour.
    - [ ] The graph engine consumes it with no change to its results.
    - [ ] The AI layer's context builder consumes it with no change to its
          prompts.
    - [ ] A second language can be added without changing the graph engine.
  - **Acceptance criteria:**
    - [ ] A document describing the entities and their relationships.
    - [ ] The three above.
  - **Dependencies:** None. **This is the prerequisite for every language
    below.**
  - **Effort:** XL.

### 4.2 Languages

Each language needs the same six things. None of them is done.

| Language | Parser | Import resolution | Symbol extraction | Graph integration | Fixtures | Documentation | Known limitations |
|---|---|---|---|---|---|---|---|
| **TypeScript / JavaScript** | Done (ts-morph) | Done | Done: definitions with kind, line and exported | Done | **Planned** | Done | No call graph |
| **Python** | Not started | Not started | Not started | Not started | Not started | Not started | Module vs package resolution, `__init__` semantics, dynamic imports |
| **Go** | Not started | Not started | Not started | Not started | Not started | Not started | Module paths, build tags, vendored code |
| **Java** | Not started | Not started | Not started | Not started | Not started | Not started | Package structure, `package-info`, annotation processors |
| **Rust** | Not started | Not started | Not started | Not started | Not started | Not started | `mod`/`use` resolution, the crate graph, macros |

For each language, the work is:

- [ ] **A parser** producing the intermediate representation.
- [ ] **A resolver** with its own reasons, so an unresolved import in that
      language is distinguishable from one in TypeScript.
- [ ] **Symbol extraction** — the definitions, not only the exports.
- [ ] **Graph integration** — the edges land in the same graph, with the same
      guarantees.
- [ ] **Fixtures**, and a test that runs the whole pipeline over them.
- [ ] **Documentation** of what is and is not supported.
- [ ] **Stated limitations.**

- [ ] **Do not promise support for a language until the fixtures demonstrate
      it**
  - **Status:** Planned
  - **Problem:** A language announced but not finished is worse than a language
    not mentioned.
  - **Outcome:** Every language claim in the README and the documentation
    matches what the fixtures show.
  - **Acceptance criteria:**
    - [ ] No language appears in the README without a fixture corpus.
  - **Dependencies:** The intermediate representation.
  - **Effort:** S (the rule).

### 4.3 Frameworks

A framework adapter is six methods. Existing adapters are the best guide.

| Framework | Detected by | Roles | Routes | Status |
|---|---|---|---|---|
| **Next.js** | `next` | Yes | App Router handlers only | Implemented |
| **NestJS** | `@nestjs/core` | Yes | Controller and method decorators | Implemented |
| **Express** | `express` | Yes, folder-based | Never — always withheld | Implemented |
| **Docusaurus** | `@docusaurus/core` | Yes | None | Implemented |
| **React** | `react` | Component, hook | None | Implemented |
| **Django** | `django` in requirements | URL patterns, views, models | From `urls.py` | Not started |
| **FastAPI** | `fastapi` | Routers, endpoints | Decorator paths and methods | Not started |
| **Gin** | `github.com/gin-gonic/gin` | Handlers, middleware | Group and route paths | Not started |
| **Spring Boot** | `spring-boot` | Controllers, services, repositories | `@RequestMapping` and `@GetMapping` | Not started |

- [ ] **Django adapter**
  - **Status:** Planned
  - **Problem:** A Django repository is mapped as an ordinary Python project,
    with no roles and no routes.
  - **Outcome:** URL patterns are recovered, and views, models and templates are
    identified.
  - **Acceptance criteria:**
    - [ ] `urls.py` patterns become routes.
    - [ ] Views, models, forms and templates get roles.
    - [ ] A path that cannot be recovered exactly is withheld with a reason,
          as the other adapters do.
  - **Dependencies:** The Python parser.
  - **Effort:** L.

- [ ] **FastAPI adapter**
  - **Status:** Planned
  - **Problem:** As above.
  - **Outcome:** Decorator paths and methods become routes.
  - **Acceptance criteria:**
    - [ ] `@app.get("/path")` and `@router.post("/path")` become routes.
    - [ ] A dynamic path parameter is preserved.
    - [ ] A prefix that is computed at runtime is withheld with a reason.
  - **Dependencies:** The Python parser.
  - **Effort:** M.

- [ ] **Gin adapter**
  - **Status:** Planned
  - **Problem:** As above.
  - **Outcome:** Group and route paths become routes.
  - **Acceptance criteria:**
    - [ ] `r.GET("/path", handler)` becomes a route.
    - [ ] A group prefix is applied.
  - **Dependencies:** The Go parser.
  - **Effort:** M.

- [ ] **Spring Boot adapter**
  - **Status:** Planned
  - **Problem:** As above.
  - **Outcome:** `@RequestMapping` and `@GetMapping` become routes.
  - **Acceptance criteria:**
    - [ ] A class-level and a method-level mapping compose into a path.
    - [ ] A class-level prefix that is computed is withheld with a reason.
  - **Dependencies:** The Java parser.
  - **Effort:** L.

---

## 5. Developer experience

- [ ] **[P1] Symbol and full-text code search**
  - **Status:** In progress — path and symbol search are done; the storage
    design that unblocks full text is decided
    ([docs/architecture/file-content-storage.md](docs/architecture/file-content-storage.md),
    tasks in §3.4), and the implementation is still to come: the database
    holds a file's hash, never its contents.
  - **Problem:** There is no way to search. Finding a file means finding it on
    the map, which means knowing where it is.
  - **Outcome:** A search over the analysis that finds files, symbols and
    lines.
  - **Acceptance criteria:**
    - [x] Search by file path.
    - [x] Search by symbol name, once symbol extraction exists.
    - [ ] Search by full text within a file.
    - [x] A result opens the file on the map and selects it.
  - **Dependencies:** Symbol extraction (4.1) — met; text search over stored
    files — unmet, the contents are not stored.
  - **Effort:** L.

- [ ] **[P1] Group the category rail by role, not by extension**
  - **Status:** Planned
  - **Problem:** The rail groups by a file's *kind* — its extension. The role
    taxonomy exists in the data and is far more useful: page routes,
    components, hooks, services.
  - **Outcome:** The rail groups by role.
  - **Acceptance criteria:**
    - [ ] The rail shows the role taxonomy.
    - [ ] Filtering by role highlights the matching files.
    - [ ] A file with no role is in an explicit "unclassified" group.
  - **Dependencies:** None. The roles are already stored.
  - **Effort:** M.

- [ ] **[P2] Architecture summaries**
  - **Status:** Planned
  - **Problem:** A person opening an unfamiliar repository has to work out the
    shape themselves.
  - **Outcome:** A short, grounded summary of the repository's shape, derived
    from the graph.
  - **Acceptance criteria:**
    - [ ] The summary is derived from the graph, not from a model's
          impression.
    - [ ] Every claim is traceable to a file.
  - **Dependencies:** The Q&A feature (3.1).
  - **Effort:** M.

- [ ] **[P2] Search by API endpoint, function, class or module**
  - **Status:** Planned
  - **Problem:** As 5.1.
  - **Outcome:** A search that accepts a route, a symbol or a module name.
  - **Acceptance criteria:**
    - [ ] A route search finds the file that serves it.
    - [ ] A symbol search finds its definition.
  - **Dependencies:** Symbol extraction, and a route index.
  - **Effort:** M.

- [ ] **[P2] Better large-graph navigation**
  - **Status:** Planned
  - **Problem:** A panel shows fourteen rows. A large repository has many
    panels, and finding a file in one is a scroll.
  - **Outcome:** Filtering within a panel, and a way to jump.
  - **Acceptance criteria:**
    - [ ] A panel can be filtered by text.
    - [ ] The selection can be reached by keyboard.
  - **Dependencies:** None.
  - **Effort:** M.

- [ ] **[P2] Keyboard shortcuts**
  - **Status:** Planned
  - **Problem:** The map is a keyboard-unfriendly surface. Everything is
    clicked.
  - **Outcome:** The common actions are reachable from the keyboard.
  - **Acceptance criteria:**
    - [ ] Move the selection, open a group, explain, and go back are bound.
    - [ ] The bindings are discoverable in the product.
  - **Dependencies:** None.
  - **Effort:** M.

- [ ] **[P2] Automatic onboarding documentation**
  - **Status:** Planned
  - **Problem:** A new contributor has to learn the layering by reading it.
  - **Outcome:** A generated page describing the repository's own structure.
  - **Acceptance criteria:**
    - [ ] The page is generated from the analysis of the repository itself.
  - **Dependencies:** The Q&A feature (3.1).
  - **Effort:** M.

---

## 6. Repository evolution and advanced analysis

Everything in this section is **planned and not implemented**. It is labelled
as such deliberately: none of it exists.

- [ ] **[P2] Compare two Git commits**
  - **Status:** Planned
  - **Problem:** "What changed between these two commits" is answered by
    reading, not by the tool.
  - **Outcome:** Two commits, and the difference between their maps.
  - **Acceptance criteria:**
    - [ ] Both commits are parsed.
    - [ ] Added, removed and changed files are listed.
    - [ ] The graph difference is shown.
  - **Dependencies:** A way to fetch a specific commit's archive, which exists.
  - **Effort:** L.

- [ ] **[P2] Detect changed dependency edges**
  - **Status:** Planned
  - **Problem:** As above.
  - **Outcome:** The edges that appeared, disappeared or changed type.
  - **Acceptance criteria:**
    - [ ] An edge added between two commits is reported.
    - [ ] An edge that became type-only is reported as changed.
  - **Dependencies:** The commit comparison.
  - **Effort:** M.

- [ ] **[P2] Recalculate blast radius for a change set**
  - **Status:** Planned
  - **Problem:** The blast radius is for one file. A change touches several.
  - **Outcome:** The impact of a set of files, taken together.
  - **Acceptance criteria:**
    - [ ] Several files are selected.
    - [ ] The combined impact is reported.
  - **Dependencies:** The change impact analysis (3.3).
  - **Effort:** M.

- [ ] **[P3] Identify architectural regressions**
  - **Status:** Planned
  - **Problem:** Nothing tracks whether the shape of a codebase is getting
    worse.
  - **Outcome:** A comparison over time of the graph's shape.
  - **Acceptance criteria:**
    - [ ] Fan-in and fan-out distributions are comparable between two
          analyses.
    - [ ] A new cycle is reported.
  - **Dependencies:** The commit comparison.
  - **Effort:** L.

- [ ] **[P3] Call-graph analysis**
  - **Status:** Planned
  - **Problem:** The import graph is not the call graph. Which function calls
    which is not derivable from it.
  - **Outcome:** Function-level call relationships, where they can be
    recovered exactly.
  - **Acceptance criteria:**
    - [ ] A call relationship is recovered, or not.
    - [ ] A relationship that cannot be recovered exactly is not guessed.
    - [ ] Type-only and dynamic call sites are handled explicitly.
  - **Dependencies:** Symbol extraction (4.1), and a decision about how much
    of the truth is recoverable.
  - **Effort:** XL.

- [ ] **[P3] Identify circular dependencies and architectural hotspots**
  - **Status:** Partially done
  - **Problem:** Cycles are already found. Hotspots are not, and a cycle's
    severity is not expressed.
  - **Outcome:** A ranked list of the places the structure is worst.
  - **Acceptance criteria:**
    - [x] Cycles are found and reported, with the loop and its members.
    - [ ] Hotspots are ranked by a stated measure.
    - [ ] The measure is stated in the product, not only in the code.
  - **Dependencies:** None.
  - **Effort:** S.

- [ ] **[P2] Generate architecture reports**
  - **Status:** Planned
  - **Problem:** There is no way to take the shape of a repository away with
    you.
  - **Outcome:** A report a person can read or keep.
  - **Acceptance criteria:**
    - [ ] The report is generated from the stored analysis.
    - [ ] Every figure in it is traceable to the analysis.
  - **Dependencies:** None.
  - **Effort:** M.

- [ ] **[P2] Support additional repository formats and monorepo layouts**
  - **Status:** Planned
  - **Problem:** A monorepo with several projects is handled, but the
    relationships *between* projects are not shown, and a repository that is
    not a single package is not understood.
  - **Outcome:** Cross-project relationships are visible.
  - **Acceptance criteria:**
    - [ ] An import from one workspace package to another is shown as a
          cross-project edge.
    - [ ] A repository with no `package.json` is still mapped.
  - **Dependencies:** None.
  - **Effort:** M.

---

## 7. AI improvements

- [ ] **[P0] Repository-wide question answering**
  - **Status:** Planned
  - **Problem:** The largest missing capability. Detailed in 3.1.
  - **Outcome:** Questions answered across the repository, with citations.
  - **Acceptance criteria:**
    - [ ] As in 3.1.
  - **Dependencies:** Symbol search, text retrieval, citations.
  - **Effort:** XL.

- [x] **[P0] Verify source citations**
  - **Status:** Done
  - **Problem:** Nothing checks that an answer names only files that exist.
    Detailed in 3.1.
  - **Outcome:** An invented path is caught and the answer is refused.
  - **Acceptance criteria:**
    - [x] As in 3.1.
  - **Dependencies:** None.
  - **Effort:** Done.

- [ ] **[P1] Measure retrieval quality**
  - **Status:** Planned
  - **Problem:** There is no retrieval, so there is nothing to measure yet.
  - **Outcome:** A measurement, and a way to tell whether a change helped.
  - **Acceptance criteria:**
    - [ ] A curated set of questions with the files that should be retrieved.
    - [ ] Recall reported over the set.
  - **Dependencies:** The Q&A feature.
  - **Effort:** M.

- [ ] **[P1] Context selection and token-budget optimisation**
  - **Status:** Planned
  - **Problem:** The context is currently the file plus all of its neighbours.
    That is a lot of source for a short answer.
  - **Outcome:** A context that is sufficient and smaller.
  - **Acceptance criteria:**
    - [ ] The token use of an explanation is reported.
    - [ ] A selection strategy that reduces it without changing the answers
          materially.
  - **Dependencies:** The Q&A feature.
  - **Effort:** M.

- [ ] **[P1] Prompt-injection defences for untrusted repository content**
  - **Status:** Planned
  - **Problem:** Repository source is untrusted text in a prompt. A file
    containing instructions addressed to the model could influence the answer.
  - **Outcome:** Source content cannot instruct the model.
  - **Acceptance criteria:**
    - [ ] The source is delimited unambiguously and explicitly marked as data.
    - [ ] A fixture containing an injection attempt produces an answer that
          does not follow it.
    - [ ] The answer still names no file it was not given.
  - **Dependencies:** None. It applies to the existing explanations.
  - **Effort:** M.

- [ ] **[P1] Answer caching and invalidation**
  - **Status:** Planned
  - **Problem:** The cache key is the question. A repository that moved can
    have a stale answer served.
  - **Outcome:** A cache that knows when its answer is out of date.
  - **Acceptance criteria:**
    - [ ] A change to the file or its neighbours produces a different key.
    - [ ] An unchanged file keeps its answer.
    - [ ] A retention rule for the cache.
  - **Dependencies:** None.
  - **Effort:** M.

- [ ] **[P2] Model and provider configuration**
  - **Status:** Partially done
  - **Problem:** The provider, the key and the model names are environment
    variables, which is enough to run and not enough to compare.
  - **Outcome:** More than one model can be configured, and the answer states
    which model wrote it.
  - **Acceptance criteria:**
    - [x] The provider, the key and both model names are configurable.
    - [x] The model that wrote an answer is shown.
    - [ ] Two prompt versions can be run over the same data and compared.
  - **Dependencies:** None.
  - **Effort:** S.

- [ ] **[P2] Usage and cost visibility**
  - **Status:** Planned
  - **Problem:** Nobody can see what the AI is costing.
  - **Outcome:** Token use and a cost estimate, per organization and per task.
  - **Acceptance criteria:**
    - [ ] Token counts are stored with the answer.
    - [ ] A per-organization total is visible to its members.
  - **Dependencies:** None.
  - **Effort:** M.

- [ ] **[P1] Evaluate answers against a curated question set**
  - **Status:** Planned
  - **Problem:** There is no way to tell whether a change to a prompt made
    answers better or worse.
  - **Outcome:** A repeatable evaluation.
  - **Acceptance criteria:**
    - [ ] A curated set of files with questions whose answers can be judged.
    - [ ] The judgement is explicit about being a model judgement.
    - [ ] Two prompt versions scored side by side.
  - **Dependencies:** The fixture corpus.
  - **Effort:** L.

- [ ] **Do not add autonomous code modification or multi-agent orchestration**
  - **Status:** Deferred
  - **Problem:** — none. This is a decision, recorded so it is not revisited
    by default.
  - **Outcome:** Neither is built without a demonstrated user need.
  - **Acceptance criteria:**
    - [ ] A proposal is evaluated against a real need, not against novelty.
    - [ ] The product rule holds: the model may not decide that two files are
          connected, and may not walk the graph.
  - **Dependencies:** None.
  - **Effort:** S.

---

## 8. Security, reliability and performance

- [ ] **[P0] Tenant-isolation tests**
  - **Status:** Planned
  - **Problem:** Isolation has been verified by hand, against the live
    database. It is not repeatable, and a migration could break it silently.
  - **Outcome:** A test that fails when isolation breaks.
  - **Acceptance criteria:**
    - [ ] Two organizations' rows, read through the RLS path, with the
          expected visibility for each.
    - [ ] `anon` and `authenticated` write attempts are refused.
    - [ ] The realtime channel refuses a subscriber from another organization.
  - **Dependencies:** A test database.
  - **Effort:** M.

- [ ] **[P1] Repository access controls**
  - **Status:** Planned
  - **Problem:** A user can submit any public repository, including one they
    have no connection to, and its map is stored in their organization.
  - **Outcome:** A decision about what should be analysable, and an
    implementation if the answer is not "anything public".
  - **Acceptance criteria:**
    - [ ] The decision is recorded in the security documentation.
    - [ ] If there is a restriction, it is implemented and tested.
  - **Dependencies:** None.
  - **Effort:** S to M.

- [ ] **[P1] Secure handling of secrets and private source code**
  - **Status:** Partially done
  - **Problem:** No secret is tracked, and the pipeline is unauthenticated, so
    no private code is fetched. But the answer cache holds model output that
    can quote source, and the browser's session store holds answers.
  - **Outcome:** The whole of it is covered.
  - **Acceptance criteria:**
    - [x] No credential-shaped string in any tracked file.
    - [x] `.env.local` is gitignored.
    - [x] The Supabase secret key is not in the client bundle.
    - [ ] The browser's session store is cleared on sign-out.
    - [ ] The answer cache has a retention rule.
  - **Dependencies:** None.
  - **Effort:** S.

- [ ] **[P1] AI prompt-injection protections**
  - **Status:** Planned
  - **Problem:** Detailed in section 7.
  - **Outcome:** Detailed in section 7.
  - **Acceptance criteria:**
    - [ ] As in section 7.
  - **Dependencies:** None.
  - **Effort:** M.

- [ ] **[P1] Cache isolation and invalidation**
  - **Status:** Partially done
  - **Problem:** The cache is isolated by the policy. It is not invalidated
    when the repository moves, and it never evicts.
  - **Outcome:** As in section 7.
  - **Acceptance criteria:**
    - [x] The cache is scoped to the organization by a policy.
    - [x] The cache key includes the model and the prompt version.
    - [ ] The key includes the repository's state.
    - [ ] There is a retention rule.
  - **Dependencies:** None.
  - **Effort:** M.

- [ ] **[P1] Large-repository benchmarks**
  - **Status:** Planned
  - **Problem:** No number exists for how the system behaves on a large
    repository.
  - **Outcome:** Published numbers, and limits derived from them.
  - **Acceptance criteria:**
    - [ ] Parse, store, read-back and render times for at least three
          repository sizes.
    - [ ] A stated limit at which the tool should refuse rather than try.
  - **Dependencies:** None.
  - **Effort:** M.

- [ ] **[P1] Parser timeouts and resource limits**
  - **Status:** Partially done
  - **Problem:** The archive is bounded and timed. The parse itself is not
    timed, and a pathological file can take a long time.
  - **Outcome:** The parse is bounded, and a timeout is reported as a
    timeout.
  - **Acceptance criteria:**
    - [x] The archive download is bounded at 100 MB and five minutes.
    - [x] A file is bounded at 1 MB.
    - [ ] The parse has a time budget, and exceeding it fails the run with a
          stated reason.
  - **Dependencies:** None.
  - **Effort:** M.

- [ ] **[P2] Database query performance**
  - **Status:** Planned
  - **Problem:** The read-back pages through PostgREST 1000 rows at a time,
    and the coverage jsonb can be large. Neither has been measured.
  - **Outcome:** The read path is fast enough, and the indexes are right.
  - **Acceptance criteria:**
    - [ ] Read-back time measured on the largest analysis.
    - [ ] Every index justified by a query plan.
  - **Dependencies:** The large-repository benchmark.
  - **Effort:** M.

- [ ] **[P1] Graceful handling of an unavailable AI provider**
  - **Status:** Partially done
  - **Problem:** An error is surfaced, but the pane's other content does not
    say what is unavailable.
  - **Outcome:** The pane distinguishes "the provider is down" from "the
    question could not be answered".
  - **Acceptance criteria:**
    - [x] An error is returned and shown.
    - [ ] The provider's failure mode is named.
  - **Dependencies:** None.
  - **Effort:** S.

- [ ] **[P2] Error reporting and observability**
  - **Status:** Partially done
  - **Problem:** Failures are recorded per run, but there is no aggregate view
    and no alerting.
  - **Outcome:** An operator can see that runs are failing.
  - **Acceptance criteria:**
    - [x] A failed run records its stage and reason.
    - [ ] An aggregate view of failure rates by stage.
  - **Dependencies:** None.
  - **Effort:** M.

---

## 9. Final-year project deliverables

Each of these is a deliverable for the project, not a feature of the software.
None is started.

- [ ] **Problem statement and motivation**
  - **Status:** Planned
  - **Acceptance criteria:**
    - [ ] One paragraph, naming the problem and who has it.
    - [ ] Backed by the reasoning in [docs/project-doc.md](docs/project-doc.md).
  - **Effort:** S.

- [ ] **Objectives and scope**
  - **Status:** Planned
  - **Acceptance criteria:**
    - [ ] What is in scope, and what is deliberately out, with the reason for
          each exclusion.
  - **Effort:** S.

- [ ] **Literature review and related-work comparison**
  - **Status:** Planned
  - **Problem:** Nothing has been written about the existing work. The product
    document names the field's history — CodeSee, SourceTrail — and that is the
    starting point.
  - **Acceptance criteria:**
    - [ ] Existing tools compared on: language coverage, evidence of edges,
          whether a model can invent structure, and whether tenant isolation is
          a policy.
    - [ ] Anatomy's position stated against each.
  - **Effort:** L.

- [ ] **Requirements and use cases**
  - **Status:** Planned
  - **Acceptance criteria:**
    - [ ] Functional and non-functional requirements.
    - [ ] Use cases, each traced to a feature in
          [docs/features.md](docs/features.md).
  - **Effort:** M.

- [ ] **System architecture diagrams**
  - **Status:** Planned
  - **Problem:** Diagrams exist in [docs/architecture.md](docs/architecture.md),
    but they were written to document the code rather than to present the
    design.
  - **Acceptance criteria:**
    - [ ] A context diagram, a component diagram and a data model.
    - [ ] Each is captioned with what it is for.
  - **Dependencies:** The architecture document, as a starting point.
  - **Effort:** M.

- [ ] **Algorithms and design decisions**
  - **Status:** Planned
  - **Acceptance criteria:**
    - [ ] The folding threshold, the blast-radius depth, the cycle detection
          and the import resolution each explained, with the alternative
          rejected and why.
  - **Effort:** M.

- [ ] **Testing strategy and results**
  - **Status:** Planned
  - **Acceptance criteria:**
    - [ ] The strategy written down: what is tested, how, and what is not
          tested and why.
    - [ ] The results, as they are.
  - **Dependencies:** The fixture corpus.
  - **Effort:** M.

- [ ] **Parser accuracy evaluation**
  - **Status:** Planned
  - **Problem:** Detailed in section 2.2.
  - **Acceptance criteria:**
    - [ ] As in section 2.2.
  - **Dependencies:** The fixture corpus.
  - **Effort:** M.

- [ ] **AI retrieval and citation evaluation**
  - **Status:** Planned
  - **Problem:** Detailed in section 7.
  - **Acceptance criteria:**
    - [ ] As in section 7.
  - **Dependencies:** The Q&A feature.
  - **Effort:** L.

- [ ] **Performance evaluation**
  - **Status:** Planned
  - **Problem:** Detailed in section 8.
  - **Acceptance criteria:**
    - [ ] As in section 8.
  - **Effort:** M.

- [ ] **Limitations and future scope**
  - **Status:** Planned
  - **Acceptance criteria:**
    - [ ] The limitations, as they are.
  - **Dependencies:** Everything else.
  - **Effort:** S.

- [ ] **Final report and presentation**
  - **Status:** Planned
  - **Acceptance criteria:**
    - [ ] Both written, using the material above.
  - **Dependencies:** Everything above.
  - **Effort:** L.

- [ ] **Demonstration script and recorded demo**
  - **Status:** Planned
  - **Problem:** There is no recording, and the evaluation criteria name one.
  - **Acceptance criteria:**
    - [ ] A script that shows: submitting a repository, watching the progress,
          reading the map, selecting a file, reading the blast radius, and
          asking for an explanation.
    - [ ] A recording of it, on a repository the audience recognises.
  - **Dependencies:** A model provider key that works reliably.
  - **Effort:** M.

- [ ] **Installation instructions for evaluators**
  - **Status:** Planned
  - **Problem:** The instructions exist, but nobody has followed them from
    nothing.
  - **Acceptance criteria:**
    - [ ] A single page an evaluator can follow, with every credential
          explained.
    - [ ] Verified on a clean machine.
  - **Dependencies:** Section 2.9.
  - **Effort:** M.

---

## 10. Recruiter-ready release

- [ ] **A stable demo deployment**
  - **Status:** Planned
  - **Problem:** There is no hosted instance. Everything has been run locally.
  - **Outcome:** A URL an evaluator can open without setting anything up.
  - **Acceptance criteria:**
    - [ ] The application is deployed and reachable.
    - [ ] The database is migrated and seeded with a demonstration analysis.
    - [ ] The deployment is documented.
  - **Dependencies:** A hosting decision, and a model provider key.
  - **Effort:** M.

- [ ] **Clear project screenshots**
  - **Status:** Planned
  - **Problem:** There are no images. The README describes the product in
    words, which is the fallback, not the goal.
  - **Outcome:** Images that show the map, the detail pane, the route table and
    an explanation.
  - **Acceptance criteria:**
    - [ ] At least four screenshots, taken from a real analysis.
    - [ ] Each has a caption saying what it shows.
    - [ ] No fabricated screenshots.
  - **Dependencies:** A demo deployment.
  - **Effort:** S.

- [ ] **An accurate README**
  - **Status:** Done
  - **Problem:** — none outstanding.
  - **Outcome:** The README describes what the product does, what it does not
    do, and how to run it, without a fabricated claim in it.
  - **Acceptance criteria:**
    - [x] Every claim is checkable against the source.
    - [x] Implemented features and planned features are distinguished.
    - [x] No screenshot, badge, benchmark or deployment link is fabricated.
    - [x] The limitations are stated.
  - **Dependencies:** None.
  - **Effort:** Done.

- [ ] **A short demonstration video**
  - **Status:** Planned
  - **Problem:** As in section 9.
  - **Acceptance criteria:**
    - [ ] Three to five minutes, showing the product doing the thing.
    - [ ] Recorded from a real deployment.
  - **Dependencies:** The demo deployment.
  - **Effort:** M.

- [ ] **Example repository or guided demo data**
  - **Status:** Planned
  - **Problem:** An evaluator needs something to map, and it should be small
    enough to understand and large enough to be interesting.
  - **Outcome:** A prepared analysis, or a repository chosen for the demo.
  - **Acceptance criteria:**
    - [ ] A repository with a recognisable structure, analysed and seeded.
    - [ ] A short note on what the demo shows about it.
  - **Dependencies:** The demo deployment.
  - **Effort:** S.

- [ ] **Architecture documentation**
  - **Status:** Done
  - **Problem:** — none outstanding.
  - **Outcome:** [docs/architecture.md](docs/architecture.md) describes the
    components, the data flow, the parser, the graph engine, the AI lifecycle
    and the deployment trade-offs, with diagrams.
  - **Acceptance criteria:**
    - [x] Every component is described.
    - [x] The data flow is diagrammed.
    - [x] The trade-offs are stated with their costs.
  - **Dependencies:** None.
  - **Effort:** Done.

- [ ] **Reproducible setup**
  - **Status:** Planned
  - **Problem:** Detailed in section 2.9.
  - **Outcome:** A second person can get it running.
  - **Acceptance criteria:**
    - [ ] As in section 2.9.
  - **Dependencies:** None.
  - **Effort:** M.

- [ ] **Verified test and evaluation results**
  - **Status:** Planned
  - **Problem:** The results do not exist yet.
  - **Outcome:** Results an evaluator can check.
  - **Acceptance criteria:**
    - [ ] The parser accuracy evaluation.
    - [ ] The performance evaluation.
    - [ ] The test suites' output, as it is.
  - **Dependencies:** The fixture corpus, the benchmark, the Q&A feature.
  - **Effort:** L.

- [ ] **Known limitations and security notes**
  - **Status:** Done
  - **Problem:** — none outstanding.
  - **Outcome:** [docs/security.md](docs/security.md) lists the trust
    boundaries, what is stored, where data goes, and nine known limitations.
  - **Acceptance criteria:**
    - [x] The trust boundaries are described.
    - [x] The data flow to third parties is described.
    - [x] The known limitations are listed, not smoothed over.
    - [x] A verification checklist is included.
  - **Dependencies:** None.
  - **Effort:** Done.

- [ ] **Meaningful Git history and a clean public repository**
  - **Status:** Partially done
  - **Problem:** The history is meaningful and the repository is clean. The
    commit messages are terse, in the style of the original build, and a
    stranger would not know what the phases were.
  - **Outcome:** A history a reader can follow.
  - **Acceptance criteria:**
    - [x] The history is linear, dated, and free of unrelated noise.
    - [x] The repository is public and clean.
    - [ ] The commit messages are understandable to a newcomer.
  - **Dependencies:** None.
  - **Effort:** S.

---

## 11. Ideas backlog

Ideas that are interesting but not yet prioritised. They stay here until
something makes them the right work.

| Idea | Benefit | Complexity | Depends on |
|---|---|---|---|
| **A diff view between two analyses** | See how a repository's shape changed, without checking out two commits | M | The commit comparison (6) |
| **Export the map as an image or a graph file** | Take the picture away; open it in another tool | S | None |
| **A "why is this file here" trace** | Follow one file's imports back to the entry point that reaches it | M | The call graph, or a bounded path search |
| **Per-organisation usage limits** | Bound the cost and the storage one team can use | S | The cost visibility (7) |
| **Import the map into a code host** | Post the graph as a comment or a file | M | None |
| **A plugin that opens a file on the map from the editor** | The map becomes part of the editing loop | M | A public deployment, and a way to authenticate against it |
| **Local analysis of a repository that is not on GitHub** | Map a project that is not published | M | A source other than `codeload.github.com` |
| **Watch a repository and re-analyse it when it moves** | The map stays current | M | A scheduler, which the project does not have |
| **Store the parse result as a portable file** | Analyse without a database; share a result | S | The contract already exists for this |
| **An interactive prompt sandbox** | Try a prompt against a real analysis and see what it retrieves | M | The Q&A feature |
| **Compare the map's view of a repository with its own tests** | Check the graph against what the test suite exercises | L | Symbol extraction, the call graph |
| **A "deletion candidate" view** | Files nothing imports and no convention reaches | S | The insights already exist; the presentation does not |
| **Colour the map by change frequency** | See which parts of a repository move | M | The commit comparison |
| **Support for monorepo workspaces with cross-package edges** | The relationships between packages | M | Nothing — the resolver already handles linked workspace packages |
| **A CLI that prints a summary of a repository** | The same analysis, without the web app | S | The parser and the graph engine are already standalone |
| **Let a person correct a route the parser got wrong** | The route table becomes as good as the person who knows the code | M | A correction store, and a policy for it |

---

## Appendix: how to update this file

1. **Tick a box only with evidence.** A function existing is not evidence.
2. **Move finished work to [CHANGELOG.md](CHANGELOG.md).** A list of things
   done in 2024 is not a roadmap.
3. **Add the item to the right section.** A language goes in section 4, an
   AI improvement in section 7, a deliverable in section 9.
4. **Keep the status honest.** "Needs verification" is a real status, and
   using it is better than guessing.
5. **Update the documentation with the code.** If a change makes a statement in
   [docs/features.md](docs/features.md) untrue, that statement has to change
   in the same pull request. See [CONTRIBUTING.md](CONTRIBUTING.md).
