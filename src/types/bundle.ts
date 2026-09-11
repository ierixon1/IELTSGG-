import type { AdminMaterial } from './admin';

/**
 * A Full CDI bundle: which published materials make up one sittable exam, and
 * how long each section runs.
 *
 * A bundle holds references, never content. Each component names one material
 * by id and pins the fingerprint of that material's content at the moment it
 * was chosen. Materials here have no immutable versions, so the fingerprint is
 * the version: when the referenced content changes, the bundle stops being
 * valid until someone deliberately pins the new content. It is never quietly
 * pointed at whatever the material says now.
 *
 * The CMS stores one Reading passage or one Listening part per material, so a
 * full bundle references four Listening materials, three Reading materials,
 * one Writing material (both tasks) and one Speaking material (all three parts).
 */

export type BundleSection = 'listening' | 'reading' | 'writing' | 'speaking';

/** The order a full exam is sat in. */
export const BUNDLE_SECTIONS: readonly BundleSection[] = ['listening', 'reading', 'writing', 'speaking'];

export type BundleLifecycleStatus = 'draft' | 'published' | 'archived';

/** The parts a full bundle must supply per section. Writing and Speaking are one material each. */
export const REQUIRED_PARTS: Readonly<Record<BundleSection, readonly number[]>> = {
  listening: [1, 2, 3, 4],
  reading: [1, 2, 3],
  writing: [1],
  speaking: [1],
};

export interface BundleComponentRef {
  section: BundleSection;
  /** Listening Part 1–4 or Reading Passage 1–3; always 1 for Writing and Speaking. */
  part: number;
  materialId: string;
  /**
   * Fingerprint of the material's learner-facing content when it was pinned.
   * Empty only on a bundle migrated from before pinning existed.
   */
  contentHash: string;
}

export interface BundleTiming {
  listeningMinutes: number;
  readingMinutes: number;
  writingMinutes: number;
  speakingMinutes: number;
  /**
   * `ielts_reference` is a claim that these are the reference IELTS timings,
   * and is only valid when the four values are exactly those. Anything else is
   * `custom`, and is shown to learners as such.
   */
  basis: 'custom' | 'ielts_reference';
  /** Whether a learner may end a section before its time is up. */
  allowEarlyFinish: boolean;
}

export const IELTS_REFERENCE_MINUTES = {
  listeningMinutes: 30,
  readingMinutes: 60,
  writingMinutes: 60,
  speakingMinutes: 14,
} as const;

export const MAX_SECTION_MINUTES = 240;

export const minutesKey = (section: BundleSection) => `${section}Minutes` as const;

export interface FullCdiBundle {
  id: string;
  schemaVersion: 2;
  title: string;
  module: 'academic' | 'general';
  targetBand?: string;
  description?: string;
  status: BundleLifecycleStatus;
  components: BundleComponentRef[];
  timing: BundleTiming;
  createdAt: string;
  updatedAt: string;
  /** The latest publication. */
  publishedAt?: string;
  /** Set once and kept: a bundle that was ever published can no longer be deleted. */
  firstPublishedAt?: string;
  archivedAt?: string;
}

export type BundleBlockerCode =
  | 'listening_missing'
  | 'reading_missing'
  | 'writing_missing'
  | 'speaking_missing'
  | 'part_missing'
  | 'part_duplicate'
  | 'part_mismatch'
  | 'component_not_found'
  | 'component_unpublished'
  | 'component_archived'
  | 'section_mismatch'
  | 'module_mismatch'
  | 'duplicate_material'
  | 'invalid_question_set'
  | 'question_count'
  | 'audio_missing'
  | 'asset_missing'
  | 'component_changed'
  | 'component_unpinned'
  | 'invalid_timing'
  | 'invalid_configuration';

export interface BundleBlocker {
  code: BundleBlockerCode;
  message: string;
  section?: BundleSection;
  part?: number;
  materialId?: string;
}

/** What a learner can be told about why a bundle will not open. */
export type LearnerBundleErrorCode =
  | 'bundle_not_found'
  | 'bundle_unpublished'
  | 'bundle_archived'
  | 'component_missing'
  | 'component_unpublished'
  | 'component_changed'
  | 'asset_unavailable'
  | 'invalid_bundle';

export interface BundleSummary {
  id: string;
  title: string;
  module: 'academic' | 'general';
  targetBand?: string;
  description?: string;
  status: BundleLifecycleStatus;
  publishedAt?: string;
  updatedAt: string;
  timing: BundleTiming;
  totalMinutes: number;
  /** How many parts each section carries. */
  parts: Record<BundleSection, number>;
}

export interface LearnerBundleSummary extends BundleSummary {
  /** False when the bundle is published but cannot be opened right now. */
  available: boolean;
  problem?: LearnerBundleErrorCode;
}

/** One pinned component, resolved to the exact material it names. */
export interface SittingComponent {
  section: BundleSection;
  part: number;
  materialId: string;
  contentHash: string;
  /** The learner-facing view of the material: no provenance, records, source assets or transcripts. */
  material: AdminMaterial;
}

/** Everything a learner needs to sit a bundle, and nothing else. */
export interface ExamSitting {
  bundle: {
    id: string;
    title: string;
    module: 'academic' | 'general';
    targetBand?: string;
    description?: string;
    publishedAt: string;
    timing: BundleTiming;
  };
  components: SittingComponent[];
}
