import type { SourceChunk } from '../../types/source';

/**
 * Finding the passages a query is actually about, and saying so when there are
 * none.
 *
 * This is deliberately lexical — BM25 over the chunks a book already produced,
 * with no embeddings and no vector database. Two reasons. A vector store is a
 * dependency and an index that has to be kept in step with the source of truth,
 * and nothing downstream exists yet to justify that. And the property that
 * matters most at this stage is that the same query returns the same passages
 * every time, which an approximate-nearest-neighbour index does not promise.
 *
 * The scoring is replaceable: `retrieve` returns ranked chunks and nothing
 * else, so a semantic scorer can be substituted, or added alongside, without
 * anything above it changing.
 *
 * The rule this module exists to enforce: it can only ever return chunks that
 * were stored. It never synthesises, summarises, paraphrases or merges text,
 * and a query with no lexical footing in the book comes back as an explicit
 * no-match rather than as the least-bad chunks in the corpus. "Here are three
 * passages" is a claim, and it has to be true.
 */

export interface RetrievalHit {
  chunk: SourceChunk;
  /** BM25 score. Comparable within one result set, not across corpora. */
  score: number;
  /** 0–1, this hit's score against the best possible in this result set. */
  confidence: number;
  /** Query terms this chunk actually contains. Never inferred. */
  matchedTerms: string[];
}

export type RetrievalOutcome =
  | { status: 'ok'; hits: RetrievalHit[]; query: string; terms: string[] }
  /** The query had no usable terms — empty, or nothing but stop words. */
  | { status: 'empty_query'; reason: string; query: string; terms: string[] }
  /** Real terms, but nothing in this source contains any of them. */
  | { status: 'no_match'; reason: string; query: string; terms: string[] }
  /** Something matched, but too weakly to present as an answer. */
  | { status: 'low_confidence'; reason: string; query: string; terms: string[]; best: number };

export interface RetrievalOptions {
  limit?: number;
  /**
   * Minimum share of the query's terms a chunk must literally contain.
   * A chunk matching one term out of six is a coincidence, not a result.
   */
  minTermCoverage?: number;
  /** Minimum BM25 score for the best hit before the result set is worth showing. */
  minScore?: number;
}

const DEFAULTS = { limit: 10, minTermCoverage: 0.34, minScore: 0.35 };

/**
 * Words carrying no retrieval signal.
 *
 * Kept short on purpose. An aggressive stop list starts removing terms that
 * matter in a language-teaching book — "will", "can", "should" are the subject
 * of whole chapters — and a query made only of stop words must be reported as
 * an empty query rather than quietly matching everything.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with',
  'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'you', 'he', 'she', 'we', 'they', 'do', 'does', 'did', 'not', 'no', 'so', 'than',
  'then', 'there', 'here', 'what', 'which', 'who', 'how', 'when', 'where', 'why',
]);

/**
 * Splits text into comparable terms.
 *
 * Lower-cased, punctuation dropped, and a very small suffix fold so that
 * "chapters" finds "chapter". Deliberately not a real stemmer: an aggressive
 * one collapses "reading" to "read", which in an IELTS book are different
 * topics.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^['-]+|['-]+$/g, ''))
    .filter((word) => word.length > 1)
    .map((word) => (word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));
}

/** Query terms: tokenized, stop words removed, duplicates collapsed in order. */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of tokenize(query)) {
    if (STOP_WORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }
  return terms;
}

const K1 = 1.2;
const B = 0.75;

interface Indexed {
  chunk: SourceChunk;
  counts: Map<string, number>;
  length: number;
}

/**
 * A searchable view of one source's chunks.
 *
 * Built on demand rather than persisted: a book of a few thousand chunks
 * indexes in milliseconds, and an index stored separately from the chunks is an
 * index that can disagree with them.
 */
export class ChunkIndex {
  private readonly documents: Indexed[];
  private readonly documentFrequency = new Map<string, number>();
  private readonly averageLength: number;

  constructor(chunks: SourceChunk[]) {
    this.documents = chunks.map((chunk) => {
      const tokens = tokenize(`${chunk.heading ?? ''} ${chunk.text}`);
      const counts = new Map<string, number>();
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      for (const term of counts.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
      return { chunk, counts, length: tokens.length };
    });

    const total = this.documents.reduce((sum, entry) => sum + entry.length, 0);
    this.averageLength = this.documents.length > 0 ? total / this.documents.length : 0;
  }

  get size(): number {
    return this.documents.length;
  }

  private idf(term: string): number {
    const n = this.documents.length;
    const df = this.documentFrequency.get(term) ?? 0;
    if (df === 0) return 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  score(terms: string[], entry: Indexed): { score: number; matched: string[] } {
    let score = 0;
    const matched: string[] = [];

    for (const term of terms) {
      const frequency = entry.counts.get(term);
      if (!frequency) continue;
      matched.push(term);
      const denominator =
        frequency + K1 * (1 - B + (B * entry.length) / (this.averageLength || 1));
      score += this.idf(term) * ((frequency * (K1 + 1)) / denominator);
    }

    // The heading is indexed alongside the body rather than weighted, so a
    // section titled "Skimming" outranks one that mentions skimming once purely
    // because the term is rarer in it, not because of a thumb on the scale.
    return { score, matched };
  }

  entries(): Indexed[] {
    return this.documents;
  }
}

/**
 * Ranks a source's chunks against a query.
 *
 * Ordering is total and deterministic: score first, then ordinal, so two
 * equally-scoring chunks always come back in reading order rather than in
 * whatever order the sort happened to leave them.
 */
export function retrieve(
  chunks: SourceChunk[],
  query: string,
  options: RetrievalOptions = {},
): RetrievalOutcome {
  const { limit, minTermCoverage, minScore } = { ...DEFAULTS, ...options };
  const terms = queryTerms(query);

  if (terms.length === 0) {
    return {
      status: 'empty_query',
      query,
      terms,
      reason: query.trim()
        ? 'The query contains no searchable words.'
        : 'No query was given.',
    };
  }

  if (chunks.length === 0) {
    return {
      status: 'no_match',
      query,
      terms,
      reason: 'This source has no indexed passages.',
    };
  }

  const index = new ChunkIndex(chunks);
  const required = Math.max(1, Math.ceil(terms.length * minTermCoverage));

  const scored: RetrievalHit[] = [];
  for (const entry of index.entries()) {
    const { score, matched } = index.score(terms, entry);
    if (matched.length < required || score <= 0) continue;
    scored.push({ chunk: entry.chunk, score, confidence: 0, matchedTerms: matched });
  }

  if (scored.length === 0) {
    return {
      status: 'no_match',
      query,
      terms,
      reason: `Nothing in this source contains ${
        required === 1 ? 'any of' : `at least ${required} of`
      } these words: ${terms.join(', ')}.`,
    };
  }

  scored.sort((a, b) => b.score - a.score || a.chunk.ordinal - b.chunk.ordinal);
  const best = scored[0].score;

  if (best < minScore) {
    return {
      status: 'low_confidence',
      query,
      terms,
      best,
      reason:
        'The closest passages only match these words in passing, so nothing is returned rather than something unrelated.',
    };
  }

  const hits = scored.slice(0, limit).map((hit) => ({
    ...hit,
    confidence: Number((hit.score / best).toFixed(4)),
  }));

  return { status: 'ok', hits, query, terms };
}
