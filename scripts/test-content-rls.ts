// Runs the content RLS integration test against the LINKED Supabase project —
// the real database, because no fake client can prove what a row policy does.
//
//   node --env-file=.env.local scripts/test-content-rls.ts
//   (requires supabase CLI login and a linked project: supabase link ...)
//
// What runs: scripts/test-content-rls.sql, one transaction that seeds two
// throwaway organizations and their content, exercises every access path as
// a member role (jwt claims, as PostgREST presents them) and as the writer,
// and ends on a select — never committing, so the database comes out exactly
// as it went in. This script then reads the checks' rows, demands every pass,
// and re-queries the database to show nothing was left behind.
//
// Deliberately NOT part of pnpm test: the default suite must run without a
// connected database, and this one touches one.

import { execSync } from "node:child_process";

function query(args: string[]): unknown {
  // The CLI speaks JSON on stdout; "Initialising login role..." goes to stderr.
  const command = ["supabase", "db", "query", "--linked", ...args].join(" ");
  const stdout = execSync(command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: process.platform === "win32" ? "cmd.exe" : undefined, // supabase is an npm .cmd shim here
  });
  return (JSON.parse(stdout) as { rows?: unknown[] }).rows ?? [];
}

type CheckRow = { name: string; pass: boolean; detail: string | null };

function fail(message: string): never {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

const rows = query(["--file", "scripts/test-content-rls.sql"]) as CheckRow[];
if (rows.length === 0) fail("no check rows came back — every property must report a row");
console.log(`content RLS integration, ${rows.length} checks against the linked database:`);

for (const { name, pass, detail } of rows) {
  console.log(`${pass ? "ok   " : "FAIL "} ${name}${detail == null ? "" : ` (${detail})`}`);
}
const failed = rows.filter((r) => !r.pass);
if (failed.length > 0) fail(`${failed.length} of ${rows.length} check(s) failed`);

// After the test transaction: nothing may remain. The script never commits,
// so the seeds — test organizations, test content, the cascade delete — are
// gone with the connection.
const [state] = query(["--file", "scripts/test-content-rls-after.sql"]) as {
  contents: number;
  test_orgs: number;
}[];
if (state.contents !== 0 || state.test_orgs !== 0) {
  fail(`the test transaction left things behind: ${state.contents} content row(s), ${state.test_orgs} test organization(s)`);
}

console.log("\nThe linked database was left untouched, and every security property held.");
