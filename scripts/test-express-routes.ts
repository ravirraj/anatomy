// Express route extraction, against the express-routes fixture and the real
// parser. Every route record asserted here is produced by parseRepository on
// the fixture repository, not by mocked rows.
//
// Cases covered (Phase 4 Batch 4):
//   A. basic app.get/post/put/delete on an express() app
//   B. routes declared on an express Router()
//   C. mounted-router prefixes composed into the final pattern
//   D. parameterized paths preserved verbatim
//   E. methods GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD/ALL
//   F. retrieval — see Section 9 of scripts/test-retrieval.ts
//   G. regression guards: no routes invented from unknown receivers,
//      unsupported patterns degrade to explicit `omitted` entries, duplicate
//      registrations deduplicate deterministically, symbols unaffected

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseRepository } from "../lib/parser/index.ts";
import { FIXTURES } from "./test-fixtures-shared.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);
function expect(condition: boolean, message: string): void {
  if (condition) pass(message);
  else fail(message);
}

const repo = path.join(FIXTURES, "express-routes", "repo");
const result = parseRepository(repo);
const routes = result.routes;
const omitted = result.coverage.routes.omitted;

/** 1-based line of the first occurrence of a needle in a fixture file. */
function lineOf(file: string, needle: string): number {
  const text = readFileSync(path.join(repo, file), "utf8");
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`needle not found in ${file}: ${needle}`);
  return text.slice(0, index).split("\n").length;
}

// Every expected route as `${method} ${pattern} ${file}`, with the line each
// registration call sits on.
const expectedRoutes: { key: string; file: string; line: number }[] = [
  // app.js: direct app routes (A, D), plus the DELETE-only path used by the
  // retrieval tests for wrong-method queries (Section 9 of test-retrieval.ts)
  { key: "GET /health app.js", file: "app.js", line: lineOf("app.js", `app.get("/health"`) },
  { key: "GET /users/:userId/posts/:postId app.js", file: "app.js", line: lineOf("app.js", `app.get("/users/:userId/posts/:postId"`) },
  { key: "DELETE /sessions/:sessionId app.js", file: "app.js", line: lineOf("app.js", `app.delete("/sessions/:sessionId"`) },
  // routes/users.js: Router() routes composed with their mount chain
  // app.use("/api", apiRouter) + router.use("/users", usersRouter) (B, C)
  { key: "GET /api/users routes/users.js", file: "routes/users.js", line: lineOf("routes/users.js", `router.get("/",`) },
  { key: "POST /api/users routes/users.js", file: "routes/users.js", line: lineOf("routes/users.js", `router.post("/",`) },
  { key: "GET /api/users/:userId routes/users.js", file: "routes/users.js", line: lineOf("routes/users.js", `router.get("/:userId"`) },
  { key: "PUT /api/users/:userId routes/users.js", file: "routes/users.js", line: lineOf("routes/users.js", `router.put(`) },
  { key: "DELETE /api/users/:userId routes/users.js", file: "routes/users.js", line: lineOf("routes/users.js", `router.delete(`) },
  // routes/posts.js: every supported method, array paths, dedup (E, G)
  // GET /api/posts is registered twice; the dedup keeps the last occurrence.
  { key: "GET /api/posts routes/posts.js", file: "routes/posts.js", line: lineOf("routes/posts.js", `router.get("/posts", listPostsCached)`) },
  { key: "POST /api/posts routes/posts.js", file: "routes/posts.js", line: lineOf("routes/posts.js", `router.post("/posts"`) },
  { key: "PATCH /api/posts/:postId routes/posts.js", file: "routes/posts.js", line: lineOf("routes/posts.js", `router.patch(`) },
  { key: "OPTIONS /api/posts routes/posts.js", file: "routes/posts.js", line: lineOf("routes/posts.js", `router.options(`) },
  { key: "HEAD /api/posts routes/posts.js", file: "routes/posts.js", line: lineOf("routes/posts.js", `router.head(`) },
  { key: "ALL /api/ping routes/posts.js", file: "routes/posts.js", line: lineOf("routes/posts.js", `router.all(`) },
  { key: "GET /api/archive routes/posts.js", file: "routes/posts.js", line: lineOf("routes/posts.js", `["/archive", "/feed"]`) },
  { key: "GET /api/feed routes/posts.js", file: "routes/posts.js", line: lineOf("routes/posts.js", `["/archive", "/feed"]`) },
];

const actualKeys = new Set(routes.map((r) => `${r.method} ${r.pattern} ${r.file}`));
const expectedKeys = new Set(expectedRoutes.map((r) => r.key));

expect(
  actualKeys.size === routes.length && expectedKeys.size === expectedRoutes.length,
  `route records are deduplicated (${routes.length} records for ${expectedRoutes.length} registrations minus 1 known duplicate)`,
);

const missing = expectedRoutes.filter((r) => !actualKeys.has(r.key));
const extra = routes.filter((r) => !expectedKeys.has(`${r.method} ${r.pattern} ${r.file}`));
expect(missing.length === 0, `every expected route is extracted${missing.length ? `: missing ${missing.map((r) => r.key).join(", ")}` : ""}`);
expect(extra.length === 0, `no unexpected route records${extra.length ? `: extra ${extra.map((r) => `${r.method} ${r.pattern} ${r.file}`).join(", ")}` : ""}`);

// A. The app's own routes carry their file and the registration's line.
for (const expected of expectedRoutes) {
  const actual = routes.find((r) => `${r.method} ${r.pattern} ${r.file}` === expected.key);
  if (!actual) continue;
  expect(actual.line === expected.line, `${expected.key} sits on line ${expected.line}`);
}

