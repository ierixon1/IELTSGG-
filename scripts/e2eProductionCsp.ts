/**
 * M2 in a real browser: the production Content Security Policy does not break the
 * built app.
 *
 *   npm run build && npm run e2e:production-csp -- [--browser=chrome|edge]
 *
 * Starts the built `dist/server.cjs` with NODE_ENV=production and a complete
 * placeholder configuration — Firestore unreachable and email never sent, as in
 * `verify:production-install` — and opens it in headless Chromium: the landing page,
 * then the product, which shows its sign-in screen once the session check fails. The
 * run fails on any CSP violation the browser reports, on a script or stylesheet of
 * the app that does not load, or on a page that does not render.
 *
 * Signed-in screens are not reached: without Firestore there is no session. They use
 * the same bundle, styles and fonts, and no inline script.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, type LaunchedBrowser } from './e2e/cdp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = process.argv.slice(2).find((arg) => arg.startsWith('--browser='))?.slice('--browser='.length) ?? 'chrome';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const results: Array<{ check: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): boolean {
  results.push({ check: name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(label: string, probe: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // Not yet.
    }
    await sleep(250);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}.`);
}

async function main() {
  if (!existsSync(path.join(ROOT, 'dist', 'server.cjs'))) {
    check('dist/server.cjs exists', false, 'run npm run build first');
    process.exit(1);
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(FIREBASE_|GOOGLE_|GCLOUD|GCS_|FIRESTORE_|GEMINI_|GRADING_|SEED_|ADMIN_)|^(NODE_OPTIONS|STORAGE_BACKEND|EXPLICIT_DEV_AUTH|TRUST_PROXY|PORT|APP_URL|RESEND_API_KEY|EMAIL_FROM)$/i.test(key)) delete env[key];
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  let browser: LaunchedBrowser | null = null;
  let output = '';
  try {
    server = spawn(process.execPath, ['dist/server.cjs'], {
      cwd: ROOT,
      env: { ...env, NODE_ENV: 'production', PORT: String(port), TRUST_PROXY: '1', STORAGE_BACKEND: 'gcs_firestore', GCS_BUCKET_NAME: 'everstudy-cspcheck-unreachable', RESEND_API_KEY: 're_cspcheck_placeholder', EMAIL_FROM: 'Ever Study <no-reply@cspcheck.invalid>', APP_URL: 'https://cspcheck.invalid' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (chunk) => (output += String(chunk)));
    server.stderr?.on('data', (chunk) => (output += String(chunk)));
    await waitFor('the built server to answer', async () => (await fetch(`${origin}/`, { signal: AbortSignal.timeout(5_000) })).status === 200, 90_000);

    browser = await launchBrowser(BROWSER);
    console.log(`Browser: ${browser.version}, headless, throwaway profile`);
    const page = browser.page;
    const failedLoads: string[] = [];
    const types = new Map<string, { url: string; type: string }>();
    let documentCsp = '';
    page.on('Network.requestWillBeSent', (params) => types.set(String(params.requestId), { url: String((params.request as { url: string }).url), type: String(params.type) }));
    page.on('Network.responseReceived', (params) => {
      const response = params.response as { url: string; status: number; headers: Record<string, string> };
      if (params.type === 'Document' && response.url.startsWith(origin)) documentCsp = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-security-policy')?.[1] ?? '';
      if ((params.type === 'Script' || params.type === 'Stylesheet') && response.url.startsWith(origin) && response.status >= 400) failedLoads.push(`${response.status} ${response.url}`);
    });
    page.on('Network.loadingFailed', (params) => {
      const request = types.get(String(params.requestId));
      if (request && (request.type === 'Script' || request.type === 'Stylesheet' || request.type === 'Font')) failedLoads.push(`${String(params.errorText)} ${request.type} ${request.url}${params.blockedReason ? ` (${String(params.blockedReason)})` : ''}`);
    });
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Network.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__cspViolations = []; document.addEventListener('securitypolicyviolation', (event) => window.__cspViolations.push(event.violatedDirective + ' ' + (event.blockedURI || 'inline') + ' ' + (event.sourceFile || '') + ':' + event.lineNumber));` });

    await page.send('Page.navigate', { url: `${origin}/` });
    const landing = await waitFor('the landing page to render', async () => {
      const length = await page.evaluate<number>(`document.getElementById('root') ? document.getElementById('root').innerText.length : 0`);
      return length > 200 ? length : null;
    }, 60_000).catch(() => 0);
    check('the production document carries the CSP', documentCsp.includes("script-src 'self'") && documentCsp.includes("frame-ancestors 'none'"), documentCsp);
    check('the built landing page renders under the CSP', landing > 200, `${landing} characters of text`);

    await page.evaluate(`window.location.hash = '#/app'`);
    const signIn = await waitFor('the sign-in screen', async () => (await page.evaluate<boolean>(`!!document.querySelector('input[type="password"]')`)) || null, 60_000).catch(() => false);
    check('the product shell reaches its sign-in screen under the CSP', signIn === true);
    await sleep(1_500);

    const violations = await page.evaluate<string[]>(`window.__cspViolations || []`);
    check('the browser reported no CSP violation', violations.length === 0, violations.join(' | '));
    const ownFailures = failedLoads.filter((entry) => entry.includes(origin));
    check("every one of the app's scripts and stylesheets loaded", ownFailures.length === 0, ownFailures.join(' | '));
    const fontFailures = failedLoads.filter((entry) => !entry.includes(origin));
    if (fontFailures.length) console.log(`      note: third-party loads failed (network, not CSP unless a violation is listed above): ${fontFailures.join(' | ')}`);
  } catch (error) {
    check('the run completed', false, error instanceof Error ? error.message : String(error));
    console.log(output.split('\n').slice(-30).join('\n'));
  } finally {
    await browser?.close().catch(() => undefined);
    if (server && server.exitCode === null) {
      server.kill();
      await new Promise((resolve) => server?.once('exit', resolve));
    }
  }
  const failures = results.filter((result) => !result.ok);
  console.log(`\nRESULT  ${results.length - failures.length}/${results.length} checks passed in ${BROWSER}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
