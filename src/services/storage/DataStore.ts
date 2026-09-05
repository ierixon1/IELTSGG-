import { UserProfile, MockAttempt, PlanTask, ChecklistWeek } from '../../types';
import { GeneratedTestRecord, StoredTextbook, StoredTextbookSummary, TextbookChunk } from './types';

export interface DailyQuota {
  dateStr: string; // YYYY-MM-DD
  generationsCount: number;
  uploadsCount: number;
}

export interface DataStore {
  // User Profile
  getUserProfile(userId: string): Promise<UserProfile | null>;
  saveUserProfile(userId: string, profile: UserProfile): Promise<void>;

  // Tasks & Checklist
  getUserTasks(userId: string): Promise<PlanTask[]>;
  saveUserTasks(userId: string, tasks: PlanTask[]): Promise<void>;
  getUserChecklist(userId: string): Promise<ChecklistWeek[]>;
  saveUserChecklist(userId: string, checklist: ChecklistWeek[]): Promise<void>;

  // Mock attempts
  getUserAttempts(userId: string): Promise<MockAttempt[]>;
  saveUserAttempt(userId: string, attempt: MockAttempt): Promise<void>;

  // Generated Tests & Anti-Repeat History
  recordGeneratedTest(userId: string, test: GeneratedTestRecord): Promise<void>;
  getRecentGenerations(userId: string, limit?: number): Promise<GeneratedTestRecord[]>;
  getGeneratedTestById(userId: string, testId: string): Promise<GeneratedTestRecord | null>;

  // Rate-Limiting Quotas
  getDailyQuota(userId: string): Promise<DailyQuota>;
  incrementGenerationCount(userId: string): Promise<DailyQuota>;
  incrementUploadCount(userId: string): Promise<DailyQuota>;

  // Textbooks & Chunks
  saveTextbook(textbook: StoredTextbook): Promise<void>;
  getTextbook(userId: string, textbookId: string): Promise<StoredTextbook | null>;
  listUserTextbooks(userId: string): Promise<StoredTextbookSummary[]>;
  deleteTextbook(userId: string, textbookId: string): Promise<void>;
  saveTextbookChunks(textbookId: string, chunks: TextbookChunk[]): Promise<void>;
  getTextbookChunks(textbookId: string): Promise<TextbookChunk[]>;
}
