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
 *   -> pinned into a bundle draft -> learner view -> sittingToAdaptedTest
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
const { sittingToAdaptedTest } = await import('../src/services/publishedTests');
const { toLearnerMaterial } = await import('../src/services/sittingView');
const { materialContentHash } = await import('../src/services/materialVersion');

const TIMING = { listeningMinutes: 30, readingMinutes: 60, writingMinutes: 60, speakingMinutes: 14, basis: 'custom' as const, allowEarlyFinish: true };

/** One pinned component, adapted exactly as a learner sitting resolves it. */
const sittingOf = (title: string, material: import('../src/types/admin').AdminMaterial, part: number) =>
  sittingToAdaptedTest({
    bundle: { id: 'cdi-pipeline', title, module: 'academic', publishedAt: '2026-01-01T00:00:00.000Z', timing: TIMING },
    components: [
      {
        section: material.section,
        part,
        materialId: material.id,
        contentHash: materialContentHash(material),
        material: toLearnerMaterial(material, { keepTranscript: false }),
      },
    ],
  });
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

  it('can be pinned into a Full CDI bundle draft', async () => {
    const candidates = (await (await api('/api/admin/bundles/candidates')).json()).candidates as Array<{ id: string; contentHash: string }>;
    const candidate = candidates.find((entry) => entry.id === materialId);
    expect(Boolean(candidate)).toBe(true);

    const response = await api('/api/admin/bundles', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Pipeline CDI',
        module: 'academic',
        status: 'published',
        components: [{ section: 'reading', part: 1, materialId, contentHash: candidate?.contentHash }],
        timing: TIMING,
      }),
    });
    expect(response.status).toBe(201);

    const body = await response.json();
    bundleId = body.bundle.id;
    expect(body.bundle.status).toBe('draft');
    expect(body.bundle.components[0].materialId).toBe(materialId);
    expect(body.components[0].pinnedIsCurrent).toBe(true);
  });

  it('adapts the pinned component, as a learner sitting resolves it, with every question intact', async () => {
    const response = await api(`/api/admin/bundles/${bundleId}`);
    expect(response.status).toBe(200);
    expect((await response.json()).components[0].material.id).toBe(materialId);

    const material = (await (await api(`/api/admin/materials/reading/${materialId}`)).json()).item;
    const adapted = sittingOf('Pipeline CDI', material, 1);
    const passage = (adapted.test.reading?.passages ?? [])[0];

    expect(adapted.test.title).toBe('Pipeline CDI');
    // Only Reading is pinned, so this is not yet a full exam — and the adapter says so.
    expect(adapted.missingSections).toEqual(['listening', 'writing', 'speaking']);
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
    const revision = (await adminStore.getMaterial('reading', materialId))?.updatedAt;
    const response = await api(`/api/admin/materials/reading/${materialId}`, {
      method: 'PUT',
      body: JSON.stringify({ ...readingEditorPayload, status: 'draft', updatedAt: revision }),
    });
    expect(response.status).toBe(200);
    // Only the claimed status differs from what is stored, so nothing is written and it stays published.
    const body = await response.json();
    expect([body.item.status, body.unchanged]).toEqual(['published', true]);
  });

  it('refuses a bundle whose component has been withdrawn', async () => {
    const unpublished = await api(`/api/admin/materials/reading/${materialId}/unpublish`, {
      method: 'POST',
    });
    expect(unpublished.status).toBe(200);
    expect((await unpublished.json()).item.status).toBe('draft');

    const check = await (await api(`/api/admin/bundles/${bundleId}/check`)).json();
    // A withdrawn component is a reason the bundle can be neither published nor sat.
    expect(check.publishable).toBe(false);
    expect(check.blockers.map((blocker: { code: string }) => blocker.code)).toContain('component_unpublished');

    const saved = await api(`/api/admin/materials/reading/${materialId}`, {
      method: 'PUT',
      body: JSON.stringify({ ...readingEditorPayload, updatedAt: (await adminStore.getMaterial('reading', materialId))?.updatedAt }),
    });
    expect(saved.status).toBe(200);
    expect((await api(`/api/admin/materials/reading/${materialId}/publish`, { method: 'POST' })).status).toBe(200);
  });

  it('survives an update without losing question data', async () => {
    const edited = structuredClone(readingEditorPayload) as typeof readingEditorPayload;
    edited.content.passage.questions[0].prompt = 'Edited claim about farmland.';

    const response = await api(`/api/admin/materials/reading/${materialId}`, {
      method: 'PUT',
      body: JSON.stringify({ ...edited, updatedAt: (await adminStore.getMaterial('reading', materialId))?.updatedAt }),
    });
    expect(response.status).toBe(200);

    // The bundle pinned the earlier version, so the edit makes it stale instead of silently changing it.
    const check = await (await api(`/api/admin/bundles/${bundleId}/check`)).json();
    expect(check.blockers.map((blocker: { code: string }) => blocker.code)).toContain('component_changed');

    const material = (await (await api(`/api/admin/materials/reading/${materialId}`)).json()).item;
    const adapted = sittingOf('Pipeline CDI', material, 1);
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

    const published = await adminStore.getMaterial('listening', legacy.id);
    if (!published) throw new Error('the legacy material was not stored');
    const adapted = sittingOf('Legacy CDI', published, 2);
    const part = (adapted.test.listening?.parts ?? [])[0];

    expect(part.title).toBe('Campus security');
    expect(part.questions).toHaveLength(1);
    expect(part.questions[0].prompt).toBe('Main security desk opens at [ 1 ] AM');
    expect(part.questions[0].instruction).toContain('NO MORE THAN TWO WORDS');
    expect(part.questions[0].correctAnswer).toBe('7:00');
  });
});
