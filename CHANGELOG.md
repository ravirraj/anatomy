# Changelog

All notable changes to Anatomy.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## About this file

**Anatomy has no tagged releases yet.** There is no version, no tag and no
published release, so this file does not pretend otherwise. There is no
`1.0.0` entry, because there has been no `1.0.0`.

What exists instead:

- **[Unreleased]** below — the state of the tree, described in the same terms
  as a release entry would be. It is not a release; it is a description of
  what is in the repository right now.
- **The build history** at the bottom — the phases the project was built in,
  in the order they were built, with the dates from the git history. These are
  the real commit dates.

### The convention for future releases

When the first release is cut:

1. A version number and a date are chosen.
2. The section is renamed from `Unreleased` to the version, and the date is
  filled in.
3. A new empty `Unreleased` section is added above it.
4. The entry describes **what changed between the previous tag and this one**,
   grouped as Added / Changed / Fixed / Removed / Security, in the past tense.
5. The version is tagged: `git tag -a v0.1.0 -m "v0.1.0"` and the tag is
   pushed.

Only changes that can be established from the git history or from the code
itself get an entry. Nothing is written here that did not happen.

---

## [Unreleased]

The current state of the tree. Not a release.

### Added

**Repository ingestion.** A pasted GitHub URL is resolved to a commit, the
tarball at exactly that commit is downloaded, and it is extracted to a
temporary directory. Unauthenticated: only public repositories, and no token
is stored. Bounded at 100 MB and five minutes, with the limit stated rather
than engineered around.

**AST parsing.** `ts-morph` over the TypeScript compiler API, with the
compiler's own resolution disabled so that every import is classified by
Anatomy's resolver. Five import forms recognised: static `import`,
`export … from`, TypeScript `import x = require(…)`, dynamic `import()` and
`require()`. Type-only is decided from the bindings.

**Import resolution.** TypeScript's resolver using the nearest
`tsconfig.json`/`jsconfig.json`, never outside the repository; then relative
paths, then `paths` aliases, then workspace packages, then `baseUrl`. Every
outcome is classified, with eight unresolved reasons and four excluded reasons.

**Coverage reporting.** Found, parsed, skipped and excluded, each with a
reason. The parser asserts on its own arithmetic before returning: `found ==
parsed + skipped`.

**The graph engine.** Pure functions over a file list and an edge list, so
they run in the browser with no request. Folding into at most 24 groups, a
canvas projection with scrolling panels of at most 14 rows, shortest unique
labels, fan-in and fan-out over distinct files.

**Blast radius and dependency chain.** Breadth-first walks in both directions
over the edge list, two steps by default, with the files further out counted
rather than listed.

