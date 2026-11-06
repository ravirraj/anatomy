// Tests Phase 6: bounded iterative retrieval (lib/ai/retrieval-loop.ts).
// Pure deterministic checks: no database, no LLM. A small mock db (same
// emulation as the retrieval fixture) drives the real pipeline through
// complete retrieval calls, so every scenario exercises the unchanged
// Phase 3/4 engine plus the loop's targeted passes, merging and stopping.

import { createHash } from "node:crypto";
import { estimateCodeTokens, estimateProseTokens } from "../lib/ai/budget.ts";
import {
  CATEGORY_QUERY_WORDS,
  mergeIterationWindows,
  retrieveWithCoverageLoop,
  windowAffiliation,
} from "../lib/ai/retrieval-loop.ts";
import { retrieveGroundedContext, type Db, type RetrievedWindow } from "../lib/ai/retrieval.ts";

const results: string[] = [];
function pass(message: string): void {
  results.push(`ok    ${message}`);
}
function fail(message: string): void {
  results.push(`FAIL  ${message}`);
}
function check(condition: boolean, okMessage: string, failMessage: string): void {
  if (condition) pass(okMessage);
  else fail(failMessage);
}

// ---- Section 1: mergeIterationWindows (pure) -----------------------------
console.log("=== 1. mergeIterationWindows: dedupe, caps, provenance ===");

let uniqueId = 0;
function mkWindow(overrides: Partial<RetrievedWindow>): RetrievedWindow {
  uniqueId += 1;
  return {
    fileId: `f${uniqueId}`,
    path: `src/file${uniqueId}.js`,
    contentHash: `hash${uniqueId}`,
    totalLines: 200,
    startLine: 1,
    endLine: 40,
    score: 90,
    text: "x".repeat(20),
    reason: "symbol \"probe\" (function) matches token \"probe\"",
    ...overrides,
  };
}

const limits = { maxFiles: 16, maxWindowsPerFile: 2, maxCharacters: 28000, scoreFloor: 50 };

// Exact duplicate is never re-served.
const mk1 = mergeIterationWindows(
  { windows: [mkWindow({ fileId: "fA", path: "src/a.js", startLine: 1, endLine: 29 })], totalCharacters: 30 },
  [mkWindow({ fileId: "fA", path: "src/a.js", startLine: 1, endLine: 29 })],
  limits,
);
check(mk1.added === 0 && mk1.windows.length === 1, "exact duplicate window skipped", `exact dup not skipped: added=${mk1.added}`);

// Overlapping slices and slices within retrieval's own 5-line merge gap are
// the same evidence and are never re-served.
const mk2 = mergeIterationWindows(
  { windows: [mkWindow({ fileId: "fA", path: "src/a.js", startLine: 1, endLine: 29 })], totalCharacters: 30 },
  [
    mkWindow({ fileId: "fA", path: "src/a.js", startLine: 10, endLine: 40 }),
    mkWindow({ fileId: "fA", path: "src/a.js", startLine: 31, endLine: 60 }),
  ],
  limits,
);
check(mk2.added === 0, "overlapping (or gap-adjacent) same-file windows all skipped", `overlap skipped failed: added=${mk2.added}`);

// A disjoint window on an already-included file is appended (drilling), the
// current package is never displaced, and provenance flows through verbatim.
const current3 = [mkWindow({ fileId: "fA", path: "src/a.js", startLine: 1, endLine: 29, provenance: "indexed" })];
const mk3 = mergeIterationWindows(
  { windows: current3, totalCharacters: current3[0]!.text.length },
  [
    mkWindow({ fileId: "fA", path: "src/a.js", startLine: 65, endLine: 115 }),
    mkWindow({ fileId: "fB", path: "src/b.js", startLine: 1, endLine: 50, provenance: "derived", score: 95 }),
  ],
  limits,
);
check(
  mk3.added === 2 && mk3.addedFiles === 1 && mk3.windows.length === 3,
  "disjoint windows append; existing evidence untouched",
  `merge append failed: added=${mk3.added} windows=${mk3.windows.length}`,
);
check(
  mk3.windows[0] === current3[0] && mk3.windows[0]!.provenance === "indexed" && mk3.windows.some((w) => w.provenance === "derived"),
  "provenance (indexed/derived/direct) passes through untouched",
  "provenance lost",
);

// Per-file window cap holds.
const mk4 = mergeIterationWindows(
  {
    windows: [
      mkWindow({ fileId: "fA", path: "src/a.js", startLine: 1, endLine: 29 }),
      mkWindow({ fileId: "fA", path: "src/a.js", startLine: 70, endLine: 95 }),
    ],
    totalCharacters: 200,
  },
  [mkWindow({ fileId: "fA", path: "src/a.js", startLine: 130, endLine: 170 })],
  limits,
);
check(mk4.added === 0 && mk4.rejectedBudget >= 0, "per-file window cap enforced", `per-file cap failed: added=${mk4.added}`);

// File cap: new files cannot enter when the 16-file budget is full.
const fileCapWindows = Array.from({ length: 16 }, (_, i) =>
  mkWindow({ fileId: `c${i}`, path: `src/d/file${i}.js` }),
);
const mk5 = mergeIterationWindows(
  { windows: fileCapWindows, totalCharacters: 2000 },
  [mkWindow({ fileId: "fN", path: "src/models/new.js", score: 95 })],
  limits,
);
check(mk5.added === 0 && mk5.rejectedBudget === 1, "file cap rejected with a budget reason", `file cap failed: added=${mk5.added} rejected=${mk5.rejectedBudget}`);

// Score floor: a new file below the floor cannot pad the package.
const mk6 = mergeIterationWindows(
  { windows: [mkWindow({ fileId: "fA", path: "src/a.js" })], totalCharacters: 100 },
  [mkWindow({ fileId: "fW", path: "src/weak.js", score: 40 })],
  limits,
);
check(mk6.added === 0 && mk6.rejectedBudget === 1, "weak new-file candidate below score floor rejected", "score floor failed");

// An already-included file's weak candidate may still drill (no displacement).
const mk7 = mergeIterationWindows(
  { windows: [mkWindow({ fileId: "fA", path: "src/a.js" })], totalCharacters: 100 },
  [mkWindow({ fileId: "fA", path: "src/a.js", startLine: 100, endLine: 140, score: 30 })],
  limits,
);
check(mk7.added === 1, "existing-file candidate is appended even when low-scored (drilling only)", "existing-file drill blocked");

// Character budget holds.
const mk8 = mergeIterationWindows(
  { windows: [], totalCharacters: 27900 },
  [mkWindow({ fileId: "fA", path: "src/a.js", text: "y".repeat(2000) })],
  limits,
);
check(mk8.added === 0 && mk8.rejectedBudget === 1, "character budget enforced", "character budget failed");

// ---- Section 1b: atomic replacement (mergeIterationWindows) ---------------
console.log("");
console.log("=== 1b. mergeIterationWindows: atomic replacement ===");

// Serving-cost mirroring of lib/ai/retrieval.ts's windowCostOf: every window
// occupies its header-inclusive character cost and its code + prose + 15
// token cost. The merge must budget candidates by these figures.
const servingTokens = (w: RetrievedWindow): number =>
  estimateCodeTokens(w.text) + estimateProseTokens(w.path) + 15;
const servingHeaderLen = (w: { path: string; contentHash: string; startLine: number; endLine: number }): number =>
  `--- File: ${w.path} (lines ${w.startLine}-${w.endLine}) [hash: ${w.contentHash.slice(0, 8)}] ---\n`.length + 2;
const mkDuplicate = (win: RetrievedWindow): RetrievedWindow => ({ ...win });
// When the merge receives a token ledger (as the real pipeline passes
// base.totalTokens down), the ledger already contains the existing windows'
// full serving tokens — the contract's accounting shape.
const ledgerFor = (wins: RetrievedWindow[]): { windows: RetrievedWindow[]; totalCharacters: number; totalTokens: number } => ({
  windows: wins,
  totalCharacters: wins.reduce((acc, w) => acc + w.text.length, 0),
  totalTokens: wins.reduce((acc, w) => acc + servingTokens(w), 0),
});

const replacementLimits = {
  maxFiles: 16,
  maxWindowsPerFile: 2,
  maxCharacters: 28000,
  maxTokens: 499,
  scoreFloor: 50,
};

