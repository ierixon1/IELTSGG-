import './env';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import { all, expectRateLimited, rawRequest, statuses } from './rateLimitHttp';

/**
 * Whose address a request without a session is counted against (H2).
 *
 * `TRUST_PROXY` is read strictly — `true` and anything unreadable are refused —
 * and the address that results is the key: IPv4 as it is, IPv6 by its /64. The
 * second half runs the real learner authentication middleware behind Express's
 * `trust proxy`, with no proxy and with one, and forges X-Forwarded-For both ways.
 */

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-client-address-'));
process.chdir(tempRoot);

const express = (await import('express')).default;
const { addressKey, trustProxySetting, TrustProxyConfigError } = await import('../src/http/clientAddress');
const { guardAsyncHandlers } = await import('../src/http/asyncHandlers');
const { apiErrorBoundary } = await import('../src/http/errorBoundary');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { RATE_LIMITS } = await import('../src/services/requestRateLimitService');

const servers: Server[] = [];

after(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

describe('TRUST_PROXY', () => {
  it('unset, empty, false and 0 believe no proxy', () => {
    for (const value of [undefined, '', '   ', 'false', 'FALSE', '0']) expect([value, trustProxySetting(value)]).toEqual([value, false]);
  });

  it('a hop count, or proxy addresses, ranges and the loopback/linklocal/uniquelocal names, are taken as written', () => {
    expect(trustProxySetting('1')).toBe(1);
    expect(trustProxySetting(' 2 ')).toBe(2);
    expect(trustProxySetting('10.0.0.1, 10.0.0.0/8,loopback')).toEqual(['10.0.0.1', '10.0.0.0/8', 'loopback']);
    expect(trustProxySetting('2001:db8::/32,::1,uniquelocal')).toEqual(['2001:db8::/32', '::1', 'uniquelocal']);
  });

  it('true, more than ten hops, and anything that is not an address are refused', () => {
    for (const value of ['true', 'TRUE', '11', '-1', '*', 'proxy.example.com', '1.2.3', '10.0.0.0/33', '::1/129', '10.0.0.0/8/1', '10.0.0.1,', 'loopback;1']) {
      let refused: unknown;
      try {
        trustProxySetting(value);
      } catch (error) {
        refused = error;
      }
      expect([value, refused instanceof TrustProxyConfigError]).toEqual([value, true]);
    }
  });
});

describe('the address key', () => {
  it('an IPv4 client is its address, also when it arrives on an IPv6 socket', () => {
    expect(addressKey('203.0.113.7')).toBe('ip4:203.0.113.7');
    expect(addressKey('::ffff:203.0.113.7')).toBe('ip4:203.0.113.7');
    expect(addressKey('::FFFF:cb00:7107')).toBe('ip4:203.0.113.7');
  });

  it('an IPv6 client is its /64, however the address is written, so it cannot rotate through the rest of its prefix', () => {
    const key = addressKey('2001:db8:85a3:12::1');
    expect(key).toBe('ip6:2001:db8:85a3:12::/64');
    expect(addressKey('2001:0db8:85a3:0012:ffff:ffff:ffff:ffff')).toBe(key);
    expect(addressKey('2001:db8:85a3:12:abcd::7%eth0')).toBe(key);
    expect(addressKey('2001:db8:85a3:12::192.0.2.1')).toBe(key);
    expect(addressKey('2001:db8:85a3:13::1') === key).toBe(false);
    expect(addressKey('::1')).toBe('ip6:0:0:0:0::/64');
  });

  it('something that is not an address is one shared key, not whatever it says', () => {
    expect(addressKey('')).toBe('ip:unknown');
    expect(addressKey('not-an-address')).toBe('ip:unknown');
  });
});

describe('behind trust proxy, over the real learner authentication middleware', () => {
  const { max, windowMs } = RATE_LIMITS.api_anonymous;
  let direct = '';
  let proxied = '';

  async function serve(trust: ReturnType<typeof trustProxySetting>): Promise<string> {
    const app = guardAsyncHandlers(express());
    app.set('trust proxy', trust);
    app.use('/api', authenticateRequest);
    app.get('/api/probe', (_req, res) => {
      res.json({ ok: true });
    });
    app.use('/api', apiErrorBoundary);
    const server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  before(async () => {
    direct = await serve(trustProxySetting(undefined));
    proxied = await serve(trustProxySetting('1'));
  });

  it('with no TRUST_PROXY, X-Forwarded-For is ignored: every forged value spends the one allowance of the connection', async () => {
    const forged = (index: number) => rawRequest(direct, 'GET', '/api/probe', { headers: { 'x-forwarded-for': `198.51.100.${index % 250}` } });
    expect(await statuses(max, forged)).toEqual(all(max, 401));
    expectRateLimited('no session, yet another forged X-Forwarded-For', await rawRequest(direct, 'GET', '/api/probe', { headers: { 'x-forwarded-for': '192.0.2.1' } }), windowMs);
    expectRateLimited('no session, no header', await rawRequest(direct, 'GET', '/api/probe'), windowMs);
  });

  it('with TRUST_PROXY=1, the address the proxy saw is counted; an address a client puts in front of it changes nothing', async () => {
    // The proxy appends the address it saw; a client can only add entries before it.
    const viaProxy = (client: string, forgedInFront?: string) =>
      rawRequest(proxied, 'GET', '/api/probe', { headers: { 'x-forwarded-for': forgedInFront ? `${forgedInFront}, ${client}` : client } });
    expect(await statuses(max, (index) => viaProxy('203.0.113.10', index % 2 === 1 ? `198.51.100.${index % 250}` : undefined))).toEqual(all(max, 401));
    expectRateLimited('the client, over its allowance, with a forged address in front', await viaProxy('203.0.113.10', '192.0.2.50'), windowMs);
    expect((await viaProxy('203.0.113.11')).status).toBe(401);

    expect(await statuses(max, (index) => viaProxy(`2001:db8:1:2::${(index + 1).toString(16)}`))).toEqual(all(max, 401));
    expectRateLimited('another address in the same IPv6 /64', await viaProxy('2001:db8:1:2:ffff::1'), windowMs);
    expect((await viaProxy('2001:db8:1:3::1')).status).toBe(401);
  });
});
