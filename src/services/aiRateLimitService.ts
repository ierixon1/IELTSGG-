import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';

export type AiOperationType = 'writing_grade' | 'speaking_grade' | 'mock_generation' | 'preppy_chat';
export interface AiUsageRecord { id:string; userId:string; timestamp:string; operation:AiOperationType; model:string; wordCount?:number; durationMs?:number; success:boolean; notes?:string; }
export interface AiQuotaLimits { daily:number; hourly:number; }
export const AI_OPERATION_LIMITS: Record<AiOperationType,AiQuotaLimits> = {
  writing_grade:{daily:10,hourly:4}, speaking_grade:{daily:10,hourly:4}, mock_generation:{daily:10,hourly:3}, preppy_chat:{daily:30,hourly:10},
};
const DATA_DIR=path.join(process.cwd(),'data');
const USAGE_LOG_FILE=path.join(DATA_DIR,'ai_usage_log.json');

class AiRateLimitService {
  constructor(){ this.ensureFile(); }
  private ensureFile(){ if(!fs.existsSync(DATA_DIR))fs.mkdirSync(DATA_DIR,{recursive:true}); if(!fs.existsSync(USAGE_LOG_FILE))fs.writeFileSync(USAGE_LOG_FILE,'[]','utf8'); }
  private readLogs():AiUsageRecord[]{try{const x=JSON.parse(fs.readFileSync(USAGE_LOG_FILE,'utf8'));return Array.isArray(x)?x:[];}catch{return[];}}
  private appendLog(record:AiUsageRecord){const logs=this.readLogs();logs.push(record);if(logs.length>5000)logs.splice(0,logs.length-5000);const t=`${USAGE_LOG_FILE}.tmp.${process.pid}.${Date.now()}`;fs.writeFileSync(t,JSON.stringify(logs),'utf8');fs.renameSync(t,USAGE_LOG_FILE);}
  public checkLimit(userId:string,operation:AiOperationType){
    const limits=AI_OPERATION_LIMITS[operation]; const now=Date.now(); const today=new Date().toISOString().slice(0,10); const oneHour=now-3600000;
    const logs=this.readLogs().filter(l=>l.userId===userId&&l.operation===operation&&l.success);
    const currentDaily=logs.filter(l=>l.timestamp.startsWith(today)).length; const currentHourly=logs.filter(l=>new Date(l.timestamp).getTime()>oneHour).length;
    if(currentHourly>=limits.hourly)return{allowed:false,reason:`Hourly AI limit reached (${limits.hourly}).`,currentDaily,maxDaily:limits.daily,currentHourly,maxHourly:limits.hourly};
    if(currentDaily>=limits.daily)return{allowed:false,reason:`Daily AI limit reached (${limits.daily}).`,currentDaily,maxDaily:limits.daily,currentHourly,maxHourly:limits.hourly};
    return{allowed:true,currentDaily,maxDaily:limits.daily,currentHourly,maxHourly:limits.hourly};
  }
  public recordUsage(params:{userId:string;operation:AiOperationType;model:string;wordCount?:number;durationMs?:number;success:boolean;notes?:string}){this.appendLog({id:`ai_${Date.now()}_${nanoid(6)}`,timestamp:new Date().toISOString(),...params});}
  public getUsageLogs(options?:{userId?:string;operation?:AiOperationType;limit?:number}){
    let logs=this.readLogs(); if(options?.userId)logs=logs.filter(x=>x.userId===options.userId); if(options?.operation)logs=logs.filter(x=>x.operation===options.operation);
    const summary:Record<string,number>={}; for(const l of logs){summary[l.operation]=(summary[l.operation]||0)+1;summary[`user_${l.userId}`]=(summary[`user_${l.userId}`]||0)+1;}
    logs.sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp)); return{records:logs.slice(0,Math.min(Math.max(options?.limit||100,1),500)),summary};
  }
}
export const aiRateLimitService=new AiRateLimitService();
