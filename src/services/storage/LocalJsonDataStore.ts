import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { UserProfile, MockAttempt, PlanTask, ChecklistWeek } from '../../types';
import { DataStore, DailyQuota } from './DataStore';
import { GeneratedTestRecord, StoredTextbook, StoredTextbookSummary, TextbookChunk } from './types';

const DATA_DIR=path.join(process.cwd(),'data');
function assertUserId(userId:string){if(!/^[A-Za-z0-9_-]{1,128}$/.test(userId))throw new Error('Invalid user identifier.');}
export class LocalJsonDataStore implements DataStore{
 private file(userId:string){assertUserId(userId);const dir=path.join(DATA_DIR,'users',userId);if(!fs.existsSync(dir))fs.mkdirSync(dir,{recursive:true});return dir;}
 private read<T>(userId:string,name:string,fallback:T):T{const p=path.join(this.file(userId),name);try{return JSON.parse(fs.readFileSync(p,'utf8')) as T}catch{return fallback;}}
 private write<T>(userId:string,name:string,value:T){const p=path.join(this.file(userId),name),tmp=`${p}.tmp.${process.pid}.${Date.now()}.${nanoid(4)}`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),'utf8');fs.renameSync(tmp,p);}
 async getUserProfile(userId:string){return this.read<UserProfile|null>(userId,'profile.json',null);}
 async saveUserProfile(userId:string,profile:UserProfile){this.write(userId,'profile.json',profile);}
 async getUserTasks(userId:string){return this.read<PlanTask[]>(userId,'tasks.json',[]);}
 async saveUserTasks(userId:string,tasks:PlanTask[]){this.write(userId,'tasks.json',tasks);}
 async getUserChecklist(userId:string){return this.read<ChecklistWeek[]>(userId,'checklist.json',[]);}
 async saveUserChecklist(userId:string,checklist:ChecklistWeek[]){this.write(userId,'checklist.json',checklist);}
 async getUserAttempts(userId:string){return this.read<MockAttempt[]>(userId,'attempts.json',[]);}
 async saveUserAttempt(userId:string,attempt:MockAttempt){const all=await this.getUserAttempts(userId),i=all.findIndex(x=>x.id===attempt.id);if(i>=0)all[i]=attempt;else all.push(attempt);this.write(userId,'attempts.json',all);}
 async recordGeneratedTest(userId:string,test:GeneratedTestRecord){const all=this.read<GeneratedTestRecord[]>(userId,'generatedTests.json',[]);all.unshift(test);this.write(userId,'generatedTests.json',all.slice(0,200));}
 async getRecentGenerations(userId:string,limit=20){return this.read<GeneratedTestRecord[]>(userId,'generatedTests.json',[]).slice(0,Math.min(Math.max(Math.floor(limit),1),50));}
 async getGeneratedTestById(userId:string,testId:string){if(!/^[A-Za-z0-9_-]{1,128}$/.test(testId))return null;return this.read<GeneratedTestRecord[]>(userId,'generatedTests.json',[]).find(x=>x.id===testId)||null;}
 async getDailyQuota(userId:string):Promise<DailyQuota>{const dateStr=new Date().toISOString().slice(0,10);const all=this.read<any>(userId,'quota.json',{});const d=all?.[dateStr]||{};return{dateStr,generationsCount:Number(d.generationsCount||0),uploadsCount:Number(d.uploadsCount||0)};}
 async incrementGenerationCount(userId:string){const q=await this.getDailyQuota(userId),all=this.read<any>(userId,'quota.json',{});all[q.dateStr]={...q,generationsCount:q.generationsCount+1};this.write(userId,'quota.json',all);return this.getDailyQuota(userId);}
 async reserveGeneration(userId:string,maxGenerations:number){const q=await this.getDailyQuota(userId);if(q.generationsCount>=maxGenerations)return null;const all=this.read<any>(userId,'quota.json',{});all[q.dateStr]={...q,generationsCount:q.generationsCount+1};this.write(userId,'quota.json',all);return this.getDailyQuota(userId);}
 async incrementUploadCount(userId:string){const q=await this.getDailyQuota(userId),all=this.read<any>(userId,'quota.json',{});all[q.dateStr]={...q,uploadsCount:q.uploadsCount+1};this.write(userId,'quota.json',all);return this.getDailyQuota(userId);}
 async saveTextbook(textbook:StoredTextbook){const all=this.read<StoredTextbook[]>(textbook.userId,'textbooks.json',[]),i=all.findIndex(x=>x.id===textbook.id);if(i>=0)all[i]=textbook;else all.push(textbook);this.write(textbook.userId,'textbooks.json',all);}
 async getTextbook(userId:string,textbookId:string){return this.read<StoredTextbook[]>(userId,'textbooks.json',[]).find(x=>x.id===textbookId)||null;}
 async listUserTextbooks(userId:string):Promise<StoredTextbookSummary[]>{return (await this.read<StoredTextbook[]>(userId,'textbooks.json',[])).map(v=>{const{tableOfContents,...summary}=v;return{...summary,unitCount:tableOfContents?.length||0};});}
 async deleteTextbook(userId:string,textbookId:string){this.write(userId,'textbooks.json',this.read<StoredTextbook[]>(userId,'textbooks.json',[]).filter(x=>x.id!==textbookId));this.write(userId,`textbook_${textbookId}_chunks.json`,[]);}
 async saveTextbookChunks(userId:string,textbookId:string,chunks:TextbookChunk[]){this.write(userId,`textbook_${textbookId}_chunks.json`,chunks);}
 async getTextbookChunks(userId:string,textbookId:string){return this.read<TextbookChunk[]>(userId,`textbook_${textbookId}_chunks.json`,[]);}
}
