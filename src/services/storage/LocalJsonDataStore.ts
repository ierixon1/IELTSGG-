import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { UserProfile, MockAttempt, PlanTask, ChecklistWeek, VocabCard } from '../../types';
import type { ExamSessionRecord } from '../../types/examSession';
import { DataStore, DailyQuota } from './DataStore';
import { GeneratedTestRecord } from './types';

const DATA_DIR=path.join(process.cwd(),'data');
function assertUserId(userId:string){if(!/^[A-Za-z0-9_-]{1,128}$/.test(userId))throw new Error('Invalid user identifier.');}
export class LocalJsonDataStore implements DataStore{
 private locks=new Map<string,Promise<void>>();
 private file(userId:string){assertUserId(userId);const dir=path.join(DATA_DIR,'users',userId);if(!fs.existsSync(dir))fs.mkdirSync(dir,{recursive:true});return dir;}
 private read<T>(userId:string,name:string,fallback:T):T{const p=path.join(this.file(userId),name);try{return JSON.parse(fs.readFileSync(p,'utf8')) as T}catch{return fallback;}}
 private write<T>(userId:string,name:string,value:T){const p=path.join(this.file(userId),name),tmp=`${p}.tmp.${process.pid}.${Date.now()}.${nanoid(4)}`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),'utf8');fs.renameSync(tmp,p);}
 private async withLock<T>(key:string,fn:()=>Promise<T>):Promise<T>{const previous=this.locks.get(key)||Promise.resolve();let release!:()=>void;const current=new Promise<void>(r=>{release=r});this.locks.set(key,current);await previous;try{return await fn();}finally{release();if(this.locks.get(key)===current)this.locks.delete(key);}}
 async getUserProfile(userId:string){return this.read<UserProfile|null>(userId,'profile.json',null);}
 async saveUserProfile(userId:string,profile:UserProfile){this.write(userId,'profile.json',profile);}
 async getUserTasks(userId:string){return this.read<PlanTask[]>(userId,'tasks.json',[]);}
 async saveUserTasks(userId:string,tasks:PlanTask[]){this.write(userId,'tasks.json',tasks);}
 async getUserChecklist(userId:string){return this.read<ChecklistWeek[]>(userId,'checklist.json',[]);}
 async saveUserChecklist(userId:string,checklist:ChecklistWeek[]){this.write(userId,'checklist.json',checklist);}
 async getUserAttempts(userId:string){return this.read<MockAttempt[]>(userId,'attempts.json',[]);}
 async saveUserAttempt(userId:string,attempt:MockAttempt){await this.withLock(`${userId}:attempts`,async()=>{const all=await this.getUserAttempts(userId),i=all.findIndex(x=>x.id===attempt.id);if(i>=0)all[i]=attempt;else all.push(attempt);this.write(userId,'attempts.json',all);});}
 async getUserVocab(userId:string){return this.read<VocabCard[]>(userId,'vocab.json',[]);}
 async saveUserVocab(userId:string,cards:VocabCard[]){await this.withLock(`${userId}:vocab`,async()=>{this.write(userId,'vocab.json',cards);});}
 async recordGeneratedTest(userId:string,test:GeneratedTestRecord){await this.withLock(`${userId}:generatedTests`,async()=>{const all=this.read<GeneratedTestRecord[]>(userId,'generatedTests.json',[]);all.unshift(test);this.write(userId,'generatedTests.json',all.slice(0,200));});}
 async getRecentGenerations(userId:string,limit=20){return this.read<GeneratedTestRecord[]>(userId,'generatedTests.json',[]).slice(0,Math.min(Math.max(Math.floor(limit),1),50));}
 async getGeneratedTestById(userId:string,testId:string){if(!/^[A-Za-z0-9_-]{1,128}$/.test(testId))return null;return this.read<GeneratedTestRecord[]>(userId,'generatedTests.json',[]).find(x=>x.id===testId)||null;}
 async getDailyQuota(userId:string):Promise<DailyQuota>{const dateStr=new Date().toISOString().slice(0,10);const all=this.read<any>(userId,'quota.json',{});const d=all?.[dateStr]||{};return{dateStr,generationsCount:Number(d.generationsCount||0),uploadsCount:Number(d.uploadsCount||0)};}
 async incrementGenerationCount(userId:string){return this.withLock(`${userId}:quota`,async()=>{const q=await this.getDailyQuota(userId),all=this.read<any>(userId,'quota.json',{});all[q.dateStr]={...q,generationsCount:q.generationsCount+1};this.write(userId,'quota.json',all);return this.getDailyQuota(userId);});}
 async reserveGeneration(userId:string,maxGenerations:number){return this.withLock(`${userId}:quota`,async()=>{const q=await this.getDailyQuota(userId);if(q.generationsCount>=maxGenerations)return null;const all=this.read<any>(userId,'quota.json',{});all[q.dateStr]={...q,generationsCount:q.generationsCount+1};this.write(userId,'quota.json',all);return this.getDailyQuota(userId);});}
 async incrementUploadCount(userId:string){return this.withLock(`${userId}:quota`,async()=>{const q=await this.getDailyQuota(userId),all=this.read<any>(userId,'quota.json',{});all[q.dateStr]={...q,uploadsCount:q.uploadsCount+1};this.write(userId,'quota.json',all);return this.getDailyQuota(userId);});}
 async listExamSessions(userId:string){return this.read<ExamSessionRecord[]>(userId,'examSessions.json',[]);}
 async getExamSession(userId:string,id:string){return (await this.listExamSessions(userId)).find(x=>x.id===id)||null;}
 async saveExamSession(userId:string,record:ExamSessionRecord,expectedRevision:number|null){if(record.userId!==userId)throw new Error('An exam session belongs to one user.');return this.withLock(`${userId}:examSessions`,async()=>{const all=await this.listExamSessions(userId),i=all.findIndex(x=>x.id===record.id),stored=i>=0?all[i].revision:null;if(stored!==expectedRevision)return false;if(i>=0)all[i]=record;else all.push(record);this.write(userId,'examSessions.json',all);return true;});}
}