// Old implementation failing point: it removed the victim window while
// planning the replacement, then learned the candidate still did not fit —
// leaving the package without its old evidence and without the new window.
// The atomic merge must reject the plan and preserve the original result.
const tokVictim = mkWindow({
  fileId: "v1",
  path: "src/services/victim.js",
  contentHash: "hashV",
  startLine: 1,
  endLine: 40,
  score: 60,
  text: "y".repeat(400),
});
const tokCand = mkWindow({
  fileId: "c1",
  path: "src/controllers/candidate.js",
  contentHash: "hashC",
  startLine: 1,
  endLine: 60,
  score: 95,
  text: "z".repeat(2000),
});
const tokAccounting = ledgerFor([tokVictim]);
const tokMerge = mergeIterationWindows(
  tokAccounting,
  [tokCand],
  replacementLimits,
  { allowReplacement: true, replacementMargin: 10 },
);
check(
  tokMerge.added === 0 && tokMerge.rejectedBudget === 1,
  "candidate exceeding the token budget is rejected as a whole",
  `token-reject merge wrong: ${JSON.stringify(tokMerge)}`,
);
check(
  tokMerge.windows.length === 1 && tokMerge.windows[0] === tokVictim,
  "token-budget rejection keeps the existing window in place",
  `windows: ${JSON.stringify(tokMerge.windows.map((w) => w.fileId))}`,
);
check(
  tokMerge.totalCharacters === tokVictim.text.length && tokMerge.totalTokens === servingTokens(tokVictim),
  "token-budget rejection leaves all accounting unchanged (no accounting corruption)",
  `accounting: ${tokMerge.totalCharacters}/${tokMerge.totalTokens}`,
);
check(
  tokMerge.replacedFiles === 0 && tokMerge.addedFiles === 0,
  "token-budget rejection does not count any replacement",
  `replaced: ${tokMerge.replacedFiles}, addedFiles: ${tokMerge.addedFiles}`,
);

// Character-budget flavour of the same failure: even after evicting the
// eligible victim, the candidate's header-inclusive serving cost exceeds the
// character limit — the plan stays uncommitted.
const charVictim = mkWindow({
  fileId: "v1",
  path: "src/services/victim.js",
  contentHash: "hashV",
  startLine: 1,
  endLine: 40,
  score: 60,
  text: "y".repeat(1200),
});
const charCand = mkWindow({
  fileId: "c1",
  path: "src/controllers/candidate.js",
  contentHash: "hashC",
  startLine: 1,
  endLine: 60,
  score: 95,
  text: "z".repeat(1400),
});
const charLimits = { maxFiles: 16, maxWindowsPerFile: 2, maxCharacters: 1400, scoreFloor: 50 };
const charMerge = mergeIterationWindows(
  { windows: [charVictim], totalCharacters: charVictim.text.length },
  [charCand],
  charLimits,
  { allowReplacement: true, replacementMargin: 10 },
);
check(
  charMerge.added === 0 && charMerge.rejectedBudget === 1,
  "candidate exceeding the character budget is rejected as a whole",
  `char-reject merge wrong: ${JSON.stringify(charMerge)}`,
);
check(
  charMerge.windows.length === 1 && charMerge.windows[0] === charVictim,
  "character-budget rejection keeps the existing window in place",
  `windows: ${JSON.stringify(charMerge.windows.map((w) => w.fileId))}`,
);
check(
  charMerge.totalCharacters === charVictim.text.length && charMerge.totalTokens === servingTokens(charVictim),
  "character-budget rejection leaves all accounting unchanged (fallback ledger keeps serving-token convention)",
  `accounting: ${charMerge.totalCharacters}/${charMerge.totalTokens}`,
);

// A feasible plan commits atomically: the strictly weaker victim is swapped
// for the stronger candidate, with window-level accounting that mirrors the
// serving contract.
const repVictim = mkWindow({
  fileId: "v1",
  path: "src/services/victim.js",
  contentHash: "hashV",
  startLine: 1,
  endLine: 40,
  score: 60,
  text: "y".repeat(3000),
});
const repCand = mkWindow({
  fileId: "n1",
  path: "src/controllers/newnice.js",
  contentHash: "hashN",
  startLine: 1,
  endLine: 20,
  score: 95,
  text: "z".repeat(200),
});
const repMerge = mergeIterationWindows(
  ledgerFor([repVictim]),
  [repCand],
  { maxFiles: 16, maxWindowsPerFile: 2, maxCharacters: 3200, scoreFloor: 50 },
  { allowReplacement: true, replacementMargin: 10 },
);
check(
  repMerge.added === 1 && repMerge.replacedFiles === 1 && repMerge.windows.length === 1 && repMerge.windows[0] === repCand,
  "a fitting candidate replaces the strictly weaker window",
  `replace merge wrong: added=${repMerge.added} replaced=${repMerge.replacedFiles} windows=${JSON.stringify(repMerge.windows.map((w) => w.fileId))}`,
);
check(
  repMerge.totalCharacters === repCand.text.length && repMerge.totalTokens === servingTokens(repCand),
  "the committed replacement moves raw and serving accounting together",
  `accounting: ${repMerge.totalCharacters}/${repMerge.totalTokens}`,
);

// Multiple equally eligible victims: victim selection stays deterministic
// (lowest best score, then lowest fileId) and only the chosen victim moves.
const tieHigh = mkWindow({ fileId: "v2", path: "src/services/second.js", contentHash: "hash2", startLine: 1, endLine: 40, score: 60, text: "a".repeat(400) });
const tieLow = mkWindow({ fileId: "v1", path: "src/services/first.js", contentHash: "hash1", startLine: 1, endLine: 40, score: 60, text: "a".repeat(400) });
const tieCand = mkWindow({ fileId: "n1", path: "src/controllers/newnice.js", contentHash: "hashN", startLine: 1, endLine: 20, score: 95, text: "z".repeat(400) });
const tieMerge = mergeIterationWindows(
  ledgerFor([tieLow, tieHigh]),
  [tieCand],
  { maxFiles: 16, maxWindowsPerFile: 2, maxCharacters: 1200, scoreFloor: 50 },
  { allowReplacement: true, replacementMargin: 10 },
);
check(
  tieMerge.replacedFiles === 1 && tieMerge.windows.length === 2,
  "one deterministic victim is removed when one removal makes the candidate fit",
  `tie merge wrong: replaced=${tieMerge.replacedFiles} windows=${JSON.stringify(tieMerge.windows.map((w) => w.fileId))}`,
);
check(
  tieMerge.windows.some((w) => w.fileId === "v2") && !tieMerge.windows.some((w) => w.fileId === "v1"),
  "equal scores select the lowest fileId as the victim (deterministic)",
  `victim pick wrong: ${JSON.stringify(tieMerge.windows.map((w) => w.fileId))}`,
);
check(
  tieMerge.totalTokens === servingTokens(tieHigh) + servingTokens(tieCand) &&
    tieMerge.totalCharacters === tieHigh.text.length + tieCand.text.length,
  "the committed replacement rebalances serving and raw accounting exactly",
  `tie accounting: ${tieMerge.totalCharacters}/${tieMerge.totalTokens}`,
);

// A failed replacement never rearranges the package: window references keep
// their original order and identity.
const orderFirst = mkWindow({ fileId: "f1", path: "src/services/first.js", contentHash: "hashF1", startLine: 1, endLine: 40, score: 60, text: "y".repeat(400) });
const orderSecond = mkWindow({ fileId: "f2", path: "src/models/second.js", contentHash: "hashF2", startLine: 1, endLine: 40, score: 99, text: "b".repeat(400) });
const orderMerge = mergeIterationWindows(
  ledgerFor([orderFirst, orderSecond]),
  [tokCand],
  replacementLimits,
  { allowReplacement: true, replacementMargin: 10 },
);
check(
  orderMerge.windows.length === 2 && orderMerge.windows[0] === orderFirst && orderMerge.windows[1] === orderSecond,
  "a failed replacement leaves window order and identity unchanged",
  `order merge wrong: ${JSON.stringify(orderMerge.windows.map((w) => w.fileId))}`,
);

// Duplicate candidates: the first copy may trigger a committed replacement;
// further copies must dedupe against the already-added window without
// double-counting any accounting. One candidate and three identical
// candidates produce the exact same package.
const singleMerge = mergeIterationWindows(
  ledgerFor([repVictim]),
  [repCand],
  { maxFiles: 16, maxWindowsPerFile: 2, maxCharacters: 3200, scoreFloor: 50 },
  { allowReplacement: true, replacementMargin: 10 },
);
const tripleMerge = mergeIterationWindows(
  ledgerFor([repVictim]),
  [repCand, mkDuplicate(repCand), mkDuplicate(repCand)],
  { maxFiles: 16, maxWindowsPerFile: 2, maxCharacters: 3200, scoreFloor: 50 },
  { allowReplacement: true, replacementMargin: 10 },
);
check(
  singleMerge.added === tripleMerge.added && singleMerge.replacedFiles === tripleMerge.replacedFiles &&
    singleMerge.totalCharacters === tripleMerge.totalCharacters && singleMerge.totalTokens === tripleMerge.totalTokens &&
    singleMerge.windows.length === tripleMerge.windows.length &&
    singleMerge.windows.every((w, i) => w === tripleMerge.windows[i]),
  "duplicate candidates never corrupt accounting (identical package with one or three copies)",
  `dup mismatch: ${JSON.stringify([singleMerge.replacedFiles, tripleMerge.replacedFiles, singleMerge.totalCharacters, tripleMerge.totalCharacters, singleMerge.windows.length, tripleMerge.windows.length])}`,
);

