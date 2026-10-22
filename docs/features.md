# Feature catalogue

What Anatomy does today, what it half-does, and what it does not do. Every
claim here is checkable against the source; the file that implements a feature
is named.

The categories are deliberately blunt. "Implemented" means there is code and it
works. "Needs validation" means the code is there but the evidence is thin.
"Planned" means it is written down in [TODO.md](../TODO.md) and not built.

---

## Implemented and verified

### Repository ingestion

**What it does.** Takes a GitHub repository URL, resolves its HEAD commit,
downloads the tarball at exactly that commit, and extracts it to a temporary
directory.

**The problem it solves.** "What is in this repository" is the first question,
and it is a question about *a commit*, not about a branch that is still moving.

**How it works internally.** `lib/pipeline/github.ts`. The commit is resolved
first, so the recorded sha is the code that was parsed. The archive is streamed
through `tar` with `strip: 1`. The commit is fetched with **no token**: only
public repositories are analysed, and no credential is stored.

**Files.** `lib/pipeline/github.ts`, `lib/pipeline/run.ts`, `lib/pipeline/submit.ts`.

**How to test it.**

```bash
pnpm analyze sindresorhus/p-limit --org <clerk-org-id>
```

**Limitations.** 100 MB archive limit; 5-minute archive timeout; 15-second API
timeout; the GitHub anonymous rate limit applies.

---

### AST parsing

**What it does.** Reads every source file and turns its imports into edges.

**The problem it solves.** The alternative — guessing from file names — is
wrong often enough that the result is a picture rather than a map.

**How it works internally.** `lib/parser/`. ts-morph over the TypeScript
compiler API, with `noResolve` and `skipFileDependencyResolution` set so that
**Anatomy's own resolver classifies every import**, not the compiler's. Five
import forms are recognised: static `import`, `export ... from`, TypeScript
`import x = require(...)`, dynamic `import()`, and `require()`. Type-only
imports are detected from the bindings, so `import { type A, b }` is *not*
type-only.

**Files.** `lib/parser/walk.ts`, `extract.ts`, `resolve.ts`, `graph.ts`,
`index.ts`, `contract.ts`.

**How to test it.** `pnpm parse <dir>` — no API keys, no database, no server.

**Limitations.** TypeScript and JavaScript only: `.ts .tsx .mts .cts .js .jsx
.mjs .cjs`. A file that does not parse cleanly is skipped with the compiler's
message rather than half-read.

---

### Import resolution

**What it does.** Turns a specifier into a file in this repository, a package,
a Node built-in, or a stated reason why it could not be resolved.

**The problem it solves.** A barrel-file project loses most of its edges and
still renders a clean, confident, wrong picture. Silent failure is the one
outcome worth engineering against.

**How it works internally.** `lib/parser/resolve.ts`. TypeScript's own
resolver, using the nearest `tsconfig.json`/`jsconfig.json` (never outside the
repository), then relative/absolute paths, then `paths` aliases, then
workspace packages, then `baseUrl`.

**Every outcome is classified.** Eight unresolved reasons and four excluded
reasons, each with a literal detail string. Nothing is left as "probably a
dependency".

**Files.** `lib/parser/resolve.ts`, `lib/parser/index.ts`.

**How to test it.** `pnpm parse <dir> --all` lists every unresolved import with
its reason.

**Limitations.** `package.json` `exports`/`main`/`module` are not read by
Anatomy; they are honoured only insofar as TypeScript honours them. A
`#subpath` import is always reported as unresolved.

---

### Coverage reporting

**What it does.** Counts what was found, parsed, skipped and excluded, and says
why for each skipped file.

**The problem it solves.** "It didn't work" is not an answer. "82 of 85 files
parsed; 2 skipped, both declaration files; 1 unresolved import" is.

**How it works internally.** `lib/parser/index.ts` assembles a `Coverage`
object; `lib/parser/contract.ts` validates it, including the invariant
`found == parsed + skipped`, which the parser asserts on itself before
returning.

**Files.** `lib/parser/types.ts`, `lib/parser/contract.ts`, `lib/parser/index.ts`.

**How to test it.** The `pnpm parse` summary, and the coverage panel in the UI.

