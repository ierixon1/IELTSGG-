/**
 * Final acceptance in a real browser: staff content, a realistic CDI import, and a
 * learner sitting a whole exam through the exam screen's own controls.
 *
 *   npm run e2e:exam-acceptance -- [--browser=chrome|edge]
 *
 * Runs the real `server.ts` (local storage, Vite serving the real app) with the
 * grading model replaced by a fixture (GRADING_FIXTURE_RESPONSE): every other part
 * of grading — the exam session, submission, the grading run, bands and the stored
 * attempt — is the production code. A headless Chromium browser (scripts/e2e/cdp.ts)
 * does what a learner does:
 *
 *   H  a real CDI Listening page from data/private_uploads is analysed by the import
 *      route and saved as a draft; it is not publishable without its recording and
 *      no learner can open it;
 *   O  the admin CMS shows the published materials, the draft and the exam bundle;
 *      a learner cannot read the admin API, and exam materials are not practice;
 *   J  the learner sits Listening (4 parts), Reading (3 passages, with a reload in
 *      the middle), Writing (2 tasks) and Speaking (3 parts), sees the result, and
 *      the stored attempt carries exactly the marks the answers earn.
 *
 * Accounts exist only in the temporary store the run creates; the browser gets their
 * session cookies, and no password is typed into it. `data/` is moved aside and
 * restored byte-identically, as in e2e:listening-audio.
 *
 * Exits 0 when every check passes, 1 otherwise.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser, type CdpSession, type LaunchedBrowser } from './e2e/cdp';
import { academicReadingRawToBand, listeningRawToBand, roundIeltsBand, speakingSectionBand, writingSectionBand } from '../src/utils/ieltsScoring';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX_DIST = path.join(ROOT, 'node_modules', 'tsx', 'dist');
const DATA = path.join(ROOT, 'data');
const args = process.argv.slice(2);
const BROWSER = args.find((arg) => arg.startsWith('--browser='))?.slice('--browser='.length) ?? 'chrome';
const BUNDLE_TITLE = 'E2E Acceptance Exam';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const results: Array<{ check: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): boolean {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/** A value inside parsed JSON, or undefined. */
const at = (value: unknown, ...keys: Array<string | number>): unknown =>
  keys.reduce<unknown>((current, key) => (current !== null && typeof current === 'object' ? (current as Record<string | number, unknown>)[key] : undefined), value);
const text = (value: unknown) => (typeof value === 'string' ? value : '');

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

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(FIREBASE_|GOOGLE_|GCLOUD|GCS_|FIRESTORE_|SEED_|ADMIN_|EXAMINER_|GEMINI_|GRADING_)|^(TRUST_PROXY|PORT|NODE_ENV|STORAGE_BACKEND|EXPLICIT_DEV_AUTH|APP_URL|RESEND_API_KEY|EMAIL_FROM|NODE_OPTIONS)$/i.test(key)) delete env[key];
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

interface Reply {
  status: number;
  text: string;
  json: unknown;
  cookie: string;
}

