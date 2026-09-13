/**
 * The scenarios `npm run verify:firestore` runs (H10), kept apart from the command
 * so the same code can be run against the in-memory Firestore in the test suite
 * (tests/firestoreVerification.test.ts) — which proves the scenarios, not Firestore.
 *
 * Everything goes through the application's own services — accounts, sessions,
 * profiles, promotion, the request limiter — on whichever Firestore
 * `getFirestoreDb()` returns. Every document written is named after `runId` and
 * removed at the end, also when a step fails.
 */
import { createHash } from 'node:crypto';
import { getFirestoreDb } from '../src/services/firebaseAdmin';
import { authService } from '../src/services/authService';
import { FirestoreDataStore } from '../src/services/storage/FirestoreDataStore';
import { RATE_LIMITS, requestRateLimitService } from '../src/services/requestRateLimitService';
import { isStorageUnavailableError } from '../src/services/storage/availability';

export interface VerificationStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerificationOptions {
  /** Lowercase letters, digits and underscores; names every document the run writes. */
  runId: string;
  /** How many requests race for one rate-limit key. */
  concurrency?: number;
  /** Reads the TTL policy on `rate_limits.expiresAt`; without it that step is reported as not checked. */
  checkTtl?: () => Promise<{ ok: boolean; detail: string }>;
}

const keyHash = (operation: string, key: string) => createHash('sha256').update(`${operation}:${key}`).digest('hex');
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Milliseconds of a stored timestamp: a Firestore `Timestamp`, or a `Date` from the in-memory Firestore. */
function millisOf(value: unknown): { millis: number; type: string } {
  if (value instanceof Date) return { millis: value.getTime(), type: 'Date' };
  if (value && typeof value === 'object' && 'toMillis' in value && typeof (value as { toMillis: unknown }).toMillis === 'function') {
    return { millis: (value as { toMillis: () => number }).toMillis(), type: 'Timestamp' };
  }
  return { millis: Number.NaN, type: typeof value };
}

