# Development guide

Reproducible setup, the commands that exist, and how to extend each part of
the system.

---

## 1. Prerequisites

| Requirement | Version | Why |
|---|---|---|
| **Node.js** | **22.18 or newer** | The `scripts/` entry points run TypeScript directly, which needs Node's native type stripping. Unflagged from 22.18. Developed on 24.21.0. |
| **pnpm** | 10 | Pinned in `package.json` as `packageManager: "pnpm@10.32.1"`. |
| **Git** | any recent | |
| **Clerk** account | free tier is enough | Sign-in and organizations. |
| **Supabase** project | free tier is enough | Postgres, PostgREST, Realtime. |
| **A model provider** | optional | Only the Explain button needs one. |

No other tooling is required. There is no test framework, no linter beyond
ESLint, and no build step beyond Next.js.

### Verifying your Node version

```bash
node -v        # must be >= v22.18
pnpm -v        # 10.x
```

If `pnpm` is not installed: `npm install -g pnpm`.

---

## 2. Installation

```bash
git clone https://github.com/ravirraj/anatomy.git
cd anatomy
pnpm install
```

`pnpm install` also runs Next.js's postinstall, which generates the route
types the project uses.

---

## 3. Environment configuration

```bash
cp .env.example .env.local
```

`.env.local` is gitignored. **Never commit it.**

### 3.1 Clerk

1. Create an application at <https://dashboard.clerk.com>.
2. **API Keys** → copy the publishable key and the secret key into
   `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`.
3. **Configure → Sessions → Customize session token** → add:

   ```json
   { "org_name": "{{org.name}}" }
   ```

   The dashboard page reads that claim and throws
   `Session token has no org_name claim` without it.

4. **Configure → Organization settings** → **Enable Organizations**. Without
   it the Backend API returns `organization_not_enabled` and the app cannot
   create the team a first sign-in needs. It is worth setting
   **Create first organization automatically** on as well, so the organization
   exists before the app asks for it.
5. **Configure → Authentication** → enable a sign-in method. Email and GitHub
   are both fine.

### 3.2 Supabase

1. Create a project at <https://supabase.com>.
2. **Settings → API** → copy the **Project URL**, the **publishable key** and
   the **secret key** into `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`.
3. **Authentication → Sign In Providers → Third-Party Auth** → **Add provider**
   → **Clerk** → paste the Clerk domain shown on Clerk's Supabase integration
   setup page.

   This is what makes PostgREST accept Clerk's tokens. Without it every query
   fails with `PGRST301: No suitable key or wrong key type` — PostgREST is
   verifying an RS256 token against an HS256 secret.

   The integration also adds the `role: "authenticated"` claim that PostgREST
   needs in order to switch the database role from `anon` to `authenticated`.
   Without it the row-level security policies never apply.

### 3.3 A model provider

The default is OpenAI:

```env
OPENAI_API_KEY=sk-...
```

Any OpenAI-compatible endpoint works. Set a base URL and a key and the same
code serves it:

```env
# Google AI Studio's compatibility layer for Gemini
AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
AI_API_KEY=...
AI_MODEL_EXPLAIN=gemini-2.5-flash
AI_MODEL_CLASSIFY=gemini-2.5-flash-lite

# OpenRouter
AI_BASE_URL=https://openrouter.ai/api/v1
AI_API_KEY=...
AI_MODEL_EXPLAIN=google/gemma-4-31b-it:free
AI_MODEL_CLASSIFY=google/gemma-4-26b-a4b-it:free
```

`AI_API_KEY` takes precedence over `OPENAI_API_KEY`. `AI_MODEL_*` defaults to
OpenAI's pinned models when unset.

**The model name is part of every cache key.** Changing it invalidates only
the answers that model wrote, which is the intended behaviour — an answer from
one model must not be served for a question asked of another.

### 3.4 LangSmith (optional)

```env
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=...
LANGSMITH_PROJECT=anatomy
```

Without a key, tracing is off and the app **says so** in the explanation
pane, rather than behaving as if it were on.

---

## 4. Database

### 4.1 With the Supabase CLI

```bash
pnpm dlx supabase login
pnpm dlx supabase link --project-ref <your-project-ref>
pnpm dlx supabase db push
```

`db push` applies each migration in `supabase/migrations/` as a unit, in
filename order, and records it in `supabase_migrations.schema_migrations`. It is
re-runnable and will not double-apply.

### 4.2 By hand

The Supabase dashboard's SQL editor accepts the migrations in filename order.
They are ordinary SQL and need no extensions beyond what Supabase provides.

The eight migrations, in order:

