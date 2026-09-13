import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getFirestoreDb } from './firebaseAdmin';

/**
 * Request allowances: how many requests a key may make in a window that opens
 * with its first request.
 *
 * The caller chooses the key, and with it who shares an allowance (src/http/rateLimit.ts):
 *   - `api_user`, `staff_api`: one signed-in account, from its validated session;
 *   - `api_anonymous`, `admin_anonymous` and the sign-in flows: one client address.
 *
 * Both stores decide a request on the current count and write the new count as
 * one step, so concurrent requests cannot both take the last slot. Firestore does
 * it in a transaction, which the client runs again when another request changed
 * the count first. The local file is read, decided and written without yielding,
 * one key at a time.
 *
 * A store that cannot be used throws. That is never turned into a refusal: the API
 * error boundary answers it with 503.
 *
 * Firestore keeps one document per key in `rate_limits`, with `expiresAt` set to
 * when its window closes; a TTL policy on that field removes the ones nobody uses
 * any more. The local file drops closed windows whenever it is written.
 */

export type RateLimitOperation =
  | 'register'
  | 'login'
  | 'forgot_password'
  | 'reset_password'
  | 'api_anonymous'
  | 'api_user'
  | 'admin_anonymous'
  | 'staff_api';

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

export const RATE_LIMITS: Record<RateLimitOperation, { windowMs: number; max: number }> = {
  register: { windowMs: 15 * 60 * 1000, max: 10 },
  login: { windowMs: 10 * 60 * 1000, max: 20 },
  forgot_password: { windowMs: 15 * 60 * 1000, max: 5 },
  reset_password: { windowMs: 15 * 60 * 1000, max: 10 },
  // One learner's own allowance. The exam client sends one request at a time —
  // answers 700 ms and drafts 1.5 s after typing stops, a poll every 4 s while
  // grading runs — which stays under 100 a minute.
  api_user: { windowMs: 60 * 1000, max: 120 },
  // Requests without a valid session, per address. They are all answered 401.
  api_anonymous: { windowMs: 60 * 1000, max: 120 },
  // One staff member's own allowance on the admin API.
  staff_api: { windowMs: 60 * 1000, max: 120 },
  // The admin API without a staff session, per address: the public catalogue and staff sign-in.
  admin_anonymous: { windowMs: 60 * 1000, max: 120 },
};

interface Window {
  count: number;
  windowStart: number;
}

const useFirestore = () => process.env.NODE_ENV === 'production' || process.env.STORAGE_BACKEND === 'gcs_firestore';
const DATA_DIR = path.join(process.cwd(), 'data');
const LOCAL_FILE = path.join(DATA_DIR, 'request_rate_limits.json');
const keyHash = (operation: RateLimitOperation, key: string) => crypto.createHash('sha256').update(`${operation}:${key}`).digest('hex');

/** A stored window, or undefined when there is none or it is not one this service wrote. */
function readWindow(data: unknown): Window | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { count, windowStart } = data as Record<string, unknown>;
  return typeof count === 'number' && Number.isFinite(count) && typeof windowStart === 'number' && Number.isFinite(windowStart) ? { count, windowStart } : undefined;
}

/** The decision on one request, and the window to store after it (null: nothing changes). */
function decide(current: Window | undefined, limit: { windowMs: number; max: number }, now: number): { decision: RateLimitDecision; next: Window | null } {
  if (!current || current.windowStart + limit.windowMs <= now) return { decision: { allowed: true, retryAfterMs: 0 }, next: { count: 1, windowStart: now } };
  if (current.count >= limit.max) return { decision: { allowed: false, retryAfterMs: current.windowStart + limit.windowMs - now }, next: null };
  return { decision: { allowed: true, retryAfterMs: 0 }, next: { count: current.count + 1, windowStart: current.windowStart } };
}

class RequestRateLimitService {
  private locks = new Map<string, Promise<void>>();

  constructor() {
    if (!useFirestore()) {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (!fs.existsSync(LOCAL_FILE)) fs.writeFileSync(LOCAL_FILE, '{}', 'utf8');
    }
  }

  private readLocal(): Record<string, Window & { expiresAt?: number }> {
    try {
      return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
    } catch {
      return {};
    }
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  async check(key: string, operation: RateLimitOperation): Promise<RateLimitDecision> {
    const limit = RATE_LIMITS[operation];
    const id = keyHash(operation, key);
    if (useFirestore()) {
      const db = getFirestoreDb();
      const ref = db.collection('rate_limits').doc(id);
      return db.runTransaction(async (tx) => {
        const now = Date.now();
        const snapshot = await tx.get(ref);
        const { decision, next } = decide(readWindow(snapshot.data()), limit, now);
        if (next) tx.set(ref, { ...next, operation, expiresAt: new Date(next.windowStart + limit.windowMs) });
        return decision;
      });
    }
    return this.withLock(id, async () => {
      const now = Date.now();
      const entries = this.readLocal();
      const { decision, next } = decide(readWindow(entries[id]), limit, now);
      if (next) {
        for (const [entryId, entry] of Object.entries(entries)) if (!(Number(entry?.expiresAt) > now)) delete entries[entryId];
        entries[id] = { ...next, expiresAt: next.windowStart + limit.windowMs };
        fs.writeFileSync(LOCAL_FILE, JSON.stringify(entries), 'utf8');
      }
      return decision;
    });
  }
}

export const requestRateLimitService = new RequestRateLimitService();
