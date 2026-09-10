import { queryTerms } from '../../sourceIngest/retrieve';

/**
 * Deterministic reading of short English propositions.
 *
 * None of this understands language. It recognises a small number of surface
 * signals that reliably mean something in exam-style prose — a negator next to
 * the words a statement is about, a pair of opposite terms, a different figure,
 * a hedge the statement drops, an item in a list — and it is used only to reach
 * conclusions those signals actually support. Everything else is left for a
 * human, which is the point: the failure mode of a clever heuristic is a
 * confident verdict on a sentence it misread.
 */

/** Case, curly quotes, dashes and whitespace do not make a quote a different quote. */
export function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Content words, using the retrieval tokenizer so both sides fold plurals the same way. */
export const contentWords = (value: string): string[] => queryTerms(value).filter((term) => term.length > 2);

/** Share of `words` present in `haystack`. */
export function coverage(words: string[], haystack: string): number {
  if (words.length === 0) return 0;
  const available = new Set(queryTerms(haystack));
  return words.filter((word) => available.has(word)).length / words.length;
}

export function jaccard(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export const percent = (value: number) => `${Math.round(value * 100)}%`;

export const stripOptionLabel = (option: string) =>
  option.replace(/^\s*([A-Za-z]{1,4}|\d{1,3})\s*[.)\]:-]\s+/, '').trim();

/* ------------------------------------------------------------------------ */
/* Sentences                                                                 */
/* ------------------------------------------------------------------------ */

export interface SentenceRef {
  chunkId: string;
  text: string;
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=["“‘(]?[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function sentencesOf(chunks: Array<{ id: string; text: string }>): SentenceRef[] {
  return chunks.flatMap((chunk) =>
    splitSentences(chunk.text).map((text) => ({ chunkId: chunk.id, text })),
  );
}

/** The sentences a quote was taken from: containing it, contained in it, or mostly overlapping it. */
export function sentencesForQuote(quote: string, chunkId: string, sentences: SentenceRef[]): SentenceRef[] {
  const target = normalizeForMatch(quote);
  const inChunk = sentences.filter((sentence) => sentence.chunkId === chunkId);
  const direct = inChunk.filter((sentence) => {
    const text = normalizeForMatch(sentence.text);
    return text.includes(target) || target.includes(text);
  });
  if (direct.length > 0) return direct;
  const words = contentWords(quote);
  return inChunk.filter((sentence) => coverage(words, sentence.text) >= 0.6);
}

export function isVerbatim(phrase: string, text: string, minWords: number): boolean {
  const target = normalizeForMatch(phrase).replace(/[.!?]+$/, '');
  return target.split(' ').length >= minWords && normalizeForMatch(text).includes(target);
}

/* ------------------------------------------------------------------------ */
/* Polarity                                                                  */
/* ------------------------------------------------------------------------ */

const NEGATORS = new Set(['not', 'no', 'never', 'none', 'nor', 'neither', 'nobody', 'nothing', 'nowhere', 'cannot', 'without']);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/n't\b/g, ' not')
    .replace(/\bcan not\b/g, 'cannot')
    .replace(/-/g, ' ')
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
}

/** The same plural fold the retrieval tokenizer applies. */
const fold = (word: string) => (word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);

/**
 * Negators that bear on the words two sentences share.
 *
 * A negator only counts when one of the shared content words follows within
 * three tokens. "Skim before you read the questions, not after" does not negate
 * skimming; "Young bees do not perform the dance" does negate performing.
 */
function bearingNegations(text: string, shared: Set<string>): number {
  const tokens = words(text).map(fold);
  let count = 0;
  tokens.forEach((token, index) => {
    if (!NEGATORS.has(token)) return;
    for (let next = index + 1; next <= index + 3 && next < tokens.length; next += 1) {
      if (shared.has(tokens[next])) {
        count += 1;
        break;
      }
    }
  });
  return count;
}

export function polarityDiffers(statement: string, evidence: string): boolean {
  const evidenceWords = new Set(contentWords(evidence));
  const shared = new Set(contentWords(statement).filter((word) => evidenceWords.has(word)));
  if (shared.size === 0) return false;
  return bearingNegations(statement, shared) % 2 !== bearingNegations(evidence, shared) % 2;
}