| File | What it does |
|---|---|
| `20260928085353_schema.sql` | The core tables, the event trigger that enables RLS on every table in `public`, the grants, and the organization policies. |
| `20260928085423_revoke_rls_trigger_execute.sql` | Revokes EXECUTE on the RLS trigger function from `public`, `anon` and `authenticated`. |
| `20260928173315_pipeline.sql` | The run lifecycle: stages, the analysis columns, the `insert_edges` / `insert_file_roles` / `insert_routes` RPCs. |
| `20260928174534_progress_channel.sql` | The realtime policy and the trigger that publishes progress. |
| `20260928175808_rename_detected_projects.sql` | Renames `analyses.projects` to `analyses.detected_projects`, so it no longer collides with the `projects` table. |
| `20260928182115_roles_and_routes.sql` | The route and role columns. |
| `20260929065834_file_exports.sql` | The stored export names. |
| `20260929135235_ai_cache.sql` | The answer cache and its policy. |

### 4.3 Checking it worked

```bash
pnpm dlx supabase db push --db-url "postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres?sslmode=require"
```

Nine tables should exist, all with RLS enabled:

```sql
select tablename, rowsecurity from pg_tables
 where schemaname = 'public' order by tablename;
```

---

## 5. Running the development server

```bash
pnpm dev
```

<http://localhost:3000>. The first sign-in creates the organization and lands
you in the workspace.

### 5.1 Running the parser on its own

The parser needs no server, no database and no keys:

```bash
pnpm parse .
pnpm parse /path/to/some/repo --all     # every unresolved import, with its reason
```

This is the fastest way to see what the project does.

### 5.2 Running the pipeline from a script

```bash
pnpm analyze sindresorhus/p-limit --org <clerk-org-id>
pnpm analyze sindresorhus/p-limit --org <clerk-org-id> --rerun
```

The org id is a Clerk organization id, from the dashboard or from
`GET /v1/organizations`.

---

## 6. Tests and quality checks

```bash
pnpm test        # every suite; the content store's is included
pnpm lint        # ESLint
pnpm typecheck   # tsc --noEmit, after next typegen has made the route types
pnpm build       # production build, and the type check
pnpm check-links # every relative link and anchor in the documentation
```

`pnpm typecheck` runs `next typegen` before `tsc --noEmit`: `PageProps` and
`LayoutProps` are generated into `.next/types`, and a type-check that only
saw a stale `.next` fails on those as if they were real errors.

### 6.1 The test suites

Both are plain Node scripts that assert on real behaviour and exit non-zero on
failure, so they need no runner.

**`scripts/test-provider.ts`** — the AI layer, against a fake
OpenAI-compatible endpoint on localhost:

```bash
node scripts/test-provider.ts             # another provider
TEST_OPENAI=1 node scripts/test-provider.ts   # OpenAI's own API shape
```

It checks the request shape, that provider-specific parameters are only sent
to the provider that takes them, that the cache read is inside the traced call,
that the model is part of the cache key, and that a JSON-schema refusal falls
back to plain JSON mode.

**`scripts/test-explanation-store.ts`** — the explanation store:

```bash
node scripts/test-explanation-store.ts
```

It checks that answers survive a re-render, that a request in flight is not
stored as an answer, and that a store that cannot be written still works in
memory.

**`scripts/test-content-store.ts`** — the content store's logic, against a
fake of the few calls it makes:

```bash
node scripts/test-content-store.ts
```

It checks hashing from exact bytes, byte-for-byte round trips (binary
included), deduplication, cross-organization rows, absent reads, integrity
failures (a corrupted payload, a wrong size), refusal of malformed
identities, first-write-wins, oversized writes, and that a database failure
surfaces instead of half-working. It cannot prove the database's row
policies — that is what the next script is for.

**`scripts/test-content-rls.ts`** — the content store's tenant isolation,
against the **live** Supabase project (requires `supabase link` and login):

```bash
node --env-file=.env.local scripts/test-content-rls.ts
```

One transaction seeds two throwaway organizations and their content,
exercises every access path as a member (with PostgREST-shaped jwt claims)
and as the writer, and never commits — the database comes out as it went in,
which the script verifies. This is deliberately not part of `pnpm test`,
because `pnpm test` must run without a connected database and this one
touches the linked project.

**`scripts/test-content-pipeline.ts`** — the indexing pipeline's content
write, against a real parser over temporary fixture directories and a fake
of the exact database calls it makes:

```bash
node scripts/test-content-pipeline.ts
```

