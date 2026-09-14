import type { Server } from 'node:http';

/**
 * What the server does when the platform stops it (Cloud Run, Kubernetes and
 * most process managers send SIGTERM and wait a few seconds before killing).
 *
 * Node's default is to exit at once, dropping every request in flight — an exam
 * answer being saved, a submission, a grading run. Instead the server stops
 * accepting connections, closes idle keep-alive connections, lets requests in
 * flight finish, and exits 0 — or exits 1 after `timeoutMs` if they have not.
 * A second signal while shutting down changes nothing.
 *
 * Returns the shutdown function, so it can be exercised without sending a signal
 * (Windows has no SIGTERM to deliver to a child process).
 */
export interface ShutdownOptions {
  timeoutMs?: number;
  signals?: NodeJS.Signals[];
  exit?: (code: number) => void;
  log?: (message: string) => void;
}

export const SHUTDOWN_TIMEOUT_MS = 10_000;

export function installGracefulShutdown(server: Server, options: ShutdownOptions = {}): (signal: string) => void {
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? ((message: string) => console.log(message));
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[Process] ${signal} received: no new connections; waiting up to ${timeoutMs} ms for requests in flight.`);
    const timer = setTimeout(() => {
      log('[Process] Requests were still in flight when the shutdown time ran out; exiting.');
      exit(1);
    }, timeoutMs);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      log('[Process] Every request finished; exiting.');
      exit(0);
    });
    server.closeIdleConnections();
  };

  for (const signal of options.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[])) process.once(signal, () => shutdown(signal));
  return shutdown;
}
