# Roadmap

The public-facing view. For the authoritative task list, see
[TODO.md](../TODO.md).

Anatomy turns a public repository into an interactive dependency map, from
real parsing, with answers that cite the code. This is where it is going.

---

## Current milestone — *A map you can trust*

**Shipped.** The pipeline runs end to end against live repositories, the map
renders a real dependency graph, and the routes are recovered from syntax or
withheld with a stated reason.

- TypeScript and JavaScript, parsed with ts-morph
- Next.js, NestJS, Express, Docusaurus and React recognised
- Blast radius and dependency chain, computed in the browser from the edge list
- Explanations for a file or a folder, cached and traced
- Row-level security on every table, verified against a live database

**Not shipped, and visible in the documentation:** no repository-wide
questions, no symbol search, no other languages, no call graph, no public
deployment.

---

## Next milestone — *Answers that cite code*

Two things, in this order.

### 1. A parser we can measure

A fixture corpus of real repositories, with their expected results, checked on
every build. Then a number: how accurate is the dependency extraction, measured
against hand-counted ground truth.

Everything else is measured against this, so it comes first.

### 2. Questions across the whole repository

> *How does authentication work in this repository?*

A question interface over a whole analysis. Answers cite real files and line
ranges, open in the map, and highlight the nodes and edges involved. When the
stored analysis does not contain the answer, the answer says so.

This needs three things that do not exist yet: a symbol index, retrieval over
the stored files, and a citation format. The design is in
[docs/ai-system.md](ai-system.md#9-proposed-repository-wide-question-answering).

**Also in this milestone:** verifying that an answer never names a file that
does not exist. The prompt forbids it; nothing checks it yet.

---

## Near-term priorities

| | |
|---|---|
| **P0** | Parser fixtures, regressions and an accuracy measurement |
| **P0** | Verify every citation against the stored analysis |
| **P0** | Tenant-isolation tests, runnable against a test database |
| **P1** | Symbol and full-text search |
| **P1** | Change impact analysis beyond a fixed depth |
| **P1** | Prompt-injection defences for untrusted repository content |
| **P1** | A public demo deployment, with screenshots and a recorded demo |

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
