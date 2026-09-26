import type { ImmuneMemoryEntry } from '../shared/types';

export interface CacheMetrics {
  hits: number;
  misses: number;
}

export class LRUCache<T> {
  private capacity: number;
  private cache: Map<string, T>;
  public metrics: CacheMetrics;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.cache = new Map<string, T>();
    this.metrics = { hits: 0, misses: 0 };
  }

  get(key: string): T | undefined {
    if (this.cache.has(key)) {
      const value = this.cache.get(key)!;
      // Refresh MRU
      this.cache.delete(key);
      this.cache.set(key, value);
      this.metrics.hits++;
      return value;
    }
    this.metrics.misses++;
    return undefined;
  }

  set(key: string, value: T): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      // Evict LRU (first item in Map)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
    this.metrics = { hits: 0, misses: 0 };
  }

  get size(): number {
    return this.cache.size;
  }
}