**Limitations.** The unresolved-import list is complete, not sampled — it can be
large on a repository with many unlinked workspace packages.

---

### The dependency graph

**What it does.** Holds the parsed graph and answers questions about it.

**The problem it solves.** "What depends on this" and "what does this break"
are questions about a structure, and they should be arithmetic.

**How it works internally.** `lib/parser/graph.ts` deduplicates edges on
`source → target → kind` and counts fan-in and fan-out over *distinct files*:
importing and re-exporting the same file counts once.

**Files.** `lib/parser/graph.ts`.

**How to test it.** `pnpm parse` prints the edge count and the type-only count.

**Limitations.** Only import relationships are recovered. There is no call
graph.

---

### Folding and the canvas

**What it does.** Turns a large file list into a readable number of boxes, then
draws the boxes and the edges between them.

**The problem it solves.** A thousand files is a thousand nodes, which is not a
map.

**How it works internally.** `lib/graph/fold.ts` raises a threshold until at
most `MAX_GROUPS` (24) groups remain, merging directories with too few files
into their parent. `lib/graph/view.ts` projects that onto the canvas: a group
is a folded box until opened, and a scrolling panel of rows after. Rows are
ranked by fan-in. Labels are the shortest unique trailing path segment.

**Files.** `lib/graph/fold.ts`, `view.ts`, `labels.ts`, `components/map/`.

**How to test it.** Open a large repository in the UI. `pnpm map-counts` prints
how many nodes the map would draw.

**Limitations.** A panel shows at most `MAX_ROWS` (14) rows at a time. The
whole file list is held in the browser, and every edge is scanned on each
rebuild.

---

### Selection, hover and the category rail

**What it does.** Selecting something lights what it connects to; hovering
marks it on the map; the rail filters by category.

**The problem it solves.** "Which of these 400 files is the one I care about",
and "show me everything that is a page route".

**How it works internally.** `lib/graph/highlight.ts` computes the bright set
from the *file* edge list, not the drawn one, so a connection to a row in the
same panel — which is not drawn — still lights up. `lib/graph/categories.ts`
derives a file's kind from its extension, which is a fact read off the path.

**Files.** `lib/graph/highlight.ts`, `categories.ts`, `components/category-rail.tsx`,
`components/map/`.

**Limitations.** The category set is open — any extension is a category, and
`.TS` and `.ts` are different ones.

---

### Blast radius and dependency chain

**What it does.** "What breaks if I change this file" and "what does this file
depend on", as a walk over the edge list.

**The problem it solves.** This is the question that makes a dependency map
worth having.

**How it works internally.** `lib/graph/reach.ts` — a breadth-first walk from
the selected file, in both directions, over an adjacency map built once from
the edges. It runs in the browser with no request, because the data is already
there.

**Files.** `lib/graph/reach.ts`, `components/detail-pane.tsx`.

**How to test it.** Select a file in the UI and press **Blast radius**.

**Limitations.** `DEFAULT_DEPTH` is 2. Files further out are counted and
reported as a number, not listed. The walk itself is not depth-capped, so on a
very large graph it still traverses the whole reachable component.

---

### Structural insights

**What it does.** Reports files nothing imports, files imported unusually
often, import loops, and long files.

**The problem it solves.** "Where do I start reading" and "what is tangled".

**How it works internally.** `lib/graph/insights.ts`. "Unusually often" is a
Tukey far-out fence over this repository's own fan-in distribution, so
"unusual" means unusual *here*. Cycles come from Tarjan's algorithm with an
explicit stack, because a real repository has import chains deep enough to
overflow the call stack.

**Files.** `lib/graph/insights.ts`, `components/detail-pane.tsx`.

**Limitations.** The loop reported is one shortest loop through the
component's alphabetically-first file, not necessarily the shortest loop in the
component. Type-only edges are excluded from cycle detection, because they are
erased before the code runs.

---

### The route table

**What it does.** Lists the HTTP routes it can recover exactly, and says why
it cannot list the others.

**The problem it solves.** A map of a web application that does not say what
its URLs are is missing the most-asked question about a web application.

**How it works internally.** `lib/parser/adapters/nextjs.ts` and
`nestjs.ts`. A route is listed only when both its method and its full path are
recoverable from the syntax.

