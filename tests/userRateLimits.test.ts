import './env';
import { after, before, describe, it } from 'node:test';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import { startServer, type ServerProcess } from './serverProcess';
import { all, cookiePair, expectRateLimited, rawRequest, statuses, type RawReply } from './rateLimitHttp';

/**
 * H2, over the real `server.ts` on local storage.
 *
 * Every request limit was keyed by the client address, and the learner API's was
 * checked before the session was even read. Learner "ben" polling from one address
 * got 429, and so did learner "ana" behind the same address; behind a proxy, the
 * whole platform shared one budget.
 *
 * Every request here comes from 127.0.0.1. Signed-in learners and staff must each
 * get exactly their own allowance; requests without a session share the address's;
 * and nothing a client sends — a header, a query, a cookie, X-Forwarded-For —
 * changes which allowance a request spends.
 */

const originalCwd = process.cwd();
const scratch = mkdtempSync(path.join(os.tmpdir(), 'everstudy-user-rate-limits-'));
// The limits come from the service, which creates its local store where it is loaded.
process.chdir(scratch);
const { RATE_LIMITS } = await import('../src/services/requestRateLimitService');
process.chdir(originalCwd);

const ADMIN_USER = 'limits_admin';
const ADMIN_PASSWORD = 'Limits-Passw0rd-Long';
const NAMES = ['ana', 'ben', 'cem', 'dia', 'eli', 'fay', 'gus'] as const;
type Name = (typeof NAMES)[number];

interface Learner {
  cookie: string;
  id: string;
}

