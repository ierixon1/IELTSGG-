import type { Question } from '../types';
import type { StoredImportRecord } from '../schemas/material';

// Types for Admin CMS, Examiners, and Full CDI Bundles
export interface AdminUser {
  id: string;
  username: string;
  name: string;
  role: 'admin' | 'examiner';
}

export type AdminSectionType = 'speaking' | 'reading' | 'listening' | 'writing';
export type AdminContentStatus = 'draft' | 'published';

/**
 * Where a material is in its life.
 *
 * Separate from the bundle status because the two are not the same idea: a
 * bundle is assembled or not, whereas a material is written, then deliberately
 * published, and eventually retired without being destroyed. `archived` exists
 * so retiring a material is not a delete — the attempts that reference it stay
 * meaningful — while still putting it out of every learner’s reach.
 */
export type MaterialLifecycleStatus = 'draft' | 'published' | 'archived';

export interface BaseAdminMaterial {
  id: string;
  title: string;
  section: AdminSectionType;
  module: 'academic' | 'general';
  status: MaterialLifecycleStatus;
  /**
   * Questions the stored row carries that cannot be made canonical.
   *
   * Computed on every read and never stored, which is why it is optional: the
   * admin list attaches it so the catalog can show what still needs a human,
   * and the publish gate refuses while it is non-empty.
   */
  needsReview?: string[];
  theme?: string;
  targetBand?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Asset references a material's content may carry.
 *
 * Files are referenced by id rather than copied in, so deleting a material can
 * release what nothing else uses, and so the original of an imported document
 * survives sanitisation and can be re-parsed later.
 */
export interface MaterialAssetRefs {
  /** Every asset this material depends on. */
  assetIds?: string[];
  /** The untouched original of an imported document; never served to a browser. */
  sourceAssetId?: string;
  /**
   * How an imported material was produced, and what the reviewer decided.
   * Written once by the import review screen and carried forward by the store;
   * the material editor neither shows nor rewrites it.
   */
  importRecord?: StoredImportRecord;
}

export interface AdminSpeakingMaterial extends BaseAdminMaterial {
  section: 'speaking';
  content: {
    speakingSession: {
      part1: { topic: string; questions: string[]; htmlContent?: string };
      part2: { cueCardTopic: string; bulletPoints: string[]; htmlContent?: string };
      part3: { questions: string[]; htmlContent?: string };
    };
    htmlContent?: string;
    audioModelAnswers?: { part: 'part1' | 'part2' | 'part3'; audioUrl: string; modelBand: number; transcript?: string }[];
  };
}

export interface AdminReadingMaterial extends BaseAdminMaterial {
  section: 'reading';
  content: MaterialAssetRefs & {
    passage: {
      passageNumber: number;
      title: string;
      text: string;
      htmlContent?: string;
      /** Canonical questions. Legacy shapes are converted at the storage boundary. */
      questions: Question[];
    };
    htmlContent?: string;
  };
}

export interface AdminListeningMaterial extends BaseAdminMaterial {
  section: 'listening';
  content: MaterialAssetRefs & {
    section: {
      sectionNumber: number;
      title: string;
      contextDescription: string;
      audioTranscript?: string;
      htmlContent?: string;
      /** Canonical questions. Legacy shapes are converted at the storage boundary. */
      questions: Question[];
    };
    /** Learner-facing URL, derived from `audioAssetId`. */
    audioUrl?: string;
    /** The stored audio asset. */
    audioAssetId?: string;
    audioFileName?: string;
    transcript?: string;
    htmlContent?: string;
  };
}

export interface AdminWritingMaterial extends BaseAdminMaterial {
  section: 'writing';
  content: {
    task: any;
    task1ImageUrl?: string;
    htmlContent?: string;
    customGradingCriteria?: { taskResponseGuide?: string; lexicalKeyTerms?: string[] };
  };
}

export type AdminMaterial = AdminSpeakingMaterial | AdminReadingMaterial | AdminListeningMaterial | AdminWritingMaterial;

export interface FullCdiBundle {
  id: string;
  title: string;
  module: 'academic' | 'general';
  targetBand?: string;
  status: AdminContentStatus;
  description?: string;
  createdAt: string;
  updatedAt: string;
  timings: { listeningMinutes: number; readingMinutes: number; writingMinutes: number; speakingMinutes: number };
  materials: { listeningId?: string; readingId?: string; writingId?: string; speakingId?: string };
}

export interface AdminStats {
  totalMaterials: number;
  publishedMaterials: number;
  draftMaterials: number;
  bySection: { speaking: number; reading: number; listening: number; writing: number };
  totalBundles: number;
  uploadedFilesCount: number;
  uploadedTotalBytes: number;
}