const ANTONYM_PAIRS: Array<[string, string]> = [
  ['easy', 'hard'], ['easy', 'difficult'], ['easiest', 'hardest'], ['easier', 'harder'],
  ['increase', 'decrease'], ['increases', 'decreases'], ['increase', 'reduce'],
  ['rise', 'fall'], ['rises', 'falls'], ['more', 'less'], ['more', 'fewer'],
  ['before', 'after'], ['first', 'last'], ['quick', 'slow'], ['quickly', 'slowly'],
  ['fast', 'slow'], ['always', 'never'], ['all', 'none'], ['high', 'low'], ['higher', 'lower'],
  ['large', 'small'], ['larger', 'smaller'], ['longer', 'shorter'], ['long', 'short'],
  ['early', 'late'], ['earlier', 'later'], ['same', 'different'], ['possible', 'impossible'],
  ['correct', 'incorrect'], ['correct', 'wrong'], ['accept', 'reject'], ['include', 'exclude'],
  ['start', 'finish'], ['begin', 'end'], ['success', 'failure'], ['strong', 'weak'],
  ['stronger', 'weaker'], ['common', 'rare'], ['often', 'rarely'], ['often', 'seldom'],
  ['advantage', 'disadvantage'], ['visible', 'invisible'], ['warm', 'cool'], ['hot', 'cold'],
  ['heat', 'cool'], ['important', 'unimportant'], ['cheap', 'expensive'], ['cheaper', 'dearer'],
];

/** An opposite term in the evidence where the statement uses its pair, if any. */
export function antonymConflict(statement: string, evidence: string): string | null {
  const said = new Set(words(statement));
  const source = new Set(words(evidence));
  for (const [a, b] of ANTONYM_PAIRS) {
    if (said.has(a) && source.has(b) && !source.has(a)) return `"${a}" in the statement, "${b}" in the source`;
    if (said.has(b) && source.has(a) && !source.has(b)) return `"${b}" in the statement, "${a}" in the source`;
  }
  return null;
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100, thousand: 1000, million: 1000000, dozen: 12, half: 0.5,
};

export function numbersIn(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(/\b\d+(?:[.,]\d+)?\b/g)) found.push(Number(match[0].replace(/,/g, '')));
  for (const word of words(text)) if (word in NUMBER_WORDS) found.push(NUMBER_WORDS[word]);
  return found;
}

/** The statement names a figure the evidence does not, and the evidence names a different one. */
export function numberConflict(statement: string, evidence: string): boolean {
  const said = numbersIn(statement);
  const source = numbersIn(evidence);
  if (said.length === 0 || source.length === 0) return false;
  const sourceSet = new Set(source);
  const saidSet = new Set(said);
  return said.some((value) => !sourceSet.has(value)) && source.some((value) => !saidSet.has(value));
}

/**
 * Independent clauses: split where a sentence joins two statements — ", and",
 * ", but", a semicolon, a colon — and not at every comma, which would separate
 * a subject from its own predicate.
 */
