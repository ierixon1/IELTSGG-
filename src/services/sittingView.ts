import type { Question } from '../types';
import type { AdminMaterial } from '../types/admin';
import { learnerAssetUrl } from '../utils/assetUrl';
import { cutAnswerKeySection, withoutKeyLines, withoutKeyText, type AnswerKeyCut } from './answerKeySection';

/**
 * What of a material reaches a signed-in learner.
 *
 * This view still carries the questions' keys, because the server marks from
 * it; nothing sends it to a browser as it is. Practice and exam responses are
 * built from it with every key removed (`toPracticeTest`, `toExamPaper`), and an
 * imported page's printed answer-key section is cut out here. Everything
 * else that is not needed to sit the test stays on the server: how the material
 * was imported or generated, the reviewer decisions, the untouched original of
 * an imported document, grading guidance, and the admin-only `needsReview` list.
 *
 * An exam sitting also withholds the Listening transcript and any Speaking
 * model answers: they are the script the answers come from. Practice keeps the
 * transcript, because a learner reviewing a single part may read along.
 *
 * Audio is addressed through the learner asset route, which serves only files a
 * published material references.
 */

const withoutProvenance = (questions: Question[]): Question[] =>
  questions.map(({ provenance: _provenance, ...question }) => question);

/**
 * The page's display markup and text without an imported answer-key section.
 * `cut` is read from the first markup that carries one; every copy of the page
 * the material holds is cut the same way.
 */
function withoutKeySection<T extends { htmlContent?: string }>(holder: T, cut: AnswerKeyCut | null): T {
  if (!cut || !holder.htmlContent) return holder;
  const own = cutAnswerKeySection(holder.htmlContent);
  return own ? { ...holder, htmlContent: own.html } : holder;
}

export function toLearnerMaterial(source: AdminMaterial, options: { keepTranscript: boolean }): AdminMaterial {
  const { needsReview: _needsReview, ...material } = structuredClone(source);

  switch (material.section) {
    case 'reading': {
      const { importRecord: _i, generationRecord: _g, generationReviews: _r, sourceAssetId: _s, ...content } = material.content;
      const cut = cutAnswerKeySection(content.passage.htmlContent ?? content.htmlContent ?? '');
      const passage = withoutKeySection(content.passage, cut);
      return {
        ...material,
        content: {
          ...withoutKeySection(content, cut),
          passage: {
            ...passage,
            text: cut ? (withoutKeyText(passage.text, cut) ?? '') : passage.text,
            questions: withoutProvenance(content.passage.questions),
          },
        },
      };
    }
    case 'listening': {
      const { importRecord: _i, generationRecord: _g, generationReviews: _r, sourceAssetId: _s, audioUrl: _url, transcript, ...rest } = material.content;
      const cut = cutAnswerKeySection(rest.section.htmlContent ?? rest.htmlContent ?? '');
      const content = withoutKeySection(rest, cut);
      const { audioTranscript, ...section } = withoutKeySection(content.section, cut);
      const keptTranscript = cut ? withoutKeyLines(transcript, cut) : transcript;
      const keptAudioTranscript = cut ? withoutKeyLines(audioTranscript, cut) : audioTranscript;
      return {
        ...material,
        content: {
          ...content,
          ...(content.audioAssetId ? { audioUrl: learnerAssetUrl(content.audioAssetId) } : {}),
          ...(options.keepTranscript && keptTranscript !== undefined ? { transcript: keptTranscript } : {}),
          section: {
            ...section,
            ...(options.keepTranscript && keptAudioTranscript !== undefined ? { audioTranscript: keptAudioTranscript } : {}),
            questions: withoutProvenance(section.questions),
          },
        },
      };
    }
    case 'writing': {
      const { customGradingCriteria: _c, ...content } = material.content;
      return { ...material, content };
    }
    case 'speaking': {
      const { audioModelAnswers, ...content } = material.content;
      return { ...material, content: options.keepTranscript && audioModelAnswers ? { ...content, audioModelAnswers } : content };
    }
  }
}
