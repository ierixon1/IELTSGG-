import type { Request } from 'express';
import { authService } from '../services/authService';

export const ADMIN_AUTH_COOKIE='prep_admin_auth';

export interface StaffSession {
  token: string;
  userId: string;
  username: string;
  name: string;
  role: 'admin' | 'examiner';
}

const readCookie = (req: Request, name: string) => {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
};

async function resolveStaffSession(req: Request): Promise<StaffSession | null> {
  let token: string;
  try {
    token = readCookie(req, ADMIN_AUTH_COOKIE);
  } catch (error) {
    // A cookie that is not valid percent-encoding is no credential at all.
    if (error instanceof URIError) return null;
    throw error;
  }
  if (!token) return null;
  const session = await authService.validateSession(token);
  if (!session || (session.role !== 'admin' && session.role !== 'examiner')) return null;
  return { token, userId: session.userId, username: session.username, name: session.name, role: session.role };
}

const resolved = new WeakMap<Request, Promise<StaffSession | null>>();

/**
 * The staff member an `/api/admin` request is signed in as, from the admin
 * session cookie and nothing else: null without one, or when it is not a current
 * admin or examiner session. Rejects when the session store cannot be read.
 *
 * Worked out once per request. The admin security middleware needs it to count
 * the request against the staff member's own allowance, and `requireAdminAuth`
 * needs it to let the request in; both get the same answer from one lookup.
 */
export function staffSessionOf(req: Request): Promise<StaffSession | null> {
  let session = resolved.get(req);
  if (!session) {
    session = resolveStaffSession(req);
    resolved.set(req, session);
  }
  return session;
}
