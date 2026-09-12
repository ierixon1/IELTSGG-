/**
 * What the process does with a promise rejection no code is waiting for.
 *
 * Node's default is to exit. The app's own handlers no longer produce such
 * rejections — `guardAsyncHandlers` hands theirs to the API error boundary — so
 * what still arrives here comes from libraries. The Firestore client is the one
 * found: with no usable credentials it creates promises for its own connection
 * setup that nothing awaits, and each rejects on its own, seconds before the call
 * that is actually waiting receives the same error. Exiting on the first of those
 * dropped every request in flight over one misconfigured call.
 *
 * So a stray rejection is logged and the process keeps serving; the request that
 * caused it still gets its own answer through the boundary. An uncaught
 * *exception* keeps Node's default: after a synchronous throw outside any handler
 * the process's state is unknown, and a restart is the safe response.
 */
let installed = false;

export function installProcessGuards(): void {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (reason) => {
    console.error('[Process] Unhandled promise rejection; no request is waiting on it, and the server keeps running:', reason);
  });
}
