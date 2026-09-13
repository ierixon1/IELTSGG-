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