**What is listed.** Next.js **App Router route handlers** (`app/**/route.ts`),
and NestJS controller and method decorators.

**What is not listed, and why.**

| Case | Outcome |
|---|---|
| Next.js Pages Router pages | Not listed. A page has no method written anywhere, so there is no route to state. |
| Next.js `pages/api/**` handlers | Omitted: *"a pages/api handler chooses its method at runtime"*. |
| Express, any project | Withheld: *"Express puts each route together at runtime from the routers and paths it's mounted on"*. |
| Docusaurus | None. A static host answers the path. |
| Next.js with a computed `basePath` | The whole project's routes withheld, with the reason. |

**Files.** `lib/parser/adapters/nextjs.ts`, `nestjs.ts`, `express.ts`,
`docusaurus.ts`.

**How to test it.** The **Routes** tab on an analysis page.

**Limitations.** Route groups `(...)` and parallel-route slots `@...` are left
out of the URL by definition, and intercepting segments `(.…)` are omitted.
The adapters read paths and syntax only — they do not execute the code.

---

### Framework detection

**What it does.** Works out which framework a project uses, and applies that
framework's conventions to the files.

**The problem it solves.** "This file is a page route" is a fact about where
it sits, and knowing which framework it belongs to is how you know that.

**How it works internally.** `lib/parser/adapters/index.ts` — a fixed order,
first match wins: **Next.js → NestJS → Express → Docusaurus → React →
fallback**. Detection is by dependency name in the project's `package.json`.
A directory becomes its own project only when it has a `package.json` *and* a
framework is detected there.

**Every adapter also applies the shared tool conventions**, so a file is
recognised as a test or a config even in a project with no framework at all.

**Files.** `lib/parser/adapters/`, `lib/parser/walk.ts`.

**Limitations.** Detection is by dependency name only. A project with both
`next` and `react` is detected as Next.js.

---

### AI explanations

**What it does.** Explains a file or a folder, written from its real
neighbours.

**The problem it solves.** "What is this file for" is the question a map
cannot answer on its own.

**How it works internally.** `lib/ai/` and `lib/analysis/context.ts`. The
context is read from the stored analysis — the file's source, its role, and
every file it imports and every file that imports it, with their roles and
export names. The model is never asked to find a connection, only to explain
the ones it is given. The prompt permits exactly three kinds of formatting, and
the pane renders exactly those.

**Files.** `lib/ai/client.ts`, `lib/ai/tasks.ts`, `lib/ai/prompts.ts`,
`lib/analysis/context.ts`, `app/(workspace)/analyses/[id]/actions.ts`.

**How to test it.** Select a file in the UI and press **Explain**.