async function api(origin: string, method: string, url: string, init: { cookie?: string; json?: unknown } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  let body: string | undefined;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const response = await fetch(`${origin}${url}`, { method, headers, body, signal: AbortSignal.timeout(120_000) });
  const raw = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { status: response.status, text: raw, json, cookie: response.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ') };
}

/* ------------------------------------------------------------- the fixtures */

/** The answers the seeded exam expects (scripts/seedExamFixture.ts), and the ones this learner gets wrong. */
const LISTENING_KEY = [
  { q1: ['Which day is the free trial? Write ONE WORD.', 'saturday'], q2: ['How is the fee paid?', 'A monthly'] },
  { q1: ['Which floor has the map room? Write ONE WORD.', 'third'], q2: ['What must visitors leave at the desk?', 'B bags'] },
  { q1: ['What will the students measure first? Write ONE WORD.', 'temperature'], q2: ['When is the report due?', 'C Friday'] },
  { q1: ['In which season do colonies grow fastest? Write ONE WORD.', 'spring'], q2: ['What do rooftop hives need most?', 'A shelter'] },
];
const READING_KEY = [
  { q1: ['When do urban foxes mostly hunt? Write ONE WORD.', 'night'], q2: ['How long did the tracking study last?', 'B two years'], count: 13 },
  { q1: ['What did salt preserve? Write ONE WORD.', 'food'], q2: ['Who was sometimes paid in salt?', 'B soldiers'], count: 13 },
  { q1: ['During which kind of sleep does the brain replay the day? Write ONE WORD.', 'deep'], q2: ['Who recalls more of a word list?', 'A people who sleep'], count: 14 },
];
const WRONG = new Set(['e2e-lis-p4-q9', 'e2e-lis-p4-q10', 'e2e-rea-p3-q14']);

interface Answer {
  id: string;
  prompt: string;
  kind: 'text' | 'choice';
  value: string;
}

function listeningAnswers(part: number): Answer[] {
  const key = LISTENING_KEY[part - 1];
  const answers: Answer[] = [
    { id: `e2e-lis-p${part}-q1`, prompt: key.q1[0], kind: 'text', value: key.q1[1] },
    { id: `e2e-lis-p${part}-q2`, prompt: key.q2[0], kind: 'choice', value: key.q2[1] },
  ];
  for (let index = 3; index <= 10; index += 1) answers.push({ id: `e2e-lis-p${part}-q${index}`, prompt: `Fixture gap ${index}. Write ONE WORD.`, kind: 'text', value: `part${part}q${index}` });
  return answers.map((answer) => (WRONG.has(answer.id) ? { ...answer, value: 'wrong' } : answer));
}

function readingAnswers(part: number): Answer[] {
  const key = READING_KEY[part - 1];
  const answers: Answer[] = [
    { id: `e2e-rea-p${part}-q1`, prompt: key.q1[0], kind: 'text', value: key.q1[1] },
    { id: `e2e-rea-p${part}-q2`, prompt: key.q2[0], kind: 'choice', value: key.q2[1] },
  ];
  for (let index = 3; index <= key.count; index += 1) answers.push({ id: `e2e-rea-p${part}-q${index}`, prompt: `Fixture gap ${index}. Write ONE WORD.`, kind: 'text', value: `passage${part}q${index}` });
  return answers.map((answer) => (WRONG.has(answer.id) ? { ...answer, value: 'wrong' } : answer));
}

const criterion = (name: string, band: number) => ({ name, band, justification: 'Acceptance fixture.', improvement_tips: ['Keep practising.'] });
const WRITING_ASSESSMENT = {
  band_overall: 6.5,
  criteria: ['Task Achievement', 'Coherence and Cohesion', 'Lexical Resource', 'Grammatical Range and Accuracy'].map((name) => criterion(name, 6.5)),
  annotated_text: [],
  general_commentary: 'Acceptance fixture assessment.',
};
const SPEAKING_ASSESSMENT = {
  band_overall: 7,
  transcript: 'Acceptance fixture transcript.',
  criteria: { fluency_coherence: criterion('Fluency and Coherence', 7), lexical_resource: criterion('Lexical Resource', 7), grammatical_range: criterion('Grammatical Range and Accuracy', 7), pronunciation: criterion('Pronunciation', 7) },
  objective_metrics: { durationSeconds: 40, wordsPerMinute: 120, pausesCount: 1, totalPauseDurationSeconds: 1, fillerWords: [] },
  actionable_drills: ['Extend answers with a reason and an example.'],
};

const ESSAY_1 = 'The chart compares how commuters in one city travelled to work in 2000 and in 2020, by bus, by train and by bicycle. Overall, bus travel fell considerably over the period, while train and bicycle commuting both grew, so that by 2020 the three modes were far more evenly used than they had been twenty years earlier. In 2000 the bus was clearly the most common choice, carrying roughly half of all commuters, whereas the train accounted for about a third and cycling for only a small share. By 2020 the proportion travelling by bus had dropped to around a third. Train use rose steadily to become the most popular option, and the share of people cycling to work more than doubled, although it remained the least common of the three. In short, the city moved away from buses towards rail and bicycles.';
const ESSAY_2 = 'Some people argue that working from home will make city centres unnecessary, but I only partly agree with this view. It is true that many office tasks can now be done anywhere with a laptop and a reliable connection, and companies have discovered that they can save money by renting less space. As a result, some central districts have seen empty offices and fewer customers for nearby cafes and shops. However, I believe city centres will change rather than disappear. People still value meeting face to face, especially when they start a new job, solve complex problems or build trust with clients. City centres also offer theatres, museums, restaurants and public events that cannot be replaced by a video call. Many workers therefore prefer a hybrid pattern, coming into the centre two or three days a week. In conclusion, remote work will reduce the importance of the traditional office, but city centres will remain necessary as places for culture, collaboration and social life.';
const TRANSCRIPTS = [
  'My hometown is a small city by a river in the north. What I like most about it is that everyone knows each other and the old market is still busy every weekend.',
  'I want to describe a mountain village I visited two summers ago with my cousins. What surprised me was how quiet it was, and how the people there shared their food and stories with complete strangers like us.',
  'People travel abroad because they want to experience a different culture and escape their routine. Tourism has changed many cities, bringing money and jobs, but it has also made some neighbourhoods crowded and expensive for local residents.',
];

/* ------------------------------------------------------------------ the page */

const byId = (id: string) => `document.getElementById(${JSON.stringify(id)})`;

class Page {
  constructor(readonly page: CdpSession) {}

  exists = (id: string) => this.page.evaluate<boolean>(`!!${byId(id)}`);
  textOf = (id: string) => this.page.evaluate<string>(`(() => { const el = ${byId(id)}; return el ? el.textContent : ''; })()`);
  attribute = (id: string, name: string) => this.page.evaluate<string | null>(`(() => { const el = ${byId(id)}; return el ? el.getAttribute(${JSON.stringify(name)}) : null; })()`);
  click = (id: string) => this.page.evaluate<string>(`(() => { const el = ${byId(id)}; if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'clicked'; })()`);

  async waitClick(id: string, timeoutMs = 60_000) {
    await waitFor(`${id} to be enabled`, async () => (await this.page.evaluate<boolean>(`(() => { const el = ${byId(id)}; return !!el && !el.disabled; })()`)), timeoutMs);
    return this.click(id);
  }

  /** Types into a React-controlled text field or textarea the way an input event does. */
  setValue = (id: string, value: string) =>
    this.page.evaluate<string>(`(() => {
      const el = ${byId(id)};
      if (!el) return 'missing';
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'set';
    })()`);

  /** Answers the visible questions: text boxes found by their prompt, choices by the option printed beside them. */
  answer = (answers: Answer[]) =>
    this.page.evaluate<string[]>(`(() => {
      const problems = [];
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const answer of ${JSON.stringify(answers)}) {
        if (answer.kind === 'text') {
          const fields = [...document.querySelectorAll('input[type="text"]')].filter((el) => el.getAttribute('aria-label') === answer.prompt && visible(el));
          if (fields.length !== 1) { problems.push(answer.id + ': ' + fields.length + ' text fields'); continue; }
          setter.call(fields[0], answer.value);
          fields[0].dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          const options = [...document.querySelectorAll('input[type="radio"]')].filter((el) => el.name.endsWith('-' + answer.id) && el.parentElement && el.parentElement.textContent.trim() === answer.value);
          if (options.length !== 1) { problems.push(answer.id + ': ' + options.length + ' matching options'); continue; }
          options[0].click();
        }
      }
      return problems;
    })()`);

  fieldValue = (prompt: string) =>
    this.page.evaluate<string | null>(`(() => { const el = [...document.querySelectorAll('input[type="text"]')].find((field) => field.getAttribute('aria-label') === ${JSON.stringify(prompt)} && (field.offsetWidth || field.offsetHeight)); return el ? el.value : null; })()`);

  async openExam(bundleId: string, startNew: boolean, sectionReady: string): Promise<string | null> {
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
    await waitFor(`the section control ${sectionReady}`, () => this.exists(sectionReady), 60_000);
    return sessionId;
  }
}

/* ---------------------------------------------------------------------- run */

async function main() {
  const cdiFile = existsSync(path.join(DATA, 'private_uploads')) ? readdirSync(path.join(DATA, 'private_uploads')).find((name) => /^Listening_.*\.html$/i.test(name)) : undefined;
  const cdiPage = cdiFile ? readFileSync(path.join(DATA, 'private_uploads', cdiFile), 'utf8') : null;

  const before = manifest(DATA);
  const backup = `${DATA}.e2e-backup-${Date.now()}`;
  if (existsSync(DATA)) renameSync(DATA, backup);
  console.log(`Final acceptance — moved data/ aside to ${path.basename(backup)} (${Object.keys(before).length} files)`);
  const fixtureDirectory = mkdtempSync(path.join(os.tmpdir(), 'everstudy-acceptance-'));
  const gradingFixture = path.join(fixtureDirectory, 'grading-fixture.json');
  writeFileSync(gradingFixture, JSON.stringify({ fixtureScript: 1, steps: [{ byKind: { writing: WRITING_ASSESSMENT, speaking: SPEAKING_ASSESSMENT } }] }), 'utf8');

  let server: ChildProcess | null = null;
  let browser: LaunchedBrowser | null = null;
  let serverOutput = '';
  try {
    const seeded = spawnSync(process.execPath, tsxArgs('scripts/seedExamFixture.ts'), { cwd: ROOT, encoding: 'utf8', env: cleanEnv({ STORAGE_BACKEND: 'local' }), timeout: 180_000 });
    if (seeded.status !== 0) throw new Error(`seed:exam-fixture failed (${seeded.status}):\n${seeded.stdout}\n${seeded.stderr}`);
    const fixture = JSON.parse(seeded.stdout.slice(seeded.stdout.indexOf('{'))) as { materials: Array<{ slot: string; id: string; title: string }> };
    check('exam fixture seeded and published through the publish gate', fixture.materials.length === 9, `${fixture.materials.length} materials`);

    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const adminUser = 'e2e_acceptance_admin';
    const adminPassword = `E2e-${randomBytes(12).toString('hex')}-A1`;
    server = spawn(process.execPath, tsxArgs('server.ts'), {
      cwd: ROOT,
      env: cleanEnv({ STORAGE_BACKEND: 'local', NODE_ENV: 'development', PORT: String(port), DISABLE_HMR: 'true', SEED_DEFAULT_ACCOUNTS: 'true', ADMIN_USER: adminUser, ADMIN_PASSWORD: adminPassword, GRADING_FIXTURE_RESPONSE: gradingFixture }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (chunk) => (serverOutput = (serverOutput + String(chunk)).slice(-40_000)));
    server.stderr?.on('data', (chunk) => (serverOutput = (serverOutput + String(chunk)).slice(-40_000)));
    await waitFor('server.ts to answer /api/health', async () => (await api(origin, 'GET', '/api/health')).status === 200, 180_000, 500);
    check('server.ts started', true, origin);

    /* Staff: sign in over HTTP, build and publish the exam. */
    const staff = await api(origin, 'POST', '/api/admin/login', { json: { username: adminUser, password: adminPassword } });
    if (staff.status !== 200) throw new Error(`staff sign-in failed: ${staff.status} ${staff.text}`);
    const staffCookie = staff.cookie;
    const staffToken = staffCookie.split('; ').find((pair) => pair.startsWith('prep_admin_auth='))?.slice('prep_admin_auth='.length) ?? '';
    const candidates = (at((await api(origin, 'GET', '/api/admin/bundles/candidates', { cookie: staffCookie })).json, 'candidates') ?? []) as Array<{ id: string; contentHash: string }>;
    const slots: Array<[string, number]> = [['listening', 1], ['listening', 2], ['listening', 3], ['listening', 4], ['reading', 1], ['reading', 2], ['reading', 3], ['writing', 1], ['speaking', 1]];
    const components = slots.map(([section, part]) => {
      const materialId = fixture.materials.find((material) => material.slot === (section === 'writing' || section === 'speaking' ? section : `${section}-${part}`))?.id ?? '';
      return { section, part, materialId, contentHash: candidates.find((candidate) => candidate.id === materialId)?.contentHash ?? '' };
    });
    const timing = { listeningMinutes: 30, readingMinutes: 30, writingMinutes: 30, speakingMinutes: 15, basis: 'custom', allowEarlyFinish: true };
    const created = await api(origin, 'POST', '/api/admin/bundles', { cookie: staffCookie, json: { title: BUNDLE_TITLE, module: 'academic', components, timing } });
    const bundleId = text(at(created.json, 'bundle', 'id'));
    const published = await api(origin, 'POST', `/api/admin/bundles/${bundleId}/publish`, { cookie: staffCookie });
    if (!check('exam bundle created and published through the bundle gate', (created.status === 200 || created.status === 201) && published.status === 200, `${created.status} / ${published.status}`)) throw new Error('No published bundle to sit.');

    /* H: a real CDI page. */
    let importedTitle = '';
    if (!cdiPage) {
      check('H  a real CDI page is available in data/private_uploads', false, 'no Listening_*.html page found — H is UNVERIFIED on this machine');
    } else {
      const analysed = await api(origin, 'POST', '/api/admin/import/html', { cookie: staffCookie, json: { html: cdiPage, filename: cdiFile } });
      const questions = (at(analysed.json, 'questions') ?? []) as unknown[];
      check('H  the real CDI page is analysed as Listening, with its questions read', analysed.status === 200 && at(analysed.json, 'detectedSection') === 'listening' && questions.length > 0, `${analysed.status}; section ${String(at(analysed.json, 'detectedSection'))}; ${questions.length} questions; needsReview ${String(at(analysed.json, 'needsReview'))}; unsupported regions ${((at(analysed.json, 'unsupportedRegions') ?? []) as unknown[]).length}`);
      const draft = at(analysed.json, 'material');
      const saved = await api(origin, 'POST', '/api/admin/materials/listening', { cookie: staffCookie, json: draft });
      const savedId = text(at(saved.json, 'item', 'id')) || text(at(saved.json, 'material', 'id')) || text(at(saved.json, 'id'));
      if (saved.status === 200 || saved.status === 201) {
        importedTitle = text(at(saved.json, 'item', 'title')) || text(at(draft, 'title'));
        const status = text(at(saved.json, 'item', 'status')) || text(at(saved.json, 'material', 'status'));
        check('H  the import is saved as a draft, never published by saving', status === 'draft', `id ${savedId}, status ${status}`);
        const gate = await api(origin, 'GET', `/api/admin/materials/listening/${savedId}/publish-check`, { cookie: staffCookie });
        const blockers = (at(gate.json, 'blockers') ?? []) as unknown[];
        check('H  the publish check refuses the draft and names what it still lacks', gate.status === 200 && at(gate.json, 'publishable') === false && blockers.length > 0, gate.text.slice(0, 300));
        const learnerProbe = await api(origin, 'GET', `/api/learner/materials/listening/${savedId}`);
        check('H  the draft cannot be opened without a session', learnerProbe.status === 401);
      } else {
        check('H  a draft the schema cannot accept is refused with the reasons named, and nothing is stored', saved.status === 400 && saved.text.length > 20, `${saved.status}: ${saved.text.slice(0, 300)}`);
      }
    }

    /* The learner, created over HTTP in the temporary store. */
    const learnerName = `e2e_learner_${randomBytes(3).toString('hex')}`;
    const registered = await api(origin, 'POST', '/api/auth/register', { json: { email: `${learnerName}@example.com`, username: learnerName, password: `Learner-${randomBytes(8).toString('hex')}-1` } });
    const learnerCookie = registered.cookie;
    const learnerToken = learnerCookie.split('; ').find((pair) => pair.startsWith('prep_auth='))?.slice('prep_auth='.length) ?? '';
    const profile = await api(origin, 'PUT', '/api/data/profile', { cookie: learnerCookie, json: { targetBand: 7, currentLevel: 6, hoursPerWeek: 10, weakSection: 'writing', isOnboarded: true } });
    check('learner registered and onboarded', registered.status === 201 && profile.status === 200 && Boolean(learnerToken));

    browser = await launchBrowser(BROWSER);
    console.log(`Browser: ${browser.version} (${browser.executable}), headless, throwaway profile`);
    const page = new Page(browser.page);
    await browser.page.send('Page.enable');
    await browser.page.send('Runtime.enable');
    await browser.page.send('Network.enable');
    await browser.page.send('Network.setCookie', { name: 'prep_auth', value: learnerToken, url: origin, path: '/', httpOnly: true, sameSite: 'Strict' });
    await browser.page.send('Network.setCookie', { name: 'prep_admin_auth', value: staffToken, url: `${origin}/api/admin/`, path: '/api/admin', httpOnly: true, sameSite: 'Strict' });
    const adminProfile = at(await api(origin, 'GET', '/api/admin/me', { cookie: staffCookie }).then((reply) => reply.json), 'admin');
    await browser.page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('prep_admin_user', ${JSON.stringify(JSON.stringify(adminProfile))}); localStorage.setItem('ever_study_entered', '1'); } catch (e) {}` });
    await browser.page.send('Page.navigate', { url: `${origin}/#/app` });

    /* O: the admin CMS. */
    await waitFor('the app to load', () => page.exists('nav-tab-exam'), 240_000, 500);
    // The CMS entry lives in the account menu. The header has more than one menu button (the language
    // switcher comes first), so each is opened in turn until the entry appears, and closed again if not.
    const menus = await browser.page.evaluate<number>(`document.querySelectorAll('header button[aria-haspopup]').length`);
    for (let index = 0; index < menus && !(await page.exists('btn-open-admin-cms')); index += 1) {
      await browser.page.evaluate(`document.querySelectorAll('header button[aria-haspopup]')[${index}].click()`);
      const opened = await waitFor('a menu entry for the CMS', () => page.exists('btn-open-admin-cms'), 2_000).catch(() => false);
      if (!opened) await browser.page.evaluate(`document.querySelectorAll('header button[aria-haspopup]')[${index}].click()`);
    }
    if (!check('O  the account menu offers the admin CMS', (await page.click('btn-open-admin-cms')) === 'clicked')) throw new Error('No CMS entry in the account menu.');
    await waitFor('the admin material catalogue', () => page.exists('admin-material-catalog'), 60_000);
    const catalogue = await waitFor('the catalogue to list the fixture', async () => {
      const content = await page.textOf('admin-material-catalog');
      return content.includes('E2E Fixture') ? content : null;
    }, 30_000);
    check('O  the admin CMS lists the published materials', catalogue.includes('E2E Fixture Reading Passage 1'));
    if (importedTitle) check('O  the admin CMS lists the imported draft', catalogue.includes(importedTitle.slice(0, 30)), importedTitle);
    await page.click('tab-bundles');
    const bundles = await waitFor('the bundle catalogue', async () => {
      const content = await page.textOf('bundle-catalog');
      return content.includes(BUNDLE_TITLE) ? content : null;
    }, 30_000);
    check('O  the admin CMS lists the published exam bundle', bundles.includes(BUNDLE_TITLE));

    /* Security, as the learner alone: the staff cookie is removed. */
    await browser.page.send('Network.deleteCookies', { name: 'prep_admin_auth', url: `${origin}/api/admin/` });
    const readingId = fixture.materials.find((material) => material.slot === 'reading-1')?.id ?? '';
    const security = await browser.page.evaluate<Record<string, { status: number; body: string }>>(`(async () => {
      const read = async (response) => ({ status: response.status, body: (await response.text()).slice(0, 400) });
      return {
        adminMaterials: await read(await fetch('/api/admin/materials', { credentials: 'same-origin' })),
        adminBundles: await read(await fetch('/api/admin/bundles', { credentials: 'same-origin' })),
        practiceExamMaterial: await read(await fetch('/api/learner/practice/mark', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: { kind: 'material', section: 'reading', materialId: ${JSON.stringify(readingId)} }, section: 'reading', answers: {} }) })),
        catalogue: await read(await fetch('/api/learner/materials/reading', { credentials: 'same-origin' })),
        unknownApi: await read(await fetch('/api/no-such-route', { credentials: 'same-origin' })),
      };
    })()`);
    check('O  a learner cannot read the admin material or bundle API (403)', security.adminMaterials?.status === 403 && security.adminBundles?.status === 403, `${security.adminMaterials?.status} / ${security.adminBundles?.status}`);
    check('O  a material in a published exam is refused for practice marking, with no answers', security.practiceExamMaterial?.status === 403 && security.practiceExamMaterial.body.includes('exam_content') && !security.practiceExamMaterial.body.includes('passage1q3'), security.practiceExamMaterial?.body);
    check('O  the learner catalogue marks exam materials as not practisable', security.catalogue?.status === 200 && security.catalogue.body.includes('"practiceAvailable":false'), security.catalogue?.body.slice(0, 160));
    check('O  an unknown API path is a JSON 404 in the browser (L3)', security.unknownApi?.status === 404 && security.unknownApi.body.includes('not_found'));

    /* J: the exam. */
    await browser.page.send('Page.navigate', { url: `${origin}/#/app` });
    const sessionId = await page.openExam(bundleId, true, 'btn-listen-part-1');
    if (!check('J  the exam opens and starts', Boolean(sessionId), `session ${sessionId}`)) throw new Error('No exam session.');
    const sessionView = async () => api(origin, 'GET', `/api/learner/exams/${sessionId}`, { cookie: learnerCookie });

    for (const part of [1, 2, 3, 4]) {
      await page.click(`btn-listen-part-${part}`);
      await waitFor(`Listening part ${part}`, async () => (await page.fieldValue(LISTENING_KEY[part - 1].q1[0])) !== null, 15_000);
      const problems = await page.answer(listeningAnswers(part));
      check(`J  Listening part ${part} answered through the question controls`, problems.length === 0, problems.join('; '));
    }
    await sleep(1_500);
    check('J  Listening answers are submitted', (await page.waitClick('btn-submit-listening')) === 'clicked');
    await waitFor('the Listening submission', () => page.exists('listening-answers-submitted'), 30_000);
    const duringExam = await sessionView();
    // Only strings a key or a mark would carry: the answers to the questions this learner got wrong (their own answers
    // are "wrong", and the view rightly returns what they typed), the key field, and any score.
    const leaked = ['part4q9', 'part4q10', 'passage3q14', 'correctAnswer', 'rawScore', '"correct"'].filter((marker) => duringExam.text.includes(marker));
    check('J  during the exam no answer key or mark reaches the learner', duringExam.status === 200 && leaked.length === 0, leaked.length ? `found ${leaked.join(', ')}` : '');
    await page.waitClick('btn-finish-section');

    await waitFor('the Reading section', () => page.exists('btn-read-passage-1'), 60_000);
    await page.click('btn-read-passage-1');
    await waitFor('Reading passage 1', async () => (await page.fieldValue(READING_KEY[0].q1[0])) !== null, 15_000);
    const passage1 = await page.answer(readingAnswers(1));
    check('J  Reading passage 1 answered', passage1.length === 0, passage1.join('; '));
    await sleep(2_000);
    await browser.page.send('Page.reload', { ignoreCache: false });
    await page.openExam(bundleId, false, 'btn-read-passage-1');
    check('J  after a reload the exam resumes where it was, and says so', await waitFor('the resumed notice', () => page.exists('exam-resumed'), 30_000).catch(() => false));
    await page.click('btn-read-passage-1');
    const restored = await waitFor('the restored answer', async () => (await page.fieldValue(READING_KEY[0].q1[0])) || null, 15_000).catch(() => null);
    check('J  answers given before the reload are restored', restored === 'night', `field holds "${restored}"`);
    for (const part of [2, 3]) {
      await page.click(`btn-read-passage-${part}`);
      await waitFor(`Reading passage ${part}`, async () => (await page.fieldValue(READING_KEY[part - 1].q1[0])) !== null, 15_000);
      const problems = await page.answer(readingAnswers(part));
      check(`J  Reading passage ${part} answered`, problems.length === 0, problems.join('; '));
    }
    await sleep(1_500);
    check('J  Reading answers are submitted', (await page.waitClick('btn-submit-reading')) === 'clicked');
    await waitFor('the Reading submission', () => page.exists('reading-answers-submitted'), 30_000);
    await page.waitClick('btn-finish-section');

    await waitFor('the Writing section', () => page.exists('textarea-essay-input'), 60_000);
    check('J  the Writing screen tells the learner only submitted work, in time, is graded (M15)', await page.exists('writing-deadline-notice'));
    for (const [task, essay] of [[1, ESSAY_1], [2, ESSAY_2]] as const) {
      check(`J  Writing Task ${task} opened`, (await page.click(`btn-switch-task${task}`)) === 'clicked');
      await sleep(300);
      await page.setValue('textarea-essay-input', essay);
      await sleep(1_800);
      check(`J  Writing Task ${task} submitted`, (await page.waitClick('btn-submit-writing-grade', 20_000)) === 'clicked');
      await waitFor(`Writing Task ${task} to be stored`, () => page.exists(`writing-task-submitted-${task}`), 60_000);
    }
    check('J  Writing is graded and the section can be finished', (await page.waitClick('btn-finish-section', 120_000)) === 'clicked');

    await waitFor('the Speaking section', () => page.exists('speaking-transcript-fallback'), 60_000);
    check('J  the Speaking screen tells the learner only submitted work, in time, is graded (M15)', await page.exists('speaking-deadline-notice'));
    for (const part of [1, 2, 3]) {
      check(`J  Speaking Part ${part} opened`, (await page.click(`btn-switch-sp-part${part}`)) === 'clicked');
      await sleep(300);
      await page.setValue('speaking-transcript-fallback', TRANSCRIPTS[part - 1]);
      await sleep(300);
      check(`J  Speaking Part ${part} submitted`, (await page.waitClick('btn-submit-speaking-grade', 20_000)) === 'clicked');
      // The screen moves on to the next part once one is accepted, so the part is looked for in the session first,
      // then on its own screen.
      const stored = await waitFor(`Speaking Part ${part} to be stored`, async () => at((await sessionView()).json, 'run', 'sections', 'speaking', 'speaking', String(part)) !== undefined, 60_000).catch(() => false);
      check(`J  Speaking Part ${part} is stored by the session`, stored === true);
      await page.click(`btn-switch-sp-part${part}`);
      check(`J  Speaking Part ${part} shows as submitted and locked`, await waitFor(`Speaking Part ${part} submitted marker`, () => page.exists(`speaking-part-submitted-${part}`), 15_000).catch(() => false));
    }
    check('J  Speaking is graded and the section can be finished', (await page.waitClick('btn-finish-section', 120_000)) === 'clicked');

    const complete = await waitFor('the complete result', async () => ((await page.attribute('exam-result', 'data-complete')) === 'true' ? true : null), 120_000).catch(() => false);
    check('J  the result screen shows a complete exam', complete === true);
    const overallText = (await page.textOf('exam-overall')).trim();
    const saved = await waitFor('the attempt to be saved', () => page.exists('exam-attempt-saved'), 30_000).catch(() => false);
    check('J  the result says the attempt is saved', saved === true);

    const data = await api(origin, 'GET', '/api/data', { cookie: learnerCookie });
    const attempts = (at(data.json, 'attempts') ?? []) as Array<Record<string, unknown>>;
    const attempt = attempts.find((entry) => entry.bundleId === bundleId);
    const scores = (attempt?.scores ?? {}) as Record<string, Record<string, number> | number>;
    const raw = (section: string) => {
      const score = scores[section];
      return typeof score === 'object' ? (score.rawScore ?? score.raw) : undefined;
    };
    const band = (section: string) => {
      const score = scores[section];
      return typeof score === 'object' ? score.band : undefined;
    };
    const expected = {
      listeningRaw: 38,
      readingRaw: 39,
      listening: listeningRawToBand(38),
      reading: academicReadingRawToBand(39),
      writing: writingSectionBand(6.5, 6.5),
      speaking: speakingSectionBand([7, 7, 7]),
    };
    const expectedOverall = roundIeltsBand((expected.listening + expected.reading + (expected.writing ?? 0) + (expected.speaking ?? 0)) / 4);
    check('J  the stored attempt is an exam attempt for this bundle', attempt?.mode === 'exam', `${attempts.length} attempt(s)`);
    check('J  Listening: 38 of 40 correct, and the band the conversion table gives', raw('listening') === expected.listeningRaw && band('listening') === expected.listening, `raw ${raw('listening')}, band ${band('listening')} (expected ${expected.listening})`);
    check('J  Reading: 39 of 40 correct, and the Academic band for it', raw('reading') === expected.readingRaw && band('reading') === expected.reading, `raw ${raw('reading')}, band ${band('reading')} (expected ${expected.reading})`);
    check('J  Writing and Speaking bands come from the grading runs', band('writing') === expected.writing && band('speaking') === expected.speaking, `writing ${band('writing')}, speaking ${band('speaking')}`);
    // The overall card also carries its label and the rounding note, in the page's language; the band is its one decimal number.
    const shownOverall = /\b\d\.\d\b/.exec(overallText)?.[0] ?? '';
    const storedOverall = attempt?.overallBand ?? (typeof scores.overall === 'number' ? scores.overall : undefined);
    check('J  the overall band is the rounded average, and the screen shows the stored one', storedOverall === expectedOverall && shownOverall === expectedOverall.toFixed(1), `stored ${String(storedOverall)}, screen ${shownOverall}, expected ${expectedOverall.toFixed(1)}`);
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
    rmSync(fixtureDirectory, { recursive: true, force: true });
    const after = manifest(DATA);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]);
    check('data/ restored byte-identical', changed.length === 0, changed.length ? `differs: ${changed.join(', ')}` : `${Object.keys(after).length} files`);
  }

  const failures = results.filter((result) => !result.ok);
  console.log(`\nRESULT  ${results.length - failures.length}/${results.length} checks passed in ${BROWSER}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
