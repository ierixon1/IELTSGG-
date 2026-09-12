import type { Express, NextFunction, Request, Response, Router } from 'express';

/**
 * Express 4 ignores what a handler returns. An `async` handler that throws
 * leaves a rejected promise nothing is waiting for: the request never gets an
 * answer, and Node's default for an unhandled rejection is to exit — which is
 * how one malformed material id used to take the whole server down (H1).
 *
 * `guardAsyncHandlers` is applied where an app or router is created. Every
 * handler registered through it afterwards has a returned promise's rejection
 * passed to `next`, where the API error boundary answers it. A handler that
 * returns no promise is unaffected, a synchronous throw was already caught by
 * Express, and an error handler keeps its four parameters, which is how Express
 * tells it apart.
 *
 * It covers registrations made through the guarded object's own methods.
 * `router.route(path)` chains are not used in this app and are not covered.
 */

type RequestHandler = (req: Request, res: Response, next: NextFunction) => unknown;
type ErrorHandler = (error: unknown, req: Request, res: Response, next: NextFunction) => unknown;

const REGISTRATION_METHODS = ['use', 'all', 'get', 'post', 'put', 'patch', 'delete'] as const;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

function forwardRejection(result: unknown, next: NextFunction): void {
  if (!isPromiseLike(result)) return;
  result.then(undefined, (reason: unknown) => {
    // `next('route')` and `next('router')` mean something to Express, and `next()`
    // with nothing means "carry on": only an Error is ever passed on.
    next(reason instanceof Error ? reason : new Error(`A route handler rejected with a non-Error value: ${String(reason)}`));
  });
}

function guard(entry: unknown): unknown {
  if (Array.isArray(entry)) return entry.map(guard);
  // A router or an app (anything with `handle`) dispatches to its own handlers,
  // which are guarded where that router was created.
  if (typeof entry !== 'function' || 'handle' in entry) return entry;
  if (entry.length === 4) {
    const handler = entry as unknown as ErrorHandler;
    return (error: unknown, req: Request, res: Response, next: NextFunction) => forwardRejection(handler(error, req, res, next), next);
  }
  const handler = entry as unknown as RequestHandler;
  return (req: Request, res: Response, next: NextFunction) => forwardRejection(handler(req, res, next), next);
}

export function guardAsyncHandlers<T extends Express | Router>(target: T): T {
  for (const method of REGISTRATION_METHODS) {
    const register = (target[method] as unknown as (...args: unknown[]) => unknown).bind(target);
    Object.defineProperty(target, method, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => register(...args.map(guard)),
    });
  }
  return target;
}