// ---- Section 1c: totalTokens fallback + line-1 API appendix accounting ----
console.log("");
console.log("=== 1c. mergeIterationWindows: fallback ledger + [API surface] appendix ===");

const fallbackLimits = { maxFiles: 16, maxWindowsPerFile: 2, maxCharacters: 28000, scoreFloor: 50 };

// Existing windows with no supplied token ledger: the fallback is the same
// convention the additions use — the windows' full served token cost — never
// a raw-characters heuristic.
const fbA = mkWindow({ fileId: "fbA", path: "src/services/fallOne.js", contentHash: "hash1", startLine: 2, endLine: 40, score: 90, text: "a".repeat(300) });
const fbB = mkWindow({ fileId: "fbB", path: "src/models/fallTwo.js", contentHash: "hash2", startLine: 3, endLine: 40, score: 90, text: "b".repeat(300) });
const fbExisting = mergeIterationWindows(
  { windows: [fbA, fbB], totalCharacters: 600 },
  [],
  fallbackLimits,
);
check(
  fbExisting.totalTokens === servingTokens(fbA) + servingTokens(fbB),
  "fallback token ledger uses the serving-token convention for existing windows",
  `fallback: ${fbExisting.totalTokens} vs ${servingTokens(fbA) + servingTokens(fbB)}`,
);
check(
  fbExisting.renderedCharacters === 600 + servingHeaderLen(fbA) + servingHeaderLen(fbB),
  "fallback character ledger covers the existing windows' headers",
  `fallback rendered: ${fbExisting.renderedCharacters}`,
);

// Successful project-candidate addition without a supplied ledger.
const fbCand = mkWindow({ fileId: "fbC", path: "src/controllers/fallNew.js", contentHash: "hash3", startLine: 2, endLine: 20, score: 95, text: "c".repeat(200) });
const fbAdd = mergeIterationWindows(
  { windows: [fbA, fbB], totalCharacters: 600 },
  [fbCand],
  fallbackLimits,
);
check(
  fbAdd.added === 1 && fbAdd.totalTokens === servingTokens(fbA) + servingTokens(fbB) + servingTokens(fbCand) &&
    fbAdd.renderedCharacters === 600 + fbCand.text.length + servingHeaderLen(fbA) + servingHeaderLen(fbB) + servingHeaderLen(fbCand),
  "successful addition without a supplied ledger extends the serving-convention figures",
  `fbAdd: ${fbAdd.totalTokens}/${fbAdd.renderedCharacters}`,
);

// Replacement without a supplied ledger: the victim's full served cost —
// including its header — is reclaimed, so the final ledger is exactly the
// surviving package's own served cost.
const fbVictim = mkWindow({ fileId: "fbV", path: "src/services/fallOld.js", contentHash: "hash4", startLine: 2, endLine: 40, score: 60, text: "v".repeat(3000) });
const fbRep = mergeIterationWindows(
  { windows: [fbVictim], totalCharacters: 3000 },
  [fbCand],
  { maxFiles: 16, maxWindowsPerFile: 2, maxCharacters: 3200, scoreFloor: 50 },
  { allowReplacement: true, replacementMargin: 10 },
);
check(
  fbRep.replacedFiles === 1 && fbRep.added === 1 &&
    fbRep.totalTokens === servingTokens(fbCand) &&
    fbRep.renderedCharacters === fbCand.text.length + servingHeaderLen(fbCand),
  "replacement without a supplied ledger reclaims the victim's served cost exactly",
  `fbRep: ${fbRep.totalTokens}/${fbRep.renderedCharacters}`,
);

// Rejected candidate without a supplied ledger: nothing moves.
const fbRejCand = mkWindow({ fileId: "fbR", path: "src/controllers/fallBig.js", contentHash: "hash5", startLine: 2, endLine: 60, score: 95, text: "r".repeat(4000) });
const fbRej = mergeIterationWindows(
  { windows: [fbA, fbB], totalCharacters: 600 },
  [fbRejCand],
  { maxFiles: 16, maxWindowsPerFile: 2, maxCharacters: 1000, scoreFloor: 50 },
);
check(
  fbRej.added === 0 && fbRej.rejectedBudget === 1 &&
    fbRej.totalTokens === servingTokens(fbA) + servingTokens(fbB) &&
    fbRej.renderedCharacters === 600 + servingHeaderLen(fbA) + servingHeaderLen(fbB),
  "rejected candidate without a supplied ledger leaves both fallback figures unchanged",
  `fbRej: ${fbRej.totalTokens}/${fbRej.renderedCharacters}`,
);

// Line-1 `[API surface]` appendix accounting. The final prompt assembly
// (formatRetrievedContext) attaches the appendix text to every window that
// contains line 1 of a file whose exported symbols are known, so the merge
// must reserve exactly that cost through `options.appendixOf`.
const appendices = new Map<string, { chars: number; tokens: number }>();
const appendixProvider = (w: { path: string }): { chars: number; tokens: number } =>
  appendices.get(w.path) ?? { chars: 0, tokens: 0 };
const apxLimits = { maxFiles: 16, maxWindowsPerFile: 2, maxCharacters: 28000, scoreFloor: 50 };

// An existing base window with an appendix: its appendix cost is already in
// the inherited ledgers (renderedCharacters + totalTokens) and is preserved —
// never re-added — by an accounting-only merge.
const apxVictim = mkWindow({ fileId: "v1", path: "src/services/one.js", contentHash: "hashV", startLine: 1, endLine: 40, score: 60, text: "y".repeat(1000) });
const apxChars = 400;
const apxTokens = 120;
appendices.set(apxVictim.path, { chars: apxChars, tokens: apxTokens });
const apxInherited = {
  windows: [apxVictim],
  totalCharacters: apxVictim.text.length,
  totalTokens: servingTokens(apxVictim) + apxTokens,
  renderedCharacters: apxVictim.text.length + servingHeaderLen(apxVictim) + apxChars,
};
const apxPreserve = mergeIterationWindows(
  apxInherited,
  [mkDuplicate({ ...apxVictim, score: 95 })],
  apxLimits,
  { appendixOf: appendixProvider },
);
check(
  apxPreserve.added === 0 &&
    apxPreserve.totalTokens === apxInherited.totalTokens &&
    apxPreserve.renderedCharacters === apxInherited.renderedCharacters &&
    apxPreserve.totalCharacters === apxInherited.totalCharacters,
  "accounting-only merge preserves inherited appendix costs without double counting",
  `apxPreserve: ${apxPreserve.totalTokens}/${apxPreserve.renderedCharacters}`,
);

// Replacing a line-1 window with an appendix is feasible only when the
// replacement plan reclaims the whole served cost — window text + header +
// appendix. Text-only planning (the old implementation, which had no
// appendix accounting) cannot make the plan feasible here.
const apxCand = mkWindow({ fileId: "c1", path: "src/services/two.js", contentHash: "hashC", startLine: 2, endLine: 60, score: 95, text: "z".repeat(1100) });
const apxSwap = mergeIterationWindows(
  apxInherited,
  [apxCand],
  { maxFiles: 16, maxWindowsPerFile: 2, maxCharacters: 2000, scoreFloor: 50 },
  { allowReplacement: true, replacementMargin: 10, appendixOf: appendixProvider },
);
check(
  apxSwap.added === 1 && apxSwap.replacedFiles === 1 && apxSwap.windows.length === 1 && apxSwap.windows[0] === apxCand,
  "a line-1 window's appendix is reclaimed when it is replaced (appendix-aware plan commits)",
  `apxSwap: added=${apxSwap.added} replaced=${apxSwap.replacedFiles}`,
);
check(
  apxSwap.totalTokens === servingTokens(apxCand) &&
    apxSwap.renderedCharacters === apxCand.text.length + servingHeaderLen(apxCand) &&
    apxSwap.totalCharacters === apxCand.text.length,
  "after the swap the ledgers equal the surviving package's served cost exactly",
  `apxSwap ledgers: ${apxSwap.totalTokens}/${apxSwap.renderedCharacters}/${apxSwap.totalCharacters}`,
);

