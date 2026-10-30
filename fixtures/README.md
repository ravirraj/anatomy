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

## Adding one

Copy the smallest fixture above, edit `repo/` to exercise the new pattern, run
the test once per the failure message, inspect the new `expected.json` so you
can claim every line of it, then commit both. A fixture whose expected output
you cannot explain is not verified.
