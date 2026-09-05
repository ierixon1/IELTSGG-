import { UserProfile, MockAttempt, PlanTask, ChecklistWeek } from '../../types';
import { GeneratedTestRecord, StoredTextbook, StoredTextbookSummary, TextbookChunk } from './types';
export interface DailyQuota { dateStr:string; generationsCount:number; uploadsCount:number; }
export interface DataStore {
 getUserProfile(userId:string):Promise<UserProfile|null>; saveUserProfile(userId:string,profile:UserProfile):Promise<void>;
 getUserTasks(userId:string):Promise<PlanTask[]>; saveUserTasks(userId:string,tasks:PlanTask[]):Promise<void>;
 getUserChecklist(userId:string):Promise<ChecklistWeek[]>; saveUserChecklist(userId:string,checklist:ChecklistWeek[]):Promise<void>;
 getUserAttempts(userId:string):Promise<MockAttempt[]>; saveUserAttempt(userId:string,attempt:MockAttempt):Promise<void>;
 recordGeneratedTest(userId:string,test:GeneratedTestRecord):Promise<void>; getRecentGenerations(userId:string,limit?:number):Promise<GeneratedTestRecord[]>; getGeneratedTestById(userId:string,testId:string):Promise<GeneratedTestRecord|null>;
 getDailyQuota(userId:string):Promise<DailyQuota>; incrementGenerationCount(userId:string):Promise<DailyQuota>; reserveGeneration(userId:string,maxGenerations:number):Promise<DailyQuota|null>; incrementUploadCount(userId:string):Promise<DailyQuota>;
 saveTextbook(textbook:StoredTextbook):Promise<void>; getTextbook(userId:string,textbookId:string):Promise<StoredTextbook|null>; listUserTextbooks(userId:string):Promise<StoredTextbookSummary[]>; deleteTextbook(userId:string,textbookId:string):Promise<void>; saveTextbookChunks(userId:string,textbookId:string,chunks:TextbookChunk[]):Promise<void>; getTextbookChunks(userId:string,textbookId:string):Promise<TextbookChunk[]>;
}
