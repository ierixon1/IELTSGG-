import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { getFirestoreDb } from './firebaseAdmin';

export type AiOperationType = 'writing_grade' | 'speaking_grade' | 'mock_generation' | 'preppy_chat' | 'ai_request';
export interface AiUsageRecord { id: string; userId: string; timestamp: string; operation: AiOperationType; model: string; wordCount?: number; durationMs?: number; success: boolean; notes?: string; }
export interface AiQuotaLimits { daily: number; hourly: number; }
const intEnv = (name: string, fallback: number) => { const n = Number.parseInt(process.env[name] || '', 10); return Number.isFinite(n) && n > 0 ? n : fallback; };
export const AI_OPERATION_LIMITS: Record<AiOperationType, AiQuotaLimits> = {
  writing_grade: { daily: intEnv('RATE_LIMIT_WRITING', 10), hourly: intEnv('RATE_LIMIT_WRITING_HOURLY', 4) },
  speaking_grade: { daily: intEnv('RATE_LIMIT_SPEAKING', 10), hourly: intEnv('RATE_LIMIT_SPEAKING_HOURLY', 4) },
  mock_generation: { daily: intEnv('RATE_LIMIT_GENERATIONS', 10), hourly: intEnv('RATE_LIMIT_MOCKS_HOURLY', 3) },
  preppy_chat: { daily: intEnv('RATE_LIMIT_CHAT', 30), hourly: intEnv('RATE_LIMIT_CHAT_HOURLY', 10) },
  ai_request: { daily: intEnv('RATE_LIMIT_AI_DAILY', 50), hourly: intEnv('RATE_LIMIT_AI_HOURLY', 12) },
};
const useFirestore = () => process.env.NODE_ENV === 'production' || process.env.STORAGE_BACKEND === 'gcs_firestore';
const DATA_DIR = path.join(process.cwd(), 'data');
const LOCAL_LOG = path.join(DATA_DIR, 'ai_usage_log.json');
const LOCAL_QUOTA = path.join(DATA_DIR, 'ai_quota.json');

type LocalQuotaEntry = { dayCount: number; day: string; hourCount: number; hour: number };

