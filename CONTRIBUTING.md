# Contributing to Anatomy

Anatomy is a project about making a codebase's structure visible, and it is
built to the standard it claims: every edge comes from really parsing the
code, and every claim the project makes about itself is checkable.

This guide covers how to set up, what is expected of a change, and how each
subsystem is extended.

---

## 1. Prerequisites

| Requirement | Version |
|---|---|
| Node.js | 22.18 or newer — the `scripts/` entry points run TypeScript directly |
| pnpm | 10 |
| A Clerk application | free tier is enough |
| A Supabase project | free tier is enough |
| A model provider key | optional — only the Explain button needs one |

See [docs/development.md](docs/development.md#1-prerequisites) for the details
and for how to obtain each value.

---

## 2. Setting up

```bash
git clone https://github.com/ravirraj/anatomy.git
cd anatomy
pnpm install
cp .env.example .env.local
```

Fill in `.env.local` — the full walkthrough is in
[docs/development.md](docs/development.md#3-environment-configuration). Two
Clerk-side steps are easy to miss and both break the app visibly:

- **Enable Organizations.** Without it the API returns
  `organization_not_enabled`.
- **Add `{"org_name": "{{org.name}}"}` to the session token.** The dashboard
  reads that claim and throws without it.

Then apply the migrations:

```bash
pnpm dlx supabase login
pnpm dlx supabase link --project-ref <your-project-ref>
pnpm dlx supabase db push
```

And run it:

```bash
pnpm dev
```

Check it works before changing anything:

```bash
pnpm test      # both suites
pnpm lint
pnpm build
pnpm parse .   # the parser, with no server and no keys
```

---

## 3. Code style

### 3.1 The rules that are not negotiable

These come from [docs/project-doc.md](docs/project-doc.md) and
[CLAUDE.md](CLAUDE.md), and they are what makes the system work.

- **Strict TypeScript, no `any`.** If a type is genuinely awkward, say so
  rather than casting.
- **The parsing code cannot import Next.js, React or the database client.**
  Path in, data out, runnable from a plain script.
- **No framework checks inside the parser.** That knowledge lives in an
  adapter.
- **Graph calculations are pure functions** over a file list and an edge list.
- **Database access happens in server code**, not inside components.
- **Who may read a row is decided by a policy**, never by application code.
- **One place constructs the AI client.** `lib/ai/client.ts` is the only
  module that imports `openai`.
- **Never decide that two files are connected.** An edge exists because the
  parser resolved a real import to a real file. Unresolved gets reported with
  a reason, never guessed.
- **Never invent something to fill a gap.** A skipped file is reported and
  counted. A route that cannot be recovered exactly is shown as none.
- **Never add a dependency without saying so first.** Name it, say what it is
  for, and wait.

### 3.2 The rules that are about taste

- **Comment the decisions, not the syntax.** A comment should say *why*, and
  what the alternative was. The existing code is the reference: if a comment
  could be deleted without anyone noticing, it is not saying anything.
- **One obvious way to do something beats a configurable one.**
- **The UI is a dense developer tool.** Small type, tight spacing, monospace
  for file paths. Colour means something or it is not there. Nothing moves
  unless it was clicked.
- **Errors name the thing that went wrong.** "Couldn't load analyses: …" and
  the provider's own message, not "Something went wrong".

### 3.3 The linter is not optional

```bash
pnpm lint
```

It runs ESLint with `eslint-config-next`, including the React Compiler rules.
`react-hooks/set-state-in-effect` in particular is not pedantry: an effect that
sets state synchronously causes a cascading render, and the fix is usually to
restructure — often with `useSyncExternalStore` for anything that lives
outside React.

---

## 4. Tests

There is no test framework. The suites are plain Node scripts that assert on
real behaviour and exit non-zero on failure, so they run the same way locally
and in CI.

```bash
pnpm test
```

| Suite | Covers |
|---|---|
| `scripts/test-provider.ts` | The AI layer against a fake OpenAI-compatible endpoint. |
| `scripts/test-explanation-store.ts` | The explanation store. |

### 4.1 What to test

- **Anything with a rule in it.** The resolver's classifications, the
  contract's validation, the cache key's composition, the store's merge
  behaviour. These are the places a wrong answer is silent.
- **Anything with a stated limit.** A limit that is not tested is a limit that
  drifts.
- **Anything that could be wrong in a way nobody would notice.** A route
  pattern that is off by a segment; an edge that resolves to the wrong file; a
  policy that leaks.

### 4.2 What not to test

- **The parser, through unit tests.** It is a large function over real
  repositories. The honest test is a fixture corpus and a comparison — see
  below.
- **The graph engine, through unit tests.** It is arithmetic over two lists.
  `pnpm parse` and `pnpm map-counts` exercise it against reality.

### 4.3 The fixture corpus — wanted

**The single highest-value contribution to this project is a fixture corpus.**
A directory of real repositories with their expected results, checked on every
build, is what turns the resolver from "seems right" into "is right".

The design is in [TODO.md](TODO.md#2-implementation-and-validation). At the
time of writing there is no corpus, and the two suites above are all there is.

---

## 5. Branching and pull requests

### 5.1 Branches

```
feature/short-description
fix/short-description
docs/short-description
```

Branch from `main`. Keep a branch to one concern — a parser change and a
documentation change are two branches.

### 5.2 Pull requests

A pull request should be readable in one sitting, and should say:

1. **What changed**, and why.
2. **How it was checked** — the commands run and what they showed. "It works"
   is not a check; `pnpm test` and `pnpm parse <repo>` are.
3. **What is deliberately not done**, if anything is in the same area.
4. **Which documentation changed**, and why.

Reference the relevant item in [TODO.md](TODO.md) if there is one.

### 5.3 Before you push

```bash
pnpm lint
pnpm test
pnpm build
pnpm check-links
pnpm parse .        # the project still parses itself
```

The last one matters more than it looks: the parser is the product, and the
repository is a real Next.js project. If it stops parsing itself correctly,
something is wrong.

---

## 6. How to extend the system

### 6.1 A new framework adapter

Adapters live in `lib/parser/adapters/`. The interface is six methods, and the
existing adapters are the best documentation of it — read
`nextjs.ts` and `nestjs.ts` before writing anything.

```ts
export interface FrameworkAdapter {
  name: Framework;                                 // shown in the UI
  detect(project: ProjectInfo): boolean;           // by dependency name
  excludeDirectory(dir: string): string | null;    // project-relative
  reachedBy(path: string): string | null;          // project-relative
  roleOf(file: AdapterFile): Role | null;
  routes(project: ProjectFiles): RouteReport;
}
```

1. Write it in `lib/parser/adapters/<name>.ts`.
2. Add its name to `FRAMEWORK_ROLES` in `lib/roles.ts`, and any roles it
   assigns to `ROLES` in the same file.
3. Register it in `ADAPTERS` in `lib/parser/adapters/index.ts`, **above**
   `fallbackAdapter` and in the right order relative to the others.
4. Test it: `pnpm parse <repo>` and check the `Projects` line and the roles.

**On `routes`:** return `NO_ROUTES` unless both the method and the full path
are recoverable from the syntax. If they are not, return a `withheld` reason.
A stated reason is worth far more than an approximation — a wrong route is the
same failure as an invented edge, and the existing adapters' withheld strings
show the level of honesty expected.

### 6.2 A new graph feature

`lib/graph/` is pure: no Node imports, no `next/*`, no React, no database
client. The browser runs it. A new module there must stay that way, or it
cannot be used in the canvas.

Take the file list and/or the edge list, return a plain object. If it needs
to render, the component that calls it goes in `components/`.

### 6.3 A new AI capability

`lib/ai/client.ts` is the only place `openai` is imported. A client built
anywhere else would work and silently go untraced.

A new task:

1. Add the input type and the message builder to `lib/ai/prompts.ts`.
2. Add the task to `lib/ai/tasks.ts`. The shape is fixed: a `traceable`
   function whose **first** action is the cache read, so a cache hit is a
   recorded run with no model call in it.
3. Add the task name to the `Task` union — it is part of the cache key.
4. If the task needs context, build it in `lib/analysis/context.ts`, from the
   stored analysis and never from the request.

**On prompts:** the model may explain and label. It may not decide that two
files are connected, and it may not walk the graph. Every path it sees must
have been handed to it. A prompt that lets the model name a file it was not
given is a prompt that will produce an invented path.

### 6.4 A new language

**This is the largest and most delicate change.** Do not extend
`CODE_EXTENSIONS` and hope: the parser is ts-morph, and a Python file handed
to it produces a syntax error, which reports a problem rather than solving
one.

The work is a parser for the language, a resolver for it, and a **language-
neutral intermediate representation** so that the graph engine, the adapters and
the AI layer do not need to know which language a file is in. The reasoning
and the plan for each candidate language are in
[TODO.md](TODO.md#4-multi-language-and-framework-support).

### 6.5 A schema change

Add a migration in `supabase/migrations/`, named `YYYYMMDDHHMMSS_what.sql`.
The timestamp prefix is the order, and the Supabase CLI relies on it.

- A new table is protected by RLS automatically, by the event trigger — but it
  is invisible until a policy is added.
- If a new column is read by application code, update
  `lib/supabase/database.types.ts` in the same change, or TypeScript will not
  know about it.
- A new write path needs a grant decision: who may call it, and from which
  role.

---

## 7. Documentation

Documentation is part of the change, not a follow-up.

### 7.1 The check list

If your change affects any of these, the matching document changes in the same
pull request:

| Your change | Update |
|---|---|
| A feature's behaviour | [docs/features.md](docs/features.md) — and move it between categories if it moved |
| How something is built | [docs/architecture.md](docs/architecture.md) |
| A new command, script or environment variable | [docs/development.md](docs/development.md), [`.env.example`](.env.example) |
| A new AI task, or a change to a prompt | [docs/ai-system.md](docs/ai-system.md) |
| A new table, policy, grant or data flow | [docs/security.md](docs/security.md) |
| A new limitation, or a fixed one | [docs/security.md](docs/security.md) |
| The state of the project | [TODO.md](TODO.md), [docs/ROADMAP.md](docs/ROADMAP.md), [README.md](README.md) |
| Anything a user would notice | [README.md](README.md) |

### 7.2 The rules for writing them

- **A claim about the code names the file that implements it.**
- **Implemented and planned are different words.** A planned feature is never
  described in the present tense.
- **No fabricated content.** No screenshots that do not exist, no benchmark
  numbers that were not measured, no release dates that were not real.
- **Quote constants exactly.** If the documentation says `MAX_GROUPS` is 24,
  then a test can compare it against the code, and the documentation cannot
  quietly become wrong.
- **Check the links.** `pnpm check-links` resolves every relative link and
  anchor in the documentation, and fails when one does not. Run it after any
  documentation change.

### 7.3 A new phase

The project is built spec-first. A new phase gets a specification in
`docs/specs/phase-NN.md`, **written before the phase is built**, describing
behaviour and giving an acceptance check. A specification deliberately does not
name files, because a specification that names files becomes wrong the moment
the implementation moves.

---

## 8. Reporting a bug

Open an issue with:

- **What you did**, and **what you expected**.
- **What happened instead**, with the exact error.
- **The version** — the commit sha.
- **The environment** — OS, Node version, whether it was `pnpm dev` or a
  build.

If it involves a repository, **say which one**. A repository that is not
public produces a specific failure, and it is worth distinguishing from a
parser bug.

A bug in the parser is the most valuable kind of report, and the most
welcome. "This repository parsed as 0 files" with the repository named is
directly actionable.

---

## 9. Suggesting a feature

Open an issue, or add it to [TODO.md](TODO.md) if you are confident.

A good suggestion says:

- **The problem.** Who has it, and what they do today instead.
- **The outcome.** What the product would do.
- **Why it fits.** Which of the product's rules it respects — particularly the
  one about the model never deciding that two files are connected.

Ideas that are interesting but not yet prioritised live in the backlog in
[TODO.md](TODO.md#11-ideas-backlog). Adding one there is welcome; an idea
does not need a full acceptance list to be worth recording.

---

## 10. Security reports

**Do not open a public issue for a security problem.** Report it privately
through GitHub's security advisory form on the repository, or by contacting
the maintainer directly.

A report is most useful with a reproduction. The verification checklist in
[docs/security.md](docs/security.md#10-verification-checklist) lists the
things worth checking, and the same list is a good starting point for a
report.

---

## 11. Code of conduct

Be accurate, be direct, and be kind to the people whose work you are
building on. A disagreement about a design decision is settled by the
reasoning, not by seniority — and the reasoning is written down, in
[docs/project-doc.md](docs/project-doc.md), precisely so that it can be
argued with.

---

## 12. Licence

There is no `LICENSE` file yet, and adding one is an open task in
[TODO.md](TODO.md#2-implementation-and-validation). Until it is added, the
repository is not licensed for reuse, and contributions are not covered by an
open-source licence.