It checks that every indexed file ends `stored` (with skipped files carrying
no claim), that stored bytes are byte-for-byte the disk's and hash to the
files row's hash, that requests respect the chunk bounds, that duplicate
bodies collapse within and across runs with the stats counting it, that a
refused content request fails only its own chunk's files while a metadata
failure fails the run loudly, that retries repeat nothing, that a file
whose text is not the round trip of its bytes is stored through the exact
re-read fallback, and that tampered or missing candidate text is refused
instead of stored under a stale identity.

**`scripts/test-content-pipeline-db.ts`** — the wire behavior no fake can
prove, against the **live** Supabase project: the batched bytea write, in
one bulk request, with byte-for-byte reads back:

```bash
node --env-file=.env.local scripts/test-content-pipeline-db.ts
```

It writes into a throwaway test organization and, at the end, deletes that
organization — the content follows by the foreign key's cascade — and
verifies the database holds no row with a test organization id. Like the
RLS suite, this is deliberately not part of `pnpm test`.

**`scripts/check-links.mjs`** — the documentation's internal links:

```bash
pnpm check-links
```

It walks every markdown file, resolves every relative link, and checks that
every anchor it points at exists in the file it points to. A moved file or a
renamed heading fails rather than quietly breaking a page.

### 6.2 Testing the parser and the graph engine

The parser and the graph engine are pure functions, and the honest way to
test them is against real repositories:

```bash
pnpm parse <repo>            # coverage, edges, routes
pnpm parse <repo> --all      # every unresolved import
pnpm map-counts              # how many nodes the map would draw
pnpm insights                # cycles and other findings
```

