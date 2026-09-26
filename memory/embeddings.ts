import type { ImmuneMemoryEntry } from '../shared/types';

export const EMBEDDING_DIM = 8;

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

/**
 * Deterministic hash-based 8-dimensional embedding.
 */
export function embed(text: string): number[] {
  const tokens = tokenise(text);
  const vec = new Array(EMBEDDING_DIM).fill(0);
  
  if (tokens.length === 0) {
    return vec;
  }

  for (const t of tokens) {
    let hash = 0;
    for (let i = 0; i < t.length; i++) {
      hash = (hash << 5) - hash + t.charCodeAt(i);
      hash |= 0;
    }
    const bucket = Math.abs(hash) % EMBEDDING_DIM;
    vec[bucket]++;
  }

  const maxCount = Math.max(...vec, 1);
  return vec.map(c => Number((c / maxCount).toFixed(4)));
}

export function embedEntry(entry: ImmuneMemoryEntry): number[] {
  const text = [entry.signature, entry.errorPattern].join(' ');
  const vec = embed(text);
  entry.embeddings = vec;
  return vec;
}

export const generateEmbedding = embed;
export const generateIncidentEmbedding = (signature: string, stackTrace?: string): number[] => {
  const combined = stackTrace ? `${signature} ${stackTrace}` : signature;
  return embed(combined);
};