function clausesOf(sentence: string): string[] {
  return sentence
    .split(/,\s*(?:and|but|while|whereas|so|yet)\s+|;\s*|:\s*/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

/** The clause of the evidence that says most of what the statement says. */
export function alignedClause(statement: string, evidence: string): string {
  const clauses = clausesOf(evidence);
  if (clauses.length <= 1) return evidence;
  const words = contentWords(statement);
  let best = clauses[0];
  let bestShare = -1;
  for (const clause of clauses) {
    const share = coverage(words, clause);
    if (share > bestShare) {
      best = clause;
      bestShare = share;
    }
  }
  return best;
}

/** The one explicit contradiction signal between two sentences, described, or null. */
export function contradiction(statement: string, evidence: string): string | null {
  if (polarityDiffers(statement, alignedClause(statement, evidence))) {
    return 'a negation the other side does not have';
  }
  const opposite = antonymConflict(statement, evidence);
  if (opposite) return `opposite terms: ${opposite}`;
  if (numberConflict(statement, evidence)) return 'a different figure';
  return null;
}

/** Words that limit how far a claim goes: frequency, modality, scope. */
const HEDGES = new Set([
  'rarely', 'seldom', 'sometimes', 'often', 'usually', 'mostly', 'partly', 'partially', 'only', 'alone',
  'some', 'may', 'might', 'could', 'generally', 'typically', 'largely', 'mainly', 'occasionally', 'perhaps',
  'possibly', 'probably', 'likely', 'unlikely', 'few', 'several',
]);
/** Words that only soften a figure. */
const APPROXIMATORS = new Set(['about', 'approximately', 'around', 'nearly', 'almost', 'roughly']);
const ABSOLUTES = new Set(['all', 'every', 'always', 'never', 'none', 'only', 'entirely', 'completely', 'totally', 'must', 'invariably']);

/** Hedges the source uses that the statement leaves out. */
export function droppedHedges(statement: string, evidence: string): string[] {
  const said = new Set(words(statement));
  return [...new Set(words(evidence).filter((word) => HEDGES.has(word) && !said.has(word)))];
}

/** Approximators the source puts on a figure the statement states exactly. */
export function droppedApproximators(statement: string, evidence: string): string[] {
  if (numbersIn(statement).length === 0) return [];
  const said = new Set(words(statement));
  return [...new Set(words(evidence).filter((word) => APPROXIMATORS.has(word) && !said.has(word)))];
}

/** Absolutes the statement asserts that the source does not. */
export function addedAbsolutes(statement: string, evidence: string): string[] {
  const source = new Set(words(evidence));
  return [...new Set(words(statement).filter((word) => ABSOLUTES.has(word) && !source.has(word)))];
}

/**
 * Specific details the statement names that the passage never does: a figure,
 * or a capitalised name other than the sentence's first word. The only kind of
 * absence text matching can actually demonstrate.
 */
export function novelSpecifics(statement: string, passage: string): string[] {
  const passageNumbers = new Set(numbersIn(passage));
  const found = numbersIn(statement)
    .filter((value) => !passageNumbers.has(value))
    .map((value) => String(value));
  const passageWords = new Set(words(passage));
  statement.split(/\s+/).forEach((token, index) => {
    const clean = token.replace(/[^A-Za-z'-]/g, '');
    if (index === 0 || clean.length < 2) return;
    if (/^[A-Z][a-z]/.test(clean) && !passageWords.has(clean.toLowerCase())) found.push(clean);
  });
  return [...new Set(found)];
}

/* ------------------------------------------------------------------------ */
/* Lists and prompts                                                         */
/* ------------------------------------------------------------------------ */

/**
 * The other items, when the answer is one item of a list in the sentence.
 *
 * "Numbers, dates, proper nouns and capitalised terms stand out" makes "proper
 * nouns" one of four equally correct answers to "what stands out?". Edge items
 * are trimmed to the answer's width, because a list's first item usually carries
 * the words before it and its last item the words after.
 */
export function enumerationAlternatives(answer: string, sentence: string): string[] | null {
  const target = normalizeForMatch(answer).replace(/[.!?,]+$/, '');
  const width = target.split(' ').length;

  for (const clause of sentence.split(/[.;:!?]/)) {
    if (!normalizeForMatch(clause).includes(target)) continue;
    const pieces = clause
      .split(',')
      .flatMap((piece) => piece.split(/\s+(?:and|or)\s+/i))
      .map((piece) => normalizeForMatch(piece))
      .filter(Boolean);
    if (pieces.length < 3) continue;

    const trimmed = pieces.map((piece, index) => {
      const parts = piece.split(' ');
      if (index === 0) return parts.slice(-width).join(' ');
      if (index === pieces.length - 1) return parts.slice(0, width).join(' ');
      return piece;
    });
    const items = trimmed.filter((item) => item.split(' ').length <= Math.max(width, 3));
    if (!items.includes(target)) continue;
    const others = items.filter((item) => item !== target);
    if (others.length >= 2) return others;
  }
  return null;
}

const QUESTION_WORDS = new Set([
  'according', 'passage', 'text', 'writer', 'author', 'book', 'following', 'statement', 'best',
  'describe', 'described', 'describes', 'question', 'answer', 'which', 'what', 'why', 'how', 'does',
  'did', 'say', 'says', 'suggest', 'mention', 'mentioned', 'word', 'words', 'kind', 'kinds', 'type',
]);

export const GAP = /_{3,}|…|\.{3}/;
const GAP_GLOBAL = /_{3,}|…|\.{3}/g;

/** What a question is actually about: its content words, without question scaffolding. */
export function promptWords(prompt: string): string[] {
  return contentWords(prompt.replace(GAP_GLOBAL, ' ')).filter((word) => !QUESTION_WORDS.has(word));
}

export function fillGap(prompt: string, answer: string): string {
  return prompt.replace(GAP_GLOBAL, answer);
}

export const INFERENCE_CUE =
  /\b(suggests?|impl(?:y|ies|ied)|infer(?:red)?|main (?:idea|purpose|point)|writer'?s? (?:view|opinion|attitude|purpose)|most likely|why)\b/i;
