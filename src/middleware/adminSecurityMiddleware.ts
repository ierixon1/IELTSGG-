import { Request, Response, NextFunction } from 'express';
import { accountKey, admitRequest } from '../http/rateLimit';
import { clientAddressKey } from '../http/clientAddress';
import { staffSessionOf } from './staffSession';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function expectedOrigins(req: Request) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwarded || req.protocol;
  const currentOrigin = `${protocol}://${req.get('host')}`;
  const configuredOrigin = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
  return new Set([currentOrigin, ...(configuredOrigin ? [configuredOrigin] : [])]);
}

export async function enforceAdminSecurity(req: Request, res: Response, next: NextFunction) {
  try {
    // A signed-in staff member is counted against their own allowance; everything
    // else here — the public catalogue, staff sign-in — against its address.
    const staff = await staffSessionOf(req);
    const admitted = staff ? await admitRequest(res, accountKey(staff.userId), 'staff_api') : await admitRequest(res, clientAddressKey(req), 'admin_anonymous');
    if (!admitted) return;

    if (STATE_CHANGING_METHODS.has(req.method)) {
      const allowed = expectedOrigins(req);
      const origin = req.headers.origin;
      if (origin && !allowed.has(origin)) {
        return res.status(403).json({ error: 'Cross-site request blocked.' });
      }

      if (!origin) {
        const referer = req.headers.referer;
        if (referer) {
          try {
            if (!allowed.has(new URL(referer).origin)) {
              return res.status(403).json({ error: 'Cross-site request blocked.' });
            }
          } catch {
            return res.status(403).json({ error: 'Cross-site request blocked.' });
          }
        }
      }
    }

    return next();
  } catch (error) {
    // Only the session store or the rate limiter can throw here, and only when
    // storage fails. That is not the caller exceeding a limit, so the API error
    // boundary answers it.
    return next(error);
  }
}
