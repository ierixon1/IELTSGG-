import { getApps, initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Firestore } from 'firebase-admin/firestore';
import { UserProfile, MockAttempt, PlanTask, ChecklistWeek } from '../../types';
import { DataStore, DailyQuota } from './DataStore';
import { GeneratedTestRecord, StoredTextbook, StoredTextbookSummary, TextbookChunk } from './types';

function initFirestore(): Firestore {
  if (!getApps().length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (projectId && clientEmail && privateKey) {
      initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
    } else if (projectId) {
      initializeApp({ projectId, credential: applicationDefault() });
    } else {
      initializeApp({ credential: applicationDefault() });
    }
  }
  return getFirestore();
}

export class FirestoreDataStore implements DataStore {
  private readonly db: Firestore;

  constructor() {
    this.db = initFirestore();
  }

  private userRef(userId: string) {
    return this.db.collection('users').doc(userId);
  }

  private subRef(userId: string, collection: string) {
    return this.userRef(userId).collection(collection);
  }

  async getUserProfile(userId: string): Promise<UserProfile | null> {
    const snap = await this.userRef(userId).get();
    return snap.exists ? ((snap.data()?.profile as UserProfile) || null) : null;
  }

  async saveUserProfile(userId: string, profile: UserProfile): Promise<void> {
    await this.userRef(userId).set({ profile: { ...profile, id: userId }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  async getUserTasks(userId: string): Promise<PlanTask[]> {
    const snap = await this.subRef(userId, 'tasks').get();
    return snap.docs.sort((a, b) => a.id.localeCompare(b.id)).map(d => d.data() as PlanTask);
  }

  async saveUserTasks(userId: string, tasks: PlanTask[]): Promise<void> {
    const batch = this.db.batch();
    const collection = this.subRef(userId, 'tasks');
    const existing = await collection.get();
    const nextIds = new Set(tasks.map(t => t.id));
    for (const doc of existing.docs) if (!nextIds.has(doc.id)) batch.delete(doc.ref);
    for (const task of tasks) batch.set(collection.doc(task.id), task);
    await batch.commit();
  }

  async getUserChecklist(userId: string): Promise<ChecklistWeek[]> {
    const snap = await this.subRef(userId, 'checklist').get();
    return snap.docs.sort((a, b) => a.id.localeCompare(b.id)).map(d => d.data() as ChecklistWeek);
  }

  async saveUserChecklist(userId: string, checklist: ChecklistWeek[]): Promise<void> {
    const batch = this.db.batch();
    const collection = this.subRef(userId, 'checklist');
    const existing = await collection.get();
    const nextIds = new Set(checklist.map(c => String(c.weekNumber)));
    for (const doc of existing.docs) if (!nextIds.has(doc.id)) batch.delete(doc.ref);
    for (const item of checklist) batch.set(collection.doc(String(item.weekNumber)), item);
    await batch.commit();
  }

  async getUserAttempts(userId: string): Promise<MockAttempt[]> {
    const snap = await this.subRef(userId, 'attempts').get();
    return snap.docs.sort((a, b) => a.id.localeCompare(b.id)).map(d => d.data() as MockAttempt);
  }

  async saveUserAttempt(userId: string, attempt: MockAttempt): Promise<void> {
    await this.subRef(userId, 'attempts').doc(attempt.id).set(attempt);
  }

  async recordGeneratedTest(userId: string, test: GeneratedTestRecord): Promise<void> {
    await this.subRef(userId, 'generatedTests').doc(test.id).set(test);
    const snap = await this.subRef(userId, 'generatedTests').orderBy('timestamp', 'desc').limit(51).get();
    if (snap.size > 50) {
      await snap.docs[snap.docs.length - 1].ref.delete();
    }
  }

  async getRecentGenerations(userId: string, limit = 20): Promise<GeneratedTestRecord[]> {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
    const snap = await this.subRef(userId, 'generatedTests').orderBy('timestamp', 'desc').limit(safeLimit).get();
    return snap.docs.map(d => d.data() as GeneratedTestRecord);
  }

  async getGeneratedTestById(userId: string, testId: string): Promise<GeneratedTestRecord | null> {
    const snap = await this.subRef(userId, 'generatedTests').doc(testId).get();
    return snap.exists ? (snap.data() as GeneratedTestRecord) : null;
  }

  private quotaRef(userId: string, dateStr: string) {
    return this.subRef(userId, 'quotas').doc(dateStr);
  }

  async getDailyQuota(userId: string): Promise<DailyQuota> {
    const dateStr = new Date().toISOString().slice(0, 10);
    const snap = await this.quotaRef(userId, dateStr).get();
    const data = snap.data() || {};
    return {
      dateStr,
      generationsCount: Number(data.generationsCount || 0),
      uploadsCount: Number(data.uploadsCount || 0),
    };
  }

  async incrementGenerationCount(userId: string): Promise<DailyQuota> {
    const dateStr = new Date().toISOString().slice(0, 10);
    const ref = this.quotaRef(userId, dateStr);
    await ref.set({ generationsCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return this.getDailyQuota(userId);
  }

  async incrementUploadCount(userId: string): Promise<DailyQuota> {
    const dateStr = new Date().toISOString().slice(0, 10);
    const ref = this.quotaRef(userId, dateStr);
    await ref.set({ uploadsCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return this.getDailyQuota(userId);
  }

  async saveTextbook(textbook: StoredTextbook): Promise<void> {
    await this.subRef(textbook.userId, 'textbooks').doc(textbook.id).set(textbook);
  }

  async getTextbook(userId: string, textbookId: string): Promise<StoredTextbook | null> {
    const snap = await this.subRef(userId, 'textbooks').doc(textbookId).get();
    return snap.exists ? (snap.data() as StoredTextbook) : null;
  }

  async listUserTextbooks(userId: string): Promise<StoredTextbookSummary[]> {
    const snap = await this.subRef(userId, 'textbooks').get();
    return snap.docs.map(d => {
      const value = d.data() as StoredTextbook;
      const { tableOfContents, ...summary } = value;
      return { ...summary, unitCount: tableOfContents?.length || 0 } as StoredTextbookSummary;
    });
  }

  async deleteTextbook(userId: string, textbookId: string): Promise<void> {
    await this.subRef(userId, 'textbooks').doc(textbookId).delete();
    const chunks = await this.subRef(userId, 'textbooks').doc(textbookId).collection('chunks').get();
    if (!chunks.empty) {
      const batch = this.db.batch();
      for (const doc of chunks.docs) batch.delete(doc.ref);
      await batch.commit();
    }
  }

  async saveTextbookChunks(userId: string, textbookId: string, chunks: TextbookChunk[]): Promise<void> {
    const collection = this.subRef(userId, 'textbooks').doc(textbookId).collection('chunks');
    const existing = await collection.get();
    const batch = this.db.batch();
    for (const doc of existing.docs) batch.delete(doc.ref);
    for (const chunk of chunks) batch.set(collection.doc(chunk.id), chunk);
    await batch.commit();
  }

  async getTextbookChunks(userId: string, textbookId: string): Promise<TextbookChunk[]> {
    const snap = await this.subRef(userId, 'textbooks').doc(textbookId).collection('chunks').orderBy('id').get();
    return snap.docs.map(d => d.data() as TextbookChunk);
  }
}
