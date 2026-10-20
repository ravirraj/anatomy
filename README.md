<div align="center">

# Anatomy

**Turn any public TypeScript or JavaScript repository into an interactive dependency map.**

Paste a repo URL. Anatomy parses it for real, folds it into folders, draws
the imports as edges, and answers questions about the structure without ever
guessing that two files are connected.

<br />

<img src="https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=nextdotjs&logoColor=white" />
<img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" />
<img src="https://img.shields.io/badge/Tailwind-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white" />
<img src="https://img.shields.io/badge/Clerk-6C47FF?style=flat-square&logo=clerk&logoColor=white" />
<img src="https://img.shields.io/badge/Supabase-3FCF8E?style=flat-square&logo=supabase&logoColor=white" />
<img src="https://img.shields.io/badge/LangSmith-1C1C1C?style=flat-square&logo=langchain&logoColor=white" />
<img src="https://img.shields.io/badge/pnpm-10-F69220?style=flat-square&logo=pnpm&logoColor=white" />

</div>

---

## Why

Codebases now routinely contain code nobody on the team has read. An agent wrote
it, someone confirmed it worked, it shipped. It works — and it accumulates
structure nobody chose. Files that import through three layers of re-exports. A
utility forty files depend on. A module nothing has referenced in months.

The questions that follow are structural. *What is this file? What depends on
it? What breaks if I change it?* Answering them today means reading imports
one file at a time and holding the results in your head, which stops working
around thirty files and stops being attempted at all somewhere past a hundred.

Anatomy answers them by parsing the code, not by asking a model to describe
it.

## The rule everything rests on

> **Every box and every line on the canvas comes from really parsing the code.**

The AI may explain and label. It may never decide that two files are connected,
and it may never walk the graph when arithmetic can do it instead.

A dependency graph that is ninety percent right is worse than no graph, because
there's no way to tell which ten percent is wrong. The moment a model is allowed
to guess at an edge, every edge becomes a *maybe*, and the product becomes a
nice-looking picture.

## Features

- **Real AST parsing.** `ts-morph` reads source files and turns imports,
  re-exports, dynamic `import()` and `require()` calls into edges. Nothing is
  inferred from naming conventions alone.
- **Honest coverage.** Every skipped file is reported with a reason and a count.
  A file that couldn't be parsed is never quietly dropped.
- **Interactive canvas.** Folders fold into boxes, boxes expand into files, and
  the layout is computed with dagre. Select anything to see its real neighbours.
- **Blast radius.** Pure arithmetic over the edge list: what breaks two levels
  out if this file changes.
- **Grounded explanations.** A file is explained from its actual imports and
  importers. Every path mentioned in the prose becomes a link that moves the
  map.
- **Route table.** Recovered from syntax only. A route whose method *and* full
  path can't both be recovered is shown as nothing, because a wrong route is
  the same failure as an invented edge.
- **Live progress.** Parsing a real repository is not instant, so the pipeline
  reports stages as it goes.
- **Multi-tenant by policy.** Rows belong to an organization and row-level
  security reads the organization off the Clerk token. Signing in from another
  organization means the first one's rows are absent from the query, not
  filtered out by the interface.
- **Traced and cached AI.** Every model call is traced, and the cache read
  happens *inside* the traced call — so a cache hit appears as a recorded run
  containing no model call. A cache nobody can verify is just a cache.

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | [Next.js 16](https://nextjs.org/) App Router, React 19, strict TypeScript |
| Parsing | [ts-morph](https://ts-morph.com/) over the TypeScript compiler API |
| Canvas | [@xyflow/react](https://reactflow.dev/) with [dagre](https://github.com/dagrejs/dagre) for layout |
| Identity | [Clerk](https://clerk.com/) — sign-in and organizations |
| Database | [Supabase](https://supabase.com/) Postgres with RLS on by default |
| AI | [OpenAI](https://platform.openai.com/) through one wrapped client |
| Observability | [LangSmith](https://smith.langchain.com/) |
| Styling | [Tailwind CSS v4](https://tailwindcss.com/) |
| Tooling | pnpm, ESLint 9 |

## Getting started

**Prerequisites:** [Node.js](https://nodejs.org/en) 20+, [pnpm](https://pnpm.io/),
a [Clerk](https://clerk.com/) application, a [Supabase](https://supabase.com/)
project, and an [OpenAI](https://platform.openai.com/) API key.

```bash
git clone https://github.com/<your-username>/anatomy.git
cd anatomy
pnpm install
```

### Environment

Copy the example file and fill in the values:

```bash
cp .env.example .env.local
```

```env
# CLERK
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=

# SUPABASE
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=

# LANGSMITH
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=
LANGSMITH_PROJECT=anatomy
LANGSMITH_ENDPOINT=https://api.smith.langchain.com

# OPENAI
OPENAI_API_KEY=
```

A missing key stops the server at boot rather than surfacing later as a vague
error on an unrelated screen, so fill these in before you start.

### Database

Apply the migrations in `supabase/migrations/` in filename order — the schema,
then the pipeline tables, then the AI cache. They enable row-level security on
every table and create the policies that read the organization claim off the
Clerk token.

### Run it

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000), sign in, and paste a
public repository URL.

## Scripts

```bash
pnpm dev           # the web app
pnpm build         # production build
pnpm lint          # eslint

pnpm parse <dir>   # parse a directory and print what was found
pnpm map-counts    # how many nodes the map would draw
pnpm insights      # cycles and other structural findings
pnpm analyze       # run the pipeline from a plain script
```

`pnpm parse` needs no API keys at all — the parser is a standalone module that
takes a path and returns files, edges and a coverage report. That's the point:
if it can't run on its own, the layering is wrong.

```
$ pnpm parse .
Projects  . (Next.js)
Files     found 82  parsed 80  skipped 2
Folders   19 distinct modules
Imports   seen 278  internal 187  external 90  unresolved 0
Edges     187 after removing duplicates (54 type-only)
```

## How it's laid out

```
app/          routes and server actions
components/   the map, the panes, the progress views
lib/
  parser/     AST parsing — standalone, no framework imports
    adapters/ framework knowledge (Next.js, React, Nest, Express, Docusaurus)
  graph/      pure functions over a file list and an edge list
  ai/         the one place the model client is constructed
  pipeline/   download, parse, store, report progress
  analysis/   loading an analysis and building model context
  supabase/   clients that respect, or explicitly bypass, the policies
docs/         the product decisions, and one spec per phase
supabase/     migrations
scripts/      command-line entry points
```

Four rules hold the shape together:

1. **The parser can't import Next, React or the database client.** Path in,
   data out, runnable from a plain script.
2. **No framework checks inside the parser.** That knowledge lives in an
   adapter, which is why adding a framework doesn't touch parsing code.
3. **Graph calculations are pure functions** over a file list and an edge list.
4. **Who may read a row is decided by a policy**, never by application code. If
   a query needs a `where` clause to return the right rows, the policy is
   wrong.

## License

Add a license before publishing this anywhere.
