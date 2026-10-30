# Fixture corpus

A regression suite for the parser. Each directory here is a tiny repository
with a known, verified parse result. On every build,
[scripts/test-fixtures.ts](../scripts/test-fixtures.ts) runs the parser over
each fixture and compares its output, byte for byte, with
`<fixture>/expected.json`.

## Layout

```
fixtures/
  <fixture-name>/
    repo/            the fixture repository, exactly as a GitHub archive extracts
    expected.json    the parser's expected output for repo/
```

The expected file is the parser's own `serializeParseResult` output with the
absolute root replaced by `"<repo>"`, so it is machine-independent. The test
round-trips it through the contract validator before comparing.

## Changing a fixture

A changed result is a **failing test**, never a diff to review silently. When
you change a fixture's source — or deliberately change the parser, and the new
behavior is correct — re-baseline it on purpose:

```
node scripts/test-fixtures.ts --update <fixture-name>
node scripts/test-fixtures.ts        # confirm everything passes
```

Without names, `--update` re-baselines every fixture. Fixtures are excluded
from the project's own lint and type-check: their imports can be broken on
purpose, because an unresolved import is exactly one of the things the corpus
pins down.

## What each fixture covers

| Fixture | Covers |
|---|---|
| `path-aliases` | A `tsconfig.json` `paths` alias resolving internally, and an alias whose target does not exist (`alias-target-not-found`). |
| `commonjs` | `require()` internal and builtin, `module.exports` exports. |
| `barrel-index` | `export *`, named re-exports and default re-exports through a barrel, and an import through it. |
| `nextjs-app-router` | Next.js App Router detection, page and route-handler roles, `reachedBy`, and route patterns from folder structure. |
| `dynamic-import` | A literal dynamic import resolving to a `dynamic-import` edge, and a computed specifier left unresolved (`non-literal-dynamic-import`). |
| `nextjs-pages-router` | Pages Router detection: `_app` as a custom App, nested dynamic pages as `page-route`, and a `pages/api` handler reported as omitted rather than invented (a handler chooses its method at runtime). |
| `two-framework-monorepo` | Two workspace packages, each detected by its own framework (`NestJS`, `Next.js`) independently of the other; roles per project; routes from a controller's decorators; no edge crossing a package boundary. |
| `base-url` | `tsconfig` `baseUrl` resolution of a bare specifier, a first-segment miss reported as unresolved (`file-not-found` against `baseUrl`), and an unmatchable bare name reported as an external package. |
| `export-import-equals` | `export =` of an object and of an identifier (`module.exports` whole-module naming), `import x = require()` read once as a declaration, and CommonJS `require()` landing on a `.ts` module. |
| `unlinked-workspaces` | A workspace package a `package.json` of the repository declares but no `node_modules` links (`workspace-package-not-linked`), an undeclared name as an external package, and unlinked packages producing no projects and no fabricated edges. |

## How accurate is the parser

`pnpm accuracy` measures dependency-resolution correctness against hand-verified
ground truth: [accuracy.json](accuracy.json), which records the internal
dependency relationships each fixture truly holds — verified from the
fixture's own sources when the fixture was written, and updated the same way
if the fixture changes. The comparison is at the level of `(source, target)`
pairs, deduplicated: which edge kind carries a relationship is the regression
suite's business, not this. Unresolved, external and excluded imports produce
no internal edge and are out of scope on both sides by definition.

The run reports per-fixture and aggregate TP, FP, FN, precision, recall and
F1, with zero denominators defined as 1 ("nothing was claimed and nothing was
missed"). The aggregate floor is the named constant `MINIMUM_F1` in
[scripts/accuracy-fixtures.ts](../scripts/accuracy-fixtures.ts) — 1, the
corpus's observed baseline. A change below the floor fails the run; changing
the floor is an edit to that line, made deliberately.

Adding a fixture means adding ground truth for it: the accuracy run fails any
fixture that appears without a ground-truth entry, so that a corpus the
evaluation does not know is an error, not a silent gap.


## Adding one

Copy the smallest fixture above, edit `repo/` to exercise the new pattern, run
the test once per the failure message, inspect the new `expected.json` so you
can claim every line of it, then record its hand-verified internal
relationships in [accuracy.json](accuracy.json) and commit all three — `repo/`,
`expected.json`, the ground truth — together. A fixture whose expected output
you cannot explain is not verified.
