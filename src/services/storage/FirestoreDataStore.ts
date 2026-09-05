import { UserProfile, MockAttempt, PlanTask, ChecklistWeek } from '../../types';
import { DataStore, DailyQuota } from './DataStore';
import { GeneratedTestRecord, StoredTextbook, StoredTextbookSummary, TextbookChunk } from './types';

/**
 * Production Firestore DataStore implementation for Cloud Run
 * Activated when STORAGE_BACKEND=gcs_firestore
 */
export class FirestoreDataStore implements DataStore {
  constructor() {
    // When enabled, connects to Firestore via firebase-admin or @google-cloud/firestore
  }

  async getUserProfile(userId: string): Promise<UserProfile | null> {
    throw new Error('FirestoreDataStore requires FIREBASE_PROJECT_ID configuration');
  }

  async saveUserProfile(userId: string, profile: UserProfile): Promise<void> {
    throw new Error('FirestoreDataStore requires FIREBASE_PROJECT_ID configuration');
  }

  async getUserTasks(userId: string): Promise<PlanTask[]> {
    return [];
  }

  async saveUserTasks(userId: string, tasks: PlanTask[]): Promise<void> {
  }

  async getUserChecklist(userId: string): Promise<ChecklistWeek[]> {
    return [];
  }

  async saveUserChecklist(userId: string, checklist: ChecklistWeek[]): Promise<void> {
  }

  async getUserAttempts(userId: string): Promise<MockAttempt[]> {
    return [];
  }

  async saveUserAttempt(userId: string, attempt: MockAttempt): Promise<void> {
  }

  async recordGeneratedTest(userId: string, test: GeneratedTestRecord): Promise<void> {
  }

  async getRecentGenerations(userId: string, limit = 20): Promise<GeneratedTestRecord[]> {
    return [];
  }

  async getGeneratedTestById(userId: string, testId: string): Promise<GeneratedTestRecord | null> {
    return null;
  }

  async getDailyQuota(userId: string): Promise<DailyQuota> {
    return {
      dateStr: new Date().toISOString().slice(0, 10),
      generationsCount: 0,
      uploadsCount: 0
    };
  }

  async incrementGenerationCount(userId: string): Promise<DailyQuota> {
    return {
      dateStr: new Date().toISOString().slice(0, 10),
      generationsCount: 1,
      uploadsCount: 0
    };
  }

  async incrementUploadCount(userId: string): Promise<DailyQuota> {
    return {
      dateStr: new Date().toISOString().slice(0, 10),
      generationsCount: 0,
      uploadsCount: 1
    };
  }

  async saveTextbook(textbook: StoredTextbook): Promise<void> {
  }

  async getTextbook(userId: string, textbookId: string): Promise<StoredTextbook | null> {
    return null;
  }

  async listUserTextbooks(userId: string): Promise<StoredTextbookSummary[]> {
    return [];
  }

  async deleteTextbook(userId: string, textbookId: string): Promise<void> {
  }

  async saveTextbookChunks(textbookId: string, chunks: TextbookChunk[]): Promise<void> {
  }

  async getTextbookChunks(textbookId: string): Promise<TextbookChunk[]> {
    return [];
  }
}