There is no fixture corpus yet. Adding one is tracked in
[TODO.md](../TODO.md#2-implementation-and-validation).

---

## 7. Building for production

```bash
pnpm build
pnpm start
```

The build needs the environment variables to be set — `next.config.ts` asserts
on the required keys at boot, so a missing one fails the build with a message
naming it rather than surfacing later as a vague error on an unrelated page.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing environment variables (set them in .env.local)` at build | `lib/env.ts` asserts at boot | Fill in `.env.local`. |
| `ERROR: role "anon" does not exist` while applying migrations by hand | Applying outside Supabase | Supabase provides the `anon`, `authenticated` and `service_role` roles. Use the hosted project or the Supabase local stack. |
| `PGRST301: No suitable key or wrong key type` | Supabase cannot verify Clerk's tokens | Configure the Clerk third-party auth provider in Supabase. |
| `access denied - The organizations feature is not enabled` | Clerk organizations off | Enable Organizations in Clerk. |
| `Session token has no org_name claim` | The session token was not customized | Add `{"org_name": "{{org.name}}"}` to Clerk's session token. |
| `Relation "public.xxx" does not exist` | Migrations not applied | `pnpm dlx supabase db push`. |
| `relation "supabase_migrations.schema_migrations" does not exist` | The CLI has never run against this database | Expected before the first `db push`. |
| `Couldn't load analyses: ...` | A policy is denying the read, or the token has no organization | Check that an organization is active and that the row exists in `organizations`. |
| `OPENAI_API_KEY isn't set in .env.local, so nothing can be explained` | No model key | Set `OPENAI_API_KEY` or `AI_API_KEY`. |
| `It's already running` when re-running | A live run holds the claim | Wait for the 5-minute stale window, or let the current run finish. |
| The map is empty after submitting a repository | The repository has no JS/TS files, or the run failed | Check the analysis row: `status`, `stage` and `error` say what happened. |
| `p-limit` style rows with `found 0` | A Go or Python repository | Anatomy parses TypeScript and JavaScript only. |

### 8.1 Diagnosing a failed run

```sql
select status, stage, stage_message, error
  from public.analyses
 order by created_at desc limit 5;
```

The `error` column carries the reason, and `stage` says where it stopped.

### 8.2 Checking the policies directly

```sql
begin;
select set_config('request.jwt.claims',
  '{"o":{"id":"org_xxx"},"org_name":"Test"}', true);
set local role authenticated;
select organization_id, count(*) from public.analyses group by organization_id;
reset role;
commit;
```

This is what PostgREST does on every request, so it tests the policy exactly
as it is used.

---

## 9. Extending the system

### 9.1 Adding a framework adapter

Adapters live in `lib/parser/adapters/`. The interface is six methods:

```ts
export interface FrameworkAdapter {
  name: Framework;                                    // shown in the UI
  detect(project: ProjectInfo): boolean;              // by dependency name
  excludeDirectory(dir: string): string | null;       // project-relative
  reachedBy(path: string): string | null;             // project-relative
  roleOf(file: AdapterFile): Role | null;
  routes(project: ProjectFiles): RouteReport;
}
```

Every path an adapter is asked about is **relative to its project**, not the
repository.

To add one:

1. Write the adapter in `lib/parser/adapters/<name>.ts`.
2. Add its name to the `FRAMEWORK_ROLES` map in `lib/roles.ts`, and the roles
   it can assign to `ROLES` in the same file.
3. Register it in `ADAPTERS` in `lib/parser/adapters/index.ts`, **above**
   `fallbackAdapter` and in the right place relative to the others — frameworks
   built on React come before React, and Express comes after the frameworks
   that can run on it.
4. Test it against a real repository: `pnpm parse <repo>` and check the
   `Projects` line and the roles.

**On `routes`:** return `NO_ROUTES` unless the method *and* the full path are
both recoverable from the syntax. If they are not, return
`{ ...NO_ROUTES, withheld: "<the reason>" }` — a stated reason is worth far
more than an approximation. The existing adapters' withheld strings are the
best guide to the expected level of honesty.

### 9.2 Adding a graph feature

`lib/graph/` is pure: no Node imports, no `next/*`, no React, no database
client. A new module there must stay that way, or the browser cannot run it.

Add a function that takes the file list and/or the edge list and returns a
plain object. If it needs to render, the component that calls it lives in
`components/`.

### 9.3 Adding an AI capability

`lib/ai/client.ts` is the only place `openai` is imported. A client built
anywhere else would work and silently go untraced, so a new capability must
go through it.

A new task:

1. Add the input type and the message builder to `lib/ai/prompts.ts`.
2. Add the task to `lib/ai/tasks.ts`. The shape is fixed: a `traceable`
   function whose **first** action is the cache read, so a cache hit is a
   recorded run with no model call in it.
3. Add the task name to the `Task` union. It is part of the cache key.
4. If the task needs context, build it in `lib/analysis/context.ts` — from the
   stored analysis, never from the request.

**On prompts:** the model may explain and label. It may not decide that two
files are connected, and it may not walk the graph. Every path it sees must
have been handed to it. A prompt that lets the model name a file it was not
given is a prompt that will produce an invented path.

### 9.4 Adding a language

This is the largest change and the one most likely to be done badly. The
boundary is drawn in `CODE_EXTENSIONS` in `lib/parser/walk.ts` and enforced in
`lib/parser/resolve.ts`.

**Do not** extend `CODE_EXTENSIONS` and hope. The parser is ts-morph: it
parses TypeScript and JavaScript, and nothing else. A Python file handed to
ts-morph produces a syntax error and is skipped as `syntax-error`, which
reports a problem rather than solving one.

The work is:

1. **A parser for the language**, producing the same shape the graph engine
   expects: a list of files and a list of edges.
2. **A resolver for the language**, answering the same questions the TypeScript
   resolver answers, with its own reasons.
3. **A normalized intermediate representation**, so the graph engine, the
   adapters and the AI layer do not need to know which language a file is in.
   `lib/parser/types.ts` currently has no language field; that is the first
   change.
4. **Fixtures**, and a test that runs the whole pipeline over them.

The reasoning, and the plan for each candidate language, is in
[TODO.md](../TODO.md#4-multi-language-and-framework-support).

### 9.5 Changing the schema

Add a migration in `supabase/migrations/`, named `YYYYMMDDHHMMSS_what.sql` —
the timestamp prefix is the order, and the CLI relies on it.

A migration that adds a table must not add a policy that assumes a column
that does not exist yet. RLS is enabled automatically by the event trigger, so
a new table is protected from the moment it is created — but it is also
invisible until a policy is added.

If a new column is read by application code, update
`lib/supabase/database.types.ts` in the same change, or the TypeScript will
not know about it.

---

## 10. Conventions

- **Strict TypeScript, no `any`.** If a type is genuinely awkward, say so
  rather than casting.
- **Comment the decisions, not the syntax.** The comment should say why, and
  what the alternative was.
- **One obvious way to do something beats a configurable one.**
- **The parsing code cannot import Next.js, React or the database client.**
- **No framework checks inside the parser.** That knowledge lives in an
  adapter.
- **Graph calculations are pure functions** over a file list and an edge list.
- **Database access happens in server code**, not inside components.
- **Who may read a row is decided by a policy**, never by application code.
- **One place constructs the AI client.**
- **Never decide that two files are connected.** An edge exists because the
  parser resolved a real import to a real file. Unresolved gets reported with
  a reason, never guessed.
- **Never invent something to fill a gap.** Skipped file? Say so and count it.
  Route not fully recoverable? Show none.
- **The UI is a dense developer tool.** Small type, tight spacing, monospace
  for file paths. Colour means something or it is not there. Nothing moves
  unless it was clicked.

These are restated in full, with the reasoning, in
[CLAUDE.md](../CLAUDE.md) and [docs/project-doc.md](project-doc.md).
