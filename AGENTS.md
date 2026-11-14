<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Anatomy — instructions for coding agents

Anatomy reads a public GitHub repository and draws it as a dependency map
that answers questions with citations to real source lines. These rules exist
so that any agent can resume work without losing context, and so that no
agent invents state that is not in the repository.

## 1. Read before changing anything

Before your first code change, read — in this order:

1. **[docs/PROJECT_STATE.md](docs/PROJECT_STATE.md)** — what is in progress,
   what is uncommitted, the verified Git state, and the exact next approved
   task. Start here every session; it is the first thing an agent must trust
   and the first thing an agent must re-verify.
2. **[docs/ROADMAP.md](docs/ROADMAP.md)** — the eight-phase delivery
   programme and which phase the current work belongs to.
3. **[docs/DECISIONS.md](docs/DECISIONS.md)** — why the system is the way it
   is, and which decisions are still open. Do not silently reopen a recorded
   decision.
4. **[docs/architecture.md](docs/architecture.md)** — how the system is built
   (note: on a case-insensitive filesystem this file *is* the canonical
   architecture document; `docs/ARCHITECTURE.md` cannot coexist with it).
5. **[CLAUDE.md](CLAUDE.md)** — the working rules of the project.
6. **[TODO.md](TODO.md)** — the authoritative task list with acceptance
   criteria.
7. **[docs/features.md](docs/features.md)** — what is implemented vs planned;
   the two are never mixed.

## 2. Audit the real state; never trust the documents blindly

- Verify branch, commits, and working-tree state with Git (`git log --oneline
  -5`, `git status --porcelain`) before recording or relying on them.
- Verify every claimed behaviour against the code and the tests, not against
  the prose. Run the verification commands yourself.
- If the documents and the repository disagree, **fix the documents** in your
  change and say so — a confidently wrong document is worse than no document.

## 3. Scope, commits, pushes

- Work only the task you were approved to do. Do not expand scope, refactor
  opportunistically, or install dependencies without explicit approval.
- Do not commit. Do not push. Both require explicit user approval for each
  act — approval for one change is not approval for the next.
- Leave the working tree in a state the next agent can understand: every
  modification is either verified and recorded in [docs/PROJECT_STATE.md](docs/PROJECT_STATE.md),
  or reverted.

## 4. Completion needs evidence

- Never mark work done without running the verification commands (`pnpm test`,
  `pnpm typecheck`, `pnpm lint`, and `pnpm test:budget` where budgets are
  touched) **after** the last relevant change, and recording their results.
- Demonstrating that a new test fails against the old implementation is part
  of the evidence.

## 5. After every approved implementation subphase

- Update **[docs/PROJECT_STATE.md](docs/PROJECT_STATE.md)** — stage, work
  state, Git state, exact next task, blockers.
- Update **[docs/ROADMAP.md](docs/ROADMAP.md)** — the phase's status.
- Record important decision changes in **[docs/DECISIONS.md](docs/DECISIONS.md)**.
- Update **[docs/architecture.md](docs/architecture.md)** when the
  architecture itself changed (data flow, subsystem seams, taxonomy).
- Record tests and verification results, unfinished work, and the exact next
  task, so an agent that stops unexpectedly can resume from the documents
  alone.
