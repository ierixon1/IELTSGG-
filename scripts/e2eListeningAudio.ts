/**
 * H8 in a real browser: an exam Listening recording, end to end.
 *
 *   npm run e2e:listening-audio -- [--browser=chrome|edge]
 *
 * Runs the real `server.ts` (local storage, Vite serving the real app) and a
 * headless Chromium browser (scripts/e2e/cdp.ts), and plays the recordings of a
 * published exam the way a learner does: through the exam screen's own buttons.
 *
 *   A  part 1 — playback starts, the recording is fetched by byte range, the part
 *      is recorded as heard only once it plays, it plays to the end, and it cannot
 *      be played again: not from the button, not through the session API;
 *   B  part 2 — its recording fails to load (the connection is refused), so
 *      playback fails: the part stays playable and nothing is recorded as heard;
 *      once the network is back it plays;
 *   C  part 3 — the page is reloaded while it plays: after the reload the part is
 *      heard and cannot be played again;
 *   D  from the page: Range, If-Range with the current and a stale ETag, an
 *      unsatisfiable range, another range unit; the published recording is served;
 *      an imported page's untouched original, its derived copy, an unknown id and
 *      the staff asset route are refused to the learner.
 *
 * The run needs an empty store, so `data/` is moved aside first and put back
 * afterwards, and the script checks every file is byte-identical to before. The
 * learner and staff accounts it signs in with exist only in that temporary store.
 * Safari and iOS are not covered: this drives Chromium only.
 *
 * Exits 0 when every check passes, 1 otherwise.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser, type CdpSession, type LaunchedBrowser } from './e2e/cdp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX_DIST = path.join(ROOT, 'node_modules', 'tsx', 'dist');
const DATA = path.join(ROOT, 'data');
const args = process.argv.slice(2);
const BROWSER = args.find((arg) => arg.startsWith('--browser='))?.slice('--browser='.length) ?? 'chrome';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const results: Array<{ check: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): boolean {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
const note = (line: string) => console.log(`      ${line}`);

/* ---------------------------------------------------------------- the store */

function manifest(directory: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(directory)) return out;
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(directory, full)] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(directory);
  return out;
}

function removeWithRetries(target: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},250)']);
    }
  }
  rmSync(target, { recursive: true, force: true });
}

/* ------------------------------------------------------------ child processes */

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(FIREBASE_|GOOGLE_|GCLOUD|GCS_|FIRESTORE_|SEED_|ADMIN_|EXAMINER_)|^(TRUST_PROXY|PORT|NODE_ENV|STORAGE_BACKEND|EXPLICIT_DEV_AUTH|APP_URL|RESEND_API_KEY|EMAIL_FROM|NODE_OPTIONS)$/i.test(key)) delete env[key];
  }
  return { ...env, ...extra };
}

const tsxArgs = (script: string) => ['--require', path.join(TSX_DIST, 'preflight.cjs'), '--import', pathToFileURL(path.join(TSX_DIST, 'loader.mjs')).href, script];

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

