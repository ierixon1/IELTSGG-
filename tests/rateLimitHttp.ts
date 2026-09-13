import http from 'node:http';
import { expect } from './harness';
import { expectControlledError } from './errorAssertions';

/**
 * HTTP for the rate-limit suites.
 *
 * Requests go out through `node:http` exactly as written: these tests send what a
 * client could send — a forged X-Forwarded-For, a decoy cookie, a header naming
 * someone else's account — and `fetch` decides some headers for itself.
 */

export interface RawReply {
  status: number;
  type: string;
  text: string;
  retryAfter: string | undefined;
  setCookie: string[];
}

export function rawRequest(
  origin: string,
  method: string,
  url: string,
  init: { headers?: Record<string, string>; json?: unknown; agent?: http.Agent; timeoutMs?: number } = {},
): Promise<RawReply> {
  const body = init.json === undefined ? undefined : JSON.stringify(init.json);
  const headers: Record<string, string | number> = { ...(init.headers ?? {}) };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(url, origin), { method, headers, agent: init.agent }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
      });
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          type: String(response.headers['content-type'] ?? ''),
          text,
          retryAfter: response.headers['retry-after'],
          setCookie: response.headers['set-cookie'] ?? [],
        }),
      );
      response.on('error', reject);
    });
    request.setTimeout(init.timeoutMs ?? 20_000, () => request.destroy(new Error(`${method} ${url} was not answered in time`)));
    request.on('error', reject);
    request.end(body);
  });
}

/** `name=value` of a cookie the reply set. */
export function cookiePair(reply: RawReply, name: string): string {
  const pair = reply.setCookie.map((line) => line.split(';')[0]).find((candidate) => candidate.startsWith(`${name}=`));
  if (!pair) throw new Error(`The reply set no ${name} cookie (${reply.status}): ${reply.text}`);
  return pair;
}

/** Sends `count` requests one after another and returns their statuses in order. */
export async function statuses(count: number, request: (index: number) => Promise<RawReply>): Promise<number[]> {
  const out: number[] = [];
  for (let index = 0; index < count; index += 1) out.push((await request(index)).status);
  return out;
}

export const all = (count: number, status: number): number[] => new Array<number>(count).fill(status);

/** A refusal for being over a limit: 429, `rate_limited`, nothing internal, and a Retry-After inside the window. */
export function expectRateLimited(label: string, reply: RawReply, windowMs: number): void {
  expectControlledError(label, reply, 429, 'rate_limited');
  const seconds = Number(reply.retryAfter);
  expect([label, 'Retry-After', Number.isInteger(seconds) && seconds >= 1 && seconds <= windowMs / 1000]).toEqual([label, 'Retry-After', true]);
}
