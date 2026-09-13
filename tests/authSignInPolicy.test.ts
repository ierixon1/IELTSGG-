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
 * M16: sign-up and sign-in from one school network, over the real `server.ts`.
 *
 * Sign-up (10 per 15 minutes) and sign-in (20 per 10 minutes, successful ones
 * included) were counted per address, so a class of more than ten registering, or
 * more than twenty signing in, from one school network was refused.
 *
 * Now registration allows 40 an hour per address — the same sustained rate — in
 * one window a class fits in. A sign-in is counted before its password is checked
 * and given back when it succeeds, so only failures stay counted: 20 per address
 * in 10 minutes, and 5 per account name per address in 15 minutes, beside the
 * account lockout. Password recovery is unchanged.
 *
 * The server runs behind one simulated proxy (`TRUST_PROXY=1`), so each test can
 * come from its own client address and has that address's allowances to itself.
 */

const originalCwd = process.cwd();
const scratch = mkdtempSync(path.join(os.tmpdir(), 'everstudy-sign-in-policy-'));
// The limits come from the service, which creates its local store where it is loaded.
process.chdir(scratch);
const { RATE_LIMITS } = await import('../src/services/requestRateLimitService');
process.chdir(originalCwd);

const ADMIN_USER = 'policy_admin';
const ADMIN_PASSWORD = 'Policy-Admin-Passw0rd';
const PASSWORD = 'Classroom-Passw0rd-1';
const CLASS_SIZE = RATE_LIMITS.register.max;

