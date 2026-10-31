// Runs the content RLS integration test against the local or linked Supabase project —
// the real database, because no fake client can prove what a row policy does.
//
//   node --env-file=.env.local scripts/test-content-rls.ts
//   (automatically targets local Supabase when .env.local points to localhost,
//    or linked Supabase when pointing to remote)
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
import { readFileSync } from "node:fs";

const isLocal =
  process.argv.includes("--local") ||
  process.env.SUPABASE_LOCAL === "true" ||
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1")) ||
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("localhost"));

function getEnv(): NodeJS.ProcessEnv {
  const currentPath = process.env.PATH ?? "";
  const extra = ["C:\\Program Files\\Docker\\Docker\\resources\\bin"];
  const newPath = [extra.filter((p) => !currentPath.includes(p)).join(";"), currentPath].filter(Boolean).join(";");
  return { ...process.env, PATH: newPath };
}

function query(file: string): unknown {
  if (isLocal) {
    const sql = readFileSync(file, "utf8");
    const stdout = execSync('docker exec -i supabase_db_cartograph psql -U postgres -d postgres -t -A -F "\t"', {
      input: sql,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: getEnv(),
    });
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (file.endsWith("test-content-rls-after.sql")) {
      const lastLine = lines[lines.length - 1];
      const [contents, test_orgs] = (lastLine ?? "0\t0").split("\t").map(Number);
      return [{ contents, test_orgs }];
    }

    const rows = lines
      .filter((l) => /\t(t|f)\t/.test(l) || /\t(t|f)$/.test(l))
      .map((l) => {
        const [name, pass, detail] = l.split("\t");
        return {
          name,
          pass: pass === "t",
          detail: detail ? detail : null,
        };
      });
    return rows;
  }

  // The CLI speaks JSON on stdout; "Initialising login role..." goes to stderr.
  const command = ["supabase", "db", "query", "--linked", "--file", file].join(" ");
  const stdout = execSync(command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: getEnv(),
    shell: process.platform === "win32" ? "cmd.exe" : undefined, // supabase is an npm .cmd shim here
  });
  return (JSON.parse(stdout) as { rows?: unknown[] }).rows ?? [];
}

type CheckRow = { name: string; pass: boolean; detail: string | null };

function fail(message: string): never {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

const rows = query("scripts/test-content-rls.sql") as CheckRow[];
if (rows.length === 0) fail("no check rows came back — every property must report a row");
console.log(`content RLS integration, ${rows.length} checks against the ${isLocal ? "local" : "linked"} database:`);

for (const { name, pass, detail } of rows) {
  console.log(`${pass ? "ok   " : "FAIL "} ${name}${detail == null ? "" : ` (${detail})`}`);
}
const failed = rows.filter((r) => !r.pass);
if (failed.length > 0) fail(`${failed.length} of ${rows.length} check(s) failed`);

// After the test transaction: nothing may remain. The script never commits,
// so the seeds — test organizations, test content, the cascade delete — are
// gone with the connection.
const [state] = query("scripts/test-content-rls-after.sql") as {
  contents: number;
  test_orgs: number;
}[];
if (state.contents !== 0 || state.test_orgs !== 0) {
  fail(`the test transaction left things behind: ${state.contents} content row(s), ${state.test_orgs} test organization(s)`);
}

console.log(`\nThe ${isLocal ? "local" : "linked"} database was left untouched, and every security property held.`);
