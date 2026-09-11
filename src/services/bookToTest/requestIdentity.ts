import { createHash } from 'node:crypto';

/**
 * What makes two generation requests the same request.
 *
 * Two parts, because they answer different questions:
 *
 * - The request id is minted by the admin screen for one deliberate click. A
 *   double submit, or a retry after the response was lost, sends the same id;
 *   pressing Generate again on purpose sends a new one. The id is what the
 *   server deduplicates on, so asking for the same thing twice on purpose is
 *   never collapsed into one draft.
 * - The fingerprint is what that click asked for: source, target, topic,
 *   question type, count, and the generator and prompt versions. It is stored
 *   with the id, and an id that comes back asking for something else is
 *   refused rather than answered with the wrong draft.
 */

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface GenerationIdentity {
  sourceId: string;
  section: 'reading';
  module: 'academic' | 'general';
  targetBand?: string;
  title?: string;
  topic: string;
  questionType: string;
  count: number;
  generatorVersion: string;
  promptVersion: string;
}

/** Whitespace and case are not part of what was asked for. */
export const normalizeTopic = (topic: string) => topic.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

export function generationFingerprint(identity: GenerationIdentity): string {
  const canonical = JSON.stringify([
    identity.sourceId,
    identity.section,
    identity.module,
    identity.targetBand?.trim() ?? '',
    identity.title?.trim() ?? '',
    normalizeTopic(identity.topic),
    identity.questionType,
    identity.count,
    identity.generatorVersion,
    identity.promptVersion,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
