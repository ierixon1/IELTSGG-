/**
 * Book → Test against the real model, once, on purpose.
 *
 *   npm run smoke:book-to-test -- [--count 1|2] [--timeout-ms 60000]
 *                                 [--attempt-timeout-ms 45000] [--attempts 2]
 *                                 [--report path/to/report.json]
 *
 * Runs the production generation route in-process against Gemini: ingests the
 * small study-skills fixture into a throwaway data directory, asks for one or two
 * short-answer questions under a strict time limit, and checks that retrieval,
 * the model call, validation and draft creation all happened. It never publishes,
 * and it deletes its data directory when it finishes.
 *
 * It is not part of `npm test`: it needs GEMINI_API_KEY and the network, and it
 * spends a request. What it reports is one of:
 *
 *   real_model_passed          exit 0   retrieval → Gemini → validation → draft
 *   real_model_unavailable     exit 75  overloaded, timed out or out of quota — nothing verified
 *   real_model_failed          exit 1   Gemini answered and the pipeline did not hold
 *   real_model_not_configured  exit 78  no GEMINI_API_KEY
 *
 * A 503 is `real_model_unavailable`, never a pass.
 */
import 'dotenv/config';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { SmokeVerdict } from '../src/services/bookToTest/smokeVerdict';

interface Options {
  count: number;
  topic: string;
  maxAttempts: number;
  attemptTimeoutMs: number;
  totalTimeoutMs: number;
  report?: string;
}

function readOptions(argv: string[]): Options {
  const options: Options = {
    count: 1,
    topic: 'scanning for dates and proper nouns',
    maxAttempts: 2,
    attemptTimeoutMs: 45_000,
    totalTimeoutMs: 60_000,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    if (flag === '--count') options.count = Number(value);
    else if (flag === '--timeout-ms') options.totalTimeoutMs = Number(value);
    else if (flag === '--attempt-timeout-ms') options.attemptTimeoutMs = Number(value);
    else if (flag === '--attempts') options.maxAttempts = Number(value);
    else if (flag === '--report') options.report = value;
    else throw new Error(`Unknown option ${flag}.`);
  }
  if (options.count !== 1 && options.count !== 2) {
    throw new Error('--count must be 1 or 2: this is a smoke test, not a generation run.');
  }
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 3) {
    throw new Error('--attempts must be 1, 2 or 3.');
  }
  if (!(options.totalTimeoutMs >= 5_000 && options.totalTimeoutMs <= 120_000)) {
    throw new Error('--timeout-ms must be between 5000 and 120000.');
  }
  if (!(options.attemptTimeoutMs >= 1_000 && options.attemptTimeoutMs <= options.totalTimeoutMs)) {
    throw new Error('--attempt-timeout-ms must be at least 1000 and no more than --timeout-ms.');
  }
  return options;
}

const projectRoot = process.cwd();
const options = readOptions(process.argv.slice(2));
const startedAt = new Date();

// This run has to reach the real model and has to write nowhere that matters.
if (process.env.BOOK_TO_TEST_FIXTURE_RESPONSE) {
  console.warn('[smoke] BOOK_TO_TEST_FIXTURE_RESPONSE is set and is ignored: this run must reach the real model.');
  delete process.env.BOOK_TO_TEST_FIXTURE_RESPONSE;
}
process.env.NODE_ENV = 'development';
process.env.STORAGE_BACKEND = 'local';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
const ADMIN_USER = 'smoke_admin';
const ADMIN_PASSWORD = `Smoke-${randomUUID()}-Aa1!`;
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-smoke-'));
process.chdir(tempRoot);

// Imported only now: these modules fix their data paths when they load.
const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { ingestSource } = await import('../src/services/sourceIngest/ingest');
const { adminStore } = await import('../src/services/adminStore');
const { setGenerationPolicy } = await import('../src/services/bookToTest/reliability');
const { smokeVerdict, SMOKE_EXIT_CODES } = await import('../src/services/bookToTest/smokeVerdict');
const { GENERATION_MODEL, GENERATOR_VERSION, PROMPT_VERSION } = await import('../src/services/bookToTest/version');

