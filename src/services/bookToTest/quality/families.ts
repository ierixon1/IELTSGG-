import type { SourceChunk } from '../../../types/source';
import { answerMatchesOption, optionLabel } from '../../../utils/answerMatching';
import type { PassageSection } from '../passage';
import type { GeneratableType } from '../types';
import type { VerdictBuilder } from './reasons';
import {
  GAP,
  INFERENCE_CUE,
  addedAbsolutes,
  contentWords,
  contradiction,
  coverage,
  droppedApproximators,
  droppedHedges,
  enumerationAlternatives,
  fillGap,
  isVerbatim,
  jaccard,
  normalizeForMatch,
  novelSpecifics,
  percent,
  promptWords,
  sentencesForQuote,
  stripOptionLabel,
  type SentenceRef,
} from './text';

/**
 * Per-family checks, each split into the two dimensions it judges.
 *
 * The rule for every check below: it may lower a verdict, it may explain why,
 * and it may never produce a different answer. When a check cannot tell, the
 * question goes to a human — `valid` is reachable only through checks that
 * positively established what they claim.
 */

export interface EvidenceItem {
  chunkId: string;
  quote: string;
}

export interface FamilyInput {
  type: GeneratableType;
  prompt: string;
  options?: string[];
  correctAnswer: string;
  acceptableAnswers?: string[];
  wordLimit?: string;
  questionEvidence: EvidenceItem[];
  answerEvidence: EvidenceItem[];
}

export interface FamilyContext {
  chunks: SourceChunk[];
  sections: PassageSection[];
  sentences: SentenceRef[];
  passageText: string;
}

/** What the heading-set checks need to know about one matching-headings question. */
export interface HeadingInfo {
  label: string;
  chunkId: string;
  keyedIndex: number;
  options: string[];
}

function evidenceSentences(items: EvidenceItem[], context: FamilyContext): SentenceRef[] {
  const found: SentenceRef[] = [];
  for (const item of items) {
    for (const sentence of sentencesForQuote(item.quote, item.chunkId, context.sentences)) {
      if (!found.includes(sentence)) found.push(sentence);
    }
  }
  return found;
}

const labelOf = (option: string, index: number) => optionLabel(option) || String.fromCharCode(65 + index);

/* ------------------------------------------------------------------------ */
/* Multiple choice                                                           */
/* ------------------------------------------------------------------------ */

/**
 * The sentences a multiple-choice question can be answered from: every sentence
 * of the sections its evidence comes from, plus any sentence elsewhere that is
 * clearly about what the question asks.
 */
function questionSentences(input: FamilyInput, context: FamilyContext, narrow: boolean): SentenceRef[] {
  const chunkIds = new Set([...input.questionEvidence, ...input.answerEvidence].map((item) => item.chunkId));
  const asked = promptWords(input.prompt);
  return context.sentences.filter((sentence) => {
    const aligned = asked.length > 0 && coverage(asked, sentence.text) >= 0.4;
    // A one-word option can be "found" in almost any sentence of a section, so
    // it is only looked for where the question itself is.
    return narrow ? aligned : aligned || chunkIds.has(sentence.chunkId);
  });
}

/** How directly any sentence states an option, discounting sentences that negate or oppose it. */
function directSupport(option: string, sentences: SentenceRef[]): number {
  const optionWords = contentWords(option);
  if (optionWords.length === 0) return 0;
  let best = 0;
  for (const sentence of sentences) {
    const share = coverage(optionWords, sentence.text);
    if (share > best && !contradiction(option, sentence.text)) best = share;
  }
  return best;
}

