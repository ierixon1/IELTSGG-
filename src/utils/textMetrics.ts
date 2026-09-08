/**
 * Deterministic lexical measurements of a candidate's own words.
 *
 * These are computed from the text, never asked of the model: the same answer
 * always yields the same numbers, they cost nothing, and they still work when
 * the grading model is unavailable. They are *indicators*, not band scores —
 * the four IELTS criteria remain the examiner's job, and the UI labels them
 * accordingly.
 */

/**
 * The high-frequency core of English. A word outside this list is not
 * automatically "advanced", but the share of words outside it tracks lexical
 * reach well enough to be worth showing next to a band.
 */
const COMMON_WORDS = new Set([
  'a','about','above','after','again','against','all','also','although','always','am','an','and','another','any','anyone','anything','are','around','as','at','away',
  'back','be','because','been','before','being','below','best','better','between','big','both','but','by',
  'call','called','came','can','cannot','come','comes','could','country','course',
  'day','days','did','different','do','does','doing','done','down','during',
  'each','early','end','enough','even','ever','every','example','everyone','everything',
  'far','few','find','first','for','found','from','fact','feel',
  'get','give','go','going','good','got','great','group',
  'had','half','hand','has','have','having','he','help','her','here','high','him','his','home','house','how','however','human',
  'i','if','important','in','into','is','it','its','issue',
  'just',
  'keep','kind','know','known',
  'large','last','later','least','less','let','life','like','little','long','look','lot',
  'made','main','make','making','man','many','may','me','mean','might','more','most','much','must','my',
  'need','never','new','next','no','not','nothing','now','number',
  'of','off','often','old','on','once','one','only','or','other','others','our','out','over','own',
  'part','people','perhaps','person','place','point','possible','problem','put',
  'quite',
  'rather','real','really','right',
  'said','same','saw','say','school','second','see','seen','seem','set','several','she','should','since','small','so','social','some','someone','something','still','such','sure',
  'take','taken','than','that','the','their','them','then','there','therefore','these','they','thing','things','think','this','those','though','thought','three','through','time','times','to','today','together','too','took','two','type',
  'under','until','up','upon','us','use','used','using','usually',
  'very',
  'want','was','way','we','well','went','were','what','when','where','whether','which','while','who','whole','why','will','with','within','without','word','work','world','would',
  'year','years','yes','yet','you','young','your',
]);

/** Function words are excluded from the repetition report — "the" repeating is not a finding. */
const FUNCTION_WORDS = new Set([
  'a','an','and','are','as','at','be','been','being','but','by','for','from','had','has','have','he','her','his','i','if','in','is','it','its','of','on','or','she','so','than','that','the','their','them','then','there','these','they','this','to','was','we','were','what','which','who','will','with','you','your','not','no','do','does','did','can','could','would','should','may','might','must','am',
]);

export interface RepeatedWord {
  word: string;
  count: number;
}

export interface LexisMetrics {
  /** Total running words. */
  totalWords: number;
  /** Distinct word forms. */
  uniqueWords: number;
  /**
   * Share of running words that fall outside the high-frequency core and are
   * morphologically substantial. 0–1.
   */
  complexity: number;
  /**
   * How much the answer leans on repeating the same content words. 0–1, where
   * higher means more repetition.
   */
  repetition: number;
  /** The content words leaned on hardest, most-used first. */
  topRepeated: RepeatedWord[];
  /** Mean syllables per word — a plain readability signal. */
  syllablesPerWord: number;
}

/** Rough English syllable count: vowel groups, minus a silent final "e". */
export function countSyllables(word: string): number {
  const clean = word.toLowerCase().replace(/[^a-z]/g, '');
  if (clean.length === 0) return 0;
  if (clean.length <= 3) return 1;

  const trimmed = clean
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '');

  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Splits prose into lowercase word forms, keeping internal apostrophes. */
export function tokenise(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z'’-]*/g) || []).map((word) =>
    word.replace(/['’-]+$/, ''),
  );
}

export function analyseLexis(text: string): LexisMetrics {
  const words = tokenise(text).filter(Boolean);
  const totalWords = words.length;

  if (totalWords === 0) {
    return {
      totalWords: 0,
      uniqueWords: 0,
      complexity: 0,
      repetition: 0,
      topRepeated: [],
      syllablesPerWord: 0,
    };
  }

  const counts = new Map<string, number>();
  let advanced = 0;
  let syllableTotal = 0;

  for (const word of words) {
    counts.set(word, (counts.get(word) || 0) + 1);

    const syllables = countSyllables(word);
    syllableTotal += syllables;

    // "Advanced" means outside the common core *and* carrying some weight —
    // a rare three-letter word is a typo more often than a lexical choice.
    if (!COMMON_WORDS.has(word) && (syllables >= 3 || word.length >= 7)) advanced += 1;
  }

  const contentCounts = [...counts.entries()]
    .filter(([word, count]) => count > 1 && !FUNCTION_WORDS.has(word) && word.length > 2)
    .sort((a, b) => b[1] - a[1]);

  /**
   * Repetition is the share of running words spent on repeats of content
   * words: every occurrence after the first counts against variety.
   */
  const repeatedOccurrences = contentCounts.reduce((sum, [, count]) => sum + (count - 1), 0);

  return {
    totalWords,
    uniqueWords: counts.size,
    complexity: advanced / totalWords,
    repetition: Math.min(1, repeatedOccurrences / totalWords),
    topRepeated: contentCounts.slice(0, 5).map(([word, count]) => ({ word, count })),
    syllablesPerWord: syllableTotal / totalWords,
  };
}

export type MetricLevel = 'low' | 'mid' | 'high';

/**
 * Bands a ratio into three buckets for display. `goodHigh` flips the reading
 * for metrics where more is better (complexity) versus worse (repetition).
 */
export function levelOf(value: number, lowCut: number, highCut: number, goodHigh: boolean): MetricLevel {
  if (value < lowCut) return goodHigh ? 'low' : 'high';
  if (value > highCut) return goodHigh ? 'high' : 'low';
  return 'mid';
}