let server: Server | undefined;
let httpStatus = 0;
let verdict: SmokeVerdict;

try {
  setGenerationPolicy({
    maxAttempts: options.maxAttempts,
    attemptTimeoutMs: options.attemptTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs,
  });

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/admin', adminRouter);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const login = await fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  if (!login.ok) throw new Error(`admin sign-in failed with HTTP ${login.status}`);
  const cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(';')[0]).join('; ');

  const source = await ingestSource({
    filename: 'study-skills.md',
    buffer: readFileSync(path.join(projectRoot, 'tests', 'fixtures', 'sources', 'study-skills.md')),
    mimeType: 'text/plain',
    createdBy: 'smoke',
  });
  if (source.status !== 'ready') throw new Error(`the fixture source did not ingest (status "${source.status}")`);

  const response = await fetch(`${origin}/api/admin/sources/${source.id}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      requestId: randomUUID(),
      topic: options.topic,
      questionType: 'short_answer',
      count: options.count,
      module: 'academic',
    }),
    // The boundary ends the model call by `totalTimeoutMs`; this only catches a boundary that did not.
    signal: AbortSignal.timeout(options.totalTimeoutMs + 30_000),
  });
  httpStatus = response.status;
  const body: unknown = await response.json();
  verdict = smokeVerdict(httpStatus, body, GENERATION_MODEL);

  // A pass is also a claim about what was stored.
  if (verdict.result === 'real_model_passed' && verdict.materialId) {
    const stored = await adminStore.getMaterial('reading', verdict.materialId);
    const problems: string[] = [];
    if (!stored || stored.section !== 'reading') {
      problems.push('the draft is not in the store');
    } else {
      if (stored.status !== 'draft') problems.push(`the stored material is "${stored.status}", not a draft`);
      if (stored.content.generationRecord?.model !== GENERATION_MODEL) problems.push('the stored generation record names another model');
      if (stored.content.passage.questions.some((question) => !question.provenance)) problems.push('a stored question has no provenance');
    }
    if (problems.length > 0) verdict = { ...verdict, result: 'real_model_failed', reason: problems.join('; ') };
  }
} catch (error) {
  verdict = {
    result: 'real_model_failed',
    reason: `the smoke run could not complete: ${error instanceof Error ? error.message : String(error)}`,
  };
} finally {
  const running = server;
  await new Promise<void>((resolve) => (running ? running.close(() => resolve()) : resolve()));
  setGenerationPolicy(null);
}

const report = {
  ...verdict,
  httpStatus,
  expectedModel: GENERATION_MODEL,
  codeVersions: { generatorVersion: GENERATOR_VERSION, promptVersion: PROMPT_VERSION },
  requested: { questionType: 'short_answer', count: options.count, topic: options.topic },
  policy: {
    maxAttempts: options.maxAttempts,
    attemptTimeoutMs: options.attemptTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs,
  },
  published: false,
  startedAt: startedAt.toISOString(),
  durationMs: Date.now() - startedAt.getTime(),
};

process.chdir(projectRoot);
try {
  rmSync(tempRoot, { recursive: true, force: true });
} catch (error) {
  console.warn(`[smoke] could not remove ${tempRoot}: ${error instanceof Error ? error.message : String(error)}`);
}

console.log(`BOOK_TO_TEST_SMOKE ${JSON.stringify(report)}`);
console.log(`\n${report.result}: ${report.reason}`);
if (options.report) {
  const target = path.resolve(projectRoot, options.report);
  writeFileSync(target, JSON.stringify(report, null, 2));
  console.log(`report written to ${target}`);
}
process.exit(SMOKE_EXIT_CODES[report.result]);
