import { Request, Response, NextFunction } from 'express';
import { requestRateLimitService } from '../services/requestRateLimitService';

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
    const ip = String(req.ip || req.socket.remoteAddress || 'unknown');
    const limiter = await requestRateLimitService.check(`admin:${ip}`, 'api_global');
    if (!limiter.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(limiter.retryAfterMs / 1000))));
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

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
  } catch {
    return res.status(429).json({ error: 'Request could not be validated.' });
  }
}
