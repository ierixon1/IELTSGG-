import { UserProfile, MockAttempt, PlanTask, ChecklistWeek } from '../../types';

export interface GeneratedTestRecord {
  id: string;
  userId: string;
  timestamp: string;
  module: 'academic' | 'general';
  section: 'reading' | 'listening' | 'writing' | 'speaking' | 'full_mock';
  targetBand: string;
  theme: string;
  contentHash: string;
  title: string;
  questionTypes: string[];
  data: any; // Full generated test JSON
}

export interface TextbookChunk {
  id: string;
  textbookId: string;
  chunkIndex: number;
  pageNumber?: number;
  sectionTitle?: string;
  content: string;
  tokenCount: number;
}

export interface TextbookTOCItem {
  id: string;
  title: string;
  pageNumber?: number;
  level: number;
  coveredSkills: string[];
  keyVocabulary: string[];
  exerciseTypes: string[];
  summary?: string;
}

export interface StoredTextbook {
  id: string;
  userId: string;
  title: string;
  author: string;
  description: string;
  targetModules: Array<'academic' | 'general'>;
  targetSections: Array<'reading' | 'listening' | 'writing' | 'speaking'>;
  fileStoragePath: string;
  fileSize: number;
  fileType: string;
  status: 'uploading' | 'processing' | 'ready' | 'error';
  errorMessage?: string;
  tableOfContents: TextbookTOCItem[];
  geminiCacheName?: string; // Gemini Context Cache resource name if cached
  geminiCacheExpireTime?: string;
  createdAt: string;
  updatedAt: string;
}

export type StoredTextbookSummary = Omit<StoredTextbook, 'tableOfContents'> & {
  unitCount: number;
  chunkCount?: number;
};
