import type { AdminMaterial } from '../types/admin';
import {
  BUNDLE_SECTIONS,
  IELTS_REFERENCE_MINUTES,
  MAX_SECTION_MINUTES,
  REQUIRED_PARTS,
  minutesKey,
  type BundleBlocker,
  type BundleBlockerCode,
  type BundleComponentRef,
  type BundleSection,
  type FullCdiBundle,
} from '../types/bundle';
import { partNumberOf, publishBlockers, questionsOf } from './publishGate';

/**
 * The IELTS paper sizes a full exam must match (ielts.org, Listening and Reading
 * test format): Listening has four parts with 10 questions in each; Reading has
 * 40 questions across its three passages or sections, not a fixed number per
 * passage. The published raw-score tables are out of 40, so a band is only an
 * IELTS band when the section has exactly 40.
 */
export const LISTENING_QUESTIONS_PER_PART = 10;
export const READING_QUESTIONS_TOTAL = 40;

/**
 * Whether a bundle may be published, or sat — as reasons, never as a boolean.
 *
 * A pure function of the bundle and what the caller looked up: the material
 * each reference resolves to, whether its content still matches the pinned
 * fingerprint, and which assets exist. The route builds that context from the
 * stores; tests build it by hand. The same blockers decide publication and
 * decide whether a learner may open the bundle, so a bundle that has gone bad
 * since it was published is refused to learners for the same reasons it would
 * be refused to an admin.
 *
 * Nothing is repaired. A missing part is not borrowed from another bundle, a
 * changed material is not re-pinned, a draft material is not treated as good
 * enough.
 */

export interface ComponentState {
  /** The material in the section the reference names, or null when there is none. */
  material: AdminMaterial | null;
  /** When the id is not in that section, the section it does exist in. */
  foundInSection: BundleSection | null;
  /** Stored questions that cannot be made canonical, as the material gate words them. */
  needsReview: string[];
  /** The fingerprint of the material as it stands now. */
  currentHash: string | null;
}

export interface AssetState {
  exists: boolean;
  kind: string | null;
}

export interface BundleGateContext {
  component: (ref: BundleComponentRef) => ComponentState;
  asset: (assetId: string) => AssetState;
}

const SECTION_LABEL: Record<BundleSection, string> = {
  listening: 'Listening',
  reading: 'Reading',
  writing: 'Writing',
  speaking: 'Speaking',
};

const MISSING_CODE: Record<BundleSection, BundleBlockerCode> = {
  listening: 'listening_missing',
  reading: 'reading_missing',
  writing: 'writing_missing',
  speaking: 'speaking_missing',
};

export function componentLabel(section: BundleSection, part: number): string {
  if (section === 'listening') return `Listening Part ${part}`;
  if (section === 'reading') return `Reading Passage ${part}`;
  return SECTION_LABEL[section];
}

function configurationBlockers(bundle: FullCdiBundle): BundleBlocker[] {
  const blockers: BundleBlocker[] = [];
  if (!bundle.title.trim()) {
    blockers.push({ code: 'invalid_configuration', message: 'The bundle has no title.' });
  }
  if (bundle.module !== 'academic' && bundle.module !== 'general') {
    blockers.push({ code: 'invalid_configuration', message: 'The bundle must be Academic or General Training.' });
  }
  for (const ref of bundle.components) {
    if (!REQUIRED_PARTS[ref.section].includes(ref.part)) {
      blockers.push({
        code: 'invalid_configuration',
        section: ref.section,
        part: ref.part,
        materialId: ref.materialId,
        message: `${SECTION_LABEL[ref.section]} has no part ${ref.part}; it takes ${REQUIRED_PARTS[ref.section].join(', ')}.`,
      });
    }
  }
  return blockers;
}

