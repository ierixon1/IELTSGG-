import type { Question } from '../../types';
import type { CdiImportResult } from './types';

/**
 * Assembles what the importer read into a draft material.
 *
 * This is a *draft*: it is returned for review, not saved. The write boundary
 * from phase 4 still validates anything that is eventually stored, so a draft
 * that would be refused there is refused there — this does not pre-approve it.
 *
 * Only questions the parser is confident about are carried into the draft.
 * Questions that need review travel alongside it, in the import result, so the
 * review screen shows them rather than the draft quietly being short.
 */
export interface DraftMaterial {
  title: string;
  section: 'reading' | 'listening';
  module: 'academic' | 'general';
  status: 'draft';
  content: Record<string, unknown>;
  /** The private asset holding the untouched original page. */
  sourceAssetId?: string;
  assetIds: string[];
  parserVersion: string;
}

export function toDraftMaterial(
  result: CdiImportResult,
  options: { sourceAssetId?: string } = {},
): DraftMaterial | null {
  // Without knowing the skill, the material cannot be filed. Guessing is how a
  // Listening test ends up in the Reading catalogue.
  if (!result.detectedSection) return null;

  const questions: Question[] = result.questions
    .filter((entry) => entry.status === 'parsed' && entry.question)
    .map((entry) => entry.question as Question);

  const assetIds = result.assets
    .map((asset) => asset.assetId)
    .filter((id): id is string => typeof id === 'string');
  if (options.sourceAssetId) assetIds.push(options.sourceAssetId);

  const shared = {
    htmlContent: result.normalizedHtml,
    sourceAssetId: options.sourceAssetId,
    assetIds,
  };

  const content =
    result.detectedSection === 'reading'
      ? {
          ...shared,
          passage: {
            passageNumber: 1,
            title: result.title,
            text: result.normalizedText,
            htmlContent: result.normalizedHtml,
            questions,
          },
        }
      : {
          ...shared,
          section: {
            sectionNumber: 1,
            title: result.title,
            contextDescription: '',
            audioTranscript: result.transcript,
            htmlContent: result.normalizedHtml,
            questions,
          },
          transcript: result.transcript,
        };

  return {
    title: result.title,
    section: result.detectedSection,
    module: 'academic',
    status: 'draft',
    content,
    sourceAssetId: options.sourceAssetId,
    assetIds,
    parserVersion: result.parserVersion,
  };
}
