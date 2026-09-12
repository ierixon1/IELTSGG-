import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { UserProfile, MockAttempt, PlanTask, ChecklistWeek, VocabCard } from '../../types';
import type { ExamSessionRecord } from '../../types/examSession';
import { getFirestoreDb } from '../firebaseAdmin';
import { DataStore, DailyQuota } from './DataStore';
import { GeneratedTestRecord } from './types';

function assertUserId(userId:string){if(!/^[A-Za-z0-9_-]{1,128}$/.test(userId))throw new Error('Invalid user identifier.');}
/** Exam session ids are attempt ids: `attempt-` and a UUID. */
function assertSessionId(id:string){if(!/^attempt-[A-Za-z0-9-]{8,64}$/.test(id))throw new Error('Invalid exam session identifier.');}
/**
 * Progress is stored as one JSON string. It is written after every answer and
 * read back whole, never queried; a string keeps the document free of the
 * nested arrays and `undefined` values Firestore refuses in a map.
 */
type StoredExamSession=Omit<ExamSessionRecord,'progress'>&{progress:string};
const toStoredSession=(record:ExamSessionRecord):StoredExamSession=>JSON.parse(JSON.stringify({...record,progress:JSON.stringify(record.progress)}));
const fromStoredSession=(stored:StoredExamSession):ExamSessionRecord=>({...stored,progress:JSON.parse(stored.progress)});
export class FirestoreDataStore implements DataStore{
 /** Resolved on use, so the shared app (or a test instance) is the only Firestore this store ever talks to. */
 private get db():Firestore{return getFirestoreDb();}
 private userRef(userId:string){assertUserId(userId);return this.db.collection('users').doc(userId);} private subRef(userId:string,c:string){return this.userRef(userId).collection(c);} private quotaRef(userId:string,date:string){return this.subRef(userId,'quotas').doc(date);}
 async getUserProfile(userId:string):Promise<UserProfile|null>{const s=await this.userRef(userId).get();return s.exists?(s.data()?.profile as UserProfile)||null:null;}
 /**
  * The user document can hold more than the profile, so only the two fields written
  * here are replaced — and `profile` is replaced whole. A merge would keep an exam
  * date or a name the learner cleared, where the local store writes the profile
  * afresh (H5).
  */
 async saveUserProfile(userId:string,profile:UserProfile){await this.userRef(userId).set({profile:{...profile,id:userId},updatedAt:FieldValue.serverTimestamp()},{mergeFields:['profile','updatedAt']});}
 async getUserTasks(userId:string):Promise<PlanTask[]>{const s=await this.subRef(userId,'tasks').get();return s.docs.sort((a,b)=>a.id.localeCompare(b.id)).map(d=>d.data() as PlanTask);}
 async saveUserTasks(userId:string,tasks:PlanTask[]){const c=this.subRef(userId,'tasks');const keep=new Map(tasks.map(t=>[t.id,t]));await this.db.runTransaction(async tx=>{const old=await tx.get(c);old.docs.filter(d=>!keep.has(d.id)).forEach(d=>tx.delete(d.ref));tasks.forEach(t=>{if(!t?.id||typeof t.id!=='string'||t.id.length>128)throw new Error('Invalid task identifier.');tx.set(c.doc(t.id),t);});});}
 async getUserChecklist(userId:string):Promise<ChecklistWeek[]>{const s=await this.subRef(userId,'checklist').get();return s.docs.sort((a,b)=>a.id.localeCompare(b.id)).map(d=>d.data() as ChecklistWeek);}
 async saveUserChecklist(userId:string,checklist:ChecklistWeek[]){const c=this.subRef(userId,'checklist');const keep=new Map(checklist.map(x=>[String(x.weekNumber),x]));await this.db.runTransaction(async tx=>{const old=await tx.get(c);old.docs.filter(d=>!keep.has(d.id)).forEach(d=>tx.delete(d.ref));checklist.forEach(x=>{const id=String(x.weekNumber);if(!/^-?\d+$/.test(id)||id.length>12)throw new Error('Invalid checklist week identifier.');tx.set(c.doc(id),x);});});}
 async getUserAttempts(userId:string):Promise<MockAttempt[]>{const s=await this.subRef(userId,'attempts').get();return s.docs.map(d=>d.data() as MockAttempt);}
 async saveUserAttempt(userId:string,attempt:MockAttempt){assertUserId(userId);if(!attempt?.id||typeof attempt.id!=='string'||attempt.id.length>128)throw new Error('Invalid attempt identifier.');await this.subRef(userId,'attempts').doc(attempt.id).set({...attempt,userId});}
 async getUserVocab(userId:string):Promise<VocabCard[]>{const s=await this.subRef(userId,'vocab').get();return s.docs.map(d=>d.data() as VocabCard);}
 async saveUserVocab(userId:string,cards:VocabCard[]){assertUserId(userId);const c=this.subRef(userId,'vocab');const keep=new Map(cards.map(card=>[card.id,card]));await this.db.runTransaction(async tx=>{const old=await tx.get(c);old.docs.filter(d=>!keep.has(d.id)).forEach(d=>tx.delete(d.ref));cards.forEach(card=>{if(!card?.id||typeof card.id!=='string'||card.id.length>128)throw new Error('Invalid vocabulary card identifier.');tx.set(c.doc(card.id),{...card,userId});});});}
 async recordGeneratedTest(userId:string,test:GeneratedTestRecord){await this.subRef(userId,'generatedTests').doc(test.id).set({...test,userId});}
 async getRecentGenerations(userId:string,limit=20):Promise<GeneratedTestRecord[]>{const n=Math.min(Math.max(Math.floor(limit),1),50),s=await this.subRef(userId,'generatedTests').orderBy('timestamp','desc').limit(n).get();return s.docs.map(d=>d.data() as GeneratedTestRecord);}
 async getGeneratedTestById(userId:string,testId:string){if(!/^[A-Za-z0-9_-]{1,128}$/.test(testId))return null;const s=await this.subRef(userId,'generatedTests').doc(testId).get();return s.exists?s.data() as GeneratedTestRecord:null;}
 async getDailyQuota(userId:string):Promise<DailyQuota>{const date=new Date().toISOString().slice(0,10),s=await this.quotaRef(userId,date).get(),d=s.data()||{};return{dateStr:date,generationsCount:Number(d.generationsCount||0),uploadsCount:Number(d.uploadsCount||0)};}
 async incrementGenerationCount(userId:string):Promise<DailyQuota>{const date=new Date().toISOString().slice(0,10);await this.quotaRef(userId,date).set({generationsCount:FieldValue.increment(1),updatedAt:FieldValue.serverTimestamp()},{merge:true});return this.getDailyQuota(userId);}
 async reserveGeneration(userId:string,maxGenerations:number):Promise<DailyQuota|null>{const date=new Date().toISOString().slice(0,10),ref=this.quotaRef(userId,date);return this.db.runTransaction(async tx=>{const snap=await tx.get(ref),d=snap.data()||{},count=Number(d.generationsCount||0);if(count>=maxGenerations)return null;const next=count+1;tx.set(ref,{generationsCount:next,updatedAt:FieldValue.serverTimestamp()},{merge:true});return{dateStr:date,generationsCount:next,uploadsCount:Number(d.uploadsCount||0)};});}
 async incrementUploadCount(userId:string):Promise<DailyQuota>{const date=new Date().toISOString().slice(0,10);await this.quotaRef(userId,date).set({uploadsCount:FieldValue.increment(1),updatedAt:FieldValue.serverTimestamp()},{merge:true});return this.getDailyQuota(userId);}
 async listExamSessions(userId:string):Promise<ExamSessionRecord[]>{const s=await this.subRef(userId,'examSessions').get();return s.docs.map(d=>fromStoredSession(d.data() as StoredExamSession));}
 async getExamSession(userId:string,id:string):Promise<ExamSessionRecord|null>{assertSessionId(id);const s=await this.subRef(userId,'examSessions').doc(id).get();return s.exists?fromStoredSession(s.data() as StoredExamSession):null;}
 async saveExamSession(userId:string,record:ExamSessionRecord,expectedRevision:number|null):Promise<boolean>{assertSessionId(record.id);if(record.userId!==userId)throw new Error('An exam session belongs to one user.');const ref=this.subRef(userId,'examSessions').doc(record.id);return this.db.runTransaction(async tx=>{const current=await tx.get(ref);const stored=current.exists?(current.data() as StoredExamSession).revision:null;if(stored!==expectedRevision)return false;tx.set(ref,toStoredSession(record));return true;});}
}
