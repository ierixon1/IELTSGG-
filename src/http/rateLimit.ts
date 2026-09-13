import type { Response } from 'express';
import { requestRateLimitService, type RateLimitOperation } from '../services/requestRateLimitService';

/**
 * Counting a request against an allowance, and the answer when it is over.
 *
 * Who shares an allowance is decided by the key, and a key is only ever built
 * from what the server established itself: `accountKey` from a validated session,
 * `clientAddressKey` (clientAddress.ts) from the connection and the configured
 * proxies. Nothing a client sends in a header, a query or a body names the
 * account a request is counted against.
 *
 * Over the limit is 429 with the stable code `rate_limited` and a `Retry-After`.
 * A limiter whose store cannot be used rejects instead, and the caller hands that
 * to the API error boundary, which answers 503: the client did nothing wrong, and
 * being told to slow down would be a lie.
 */

export const RATE_LIMITED = { code: 'rate_limited', message: 'Too many requests. Please try again later.' } as const;

/** The key a signed-in account's requests are counted under. */
export const accountKey = (userId: string) => `account:${userId}`;

/** Counts the request. True when it may go on; otherwise it has been answered 429. Rejects when the store fails. */
export async function admitRequest(res: Response, key: string, operation: RateLimitOperation): Promise<boolean> {
  const decision = await requestRateLimitService.check(key, operation);
  if (decision.allowed) return true;
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
  res.status(429).json({ error: RATE_LIMITED.message, code: RATE_LIMITED.code });
  return false;
}

/** An attempt that was counted and may be given back. */
export interface CountedAttempt {
  key: string;
  operation: RateLimitOperation;
  windowStart: number;
}

/**
 * A sign-in attempt, counted against the two limits it is held to (M16):
 *   - `login_account`: this account name from this address;
 *   - `login`: this address.
 *
 * Both are counted before the password is checked — so concurrent guesses cannot
 * overrun them — and `releaseSignIn` gives both back when the sign-in succeeds, so
 * only failures stay counted. A class signing in from one school network spends
 * nothing; guessing does. Null when either limit is reached: the request has been
 * answered 429, and nothing of it stays counted. Rejects when the store fails.
 *
 * `addressKey` is the client address key, prefixed for staff sign-in so the two
 * sign-in forms are counted apart.
 */
export async function countSignIn(res: Response, addressKey: string, identifier: string): Promise<CountedAttempt[] | null> {
  const account = `${addressKey}|${String(identifier || '').trim().toLowerCase().slice(0, 256)}`;
  const counted: CountedAttempt[] = [];
  for (const [key, operation] of [
    [account, 'login_account'],
    [addressKey, 'login'],
  ] as const) {
    const decision = await requestRateLimitService.check(key, operation);
    if (!decision.allowed) {
      await releaseSignIn(counted);
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
      res.status(429).json({ error: RATE_LIMITED.message, code: RATE_LIMITED.code });
      return null;
    }
    counted.push({ key, operation, windowStart: decision.windowStart });
  }
  return counted;
}

/**
 * Gives counted sign-in attempts back. A store that fails here is logged and not
 * reported: the sign-in it follows has already been decided, and the worst outcome
 * is one attempt left counted until its window closes.
 */
export async function releaseSignIn(counted: CountedAttempt[]): Promise<void> {
  for (const attempt of counted) {
    try {
      await requestRateLimitService.release(attempt.key, attempt.operation, attempt.windowStart);
    } catch (error) {
      console.error(`[RateLimit] A counted ${attempt.operation} attempt could not be given back:`, error);
    }
  }
}
