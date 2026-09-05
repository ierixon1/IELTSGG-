import fs from 'fs';
import path from 'path';
import { UserProfile, MockAttempt, PlanTask, ChecklistWeek } from '../../types';
import { DataStore, DailyQuota } from './DataStore';
import { GeneratedTestRecord, StoredTextbook, StoredTextbookSummary, TextbookChunk } from './types';

interface DatabaseSchema {
  users: Record<string, {
    profile?: UserProfile;
    tasks?: PlanTask[];
    checklist?: ChecklistWeek[];
    attempts?: MockAttempt[];
    quotas?: Record<string, { generationsCount: number; uploadsCount: number }>; // key: YYYY-MM-DD
    generatedTests?: GeneratedTestRecord[];
    textbooks?: StoredTextbook[];
  }>;
  chunks: Record<string, TextbookChunk[]>; // key: textbookId
}

export class LocalJsonDataStore implements DataStore {
  private filePath: string;
  private cache: DatabaseSchema | null = null;

  constructor(filePath = 'data/db.json') {
    this.filePath = path.resolve(process.cwd(), filePath);
    this.ensureDbExists();
  }

  private ensureDbExists(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      const initial: DatabaseSchema = { users: {}, chunks: {} };
      fs.writeFileSync(this.filePath, JSON.stringify(initial, null, 2), 'utf8');
    }
  }

  private async readDb(): Promise<DatabaseSchema> {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return { users: {}, chunks: {} };
      }
      if (!parsed.users) {
        parsed.users = {};
        // Migrate legacy flat profile/tasks/attempts if present
        if (parsed.profile || parsed.tasks || parsed.attempts) {
          parsed.users['usr_student_preview'] = {
            profile: parsed.profile,
            tasks: parsed.tasks || [],
            checklist: parsed.checklist ? [parsed.checklist] : [],
            attempts: parsed.attempts || [],
            quotas: {},
            generatedTests: [],
            textbooks: []
          };
        }
      }
      if (!parsed.chunks) {
        parsed.chunks = {};
      }
      return parsed as DatabaseSchema;
    } catch {
      return { users: {}, chunks: {} };
    }
  }

  private async writeDb(data: DatabaseSchema): Promise<void> {
    const tempPath = `${this.filePath}.tmp.${Date.now()}`;
    await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.promises.rename(tempPath, this.filePath);
  }

  private getTodayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private ensureUser(db: DatabaseSchema, userId: string) {
    if (!db.users[userId]) {
      db.users[userId] = {
        tasks: [],
        checklist: [],
        attempts: [],
        quotas: {},
        generatedTests: [],
        textbooks: []
      };
    }
    return db.users[userId];
  }

  // --- User Profile ---
  async getUserProfile(userId: string): Promise<UserProfile | null> {
    const db = await this.readDb();
    return db.users[userId]?.profile || null;
  }

  async saveUserProfile(userId: string, profile: UserProfile): Promise<void> {
    const db = await this.readDb();
    const user = this.ensureUser(db, userId);
    user.profile = profile;
    await this.writeDb(db);
  }

  // --- Tasks & Checklist ---
  async getUserTasks(userId: string): Promise<PlanTask[]> {
    const db = await this.readDb();
    return db.users[userId]?.tasks || [];
  }

  async saveUserTasks(userId: string, tasks: PlanTask[]): Promise<void> {
    const db = await this.readDb();
    const user = this.ensureUser(db, userId);
    user.tasks = tasks;
    await this.writeDb(db);
  }

  async getUserChecklist(userId: string): Promise<ChecklistWeek[]> {
    const db = await this.readDb();
    return db.users[userId]?.checklist || [];
  }

  async saveUserChecklist(userId: string, checklist: ChecklistWeek[]): Promise<void> {
    const db = await this.readDb();
    const user = this.ensureUser(db, userId);
    user.checklist = checklist;
    await this.writeDb(db);
  }

  // --- Attempts ---
  async getUserAttempts(userId: string): Promise<MockAttempt[]> {
    const db = await this.readDb();
    return db.users[userId]?.attempts || [];
  }

  async saveUserAttempt(userId: string, attempt: MockAttempt): Promise<void> {
    const db = await this.readDb();
    const user = this.ensureUser(db, userId);
    if (!user.attempts) user.attempts = [];
    user.attempts.push(attempt);
    await this.writeDb(db);
  }

  // --- Generated Tests & Anti-Repeat ---
  async recordGeneratedTest(userId: string, test: GeneratedTestRecord): Promise<void> {
    const db = await this.readDb();
    const user = this.ensureUser(db, userId);
    if (!user.generatedTests) user.generatedTests = [];
    user.generatedTests.unshift(test); // newest first
    // Keep max 50 recent tests in storage to prevent bloat
    if (user.generatedTests.length > 50) {
      user.generatedTests = user.generatedTests.slice(0, 50);
    }
    await this.writeDb(db);
  }

  async getRecentGenerations(userId: string, limit = 20): Promise<GeneratedTestRecord[]> {
    const db = await this.readDb();
    const tests = db.users[userId]?.generatedTests || [];
    return tests.slice(0, limit);
  }

  async getGeneratedTestById(userId: string, testId: string): Promise<GeneratedTestRecord | null> {
    const db = await this.readDb();
    const tests = db.users[userId]?.generatedTests || [];
    return tests.find(t => t.id === testId) || null;
  }

  // --- Quotas & Rate-Limiting ---
  async getDailyQuota(userId: string): Promise<DailyQuota> {
    const db = await this.readDb();
    const today = this.getTodayStr();
    const userQuotas = db.users[userId]?.quotas || {};
    const todayQuota = userQuotas[today] || { generationsCount: 0, uploadsCount: 0 };
    return {
      dateStr: today,
      generationsCount: todayQuota.generationsCount,
      uploadsCount: todayQuota.uploadsCount
    };
  }

  async incrementGenerationCount(userId: string): Promise<DailyQuota> {
    const db = await this.readDb();
    const user = this.ensureUser(db, userId);
    const today = this.getTodayStr();
    if (!user.quotas) user.quotas = {};
    if (!user.quotas[today]) {
      user.quotas[today] = { generationsCount: 0, uploadsCount: 0 };
    }
    user.quotas[today].generationsCount += 1;
    await this.writeDb(db);
    return {
      dateStr: today,
      generationsCount: user.quotas[today].generationsCount,
      uploadsCount: user.quotas[today].uploadsCount
    };
  }

  async incrementUploadCount(userId: string): Promise<DailyQuota> {
    const db = await this.readDb();
    const user = this.ensureUser(db, userId);
    const today = this.getTodayStr();
    if (!user.quotas) user.quotas = {};
    if (!user.quotas[today]) {
      user.quotas[today] = { generationsCount: 0, uploadsCount: 0 };
    }
    user.quotas[today].uploadsCount += 1;
    await this.writeDb(db);
    return {
      dateStr: today,
      generationsCount: user.quotas[today].generationsCount,
      uploadsCount: user.quotas[today].uploadsCount
    };
  }

  // --- Textbooks & Chunks ---
  async saveTextbook(textbook: StoredTextbook): Promise<void> {
    const db = await this.readDb();
    const user = this.ensureUser(db, textbook.userId);
    if (!user.textbooks) user.textbooks = [];
    const idx = user.textbooks.findIndex(t => t.id === textbook.id);
    if (idx >= 0) {
      user.textbooks[idx] = textbook;
    } else {
      user.textbooks.push(textbook);
    }
    await this.writeDb(db);
  }

  async getTextbook(userId: string, textbookId: string): Promise<StoredTextbook | null> {
    const db = await this.readDb();
    const textbooks = db.users[userId]?.textbooks || [];
    return textbooks.find(t => t.id === textbookId) || null;
  }

  async listUserTextbooks(userId: string): Promise<StoredTextbookSummary[]> {
    const db = await this.readDb();
    const textbooks = db.users[userId]?.textbooks || [];
    return textbooks.map(t => {
      const { tableOfContents, ...summary } = t;
      return {
        ...summary,
        unitCount: tableOfContents ? tableOfContents.length : 0
      };
    });
  }

  async deleteTextbook(userId: string, textbookId: string): Promise<void> {
    const db = await this.readDb();
    const user = this.ensureUser(db, userId);
    if (user.textbooks) {
      user.textbooks = user.textbooks.filter(t => t.id !== textbookId);
    }
    delete db.chunks[textbookId];
    await this.writeDb(db);
  }

  async saveTextbookChunks(textbookId: string, chunks: TextbookChunk[]): Promise<void> {
    const db = await this.readDb();
    db.chunks[textbookId] = chunks;
    await this.writeDb(db);
  }

  async getTextbookChunks(textbookId: string): Promise<TextbookChunk[]> {
    const db = await this.readDb();
    return db.chunks[textbookId] || [];
  }
}
