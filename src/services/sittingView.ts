import type { Question } from '../types';
import type { AdminMaterial } from '../types/admin';
import { learnerAssetUrl } from '../utils/assetUrl';

/**
 * What of a material reaches a signed-in learner.
 *
 * Practice marks in the browser, so this view carries the answer key — the one
 * thing practice needs that an anonymous catalog must never see. A full exam's
 * paper is built from this view with every key removed (`toExamPaper`), and the
 * exam session marks on the server. Everything
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

export function toLearnerMaterial(source: AdminMaterial, options: { keepTranscript: boolean }): AdminMaterial {
  const { needsReview: _needsReview, ...material } = structuredClone(source);

  switch (material.section) {
    case 'reading': {
      const { importRecord: _i, generationRecord: _g, generationReviews: _r, sourceAssetId: _s, ...content } = material.content;
      return { ...material, content: { ...content, passage: { ...content.passage, questions: withoutProvenance(content.passage.questions) } } };
    }
    case 'listening': {
      const { importRecord: _i, generationRecord: _g, generationReviews: _r, sourceAssetId: _s, audioUrl: _url, transcript, ...content } = material.content;
      const { audioTranscript, ...section } = content.section;
      return {
        ...material,
        content: {
          ...content,
          ...(content.audioAssetId ? { audioUrl: learnerAssetUrl(content.audioAssetId) } : {}),
          ...(options.keepTranscript && transcript !== undefined ? { transcript } : {}),
          section: {
            ...section,
            ...(options.keepTranscript && audioTranscript !== undefined ? { audioTranscript } : {}),
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
