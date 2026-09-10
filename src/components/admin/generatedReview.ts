import type { StoredGenerationRecord } from '../../schemas/material';
import type { CdiImportResult } from '../../services/cdiImport/types';
import {
  buildReviewState,
  setClassification,
  type ReviewConfirmation,
  type ReviewState,
} from '../../services/cdiImport/review';

interface GeneratedReviewResponse {
  materialId: string;
  result: CdiImportResult;
  sourceHtml: string;
  generationRecord: StoredGenerationRecord;
  generationReviews?: ReviewConfirmation[];
  classification: { module: 'academic' | 'general'; theme: string; targetBand: string; title: string; part: number };
}

/**
 * Loads a generated draft into the shared review screen.
 *
 * Used straight after generation and from the material catalog: a flagged
 * question has to be decidable later, by whoever reviews it, not only in the
 * session that happened to generate it.
 */
export async function loadGeneratedReview(materialId: string): Promise<ReviewState> {
  const response = await fetch(`/api/admin/sources/generated/${encodeURIComponent(materialId)}/review`, {
    credentials: 'same-origin',
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : 'The draft could not be opened.';
    throw new Error(message);
  }

  const input = body as GeneratedReviewResponse;
  return setClassification(
    buildReviewState(input.result, {
      sourceHtml: input.sourceHtml,
      materialId: input.materialId,
      generationRecord: input.generationRecord,
      generationReviews: input.generationReviews,
    }),
    { section: 'reading', ...input.classification },
  );
}