// A failed replacement against appendix-inclusive figures preserves the
// original package and every ledger figure exactly.
const apxBuffer = mkWindow({ fileId: "v2", path: "src/services/four.js", contentHash: "hash2", startLine: 5, endLine: 40, score: 99, text: "b".repeat(400) });
const apxInheritedBuffer = {
  windows: [apxVictim, apxBuffer],
  totalCharacters: apxVictim.text.length + apxBuffer.text.length,
  totalTokens: servingTokens(apxVictim) + servingTokens(apxBuffer) + apxTokens,
  renderedCharacters: apxVictim.text.length + apxBuffer.text.length + servingHeaderLen(apxVictim) + servingHeaderLen(apxBuffer) + apxChars,
};
appendices.set("src/services/four.js", { chars: 0, tokens: 0 });
const apxFailCand = mkWindow({ fileId: "c1", path: "src/services/two.js", contentHash: "hashC", startLine: 2, endLine: 60, score: 95, text: "z".repeat(1100) });
const apxFail = mergeIterationWindows(
  apxInheritedBuffer,
  [apxFailCand],
  { maxFiles: 16, maxWindowsPerFile: 2, maxCharacters: 1162, scoreFloor: 50 },
  { allowReplacement: true, replacementMargin: 10, appendixOf: appendixProvider },
);
check(
  apxFail.added === 0 && apxFail.replacedFiles === 0 && apxFail.rejectedBudget >= 1 &&
    apxFail.windows.length === 2 && apxFail.windows[0] === apxVictim && apxFail.windows[1] === apxBuffer &&
    apxFail.totalTokens === apxInheritedBuffer.totalTokens &&
    apxFail.renderedCharacters === apxInheritedBuffer.renderedCharacters &&
    apxFail.totalCharacters === apxInheritedBuffer.totalCharacters,
  "a failed appendix-aware replacement preserves the package and all three ledger figures exactly",
  `apxFail: ${JSON.stringify(apxFail)}`,
);

// A newly introduced line-1 window carries its own appendix: the merge
// reserves the appendix the final prompt will attach, so the candidate only
// enters when its full served cost fits.
const apxNew = mkWindow({ fileId: "n1", path: "src/controllers/newOne.js", contentHash: "hashN", startLine: 1, endLine: 60, score: 95, text: "n".repeat(700) });
const apxNewChars = 400;
const apxNewTokens = 120;
appendices.set(apxNew.path, { chars: apxNewChars, tokens: apxNewTokens });
const nonLineOne = mkWindow({ fileId: "f2", path: "src/models/two.js", contentHash: "hashF2", startLine: 3, endLine: 40, score: 99, text: "f".repeat(500) });
const baseRendered = nonLineOne.text.length + servingHeaderLen(nonLineOne);
appendices.set(nonLineOne.path, { chars: 0, tokens: 0 });
const candServedChars = apxNew.text.length + servingHeaderLen(apxNew) + apxNewChars;
const apxAdd = mergeIterationWindows(
  { windows: [nonLineOne], totalCharacters: nonLineOne.text.length, totalTokens: servingTokens(nonLineOne), renderedCharacters: baseRendered },
  [apxNew],
  { ...apxLimits, maxCharacters: baseRendered + candServedChars },
  { appendixOf: appendixProvider },
);
check(
  apxAdd.added === 1 &&
    apxAdd.renderedCharacters === baseRendered + candServedChars &&
    apxAdd.totalTokens === servingTokens(nonLineOne) + servingTokens(apxNew) + apxNewTokens,
  "a new line-1 window's appendix is charged exactly once on entry",
  `apxAdd: ${apxAdd.renderedCharacters} (expected ${baseRendered + candServedChars})`,
);

// The same candidate with no room for its appendix is rejected whole — the
// header + appendix overhead makes room checks as rendered, not just as text.
const apxReject = mergeIterationWindows(
  { windows: [nonLineOne], totalCharacters: nonLineOne.text.length, totalTokens: servingTokens(nonLineOne), renderedCharacters: baseRendered },
  [mkDuplicate(apxNew)],
  { ...apxLimits, maxCharacters: baseRendered + candServedChars - 5 },
  { appendixOf: appendixProvider },
);
check(
  apxReject.added === 0 && apxReject.rejectedBudget >= 1 &&
    apxReject.renderedCharacters === baseRendered &&
    apxReject.totalTokens === servingTokens(nonLineOne),
  "a line-1 candidate whose appendix exceeds the rendered budget is rejected with accounting unchanged",
  `apxReject: ${JSON.stringify(apxReject)}`,
);


// ---- Section 2: windowAffiliation (pure) ---------------------------------
console.log("");
console.log("=== 2. windowAffiliation mirrors coverage semantics ===");
{
  // The focused-vocabulary table must stay aligned with the planner's
  // category set: every planner category maps to focused query words. It also
  // carries curated words for adaptive coverage categories that are taxonomy
  // role ids (Phase 1C F4); unknown role ids keep the raw-name fallback.
  const categories = new Set([
    ...Object.values(CATEGORY_QUERY_WORDS),
  ]);
  check(
    Object.keys(CATEGORY_QUERY_WORDS).sort().join(",") ===
      "api-endpoint,component,config,controller,controllers,dto,entity,frontend,gateway,guard,hook,interceptor,middleware,model,models,page-route,repository,resolver,routes,server-action,service,services"
      && CATEGORY_QUERY_WORDS.routes === "route router endpoint"
      && categories.size === 19,
    "focused query words exist for every planner category and taxonomy role",
    `category words: ${JSON.stringify(CATEGORY_QUERY_WORDS)}`,
  );
  check(
    CATEGORY_QUERY_WORDS["page-route"] === "page route"
      && CATEGORY_QUERY_WORDS["api-endpoint"] === "api endpoint route"
      && CATEGORY_QUERY_WORDS["server-action"] === "server action"
      && CATEGORY_QUERY_WORDS.repository === "repository persistence"
      && CATEGORY_QUERY_WORDS["dto"] === "data transfer object"
      && CATEGORY_QUERY_WORDS.component === "component ui"
      && CATEGORY_QUERY_WORDS.hook === "hook state",
    "taxonomy-role categories have curated focused-query vocabulary",
    `role words: ${{ "page-route": CATEGORY_QUERY_WORDS["page-route"], "api-endpoint": CATEGORY_QUERY_WORDS["api-endpoint"], "server-action": CATEGORY_QUERY_WORDS["server-action"], repository: CATEGORY_QUERY_WORDS.repository, dto: CATEGORY_QUERY_WORDS["dto"], component: CATEGORY_QUERY_WORDS.component, hook: CATEGORY_QUERY_WORDS.hook }}`,
  );
  check(
    CATEGORY_QUERY_WORDS["theme-override"] === undefined,
    "unknown role ids keep the raw-name fallback (absent from the table)",
    `unexpected entry: ${CATEGORY_QUERY_WORDS["theme-override"]}`,
  );
}

check(windowAffiliation({ path: "backend/src/routes/media.js", reason: "" }) === "routes", "path segment affiliates routes", "routes segment affiliation failed");
check(windowAffiliation({ path: "src/anything.js", reason: 'file holds the "controller" role' }) === "controllers", "reason role affiliates controllers", "role affiliation failed");
check(windowAffiliation({ path: "src/services/records.js", reason: "" }) === "services", "services segment affiliates", "services affiliation failed");
check(windowAffiliation({ path: "packages/src/client/keys.ts", reason: "" }) === "frontend", "client segment affiliates frontend", "frontend affiliation failed");
check(windowAffiliation({ path: "src/data/archive.js", reason: "" }) === null, "unaffiliated paths return null", "null affiliation failed");

// ---- Section 3: the loop against the real pipeline -----------------------

type TextLine = string | null;

type MockFile = {
  id: string;
  path: string;
  lines?: number;
  role?: string;
  symbols?: [name: string, line: number, exported?: boolean][];
  routes?: { method: string; path: string; line: number }[];
  text?: (line: number) => TextLine;
};

type MockDbRecord = {
  db: {
    from(table: string): unknown;
  };
  calls: Record<string, number>;
};

const FILLER = (line: number): string => `// chain ${line}`;

