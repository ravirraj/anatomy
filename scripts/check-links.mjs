// Checks every relative link in the markdown files: the file it points at
// exists, and the anchor inside it exists.
//
//   node scripts/check-links.mjs

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SKIP = new Set(["node_modules", ".git", ".next", ".agents", ".claude", "public"]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

// GitHub's anchor rules: lowercase, drop punctuation except dashes and
// underscores, spaces become dashes.
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/\s+/g, "-");
}

function anchorsOf(file) {
  const body = readFileSync(file, "utf8");
  const anchors = new Set();
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) anchors.add(slug(m[2].replace(/`/g, "")));
  }
  return anchors;
}

const files = walk(ROOT);
const problems = [];
let checked = 0;

for (const file of files) {
  const body = readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file);
  // Strip fenced code blocks so examples are not checked.
  const clean = body.replace(/```[\s\S]*?```/g, "");
  for (const m of clean.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const target = m[2];
    if (/^(https?:|mailto:|#)/.test(target)) {
      if (target.startsWith("#")) {
        const anchors = anchorsOf(file);
        if (!anchors.has(target.slice(1))) problems.push(`${rel}: anchor ${target} not found in the same file`);
      }
      continue;
    }
    const [filePart, anchor] = target.split("#");
    const resolved = path.resolve(path.dirname(file), filePart);
    checked++;
    if (!existsSync(resolved)) {
      problems.push(`${rel}: ${target} -> ${path.relative(ROOT, resolved)} does not exist`);
      continue;
    }
    if (anchor && resolved.endsWith(".md")) {
      const anchors = anchorsOf(resolved);
      if (!anchors.has(anchor)) {
        problems.push(`${rel}: ${target} -> anchor "#${anchor}" not found in ${path.relative(ROOT, resolved)}`);
      }
    }
  }
}

console.log(`checked ${checked} relative links across ${files.length} markdown files`);
if (problems.length === 0) {
  console.log("\nEvery link and anchor resolves.");
} else {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log("  " + p);
}
process.exit(problems.length === 0 ? 0 : 1);
