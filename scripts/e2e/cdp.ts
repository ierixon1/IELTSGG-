/**
 * A small Chrome DevTools Protocol client for the browser checks in `scripts/`.
 *
 * It drives a Chromium browser already installed on the machine — Chrome or Edge —
 * over Node's own WebSocket, so nothing is downloaded. The browser runs headless
 * with a throwaway profile: no personal browser data, cookies or extensions are
 * touched, and the profile is deleted afterwards.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BROWSER_EXECUTABLES: Record<string, string[]> = {
  chrome: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ],
  edge: [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/microsoft-edge',
  ],
};

type Params = Record<string, unknown>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Params) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Map<string, Array<(params: Params) => void>>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: Params; error?: { message: string }; method?: string; params?: Params };
      if (message.id !== undefined) {
        const waiting = this.pending.get(message.id);
        if (!waiting) return;
        this.pending.delete(message.id);
        if (message.error) waiting.reject(new Error(message.error.message));
        else waiting.resolve(message.result ?? {});
        return;
      }
      if (message.method) for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
  }

  static async connect(url: string): Promise<CdpSession> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`Could not connect to ${url}`)), { once: true });
    });
    return new CdpSession(socket);
  }

  send<T = Params>(method: string, params: Params = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: Params) => void): void {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }

  /** Evaluates `expression` in the page as a user gesture, awaiting a promise, and returns its value. */
  async evaluate<T>(expression: string): Promise<T> {
    const reply = await this.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (reply.exceptionDetails) throw new Error(`Page script failed: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
    return reply.result.value as T;
  }

  close(): void {
    this.socket.close();
  }
}

export interface LaunchedBrowser {
  name: string;
  executable: string;
  version: string;
  page: CdpSession;
  close(): Promise<void>;
}

export async function launchBrowser(name: string): Promise<LaunchedBrowser> {
  const candidates = BROWSER_EXECUTABLES[name] ?? [];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error(`No ${name} executable found (looked in: ${candidates.join(', ') || 'nowhere — unknown browser'}).`);
  const profile = mkdtempSync(path.join(os.tmpdir(), `everstudy-e2e-${name}-`));
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = 0;
  for (const deadline = Date.now() + 30_000; Date.now() < deadline && port === 0; await sleep(100)) {
    if (existsSync(portFile)) port = Number(readFileSync(portFile, 'utf8').split('\n')[0]) || 0;
  }
  if (port === 0) {
    child.kill();
    throw new Error(`${name} did not open its DevTools port within 30 s.`);
  }

  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { Browser?: string; webSocketDebuggerUrl?: string };
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const target = targets.find((entry) => entry.type === 'page');
  if (!target) throw new Error(`${name} opened no page target.`);
  const page = await CdpSession.connect(target.webSocketDebuggerUrl);

  return {
    name,
    executable,
    version: version.Browser ?? 'unknown',
    page,
    async close() {
      page.close();
      if (version.webSocketDebuggerUrl) {
        try {
          const browser = await CdpSession.connect(version.webSocketDebuggerUrl);
          await Promise.race([browser.send('Browser.close'), sleep(3000)]);
          browser.close();
        } catch {
          // Already gone.
        }
      }
      child.kill();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          rmSync(profile, { recursive: true, force: true });
          return;
        } catch {
          await sleep(250);
        }
      }
      console.warn(`note: could not remove the browser profile ${profile}`);
    },
  };
}
