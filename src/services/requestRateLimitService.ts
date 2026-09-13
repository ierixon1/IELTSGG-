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
 *   - `api_anonymous`, `admin_anonymous` and the sign-in flows: one client address;
 *   - `login_account`: one account name tried from one client address.
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
  | 'login_account'
  | 'forgot_password'
  | 'reset_password'
  | 'api_anonymous'
  | 'api_user'
  | 'admin_anonymous'
  | 'staff_api';

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
  /** When the window this request was counted in (or refused by) opened; `release` needs it. */
  windowStart: number;
}

export const RATE_LIMITS: Record<RateLimitOperation, { windowMs: number; max: number }> = {
  // Account creation per address. The same sustained rate as the earlier 10 per
  // 15 minutes (40 an hour, 960 a day), taken as one window so a class of up to
  // 40 can register together (M16).
  register: { windowMs: 60 * 60 * 1000, max: 40 },
  // Failed sign-ins per address. Every attempt is counted before the password is
  // checked, and one that succeeds is given back, so a class signing in does not
  // spend it and concurrent guesses cannot overrun it (M16).
  login: { windowMs: 10 * 60 * 1000, max: 20 },
  // Failed sign-ins for one account name from one address, counted the same way.
  // Matches the account lockout (5 failures, 15 minutes), and keeps one person
  // retrying one account from spending the whole address's allowance.
  login_account: { windowMs: 15 * 60 * 1000, max: 5 },
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
  if (!current || current.windowStart + limit.windowMs <= now) return { decision: { allowed: true, retryAfterMs: 0, windowStart: now }, next: { count: 1, windowStart: now } };
  if (current.count >= limit.max) return { decision: { allowed: false, retryAfterMs: current.windowStart + limit.windowMs - now, windowStart: current.windowStart }, next: null };
  return { decision: { allowed: true, retryAfterMs: 0, windowStart: current.windowStart }, next: { count: current.count + 1, windowStart: current.windowStart } };
}

/** The window after giving one counted request back, or null when there is nothing to give back in that window. */
function giveBack(current: Window | undefined, windowStart: number): Window | null {
  return current && current.windowStart === windowStart && current.count > 0 ? { count: current.count - 1, windowStart } : null;
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

  /**
   * Gives back one request `check` counted in the window that opened at
   * `windowStart` — a sign-in that succeeded, which was no guess. Nothing is given
   * back once that window has closed and another opened, and never more than was
   * counted. Throws when the store fails, like `check`.
   */
  async release(key: string, operation: RateLimitOperation, windowStart: number): Promise<void> {
    const limit = RATE_LIMITS[operation];
    const id = keyHash(operation, key);
    if (useFirestore()) {
      const db = getFirestoreDb();
      const ref = db.collection('rate_limits').doc(id);
      await db.runTransaction(async (tx) => {
        const next = giveBack(readWindow((await tx.get(ref)).data()), windowStart);
        if (next) tx.set(ref, { ...next, operation, expiresAt: new Date(windowStart + limit.windowMs) });
      });
      return;
    }
    await this.withLock(id, async () => {
      const entries = this.readLocal();
      const next = giveBack(readWindow(entries[id]), windowStart);
      if (next) {
        entries[id] = { ...next, expiresAt: windowStart + limit.windowMs };
        fs.writeFileSync(LOCAL_FILE, JSON.stringify(entries), 'utf8');
      }
    });
  }
}

export const requestRateLimitService = new RequestRateLimitService();