describe('the real server.ts: one address, several accounts', () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });
  const learners = new Map<Name, Learner>();
  let server: ServerProcess;
  let staff = '';
  // Requests from this address that the anonymous allowances have already counted.
  let anonymousApiSpent = 0;
  let anonymousAdminSpent = 0;

  const send = (method: string, url: string, headers: Record<string, string> = {}, json?: unknown) => rawRequest(server.origin, method, url, { headers, json, agent });
  const learner = (name: Name): Learner => {
    const found = learners.get(name);
    if (!found) throw new Error(`No learner ${name}.`);
    return found;
  };
  const asLearner = (who: Learner): Promise<RawReply> => send('GET', '/api/data', { cookie: who.cookie });

  before(async () => {
    server = await startServer({ STORAGE_BACKEND: 'local', SEED_DEFAULT_ACCOUNTS: 'true', ADMIN_USER, ADMIN_PASSWORD });
    staff = cookiePair(await send('POST', '/api/admin/login', {}, { username: ADMIN_USER, password: ADMIN_PASSWORD }), 'prep_admin_auth');
    anonymousAdminSpent += 1;
    for (const name of NAMES) {
      const reply = await send('POST', '/api/auth/register', {}, { email: `${name}@example.com`, username: `limits_${name}`, password: 'Learner-Passw0rd-1' });
      const body = JSON.parse(reply.text) as { user?: { id?: unknown } };
      if (reply.status !== 201 || typeof body.user?.id !== 'string') throw new Error(`Registering ${name} failed (${reply.status}): ${reply.text}`);
      learners.set(name, { cookie: cookiePair(reply, 'prep_auth'), id: body.user.id });
    }
  });

  after(async () => {
    agent.destroy();
    await server?.stop();
    removeTempRoot(scratch);
  });

  it('two learners behind one address each get their own allowance: one using it up leaves the other exactly theirs', async () => {
    const { max, windowMs } = RATE_LIMITS.api_user;
    const ana = learner('ana');
    const ben = learner('ben');
    const anaStatuses: number[] = [];
    const benStatuses: number[] = [];
    for (let index = 0; index < max; index += 1) {
      anaStatuses.push((await asLearner(ana)).status);
      if (index % 10 === 0) benStatuses.push((await asLearner(ben)).status);
    }
    expect(anaStatuses).toEqual(all(max, 200));
    expect(benStatuses).toEqual(all(benStatuses.length, 200));
    for (let attempt = 1; attempt <= 3; attempt += 1) expectRateLimited(`Ana over her allowance, attempt ${attempt}`, await asLearner(ana), windowMs);

    // Ben gets the rest of his own allowance — no request of Ana's was counted against it — and then he too is refused.
    const benLeft = max - benStatuses.length;
    expect(await statuses(benLeft, () => asLearner(ben))).toEqual(all(benLeft, 200));
    expectRateLimited('Ben over his own allowance', await asLearner(ben), windowMs);

    // Neither learner spent the allowance of requests without a session from this address.
    anonymousApiSpent += 1;
    expect((await send('GET', '/api/data')).status).toBe(401);
  });

  it('requests without a session are limited per address — forged headers and cookies do not escape it — and never spend a signed-in learner\'s allowance', async () => {
    const { max, windowMs } = RATE_LIMITS.api_anonymous;
    const cem = learner('cem');
    const eli = learner('eli');
    const forged = (index: number): Record<string, string> => {
      const n = index % 250;
      switch (index % 5) {
        case 0:
          return { 'x-forwarded-for': `198.51.100.${n}` };
        case 1:
          return { 'x-user-id': eli.id };
        case 2:
          return { cookie: `prep_auth=prep_${'x'.repeat(40)}${index}` };
        case 3:
          // Eli's own session token, one character short.
          return { cookie: eli.cookie.slice(0, -1) };
        default:
          return { 'x-real-ip': `203.0.113.${n}`, forwarded: `for=203.0.113.${n}` };
      }
    };
    const left = max - anonymousApiSpent;
    expect(await statuses(left, (index) => send('GET', '/api/data', forged(index)))).toEqual(all(left, 401));
    anonymousApiSpent += left;
    expectRateLimited('no session, over the address allowance', await send('GET', '/api/data', forged(1)), windowMs);
    expectRateLimited('no session, a new X-Forwarded-For', await send('GET', '/api/data', { 'x-forwarded-for': '192.0.2.99' }), windowMs);

    // A learner signed in behind the same address is not refused.
    expect(await statuses(5, () => asLearner(cem))).toEqual(all(5, 200));
  });

  it('staff have an allowance of their own, apart from the public catalogue and from learners behind the same address', async () => {
    const publicLimit = RATE_LIMITS.admin_anonymous;
    const staffLimit = RATE_LIMITS.staff_api;
    const catalogue = () => send('GET', '/api/admin/public/materials/reading');
    const asStaff = () => send('GET', '/api/admin/me', { cookie: staff });

    const publicLeft = publicLimit.max - anonymousAdminSpent;
    expect(await statuses(publicLeft, catalogue)).toEqual(all(publicLeft, 200));
    anonymousAdminSpent += publicLeft;
    expectRateLimited('the public catalogue, over the address allowance', await catalogue(), publicLimit.windowMs);

    // The staff member behind that address has every request of their own allowance, counted once each.
    expect(await statuses(staffLimit.max, asStaff)).toEqual(all(staffLimit.max, 200));
    expectRateLimited('staff over their own allowance', await asStaff(), staffLimit.windowMs);

    // Learners are counted apart from both.
    expect(await statuses(3, () => asLearner(learner('fay')))).toEqual(all(3, 200));
  });

  it('nothing a learner sends chooses the account a request is counted against', async () => {
    const { max, windowMs } = RATE_LIMITS.api_user;
    const dia = learner('dia');
    const eli = learner('eli');
    expect((await asLearner(eli)).status).toBe(200);

    // Dia, signed in as herself, claims every other way to be Eli.
    const claimingToBeEli = (index: number): Promise<RawReply> => {
      switch (index % 5) {
        case 0:
          return send('GET', `/api/data?userId=${encodeURIComponent(eli.id)}`, { cookie: dia.cookie });
        case 1:
          return send('GET', '/api/data', { cookie: dia.cookie, 'x-user-id': eli.id });
        case 2:
          return send('GET', '/api/data', { cookie: `${dia.cookie}; userId=${eli.id}; user_id=${eli.id}` });
        case 3:
          return send('GET', '/api/data', { cookie: `${dia.cookie}; ${eli.cookie.replace('prep_auth=', 'prep_auth_user=')}` });
        default:
          return send('GET', '/api/data', { cookie: dia.cookie, 'x-forwarded-for': '198.51.100.7', 'x-user-id': eli.id, 'x-account-id': eli.id });
      }
    };
    expect(await statuses(max, claimingToBeEli)).toEqual(all(max, 200));
    expectRateLimited('Dia over her own allowance, still claiming to be Eli', await claimingToBeEli(1), windowMs);

    // Eli's allowance holds his one request and nothing of Dia's.
    expect(await statuses(max - 1, () => asLearner(eli))).toEqual(all(max - 1, 200));
    expectRateLimited('Eli over his own allowance', await asLearner(eli), windowMs);
  });

  it('concurrent requests from one learner take exactly the allowance, and no more', async () => {
    const { max } = RATE_LIMITS.api_user;
    const gus = learner('gus');
    const extra = 40;
    const replies = await Promise.all(Array.from({ length: max + extra }, () => asLearner(gus)));
    const count = (status: number) => replies.filter((reply) => reply.status === status).length;
    expect({ allowed: count(200), refused: count(429), other: replies.length - count(200) - count(429) }).toEqual({ allowed: max, refused: extra, other: 0 });
  });
});

describe('the real server.ts with TRUST_PROXY=true', () => {
  it('refuses to start: believing every X-Forwarded-For hop would let any client choose its own address', async () => {
    let failure = '';
    try {
      const started = await startServer({ STORAGE_BACKEND: 'local', TRUST_PROXY: 'true' }, 90_000);
      await started.stop();
      failure = 'the server started';
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toContain('exited');
    expect(failure).toContain('[Config] TRUST_PROXY=true would believe an X-Forwarded-For header');
  });
});
