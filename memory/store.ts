// Vector database adapter providing similarity search and persistence for past incident signatures and approved code diffs

import * as fs from 'fs';
import * as path from 'path';
import type { ImmuneMemoryEntry, MemoryMatchResult } from '../shared/types';

// ---------------------------------------------------------------------------
// Helpers — deterministic, no external dependencies
// ---------------------------------------------------------------------------

/**
 * Normalise a raw signature string into a comparable token set.
 * Lower-cases, strips punctuation noise, splits on word boundaries.
 */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

/**
 * Jaccard similarity between two token arrays.
 * Returns a value in [0, 1].
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/**
 * Cosine similarity between two numeric vectors.
 * Returns a value in [0, 1].  Falls back to 0 when either vector is empty
 * or the vectors have different lengths.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Composite similarity: blend Jaccard token overlap with cosine vector
 * similarity when both entries carry embeddings.
 *
 * Weights:
 *   - Jaccard (token overlap)  : 0.60
 *   - Cosine  (vector)         : 0.40  (only when embeddings are present)
 */
function similarity(
  querySignature: string,
  queryEmbeddings: number[] | undefined,
  entry: ImmuneMemoryEntry,
): number {
  const jScore = jaccardSimilarity(
    tokenise(querySignature),
    tokenise(entry.signature),
  );

  if (
    queryEmbeddings &&
    queryEmbeddings.length > 0 &&
    entry.embeddings &&
    entry.embeddings.length === queryEmbeddings.length
  ) {
    const cScore = cosineSimilarity(queryEmbeddings, entry.embeddings);
    return 0.6 * jScore + 0.4 * cScore;
  }

  return jScore;
}

// ---------------------------------------------------------------------------
// ImmuneMemoryStore
// ---------------------------------------------------------------------------

const SEED_PATH = path.resolve(__dirname, 'seed_memory.json');

export class ImmuneMemoryStore {
  private entries: ImmuneMemoryEntry[];

  constructor(seedPath: string = SEED_PATH) {
    try {
      const raw = fs.readFileSync(seedPath, 'utf-8');
      this.entries = JSON.parse(raw) as ImmuneMemoryEntry[];
    } catch {
      // Gracefully start with an empty store when the file is missing or invalid.
      this.entries = [];
    }
  }

  // -------------------------------------------------------------------------
  // findMatch
  // -------------------------------------------------------------------------

  /**
   * Search the memory store for the best-matching entry above `threshold`.
   *
   * @param signature   - Normalised error signature from the incident.
   * @param threshold   - Minimum similarity score to count as a match (default 0.85).
   * @param embeddings  - Optional pre-computed query vector for enhanced accuracy.
   * @returns           A MemoryMatchResult describing the outcome.
   */
  findMatch(
    signature: string,
    threshold = 0.85,
    embeddings?: number[],
  ): MemoryMatchResult {
    const start = Date.now();

    if (this.entries.length === 0) {
      return { matched: false, confidence: 0, latencyMs: Date.now() - start };
    }

    let bestScore = 0;
    let bestEntry: ImmuneMemoryEntry | undefined;

    for (const entry of this.entries) {
      const score = similarity(signature, embeddings, entry);
      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }

    const latencyMs = Date.now() - start;

    if (bestScore >= threshold && bestEntry !== undefined) {
      return {
        matched: true,
        confidence: bestScore,
        entry: bestEntry,
        latencyMs,
      };
    }

    return { matched: false, confidence: bestScore, latencyMs };
  }

  // -------------------------------------------------------------------------
  // recordFix
  // -------------------------------------------------------------------------

  /**
   * Persist a new verified fix into the in-memory store.
   *
   * If an entry with the same `id` already exists it is replaced (idempotent
   * upsert).  The store is intentionally not flushed to disk — callers that
   * need persistence can serialise `this.entries` themselves.
   *
   * @param entry - A fully populated ImmuneMemoryEntry to record.
   */
  recordFix(entry: ImmuneMemoryEntry): void {
    const idx = this.entries.findIndex(e => e.id === entry.id);
    if (idx !== -1) {
      this.entries[idx] = entry;
    } else {
      this.entries.push(entry);
    }
  }

  // -------------------------------------------------------------------------
  // Accessors (useful for testing & orchestrator inspection)
  // -------------------------------------------------------------------------

  /** Returns a shallow copy of all stored entries. */
  getAll(): ImmuneMemoryEntry[] {
    return [...this.entries];
  }

  /** Current number of entries. */
  get size(): number {
    return this.entries.length;
  }
}
