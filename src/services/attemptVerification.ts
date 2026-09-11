import type { MockAttempt } from '../types';
import { BUNDLE_SECTIONS, type BundleComponentRef, type BundleSection } from '../types/bundle';
import { calculateOverallBand } from '../utils/ieltsScoring';
import { adminStore } from './adminStore';
import { bundleStore } from './bundleStore';
import { materialContentHash } from './materialVersion';
import { questionsOf } from './publishGate';

/**
 * Checks a full-exam attempt against the bundle it claims to come from.
 *
 * The client builds the attempt, so the server does not take its word for it:
 *
 *   - an exam attempt names its bundle, and every section, answer, essay and
 *     transcript names a component that bundle actually pins — the same
 *     material, the same content version, the same part;
 *   - every section records all of its components, so nothing was dropped;
 *   - an answer names a question that exists in that material version;
 *   - `completed` means all four sections carry a band and the overall band is
 *     the average of exactly those four; an incomplete attempt has no overall
 *     band at all.
 *
 * Returns the problems; an empty list means the attempt may be stored.
 */

const key = (section: BundleSection, ref: { part: number; materialId: string; contentHash: string }) =>
  `${section}:${ref.part}:${ref.materialId}:${ref.contentHash}`;

export async function verifyExamAttempt(attempt: MockAttempt): Promise<string[]> {
  const problems: string[] = [];
  const isExam = attempt.mode === 'exam' && attempt.isFullMock === true;

  if (!attempt.bundleId) {
    if (isExam) problems.push('A full exam attempt must name the bundle it was sat from.');
    const carriesExamRecords = attempt.sections || attempt.responses || attempt.writingTasks || attempt.speakingParts;
    if (carriesExamRecords) problems.push('Exam records were sent without a bundle.');
    return problems;
  }

  if (attempt.testId !== attempt.bundleId) problems.push('The attempt names a different test than its bundle.');
  if (!attempt.bundlePublishedAt) problems.push('The attempt does not record which publication of the bundle it sat.');

  const bundle = await bundleStore.get(attempt.bundleId);
  if (!bundle) return [...problems, `Bundle ${attempt.bundleId} does not exist.`];

  const pinned = new Map<string, BundleComponentRef>(bundle.components.map((ref) => [key(ref.section, ref), ref]));
  const sections = attempt.sections ?? {};

  for (const section of BUNDLE_SECTIONS) {
    const record = sections[section];
    if (!record) {
      problems.push(`The attempt has no record of ${section}.`);
      continue;
    }
    const expected = bundle.components.filter((ref) => ref.section === section).map((ref) => key(section, ref)).sort();
    const given = record.components.map((ref) => key(section, ref)).sort();
    if (JSON.stringify(expected) !== JSON.stringify(given)) {
      problems.push(`The ${section} record does not list exactly the components the bundle pins.`);
    }
    if (record.status !== 'completed' && typeof record.band === 'number') {
      problems.push(`${section} carries a band without being completed.`);
    }
  }

  const questionIds = new Map<string, Set<string> | null>();
  for (const response of attempt.responses ?? []) {
    const componentKey = key(response.section, response);
    if (!pinned.has(componentKey)) {
      problems.push(`An answer to ${response.questionId} names a ${response.section} component the bundle does not pin.`);
      continue;
    }
    if (!questionIds.has(componentKey)) {
      const material = await adminStore.getMaterial(response.section, response.materialId);
      // Questions can only be checked against the version that was sat.
      questionIds.set(
        componentKey,
        material && materialContentHash(material) === response.contentHash ? new Set(questionsOf(material).map((q) => q.id)) : null,
      );
    }
    const known = questionIds.get(componentKey);
    if (known && !known.has(response.questionId)) {
      problems.push(`Question ${response.questionId} is not part of ${response.section} part ${response.part}.`);
    }
  }

  for (const task of attempt.writingTasks ?? []) {
    if (!pinned.has(key('writing', { part: 1, materialId: task.materialId, contentHash: task.contentHash }))) {
      problems.push(`Writing Task ${task.task} names a component the bundle does not pin.`);
    }
  }
  const tasks = (attempt.writingTasks ?? []).map((task) => task.task).sort();
  if (JSON.stringify(tasks) !== JSON.stringify([1, 2])) problems.push('The attempt must record Writing Task 1 and Task 2.');

  for (const part of attempt.speakingParts ?? []) {
    if (!pinned.has(key('speaking', { part: 1, materialId: part.materialId, contentHash: part.contentHash }))) {
      problems.push(`Speaking Part ${part.part} names a component the bundle does not pin.`);
    }
  }
  const parts = (attempt.speakingParts ?? []).map((part) => part.part).sort();
  if (JSON.stringify(parts) !== JSON.stringify([1, 2, 3])) problems.push('The attempt must record Speaking Parts 1, 2 and 3.');

  const bands: Partial<Record<BundleSection, number>> = {};
  for (const section of BUNDLE_SECTIONS) {
    const record = sections[section];
    if (record?.status === 'completed' && typeof record.band === 'number') bands[section] = record.band;
    const scored = attempt.scores[section]?.band;
    if (typeof scored === 'number' && scored !== record?.band) {
      problems.push(`The ${section} score does not match its section record.`);
    }
    if (typeof scored !== 'number' && typeof record?.band === 'number') {
      problems.push(`The ${section} section has a band that the scores leave out.`);
    }
  }
  const allComplete = BUNDLE_SECTIONS.every((section) => typeof bands[section] === 'number');

  if (attempt.status === 'completed') {
    if (!allComplete) problems.push('An attempt cannot be completed while a section is not.');
    else if (attempt.scores.overall !== calculateOverallBand(bands)) {
      problems.push('The overall band is not the average of the four section bands.');
    }
  } else if (attempt.status === 'incomplete') {
    if (attempt.scores.overall !== undefined) problems.push('An incomplete attempt cannot carry an overall band.');
    if (allComplete) problems.push('Every section is complete, so the attempt is not incomplete.');
  } else {
    problems.push('An exam attempt must say whether it is completed or incomplete.');
  }

  return problems;
}
