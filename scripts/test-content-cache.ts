// Checks the bounded LRU cache for source-file contents: lib/content/cache.ts
//
// Tests:
// - Cache hit and miss
// - LRU promotion (accessing an item prevents eviction)
// - LRU eviction when entry limit exceeded
// - LRU eviction when byte budget exceeded
// - Organization isolation (org A cannot read org B's cache entry)
// - Same content hash across different organizations kept separate
// - Null values / failed reads / hash mismatch never cached
// - Mutable buffer protection (caller mutating returned buffer does not corrupt cache)
// - Explicit delete and clear operations
// - Accurate statistics reporting (hits, misses, evictions, current size)
//
//   node scripts/test-content-cache.ts

import { ContentCache, cachedGetContent, getContentCache, resetContentCache } from "../lib/content/cache.ts";
import { getFileContent, getFileLines } from "../lib/content/read.ts";
import { sha256 } from "../lib/content/store.ts";
import type { Db } from "../lib/content/types.ts";

const results: string[] = [];
const pass = (m: string) => results.push(`ok    ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);
const check = (message: string, condition: boolean) => {
  if (condition) pass(message);
  else fail(message);
};

const text = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

async function main(): Promise<void> {
  // --- 1. Basic get/set, cache hit and miss ---
  {
    const cache = new ContentCache();
    const bytes = text("console.log('hello');");
    const hash = sha256(bytes);

    check("cache miss on empty cache returns undefined", cache.get("org-1", hash) === undefined);

    cache.set("org-1", hash, bytes);
    const retrieved = cache.get("org-1", hash);
    check("cache hit returns correct bytes", retrieved !== undefined && Buffer.from(retrieved).equals(Buffer.from(bytes)));

    const stats = cache.getStats();
    check("stats record 1 hit, 1 miss, 1 entry", stats.hits === 1 && stats.misses === 1 && stats.currentEntries === 1);
  }

  // --- 2. Organization isolation ---
  {
    const cache = new ContentCache();
    const bytesA = text("content for org A");
    const bytesB = text("content for org B");
    const hashA = sha256(bytesA);
    const hashB = sha256(bytesB);

    cache.set("org-a", hashA, bytesA);
    cache.set("org-b", hashB, bytesB);

    check("org-b cannot access org-a's cached content", cache.get("org-b", hashA) === undefined);
    check("org-a cannot access org-b's cached content", cache.get("org-a", hashB) === undefined);
    check("org-a can access its own content", cache.get("org-a", hashA) !== undefined);
    check("org-b can access its own content", cache.get("org-b", hashB) !== undefined);
  }

  // --- 3. Same hash across different organizations ---
  {
    const cache = new ContentCache();
    const identicalBytes = text("identical shared library file");
    const hash = sha256(identicalBytes);

    cache.set("org-1", hash, identicalBytes);
    cache.set("org-2", hash, identicalBytes);

    check("both organizations hold entries for identical hash", cache.get("org-1", hash) !== undefined && cache.get("org-2", hash) !== undefined);
    check("cache tracks 2 entries for identical hash in different orgs", cache.getStats().currentEntries === 2);

    cache.delete("org-1", hash);
    check("deleting entry for org-1 leaves org-2 intact", cache.get("org-1", hash) === undefined && cache.get("org-2", hash) !== undefined);
  }

  // --- 4. Entry limit eviction ---
  {
    // Configure cache for max 3 entries
    const cache = new ContentCache({ maxEntries: 3, maxBytes: 1024 * 1024 });

    const b1 = text("item 1");
    const b2 = text("item 2");
    const b3 = text("item 3");
    const b4 = text("item 4");

    const h1 = sha256(b1);
    const h2 = sha256(b2);
    const h3 = sha256(b3);
    const h4 = sha256(b4);

    cache.set("org-1", h1, b1);
    cache.set("org-1", h2, b2);
    cache.set("org-1", h3, b3);

    check("cache contains 3 entries", cache.getStats().currentEntries === 3);

    // Adding 4th item evicts oldest (h1)
    cache.set("org-1", h4, b4);

    check("cache size remains capped at 3 entries", cache.getStats().currentEntries === 3);
    check("oldest entry (h1) was evicted", cache.get("org-1", h1) === undefined);
    check("entries h2, h3, h4 are present", cache.get("org-1", h2) !== undefined && cache.get("org-1", h3) !== undefined && cache.get("org-1", h4) !== undefined);
    check("stats recorded 1 eviction", cache.getStats().evictions === 1);
  }

  // --- 5. LRU promotion ---
  {
    // Configure cache for max 3 entries
    const cache = new ContentCache({ maxEntries: 3, maxBytes: 1024 * 1024 });

    const b1 = text("item 1");
    const b2 = text("item 2");
    const b3 = text("item 3");
    const b4 = text("item 4");

    const h1 = sha256(b1);
    const h2 = sha256(b2);
    const h3 = sha256(b3);
    const h4 = sha256(b4);

    cache.set("org-1", h1, b1);
    // Slight delay to ensure distinct timestamps
    await new Promise((r) => setTimeout(r, 5));
    cache.set("org-1", h2, b2);
    await new Promise((r) => setTimeout(r, 5));
    cache.set("org-1", h3, b3);

    // Access h1 to promote it to most recently used
    await new Promise((r) => setTimeout(r, 5));
    cache.get("org-1", h1);

    // Now adding h4 should evict h2 (least recently used, since h1 was promoted)
    await new Promise((r) => setTimeout(r, 5));
    cache.set("org-1", h4, b4);

    check("promoted entry h1 was NOT evicted", cache.get("org-1", h1) !== undefined);
    check("un-promoted entry h2 WAS evicted", cache.get("org-1", h2) === undefined);
    check("entries h3, h4 remain cached", cache.get("org-1", h3) !== undefined && cache.get("org-1", h4) !== undefined);
  }

  // --- 6. Byte budget eviction ---
  {
    // Configure cache with 100 bytes limit
    const cache = new ContentCache({ maxEntries: 100, maxBytes: 100 });

    const b1 = new Uint8Array(40); // 40 bytes
    const b2 = new Uint8Array(40); // 40 bytes
    const b3 = new Uint8Array(40); // 40 bytes (total 120 > 100 -> must evict)

    b1.fill(1);
    b2.fill(2);
    b3.fill(3);

    const h1 = sha256(b1);
    const h2 = sha256(b2);
    const h3 = sha256(b3);

    cache.set("org-1", h1, b1);
    cache.set("org-1", h2, b2);

    check("cache holds 80 bytes for 2 items", cache.getStats().currentSize === 80);

    // Setting 3rd item brings total to 120, exceeding 100 limit -> evicts h1
    cache.set("org-1", h3, b3);

    check("cache total size stays under 100 bytes limit", cache.getStats().currentSize <= 100);
    check("h1 was evicted due to byte limit", cache.get("org-1", h1) === undefined);
    check("h2 and h3 remain in cache", cache.get("org-1", h2) !== undefined && cache.get("org-1", h3) !== undefined);
  }

  // --- 7. Mutable buffer protection ---
  {
    const cache = new ContentCache();
    const original = text("immutable original content");
    const hash = sha256(original);

    cache.set("org-1", hash, original);

    // Mutate the original buffer that was passed in
    original[0] = 0x58; // 'X'

    // Verify cache was not corrupted
    const read1 = cache.get("org-1", hash)!;
    check("mutating passed buffer does not corrupt cache", read1[0] !== 0x58 && read1[0] === 0x69); // 'i'

    // Mutate the buffer returned from get()
    read1[0] = 0x5a; // 'Z'

    // Verify cache remains uncorrupted on subsequent read
    const read2 = cache.get("org-1", hash)!;
    check("mutating retrieved buffer does not corrupt cache", read2[0] === 0x69);
  }

  // --- 8. Delete and clear operations ---
  {
    const cache = new ContentCache();
    const b1 = text("file 1");
    const b2 = text("file 2");
    const h1 = sha256(b1);
    const h2 = sha256(b2);

    cache.set("org-1", h1, b1);
    cache.set("org-1", h2, b2);

    check("delete existing entry returns true", cache.delete("org-1", h1) === true);
    check("delete non-existing entry returns false", cache.delete("org-1", h1) === false);
    check("deleted entry is no longer present", cache.get("org-1", h1) === undefined);
    check("other entry is still present", cache.get("org-1", h2) !== undefined);

    cache.clear();
    check("clear empties the cache completely", cache.getStats().currentEntries === 0 && cache.getStats().currentSize === 0);
    check("entry h2 is gone after clear", cache.get("org-1", h2) === undefined);
  }

  // --- 9. Invalidate organization ---
  {
    const cache = new ContentCache();
    const bA1 = text("org A file 1");
    const bA2 = text("org A file 2");
    const bB1 = text("org B file 1");

    cache.set("org-a", sha256(bA1), bA1);
    cache.set("org-a", sha256(bA2), bA2);
    cache.set("org-b", sha256(bB1), bB1);

    check("cache has 3 entries initially", cache.getStats().currentEntries === 3);

    const invalidated = cache.invalidateOrganization("org-a");
    check("invalidateOrganization removed 2 entries for org-a", invalidated === 2);
    check("org-b entries remain untouched", cache.get("org-b", sha256(bB1)) !== undefined);
    check("org-a entries are gone", cache.get("org-a", sha256(bA1)) === undefined && cache.get("org-a", sha256(bA2)) === undefined);
  }

  // --- 10. cachedGetContent middleware: null and error safety ---
  {
    const cache = new ContentCache();
    const goodBytes = text("good content");
    const goodHash = sha256(goodBytes);

    // Call with null fetcher result
    let fetchCalls = 0;
    const nullResult = await cachedGetContent(
      "org-1",
      "nonexistent-hash",
      async () => {
        fetchCalls++;
        return null;
      },
      cache,
    );

    check("cachedGetContent returns null when fetcher returns null", nullResult === null);
    check("null results are NOT cached", cache.get("org-1", "nonexistent-hash") === undefined);

    // Subsequent call should fetch again because null was not cached
    await cachedGetContent(
      "org-1",
      "nonexistent-hash",
      async () => {
        fetchCalls++;
        return null;
      },
      cache,
    );
    check("second attempt on nonexistent content fetches again (not cached)", fetchCalls === 2);

    // Call with hash mismatch
    const badBytes = text("wrong content");
    const badResult = await cachedGetContent(
      "org-1",
      goodHash, // request goodHash, but fetcher returns badBytes
      async () => badBytes,
      cache,
    );

    check("hash mismatch content is returned to caller", badResult === badBytes);
    check("hash mismatch content is NOT stored in cache", cache.get("org-1", goodHash) === undefined);

    // Successful cached read
    let successfulFetches = 0;
    const fetcher = async () => {
      successfulFetches++;
      return goodBytes;
    };

    const first = await cachedGetContent("org-1", goodHash, fetcher, cache);
    check("first fetch populates cache", first !== null && successfulFetches === 1);

    const second = await cachedGetContent("org-1", goodHash, fetcher, cache);
    check("second fetch served from cache without calling fetcher", second !== null && successfulFetches === 1);
  }

  // --- 11. Singleton reset and getFileContent / getFileLines integration ---
  {
    resetContentCache();
    const c1 = getContentCache({ maxBytes: 1000 });
    check("getContentCache returns an initialized ContentCache instance", c1 instanceof ContentCache);
    const c2 = getContentCache();
    check("subsequent getContentCache returns the same singleton instance", c1 === c2);
    resetContentCache();
    const c3 = getContentCache();
    check("resetContentCache cleared singleton so a fresh instance is returned", c1 !== c3);

    // Mock DB for getFileContent integration
    const sourceText = "line 1: export const x = 42;\nline 2: export const y = 100;\n";
    const sourceBytes = text(sourceText);
    const sourceHash = sha256(sourceBytes);

    let contentDbReads = 0;
    const testCache = new ContentCache();

    const fakeDb = {
      from: (table: string) => {
        if (table === "files") {
          return {
            select: () => ({
              eq: (_col: string, val: string) => ({
                maybeSingle: async () => {
                  if (val === "f-test") {
                    return {
                      data: {
                        id: "f-test",
                        path: "src/test.ts",
                        hash: sourceHash,
                        lines: 2,
                        content_status: "stored",
                        organization_id: "org-cache-test",
                        analysis: null,
                      },
                      error: null,
                    };
                  }
                  return { data: null, error: null };
                },
              }),
            }),
          };
        }
        if (table === "file_contents") {
          return {
            select: () => ({
              eq: (_col1: string, orgVal: string) => ({
                eq: (_col2: string, hashVal: string) => ({
                  maybeSingle: async () => {
                    contentDbReads++;
                    if (orgVal === "org-cache-test" && hashVal === sourceHash) {
                      return {
                        data: {
                          payload: "\\x" + Buffer.from(sourceBytes).toString("hex"),
                          size: sourceBytes.byteLength,
                        },
                        error: null,
                      };
                    }
                    return { data: null, error: null };
                  },
                }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    } as unknown as Db;

    // First read: cache miss, reads from DB
    const read1 = await getFileContent(fakeDb, "f-test", { cache: testCache });
    check("first getFileContent reads source correctly", read1 === sourceText);
    check("first read accessed DB content table once", contentDbReads === 1);
    check("cache recorded 1 miss and 1 entry", testCache.getStats().misses === 1 && testCache.getStats().currentEntries === 1);

    // Second read: cache hit, bypasses DB!
    const read2 = await getFileContent(fakeDb, "f-test", { cache: testCache });
    check("second getFileContent returns exact same source", read2 === sourceText);
    check("second read did not access DB (served from cache)", contentDbReads === 1);
    check("cache recorded 1 hit", testCache.getStats().hits === 1);

    // getFileLines also served from cache without DB access
    const line2 = await getFileLines(fakeDb, "f-test", 2, 2, { cache: testCache });
    check("getFileLines served from cache returns line 2", line2 === "line 2: export const y = 100;");
    check("getFileLines did not touch DB", contentDbReads === 1);

    // Explicit cache: null bypasses cache and hits DB again
    const readUncached = await getFileContent(fakeDb, "f-test", { cache: null });
    check("cache: null returns correct source", readUncached === sourceText);
    check("cache: null reached DB again", contentDbReads === 2);
  }
}

main()
  .catch((error) => {
    console.error("Test failed with unexpected error:", error);
    fail(`unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  })
  .finally(() => {
    console.log("");
    for (const line of results) console.log(line);
    const failed = results.filter((r) => r.startsWith("FAIL")).length;
    console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
    process.exit(failed === 0 ? 0 : 1);
  });