async function waitFor<T>(label: string, probe: () => Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}${lastError ? ` (last error: ${lastError})` : ''}.`);
}

/* ---------------------------------------------------------------------- HTTP */

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: any;
  cookie: string;
}

async function api(origin: string, method: string, url: string, init: { cookie?: string; json?: unknown; form?: FormData } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.form) body = init.form;
  const response = await fetch(`${origin}${url}`, { method, headers, body, signal: AbortSignal.timeout(120_000) });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json, cookie: response.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ') };
}

/* ------------------------------------------------------------------ the page */

interface MediaRequest {
  id: string;
  url: string;
  range?: string;
  status?: number;
  contentRange?: string;
  failed?: string;
}

interface PartState {
  playback: string | null;
  heard: string | null;
  disabled: boolean | null;
  problem: string | null;
  label: string | null;
}

const byId = (id: string) => `document.getElementById(${JSON.stringify(id)})`;

class LearnerPage {
  readonly media: MediaRequest[] = [];
  failingUrlPart: string | null = null;

  constructor(readonly page: CdpSession) {
    const header = (headers: unknown, name: string) => {
      const entries = Object.entries((headers ?? {}) as Record<string, string>);
      return entries.find(([key]) => key.toLowerCase() === name)?.[1];
    };
    const find = (id: unknown) => this.media.find((entry) => entry.id === String(id));
    page.on('Network.requestWillBeSent', (params) => {
      const request = params.request as { url: string; headers: unknown };
      if (request.url.includes('/api/assets/')) this.media.push({ id: String(params.requestId), url: request.url, range: header(request.headers, 'range') });
    });
    page.on('Network.requestWillBeSentExtraInfo', (params) => {
      const entry = find(params.requestId);
      const range = header(params.headers, 'range');
      if (entry && range) entry.range = range;
    });
    page.on('Network.responseReceived', (params) => {
      const entry = find(params.requestId);
      const response = params.response as { status: number; headers: unknown };
      if (entry) {
        entry.status = response.status;
        entry.contentRange = header(response.headers, 'content-range') ?? entry.contentRange;
      }
    });
    page.on('Network.loadingFailed', (params) => {
      const entry = find(params.requestId);
      if (entry) entry.failed = String(params.errorText);
    });
    page.on('Fetch.requestPaused', (params) => {
      const request = params.request as { url: string };
      if (this.failingUrlPart && request.url.includes(this.failingUrlPart)) void page.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'ConnectionRefused' });
      else void page.send('Fetch.continueRequest', { requestId: params.requestId });
    });
  }

  async start(origin: string, sessionToken: string) {
    await this.page.send('Page.enable');
    await this.page.send('Runtime.enable');
    await this.page.send('Network.enable');
    await this.page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/assets/*', requestStage: 'Request' }] });
    await this.page.send('Network.setCookie', { name: 'prep_auth', value: sessionToken, url: origin, httpOnly: true, sameSite: 'Strict' });
  }

  exists = (id: string) => this.page.evaluate<boolean>(`!!${byId(id)}`);
  click = (id: string) =>
    this.page.evaluate<string>(`(() => { const el = ${byId(id)}; if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'clicked'; })()`);
  attribute = (id: string, name: string) => this.page.evaluate<string | null>(`(() => { const el = ${byId(id)}; return el ? el.getAttribute(${JSON.stringify(name)}) : null; })()`);
  part = (part: number) =>
    this.page.evaluate<PartState>(
      `(() => { const box = document.querySelector('[data-audio-part="${part}"]'); const button = ${byId(`btn-play-listening-part-${part}`)}; const problem = ${byId(`listening-audio-problem-${part}`)};` +
        ` return { playback: box ? box.getAttribute('data-playback') : null, heard: box ? box.getAttribute('data-heard') : null, disabled: button ? button.disabled : null, problem: problem ? problem.getAttribute('data-problem') : null, label: button ? button.textContent.trim() : null }; })()`,
    );
  audio = (part: number) =>
    this.page.evaluate<{ paused: boolean; ended: boolean; currentTime: number; duration: number; error: number | null; networkState: number } | null>(
      `(() => { const a = ${byId(`listening-audio-part-${part}`)}; return a ? { paused: a.paused, ended: a.ended, currentTime: a.currentTime, duration: a.duration, error: a.error ? a.error.code : null, networkState: a.networkState } : null; })()`,
    );

  async navigate(url: string) {
    await this.page.send('Page.navigate', { url });
  }

  async reload() {
    await this.page.send('Page.reload', { ignoreCache: false });
  }

  /** From the app shell to the Listening section of the bundle's exam. Returns the session id when a new sitting is started. */
  async openExam(bundleId: string, startNew: boolean): Promise<string | null> {
    await waitFor('the app to load and show the exam tab', () => this.exists('nav-tab-exam'), 240_000, 500);
    await this.click('nav-tab-exam');
    await waitFor('the exam catalogue to list the bundle', () => this.exists(`btn-open-exam-${bundleId}`), 60_000);
    await this.click(`btn-open-exam-${bundleId}`);
    let sessionId: string | null = null;
    if (startNew) {
      await waitFor('the ready screen', () => this.exists('btn-start-exam'), 60_000);
      sessionId = await this.attribute('exam-ready', 'data-session-id');
      await this.click('btn-start-exam');
    }
    await waitFor('the Listening section', () => this.exists('btn-listen-part-1'), 60_000);
    return sessionId;
  }

  async selectPart(part: number) {
    await this.click(`btn-listen-part-${part}`);
    await waitFor(`part ${part} to be shown`, async () => (await this.part(part)).playback !== null, 10_000);
  }

  waitForPlayback(part: number, states: string[], timeoutMs: number) {
    return waitFor(`part ${part} to reach ${states.join(' or ')}`, async () => {
      const state = await this.part(part);
      return state.playback !== null && states.includes(state.playback) ? state : null;
    }, timeoutMs);
  }
}

/* ---------------------------------------------------------------------- run */

async function main() {
  const before = manifest(DATA);
  const backup = `${DATA}.e2e-backup-${Date.now()}`;
  if (existsSync(DATA)) renameSync(DATA, backup);
  console.log(`H8 browser verification — moved data/ aside to ${path.basename(backup)} (${Object.keys(before).length} files)`);

  let server: ChildProcess | null = null;
  let browser: LaunchedBrowser | null = null;
  let serverOutput = '';
  try {
    /* Seed the published exam content. */
    const seeded = spawnSync(process.execPath, tsxArgs('scripts/seedExamFixture.ts'), { cwd: ROOT, encoding: 'utf8', env: cleanEnv({ STORAGE_BACKEND: 'local' }), timeout: 180_000 });
    if (seeded.status !== 0) throw new Error(`seed:exam-fixture failed (${seeded.status}):\n${seeded.stdout}\n${seeded.stderr}`);
    const fixture = JSON.parse(seeded.stdout.slice(seeded.stdout.indexOf('{'))) as { materials: Array<{ slot: string; id: string; audioAssetId?: string }> };
    const audio: Record<number, string> = {};
    for (const material of fixture.materials) if (material.audioAssetId) audio[Number(material.slot.split('-')[1])] = material.audioAssetId;
    check('exam fixture seeded', Object.keys(audio).length === 4, `${fixture.materials.length} published materials, 4 recordings`);

    /* The real server. */
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const adminUser = 'e2e_audio_admin';
    const adminPassword = `E2e-${randomBytes(12).toString('hex')}-A1`;
    server = spawn(process.execPath, tsxArgs('server.ts'), {
      cwd: ROOT,
      env: cleanEnv({ STORAGE_BACKEND: 'local', NODE_ENV: 'development', PORT: String(port), DISABLE_HMR: 'true', SEED_DEFAULT_ACCOUNTS: 'true', ADMIN_USER: adminUser, ADMIN_PASSWORD: adminPassword }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (chunk) => (serverOutput = (serverOutput + String(chunk)).slice(-20_000)));
    server.stderr?.on('data', (chunk) => (serverOutput = (serverOutput + String(chunk)).slice(-20_000)));
    await waitFor('server.ts to answer /api/health', async () => (await api(origin, 'GET', '/api/health')).status === 200, 180_000, 500);
    check('server.ts started on the PORT it was given', true, origin);

    /* Staff: publish a bundle, and import a page whose original must stay private. */
    const staff = await api(origin, 'POST', '/api/admin/login', { json: { username: adminUser, password: adminPassword } });
    if (staff.status !== 200) throw new Error(`staff sign-in failed: ${staff.status} ${staff.text}`);
    const candidates = (await api(origin, 'GET', '/api/admin/bundles/candidates', { cookie: staff.cookie })).json.candidates as Array<{ id: string; contentHash: string }>;
    const slots: Array<[string, number]> = [['listening', 1], ['listening', 2], ['listening', 3], ['listening', 4], ['reading', 1], ['reading', 2], ['reading', 3], ['writing', 1], ['speaking', 1]];
    const components = slots.map(([section, part]) => {
      const materialId = fixture.materials.find((material) => material.slot === (section === 'writing' || section === 'speaking' ? section : `${section}-${part}`))?.id ?? '';
      return { section, part, materialId, contentHash: candidates.find((candidate) => candidate.id === materialId)?.contentHash ?? '' };
    });
    const timing = { listeningMinutes: 20, readingMinutes: 20, writingMinutes: 20, speakingMinutes: 5, basis: 'custom', allowEarlyFinish: true };
    const created = await api(origin, 'POST', '/api/admin/bundles', { cookie: staff.cookie, json: { title: 'E2E Audio Exam', module: 'academic', components, timing } });
    const bundleId = String(created.json?.bundle?.id ?? '');
    const published = await api(origin, 'POST', `/api/admin/bundles/${bundleId}/publish`, { cookie: staff.cookie });
    if (!check('bundle created and published', created.status === 201 || created.status === 200 ? published.status === 200 : false, `${created.status} / ${published.status} ${published.status === 200 ? '' : published.text.slice(0, 300)}`)) throw new Error('No published bundle to sit.');

    const form = new FormData();
    form.append('file', new Blob(['<!DOCTYPE html><html><body><h1>Answer key</h1><p>1 saturday</p></body></html>'], { type: 'text/html' }), 'imported-page.html');
    const imported = await api(origin, 'POST', '/api/admin/upload', { cookie: staff.cookie, form });
    const originalId = String(imported.json?.file?.sourceAssetId ?? '');
    const derivedId = String(imported.json?.file?.assetId ?? '');
    check('an HTML page imported, keeping a private original', imported.status === 200 && Boolean(originalId && derivedId), `original ${originalId}, derived ${derivedId}`);

    /* The learner. */
    const learnerName = `e2e_learner_${randomBytes(3).toString('hex')}`;
    const registered = await api(origin, 'POST', '/api/auth/register', { json: { email: `${learnerName}@example.com`, username: learnerName, password: `Learner-${randomBytes(8).toString('hex')}-1` } });
    const learnerCookie = registered.cookie;
    const sessionToken = learnerCookie.split('; ').find((pair) => pair.startsWith('prep_auth='))?.slice('prep_auth='.length) ?? '';
    const profile = await api(origin, 'PUT', '/api/data/profile', { cookie: learnerCookie, json: { targetBand: 7, currentLevel: 6, hoursPerWeek: 10, weakSection: 'listening', isOnboarded: true } });
    check('learner registered (in the temporary store) and onboarded', registered.status === 201 && profile.status === 200 && Boolean(sessionToken));

    /* The browser. */
    browser = await launchBrowser(BROWSER);
    console.log(`Browser: ${browser.version} (${browser.executable}), headless, throwaway profile`);
    const learner = new LearnerPage(browser.page);
    await learner.start(origin, sessionToken);
    // Part 2's recording will not load: the connection is refused.
    learner.failingUrlPart = `/api/assets/${audio[2]}`;
    await learner.navigate(`${origin}/#/app`);
    const sessionId = await learner.openExam(bundleId, true);
    if (!check('exam opened and started in the browser', Boolean(sessionId), `session ${sessionId}`)) throw new Error('No exam session.');
    const view = async () => (await api(origin, 'GET', `/api/learner/exams/${sessionId}`, { cookie: learnerCookie })).json;
    const listening = async () => ((await view())?.run?.sections?.listening ?? {}) as { audioStarted?: Record<string, number>; audioClaims?: Record<string, { claim: string; leaseUntil: number }> };

    /* A: part 1 plays once, by byte range, to the end, and not again. */
    await learner.selectPart(1);
    const idle = await learner.part(1);
    check('A  part 1 is playable before it starts', idle.playback === 'idle' && idle.heard === 'false' && idle.disabled === false, JSON.stringify(idle));
    check('A  nothing is recorded as heard before playback', (await listening()).audioStarted?.['1'] === undefined);
    check('A  the play button responds', (await learner.click('btn-play-listening-part-1')) === 'clicked');
    const started = await learner.waitForPlayback(1, ['playing', 'ended', 'failed'], 30_000);
    check('A  the recording starts playing', started.playback === 'playing' || started.playback === 'ended', JSON.stringify(started));
    const heardAt = await waitFor('the server to record part 1 as heard', async () => (await listening()).audioStarted?.['1'], 15_000);
    check('A  the session records part 1 as heard once it plays', typeof heardAt === 'number', `audioStarted[1] = ${heardAt}`);
    const ended = await learner.waitForPlayback(1, ['ended'], 30_000);
    const element1 = await learner.audio(1);
    check('A  the recording plays to its end', ended.playback === 'ended' && Boolean(element1?.ended), JSON.stringify(element1));
    check('A  after the end, the button is disabled and says so', ended.disabled === true && ended.heard === 'true', `label "${ended.label}"`);
    check('A  clicking again does nothing', (await learner.click('btn-play-listening-part-1')) === 'disabled');
    const replay = await api(origin, 'POST', `/api/learner/exams/${sessionId}/events`, { cookie: learnerCookie, json: { events: [{ type: 'audio_starting', part: 1, claim: 'e2e-replay-claim-0001' }] } });
    const afterReplay = (replay.json?.run?.sections?.listening ?? {}) as { audioStarted?: Record<string, number>; audioClaims?: Record<string, { claim: string }> };
    check('A  a new claim on part 1 through the session API is not granted', afterReplay.audioStarted?.['1'] === heardAt && afterReplay.audioClaims?.['1']?.claim !== 'e2e-replay-claim-0001', `${replay.status}; audioStarted[1] = ${afterReplay.audioStarted?.['1']}, claim = ${afterReplay.audioClaims?.['1']?.claim ?? 'none'}`);
    const part1Media = learner.media.filter((entry) => entry.url.includes(audio[1]));
    for (const entry of part1Media) note(`part 1 request: Range ${entry.range ?? '(none)'} → ${entry.status ?? '?'} ${entry.contentRange ?? ''}${entry.failed ? ` failed: ${entry.failed}` : ''}`);
    check('A  the browser fetched the recording by byte range (206 Partial Content)', part1Media.some((entry) => entry.status === 206 && (entry.contentRange ?? '').startsWith('bytes ') && Boolean(entry.range)), `${part1Media.length} request(s)`);

    /* B: part 2 fails to load; the part stays playable; it plays once the network is back. */
    await learner.selectPart(2);
    const failedLoad = await waitFor('part 2 to fail loading', async () => {
      const element = await learner.audio(2);
      return element && element.error !== null ? element : null;
    }, 30_000);
    note(`part 2 element after the refused load: ${JSON.stringify(failedLoad)}`);
    check('B  the play button responds', (await learner.click('btn-play-listening-part-2')) === 'clicked');
    const failed = await learner.waitForPlayback(2, ['failed', 'playing', 'ended'], 40_000);
    check('B  playback fails and says so', failed.playback === 'failed' && failed.problem !== null, JSON.stringify(failed));
    check('B  the part is still playable after the failure', failed.disabled === false && failed.heard === 'false');
    // The tab tells the server after the screen shows the failure; give that request time to land.
    const afterFailure = await waitFor('the server to release the claim on part 2', async () => {
      const state = await listening();
      return state.audioClaims?.['2'] === undefined ? state : null;
    }, 15_000).catch(async () => listening());
    check('B  nothing is recorded as heard, and the claim is released', afterFailure.audioStarted?.['2'] === undefined && afterFailure.audioClaims?.['2'] === undefined, JSON.stringify({ started: afterFailure.audioStarted?.['2'], claim: afterFailure.audioClaims?.['2'] }));
    learner.failingUrlPart = null;
    check('B  with the network back, the play button responds again', (await learner.click('btn-play-listening-part-2')) === 'clicked');
    const retried = await learner.waitForPlayback(2, ['playing', 'ended', 'failed'], 40_000);
    check('B  with the network back, playing again in the same tab works', retried.playback === 'playing' || retried.playback === 'ended', JSON.stringify(retried));
    if (retried.playback !== 'failed') {
      const heard2 = await waitFor('the server to record part 2 as heard', async () => (await listening()).audioStarted?.['2'], 15_000).catch(() => undefined);
      check('B  after the retry, part 2 is recorded as heard', typeof heard2 === 'number');
      // While one recording plays, no other part may start.
      await learner.selectPart(3);
      const stillPlaying = await learner.audio(2);
      if (stillPlaying && !stillPlaying.ended) {
        const blocked = await learner.part(3);
        check('B  while part 2 plays, part 3 cannot be started', blocked.disabled === true && (await learner.click('btn-play-listening-part-3')) === 'disabled', JSON.stringify(blocked));
      }
      await waitFor('part 2 to play to its end', async () => (await learner.audio(2))?.ended, 30_000);
      check('B  the retried recording plays to its end', Boolean((await learner.audio(2))?.ended));
    }

    /* C: reload while part 3 plays. */
    await learner.selectPart(3);
    await waitFor('part 3 to become playable', async () => (await learner.part(3)).disabled === false, 15_000);
    check('C  the play button responds', (await learner.click('btn-play-listening-part-3')) === 'clicked');
    const playing3 = await learner.waitForPlayback(3, ['playing', 'failed'], 30_000);
    check('C  part 3 is playing', playing3.playback === 'playing', JSON.stringify(playing3));
    await waitFor('the server to record part 3 as heard', async () => (await listening()).audioStarted?.['3'], 15_000);
    await learner.reload();
    await learner.openExam(bundleId, false);
    await learner.selectPart(3);
    const resumed3 = await waitFor('part 3 to show as heard after the reload', async () => {
      const state = await learner.part(3);
      return state.heard === 'true' ? state : null;
    }, 30_000);
    const element3 = await learner.audio(3);
    check('C  after a reload mid-playback the part is heard and cannot be played again', resumed3.disabled === true && (await learner.click('btn-play-listening-part-3')) === 'disabled', JSON.stringify(resumed3));
    check('C  after the reload nothing is playing', Boolean(element3?.paused), JSON.stringify(element3));
    await learner.selectPart(1);
    const part1AfterReload = await learner.part(1);
    check('C  part 1 stays heard after the reload', part1AfterReload.heard === 'true' && part1AfterReload.disabled === true);

    /* D: ranges, validators and access, from the learner's page. */
    const probes = await browser.page.evaluate<Record<string, { status: number; length?: number; contentRange?: string | null; etag?: string | null; acceptRanges?: string | null; cacheControl?: string | null }>>(`(async () => {
      const url = '/api/assets/${audio[4]}';
      const read = async (response) => ({ status: response.status, length: (await response.arrayBuffer()).byteLength, contentRange: response.headers.get('content-range'), etag: response.headers.get('etag'), acceptRanges: response.headers.get('accept-ranges'), cacheControl: response.headers.get('cache-control') });
      const out = {};
      out.whole = await read(await fetch(url, { cache: 'no-store' }));
      out.range = await read(await fetch(url, { cache: 'no-store', headers: { Range: 'bytes=0-99' } }));
      out.suffix = await read(await fetch(url, { cache: 'no-store', headers: { Range: 'bytes=-10' } }));
      out.ifRangeCurrent = await read(await fetch(url, { cache: 'no-store', headers: { Range: 'bytes=0-99', 'If-Range': out.range.etag } }));
      out.ifRangeStale = await read(await fetch(url, { cache: 'no-store', headers: { Range: 'bytes=0-99', 'If-Range': '"stale-validator"' } }));
      out.unsatisfiable = await read(await fetch(url, { cache: 'no-store', headers: { Range: 'bytes=99999999-' } }));
      out.otherUnit = await read(await fetch(url, { cache: 'no-store', headers: { Range: 'items=0-5' } }));
      out.original = await read(await fetch('/api/assets/${originalId}', { cache: 'no-store' }));
      out.derived = await read(await fetch('/api/assets/${derivedId}', { cache: 'no-store' }));
      out.unknown = await read(await fetch('/api/assets/ast_e2eDoesNotExist01', { cache: 'no-store' }));
      out.staffRoute = await read(await fetch('/api/admin/assets/${audio[4]}', { cache: 'no-store' }));
      return out;
    })()`);
    for (const [name, probe] of Object.entries(probes)) note(`${name}: ${JSON.stringify(probe)}`);
    const size = probes.whole?.length ?? 0;
    check('D  the published recording is served whole, advertising byte ranges', probes.whole?.status === 200 && size > 0 && probes.whole.acceptRanges === 'bytes' && Boolean(probes.whole.etag));
    check('D  Range bytes=0-99 → 206, 100 bytes, Content-Range', probes.range?.status === 206 && probes.range.length === 100 && probes.range.contentRange === `bytes 0-99/${size}`);
    check('D  a suffix range → 206, the last 10 bytes', probes.suffix?.status === 206 && probes.suffix.length === 10 && probes.suffix.contentRange === `bytes ${size - 10}-${size - 1}/${size}`);
    check('D  If-Range with the current ETag → 206', probes.ifRangeCurrent?.status === 206 && probes.ifRangeCurrent.length === 100);
    check('D  If-Range with a stale ETag → 200, the whole file', probes.ifRangeStale?.status === 200 && probes.ifRangeStale.length === size);
    check('D  an unsatisfiable range → 416 with Content-Range bytes */size', probes.unsatisfiable?.status === 416 && probes.unsatisfiable.contentRange === `bytes */${size}`);
    check('D  a range in another unit is ignored → 200, the whole file', probes.otherUnit?.status === 200 && probes.otherUnit.length === size);
    check("D  an imported page's untouched original is refused to the learner (404)", probes.original?.status === 404);
    check('D  an unpublished derived copy is refused to the learner (404)', probes.derived?.status === 404);
    check('D  an unknown asset id → 404', probes.unknown?.status === 404);
    check('D  the staff asset route is refused to a learner (403)', probes.staffRoute?.status === 403);
  } catch (error) {
    check('the run completed', false, error instanceof Error ? error.message : String(error));
    if (serverOutput) console.log(`--- server output (tail) ---\n${serverOutput.split('\n').slice(-40).join('\n')}`);
  } finally {
    await browser?.close().catch(() => undefined);
    if (server && server.exitCode === null) {
      server.kill();
      await new Promise((resolve) => server?.once('exit', resolve));
    }
    removeWithRetries(DATA);
    if (existsSync(backup)) renameSync(backup, DATA);
    const after = manifest(DATA);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]);
    check('data/ restored byte-identical', changed.length === 0, changed.length ? `differs: ${changed.join(', ')}` : `${Object.keys(after).length} files`);
  }

  const failures = results.filter((result) => !result.ok);
  console.log(`\nRESULT  ${results.length - failures.length}/${results.length} checks passed in ${BROWSER}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
