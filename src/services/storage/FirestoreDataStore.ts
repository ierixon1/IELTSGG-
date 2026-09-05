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
    if (projectId && clientEmail && privateKey) initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
    else if (projectId) initializeApp({ projectId, credential: applicationDefault() });
    else initializeApp({ credential: applicationDefault() });
  }
  return getFirestore();
}

function assertUserId(userId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error('Invalid user identifier.');
}

export class FirestoreDataStore implements DataStore {
  private readonly db: Firestore;
  constructor() { this.db = initFirestore(); }
  private userRef(userId: string) { assertUserId(userId); return this.db.collection('users').doc(userId); }
  private subRef(userId: string, collection: string) { return this.userRef(userId).collection(collection); }

  async getUserProfile(userId: string): Promise<UserProfile | null> { const snap = await this.userRef(userId).get(); return snap.exists ? ((snap.data()?.profile as UserProfile) || null) : null; }
  async saveUserProfile(userId: string, profile: UserProfile): Promise<void> { await this.userRef(userId).set({ profile: { ...profile, id: userId }, updatedAt: FieldValue.serverTimestamp() }, { merge: true }); }
  async getUserTasks(userId: string): Promise<PlanTask[]> { const snap = await this.subRef(userId, 'tasks').get(); return snap.docs.sort((a,b) => a.id.localeCompare(b.id)).map(d => d.data() as PlanTask); }
  async saveUserTasks(userId: string, tasks: PlanTask[]): Promise<void> { const c = this.subRef(userId, 'tasks'); const old = await c.get(); const keep = new Set(tasks.map(t => t.id)); const b = this.db.batch(); old.docs.filter(d => !keep.has(d.id)).forEach(d => b.delete(d.ref)); tasks.forEach(t => b.set(c.doc(t.id), t)); await b.commit(); }
  async getUserChecklist(userId: string): Promise<ChecklistWeek[]> { const snap = await this.subRef(userId, 'checklist').get(); return snap.docs.sort((a,b) => a.id.localeCompare(b.id)).map(d => d.data() as ChecklistWeek); }
  async saveUserChecklist(userId: string, checklist: ChecklistWeek[]): Promise<void> { const c = this.subRef(userId, 'checklist'); const old = await c.get(); const keep = new Set(checklist.map(x => String(x.weekNumber))); const b = this.db.batch(); old.docs.filter(d => !keep.has(d.id)).forEach(d => b.delete(d.ref)); checklist.forEach(x => b.set(c.doc(String(x.weekNumber)), x)); await b.commit(); }
  async getUserAttempts(userId: string): Promise<MockAttempt[]> { const snap = await this.subRef(userId, 'attempts').get(); return snap.docs.map(d => d.data() as MockAttempt); }
  async saveUserAttempt(userId: string, attempt: MockAttempt): Promise<void> { await this.subRef(userId, 'attempts').doc(attempt.id).set(attempt); }
  async recordGeneratedTest(userId: string, test: GeneratedTestRecord): Promise<void> { await this.subRef(userId, 'generatedTests').doc(test.id).set(test); }
  async getRecentGenerations(userId: string, limit=20): Promise<GeneratedTestRecord[]> { const n=Math.min(Math.max(Math.floor(limit),1),50); const s=await this.subRef(userId,'generatedTests').orderBy('timestamp','desc').limit(n).get(); return s.docs.map(d=>d.data() as GeneratedTestRecord); }
  async getGeneratedTestById(userId:string,testId:string):Promise<GeneratedTestRecord|null>{const s=await this.subRef(userId,'generatedTests').doc(testId).get(); return s.exists ? s.data() as GeneratedTestRecord : null;}
  private quotaRef(userId:string,dateStr:string){return this.subRef(userId,'quotas').doc(dateStr);}
  async getDailyQuota(userId:string):Promise<DailyQuota>{const dateStr=new Date().toISOString().slice(0,10); const s=await this.quotaRef(userId,dateStr).get(); const d=s.data()||{}; return {dateStr,generationsCount:Number(d.generationsCount||0),uploadsCount:Number(d.uploadsCount||0)};}
  async incrementGenerationCount(userId:string):Promise<DailyQuota>{const d=new Date().toISOString().slice(0,10); const r=this.quotaRef(userId,d); await r.set({generationsCount:FieldValue.increment(1),updatedAt:FieldValue.serverTimestamp()},{merge:true}); return this.getDailyQuota(userId);}
  async incrementUploadCount(userId:string):Promise<DailyQuota>{const d=new Date().toISOString().slice(0,10); const r=this.quotaRef(userId,d); await r.set({uploadsCount:FieldValue.increment(1),updatedAt:FieldValue.serverTimestamp()},{merge:true}); return this.getDailyQuota(userId);}
  async saveTextbook(textbook:StoredTextbook):Promise<void>{await this.subRef(textbook.userId,'textbooks').doc(textbook.id).set(textbook);}
  async getTextbook(userId:string,textbookId:string):Promise<StoredTextbook|null>{const s=await this.subRef(userId,'textbooks').doc(textbookId).get(); return s.exists?s.data() as StoredTextbook:null;}
  async listUserTextbooks(userId:string):Promise<StoredTextbookSummary[]>{const s=await this.subRef(userId,'textbooks').get(); return s.docs.map(d=>{const v=d.data() as StoredTextbook; const {tableOfContents,...summary}=v; return {...summary,unitCount:tableOfContents?.length||0};});}
  async deleteTextbook(userId:string,textbookId:string):Promise<void>{await this.subRef(userId,'textbooks').doc(textbookId).delete(); const c=await this.subRef(userId,'textbooks').doc(textbookId).collection('chunks').get(); if(!c.empty){const b=this.db.batch(); c.docs.forEach(d=>b.delete(d.ref)); await b.commit();}}
  async saveTextbookChunks(userId:string,textbookId:string,chunks:TextbookChunk[]):Promise<void>{const c=this.subRef(userId,'textbooks').doc(textbookId).collection('chunks'); const old=await c.get(); const b=this.db.batch(); old.docs.forEach(d=>b.delete(d.ref)); chunks.forEach(x=>b.set(c.doc(x.id),x)); await b.commit();}
  async getTextbookChunks(userId:string,textbookId:string):Promise<TextbookChunk[]>{const s=await this.subRef(userId,'textbooks').doc(textbookId).collection('chunks').orderBy('id').get(); return s.docs.map(d=>d.data() as TextbookChunk);}
}