function buildMock(
  analysisId: string,
  fileSpecs: MockFile[],
  edges: { source: string; target: string; kind?: string }[] = [],
): MockDbRecord {
  const calls: Record<string, number> = {};
  const fileTexts = new Map<string, string>();
  const rows = fileSpecs.map((spec) => {
    const total = spec.lines ?? 70;
    const parts: string[] = [];
    for (let i = 1; i <= total; i++) {
      const custom = spec.text?.(i);
      parts.push(custom ?? FILLER(i));
    }
    const text = parts.join("\n") + "\n";
    const hash = createHash("sha256").update(text).digest("hex");
    fileTexts.set(spec.id, text);
    return {
      id: spec.id,
      path: spec.path,
      hash,
      lines: total,
      content_status: "stored",
      analysis_id: analysisId,
      file_roles: spec.role ? [{ role: spec.role, source: "convention" }] : [{ role: undefined, source: "convention" }],
    };
  });

  const symbolRows = fileSpecs.flatMap((spec) =>
    (spec.symbols ?? []).map(([name, line, exported]) => ({
      file_id: spec.id,
      name,
      kind: name[0] === name[0]!.toUpperCase() ? "class" : "function",
      line,
      exported: exported ?? false,
    })),
  );
  const routeRows = fileSpecs.flatMap((spec) =>
    (spec.routes ?? []).map((r) => ({
      file_id: spec.id,
      method: r.method,
      path: r.path,
      line: r.line,
    })),
  );
  const edgeRows = edges.map((e) => ({
    source_file_id: e.source,
    target_file_id: e.target,
    kind: e.kind ?? "import",
  }));

  return {
    db: {
      from(table: string) {
        calls[table] = (calls[table] ?? 0) + 1;
        if (table === "files") {
          return {
            select: () => ({
              eq: (col: string, value: string) => ({
                is: () =>
                  Promise.resolve({
                    data: col === "analysis_id"
                      ? rows.filter((f) => f.analysis_id === value)
                      : rows,
                    error: null,
                  }),
                maybeSingle: async () => ({
                  data: rows.find((f) => f.id === value) ?? null,
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "symbols") {
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: symbolRows, error: null }),
            }),
          };
        }
        if (table === "routes") {
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: routeRows, error: null }),
            }),
          };
        }
        if (table === "edges") {
          return {
            select: () => ({
              eq: () => ({
                or: (orFilter: string) => {
                  const seedIds = new Set<string>();
                  for (const m of orFilter.matchAll(/in\.\(([^)]*)\)/g)) {
                    for (const id of (m[1] ?? "").split(",")) {
                      if (id.trim()) seedIds.add(id.trim());
                    }
                  }
                  const filtered = edgeRows.filter(
                    (edge) => seedIds.has(edge.source_file_id) || seedIds.has(edge.target_file_id),
                  );
                  return Promise.resolve({ data: filtered, error: null });
                },
              }),
            }),
          };
        }
        if (table === "file_contents") {
          return {
            select: () => ({
              eq: () => ({
                eq: (_col: string, hash: string) => ({
                  maybeSingle: async () => {
                    const row = rows.find((f) => f.hash === hash);
                    if (!row) return { data: null, error: null };
                    const text = fileTexts.get(row.id) ?? "";
                    return {
                      data: {
                        payload: `\\x${Buffer.from(text, "utf8").toString("hex")}`,
                        size: Buffer.byteLength(text, "utf8"),
                      },
                      error: null,
                    };
                  },
                }),
              }),
            }),
          };
        }
    if (table === "manifests" || table === "dependencies" || table === "config_references" || table === "entry_points") {
      // No packaging metadata in this fixture: the blocks are simply absent.
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      };
    }
    throw new Error(`Unexpected table ${table}`);
      },
    },
    calls,
  };
}

function assertBudgetInvariants(
  label: string,
  result: Awaited<ReturnType<typeof retrieveWithCoverageLoop>>["result"],
): void {
  const perFile = new Map<string, number>();
  const seen = new Set<string>();
  let ok = true;
  let overlapOk = true;
  for (const win of result.windows) {
    perFile.set(win.fileId, (perFile.get(win.fileId) ?? 0) + 1);
    const key = `${win.fileId}:${win.startLine}:${win.endLine}`;
    if (seen.has(key)) ok = false;
    seen.add(key);
  }
  const byFile = new Map<string, { startLine: number; endLine: number }[]>();
  for (const win of result.windows) {
    const list = byFile.get(win.fileId) ?? [];
    list.push(win);
    byFile.set(win.fileId, list);
  }
  for (const list of byFile.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i]!.startLine <= list[j]!.endLine + 5 && list[j]!.startLine <= list[i]!.endLine + 5) overlapOk = false;
      }
    }
  }
  check(result.files.length <= 16, `${label}: file budget respected (${result.files.length})`, `${label}: ${result.files.length} files exceed budget`);
  check(result.totalCharacters <= 28000, `${label}: character budget respected (${result.totalCharacters})`, `${label}: characters ${result.totalCharacters} exceed budget`);
  if (result.renderedCharacters !== undefined) {
    check(result.renderedCharacters >= result.totalCharacters, `${label}: rendered ledger covers raw characters (${result.renderedCharacters}/${result.totalCharacters})`, `${label}: rendered ledger below raw characters`);
    check(result.renderedCharacters <= 28000, `${label}: rendered (header- and appendix-inclusive) budget respected (${result.renderedCharacters})`, `${label}: rendered characters ${result.renderedCharacters} exceed budget`);
  }
  check([...perFile.values()].every((n) => n <= 2), `${label}: per-file window cap respected`, `${label}: per-file cap violated`);
  check(ok, `${label}: no duplicate windows`, `${label}: duplicate window found`);
  check(overlapOk, `${label}: no overlapping windows on the same file`, `${label}: overlapping windows found`);
}

console.log("");
console.log("=== 3. SDK scenario: routes/controllers partial improve through targeted retrieval ===");
{
  const sdk = buildMock("loop_sdk",
    [
      {
        id: "sdk_routes",
        path: "backend/routes/mediaRegistry.js",
        lines: 190,
        symbols: [["developerKeysRegistry", 80, true]],
        routes: [{ method: "GET", path: "/router-registration", line: 140 }],
        text: (n) => (n === 80 ? "function developerKeysRegistry(req) { return issueKey(req); }" : n === 140 ? "routerRegistration.add('/media/sdk/register', guardChain);" : null),
      },
      {
        id: "sdk_controller",
        path: "backend/src/controllers/mediaKeys.js",
        role: "controller",
        lines: 160,
        symbols: [["issueDeveloperKey", 88, true]],
        text: (n) => (n === 8 ? "const sdkGuard = validateIssue(req);" : n === 88 ? "async function issueDeveloperKey(req) { return issueKeyRow(req); }" : null),
      },
      {
        id: "sdk_frontend",
        path: "packages/src/client/keys.ts",
        lines: 70,
        symbols: [["listDeveloperKeys", 8, true]],
        text: (n) => (n === 6 ? "export const listDeveloperKeys = () => sdkKeysClient.list();" : null),
      },
    ]);

  const loop = await retrieveWithCoverageLoop(sdk.db as unknown as Db, "loop_sdk", "How does the developer SDK work in this project?", { adaptive: false });
  check(loop.stoppedBecause === "no-candidates", "the sdk concepts drill to found, then the leftover 'project' qualifier drills dry", `stop reason: ${loop.stoppedBecause}`);
  check(loop.passes.length === 2, "exactly one targeted evidence pass plus one dry qualifier drill", `passes: ${loop.passes.length}`);
  check(loop.passes[0]!.addedWindows === 2, "targeted pass added one window per missing category", `added: ${loop.passes[0]!.addedWindows}`);
  check(
    JSON.stringify(loop.passes[0]!.queries) === JSON.stringify(["sdk route router endpoint", "sdk controller handler"]),
    "focused queries pair the concept token with category vocabulary",
    `queries: ${JSON.stringify(loop.passes[0]!.queries)}`,
  );
  const concept = loop.coverage.concepts.find((c) => c.token === "sdk")!;
  check(
    concept !== undefined && concept.categories.every((c) => c.status === "found"),
    "sdk coverage reaches found for routes, controllers and frontend",
    `sdk coverage: ${JSON.stringify(loop.coverage.concepts)}`,
  );
  check(loop.coverage.summary.partial === 0 && loop.coverage.summary.unknown === 1, "nothing regressed to partial; the unmatched 'project' qualifier stays honestly unknown (Phase 1D, V1)", `summary: ${JSON.stringify(loop.coverage.summary)}`);
  check(
    loop.result.windows.some((w) => w.path === "backend/routes/mediaRegistry.js" && w.startLine === 130),
    "routes drill surfaced the route-table slice (new evidence, same file)",
    `routes windows: ${JSON.stringify(loop.result.windows.filter((w) => w.path.includes("mediaRegistry")).map((w) => `${w.startLine}-${w.endLine}`))}`,
  );
  check(
    loop.result.windows.some((w) => w.path === "backend/src/controllers/mediaKeys.js" && w.startLine === 1),
    "controller drill surfaced the import header slice (new evidence, same file)",
    "controller header missing",
  );
  check(sdk.calls.symbols >= 3, `two focused retrievals plus the base pass ran (symbols queries: ${sdk.calls.symbols})`, `symbol queries: ${sdk.calls.symbols}`);
  assertBudgetInvariants("sdk", loop.result);
}

