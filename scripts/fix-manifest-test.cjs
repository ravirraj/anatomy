/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const p = fs.readFileSync("scripts/test-citations-manifest.ts", "utf8");
const fixed = p.replace(
  "The repo declares `" + "${name}" + "`.",
  "The repo declares `" + "${name}" + "`.",
);
fs.writeFileSync("scripts/test-citations-manifest.ts", fixed);
console.log("patched");