function timingBlockers(bundle: FullCdiBundle): BundleBlocker[] {
  const blockers: BundleBlocker[] = [];
  for (const section of BUNDLE_SECTIONS) {
    const minutes = bundle.timing[minutesKey(section)];
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SECTION_MINUTES) {
      blockers.push({
        code: 'invalid_timing',
        section,
        message: `${SECTION_LABEL[section]} duration must be a whole number of minutes between 1 and ${MAX_SECTION_MINUTES}; it is ${minutes}.`,
      });
    }
  }
  if (bundle.timing.basis === 'ielts_reference') {
    const differing = BUNDLE_SECTIONS.filter(
      (section) => bundle.timing[minutesKey(section)] !== IELTS_REFERENCE_MINUTES[minutesKey(section)],
    );
    if (differing.length > 0) {
      blockers.push({
        code: 'invalid_timing',
        message: `The timing is labelled as IELTS reference timing, but ${differing
          .map((section) => SECTION_LABEL[section])
          .join(', ')} differ from it. Use the reference values or label the timing custom.`,
      });
    }
  }
  return blockers;
}

function structureBlockers(bundle: FullCdiBundle): BundleBlocker[] {
  const blockers: BundleBlocker[] = [];
  for (const section of BUNDLE_SECTIONS) {
    const refs = bundle.components.filter((ref) => ref.section === section);
    if (refs.length === 0) {
      blockers.push({ code: MISSING_CODE[section], section, message: `The bundle has no ${SECTION_LABEL[section]} component.` });
      continue;
    }
    for (const part of REQUIRED_PARTS[section]) {
      const count = refs.filter((ref) => ref.part === part).length;
      if (count === 0) {
        blockers.push({ code: 'part_missing', section, part, message: `${componentLabel(section, part)} is missing.` });
      } else if (count > 1) {
        blockers.push({
          code: 'part_duplicate',
          section,
          part,
          message: `${componentLabel(section, part)} is filled ${count} times; it takes exactly one material.`,
        });
      }
    }
  }
  return blockers;
}

function duplicateBlockers(bundle: FullCdiBundle): BundleBlocker[] {
  const seen = new Map<string, number>();
  for (const ref of bundle.components) seen.set(ref.materialId, (seen.get(ref.materialId) ?? 0) + 1);
  return [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([materialId, count]) => ({
      code: 'duplicate_material' as const,
      materialId,
      message: `Material ${materialId} is used ${count} times in this bundle.`,
    }));
}