**Limitations.** The explanation is about **one file or one folder**, never the
repository. See
[docs/ai-system.md](ai-system.md#8-what-is-not-built) and
[TODO.md](../TODO.md#3-high-priority-features).

---

### Answer caching and staleness

**What it does.** Answers the same question instantly the second time, and
says when the repository has moved past the analysed commit.

**The problem it solves.** A model call that took a minute should not be paid
for twice. And an explanation of code that has since changed is worse than
useless.

**How it works internally.** The cache read is the first thing inside the
traced function, so a cache hit is a recorded run containing no model call —
a cache nobody can verify is just a cache. The cache key includes the task,
the prompt version, **the model** and the question. Answers are stored in
`ai_cache`, scoped to the organization.

Freshness compares the repository's current HEAD against the analysed commit,
and for a file compares GitHub's bytes against the hash the parser stored.

**Files.** `lib/ai/tasks.ts`, `app/(workspace)/analyses/[id]/actions.ts`,
`components/explanation-panel.tsx`, `components/explanation-store.ts`.

**Limitations.** The cache is never evicted. Re-analysis is manual.

---

### AI classification of unclassified files

**What it does.** Gives a role to a file that no framework or tool convention
identified.

**The problem it solves.** Half the files in a repository are ordinary
modules, and "unclassified" is not a useful answer when you are trying to
understand it.

**How it works internally.** `lib/ai/tasks.ts` asks for a single role from a
fixed list, as a strict JSON schema. The answer is **checked, not trusted**:
a role outside the permitted list is refused, and the file stays unclassified.

**Files.** `lib/ai/tasks.ts`, `lib/roles.ts`, `app/(workspace)/analyses/[id]/actions.ts`.

**Limitations.** Only seven roles are permitted, and none of them is a
routable one — the role that decides what is a page belongs to convention
alone.

---

### Authentication and organizations

**What it does.** Signs a person in, puts them in a team, and keeps one team's
rows away from another's.

**The problem it solves.** An analysis belongs to a team, not to whoever ran
it, and teams that share a codebase should share the map.

**How it works internally.** Clerk issues a session token; the application
reads it and never asks Clerk a question at runtime. The token carries the
active organization, and the database policies read it.

**Files.** `proxy.ts`, `app/start/`, `app/(workspace)/layout.tsx`.

**How to test it.** Sign in, and confirm the organization appears in the
header's switcher.

**Limitations.** Requires two Clerk-side settings to be on: organizations
enabled, and `org_name` added to the session token.

---

### Tenant isolation

**What it does.** Makes one organization's rows absent from another
organization's queries.

**The problem it solves.** A multi-tenant tool that filters rows in the
interface is one refactor away from leaking.

**How it works internally.** Row-level security, enabled on every table by a
database event trigger. Every policy reads
`coalesce(auth.jwt() -> 'o' ->> 'id', auth.jwt() ->> 'org_id')`. There is no
`where organization_id = ...` in application code.

**Files.** `supabase/migrations/20260928085353_schema.sql`,
`lib/supabase/server.ts`, `lib/supabase/admin.ts`.

**How to test it.** Two accounts in two organizations; each sees only its own
analyses. The policies have been exercised directly against Postgres this way.

**Limitations.** The writer (`createAdminSupabase`) bypasses the policies, so
every write it makes is responsible for its own `organization_id`.

---

### Live progress

**What it does.** Shows the stages of a run as they happen.

**The problem it solves.** Parsing a real repository is not instant, and a
spinner that does not say anything is indistinguishable from a hang.

**How it works internally.** A database trigger publishes
`{ status, stage, message }` on the private realtime topic `analysis:{id}`
whenever the stage or message actually changes. The browser subscribes once,
reads the row once after joining, and then listens — never polls.

**Files.** `supabase/migrations/20260928174534_progress_channel.sql`,
`lib/pipeline/stages.ts`, `components/progress/`.

**Limitations.** A run whose server dies leaves a row that says "running"
until the stale window passes.

---

### Staleness and re-running

**What it does.** Notices that a run has been abandoned, and lets it be
started again.

**The problem it solves.** There is no queue and no worker, so a run can die.

**How it works internally.** `STALE_AFTER_MS` is 5 minutes. A queued row is
measured from when it was created; a running one from when it began. A claim
is a conditional update, so a live run cannot be claimed twice. Every later
write by a run is scoped by the run's own claim timestamp, so a run that has
been taken over stops rather than overwriting the newer one.

**Files.** `lib/pipeline/run.ts`, `lib/pipeline/stages.ts`,
`components/progress/rerun-button.tsx`.

**Limitations.** The file, edge, route and role writes are not scoped by the
claim, so two overlapping runs can still interfere.

---

## Implemented but requiring further validation

### The Next.js route table against a large App Router codebase

The adapter's rules are exercised on individual repositories, but there is no
fixture suite covering the range of App Router layouts — route groups,
parallel routes, intercepting routes, `basePath` with a prefix, dynamic
segments, `route.ts` files that export a handler imported from elsewhere.

**Why it matters.** The route table is the feature most likely to be wrong in
a way nobody notices, because an absent route is indistinguishable from a
route that does not exist.

**What would settle it.** A set of fixture repositories with known routes, and
a test that asserts the recovered set equals the known set.

**Tracked in** [TODO.md](../TODO.md#2-implementation-and-validation).

### Coverage of import forms in real code

The five recognised forms are implemented and unit-reachable, but the
proportion of real-world imports they capture has not been measured.

**What would settle it.** Running the parser over a corpus of repositories and
reporting the distribution of unresolved reasons.

**Tracked in** [TODO.md](../TODO.md#2-implementation-and-validation).

### Multi-project repositories

A monorepo with several detected projects produces several adapters, and
adapter results are mapped back to repository paths. The mapping is covered by
the code, but multi-project repositories have not been exercised end to end.

**Tracked in** [TODO.md](../TODO.md#2-implementation-and-validation).

---

## Partially implemented

### The `explain` task covers one file or one folder

A folder explanation is a real question — what is in here, and why does so
much point at it — and it is answered from the folding the map draws. But
"explain the repository" has no implementation, and there is no way to ask a
question the map did not already answer.

**What is missing.** A question, a retrieval step over the whole graph, and
citations.

**Tracked in** [TODO.md](../TODO.md#3-high-priority-features).

### The explanation store survives a re-render, not a different answer

Answers are cached in the browser's session storage and in the database. They
are not invalidated when the repository moves; the pane detects that separately
and offers to re-analyse. There is no cache key for the repository's head.

**Tracked in** [TODO.md](../TODO.md#7-ai-improvements).

### The analysis page is one analysis at a time

The dashboard lists every analysis in the organization, but there is no
comparison between two, and no way to see the same repository analysed at two
commits side by side.

**Tracked in** [TODO.md](../TODO.md#6-repository-evolution-and-advanced-analysis).

### The category rail filters by extension, not by role

The rail groups by the file's *kind* — its extension. The *role* taxonomy
(page route, component, hook, service) is a much richer grouping that exists
in the data and is used for the role of a file, but the rail does not use it.

**Tracked in** [TODO.md](../TODO.md#5-developer-experience).

---

## Planned

Each of these is written up in full, with acceptance criteria, in
[TODO.md](../TODO.md).

| Feature | Priority |
|---|---|
| Repository-wide AI question answering, with citations | P0 |
| Parser reliability: fixtures, regression tests, accuracy measurement | P0 |
| Change impact analysis beyond a fixed depth | P1 |
| Symbol and full-text search | P2 |
| Commit-to-commit comparison | P2 |
| Call-graph analysis | P3 |

Nothing in this list is implemented. The list is the authority on that.

---

## Not currently supported

### Languages other than TypeScript and JavaScript

**Python, Go, Java, Rust, C#, Ruby, PHP** — and every other language.

**Why.** The parser is built on ts-morph, the TypeScript compiler API. There
is no tree-sitter, no second grammar, and no language field anywhere in the
data model. A repository written in Go contributes **zero files** — those files
are not "skipped with a reason", they are never considered, because
`CODE_EXTENSIONS` rejects them before the found count is incremented.

**What it would take.** A per-language parser producing a common intermediate
representation, so the graph engine and the adapters do not change. Detailed
in [TODO.md](../TODO.md#4-multi-language-and-framework-support).

### Frameworks not listed in the adapter table

Django, FastAPI, Gin, Spring Boot, Rails, Laravel, Svelte, Vue, Angular, and
every other framework. A repository using one of these is parsed — its imports
are still found — but its files get no framework roles and no routes.

**What it would take.** An adapter. The interface is six methods, and the
existing ones are the best documentation of it.

### Private repositories

Only public repositories are analysed. There is no GitHub token, so there is
nothing to authenticate with. A token would have to be stored, which is the
reason the boundary is where it is.

### The agent / chat panel

**Not built.** The product design calls for a panel where a person asks the
repository a question and watches it look the answer up. There is no such
panel, no agent service, and no chat route in this repository. The `AGENT_URL`
variable that an earlier revision of the environment template mentioned is
gone, because nothing reads it.

**What it would take.** Repository-wide retrieval, a question interface, and
citations. Designed in [docs/ai-system.md](ai-system.md#9-proposed-repository-wide-question-answering).

### A call graph

Only import and re-export relationships are recovered. Which function calls
which is not, and cannot be derived from the import graph.

### Symbol-level information

Anatomy knows which files exist, what they import, and what they export *by
name*. It does not know what functions or classes a file contains, so it
cannot answer "where is `useAuth` defined".

### A public deployment

There is no hosted instance, no recorded demonstration video, and no public
demo URL. The repository has been run locally only.

### A license

The repository has no `LICENSE` file, so it is not licensed for reuse.
