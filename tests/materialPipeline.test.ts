import { after, before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';

/**
 * The material pipeline, driven end to end.
 *
 * The round trip this exercises is exactly the one that was broken:
 *
 *   editor payload -> POST /api/admin/materials -> saveMaterial
 *   -> GET /api/admin/materials (the list the repository renders)
 *   -> saveBundle -> getResolvedBundle -> bundleToAdaptedTest
 *   -> the question a learner sees
 *
 * Asserting on source text could not have caught any of it: the list read the
 * wrong response key, the adapter read the wrong question field, and the
 * resolved bundle was read under the wrong name. All three compile fine.
 */
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-pipeline-'));
const originalCwd = process.cwd();
process.env.STORAGE_BACKEND = 'local';
process.env.NODE_ENV = 'test';
process.chdir(tempRoot);

// authService seeds its accounts in its constructor, so the admin this suite
// signs in as is created the supported way rather than by reaching into the
// store.
const ADMIN_USER = 'pipeline_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Tests';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const express = (await import('express')).default;
const { adminStore } = await import('../src/services/adminStore');
const { adminRouter } = await import('../src/routes/adminRoutes');
const { bundleToAdaptedTest } = await import('../src/services/publishedTests');
const { publishMaterial } = await import('./publishMaterial');

/** Exactly what AdminReadingEditor.handleSave now emits. */
const readingEditorPayload = {
  title: 'Academic Reading: Biofuels & Renewable Energies',
  section: 'reading' as const,
  module: 'academic' as const,
  theme: 'Renewable Energy',
  targetBand: '7.5',
  content: {
    passage: {
      passageNumber: 1,
      title: 'Algae as fuel',
      text: 'Algae do not compete with arable land dedicated to food.',
      questions: [
        {
          id: 1,
          type: 'true_false_not_given',
          prompt: 'Microalgae production requires fertile farmland.',
          correctAnswer: 'FALSE',
          explanation: 'The text notes algae do not compete with arable land.',
        },
        {
          id: 2,
          type: 'multiple_choice',
          prompt: 'What is the main obstacle to commercial adoption?',
          options: ['A. Upfront capital costs', 'B. Land', 'C. Water', 'D. Law'],
          correctAnswer: 'A. Upfront capital costs',
        },
        {
          id: 3,
          type: 'fill_in_blank',
          prompt: 'Algae are grown in ___.',
          correctAnswer: 'ponds',
          acceptableAnswers: ['open ponds'],
          instruction: 'Write ONE WORD ONLY.',
        },
      ],
    },
  },
};

let server: Server;
let origin = '';
let adminCookie = '';

async function api(pathname: string, init: RequestInit = {}) {
  return fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(adminCookie ? { cookie: adminCookie } : {}),
      ...(init.headers || {}),
    },
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const login = await api('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  expect(login.status).toBe(200);
  const setCookie = login.headers.getSetCookie?.() ?? [];
  adminCookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  expect(adminCookie).toContain('prep_admin_auth=');
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

describe('material round trip', () => {
  let materialId = '';
  let bundleId = '';

  it('saves a material the editor authored', async () => {
    const response = await api('/api/admin/materials', {
      method: 'POST',
      body: JSON.stringify(readingEditorPayload),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.item.id).toBeTruthy();
    expect(body.item.section).toBe('reading');
    materialId = body.item.id;
    // A save no longer publishes. The material lands as a draft and stays there
    // until somebody asks for it to be published, against the gate.
    expect(body.item.status).toBe('draft');
  });

  it('publishes only when asked, and only through the gate', async () => {
    const check = await (await api(`/api/admin/materials/reading/${materialId}/publish-check`)).json();
    expect(check.publishable).toBe(true);
    expect(check.blockers).toHaveLength(0);

    const response = await api(`/api/admin/materials/reading/${materialId}/publish`, {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect((await response.json()).item.status).toBe('published');
  });

  it('returns it in the list the repository screen renders', async () => {
    const response = await api('/api/admin/materials');
    expect(response.status).toBe(200);

    const body = await response.json();
    // The dashboard reads `items`. Reading `materials` here is what left the
    // repository permanently empty and the bundle dropdowns unusable.
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(materialId);
    expect(body.items[0].title).toBe(readingEditorPayload.title);
  });

  it('filters the list by section and status', async () => {
    expect((await (await api('/api/admin/materials?section=reading')).json()).items).toHaveLength(1);
    expect((await (await api('/api/admin/materials?section=listening')).json()).items).toHaveLength(0);
    expect((await (await api('/api/admin/materials?status=published')).json()).items).toHaveLength(1);
    expect((await (await api('/api/admin/materials?status=draft')).json()).items).toHaveLength(0);
  });

  it('can be selected into a Full CDI bundle', async () => {
    const response = await api('/api/admin/bundles', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Pipeline CDI',
        module: 'academic',
        status: 'published',
        materials: { readingId: materialId },
      }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    bundleId = body.bundle.id;
    expect(body.bundle.materials.readingId).toBe(materialId);
  });

  it('resolves that bundle into a sittable test with every question intact', async () => {
    const response = await api(`/api/admin/bundles/${bundleId}`);
    expect(response.status).toBe(200);

    const resolved = await response.json();
    expect(resolved.resolvedMaterials.reading.id).toBe(materialId);

    const adapted = bundleToAdaptedTest(resolved);
    const passage = (adapted.test.reading?.passages ?? [])[0];

    expect(adapted.test.title).toBe('Pipeline CDI');
    expect(adapted.missingSections).toHaveLength(0);
    expect(adapted.issues.reading).toBeUndefined();
    expect(passage.title).toBe('Algae as fuel');
    expect(passage.questions).toHaveLength(3);

    // Question text survives.
    expect(passage.questions.filter((q) => !q.prompt)).toHaveLength(0);
    expect(passage.questions[0].prompt).toBe('Microalgae production requires fertile farmland.');

    // Types survive, rather than collapsing to fill_in_blank.
    expect(passage.questions.map((q) => q.type)).toEqual([
      'true_false_not_given',
      'multiple_choice',
      'fill_in_blank',
    ]);

    // Answers, variants and rubrics survive.
    expect(passage.questions[0].correctAnswer).toBe('FALSE');
    expect(passage.questions[1].options).toHaveLength(4);
    expect(passage.questions[2].acceptableAnswers).toEqual(['open ponds']);
    expect(passage.questions[2].instruction).toBe('Write ONE WORD ONLY.');
    expect(passage.questions[0].explanation).toContain('arable land');
  });

  it('cannot be unpublished by a save that claims a status', async () => {
    // The only way through is the lifecycle endpoint. A PUT carrying
    // `status: 'draft'` is a request to publish or withdraw through the back
    // door, and it is ignored rather than honoured.
    const response = await api(`/api/admin/materials/reading/${materialId}`, {
      method: 'PUT',
      body: JSON.stringify({ ...readingEditorPayload, status: 'draft' }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).item.status).toBe('published');
  });

  it('keeps a draft material out of a published bundle', async () => {
    const unpublished = await api(`/api/admin/materials/reading/${materialId}/unpublish`, {
      method: 'POST',
    });
    expect(unpublished.status).toBe(200);
    expect((await unpublished.json()).item.status).toBe('draft');

    const resolved = await (await api(`/api/admin/bundles/${bundleId}`)).json();
    expect(resolved.resolvedMaterials.reading).toBe(null);

    const adapted = bundleToAdaptedTest(resolved);
    // The gap is reported rather than passed off as the bundle's own content.
    expect(adapted.missingSections).toEqual(['reading']);

    await api(`/api/admin/materials/reading/${materialId}`, {
      method: 'PUT',
      body: JSON.stringify(readingEditorPayload),
    });
    await api(`/api/admin/materials/reading/${materialId}/publish`, { method: 'POST' });
  });

  it('survives an update without losing question data', async () => {
    const edited = structuredClone(readingEditorPayload) as typeof readingEditorPayload;
    edited.content.passage.questions[0].prompt = 'Edited claim about farmland.';

    const response = await api(`/api/admin/materials/reading/${materialId}`, {
      method: 'PUT',
      body: JSON.stringify(edited),
    });
    expect(response.status).toBe(200);

    const resolved = await (await api(`/api/admin/bundles/${bundleId}`)).json();
    const adapted = bundleToAdaptedTest(resolved);
    expect((adapted.test.reading?.passages ?? [])[0].questions[0].prompt).toBe('Edited claim about farmland.');
    expect((adapted.test.reading?.passages ?? [])[0].questions).toHaveLength(3);
  });

  it('refuses every write without an admin session', async () => {
    const saved = adminCookie;
    adminCookie = '';
    try {
      expect((await api('/api/admin/materials', { method: 'POST', body: '{}' })).status).toBe(403);
      expect((await api('/api/admin/materials')).status).toBe(403);
      expect((await api(`/api/admin/bundles/${bundleId}`, { method: 'DELETE' })).status).toBe(403);
    } finally {
      adminCookie = saved;
    }
  });
});

describe('stored material authored by an older build', () => {
  it('still adapts when it carries questionText and instructions', async () => {
    const legacy = await adminStore.saveMaterial('listening', {
      title: 'Legacy Listening',
      section: 'listening',
      module: 'academic',
      theme: 'Campus life',
      targetBand: '7.0',
      content: {
        section: {
          sectionNumber: 2,
          title: 'Campus security',
          contextDescription: 'An enquiry call.',
          audioTranscript: 'The desk opens at seven.',
          questions: [
            {
              id: 1,
              type: 'form_completion',
              questionText: 'Main security desk opens at [ 1 ] AM',
              instructions: 'Write NO MORE THAN TWO WORDS AND/OR A NUMBER.',
              correctAnswer: '7:00',
            },
          ],
        },
      },
    });

    await publishMaterial(adminStore, 'listening', legacy);

    const bundle = await adminStore.saveBundle({
      title: 'Legacy CDI',
      status: 'published',
      materials: { listeningId: legacy.id },
    });

    const resolved = await adminStore.getResolvedBundle(bundle.id);
    const adapted = bundleToAdaptedTest(resolved as never);
    const part = (adapted.test.listening?.parts ?? [])[0];

    expect(part.title).toBe('Campus security');
    expect(part.questions).toHaveLength(1);
    expect(part.questions[0].prompt).toBe('Main security desk opens at [ 1 ] AM');
    expect(part.questions[0].instruction).toContain('NO MORE THAN TWO WORDS');
    expect(part.questions[0].correctAnswer).toBe('7:00');
  });
});