console.log("");
console.log("=== 4. Authentication scenario: already sufficient, zero passes ===");
{
  const auth = buildMock("loop_auth",
    [
      {
        id: "auth_controller",
        path: "backend/src/controllers/sessionGuard.js",
        role: "controller",
        lines: 70,
        symbols: [["verifySessionGuard", 10, true]],
        text: (n) => (n === 10 ? "function verifySessionGuard(req, next) { return next(); }" : null),
      },
      {
        id: "auth_middleware",
        path: "src/middlewares/authenticate.js",
        role: "middleware",
        lines: 70,
        symbols: [["authenticateRequests", 6, true]],
        text: (n) => (n === 6 ? "const authenticateRequests = chain(theGuards);" : null),
      },
      {
        id: "auth_model",
        path: "src/models/userSessions.js",
        role: "model",
        lines: 70,
        symbols: [["UserSession", 8, true]],
        text: (n) => (n === 8 ? "const UserSession = defineMapping('user_sessions_data');" : null),
      },
      {
        id: "auth_frontend",
        path: "web/src/pages/LoginPage.jsx",
        lines: 70,
        symbols: [["LoginPageForm", 8, true]],
        text: (n) => (n === 8 ? "const LoginPageForm = () => loginSubmit();" : null),
      },
    ]);

  const loop = await retrieveWithCoverageLoop(auth.db as unknown as Db, "loop_auth", "How does authentication work in this project?", { adaptive: false });
  check(loop.stoppedBecause === "no-candidates", "the auth package is sufficient; the leftover qualifier concept drills once and lands empty", `stop: ${loop.stoppedBecause}`);
  check(loop.passes.length === 1 && loop.passes[0]!.addedWindows === 0, "exactly one dry drill pass for the qualifier concept", `passes: ${JSON.stringify(loop.passes)}`);
  check(auth.calls.symbols >= 1, `single retrieval call (symbols queries: ${auth.calls.symbols})`, `symbol queries: ${auth.calls.symbols}`);
  check(
    loop.coverage.summary.found === 4 && loop.coverage.summary.partial === 0 && loop.coverage.summary.unknown === 1,
    "auth coverage stays all-found; the unmatched 'project' qualifier is honestly unknown (Phase 1D, V1)",
    `summary: ${JSON.stringify(loop.coverage.summary)}`,
  );
  assertBudgetInvariants("auth", loop.result);
}

console.log("");
console.log("=== 5. Bounded iteration: stops at the iteration limit ===");
{
  const maxPasses = buildMock("loop_max",
    [
      {
        id: "max_frontend",
        path: "packages/src/client/media.js",
        lines: 70,
        text: (n) => (n === 6 ? "export const storeMediaChannel = Object.create(null);" : null),
      },
      {
        id: "max_controller",
        path: "backend/src/controllers/restful.js",
        role: "controller",
        lines: 70,
        text: (n) => (n === 9 ? "module.exports.validUpload = sdkCombine(body);" : null),
      },
      {
        id: "max_service",
        path: "backend/src/services/persist.js",
        role: "service",
        lines: 70,
        text: (n) => (n === 6 ? "module.exports.storeAttachment = (payload) => bucketPersist(payload);" : null),
      },
      {
        id: "max_model",
        path: "src/models/media.js",
        role: "model",
        lines: 70,
        text: (n) => (n === 7 ? "module.exports.saveMultipartPayload = insertRow;" : null),
      },
      {
        id: "max_config",
        path: "backend/src/config/mediaEnv.js",
        role: "config",
        lines: 70,
        text: (n) => (n === 4 ? "module.exports.uploadLimits = process.env.UPLOAD_MAX;" : null),
      },
      {
        id: "max_routes",
        path: "backend/routes/mediaList.js",
        lines: 70,
      },
    ]);

  const query = "How does the file upload SDK work in this project?";
  const loop = await retrieveWithCoverageLoop(maxPasses.db as unknown as Db, "loop_max", query, { adaptive: false });
  check(loop.stoppedBecause === "max-passes", "stops at the iteration limit", `stop: ${loop.stoppedBecause}`);
  check(loop.passes.length === 3, `exactly ${3} additional passes ran (got ${loop.passes.length})`, `passes: ${loop.passes.length}`);
  check(loop.passes.every((p) => p.addedWindows > 0), "every pass still added fresh evidence", `added: ${JSON.stringify(loop.passes.map((p) => p.addedWindows))}`);
  check(
    loop.coverage.summary.found === 4 && loop.coverage.summary.partial === 1 && loop.coverage.summary.unknown === 3,
    `coverage improved to {found 4, partial 1, unknown 3} without completing (summary: ${JSON.stringify(loop.coverage.summary)})`,
    `summary: ${JSON.stringify(loop.coverage.summary)}`,
  );
  check(
    loop.coverage.concepts.some((c) => c.categories.some((cat) => cat.status === "partial" || cat.status === "unknown")),
    "loop leaves remaining gaps alongside their fixed unknown note",
    `concepts: ${JSON.stringify(loop.coverage.concepts)}`,
  );
  assertBudgetInvariants("max-passes", loop.result);
}

console.log("");
console.log("=== 6. File budget exhausted ===");
{
  // 16 controller files seeded by the question; the missing service layer
  // exists in the db but its file slot is already gone.
  const sixteen = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen"];
  const spec: MockFile[] = sixteen.map((word) => ({
    id: `budget_${word}`,
    path: `backend/src/controllers/upload${word[0]!.toUpperCase()}${word.slice(1)}.js`,
    role: "controller",
    lines: 100,
    text: (n) => (n === 9 ? `module.exports.uploadHandler = deepCombine(req);` : null),
  }));
  spec.push({
    id: "budget_service",
    path: "backend/src/services/persist.js",
    role: "service",
    lines: 70,
    text: (n) => (n === 5 ? "module.exports.attachmentSink = deepStore(payload);" : null),
  });
  const budget = buildMock("loop_budget", spec);

  const loop = await retrieveWithCoverageLoop(budget.db as unknown as Db, "loop_budget", "How does the file upload SDK work in this project?", { adaptive: false });
  check(loop.stoppedBecause === "budget-exhausted", "stops when the file budget is exhausted", `stop: ${loop.stoppedBecause}`);
  check(loop.passes.length === 1, `stops after the first dry pass (got ${loop.passes.length})`, `passes: ${loop.passes.length}`);
  check(loop.result.files.length === 16, `file count pinned at 16 (got ${loop.result.files.length})`, `files: ${loop.result.files.length}`);
  check(loop.result.totalCharacters <= 28000, `character budget respected (${loop.result.totalCharacters})`, `chars: ${loop.result.totalCharacters}`);
  assertBudgetInvariants("budget", loop.result);
}

console.log("");
console.log("=== 7. No candidates remain ===");
{
  // Same fixture without the service file: the targeted retrieval finds
  // nothing new, so the loop stops and says so.
  const sixteen = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen"];
  const spec: MockFile[] = sixteen.map((word) => ({
    id: `nocand_${word}`,
    path: `backend/src/controllers/upload${word[0]!.toUpperCase()}${word.slice(1)}.js`,
    role: "controller",
    lines: 100,
    text: (n) => (n === 9 ? `module.exports.uploadHandler = deepUnify(req);` : null),
  }));
  const dry = buildMock("loop_nocand", spec);

  const loop = await retrieveWithCoverageLoop(dry.db as unknown as Db, "loop_nocand", "How does the file upload SDK work in this project?", { adaptive: false });
  check(loop.stoppedBecause === "no-candidates", "stops when no candidates remain", `stop: ${loop.stoppedBecause}`);
  check(loop.passes.length === 1 && loop.passes[0]!.addedWindows === 0, "the dry pass added nothing", `passes: ${JSON.stringify(loop.passes)}`);
  assertBudgetInvariants("no-candidates", loop.result);
}

