import type { NextFunction, Request, Response } from 'express';
import { staffSessionOf } from '../middleware/staffSession';
import { requestIdOf } from './requestId';

/**
 * An audit line for every state-changing request to the admin API (M7).
 *
 * Written when the response has been sent, one JSON object per line on stdout,
 * where a platform's log collector keeps it:
 *
 *   {"type":"admin_audit","at":…,"requestId":…,"actor":{"userId","role"}|null,
 *    "method":"POST","route":"/api/admin/materials/:section/:id/:action(…)",
 *    "params":{…},"status":200,"subject":"<username, staff sign-in only>"}
 *
 * The actor is the staff session the request was made with — resolved once per
 * request (`staffSessionOf`), never from anything the client names. A refused
 * request is recorded too, with its status and a null actor when there was no
 * staff session. No request body is logged; staff sign-in records only the
 * username it tried, never a password.
 *
 * It replaces `auditLogService`, which was never called and wrote to a local file
 * a production (Firestore) deployment does not keep.
 */

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AdminAuditRecord {
  type: 'admin_audit';
  at: string;
  requestId?: string;
  actor: { userId: string; role: string } | null;
  method: string;
  route: string;
  params: Record<string, string>;
  status: number;
  subject?: string;
}

export function adminAuditTrail(write: (line: string) => void = (line) => console.info(line)) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!STATE_CHANGING.has(req.method)) {
      next();
      return;
    }
    res.on('finish', () => {
      const route = `${req.baseUrl}${typeof req.route?.path === 'string' ? req.route.path : req.path}`;
      const params = { ...req.params };
      const status = res.statusCode;
      const body = req.body as { username?: unknown } | undefined;
      const subject = req.path === '/login' && typeof body?.username === 'string' ? body.username.trim().toLowerCase().slice(0, 64) : undefined;
      void staffSessionOf(req)
        .catch(() => null)
        .then((session) => {
          const record: AdminAuditRecord = {
            type: 'admin_audit',
            at: new Date().toISOString(),
            requestId: requestIdOf(req),
            actor: session ? { userId: session.userId, role: session.role } : null,
            method: req.method,
            route,
            params,
            status,
            ...(subject ? { subject } : {}),
          };
          write(JSON.stringify(record));
        });
    });
    next();
  };
}
