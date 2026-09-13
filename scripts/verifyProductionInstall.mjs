#!/usr/bin/env node
/**
 * H9: a clean production install runs the built server.
 *
 *   npm run verify:production-install -- [--skip-build] [--installer=npm|bun] [--keep]
 *
 * `npm run build` bundles server.ts with `--packages=external`, so dist/server.cjs
 * loads every bare import from node_modules when it runs. A production install
 * holds `dependencies` only. This proves that install is enough, without the
 * repository's own node_modules anywhere on the resolution path:
 *
 *   1. build (unless --skip-build);
 *   2. read every package dist/server.cjs loads — `require("…")` and `import("…")` —
 *      and check each is declared in `dependencies`;
 *   3. copy package.json, the lockfile and dist/ into a fresh directory under the
 *      system temp directory, and check no package resolves there yet;
 *   4. install for production: `npm ci --omit=dev`, or
 *      `bun install --production --frozen-lockfile` (the project's CI lockfile);
 *   5. check every runtime package is installed and the dev-only toolchain is not;
 *   6. boot the bundle in production mode (NODE_ENV=production, Firestore without
 *      credentials): the app shell is served and /api/health answers 503;
 *   7. boot the same bundle on local storage and exercise the runtime paths the
 *      misdeclared packages serve: sign-up and sign-in, the learner's data, staff
 *      sign-in, multipart HTML, DOCX and PDF uploads, DOCX and PDF source
 *      ingestion, and reading a stored asset, whole and by byte range.
 *
 * Exits 0 when every step passes and 1 at the first that does not.
 *
 * Checks of the check (they must fail):
 *   --break-dependency=<name>      move a runtime package to devDependencies in the copy
 *   --undeclare-dependency=<name>  remove a runtime package from dependencies in the copy
 *   --skip-declared-check          skip step 2, so the installed server itself shows the gap
 *
 * The server is started on PORT below — deliberately not 3000, so a server that
 * ignored PORT (audit M1) fails here. Nothing else may listen there.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3217;
const BASE = `http://127.0.0.1:${PORT}`;
const BUN_VERSION = '1.4.2';
/** Dev-only tooling that no runtime package depends on: present in a production tree only if devDependencies were installed. */
const DEV_ONLY_SENTINELS = ['typescript', 'autoprefixer'];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

class VerificationFailure extends Error {}
const fail = (message) => {
  throw new VerificationFailure(message);
};
const log = (line) => process.stdout.write(`${line}\n`);
const pass = (label, detail = '') => log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const tail = (text, lines = 30) => String(text ?? '').trim().split(/\r?\n/).slice(-lines).join('\n');

/** The environment a child gets: the caller's, minus anything that would point the server at real services or accounts. */
function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(GEMINI_|FIREBASE_|GOOGLE_|GCLOUD|GCS_|FIRESTORE_|GRADING_|SEED_|ADMIN_|EXAMINER_|npm_)|^(APP_URL|NODE_OPTIONS|NODE_ENV|STORAGE_BACKEND|EXPLICIT_DEV_AUTH|RESEND_API_KEY|EMAIL_FROM|PORT|TRUST_PROXY)$/i.test(key)) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

function run(command, cwd, label) {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: childEnv() });
  if (result.status !== 0) fail(`${label} exited with ${result.status}:\n${tail(`${result.stdout}\n${result.stderr}`)}`);
  return `${result.stdout}\n${result.stderr}`;
}

const packageName = (specifier) => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
const isBuiltin = (specifier) => specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0]);

/** Every package the bundle loads at run time, statically or through `import()`. */
function runtimePackagesOf(bundle) {
  const names = new Set();
  for (const match of bundle.matchAll(/\b(?:require|import)\("([^"]+)"\)/g)) {
    const specifier = match[1];
    if (specifier.startsWith('.') || specifier.startsWith('/') || isBuiltin(specifier)) continue;
    names.add(packageName(specifier));
  }
  return [...names].sort();
}

