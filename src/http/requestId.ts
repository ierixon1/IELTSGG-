import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * A request id for every request (M7): generated here, never taken from the
 * client (a caller-chosen id could forge or collide with log lines), answered in
 * `X-Request-Id`, and written on the error boundary's and the audit trail's log
 * lines, so one failure can be traced from a user's report to the server log.
 */

type RequestWithId = Request & { requestId?: string };

export function assignRequestId(req: Request, res: Response, next: NextFunction): void {
  const id = randomUUID();
  (req as RequestWithId).requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

export const requestIdOf = (req: Request): string | undefined => (req as RequestWithId).requestId;
