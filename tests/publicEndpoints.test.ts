import { after, before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';

/**
 * Answer-key leakage, tested over real HTTP.
 *
 * `/api/admin/public/*` sits behind no session at all, and it used to answer
 * with the stored material verbatim — so an anonymous request could collect
 * `correctAnswer` and `explanation` for every published test without signing
 * in. Asserting that by reading the source file would not have caught it;
 * these tests make the requests.
 *
 * `adminStore` resolves its data directory from `process.cwd()` when it is
 * imported, so cwd is pointed at a throwaway directory before the first import.
 */
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-public-'));
const originalCwd = process.cwd();
process.env.STORAGE_BACKEND = 'local';
process.env.NODE_ENV = 'test';
process.chdir(tempRoot);

const express = (await import('express')).default;
const { adminStore } = await import('../src/services/adminStore');
const { adminRouter } = await import('../src/routes/adminRoutes');
const { learnerContentRouter } = await import('../src/routes/learnerContentRoutes');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { enforceAdminSecurity } = await import('../src/middleware/adminSecurityMiddleware');
const { publishMaterial } = await import('./publishMaterial');

const ANSWER = 'B. Excessive upfront capital costs';
const TRANSCRIPT = 'The eco-farm tour runs from the sixth to the twentieth of June.';

let server: Server;
let origin = '';
let bundleId = '';

before(async () => {
  const reading = await adminStore.saveMaterial('reading', {
    title: 'Audited Reading',
    section: 'reading',
    module: 'academic',
    theme: 'Renewable Energy',
    targetBand: '7.5',
    content: {
      passage: {
        passageNumber: 1,
        title: 'Biofuels',
        text: 'Algae do not compete with arable land.',
        questions: [
          {
            id: 'q1',
            questionNumber: 1,
            type: 'multiple_choice',
            prompt: 'What is the main obstacle?',
            options: ['A. Land', ANSWER, 'C. Water', 'D. Law'],
            correctAnswer: ANSWER,
            acceptableAnswers: ['capital costs'],
            explanation: 'Paragraph C names the capital outlay.',
          },
        ],
      },
    },
  });

  const listening = await adminStore.saveMaterial('listening', {
    title: 'Audited Listening',
    section: 'listening',
    module: 'academic',
    theme: 'Eco-tourism',
    targetBand: '7.0',
    content: {
      section: {
        sectionNumber: 1,
        title: 'Eco-farm',
        contextDescription: 'A booking call.',
        audioTranscript: TRANSCRIPT,
        questions: [
          {
            id: 'q1',
            questionNumber: 1,
            type: 'form_completion',
            prompt: 'Dates offered:',
            correctAnswer: '6-20 June',
          },
        ],
      },
      transcript: TRANSCRIPT,
    },
  });

  await publishMaterial(adminStore, 'reading', reading);
  await publishMaterial(adminStore, 'listening', listening);

  const bundle = await adminStore.saveBundle({
    title: 'Audited CDI',
    module: 'academic',
    status: 'published',
    materials: { readingId: reading.id, listeningId: listening.id },
  });
  bundleId = bundle.id;

  const app = express();
  app.use(express.json());
  app.use('/api/admin', enforceAdminSecurity, adminRouter);
  app.use('/api', authenticateRequest);
  app.use('/api', learnerContentRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

describe('anonymous access to published content', () => {
  it('does not expose answer keys through the public materials list', async () => {
    const response = await fetch(`${origin}/api/admin/public/materials/reading`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).not.toContain(ANSWER);
    expect(body).not.toContain('correctAnswer');
    expect(body).not.toContain('acceptableAnswers');
    expect(body).not.toContain('explanation');

    // Metadata a catalog needs is still there.
    const parsed = JSON.parse(body);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].title).toBe('Audited Reading');
    expect(parsed.items[0].questionCount).toBe(1);
  });

  it('does not expose the listening transcript, which gives the answers away', async () => {
    const response = await fetch(`${origin}/api/admin/public/materials/listening`);
    const body = await response.text();
    expect(body).not.toContain(TRANSCRIPT);
    expect(body).not.toContain('audioTranscript');
  });

  it('does not expose answer keys through the public bundle route', async () => {
    const response = await fetch(`${origin}/api/admin/public/bundles/${bundleId}`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).not.toContain(ANSWER);
    expect(body).not.toContain('correctAnswer');
    expect(body).not.toContain(TRANSCRIPT);

    // The learner still needs to know which skills the bundle carries.
    const parsed = JSON.parse(body);
    expect(parsed.bundle.id).toBe(bundleId);
    expect(parsed.resolvedMaterials.reading.title).toBe('Audited Reading');
  });

  it('refuses the learner test route without a session', async () => {
    const response = await fetch(`${origin}/api/learner/bundles/${bundleId}`);
    expect(response.status).toBe(401);

    const body = await response.text();
    expect(body).not.toContain(ANSWER);
  });

  it('refuses the learner material route without a session', async () => {
    const response = await fetch(`${origin}/api/learner/materials/reading`);
    expect(response.status).toBe(401);
  });
});
