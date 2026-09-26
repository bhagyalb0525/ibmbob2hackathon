// Embedding generator computing vector representations of incident error logs and stack traces
// Deterministic, no external dependencies — uses term-frequency over a fixed vocabulary.

import type { ImmuneMemoryEntry } from '../shared/types';

// ---------------------------------------------------------------------------
// Fixed vocabulary (index = dimension in the output vector)
// Keep this list stable across runs so embeddings are reproducible.
// ---------------------------------------------------------------------------

const VOCAB: string[] = [
  // Error types
  'typeerror', 'rangeerror', 'syntaxerror', 'referenceerror', 'error',
  // Common patterns
  'undefined', 'null', 'cannot', 'read', 'properties', 'property',
  'maximum', 'call', 'stack', 'size', 'exceeded',
  'unexpected', 'token', 'json', 'position',
  // Services
  'checkout', 'payment', 'cart', 'service',
  // Code concepts
  'price', 'quantity', 'amount', 'currency',
  'recursion', 'retry', 'parse', 'body',
  // Outcomes
  'failed', 'success', 'rejected', 'invalid', 'resolved',
];

export const EMBEDDING_DIM = VOCAB.length; // 37

// ---------------------------------------------------------------------------
// tokenise — mirrors the one in store.ts so vectors align with text search
// ---------------------------------------------------------------------------

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

// ---------------------------------------------------------------------------
// embed
// ---------------------------------------------------------------------------

/**
 * Convert a free-form text (error message, stack trace, signature …) into a
 * deterministic unit-length vector over the fixed vocabulary.
 *
 * Algorithm: normalised term-frequency (TF) over the static VOCAB list.
 * Each dimension is tf(term) / max_tf so the vector is in [0, 1]^VOCAB.length.
 *
 * @param text - Any text to embed.
 * @returns    A Float vector with length === EMBEDDING_DIM.
 */
export function embed(text: string): number[] {
  const tokens = tokenise(text);
  const tf = new Map<string, number>();

  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }

  const counts = VOCAB.map(term => tf.get(term) ?? 0);
  const maxCount = Math.max(...counts, 1); // avoid div-by-zero

  return counts.map(c => Number((c / maxCount).toFixed(4)));
}

// ---------------------------------------------------------------------------
// embedEntry
// ---------------------------------------------------------------------------

/**
 * Derive an embedding for an ImmuneMemoryEntry by concatenating its
 * signature + errorPattern fields.
 *
 * The resulting vector is stored in `entry.embeddings` in-place and returned.
 */
export function embedEntry(entry: ImmuneMemoryEntry): number[] {
  const text = [entry.signature, entry.errorPattern].join(' ');
  const vec = embed(text);
  entry.embeddings = vec;
  return vec;
}

// Aliases for compatibility across agent pipeline and tests
export const generateEmbedding = embed;
export const generateIncidentEmbedding = (signature: string, stackTrace?: string): number[] => {
  const combined = stackTrace ? `${signature} ${stackTrace}` : signature;
  return embed(combined);
};