class AiRateLimitService {
  private locks = new Map<string, Promise<void>>();
  constructor() { if (!useFirestore()) this.ensureLocalFiles(); }
  private ensureLocalFiles() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); if (!fs.existsSync(LOCAL_LOG)) fs.writeFileSync(LOCAL_LOG, '[]', 'utf8'); if (!fs.existsSync(LOCAL_QUOTA)) fs.writeFileSync(LOCAL_QUOTA, '{}', 'utf8'); }
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> { const previous = this.locks.get(key) || Promise.resolve(); let release!: () => void; const current = new Promise<void>(r => { release = r; }); this.locks.set(key, current); await previous; try { return await fn(); } finally { release(); if (this.locks.get(key) === current) this.locks.delete(key); } }
  private readLocal(): AiUsageRecord[] { try { const v = JSON.parse(fs.readFileSync(LOCAL_LOG, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } }
  private readLocalQuota(): Record<string, LocalQuotaEntry> { try { const v = JSON.parse(fs.readFileSync(LOCAL_QUOTA, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
  private writeLocalQuota(value: Record<string, LocalQuotaEntry>) { const tmp = `${LOCAL_QUOTA}.tmp.${process.pid}.${Date.now()}.${nanoid(4)}`; fs.writeFileSync(tmp, JSON.stringify(value), 'utf8'); fs.renameSync(tmp, LOCAL_QUOTA); }
  private appendLocal(r: AiUsageRecord) { const logs = this.readLocal(); logs.push(r); if (logs.length > 5000) logs.splice(0, logs.length - 5000); const tmp = `${LOCAL_LOG}.tmp.${process.pid}.${Date.now()}.${nanoid(4)}`; fs.writeFileSync(tmp, JSON.stringify(logs), 'utf8'); fs.renameSync(tmp, LOCAL_LOG); }
  public async consume(userId: string, operation: AiOperationType) {
    const limits = AI_OPERATION_LIMITS[operation];
    if (!useFirestore()) {
      return this.withLock(`quota:${userId}:${operation}`, async () => {
        const now = Date.now(), today = new Date(now).toISOString().slice(0, 10), hourKey = Math.floor(now / 3600000), key = `${userId}:${operation}`;
        const all = this.readLocalQuota();
        const current = all[key] || { dayCount: 0, day: today, hourCount: 0, hour: hourKey };
        const daily = current.day === today ? current.dayCount : 0;
        const hourly = current.hour === hourKey ? current.hourCount : 0;
        if (hourly >= limits.hourly) return { allowed: false, reason: `Hourly AI limit reached (${limits.hourly}).`, currentDaily: daily, maxDaily: limits.daily, currentHourly: hourly, maxHourly: limits.hourly };
        if (daily >= limits.daily) return { allowed: false, reason: `Daily AI limit reached (${limits.daily}).`, currentDaily: daily, maxDaily: limits.daily, currentHourly: hourly, maxHourly: limits.hourly };
        all[key] = { dayCount: daily + 1, day: today, hourCount: hourly + 1, hour: hourKey };
        this.writeLocalQuota(all);
        return { allowed: true, currentDaily: daily + 1, maxDaily: limits.daily, currentHourly: hourly + 1, maxHourly: limits.hourly };
      });
    }
    const db = getFirestoreDb();
    const now = Date.now(), today = new Date().toISOString().slice(0, 10), hourKey = Math.floor(now / 3600000);
    const dayRef = db.collection('users').doc(userId).collection('ai_quota').doc(`${operation}_${today}`);
    const hourRef = db.collection('users').doc(userId).collection('ai_quota').doc(`${operation}_hour_${hourKey}`);
    return db.runTransaction(async tx => {
      const [daySnap, hourSnap] = await Promise.all([tx.get(dayRef), tx.get(hourRef)]);
      const daily = Number(daySnap.data()?.count || 0), hourly = Number(hourSnap.data()?.count || 0);
      if (hourly >= limits.hourly) return { allowed: false, reason: `Hourly AI limit reached (${limits.hourly}).`, currentDaily: daily, maxDaily: limits.daily, currentHourly: hourly, maxHourly: limits.hourly };
      if (daily >= limits.daily) return { allowed: false, reason: `Daily AI limit reached (${limits.daily}).`, currentDaily: daily, maxDaily: limits.daily, currentHourly: hourly, maxHourly: limits.hourly };
      tx.set(dayRef, { count: daily + 1, operation, updatedAt: now }, { merge: true });
      tx.set(hourRef, { count: hourly + 1, operation, updatedAt: now }, { merge: true });
      return { allowed: true, currentDaily: daily + 1, maxDaily: limits.daily, currentHourly: hourly + 1, maxHourly: limits.hourly };
    });
  }
  public async checkLimit(userId: string, operation: AiOperationType) { return this.consume(userId, operation); }
  public async recordUsage(params: { userId: string; operation: AiOperationType; model: string; wordCount?: number; durationMs?: number; success: boolean; notes?: string }) {
    const record: AiUsageRecord = { id: `ai_${Date.now()}_${nanoid(6)}`, timestamp: new Date().toISOString(), ...params };
    if (useFirestore()) await getFirestoreDb().collection('ai_usage').doc(record.id).set(record); else await this.withLock('usage-log', async () => this.appendLocal(record));
  }
  public async getUsageLogs(options?: { userId?: string; operation?: AiOperationType; limit?: number }) {
    if (!useFirestore()) { let logs = this.readLocal(); if (options?.userId) logs = logs.filter(x => x.userId === options.userId); if (options?.operation) logs = logs.filter(x => x.operation === options.operation); logs.sort((a,b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)); return { records: logs.slice(0, Math.min(Math.max(options?.limit || 100, 1), 500)), summary: {} as Record<string, number> }; }
    let q: FirebaseFirestore.Query = getFirestoreDb().collection('ai_usage').orderBy('timestamp', 'desc');
    if (options?.userId) q = q.where('userId', '==', options.userId); if (options?.operation) q = q.where('operation', '==', options.operation);
    const snap = await q.limit(Math.min(Math.max(options?.limit || 100, 1), 500)).get();
    return { records: snap.docs.map(d => d.data() as AiUsageRecord), summary: {} as Record<string, number> };
  }
}
export const aiRateLimitService = new AiRateLimitService();