/** The manifest the copy gets: the repository's, with any deliberate breakage applied. */
function manifestForCopy(manifest) {
  const copy = JSON.parse(JSON.stringify(manifest));
  const broken = option('break-dependency');
  if (broken) {
    if (!copy.dependencies[broken]) fail(`--break-dependency=${broken}: not a runtime dependency.`);
    copy.devDependencies[broken] = copy.dependencies[broken];
    delete copy.dependencies[broken];
  }
  const undeclared = option('undeclare-dependency');
  if (undeclared) {
    if (!copy.dependencies[undeclared]) fail(`--undeclare-dependency=${undeclared}: not a runtime dependency.`);
    delete copy.dependencies[undeclared];
  }
  return { copy, mutated: Boolean(broken || undeclared) };
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts dist/server.cjs from the install and waits until it answers HTTP. */
async function boot(installDir, env, label) {
  if (await portInUse(PORT)) fail(`${label}: port ${PORT} is already in use; stop whatever listens there first.`);
  let output = '';
  let exited = null;
  const child = spawn(process.execPath, ['dist/server.cjs'], { cwd: installDir, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = (chunk) => {
    output = (output + chunk.toString()).slice(-20_000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (exited) fail(`${label}: the server exited (${exited.code ?? exited.signal}) before answering:\n${tail(output)}`);
    try {
      await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(10_000) });
      pass(`${label}: server booted`, `pid ${child.pid}`);
      return {
        output: () => output,
        async stop() {
          if (!exited) {
            child.kill();
            for (let i = 0; i < 50 && !exited; i++) await sleep(100);
          }
          for (let i = 0; i < 50 && (await portInUse(PORT)); i++) await sleep(100);
        },
      };
    } catch {
      await sleep(500);
    }
  }
  child.kill();
  fail(`${label}: the server did not answer within 90 s:\n${tail(output)}`);
}

async function call(method, url, { cookie, json, form, headers = {} } = {}) {
  const init = { method, headers: { ...(cookie ? { cookie } : {}), ...headers }, signal: AbortSignal.timeout(60_000) };
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  if (form) init.body = form;
  const response = await fetch(`${BASE}${url}`, init);
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer.toString('utf8');
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, headers: response.headers, buffer, text, body, cookie: (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ') };
}

function expectStatus(label, reply, status) {
  if (reply.status !== status) fail(`${label}: expected HTTP ${status}, got ${reply.status}: ${reply.text.slice(0, 400)}`);
}

/* ------------------------------------------------------------------ fixtures */

const MARKER = 'quokka';
const PASSAGE = [
  `The ${MARKER} marker sentence proves this text was extracted from the uploaded file by the installed parser.`,
  'Sailors once estimated their position by dead reckoning, combining a known starting point with speed, heading and elapsed time.',
  'Errors accumulated with every hour at sea, so navigators corrected their estimate whenever a coastline or a star could be sighted.',
  'Modern instruments still use the same principle when satellite signals are lost, which is why the method is taught to this day.',
];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A ZIP archive with stored (uncompressed) entries. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function docx() {
  const paragraphs = [`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter One: Dead reckoning</w:t></w:r></w:p>`, ...PASSAGE.map((text) => `<w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`)];
  return zip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join('')}</w:body></w:document>`),
    },
  ]);
}

function pdf() {
  const objects = [];
  const add = (body) => objects.push(body);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const stream = `BT /F1 12 Tf 72 720 Td 14 TL\n${['Chapter One: Dead reckoning', ...PASSAGE].map((line) => `(${line.replace(/[()\\]/g, '\\$&')}) Tj T*`).join('\n')}\nET`;
  add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  add('<< /Type /Page /Parent 4 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 1 0 R >> >> /Contents 2 0 R >>');
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add('<< /Type /Catalog /Pages 4 0 R >>');
  let text = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
  text += `trailer\n<< /Size ${objects.length + 1} /Root 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text, 'latin1');
}

function wav() {
  const samples = Buffer.alloc(1600);
  for (let i = 0; i < samples.length / 2; i++) samples.writeInt16LE(Math.round(Math.sin(i / 4) * 4000), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

const HTML = `<!DOCTYPE html><html><body><h1>Dead reckoning</h1>${PASSAGE.map((text) => `<p>${text}</p>`).join('')}</body></html>`;

function fileForm(filename, content, type) {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), filename);
  return form;
}

/* -------------------------------------------------------------- the checks */

async function productionModeChecks(installDir) {
  // Production refuses to start without its configuration, and says what is missing.
  const refused = spawnSync(process.execPath, ['dist/server.cjs'], { cwd: installDir, env: childEnv({ NODE_ENV: 'production', PORT: String(PORT) }), encoding: 'utf8', timeout: 60_000 });
  const refusal = `${refused.stdout}\n${refused.stderr}`;
  if (refused.status !== 1 || !refusal.includes('[Config] The server cannot start') || !refusal.includes('TRUST_PROXY must be set')) {
    fail(`production mode without its configuration should exit 1 naming what is missing, got ${refused.status}:\n${tail(refusal)}`);
  }
  pass('production mode: refuses to start without its configuration', `${refusal.split('\n').filter((line) => line.startsWith('[Config] ') && !line.includes('cannot start')).length} problems named`);

  // A complete production configuration. The bucket is one nothing can reach, there are no Firestore
  // credentials, and the email settings are placeholders: nothing is sent.
  const server = await boot(
    installDir,
    {
      NODE_ENV: 'production',
      PORT: String(PORT),
      TRUST_PROXY: '1',
      STORAGE_BACKEND: 'gcs_firestore',
      GCS_BUCKET_NAME: 'everstudy-prodcheck-unreachable',
      RESEND_API_KEY: 're_prodcheck_placeholder',
      EMAIL_FROM: 'Ever Study <no-reply@prodcheck.invalid>',
      APP_URL: 'https://prodcheck.invalid',
    },
    'production mode',
  );
  try {
    const shell = await call('GET', '/');
    expectStatus('production mode: app shell', shell, 200);
    if (!(shell.headers.get('content-type') ?? '').includes('text/html') || !shell.text.includes('id="root"')) fail(`production mode: / did not serve the built index.html:\n${shell.text.slice(0, 300)}`);
    pass('production mode: app shell served from dist', `${shell.buffer.length} bytes`);

    const health = await call('GET', '/api/health');
    if (health.status !== 503 || health.body?.status !== 'unavailable' || health.body?.storage?.backend !== 'gcs_firestore') {
      fail(`production mode: /api/health should answer 503 without Firestore credentials, got ${health.status}: ${health.text.slice(0, 300)}`);
    }
    pass('production mode: /api/health answers 503 JSON without Firestore credentials');
  } finally {
    await server.stop();
  }
}

async function runtimePathChecks(installDir) {
  const adminUser = 'prodcheck_admin';
  const password = `Pc-${randomBytes(12).toString('hex')}-A1`;
  const server = await boot(
    installDir,
    { NODE_ENV: 'development', PORT: String(PORT), STORAGE_BACKEND: 'local', SEED_DEFAULT_ACCOUNTS: 'true', ADMIN_USER: adminUser, ADMIN_PASSWORD: password },
    'local storage',
  );
  try {
    const health = await call('GET', '/api/health');
    expectStatus('local storage: /api/health', health, 200);
    pass('local storage: /api/health answers 200');

    // Authentication (bcryptjs, nanoid).
    const registered = await call('POST', '/api/auth/register', { json: { username: 'prodcheck_learner', email: 'prodcheck@example.com', password, name: 'Production Check' } });
    expectStatus('auth: register', registered, 201);
    if (!registered.cookie.includes('prep_auth=')) fail('auth: register set no session cookie.');
    const me = await call('GET', '/api/auth/me', { cookie: registered.cookie });
    expectStatus('auth: me', me, 200);
    if (me.body?.user?.username !== 'prodcheck_learner') fail(`auth: /api/auth/me returned ${me.text.slice(0, 200)}`);
    const data = await call('GET', '/api/data', { cookie: registered.cookie });
    expectStatus('learner data', data, 200);
    pass('auth: learner signed up, session read back, /api/data served');

    const login = await call('POST', '/api/admin/login', { json: { username: adminUser, password } });
    expectStatus('auth: staff sign-in', login, 200);
    if (!login.cookie.includes('prep_admin_auth=')) fail('auth: staff sign-in set no session cookie.');
    const admin = login.cookie;
    pass('auth: staff signed in');

    // Multipart uploads (multer), HTML sanitising (sanitize-html), DOCX text (mammoth), PDF (pdf-parse).
    const html = await call('POST', '/api/admin/upload', { cookie: admin, form: fileForm('passage.html', HTML, 'text/html') });
    expectStatus('upload: HTML', html, 200);
    if (!html.body?.file?.assetId || !html.body.file.sourceAssetId || !String(html.body.file.extractedHtml ?? '').includes(MARKER)) fail(`upload: HTML was not stored and sanitised: ${html.text.slice(0, 400)}`);
    pass('upload: multipart HTML stored and sanitised', `asset ${html.body.file.assetId}`);

    const word = await call('POST', '/api/admin/upload', { cookie: admin, form: fileForm('notes.docx', docx(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') });
    expectStatus('upload: DOCX', word, 200);
    if (!String(word.body?.file?.extractedText ?? '').includes(MARKER)) fail(`upload: DOCX text was not extracted: ${word.text.slice(0, 400)}`);
    pass('upload: multipart DOCX stored, text extracted (mammoth)');

    const pdfUpload = await call('POST', '/api/admin/upload', { cookie: admin, form: fileForm('page.pdf', pdf(), 'application/pdf') });
    expectStatus('upload: PDF', pdfUpload, 200);
    if (!String(pdfUpload.body?.file?.extractedText ?? '').includes(MARKER)) fail(`upload: PDF text was not extracted (L15): ${pdfUpload.text.slice(0, 400)}`);
    pass('upload: multipart PDF stored, text extracted (pdf-parse)');

    // Source ingestion: DOCX (mammoth) and PDF (pdf-parse), chunked and searchable.
    for (const [label, filename, content, type] of [
      ['DOCX', 'chapter.docx', docx(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['PDF', 'chapter.pdf', pdf(), 'application/pdf'],
    ]) {
      const ingested = await call('POST', '/api/admin/sources', { cookie: admin, form: fileForm(filename, content, type) });
      expectStatus(`source ingestion: ${label}`, ingested, 200);
      if (ingested.body?.item?.status !== 'ready') fail(`source ingestion: ${label} did not become ready: ${ingested.text.slice(0, 500)}`);
      const chunks = await call('GET', `/api/admin/sources/${ingested.body.item.id}/chunks?limit=50`, { cookie: admin });
      expectStatus(`source ingestion: ${label} chunks`, chunks, 200);
      if (!(chunks.body?.total > 0) || !chunks.text.includes(MARKER)) fail(`source ingestion: ${label} chunks do not carry the extracted text: ${chunks.text.slice(0, 400)}`);
      pass(`source ingestion: ${label} extracted, chunked and readable`, `${chunks.body.total} chunk(s)`);
    }

    // Asset handling: a stored file read back whole and by byte range.
    const stored = await call('GET', `/api/admin/assets/${html.body.file.assetId}`, { cookie: admin });
    expectStatus('assets: HTML read', stored, 200);
    if (!stored.text.includes(MARKER)) fail('assets: the stored HTML came back without its content.');
    const audio = await call('POST', '/api/admin/upload', { cookie: admin, form: fileForm('tone.wav', wav(), 'audio/wav') });
    expectStatus('assets: audio upload', audio, 200);
    const ranged = await call('GET', `/api/admin/assets/${audio.body.file.assetId}`, { cookie: admin, headers: { Range: 'bytes=0-9' } });
    if (ranged.status !== 206 || ranged.buffer.length !== 10 || !(ranged.headers.get('content-range') ?? '').startsWith('bytes 0-9/')) fail(`assets: byte range not served: ${ranged.status} ${ranged.headers.get('content-range')}`);
    pass('assets: stored files read back whole and by byte range');
  } catch (error) {
    if (error instanceof VerificationFailure) error.message += `\n--- server output ---\n${tail(server.output())}`;
    throw error;
  } finally {
    await server.stop();
  }
}

async function main() {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const installer = option('installer') ?? (existsSync(path.join(ROOT, 'package-lock.json')) ? 'npm' : 'bun');
  if (installer !== 'npm' && installer !== 'bun') fail(`--installer must be npm or bun, not ${installer}.`);
  log(`H9 production install verification — Node ${process.versions.node}, installer ${installer}`);

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) fail(`Node ${process.versions.node} is below the engines floor ${manifest.engines?.node}.`);

  if (!flag('skip-build')) {
    run('npm run build', ROOT, 'npm run build');
    pass('build');
  }
  const bundlePath = path.join(ROOT, 'dist', 'server.cjs');
  if (!existsSync(bundlePath) || !existsSync(path.join(ROOT, 'dist', 'index.html'))) fail('dist/server.cjs or dist/index.html is missing; build first.');

  const { copy, mutated } = manifestForCopy(manifest);
  const runtime = runtimePackagesOf(readFileSync(bundlePath, 'utf8'));
  if (runtime.length === 0) fail('dist/server.cjs loads no packages; the bundle is not the one expected.');
  if (!flag('skip-declared-check')) {
    const undeclared = runtime.filter((name) => !Object.hasOwn(copy.dependencies, name));
    if (undeclared.length > 0) fail(`the built server loads packages not declared in dependencies: ${undeclared.join(', ')}.`);
    pass('every package the built server loads is declared in dependencies', runtime.join(', '));
  }

  const lockfile = installer === 'npm' ? 'package-lock.json' : 'bun.lock';
  if (!existsSync(path.join(ROOT, lockfile))) fail(`${lockfile} is missing; the ${installer} install needs it.`);

  const installDir = mkdtempSync(path.join(os.tmpdir(), 'everstudy-prod-install-'));
  try {
    try {
      createRequire(path.join(installDir, 'probe.cjs')).resolve('express');
      fail(`packages already resolve from ${installDir}: a node_modules above it would hide a missing dependency.`);
    } catch (error) {
      if (error instanceof VerificationFailure) throw error;
    }
    writeFileSync(path.join(installDir, 'package.json'), `${JSON.stringify(copy, null, 2)}\n`);
    cpSync(path.join(ROOT, lockfile), path.join(installDir, lockfile));
    cpSync(path.join(ROOT, 'dist'), path.join(installDir, 'dist'), { recursive: true });
    pass('clean copy prepared outside the repository', installDir);

    const bun = spawnSync('bun --version', { shell: true, encoding: 'utf8' }).status === 0 ? 'bun' : `npx --yes bun@${BUN_VERSION}`;
    if (mutated) {
      run(installer === 'npm' ? 'npm install --package-lock-only --ignore-scripts --no-audit --no-fund' : `${bun} install --lockfile-only`, installDir, 'lockfile resync for the altered manifest');
    }
    const installCommand = installer === 'npm' ? 'npm ci --omit=dev --no-audit --no-fund' : `${bun} install --production --frozen-lockfile`;
    run(installCommand, installDir, installCommand);
    pass('production install', installCommand);

    const missing = runtime.filter((name) => !existsSync(path.join(installDir, 'node_modules', ...name.split('/'), 'package.json')));
    if (missing.length > 0) fail(`the production install lacks packages the built server loads: ${missing.join(', ')}.`);
    const leaked = DEV_ONLY_SENTINELS.filter((name) => existsSync(path.join(installDir, 'node_modules', name, 'package.json')));
    if (leaked.length > 0) fail(`the production install contains dev-only tooling: ${leaked.join(', ')}.`);
    pass('production install holds every runtime package and no dev-only tooling');

    await productionModeChecks(installDir);
    await runtimePathChecks(installDir);
    log('RESULT  clean production install → server boots → runtime paths work');
  } finally {
    if (flag('keep')) log(`kept ${installDir}`);
    else {
      try {
        rmSync(installDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      } catch (error) {
        log(`note: could not remove ${installDir}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    log(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
