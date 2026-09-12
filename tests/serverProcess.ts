import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { removeTempRoot } from './tempDir';

/**
 * Runs the real `server.ts` — the file `npm run dev` runs, with every route,
 * middleware and guard it registers — in a child process. A request that
 * crashes the server crashes the child, not the test runner, and the test can
 * see that it happened.
 *
 * `server.ts` listens on port 3000 and Vite's HMR socket on 24678. A preload
 * moves both to free ports, so the suite needs neither port, cannot collide
 * with a running dev server or with itself, and learns the port the app got.
 * Nothing in `server.ts` is changed for the test.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX_DIST = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist');

const PRELOAD = `
import net from 'node:net';
const APP_PORT = 3000;
const HMR_PORT = 24678;
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const requested = typeof args[0] === 'object' && args[0] !== null ? args[0].port : args[0];
  if (requested === APP_PORT || requested === HMR_PORT) {
    args[0] = typeof args[0] === 'object' ? { ...args[0], port: 0 } : 0;
    if (requested === APP_PORT) this.once('listening', () => process.stdout.write('TEST_SERVER_PORT=' + this.address().port + '\\n'));
  }
  return listen.apply(this, args);
};
`;

/** Inherited variables that would point the child at real services, or change what it is. */
const STRIPPED = [
  'GEMINI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  'GCS_BUCKET_NAME',
  'STORAGE_BACKEND',
  'NODE_ENV',
  'NODE_OPTIONS',
  'NODE_TEST_CONTEXT',
  'SEED_DEFAULT_ACCOUNTS',
  'ADMIN_USER',
  'ADMIN_PASSWORD',
  'EXPLICIT_DEV_AUTH',
];

export interface ServerProcess {
  readonly origin: string;
  /** Everything the child has written to stdout and stderr. */
  output(): string;
  /** Null while the process is running; how it ended once it has exited. */
  exit(): { code: number | null; signal: NodeJS.Signals | null } | null;
  stop(): Promise<void>;
}

export async function startServer(env: Record<string, string>, timeoutMs = 120_000): Promise<ServerProcess> {
  // Canonical paths: on Windows the temp directory can come back in its 8.3 short
  // form, and Vite refuses to serve files whose real path does not start with its root.
  const cwd = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'everstudy-server-')));
  const home = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'everstudy-server-home-')));
  const preload = path.join(home, 'ephemeral-port.mjs');
  writeFileSync(preload, PRELOAD, 'utf8');
  // Vite serves the app shell from the working directory; a page there lets a
  // test see the server answer a request that needs no API.
  writeFileSync(path.join(cwd, 'index.html'), '<!doctype html><html><head><title>Ever Study</title></head><body><div id="root"></div></body></html>', 'utf8');

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of STRIPPED) delete childEnv[name];
  // Application default credentials are looked up under these; an empty
  // directory means none can be found on this machine.
  Object.assign(childEnv, { APPDATA: home, HOME: home, CLOUDSDK_CONFIG: home }, env);

  const child = spawn(
    process.execPath,
    [
      '--require',
      path.join(TSX_DIST, 'preflight.cjs'),
      '--import',
      pathToFileURL(path.join(TSX_DIST, 'loader.mjs')).href,
      '--import',
      pathToFileURL(preload).href,
      path.join(REPO_ROOT, 'server.ts'),
    ],
    { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let output = '';
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const exited = new Promise<void>((resolve) => {
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      resolve();
    });
  });
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output += String(chunk);
  });

  const cleanUp = () => {
    removeTempRoot(cwd);
    removeTempRoot(home);
  };

  let port: number;
  try {
    port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server.ts did not start within ${timeoutMs} ms:\n${output}`)), timeoutMs);
      const poll = setInterval(() => {
        const match = /TEST_SERVER_PORT=(\d+)/.exec(output);
        if (match) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve(Number(match[1]));
        } else if (exit) {
          clearInterval(poll);
          clearTimeout(timer);
          reject(new Error(`server.ts exited (${JSON.stringify(exit)}) before listening:\n${output}`));
        }
      }, 50);
    });
  } catch (error) {
    if (!exit) child.kill();
    await exited;
    cleanUp();
    throw error;
  }

  return {
    origin: `http://127.0.0.1:${port}`,
    output: () => output,
    exit: () => exit,
    async stop() {
      if (!exit) child.kill();
      await exited;
      cleanUp();
    },
  };
}