function checkMultipleChoice(input: FamilyInput, context: FamilyContext, grounding: VerdictBuilder, quality: VerdictBuilder) {
  const options = input.options ?? [];
  const texts = options.map(stripOptionLabel);
  const words = texts.map(contentWords);
  const keyed = options.findIndex((option) => answerMatchesOption(input.correctAnswer, option));
  if (keyed < 0) return;

  for (let a = 0; a < options.length; a += 1) {
    for (let b = a + 1; b < options.length; b += 1) {
      if (words[a].length > 0 && words[b].length > 0 && jaccard(words[a], words[b]) >= 0.8) {
        quality.review(
          'near_duplicate_options',
          `Options ${labelOf(options[a], a)} and ${labelOf(options[b], b)} say nearly the same thing.`,
        );
      }
    }
  }

  // Grounding: the keyed option is what the answer evidence says.
  const answerText = input.answerEvidence.map((item) => item.quote).join(' ');
  if (words[keyed].length === 0) {
    grounding.review('answer_not_extractable', 'The keyed option has no content words that could be checked against the source.');
  } else {
    const share = coverage(words[keyed], answerText);
    if (share < 0.6) {
      grounding.review('evidence_weak', `Only ${percent(share)} of the keyed option's words appear in the answer evidence.`);
    } else {
      const opposed = evidenceSentences(input.answerEvidence, context)
        .map((sentence) => contradiction(texts[keyed], sentence.text))
        .find(Boolean);
      if (opposed) {
        grounding.review('answer_conflicts_with_evidence', `The answer evidence contradicts the keyed option (${opposed}).`);
      }
    }
  }

  // Quality: exactly one option is stated by the source.
  const support = texts.map((text, index) =>
    directSupport(text, questionSentences(input, context, words[index].length < 2)),
  );
  const stated = support.map((value, index) => ({ value, index })).filter((item) => item.value >= 0.75);
  if (stated.length >= 2 && stated.some((item) => item.index === keyed)) {
    quality.review(
      'multiple_correct_options',
      `The source states options ${stated.map((item) => labelOf(options[item.index], item.index)).join(' and ')} equally directly, so more than one answer is defensible.`,
    );
  } else {
    for (const item of stated) {
      if (item.index === keyed) continue;
      quality.review(
        'distractor_also_supported',
        `Distractor ${labelOf(options[item.index], item.index)} ("${texts[item.index]}") is stated directly in the source.`,
      );
    }
  }

  if (words[keyed].length >= 2 && coverage(words[keyed], input.prompt) >= 0.6) {
    quality.review('option_leaked_in_prompt', 'The question repeats the wording of its own correct option.');
  }
  if (INFERENCE_CUE.test(input.prompt) && isVerbatim(texts[keyed], context.passageText, 4)) {
    quality.review(
      'answer_copied_verbatim',
      'The question asks for an inference, but the correct option is copied word for word from the source.',
    );
  }

  const asked = promptWords(input.prompt);
  if (asked.length > 0 && coverage(asked, context.passageText) < 0.5) {
    quality.review(
      'question_not_answerable',
      `Most of what the question asks about (${asked.join(', ')}) is not in the retrieved material.`,
    );
  }
}

/* ------------------------------------------------------------------------ */
/* True / False / Not Given                                                  */
/* ------------------------------------------------------------------------ */

