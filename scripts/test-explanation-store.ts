// Checks the explanation store: an answer fetched on a page is still there
// after the page is rendered again, and a request in flight isn't mistaken
// for a finished answer.
//
//   node scripts/test-explanation-store.ts

// A session storage to write to. The store reads it lazily, so this has to be
// in place before the first call.
class FakeStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}
(globalThis as { sessionStorage?: unknown }).sessionStorage = new FakeStorage();

const results: string[] = [];
const pass = (m: string) => {
  results.push(`ok    ${m}`);
};
const fail = (m: string) => {
  results.push(`FAIL  ${m}`);
};

type ExplanationState = { status: "loading" } | { status: "done"; result: { body: string } } | { status: "error"; error: string };

const done = (body: string): ExplanationState => ({ status: "done", result: { body } });

// The module holds the answers in memory as well as on disk, so a fresh
// import stands in for a page that was rendered again.
async function freshStore() {
  return import(`../components/explanation-store.ts?reload=${Math.random()}`);
}

const A = "analysis-one";
const B = "analysis-two";

{
  const store = await freshStore();

  if (store.explanationsFor(A).size === 0) {
    pass("an empty store holds nothing");
  } else {
    fail("a fresh store isn't empty");
  }

  store.setExplanation(A, "file:auth.ts", done("the auth file"));
  store.setExplanation(A, "file:middleware.ts", done("the middleware file"));

  const after = store.explanationsFor(A);
  if (after.size === 2) {
    pass("both answers are held");
  } else {
    fail(`held ${after.size}, expected 2`);
  }
  if (after.get("file:auth.ts")?.status === "done") {
    pass("the answer is found by its target");
  } else {
    fail("the answer isn't found by its target");
  }
  if (store.explanationsFor(B).size === 0) {
    pass("another analysis holds nothing");
  } else {
    fail("another analysis sees this one's answers");
  }
}

{
  // A page rendered again: the same storage, a fresh module.
  const store = await freshStore();
  const after = store.explanationsFor(A);
  if (after.size === 2) {
    pass("the answers survive the page being rendered again");
  } else {
    fail(`after a re-render only ${after.size} of 2 answers were left`);
  }
  if (after.get("file:auth.ts")?.status === "done") {
    pass("the answer is still the one that was fetched");
  } else {
    fail("the answer is not the one that was fetched");
  }
}

{
  // A request in flight is not an answer, and isn't written down.
  const store = await freshStore();
  store.setExplanation(A, "file:auth.ts", { status: "loading" });
  const held = store.explanationsFor(A);
  if (held.get("file:auth.ts")?.status === "loading") {
    pass("a request in flight is shown as one");
  } else {
    fail("a request in flight isn't shown as one");
  }

  const reloaded = await freshStore();
  const onDisk = reloaded.explanationsFor(A);
  if (onDisk.get("file:auth.ts")?.status !== "loading") {
    pass("a request in flight is not written down");
  } else {
    fail("a request in flight was written down");
  }
  if (onDisk.has("file:middleware.ts")) {
    pass("the other answer is still there");
  } else {
    fail("the other answer was lost");
  }
}

{
  // An answer replaced by a new request is still the last one fetched.
  const store = await freshStore();
  store.setExplanation(A, "file:middleware.ts", { status: "loading" });
  const reloaded = await freshStore();
  const onDisk = reloaded.explanationsFor(A);
  const kept = onDisk.get("file:middleware.ts");
  if (kept && kept.status === "done" && kept.result.body === "the middleware file") {
    pass("an answer being replaced is still the last one fetched");
  } else {
    fail(`an answer being replaced became ${JSON.stringify(kept)}`);
  }
}

{
  // A store that can't be read is a store that isn't there.
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem() {
      throw new Error("no storage here");
    },
    setItem() {
      throw new Error("no storage here");
    },
  };
  const store = await freshStore();
  store.setExplanation(A, "file:x.ts", done("x"));
  if (store.explanationsFor(A).size >= 1) {
    pass("a store that can't be written still holds the answer in memory");
  } else {
    fail("a store that can't be written lost the answer");
  }
}

console.log("");
for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

// A module, so the awaits above are allowed.
export {};
