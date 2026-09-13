import { isIP, isIPv4 } from 'node:net';
import type { Request } from 'express';

/**
 * Where a request comes from, for the limits that cannot use an account: sign-up,
 * sign-in, password recovery, and any API request without a valid session.
 *
 * Express works `req.ip` out from its `trust proxy` setting. Left unset, it is
 * the address of the connection itself and `X-Forwarded-For` is ignored — any
 * client can write that header. Behind a reverse proxy or a load balancer the
 * connection comes from the proxy, so every client would share its address. The
 * deployment says what sits in front of the server with `TRUST_PROXY`, and
 * Express then takes the address the nearest trusted proxy saw:
 *
 *   - unset, empty, `false` or `0`: no proxy; the connection's own address;
 *   - a whole number N from 1 to 10: N proxies in front; the address N hops back;
 *   - a comma-separated list of proxy addresses, CIDR ranges, or the names
 *     `loopback`, `linklocal`, `uniquelocal`: only those hops are believed.
 *
 * `true` is refused: it believes every hop, so the client chooses its own
 * address. Anything else that is not one of the forms above stops the server at
 * start rather than being guessed at.
 */

export type TrustProxySetting = false | number | string[];

export class TrustProxyConfigError extends Error {}

const MAX_HOPS = 10;
const PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isTrustedProxyEntry(entry: string): boolean {
  if (PRESETS.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

export function trustProxySetting(raw: string | undefined): TrustProxySetting {
  const value = (raw ?? '').trim();
  const lower = value.toLowerCase();
  if (value === '' || lower === 'false') return false;
  if (lower === 'true') {
    throw new TrustProxyConfigError(
      'TRUST_PROXY=true would believe an X-Forwarded-For header that any client can write. Set the number of proxies in front of the server, or their addresses.',
    );
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops > MAX_HOPS) throw new TrustProxyConfigError(`TRUST_PROXY allows at most ${MAX_HOPS} proxy hops; got ${value.slice(0, 12)}.`);
    return hops === 0 ? false : hops;
  }
  const entries = value.split(',').map((entry) => entry.trim());
  for (const entry of entries) {
    if (!isTrustedProxyEntry(entry)) {
      throw new TrustProxyConfigError(`TRUST_PROXY has an entry that is not an IP address, a CIDR range or loopback/linklocal/uniquelocal: "${entry.slice(0, 64)}".`);
    }
  }
  return entries;
}

/** The eight groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  let text = address;
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    const [a, b, c, d] = last.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const groups = (part: string) => (part === '' ? [] : part.split(':').map((group) => parseInt(group, 16)));
  const [head, tail] = text.split('::');
  if (tail === undefined) return groups(head);
  const before = groups(head);
  const after = groups(tail);
  return [...before, ...new Array<number>(8 - before.length - after.length).fill(0), ...after];
}

/**
 * The key an address is limited under. An IPv4 client is its address, and so is
 * an IPv4 client seen through an IPv4-mapped IPv6 socket. An IPv6 client is its
 * /64: one subscriber is routinely given a whole /64 and can use any address in
 * it, so keying the full address would give one client as many allowances as it
 * cares to take.
 */
export function addressKey(address: string): string {
  const bare = address.split('%')[0];
  if (isIPv4(bare)) return `ip4:${bare}`;
  const groups = ipv6Groups(bare);
  if (!groups) return 'ip:unknown';
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `ip4:${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return `ip6:${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
}

/** The address key of a request, from `req.ip` as the `trust proxy` setting decides it. */
export function clientAddressKey(req: Request): string {
  return addressKey(String(req.ip || req.socket.remoteAddress || ''));
}