describe('one school network, the real server.ts behind one proxy', () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });
  const learners: Array<{ username: string; cookie: string }> = [];
  let server: ServerProcess;

  const from = (address: string) => ({
    send: (method: string, url: string, json?: unknown, headers: Record<string, string> = {}): Promise<RawReply> =>
      rawRequest(server.origin, method, url, { headers: { 'x-forwarded-for': address, ...headers }, json, agent }),
  });
  type Client = ReturnType<typeof from>;
  const signIn = (client: Client, username: string, password: string) => client.send('POST', '/api/auth/login', { username, password });
  const learner = (index: number) => {
    const found = learners[index];
    if (!found) throw new Error(`No learner ${index}: the class did not register.`);
    return found;
  };

  before(async () => {
    server = await startServer({ STORAGE_BACKEND: 'local', SEED_DEFAULT_ACCOUNTS: 'true', ADMIN_USER, ADMIN_PASSWORD, TRUST_PROXY: '1' });
  });

  after(async () => {
    agent.destroy();
    await server?.stop();
    removeTempRoot(scratch);
  });

  it('a class registers and signs in together: nobody is refused, signing in again costs nothing, and each learner then has their own API allowance', async () => {
    // The policy itself, pinned: the class below is sized from these, so without this a looser or tighter limit would pass unnoticed.
    expect([RATE_LIMITS.register, RATE_LIMITS.login, RATE_LIMITS.login_account]).toEqual([
      { windowMs: 60 * 60 * 1000, max: 40 },
      { windowMs: 10 * 60 * 1000, max: 20 },
      { windowMs: 15 * 60 * 1000, max: 5 },
    ]);
    const school = from('203.0.113.10');
    const registered: number[] = [];
    for (let index = 0; index < CLASS_SIZE; index += 1) {
      const username = `class_${String(index).padStart(2, '0')}`;
      const reply = await school.send('POST', '/api/auth/register', { email: `${username}@school.example`, username, password: PASSWORD });
      registered.push(reply.status);
      if (reply.status === 201) learners.push({ username, cookie: cookiePair(reply, 'prep_auth') });
    }
    expect(registered).toEqual(all(CLASS_SIZE, 201));
    expectRateLimited('one registration more than the hour allows', await school.send('POST', '/api/auth/register', { email: 'late@school.example', username: 'class_late', password: PASSWORD }), RATE_LIMITS.register.windowMs);

    // Twice the old address limit of twenty sign-ins, then a second round.
    expect(await statuses(CLASS_SIZE, (index) => signIn(school, learner(index).username, PASSWORD))).toEqual(all(CLASS_SIZE, 200));
    expect(await statuses(10, (index) => signIn(school, learner(index).username, PASSWORD))).toEqual(all(10, 200));

    // Signed in, each learner is counted on their own (H2).
    expect(await statuses(CLASS_SIZE, (index) => school.send('GET', '/api/data', undefined, { cookie: learner(index).cookie }))).toEqual(all(CLASS_SIZE, 200));
    const { max, windowMs } = RATE_LIMITS.api_user;
    expect(await statuses(max - 1, () => school.send('GET', '/api/data', undefined, { cookie: learner(0).cookie }))).toEqual(all(max - 1, 200));
    expectRateLimited('the first learner, over their own API allowance', await school.send('GET', '/api/data', undefined, { cookie: learner(0).cookie }), windowMs);
    expect((await school.send('GET', '/api/data', undefined, { cookie: learner(1).cookie })).status).toBe(200);
  });

  it("guessing one account's password is refused after five failures from that address, while classmates there still sign in", async () => {
    const attacker = from('203.0.113.20');
    const target = learner(2).username;
    const { max, windowMs } = RATE_LIMITS.login_account;
    expect(await statuses(max, () => signIn(attacker, target, 'wrong-password-guess'))).toEqual(all(max, 401));
    expectRateLimited('a sixth guess at the same account', await signIn(attacker, target, 'wrong-password-guess'), windowMs);
    expectRateLimited('even the right password, from that address inside the window', await signIn(attacker, target, PASSWORD), windowMs);
    // The account lockout (five failures, fifteen minutes) holds from every address.
    expect((await signIn(from('203.0.113.21'), target, PASSWORD)).status).toBe(401);
    // A classmate on the same network signs in.
    expect((await signIn(attacker, learner(3).username, PASSWORD)).status).toBe(200);
  });

  it('guessing across many accounts is refused after twenty failures from one address — which also refuses a classmate there until the window closes', async () => {
    const sprayer = from('203.0.113.30');
    const { max, windowMs } = RATE_LIMITS.login;
    expect(await statuses(max, (index) => signIn(sprayer, `guess_${index}`, 'Summer2026!'))).toEqual(all(max, 401));
    expectRateLimited('another account name', await signIn(sprayer, 'guess_next', 'Summer2026!'), windowMs);
    // The trade-off that remains (M16): the same address is refused for everyone until the window closes…
    expectRateLimited('a classmate with the right password, same address', await signIn(sprayer, learner(4).username, PASSWORD), windowMs);
    // …and the classmate signs in from any other address.
    expect((await signIn(from('203.0.113.31'), learner(4).username, PASSWORD)).status).toBe(200);
  });

  it('concurrent guesses cannot overrun the limit: each one is counted before its password is checked', async () => {
    const burst = from('203.0.113.40');
    const { max } = RATE_LIMITS.login;
    const replies = await Promise.all(Array.from({ length: max + 10 }, (_, index) => signIn(burst, `burst_${index}`, 'wrong-password')));
    const count = (status: number) => replies.filter((reply) => reply.status === status).length;
    expect({ refusedCredentials: count(401), rateLimited: count(429), other: replies.length - count(401) - count(429) }).toEqual({ refusedCredentials: max, rateLimited: 10, other: 0 });
  });

  it('signing in successfully in between guesses makes no room for more guesses', async () => {
    const mixed = from('203.0.113.50');
    const { max, windowMs } = RATE_LIMITS.login;
    const guesses: number[] = [];
    const successes: number[] = [];
    for (let index = 0; index < max; index += 1) {
      guesses.push((await signIn(mixed, `mixed_${index}`, 'wrong-password')).status);
      successes.push((await signIn(mixed, learner(5).username, PASSWORD)).status);
    }
    expect(guesses).toEqual(all(max, 401));
    // After the twentieth failure the address is refused, successful sign-ins included.
    expect(successes).toEqual([...all(max - 1, 200), 429]);
    expectRateLimited('a twenty-first guess', await signIn(mixed, 'mixed_extra', 'wrong-password'), windowMs);
  });

  it('password recovery stays as strict per address as it was', async () => {
    const client = from('203.0.113.60');
    const forgot = RATE_LIMITS.forgot_password;
    const reset = RATE_LIMITS.reset_password;
    expect([forgot.max, forgot.windowMs, reset.max, reset.windowMs]).toEqual([5, 15 * 60 * 1000, 10, 15 * 60 * 1000]);
    expect(await statuses(forgot.max, (index) => client.send('POST', '/api/auth/forgot-password', { email: `someone${index}@school.example` }))).toEqual(all(forgot.max, 200));
    expectRateLimited('forgot-password', await client.send('POST', '/api/auth/forgot-password', { email: 'another@school.example' }), forgot.windowMs);
    const resetAttempt = () => client.send('POST', '/api/auth/reset-password', { email: 'someone@school.example', token: 'x'.repeat(43), newPassword: 'Another-Passw0rd-1' });
    expect(await statuses(reset.max, resetAttempt)).toEqual(all(reset.max, 400));
    expectRateLimited('reset-password', await resetAttempt(), reset.windowMs);
  });

  it('staff sign-in is counted apart from learner sign-in', async () => {
    const office = from('203.0.113.70');
    const { max, windowMs } = RATE_LIMITS.login;
    expect(await statuses(max, (index) => office.send('POST', '/api/admin/login', { username: `staff_guess_${index}`, password: 'wrong-password' }))).toEqual(all(max, 401));
    expectRateLimited('staff sign-in', await office.send('POST', '/api/admin/login', { username: 'staff_guess_next', password: 'wrong-password' }), windowMs);
    expect((await signIn(office, learner(6).username, PASSWORD)).status).toBe(200);
  });
});