console.log("");
console.log("=== 8. Provenance and hashes preserved through the loop ===");
{
  const prov = buildMock("loop_prov",
    [
      {
        id: "prov_svc",
        path: "src/services/records.js",
        role: "service",
        lines: 70,
        symbols: [["saveRecords", 4, true]],
        text: (n) => (n === 4 ? "function saveRecords(key, recordRow) { return recordRow; }" : null),
      },
      { id: "prov_data", path: "src/data/archive.js", lines: 70 },
    ],
    [{ source: "prov_svc", target: "prov_data", kind: "import" }]);

  const loop = await retrieveWithCoverageLoop(prov.db as unknown as Db, "loop_prov", "Where is the record store used?", { adaptive: false });
  check(loop.stoppedBecause === "no-candidates", "the unrelated-category drill finds nothing new (stops, never invents)", `stop: ${loop.stoppedBecause}`);
  check(loop.passes.length === 1, "one focused pass ran before the stop", `passes: ${loop.passes.length}`);
  const indexedWindow = loop.result.windows.find((w) => w.path === "src/data/archive.js");
  check(
    indexedWindow !== undefined && indexedWindow.provenance === "indexed",
    `relationship window kept its "indexed" provenance (${indexedWindow?.provenance ?? "missing"})`,
    "indexed provenance lost",
  );
  check(
    loop.result.windows.every((w) => typeof w.contentHash === "string" && w.contentHash.length === 64),
    "every window keeps its content hash for citation verification",
    "hash missing",
  );
  check(prov.calls.symbols >= 2, `base plus one focused retrieval (symbols queries: ${prov.calls.symbols})`, `symbols: ${prov.calls.symbols}`);
  assertBudgetInvariants("prov", loop.result);
}

  // Section 9: adaptive concept discovery (Phase 1) on an unfamiliar repository.
  console.log("");
  console.log("=== 9. Adaptive concept discovery (unfamiliar repo, no hardcoded categories) ===");
  {
    const adaptive = buildMock("loop_adaptive", [
      { id: "t_collector", path: "src/telemetry/collector.ts", role: "service", lines: 40, symbols: [["TelemetryCollector", 4, true]], text: (n) => (n === 4 ? "export class TelemetryCollector { record() {} }" : null) },
      { id: "t_exporter", path: "src/telemetry/exporter.ts", role: "service", lines: 40, symbols: [["ExportTelemetryMetrics", 4, true]], text: (n) => (n === 4 ? "export function ExportTelemetryMetrics() { return null; }" : null) },
      { id: "t_buffer", path: "src/telemetry/buffer.ts", role: "model", lines: 40, symbols: [["TelemetryBufferQueue", 4, true]], text: (n) => (n === 4 ? "export class TelemetryBufferQueue { enqueue() {} }" : null) },
      { id: "s_coordinator", path: "src/sharding/coordinator.ts", role: "controller", lines: 40, symbols: [["ShardingCoordinator", 4, true]], text: (n) => (n === 4 ? "export class ShardingCoordinator { plan() {} }" : null) },
      { id: "s_partition", path: "src/sharding/partition_map.ts", role: "model", lines: 40, symbols: [["PartitionMap", 4, true]], text: (n) => (n === 4 ? "export interface PartitionMap { shards: number }" : null) },
      { id: "s_rebalancer", path: "src/sharding/rebalancer.ts", role: "service", lines: 40, symbols: [["RebalanceShards", 4, true]], text: (n) => (n === 4 ? "export function RebalanceShards() { return null; }" : null) },
    ], [
      { source: "t_collector", target: "t_exporter" },
      { source: "t_collector", target: "t_buffer" },
      { source: "s_coordinator", target: "s_partition" },
      { source: "s_coordinator", target: "s_rebalancer" },
    ]);

    const loop = await retrieveWithCoverageLoop(adaptive.db as unknown as Db, "loop_adaptive", "How does telemetry collection work?");
    check(loop.coverage.concepts.length > 0, "adaptive discovery produces repository-derived concepts", `concepts: ${loop.coverage.concepts.length}`);
    // Categories should be derived (roles), not the hardcoded 7-layer vocabulary forced onto an unrelated repo.
    const categories = loop.coverage.concepts.flatMap((c) => c.categories.map((cat) => cat.category));
    check(categories.length > 0, "adaptive coverage emits categories from discovered roles", `categories: ${JSON.stringify(categories)}`);
    check(loop.result.files.length > 0, "retrieval returns evidence for the unfamiliar concept", `files: ${loop.result.files.length}`);
    check(loop.stoppedBecause !== undefined, "loop reports a stop reason", `stop: ${loop.stoppedBecause}`);
    assertBudgetInvariants("adaptive", loop.result);
  }

  // Section 10: adaptive affiliation in the loop — role-guarded evidence.
  console.log("");
  console.log("=== 10. Adaptive affiliation: role-guarded targeted retrieval ===");
  {
    // One auth concept spanning service, controller and repository files; the
    // controller/repository membership comes from /auth routes, and only the
    // service file's retrieved slice carries the concept vocabulary.
    const roles = buildMock("loop_roles",
      [
        {
          id: "roles_service",
          path: "backend/src/services/authService.js",
          role: "service",
          lines: 160,
          symbols: [["verifyAuthSession", 30, true]],
          text: (n) => (n === 30 ? "function verifyAuthSession(token) { return authDecode(token); }" : null),
        },
        {
          id: "roles_controller",
          path: "backend/src/controllers/accessRules.js",
          role: "controller",
          lines: 160,
          routes: [{ method: "POST", path: "/auth/submit", line: 15 }],
        },
        {
          id: "roles_repository",
          path: "backend/src/repositories/accessRows.js",
          role: "repository",
          lines: 160,
          routes: [{ method: "POST", path: "/auth/persist", line: 20 }],
        },
      ],
      [
        { source: "roles_controller", target: "roles_service" },
        { source: "roles_service", target: "roles_repository" },
      ]);

    const loop = await retrieveWithCoverageLoop(roles.db as unknown as Db, "loop_roles", "How does authentication work in this project?");
    const guardConcept = loop.coverage.concepts.find((c) => c.token === "auth")!;
    const guardCategory = (category: string) => guardConcept.categories.find((cat) => cat.category === category);
    const service = guardCategory("service");
    const controller = guardCategory("controller");
    const repository = guardCategory("repository");

    check(
      service?.status === "found" && service.evidence.every((e) => e.path === "backend/src/services/authService.js"),
      "the service file's concept text founds only the service category",
      `service wrong: ${JSON.stringify(service)}`,
    );
    check(
      controller !== undefined && controller.status !== "found" &&
        controller.evidence.every((e) => e.path === "backend/src/controllers/accessRules.js"),
      "the unrelated service file is never accepted as controller evidence (controller stays missing)",
      `controller wrong: ${JSON.stringify(controller)}`,
    );
    check(
      repository !== undefined && repository.status !== "found" &&
        repository.evidence.every((e) => e.path === "backend/src/repositories/accessRows.js"),
      "the unrelated service file is never accepted as repository evidence (repository stays missing)",
      `repository wrong: ${JSON.stringify(repository)}`,
    );
    check(
      loop.stoppedBecause !== "sufficient-coverage" && loop.passes.length >= 1 &&
        loop.passes[0]!.categories.includes("controller"),
      "false coverage did not stop the loop: the controller category stayed missing and was targeted",
      `stop: ${loop.stoppedBecause}, passes: ${JSON.stringify(loop.passes)}`,
    );
    assertBudgetInvariants("roles", loop.result);

    // Same repository, but the controller file carries a real auth slice deep
    // in the file. Retrieving that slice can legitimately mark controller
    // coverage found — via the controller file, never the service file.
    const rolesFound = buildMock("loop_roles_found",
      [
        {
          id: "froles_service",
          path: "backend/src/services/authService.js",
          role: "service",
          lines: 160,
          symbols: [["verifyAuthSession", 30, true]],
          text: (n) => (n === 30 ? "function verifyAuthSession(token) { return authDecode(token); }" : null),
        },
        {
          id: "froles_controller",
          path: "backend/src/controllers/accessRules.js",
          role: "controller",
          lines: 160,
          symbols: [["submitAuthRequest", 96, true]],
          text: (n) => (n === 96 ? "async function submitAuthRequest(req) { return authSubmit(req.body); }" : null),
        },
        {
          id: "froles_repository",
          path: "backend/src/repositories/accessRows.js",
          role: "repository",
          lines: 160,
          routes: [{ method: "POST", path: "/auth/persist", line: 20 }],
        },
      ],
      [
        { source: "froles_controller", target: "froles_service" },
        { source: "froles_service", target: "froles_repository" },
      ]);

    const loopFound = await retrieveWithCoverageLoop(rolesFound.db as unknown as Db, "loop_roles_found", "How does authentication work in this project?");
    const foundConcept = loopFound.coverage.concepts.find((c) => c.token === "auth")!;
    const foundCategory = (category: string) => foundConcept.categories.find((cat) => cat.category === category);
    const foundService = foundCategory("service");
    const foundController = foundCategory("controller");
    const foundRepository = foundCategory("repository");

    check(
      foundController?.status === "found" &&
        foundController.evidence.every((e) => e.path === "backend/src/controllers/accessRules.js" && e.signal === "source-text"),
      "retrieving the controller file with relevant source evidence marks controller coverage found (its own file only)",
      `controller wrong: ${JSON.stringify(foundController)}`,
    );
    check(
      foundService?.status === "found" && foundService.evidence.every((e) => e.path === "backend/src/services/authService.js"),
      "the service category stays grounded in the service file alone",
      `service wrong: ${JSON.stringify(foundService)}`,
    );
    check(
      foundRepository !== undefined && foundRepository.status !== "found",
      "the repository category is never marked found without repository evidence",
      `repository wrong: ${JSON.stringify(foundRepository)}`,
    );
    assertBudgetInvariants("roles-found", loopFound.result);
  }