function checkTrueFalseNotGiven(input: FamilyInput, context: FamilyContext, grounding: VerdictBuilder, quality: VerdictBuilder) {
  const statement = input.prompt;
  const key = input.correctAnswer;
  const statementWords = contentWords(statement);
  const judge = (sentence: SentenceRef) => ({
    sentence,
    share: coverage(statementWords, sentence.text),
    against: contradiction(statement, sentence.text),
  });

  const passage = context.sentences.map(judge);
  const statedElsewhere = passage.filter((item) => item.share >= 0.8 && !item.against);
  const contradictedElsewhere = passage.filter((item) => item.share >= 0.5 && item.against);
  const cited = evidenceSentences(input.answerEvidence, context).map(judge).sort((a, b) => b.share - a.share);

  if (key === 'TRUE') {
    const best = cited[0];
    if (!best) {
      grounding.review('evidence_weak', 'The answer evidence could not be matched to a sentence of the source.');
    } else if (best.against) {
      grounding.review(
        'answer_conflicts_with_evidence',
        `The answer evidence contradicts the statement (${best.against}), which fits FALSE rather than TRUE.`,
      );
    } else if (best.share < 0.8) {
      grounding.review('evidence_weak', `The answer evidence covers only ${percent(best.share)} of the statement.`);
    }

    if (best && !best.against) {
      const dropped = [
        ...droppedHedges(statement, best.sentence.text),
        ...droppedApproximators(statement, best.sentence.text),
      ];
      if (dropped.length > 0) {
        quality.review('ambiguous_question', `The source qualifies this with "${dropped.join('", "')}", which the statement leaves out.`);
      }
      const added = addedAbsolutes(statement, best.sentence.text);
      if (added.length > 0) {
        quality.review('ambiguous_question', `The statement adds "${added.join('", "')}", which the source does not say.`);
      }
    }
    if (contradictedElsewhere.length > 0) {
      quality.review('ambiguous_question', 'Another sentence in the passage appears to contradict the statement.');
    }
    if (isVerbatim(statement, context.passageText, 6)) {
      quality.review('answer_copied_verbatim', 'The statement repeats the source word for word; IELTS statements paraphrase the text.');
    }
    return;
  }

  if (key === 'FALSE') {
    // No overlap threshold as the pass criterion: FALSE is established by an
    // explicit contradiction in the cited sentence, not by shared words. The
    // modest alignment only makes sure the contradiction is about this statement.
    const opposing = cited.find((item) => item.against && item.share >= 0.4);
    if (!opposing) {
      grounding.review(
        'false_not_provable',
        'No explicit contradiction was found in the answer evidence: no negation, opposite term or different figure bearing on the statement.',
      );
    } else {
      const dropped = droppedHedges(statement, opposing.sentence.text);
      if (dropped.length > 0) {
        quality.review('ambiguous_question', `The source hedges with "${dropped.join('", "')}"; the contradiction may not be absolute.`);
      }
    }
    if (statedElsewhere.length > 0) {
      grounding.review('answer_conflicts_with_evidence', `A sentence in the passage appears to state this as true: "${statedElsewhere[0].sentence.text.slice(0, 120)}".`);
    }
    return;
  }

  // NOT GIVEN: the source neither establishes nor contradicts the statement.
  if (input.answerEvidence.length > 0) {
    quality.review('ambiguous_question', 'A NOT GIVEN answer cites answer evidence, which suggests the source does address the statement.');
  }
  if (statedElsewhere.length > 0) {
    grounding.review('answer_conflicts_with_evidence', `The passage appears to state this: "${statedElsewhere[0].sentence.text.slice(0, 120)}".`);
    return;
  }
  if (contradictedElsewhere.length > 0) {
    grounding.review(
      'answer_conflicts_with_evidence',
      `The passage appears to contradict this (${contradictedElsewhere[0].against}), which fits FALSE.`,
    );
    return;
  }

  const novel = novelSpecifics(statement, context.passageText);
  const novelWords = new Set(novel.map((item) => item.toLowerCase()));
  const topical = statementWords.filter((word) => !novelWords.has(word));
  if (coverage(topical, context.passageText) < 0.4) {
    quality.review(
      'statement_unrelated_to_passage',
      'The statement is mostly about things the passage never discusses, so NOT GIVEN is trivially true and tests nothing.',
    );
  }
  if (novel.length === 0) {
    grounding.review(
      'not_given_not_provable',
      'Nothing in the statement is demonstrably absent from the passage; the source may still say it in other words.',
    );
  }
}

/* ------------------------------------------------------------------------ */
/* Short answer and sentence completion                                      */
/* ------------------------------------------------------------------------ */

const WORD_NUMBERS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

function wordLimitOf(limit: string): number | null {
  const match = /NO MORE THAN\s+(ONE|TWO|THREE|FOUR|FIVE|\d+)\s+WORDS?/i.exec(limit);
  if (!match) return null;
  const token = match[1].toUpperCase();
  return WORD_NUMBERS[token] ?? Number(token);
}