// B + C. Router routes compose the mounted prefixes: the users router is
// mounted through app.use("/api", apiRouter) and router.use("/users", ...),
// so its own "/:userId" is stored as "/api/users/:userId".
expect(
  routes.some((r) => r.method === "GET" && r.pattern === "/api/users/:userId" && r.file === "routes/users.js"),
  "the mounted users router's /:userId is stored as /api/users/:userId",
);

// D. Parameterized paths are preserved verbatim, both segments and names.
expect(
  routes.some((r) => r.pattern === "/users/:userId/posts/:postId"),
  "the two-parameter path /users/:userId/posts/:postId is preserved verbatim",
);
expect(
  routes.some((r) => r.pattern === "/api/posts/:postId"),
  "the single-parameter path /api/posts/:postId is preserved verbatim",
);

// E. Every supported method appears, upper-case.
const methods = new Set(routes.map((r) => r.method));
for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "ALL"]) {
  expect(methods.has(method), `the ${method} method is indexed`);
}
expect(methods.size === 8, "no method outside the supported set is invented");

// G. Unsupported patterns degrade to explicit omitted entries, never guesses.
const expectedOmitted: { file: string; line: number; reason: string }[] = [
  // A registration whose path argument isn't a string literal.
  {
    file: "routes/posts.js",
    line: lineOf("routes/posts.js", "router.get(unlistedPath"),
    reason: "router.get() is given a path that isn't a string literal",
  },
  {
    file: "routes/posts.js",
    line: lineOf("routes/posts.js", "router.delete(`"),
    reason: "router.delete() is given a path that isn't a string literal",
  },
  // A router that nothing mounts: its full paths are unknowable.
  {
    file: "routes/orphan.js",
    line: lineOf("routes/orphan.js", `router.get("/secret"`),
    reason: "the router it's registered on is never mounted",
  },
  {
    file: "routes/orphan.js",
    line: lineOf("routes/orphan.js", `router.post("/secret"`),
    reason: "the router it's registered on is never mounted",
  },
  // A mount whose path isn't a string literal.
  {
    file: "routes/misc.js",
    line: lineOf("routes/misc.js", `router.get("/misc"`),
    reason: "the router it's registered on is mounted at a path that isn't a string literal",
  },
];
const actualOmitted = new Map(omitted.map((o) => [`${o.file} ${o.line}`, o.reason]));
for (const expected of expectedOmitted) {
  const reason = actualOmitted.get(`${expected.file} ${expected.line}`);
  expect(
    reason === expected.reason,
    `${expected.file}:${expected.line} is explicitly omitted ("${expected.reason}")${reason === undefined ? " — missing" : reason === expected.reason ? "" : ` — got "${reason}"`}`,
  );
}
expect(
  omitted.length === expectedOmitted.length,
  `no omitted entry beyond the known unsupported ones (got ${omitted.length})`,
);

// The withholding is gone: the Express project answers for its routes.
expect(
  result.coverage.routes.withheld.length === 0,
  "nothing is withheld any more",
);

// Storage compatibility: every record matches the routes table's columns and
// the contract validator's rules.
expect(
  routes.every((r) => /^[A-Z]+$/.test(r.method) && r.pattern.startsWith("/") && r.line >= 1
    && result.files.some((f) => f.path === r.file)),
  "every route record is storage-compatible (upper-case method, /-rooted pattern, real file, line)",
);

// G. Symbols are unaffected: the route handlers are still indexed functions.
expect(
  result.symbols.some((s) => s.name === "createUser" && s.file === "routes/users.js"),
  "route handlers are still indexed as symbols",
);

// Determinism: two parses agree byte for byte on the route slice.
const first = JSON.stringify(result.routes);
const second = JSON.stringify(parseRepository(repo).routes);
expect(first === second, "two parses produce identical route records");

// --- Conservative contract for sources the parser can't fully read ---
// 1. Any code file left unparsed withholds the whole project's routes. A
//    route record is a claim about the full served path, and an unparsed
//    file could mount any exported router under another prefix at runtime —
//    nothing in the parsed syntax can prove it doesn't, for any skip reason
//    (unreadable, oversized, binary, and even syntax-error files are all
//    loadable by a running Node process). Scoping the uncertainty to
//    "relevant" files is not possible: which modules an unreadable file
//    requires is exactly the information it withholds.
// 2. A mount whose module can't be resolved is ignored: it invents no route
//    and hides none.
{
  const { cpSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "express-routes-"));
  try {
    cpSync(repo, dir, { recursive: true });
    writeFileSync(path.join(dir, "broken.js"), "const = ;\n");
    const withUnparsed = parseRepository(dir);
    expect(
      withUnparsed.routes.length === 0
        && withUnparsed.coverage.routes.withheld.length === 1
        && withUnparsed.coverage.routes.withheld[0]!.project === ".",
      "an unparsed file withholds the project's routes rather than stating partial patterns",
    );

    rmSync(path.join(dir, "broken.js"), { force: true });
    writeFileSync(path.join(dir, "app.js"), readFileSync(path.join(repo, "app.js"), "utf8").replace(
      "app.use(miscMount, miscRouter);",
      'app.use("/ghost", require("./does-not-exist"));\napp.use(miscMount, miscRouter);',
    ));
    const withGhost = parseRepository(dir);
    expect(
      withGhost.coverage.routes.withheld.length === 0
        && withGhost.routes.length === routes.length
        && withGhost.routes.every((r) => !r.pattern.startsWith("/ghost")),
      "an unresolved mount is ignored: no invented routes, known routes retained",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("");
for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
if (failed > 0) process.exit(1);