// ---- 11. Vacuous coverage no longer stops the loop (Phase 1D, V1/V9) ----
{
  // A question whose concepts are entirely out of vocabulary against a repo
  // with no path/symbol match: pass 0 abstains (no direct seeds outside an
  // iterative pass). Pre-fix the empty-evidence planner concepts evaluated
  // to nothing, the drill list was empty, and the loop stopped
  // "sufficient-coverage" without ever looking again. Now every such
  // concept evaluates under its own name, the loop drills once with the
  // concept vocabulary, and the stop is honest.
  const v9 = buildMock("loop_v9", [
    {
      id: "v9_mw",
      path: "backend/src/middlewares/auditTrail.js",
      role: "middleware",
      lines: 60,
    },
  ]);
  const loop = await retrieveWithCoverageLoop(
    v9.db as unknown as Db,
    "loop_v9",
    "How are widgetfield transactions enforced?",
    { adaptive: false },
  );
  check(
    loop.stoppedBecause === "no-candidates" && loop.passes.length === 1,
    "an out-of-vocabulary role-only question drills instead of stopping vacuously",
    `stoppedBecause=${loop.stoppedBecause} passes=${loop.passes.length}`,
  );
  const queries = loop.passes.flatMap((p) => p.queries);
  check(
    queries.includes("widgetfield") && queries.includes("transactions"),
    "the drill runs the unmatched concepts' own vocabulary (bare tokens, no junk words)",
    `queries=${JSON.stringify(queries)}`,
  );
  check(
    loop.coverage.summary.unknown >= 2 &&
      loop.coverage.concepts.every((c) => c.categories.length === 1),
    "every empty-evidence plan concept evaluates under its own name as unknown",
    `summary=${JSON.stringify(loop.coverage.summary)} categories=${JSON.stringify(loop.coverage.concepts.map((c) => c.categories.map((x) => x.category)))}`,
  );
  check(
    loop.result.windows.length === 0 && loop.result.insufficientEvidence === true,
    "an honestly-drilled but seed-less question still abstains with an empty package",
    `windows=${loop.result.windows.length} insufficient=${loop.result.insufficientEvidence}`,
  );
  assertBudgetInvariants("v9-drill", loop.result);
}

// ---- 12. Adaptive coverage drills for unmatched plan concepts (Phase 1D, V1) ----
{
  // One matched concept (telemetry, all categories found) plus an unmatched
  // sibling concept (widget) whose file text carries no concept vocabulary:
  // the widget coverage starts partial, drives exactly one focused pass run
  // with the bare concept token, and lands honestly (nothing new to add).
  const unmatched = buildMock("loop_unmatched", [
    {
      id: "tel_collector",
      path: "src/telemetry/collector.js",
      role: "service",
      lines: 80,
      symbols: [["TelemetryCollector", 10, true]],
      text: (n) => (n === 10 ? "class TelemetryCollector { track(event) { return event; } }" : null),
    },
    {
      id: "tel_export",
      path: "src/telemetry/exporter.js",
      role: "service",
      lines: 80,
      symbols: [["exportTelemetry", 20, true]],
      text: (n) => (n === 20 ? "export function exportTelemetry(event) { return fetch(event); }" : null),
    },
    {
      id: "uw",
      path: "src/panels/panel.js",
      lines: 60,
      symbols: [["WidgetPanel", 10, true]],
    },
  ]);
  const loop = await retrieveWithCoverageLoop(
    unmatched.db as unknown as Db,
    "loop_unmatched",
    "How does telemetry work with the widget?",
  );
  check(
    loop.passes.length === 1 && loop.passes[0]!.queries[0] === "widget",
    "the unmatched widget concept drives exactly one drill with the bare token",
    `passes=${JSON.stringify(loop.passes.map((p) => p.queries))}`,
  );
  check(
    loop.passes[0]!.categories.every((c) => c === "widget"),
    "fixture precondition: only the widget category was missing when the pass ran",
    `pass categories=${JSON.stringify(loop.passes[0]!.categories)}`,
  );
  check(
    loop.stoppedBecause === "no-candidates",
    "the partial-driven drill lands honestly when the focused pass adds nothing new",
    `stoppedBecause=${loop.stoppedBecause}`,
  );
  const widgetEntry = loop.coverage.concepts.find((c) => c.token === "widget");
  check(
    widgetEntry !== undefined &&
      widgetEntry.categories.length === 1 &&
      widgetEntry.categories[0]!.category === "widget",
    "the adaptive coverage keeps the unmatched widget concept under its own name",
    `widget wrong: ${JSON.stringify(widgetEntry)}`,
  );
  assertBudgetInvariants("unmatched-drill", loop.result);
}

// ---- 13. Role-less concepts drill under their own name (Phase 1D, V7b) ----
{
  // A concept whose files never received indexed roles: pre-fix its
  // coverage category was the literal "unclassified" and the drill query
  // embedded that junk word. Now the concept drills its own display name.
  const roleless = buildMock("loop_v7b", [
    { id: "v7b_panel", path: "src/renders/panel.js", lines: 60, symbols: [["widgetPanel", 10, true]] },
    { id: "v7b_dock", path: "src/renders/dock.js", lines: 60, symbols: [["widgetDock", 20, true]] },
  ]);
  const loop = await retrieveWithCoverageLoop(
    roleless.db as unknown as Db,
    "loop_v7b",
    "How does widget rendering work?",
  );
  const conceptEntry = loop.coverage.concepts.find((c) =>
    c.categories.some((cat) => cat.status !== "found"),
  );
  check(
    conceptEntry !== undefined &&
      conceptEntry.token !== "unclassified" &&
      !loop.passes.flatMap((p) => p.queries).some((q) => q.includes("unclassified")),
    "the role-less concept drills its own display name, never the 'unclassified' junk word",
    `token=${conceptEntry?.token} queries=${JSON.stringify(loop.passes.flatMap((p) => p.queries))}`,
  );
  check(
    conceptEntry !== undefined &&
      loop.passes.length === 1 &&
      loop.passes[0]!.queries[0] === conceptEntry.token,
    "the focused query for a role-less concept is exactly its display name",
    `queries=${JSON.stringify(loop.passes.flatMap((p) => p.queries))}`,
  );
  check(
    loop.coverage.concepts
      .flatMap((c) => c.categories)
      .every((cat) => cat.category !== "unclassified"),
    "no 'unclassified' category is ever emitted by the loop's coverage evaluation",
    `categories=${JSON.stringify(loop.coverage.concepts.flatMap((c) => c.categories.map((cat) => cat.category)))}`,
  );
  assertBudgetInvariants("v7b-drill", loop.result);
}

// ---- 14. An explicitly-named file is the question's scope (Phase 1D, V10) ----
{
  // Manifest-shaped question naming its file outright: pass 0 serves the
  // named file, and every leftover category (self-named oov tokens from the
  // file path, planner/adaptive category pairs) stays honestly unknown
  // instead of pulling unrelated repository structure into the package.
  // Pre-V10 the self-named "package" pair drilled the whole packages/* tree
  // (broad path noise), and category pairs added monorepo files the manifest
  // question never asked about (QA-07 shape).
  const anchor = buildMock("loop_anchor", [
    {
      id: "am_web",
      path: "packages/web/package.json",
      lines: 9,
      text: (n) => [
        '{',
        '  "name": "@monorepo/web",',
        '  "dependencies": {',
        '    "next": "16.0.0",',
        '    "react": "19.0.0"',
        '  }',
        '}',
        "// line 8",
        "// line 9",
      ][n - 1] ?? null,
    },
    {
      id: "am_ctrl",
      path: "packages/api/src/users/users.controller.ts",
      lines: 40,
      role: "controller",
      symbols: [["UsersController", 5, true]],
    },
    {
      id: "am_svc",
      path: "packages/api/src/users/users.service.ts",
      lines: 40,
      role: "service",
      symbols: [["UsersService", 5, true]],
    },
  ]);
  const question =
    "What dependencies are declared by @monorepo/web in packages/web/package.json, and does it declare @monorepo/api?";
  const loop = await retrieveWithCoverageLoop(anchor.db as unknown as Db, "loop_anchor", question);
  const single = await retrieveGroundedContext(anchor.db as unknown as Db, "loop_anchor", question);
  check(
    loop.result.windows.some((w) => w.reason.startsWith("file explicitly named in query")),
    "fixture precondition: pass 0 served a window for the file the question names",
    `reasons: ${JSON.stringify(loop.result.windows.map((w) => w.reason))}`,
  );
  check(
    loop.stoppedBecause === "explicit-anchor",
    "the loop stops with explicit-anchor instead of drilling speculative categories",
    `stoppedBecause=${loop.stoppedBecause} passes=${JSON.stringify(loop.passes)}`,
  );
  check(
    loop.passes.length === 0,
    "no focused pass runs for an explicitly-named question",
    `passes: ${JSON.stringify(loop.passes)}`,
  );
  const anchorWindow = loop.result.windows.map((w) => `${w.fileId}:${w.startLine}-${w.endLine}`).join(",");
  const singleWindow = single.windows.map((w) => `${w.fileId}:${w.startLine}-${w.endLine}`).join(",");
  check(
    anchorWindow === singleWindow && single.windows.length > 0,
    "the anchored loop package is exactly the pass-0 package (no drift)",
    `anchor=${anchorWindow} single=${singleWindow}`,
  );
  check(
    loop.coverage.summary.unknown > 0,
    "leftover categories remain honestly unknown in the coverage block",
    `summary=${JSON.stringify(loop.coverage.summary)}`,
  );
  assertBudgetInvariants("anchor", loop.result);
}

// ---- Summary ----
console.log("");
for (const line of results) console.log(line);
console.log("");
const fails = results.filter((r) => r.startsWith("FAIL"));
if (fails.length === 0) {
  console.log("Every check passed.");
} else {
  console.log(`${fails.length} check(s) failed.`);
  process.exitCode = 1;
}
