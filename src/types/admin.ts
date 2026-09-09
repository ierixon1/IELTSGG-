// Types for Admin CMS, Examiners, and Full CDI Bundles
export interface AdminUser {
  id: string;
  username: string;
  name: string;
  role: 'admin' | 'examiner';
}

export type AdminSectionType = 'speaking' | 'reading' | 'listening' | 'writing';
export type AdminContentStatus = 'draft' | 'published';

export interface BaseAdminMaterial {
  id: string;
  title: string;
  section: AdminSectionType;
  module: 'academic' | 'general';
  status: AdminContentStatus;
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
  content: MaterialAssetRefs & { passage: { passageNumber: number; title: string; text: string; htmlContent?: string; questions: any[] }; htmlContent?: string };
}

export interface AdminListeningMaterial extends BaseAdminMaterial {
  section: 'listening';
  content: MaterialAssetRefs & {
    section: { sectionNumber: number; title: string; contextDescription: string; audioTranscript?: string; htmlContent?: string; questions: any[] };
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
