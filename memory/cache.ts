// Fast in-memory lookup cache to evaluate immediate fingerprint matches before hitting vector search

import type { ImmuneMemoryEntry } from '../shared/types';

// ---------------------------------------------------------------------------
// FingerprintCache
// ---------------------------------------------------------------------------
// Provides O(1) exact-match lookups by a canonical fingerprint key derived
// from the incident's errorSignature.  Cache misses fall through to the
// full vector search in ImmuneMemoryStore.
//
// The cache is a simple Map — no external dependencies.
// ---------------------------------------------------------------------------

/**
 * Normalise an error signature into a stable cache key.
 *
 * Strips all whitespace and non-alphanumeric characters, lower-cases, and
 * truncates to 128 chars so keys stay compact.
 */
function toKey(signature: string): string {
  return signature
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 128);
}

export interface CacheEntry {
  memoryEntry: ImmuneMemoryEntry;
  cachedAt: number;   // epoch ms
  hitCount: number;
}

export class FingerprintCache {
  private store = new Map<string, CacheEntry>();

  /**
   * Look up an exact fingerprint match.
   *
   * @param signature  Raw error signature from the incident.
   * @returns          The cached ImmuneMemoryEntry, or `undefined` on a miss.
   */
  get(signature: string): ImmuneMemoryEntry | undefined {
    const key = toKey(signature);
    const entry = this.store.get(key);
    if (!entry) return undefined;

    // Increment hit counter in-place (mutable)
    entry.hitCount += 1;
    return entry.memoryEntry;
  }

  /**
   * Store a memory entry under the given signature key.
   * Replaces any existing entry for the same key (idempotent upsert).
   *
   * @param signature    Raw error signature used as the lookup key.
   * @param memoryEntry  The ImmuneMemoryEntry to cache.
   */
  set(signature: string, memoryEntry: ImmuneMemoryEntry): void {
    const key = toKey(signature);
    const existing = this.store.get(key);
    this.store.set(key, {
      memoryEntry,
      cachedAt: existing?.cachedAt ?? Date.now(),
      hitCount: existing?.hitCount ?? 0,
    });
  }

  /**
   * Remove a single entry from the cache.
   */
  delete(signature: string): boolean {
    return this.store.delete(toKey(signature));
  }

  /**
   * Evict all entries older than `maxAgeMs` milliseconds.
   *
   * @param maxAgeMs  Maximum age in ms; defaults to 10 minutes.
   */
  evictExpired(maxAgeMs = 10 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [key, entry] of this.store.entries()) {
      if (entry.cachedAt < cutoff) {
        this.store.delete(key);
      }
    }
  }

  /** Flush the entire cache. */
  clear(): void {
    this.store.clear();
  }

  /** Number of entries currently cached. */
  get size(): number {
    return this.store.size;
  }

  /**
   * Seed the cache from an array of ImmuneMemoryEntries.
   * Uses each entry's `signature` as the cache key.
   */
  seed(entries: ImmuneMemoryEntry[]): void {
    for (const e of entries) {
      this.set(e.signature, e);
    }
  }

  /** Return all cached entries as an array (useful for debugging). */
  entries(): CacheEntry[] {
    return Array.from(this.store.values());
  }
}