**Structural insights.** Files nothing imports, files imported unusually
often (a Tukey far-out fence over the repository's own distribution), import
cycles (Tarjan's algorithm, with an explicit stack), and long files.

**Framework adapters.** Next.js, NestJS, Express, Docusaurus and React, plus a
fallback, selected in a fixed order. Every adapter applies the shared tool
conventions, so a test or a config file is recognised even with no framework
at all.

**Route recovery.** Next.js App Router route handlers and NestJS controller
and method decorators. Where the method or the full path cannot be recovered
exactly, the routes are **withheld with a stated reason** rather than
approximated — Express routes always, and Next.js routes when `basePath` is
computed or `pageExtensions` is set.

**AI explanations.** For a file or a folder, written from that thing's real
neighbours, with every path in the prose becoming a link that moves the map.
The prompt permits exactly three kinds of formatting and the renderer renders
exactly those, reducing anything else rather than printing it as markup.

**Answer caching.** In the `ai_cache` table, scoped to the organization. The
cache read is the **first thing inside the traced call**, so a cache hit is a
recorded run containing no model call — a cache nobody can verify is just a
cache. The key includes the task, the prompt version, the model and the
question.

**Tracing.** LangSmith, optional. The pane reports whether tracing is on, and
why not if it is not, because an absent key otherwise looks exactly like a
working setup with no traffic.

**AI classification of unclassified files.** A file no convention identified
can be labelled by the model, from a fixed list of seven roles, none of them
routable. The answer is checked, not trusted, and a refused answer is never
cached.

**Citation verification.** Every path-shaped mention in an AI answer — code
spans, bold text, bare words in prose, the same tokens the renderer links — is
tested against the set of paths the model was shown. An answer that names a
file that is not in the analysis is refused, and it is refused **before it is
cached**, on a cache hit as much as on a miss, so a bad answer can never be
stored and served. `scripts/test-citations.ts` covers the checker, including a
made-up filename spliced into an honest answer.

**Freshness checking.** The repository's current HEAD is compared against the
analysed commit, and a file's bytes against the hash the parser stored, so an
explanation always describes the code that is on the map.

**Multi-tenancy.** Clerk for identity and organizations; row-level security on
every table, enabled by a database event trigger so a table cannot silently be
left unprotected. Every policy reads the organization off the token; there is
no `where organization_id = …` in application code.

**Live progress.** A database trigger publishes `{ status, stage, message }` on
a private realtime channel whenever the stage actually changes. The browser
subscribes once, reads the row once after joining, and then listens — never
polls.

**Staleness and re-running.** A run is claimed with a conditional update, so a
live run cannot be claimed twice and an abandoned one can be taken over. Every
later write by a run is scoped by its own claim timestamp.

**Three test suites.** `scripts/test-provider.ts` (the AI layer against a fake
OpenAI-compatible endpoint), `scripts/test-explanation-store.ts` (the
explanation store) and `scripts/test-citations.ts` (citation verification).
36 checks, no test framework, non-zero exit on failure.

**A configurable model provider.** The base URL, the key and both model names
are environment variables. Unset, it is OpenAI's own API with its own pinned
models. Google AI Studio's compatibility layer for Gemini and OpenRouter both
work, with the provider-specific parameters handled — `verbosity` is sent only
to OpenAI, and a strict JSON schema falls back to plain JSON mode when an
endpoint refuses it.

**Documentation.** A README, a documentation index, architecture, features,
development, AI system, security, a public roadmap, this changelog, a
contribution guide, and a `TODO.md` carrying the authoritative task list.

### Changed

**Explanations survive a re-render.** Answers moved into a store of their own,
backed by the browser's session storage and read with `useSyncExternalStore`. A
server action re-renders the page it was called from, and an answer that took
a minute to fetch should not be lost to that. Only a finished answer is
written to disk: a request still in flight died with the page.

**The wordmark is a link home.** The header's `anatomy` goes to the
dashboard, so leaving an analysis no longer means editing the URL.

**A file is not asked for twice.** While a request for a target is in flight, a
second request for the same target does nothing.

### Fixed

- The `neighboursOf` edge kinds are in encounter order rather than contract
  order, which the comment claimed otherwise. Not yet corrected — see
  [TODO.md](TODO.md#14-important-technical-debt).

### Security

- **Verified.** Every table grants `SELECT` to `authenticated` and nothing to
  `anon`; the three write RPCs are executable only by `service_role`; the
  realtime channel refuses a subscriber from another organization; the answer
  cache is scoped to the organization by a policy; and no credential-shaped
  string is present in any tracked file.
- **Known limitations**, listed in full in
  [docs/security.md](docs/security.md#9-known-security-limitations): the
  browser's session store is not cleared on sign-out; there is no
  prompt-injection defence; nothing verifies that an answer does not name a
  file that does not exist; the parser's data writes are not fenced by the
  run's claim; the answer cache never evicts.

---

## Build history

The project was built in phases, each specified before it was built. The
specifications are in [docs/specs/](docs/specs/) and the reasoning behind the
whole product is in [docs/project-doc.md](docs/project-doc.md).

The dates below are the real commit dates from the git history.

| Date | Phase | Specification |
|---|---|---|
| 2026-10-15 | Scaffold, and the role taxonomy | — |
| 2026-10-16 | The parser, and the framework adapters | [phase-03](docs/specs/phase-03.md), [phase-08](docs/specs/phase-08.md) |
| 2026-10-17 | The parser on the command line, and the graph engine | [phase-06](docs/specs/phase-06.md) |
| 2026-10-18 | The schema, and the policies that enforce tenancy | [phase-02](docs/specs/phase-02.md) |
| 2026-10-19 | The AI client, and the pipeline | [phase-07](docs/specs/phase-07.md), [phase-10](docs/specs/phase-10.md) |
| 2026-10-20 | The canvas, the agent tooling, and the documentation | [phase-04](docs/specs/phase-04.md), [phase-05](docs/specs/phase-05.md) |

Phases 01 (auth and teams), 09 (CommonJS and Express) and the rest of the
specifications describe the work in the order it was planned; the
specifications are the authoritative statement of intent, and the code is the
authoritative statement of what exists.

---

[Unreleased]: https://github.com/ravirraj/anatomy/compare/HEAD...HEAD