export async function runFirestoreVerification(options: VerificationOptions): Promise<VerificationStep[]> {
  if (!/^[a-z0-9_]{6,24}$/.test(options.runId)) throw new Error('runId must be 6–24 lowercase letters, digits or underscores.');
  const steps: VerificationStep[] = [];
  const step = async (name: string, run: () => Promise<{ ok: boolean; detail: string }>) => {
    try {
      const outcome = await run();
      steps.push({ name, ...outcome });
    } catch (error) {
      steps.push({ name, ok: false, detail: `threw: ${describe(error)}` });
    }
  };

  const db = getFirestoreDb();
  const store = new FirestoreDataStore();
  const username = `verify_${options.runId}`;
  const password = `Verify-${options.runId}-Passw0rd`;
  const concurrentKey = `verify:${options.runId}:concurrent`;
  const releaseKey = `verify:${options.runId}:release`;
  let userId = '';
  let token = '';

  try {
    await step('Firestore answers a document read', async () => {
      await db.collection('rate_limits').doc(`verify-${options.runId}-probe`).get();
      return { ok: true, detail: 'rate_limits read' };
    });

    await step('an account is registered, signs in, and its session validates', async () => {
      const registered = await authService.register({ email: `${username}@verify.invalid`, username, password });
      userId = registered.user.id;
      const signedIn = await authService.login(username, password);
      token = signedIn.token;
      const session = await authService.validateSession(token);
      return { ok: session?.userId === userId, detail: `user ${userId}, session ${session ? 'valid' : 'missing'}` };
    });

    await step('a learner profile is written and read back', async () => {
      const profile = { id: userId, targetBand: 7.5, currentLevel: 6, hoursPerWeek: 9, weakSection: 'reading' as const, isOnboarded: true };
      await store.saveUserProfile(userId, profile);
      const read = await store.getUserProfile(userId);
      return { ok: JSON.stringify(read) === JSON.stringify(profile), detail: JSON.stringify(read) };
    });

    await step('a promotion changes the stored role in a transaction and ends the account’s sessions', async () => {
      const result = await authService.promoteAccount(username, 'examiner');
      const stored = (await db.collection('auth_users').doc(userId).get()).data();
      const session = await authService.validateSession(token);
      return { ok: result.outcome === 'promoted' && stored?.role === 'examiner' && session === null, detail: `${result.outcome}; role ${stored?.role}; old session ${session ? 'still valid' : 'ended'}` };
    });

    const { max, windowMs } = RATE_LIMITS.login;
    const concurrency = options.concurrency ?? max * 2;
    const raced = await Promise.allSettled(Array.from({ length: concurrency }, () => requestRateLimitService.check(concurrentKey, 'login')));
    const allowed = raced.filter((result) => result.status === 'fulfilled' && result.value.allowed).length;
    const refused = raced.filter((result) => result.status === 'fulfilled' && !result.value.allowed).length;
    const failures = raced.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
    const storedCount = Number((await db.collection('rate_limits').doc(keyHash('login', concurrentKey)).get()).data()?.count ?? 0);

    await step(`${concurrency} concurrent requests on one rate-limit key let through no more than the allowance of ${max}`, async () => ({
      ok: allowed <= max && storedCount === allowed && allowed + refused + failures.length === concurrency && (failures.length > 0 || allowed === max),
      detail: `${allowed} allowed, ${refused} refused, ${failures.length} failed; stored count ${storedCount}`,
    }));

    await step('a transaction that fails under contention is classified as storage unavailable (503), never as a refusal', async () => ({
      ok: failures.every((failure) => isStorageUnavailableError(failure)),
      detail: failures.length === 0 ? 'no transaction failed in this run (nothing to classify)' : failures.map(describe).join(' | ').slice(0, 300),
    }));

    await step('attempts given back while others are counted leave the count right', async () => {
      let windowStart = 0;
      for (let index = 0; index < 10; index += 1) windowStart = (await requestRateLimitService.check(releaseKey, 'login')).windowStart;
      const mixed = await Promise.allSettled([
        ...Array.from({ length: 5 }, () => requestRateLimitService.release(releaseKey, 'login', windowStart).then(() => 'released' as const)),
        ...Array.from({ length: 5 }, () => requestRateLimitService.check(releaseKey, 'login').then((decision) => (decision.allowed ? ('counted' as const) : ('refused' as const)))),
      ]);
      const released = mixed.filter((result) => result.status === 'fulfilled' && result.value === 'released').length;
      const counted = mixed.filter((result) => result.status === 'fulfilled' && result.value === 'counted').length;
      const stored = Number((await db.collection('rate_limits').doc(keyHash('login', releaseKey)).get()).data()?.count ?? Number.NaN);
      return { ok: stored === 10 - released + counted, detail: `${released} released, ${counted} counted, ${mixed.length - released - counted} failed or refused; stored count ${stored}` };
    });

    await step('rate_limits documents carry expiresAt, a timestamp exactly at the end of their window', async () => {
      const data = (await db.collection('rate_limits').doc(keyHash('login', concurrentKey)).get()).data() ?? {};
      const { millis, type } = millisOf(data.expiresAt);
      return { ok: Number.isFinite(millis) && millis === Number(data.windowStart) + windowMs, detail: `expiresAt ${type} ${Number.isFinite(millis) ? new Date(millis).toISOString() : 'missing'}; windowStart ${data.windowStart}` };
    });

    await step('a TTL policy is active on rate_limits.expiresAt', async () => (options.checkTtl ? options.checkTtl() : { ok: false, detail: 'not checked: no Firestore Admin API access was given' }));
  } finally {
    await step('everything the run wrote is removed', async () => {
      const refs = [
        db.collection('rate_limits').doc(keyHash('login', concurrentKey)),
        db.collection('rate_limits').doc(keyHash('login', releaseKey)),
        db.collection('rate_limits').doc(keyHash('register', 'verify-script')),
        db.collection('rate_limits').doc(`verify-${options.runId}-probe`),
      ];
      if (userId) {
        refs.push(db.collection('auth_users').doc(userId), db.collection('users').doc(userId));
        const sessions = await db.collection('auth_sessions').where('userId', '==', userId).get();
        refs.push(...sessions.docs.map((doc) => doc.ref));
      }
      for (const ref of refs) await ref.delete();
      return { ok: true, detail: `${refs.length} document(s) deleted` };
    });
  }
  return steps;
}
