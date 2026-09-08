import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getFirestoreDb } from './firebaseAdmin';

export type AuthRateLimitOperation = 'register' | 'login' | 'forgot_password' | 'reset_password' | 'api_global';
const LIMITS: Record<AuthRateLimitOperation, { windowMs:number; max:number }> = {
  register: { windowMs: 15 * 60 * 1000, max: 10 },
  login: { windowMs: 10 * 60 * 1000, max: 20 },
  forgot_password: { windowMs: 15 * 60 * 1000, max: 5 },
  reset_password: { windowMs: 15 * 60 * 1000, max: 10 },
  api_global: { windowMs: 60 * 1000, max: 120 },
};
const useFirestore=()=>process.env.NODE_ENV==='production'||process.env.STORAGE_BACKEND==='gcs_firestore';
const DATA_DIR=path.join(process.cwd(),'data');
const LOCAL_FILE=path.join(DATA_DIR,'request_rate_limits.json');
const keyHash=(operation:AuthRateLimitOperation,key:string)=>crypto.createHash('sha256').update(`${operation}:${key}`).digest('hex');

class RequestRateLimitService {
  private locks=new Map<string,Promise<void>>();
  constructor(){if(!useFirestore()){if(!fs.existsSync(DATA_DIR))fs.mkdirSync(DATA_DIR,{recursive:true});if(!fs.existsSync(LOCAL_FILE))fs.writeFileSync(LOCAL_FILE,'{}','utf8');}}
  private readLocal():Record<string,{count:number;resetAt:number}>{try{return JSON.parse(fs.readFileSync(LOCAL_FILE,'utf8'));}catch{return {};}}
  private async withLock<T>(key:string,fn:()=>Promise<T>):Promise<T>{const previous=this.locks.get(key)||Promise.resolve();let release!:()=>void;const current=new Promise<void>(r=>{release=r});this.locks.set(key,current);await previous;try{return await fn();}finally{release();if(this.locks.get(key)===current)this.locks.delete(key);}}
  async check(key:string,operation:AuthRateLimitOperation){const limit=LIMITS[operation];if(useFirestore()){const now=Date.now(),bucket=Math.floor(now/limit.windowMs),ref=getFirestoreDb().collection('rate_limits').doc(keyHash(operation,`${key}:${bucket}`));return getFirestoreDb().runTransaction(async tx=>{const snap=await tx.get(ref);const count=Number(snap.data()?.count||0);if(count>=limit.max)return{allowed:false,retryAfterMs:Math.max(0,(bucket+1)*limit.windowMs-now)};tx.set(ref,{count:count+1,operation,updatedAt:now},{merge:true});return{allowed:true,retryAfterMs:0};});}
    return this.withLock(`${operation}:${key}`,async()=>{const now=Date.now(),id=keyHash(operation,key),db=this.readLocal(),entry=db[id];if(!entry||entry.resetAt<=now){db[id]={count:1,resetAt:now+limit.windowMs};fs.writeFileSync(LOCAL_FILE,JSON.stringify(db),'utf8');return{allowed:true,retryAfterMs:0};}if(entry.count>=limit.max)return{allowed:false,retryAfterMs:entry.resetAt-now};entry.count+=1;fs.writeFileSync(LOCAL_FILE,JSON.stringify(db),'utf8');return{allowed:true,retryAfterMs:0};});
  }
}
export const requestRateLimitService=new RequestRateLimitService();
