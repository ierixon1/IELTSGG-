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
    quotas?: Record<string, { generationsCount: number; uploadsCount: number }>;
    generatedTests?: GeneratedTestRecord[];
    textbooks?: StoredTextbook[];
  }>;
  chunks: Record<string, Record<string, TextbookChunk[]>>;
}

export class LocalJsonDataStore implements DataStore {
  private filePath: string;
  constructor(filePath = 'data/db.json') { this.filePath = path.resolve(process.cwd(), filePath); this.ensureDbExists(); }
  private ensureDbExists(): void {
    const dir = path.dirname(this.filePath); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, JSON.stringify({ users: {}, chunks: {} }, null, 2), 'utf8');
  }
  private async readDb(): Promise<DatabaseSchema> {
    try { const parsed = JSON.parse(await fs.promises.readFile(this.filePath, 'utf8')); return { users: parsed?.users || {}, chunks: parsed?.chunks || {} } as DatabaseSchema; }
    catch { return { users: {}, chunks: {} }; }
  }
  private async writeDb(data: DatabaseSchema): Promise<void> {
    const tempPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.promises.rename(tempPath, this.filePath);
  }
  private getTodayStr(): string { return new Date().toISOString().slice(0, 10); }
  private ensureUser(db: DatabaseSchema, userId: string) {
    if (!db.users[userId]) db.users[userId] = { tasks: [], checklist: [], attempts: [], quotas: {}, generatedTests: [], textbooks: [] };
    return db.users[userId];
  }
  async getUserProfile(userId: string): Promise<UserProfile | null> { const db = await this.readDb(); return db.users[userId]?.profile || null; }
  async saveUserProfile(userId: string, profile: UserProfile): Promise<void> { const db = await this.readDb(); this.ensureUser(db, userId).profile = profile; await this.writeDb(db); }
  async getUserTasks(userId: string): Promise<PlanTask[]> { const db = await this.readDb(); return db.users[userId]?.tasks || []; }
  async saveUserTasks(userId: string, tasks: PlanTask[]): Promise<void> { const db = await this.readDb(); this.ensureUser(db, userId).tasks = tasks; await this.writeDb(db); }
  async getUserChecklist(userId: string): Promise<ChecklistWeek[]> { const db = await this.readDb(); return db.users[userId]?.checklist || []; }
  async saveUserChecklist(userId: string, checklist: ChecklistWeek[]): Promise<void> { const db = await this.readDb(); this.ensureUser(db, userId).checklist = checklist; await this.writeDb(db); }
  async getUserAttempts(userId: string): Promise<MockAttempt[]> { const db = await this.readDb(); return db.users[userId]?.attempts || []; }
  async saveUserAttempt(userId: string, attempt: MockAttempt): Promise<void> { const db = await this.readDb(); const user = this.ensureUser(db, userId); user.attempts ||= []; user.attempts.push(attempt); await this.writeDb(db); }
  async recordGeneratedTest(userId: string, test: GeneratedTestRecord): Promise<void> { const db = await this.readDb(); const user = this.ensureUser(db, userId); user.generatedTests ||= []; user.generatedTests.unshift(test); user.generatedTests = user.generatedTests.slice(0, 50); await this.writeDb(db); }
  async getRecentGenerations(userId: string, limit = 20): Promise<GeneratedTestRecord[]> { const db = await this.readDb(); return (db.users[userId]?.generatedTests || []).slice(0, Math.min(Math.max(Math.floor(limit), 1), 50)); }
  async getGeneratedTestById(userId: string, testId: string): Promise<GeneratedTestRecord | null> { const db = await this.readDb(); return (db.users[userId]?.generatedTests || []).find(t => t.id === testId) || null; }
  async getDailyQuota(userId: string): Promise<DailyQuota> { const db = await this.readDb(); const dateStr = this.getTodayStr(); const q = db.users[userId]?.quotas?.[dateStr] || { generationsCount: 0, uploadsCount: 0 }; return { dateStr, ...q }; }
  async incrementGenerationCount(userId: string): Promise<DailyQuota> { const db = await this.readDb(); const user = this.ensureUser(db, userId); const d = this.getTodayStr(); user.quotas ||= {}; user.quotas[d] ||= { generationsCount: 0, uploadsCount: 0 }; user.quotas[d].generationsCount += 1; await this.writeDb(db); return { dateStr: d, ...user.quotas[d] }; }
  async incrementUploadCount(userId: string): Promise<DailyQuota> { const db = await this.readDb(); const user = this.ensureUser(db, userId); const d = this.getTodayStr(); user.quotas ||= {}; user.quotas[d] ||= { generationsCount: 0, uploadsCount: 0 }; user.quotas[d].uploadsCount += 1; await this.writeDb(db); return { dateStr: d, ...user.quotas[d] }; }
  async saveTextbook(textbook: StoredTextbook): Promise<void> { const db = await this.readDb(); const user = this.ensureUser(db, textbook.userId); user.textbooks ||= []; const i = user.textbooks.findIndex(t => t.id === textbook.id); if (i >= 0) user.textbooks[i] = textbook; else user.textbooks.push(textbook); await this.writeDb(db); }
  async getTextbook(userId: string, textbookId: string): Promise<StoredTextbook | null> { const db = await this.readDb(); return (db.users[userId]?.textbooks || []).find(t => t.id === textbookId) || null; }
  async listUserTextbooks(userId: string): Promise<StoredTextbookSummary[]> { const db = await this.readDb(); return (db.users[userId]?.textbooks || []).map(t => { const { tableOfContents, ...summary } = t; return { ...summary, unitCount: tableOfContents?.length || 0 }; }); }
  async deleteTextbook(userId: string, textbookId: string): Promise<void> { const db = await this.readDb(); const user = this.ensureUser(db, userId); user.textbooks = (user.textbooks || []).filter(t => t.id !== textbookId); delete db.chunks[userId]?.[textbookId]; await this.writeDb(db); }
  async saveTextbookChunks(userId: string, textbookId: string, chunks: TextbookChunk[]): Promise<void> { const db = await this.readDb(); db.chunks[userId] ||= {}; db.chunks[userId][textbookId] = chunks; await this.writeDb(db); }
  async getTextbookChunks(userId: string, textbookId: string): Promise<TextbookChunk[]> { const db = await this.readDb(); return db.chunks[userId]?.[textbookId] || []; }
}