function componentBlockers(bundle: FullCdiBundle, ref: BundleComponentRef, context: BundleGateContext): BundleBlocker[] {
  const where = componentLabel(ref.section, ref.part);
  const base = { section: ref.section, part: ref.part, materialId: ref.materialId };
  const state = context.component(ref);
  const material = state.material;

  if (!material) {
    if (state.foundInSection) {
      return [
        {
          ...base,
          code: 'section_mismatch',
          message: `${where} names ${ref.materialId}, which is a ${SECTION_LABEL[state.foundInSection]} material.`,
        },
      ];
    }
    return [{ ...base, code: 'component_not_found', message: `${where} names ${ref.materialId}, which does not exist.` }];
  }
  if (material.section !== ref.section) {
    return [
      { ...base, code: 'section_mismatch', message: `${where} names a ${SECTION_LABEL[material.section]} material.` },
    ];
  }

  const blockers: BundleBlocker[] = [];
  const named = `${where} ("${material.title}")`;

  if (material.status === 'draft') {
    blockers.push({ ...base, code: 'component_unpublished', message: `${named} is not published.` });
  } else if (material.status === 'archived') {
    blockers.push({ ...base, code: 'component_archived', message: `${named} is archived.` });
  }
  if (material.module !== bundle.module) {
    blockers.push({
      ...base,
      code: 'module_mismatch',
      message: `${named} is ${material.module === 'general' ? 'General Training' : 'Academic'}, but the bundle is ${bundle.module === 'general' ? 'General Training' : 'Academic'}.`,
    });
  }
  if (ref.section === 'listening' || ref.section === 'reading') {
    const own = partNumberOf(material);
    if (own !== ref.part) {
      blockers.push({
        ...base,
        code: 'part_mismatch',
        message: `${named} is printed as ${own === null ? 'no part' : componentLabel(ref.section, own)}, not ${where}.`,
      });
    }
  }

  if (!ref.contentHash) {
    blockers.push({
      ...base,
      code: 'component_unpinned',
      message: `${named} was added before versions were pinned. Pin its current published content before publishing.`,
    });
  } else if (state.currentHash !== ref.contentHash) {
    blockers.push({
      ...base,
      code: 'component_changed',
      message: `${named} has changed since it was pinned into this bundle. Review it and pin the new version deliberately.`,
    });
  }

  for (const blocker of publishBlockers(material, {
    assetExists: (id) => context.asset(id).exists,
    needsReview: state.needsReview,
  })) {
    blockers.push({
      ...base,
      code: blocker.code === 'asset_missing' ? 'asset_missing' : 'invalid_question_set',
      message: `${where}: ${blocker.message}`,
    });
  }

  if (material.section === 'writing') {
    const task = (material.content.task ?? {}) as Record<string, { prompt?: unknown } | undefined>;
    const missing = (['task1', 'task2'] as const).filter((key) => typeof task[key]?.prompt !== 'string' || !String(task[key]?.prompt).trim());
    if (missing.length > 0) {
      blockers.push({
        ...base,
        code: 'invalid_question_set',
        message: `${named} must carry both Task 1 and Task 2 for a full exam; ${missing.map((key) => (key === 'task1' ? 'Task 1' : 'Task 2')).join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing.`,
      });
    }
  }

  if (material.section === 'listening') {
    const count = questionsOf(material).length;
    if (count !== LISTENING_QUESTIONS_PER_PART) {
      blockers.push({
        ...base,
        code: 'question_count',
        message: `${named} has ${count} question${count === 1 ? '' : 's'}; an IELTS Listening part has ${LISTENING_QUESTIONS_PER_PART}.`,
      });
    }
    const audioId = material.content.audioAssetId;
    if (!audioId) {
      blockers.push({ ...base, code: 'audio_missing', message: `${named} has no audio file.` });
    } else {
      const audio = context.asset(audioId);
      if (!audio.exists) {
        blockers.push({ ...base, code: 'audio_missing', message: `${named} names audio ${audioId}, which is not in the asset store.` });
      } else if (audio.kind !== 'audio') {
        blockers.push({ ...base, code: 'audio_missing', message: `${named} names ${audioId} as its audio, but that file is ${audio.kind ?? 'not audio'}.` });
      }
    }
  }

  return blockers;
}

/**
 * Every reason the bundle may not be published or sat, in the order they are
 * fixed: what the bundle is, how it is timed, what it is made of, then each
 * component. An empty list means publishable.
 */
export function bundleBlockers(bundle: FullCdiBundle, context: BundleGateContext): BundleBlocker[] {
  return [
    ...configurationBlockers(bundle),
    ...timingBlockers(bundle),
    ...structureBlockers(bundle),
    ...duplicateBlockers(bundle),
    ...bundle.components.flatMap((ref) => componentBlockers(bundle, ref, context)),
    ...readingCountBlockers(bundle, context),
  ];
}

/**
 * Reading takes 40 questions across the section. Counted only once every Reading
 * part resolves to a Reading material: a missing or wrong component is already
 * reported, and a total over an incomplete section would be a second, misleading
 * blocker for the same fault.
 */
function readingCountBlockers(bundle: FullCdiBundle, context: BundleGateContext): BundleBlocker[] {
  const refs = bundle.components.filter((ref) => ref.section === 'reading');
  const materials = refs.map((ref) => context.component(ref).material);
  const complete =
    REQUIRED_PARTS.reading.every((part) => refs.some((ref) => ref.part === part)) &&
    materials.every((material) => material !== null && material.section === 'reading');
  if (!complete) return [];
  const total = materials.reduce((sum, material) => sum + (material ? questionsOf(material).length : 0), 0);
  if (total === READING_QUESTIONS_TOTAL) return [];
  return [
    {
      code: 'question_count',
      section: 'reading',
      message: `Reading has ${total} question${total === 1 ? '' : 's'} across its passages; an IELTS Reading test has ${READING_QUESTIONS_TOTAL}.`,
    },
  ];
}
