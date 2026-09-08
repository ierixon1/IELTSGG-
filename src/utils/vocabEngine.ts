import { SkillType, VocabCard, WritingGradingResult } from '../types';
import { analyseLexis } from './textMetrics';

/**
 * The learner's vocabulary deck, built from their own work.
 *
 * Two things earn a card: a phrase the examiner flagged as a lexical problem,
 * and a content word the answer leaned on so hard it reads as a limited range.
 * Nothing is generated from a stock word list — a card the learner does not
 * recognise from their own writing is a card they will not review.
 */

/** Leitner intervals in days, indexed by box. Box 1 comes back the same day. */
const BOX_INTERVALS_DAYS = [0, 0, 1, 3, 7, 21];

export const MAX_BOX = 5;

/** A word repeated at least this many times is a range problem worth drilling. */
const OVERUSE_THRESHOLD = 4;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Stable id per term and skill, so the same word never lands twice. */
function cardId(term: string, skill: SkillType): string {
  return `vocab_${skill}_${term.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`;
}

function newCard(input: Omit<VocabCard, 'box' | 'dueDate' | 'reviews' | 'lapses' | 'createdAt'>): VocabCard {
  return {
    ...input,
    box: 1,
    dueDate: today(),
    reviews: 0,
    lapses: 0,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Harvests cards from a graded Writing result plus the essay it graded.
 * Returns only cards that are not already in the deck.
 */
export function harvestFromWriting(
  result: WritingGradingResult,
  essay: string,
  existing: VocabCard[],
): VocabCard[] {
  const known = new Set(existing.map((card) => card.id));
  const harvested: VocabCard[] = [];

  for (const annotation of result.annotated_text || []) {
    if (annotation.issue_type !== 'lexical') continue;

    const term = annotation.span.trim();
    if (!term) continue;

    const id = cardId(term, 'writing');
    if (known.has(id)) continue;
    known.add(id);

    harvested.push(
      newCard({
        id,
        term,
        source: 'annotation',
        context: annotation.span,
        suggestion: annotation.suggestion,
        note: annotation.comment,
        skill: 'writing',
      }),
    );
  }

  for (const repeated of analyseLexis(essay).topRepeated) {
    if (repeated.count < OVERUSE_THRESHOLD) continue;

    const id = cardId(repeated.word, 'writing');
    if (known.has(id)) continue;
    known.add(id);

    harvested.push(
      newCard({
        id,
        term: repeated.word,
        source: 'repetition',
        note: String(repeated.count),
        skill: 'writing',
      }),
    );
  }

  return harvested;
}

/** Harvests overused words from a Speaking transcript. */
export function harvestFromSpeaking(transcript: string, existing: VocabCard[]): VocabCard[] {
  const known = new Set(existing.map((card) => card.id));
  const harvested: VocabCard[] = [];

  for (const repeated of analyseLexis(transcript).topRepeated) {
    if (repeated.count < OVERUSE_THRESHOLD) continue;

    const id = cardId(repeated.word, 'speaking');
    if (known.has(id)) continue;
    known.add(id);

    harvested.push(
      newCard({
        id,
        term: repeated.word,
        source: 'repetition',
        note: String(repeated.count),
        skill: 'speaking',
      }),
    );
  }

  return harvested;
}

/** Cards due today or overdue, oldest due first. */
export function dueCards(cards: VocabCard[]): VocabCard[] {
  const now = today();
  return cards
    .filter((card) => card.dueDate <= now)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

/**
 * Moves a card after a review. Remembering promotes it one box; forgetting
 * sends it back to the start, because a word you cannot produce under pressure
 * is not learned regardless of how many times you have seen it.
 */
export function reviewCard(card: VocabCard, remembered: boolean): VocabCard {
  if (remembered) {
    const box = Math.min(MAX_BOX, card.box + 1);
    return {
      ...card,
      box,
      reviews: card.reviews + 1,
      dueDate: addDays(BOX_INTERVALS_DAYS[box]),
    };
  }

  return {
    ...card,
    box: 1,
    reviews: card.reviews + 1,
    lapses: card.lapses + 1,
    dueDate: today(),
  };
}

export interface DeckStats {
  total: number;
  due: number;
  learned: number;
}

export function deckStats(cards: VocabCard[]): DeckStats {
  return {
    total: cards.length,
    due: dueCards(cards).length,
    learned: cards.filter((card) => card.box >= MAX_BOX).length,
  };
}