function checkExtractive(input: FamilyInput, context: FamilyContext, grounding: VerdictBuilder, quality: VerdictBuilder) {
  const answer = input.correctAnswer;
  const target = normalizeForMatch(answer);
  const passage = normalizeForMatch(context.passageText);
  const cited = evidenceSentences(input.answerEvidence, context);

  if (!normalizeForMatch(input.answerEvidence.map((item) => item.quote).join(' ')).includes(target)) {
    if (passage.includes(target)) {
      grounding.review('answer_not_in_evidence', 'The answer is in the source, but not in the text cited as answer evidence.');
    } else {
      grounding.reject('answer_not_in_source', `The answer "${answer}" does not appear anywhere in the source text supplied to the model.`);
      return;
    }
  }
  for (const alternative of input.acceptableAnswers ?? []) {
    if (!passage.includes(normalizeForMatch(alternative))) {
      grounding.review('acceptable_answer_not_in_source', `The alternative answer "${alternative}" does not appear in the source.`);
    }
  }

  const limit = input.wordLimit ? wordLimitOf(input.wordLimit) : null;
  if (limit !== null) {
    for (const value of [answer, ...(input.acceptableAnswers ?? [])]) {
      if (value.trim().split(/\s+/).length > limit) {
        quality.reject('word_limit_exceeded', `"${value}" is longer than the question's own word limit (${input.wordLimit}).`);
      }
    }
  }
  if (input.type === 'sentence_completion' && !GAP.test(input.prompt)) {
    quality.reject('completion_missing_gap', 'The sentence has no gap for the answer to fill.');
    return;
  }

  const home = cited.find((sentence) => normalizeForMatch(sentence.text).includes(target)) ?? cited[0];
  const answerWords = new Set(contentWords(answer));
  const asked = promptWords(input.prompt).filter((word) => !answerWords.has(word));
  if (home && asked.length > 0 && coverage(asked, home.text) < 0.3) {
    quality.review('evidence_weak', 'The sentence holding the answer is not about what the question asks.');
  }

  if (home) {
    const alternatives = enumerationAlternatives(answer, home.text);
    if (alternatives) {
      const accepted = new Set((input.acceptableAnswers ?? []).map((value) => normalizeForMatch(value)));
      const unaccounted = alternatives.filter((item) => !accepted.has(item));
      if (unaccounted.length > 0) {
        quality.review(
          'answer_not_exclusive',
          `"${answer}" is one item in a list; "${unaccounted.join('", "')}" would answer equally well and are not accepted answers.`,
        );
      }
    }
  }

  if (input.type === 'sentence_completion') {
    const filled = fillGap(input.prompt, answer);
    const filledWords = contentWords(filled);
    const closest = context.sentences
      .map((sentence) => ({ sentence, share: coverage(filledWords, sentence.text) }))
      .sort((a, b) => b.share - a.share)[0];
    if (!closest || closest.share < 0.6) {
      quality.review(
        'completion_changes_meaning',
        `The completed sentence matches no source sentence closely (best ${percent(closest?.share ?? 0)}), so it cannot be confirmed to keep the source's meaning.`,
      );
    } else {
      const against = contradiction(filled, closest.sentence.text);
      if (against) quality.review('completion_changes_meaning', `The completed sentence differs from the source (${against}).`);
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Matching headings                                                         */
/* ------------------------------------------------------------------------ */

function checkHeadingQuestion(input: FamilyInput, context: FamilyContext, grounding: VerdictBuilder): HeadingInfo | undefined {
  const label = /section\s+([A-Z])\b/i.exec(input.prompt)?.[1]?.toUpperCase();
  const section = context.sections.find((item) => item.label === label);
  if (!section) {
    grounding.reject('section_not_named', 'The prompt does not name one of the passage sections.');
    return undefined;
  }
  if (!input.answerEvidence.some((item) => item.chunkId === section.chunkId)) {
    grounding.reject('evidence_from_wrong_section', `The answer evidence does not come from Section ${section.label}, which the question is about.`);
    return undefined;
  }
  const options = input.options ?? [];
  const keyedIndex = options.findIndex((option) => answerMatchesOption(input.correctAnswer, option));
  return { label: section.label, chunkId: section.chunkId, keyedIndex, options };
}

/**
 * Checks a matching-headings set as the set it is.
 *
 * Most of what makes a heading question good is relational — its heading must
 * fit its own section better than any other section, no other heading may fit
 * that section as well, and the spare headings must be near misses rather than
 * noise — so these checks run once over every heading question together.
 */
export function checkHeadingSet(
  items: Array<{ info: HeadingInfo; quality: VerdictBuilder }>,
  context: FamilyContext,
): void {
  if (items.length === 0) return;
  const headings = items[0].info.options;
  const texts = headings.map(stripOptionLabel);
  const headingWords = texts.map(contentWords);
  const reference = texts.map((text) => normalizeForMatch(text)).join('|');
  const chunkText = (chunkId: string) => context.chunks.find((chunk) => chunk.id === chunkId)?.text ?? '';
  const sectionLabel = (chunkId: string) => context.sections.find((section) => section.chunkId === chunkId)?.label ?? '?';
  const fit = (heading: number, chunkId: string) => coverage(headingWords[heading], chunkText(chunkId));

  const seenSections = new Set<string>();
  const byHeading = new Map<number, number>();
  for (const item of items) {
    if (item.info.options.map((option) => normalizeForMatch(stripOptionLabel(option))).join('|') !== reference) {
      item.quality.review('inconsistent_heading_list', 'This question offers a different list of headings from the others in the set.');
    }
    if (seenSections.has(item.info.label)) {
      item.quality.reject('section_answered_twice', `Section ${item.info.label} already has a heading question.`);
      continue;
    }
    seenSections.add(item.info.label);
    byHeading.set(item.info.keyedIndex, (byHeading.get(item.info.keyedIndex) ?? 0) + 1);
  }

  for (const item of items) {
    if (item.quality.rejected) continue;
    const { chunkId, keyedIndex: keyed, label } = item.info;
    if (keyed < 0) continue;
    if ((byHeading.get(keyed) ?? 0) > 1) {
      item.quality.review('heading_used_twice', `Heading "${texts[keyed]}" is the answer for more than one section.`);
    }

    const own = fit(keyed, chunkId);
    if (own < 0.34) {
      item.quality.review('heading_not_appropriate', `Heading "${texts[keyed]}" shares only ${percent(own)} of its words with Section ${label}.`);
    }
    for (const section of context.sections) {
      if (section.chunkId === chunkId || own === 0) continue;
      if (fit(keyed, section.chunkId) >= own) {
        item.quality.review(
          'headings_ambiguous_between_sections',
          `Heading "${texts[keyed]}" fits Section ${sectionLabel(section.chunkId)} at least as well as Section ${label}.`,
        );
      }
    }
    headingWords.forEach((_, other) => {
      if (other === keyed || own === 0) return;
      if (fit(other, chunkId) >= own) {
        item.quality.review('answer_not_exclusive', `Heading "${texts[other]}" fits Section ${label} at least as well as the keyed heading.`);
      }
    });

    const bookHeading = context.chunks.find((chunk) => chunk.id === chunkId)?.heading;
    if (bookHeading) {
      const bookWords = contentWords(bookHeading);
      if (
        bookWords.length >= 2 &&
        (normalizeForMatch(texts[keyed]) === normalizeForMatch(bookHeading) || jaccard(headingWords[keyed], bookWords) >= 0.8)
      ) {
        item.quality.review(
          'heading_leaks_source_heading',
          `Heading "${texts[keyed]}" repeats the book's own title for this section, "${bookHeading}".`,
        );
      }
    }
  }

  const used = new Set(items.map((item) => item.info.keyedIndex));
  texts.forEach((text, index) => {
    if (used.has(index) || headingWords[index].length === 0) return;
    if (coverage(headingWords[index], context.passageText) < 0.15) {
      for (const item of items) {
        item.quality.review('unused_heading_implausible', `Unused heading "${text}" has nothing to do with the passage, so it is not a real distractor.`);
      }
    }
  });
}

/* ------------------------------------------------------------------------ */

export function checkFamily(
  input: FamilyInput,
  context: FamilyContext,
  grounding: VerdictBuilder,
  quality: VerdictBuilder,
): HeadingInfo | undefined {
  switch (input.type) {
    case 'multiple_choice':
      checkMultipleChoice(input, context, grounding, quality);
      return undefined;
    case 'true_false_not_given':
      checkTrueFalseNotGiven(input, context, grounding, quality);
      return undefined;
    case 'short_answer':
    case 'sentence_completion':
      checkExtractive(input, context, grounding, quality);
      return undefined;
    case 'matching_headings':
      return checkHeadingQuestion(input, context, grounding);
    default:
      return undefined;
  }
}
