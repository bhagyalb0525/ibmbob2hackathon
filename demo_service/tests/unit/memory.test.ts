import { ImmuneMemoryStore } from '../../../memory/store';
import { generateEmbedding, generateIncidentEmbedding } from '../../../memory/embeddings';
import { LRUCache } from '../../../memory/cache';

describe('Immune Memory Subsystem - Unit & Integration Tests', () => {
  describe('Embeddings Engine', () => {
    it('should generate an 8-dimensional normalized embedding', () => {
      const emb = generateEmbedding('TypeError: Cannot read properties of undefined reading price');
      expect(emb).toBeDefined();
      expect(emb.length).toBe(8);
      // Verify non-zero and values bounded in [0, 1]
      expect(emb.some(val => val > 0)).toBe(true);
      expect(emb.every(val => val >= 0 && val <= 1)).toBe(true);
    });

    it('should be deterministic: same input generates identical vector', () => {
      const text = 'RangeError: Maximum call stack size exceeded in processPayment';
      const v1 = generateEmbedding(text);
      const v2 = generateEmbedding(text);
      expect(v1).toEqual(v2);
    });

    it('should handle empty or whitespace-only inputs safely with zero vector', () => {
      const empty1 = generateEmbedding('');
      const empty2 = generateEmbedding('   ');
      expect(empty1).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      expect(empty2).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('should support generateIncidentEmbedding with stack trace', () => {
      const emb = generateIncidentEmbedding('TypeError: cart error', 'at calculateCart (cart.ts:54:36)');
      expect(emb.length).toBe(8);
      expect(emb.some(val => val > 0)).toBe(true);
    });
  });

  describe('LRU Cache', () => {
    it('should store and retrieve items, updating recency', () => {
      const cache = new LRUCache<string>(2);
      cache.set('sig1', 'entry1');
      cache.set('sig2', 'entry2');

      expect(cache.size).toBe(2);
      expect(cache.get('sig1')).toBe('entry1'); // sig1 is now MRU
      expect(cache.metrics.hits).toBe(1);
    });

    it('should evict the least recently used item when capacity is exceeded', () => {
      const cache = new LRUCache<string>(2);
      cache.set('sig1', 'entry1');
      cache.set('sig2', 'entry2');

      // Access sig1 so sig2 becomes LRU
      cache.get('sig1');

      // Insert sig3: should evict sig2
      cache.set('sig3', 'entry3');

      expect(cache.has('sig2')).toBe(false);
      expect(cache.has('sig1')).toBe(true);
      expect(cache.has('sig3')).toBe(true);
      expect(cache.size).toBe(2);
    });

    it('should handle missing keys safely', () => {
      const cache = new LRUCache<string>(5);
      expect(cache.get('nonexistent')).toBeUndefined();
      expect(cache.has('nonexistent')).toBe(false);
      expect(cache.metrics.misses).toBe(1);
    });

    it('should support delete and clear', () => {
      const cache = new LRUCache<string>(5);
      cache.set('a', 'alpha');
      cache.set('b', 'beta');
      expect(cache.delete('a')).toBe(true);
      expect(cache.size).toBe(1);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.metrics.hits).toBe(0);
    });
  });

  describe('ImmuneMemoryStore', () => {
    let store: ImmuneMemoryStore;

    beforeEach(() => {
      store = new ImmuneMemoryStore();
    });

    it('should load seed entries from seed_memory.json', () => {
      expect(store.size).toBeGreaterThanOrEqual(3);
      const entries = store.getAll();
      expect(entries.some(e => e.id === 'mem_001')).toBe(true);
    });

    it('should find a match for a high-similarity incident signature', () => {
      const querySig = "TypeError: Cannot read properties of undefined (reading 'price')";
      const match = store.findMatch(querySig, 0.70);

      expect(match.matched).toBe(true);
      expect(match.confidence).toBeGreaterThanOrEqual(0.70);
      expect(match.entry).toBeDefined();
      expect(match.entry?.id).toBe('mem_001');
      expect(match.entry?.rootCauseFile).toBe('demo_service/src/services/cart.ts');
      expect(match.entry?.verifiedDiff).toBeDefined();
      expect(match.latencyMs).toBeLessThan(100);
    });

    it('should return matched: false when no entry meets threshold', () => {
      const querySig = "UnrelatedDatabaseConnectionRefusedError: port 5432 unreachable";
      const match = store.findMatch(querySig, 0.85);

      expect(match.matched).toBe(false);
      expect(match.entry).toBeUndefined();
    });

    it('should record a new verified fix idempotently', () => {
      const newEntry = {
        id: 'mem_test_999',
        signature: 'CustomTimeoutError: gateway timeout',
        serviceName: 'checkout-service',
        errorPattern: 'gateway timeout.*',
        rootCauseFile: 'demo_service/src/routes/checkout.ts',
        verifiedDiff: '+ timeout: 10000',
        confidence: 0.95,
        tags: ['timeout'],
        createdAt: new Date().toISOString(),
        hitCount: 1,
      };

      const initialSize = store.size;
      store.recordFix(newEntry);
      expect(store.size).toBe(initialSize + 1);

      // Upsert same ID
      store.recordFix({ ...newEntry, hitCount: 2 });
      expect(store.size).toBe(initialSize + 1);
    });
  });
});
