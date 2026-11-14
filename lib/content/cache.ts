// A bounded, process-local LRU cache for verified source-file contents.
// Keys are (organization_id, content_hash) — the hash makes re-indexing
// invalidate by miss, not by purge, and prevents cross-org data leakage.
//
// The cache is deliberately process-local: in multi-instance deployments,
// each instance maintains its own cache. Stale entries from GC'd content are
// harmless — a miss falls through to the database. This avoids the complexity
// of distributed invalidation for a bounded, in-memory structure.
//
// Memory is bounded by:
// - maxBytes: total cache size budget (default 32 MB)
// - maxEntries: maximum number of cached items (default 256, the approximate
//   count of 128 KB average files that fills 32 MB)

import { createHash } from "node:crypto";

/** Configuration for the content cache. */
export type CacheConfig = {
  /** Maximum total bytes held in the cache. Default: 32 MB */
  maxBytes: number;
  /** Maximum number of entries. Default: 256 */
  maxEntries: number;
};

/** Default cache configuration, matching the design in file-content-storage.md §7.2 */
export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  maxBytes: 32 * 1024 * 1024, // 32 MB
  maxEntries: 256,
};

/** Statistics about cache performance. */
export type CacheStats = {
  hits: number;
  misses: number;
  evictions: number;
  currentSize: number;
  currentEntries: number;
};

/** One cached content entry, immutable once stored. */
type CacheEntry = {
  /** The content bytes, stored as a Uint8Array. */
  data: Uint8Array;
  /** Size in bytes, pre-computed to avoid buffer property access. */
  size: number;
  /** Timestamp for LRU ordering — milliseconds since epoch. */
  lastAccessed: number;
};

/** A cache key scoped to one organization, so content is never shared across orgs. */
export type CacheKey = {
  organizationId: string;
  contentHash: string;
};

function keyToString(key: CacheKey): string {
  return `${key.organizationId}:${key.contentHash}`;
}

/**
 * A bounded LRU cache for source-file contents.
 *
 * Thread-safety note: this is process-local and not thread-safe. In Node.js,
 * that's fine — there's one event loop. The cache is designed for the read
 * path, which is single-threaded per request.
 */
export class ContentCache {
  private readonly config: CacheConfig;
  private readonly store = new Map<string, CacheEntry>();
  private currentBytes = 0;
  private clock = 0;
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    currentSize: 0,
    currentEntries: 0,
  };

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
  }

  /** Get a cached entry, returning undefined if absent or stale. */
  get(organizationId: string, contentHash: string): Uint8Array | undefined {
    const key = keyToString({ organizationId, contentHash });
    const entry = this.store.get(key);

    if (entry === undefined) {
      this.stats.misses++;
      this.updateStats();
      return undefined;
    }

    // LRU promotion: update access order
    entry.lastAccessed = ++this.clock;
    this.stats.hits++;
    this.updateStats();

    // Return a copy to protect the internal buffer from mutation
    return new Uint8Array(entry.data);
  }

  /**
   * Store content in the cache.
   *
   * Never caches: null results, failed reads, hash verification failures,
   * oversized files (> maxBytes would indicate a corrupt store call), or
   * partially read content.
   */
  set(organizationId: string, contentHash: string, data: Uint8Array): void {
    // Reject oversized entries — this shouldn't happen since the parser
    // already limits to MAX_FILE_BYTES, but defense in depth.
    if (data.byteLength > this.config.maxBytes) {
      console.warn(`Content cache: refusing to cache oversized entry (${data.byteLength} bytes)`);
      return;
    }

    const key = keyToString({ organizationId, contentHash });
    const existing = this.store.get(key);

    // If updating an existing entry, subtract its size from currentBytes first
    if (existing) {
      this.currentBytes -= existing.size;
    }

    // Evict entries until we fit
    while (
      this.store.size >= this.config.maxEntries ||
      this.currentBytes + data.byteLength > this.config.maxBytes
    ) {
      this.evictLRU();
    }

    // Store the new entry (copy to protect against external mutation)
    const entry: CacheEntry = {
      data: new Uint8Array(data),
      size: data.byteLength,
      lastAccessed: ++this.clock,
    };

    this.store.set(key, entry);
    this.currentBytes += data.byteLength;
    this.updateStats();
  }

  /** Delete a specific entry from the cache. */
  delete(organizationId: string, contentHash: string): boolean {
    const key = keyToString({ organizationId, contentHash });
    const entry = this.store.get(key);

    if (entry === undefined) {
      return false;
    }

    this.currentBytes -= entry.size;
    this.store.delete(key);
    this.updateStats();
    return true;
  }

  /** Clear all entries from the cache. */
  clear(): void {
    this.store.clear();
    this.currentBytes = 0;
    this.updateStats();
  }

  /**
   * Invalidate entries by organization — call when GC deletes content
   * for an org. This removes cached entries that now point to deleted rows.
   */
  invalidateOrganization(organizationId: string): number {
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (key.startsWith(`${organizationId}:`)) {
        this.currentBytes -= entry.size;
        this.store.delete(key);
        removed++;
      }
    }
    this.updateStats();
    return removed;
  }

  /** Get current statistics. */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /** Evict the least recently used entry. */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.store) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      const entry = this.store.get(oldestKey)!;
      this.currentBytes -= entry.size;
      this.store.delete(oldestKey);
      this.stats.evictions++;
    }
  }

  private updateStats(): void {
    this.stats.currentSize = this.currentBytes;
    this.stats.currentEntries = this.store.size;
  }
}

/** Singleton cache instance, lazily initialized. */
let cacheInstance: ContentCache | null = null;

/**
 * Get the singleton content cache instance.
 * Uses lazy initialization so config can be set before first use.
 */
export function getContentCache(config?: Partial<CacheConfig>): ContentCache {
  if (cacheInstance === null) {
    cacheInstance = new ContentCache(config);
  }
  return cacheInstance;
}

/** Reset the cache singleton — useful for testing. */
export function resetContentCache(): void {
  cacheInstance = null;
}

/**
 * Content cache middleware for the read path.
 * Wraps a content-fetching function with cache lookups.
 */
export async function cachedGetContent(
  organizationId: string,
  contentHash: string,
  fetchContent: () => Promise<Uint8Array | null>,
  cache: ContentCache = getContentCache(),
): Promise<Uint8Array | null> {
  // Try cache first
  const cached = cache.get(organizationId, contentHash);
  if (cached !== undefined) {
    return cached;
  }

  // Cache miss — fetch from source
  const content = await fetchContent();
  if (content === null) {
    return null;
  }

  // Verify the fetched content matches the requested hash (defense in depth)
  // The store already does this, but the cache key includes the hash so we
  // want to be certain we're caching what we think we're caching.
  const actualHash = sha256Sync(content);
  if (actualHash !== contentHash) {
    console.warn(`Content cache: fetched content hash mismatch (expected ${contentHash}, got ${actualHash})`);
    return content;
  }

  // Cache the verified content
  cache.set(organizationId, contentHash, content);
  return content;
}

// Synchronous SHA256 for cache verification — avoids async overhead
function sha256Sync(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
