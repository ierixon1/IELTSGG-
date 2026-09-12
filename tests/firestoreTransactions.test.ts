import './env';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Firestore } from 'firebase-admin/firestore';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { AdminMaterial } from '../src/types/admin';
import type { ExamSessionRecord } from '../src/types/examSession';
import type { BundleDraftInput } from '../src/schemas/bundle';
import { CUSTOM_TIMING, FULL_SLOTS, listeningPayload, readingPayload, speakingPayload, writingPayload } from './bundleFixtures';

/**
 * Firestore transactions (Phase 23, Part C): a write that must be decided on
 * current data reads that data inside its transaction, compares a revision where
 * one exists, and writes through the transaction — so two requests racing on one
 * document cannot both win, and nothing read outside the transaction decides it.
 *
 * `FakeFirestore` runs here in its optimistic mode. Transactions interleave, and a
 * commit whose reads have changed is thrown away and run again, as the Firestore
 * client does for a transaction that lost a conflict. `holdTransactionReads(n)`
 * holds the first n transactional reads until all of them have arrived, so every
 * race below happens the same way on every run. Each race also requires that the
 * fake saw a conflict: a pass cannot come from the requests running one after the
 * other.
 *
 * This is the contract on the in-memory Firestore. It has not been run against a
 * real Firestore project (H10).
 */
process.env.STORAGE_BACKEND = 'gcs_firestore';
process.env.GCS_BUCKET_NAME = 'not-used-uploads-are-stubbed';
process.env.EXPLICIT_DEV_AUTH = 'true';
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-firestore-transactions-'));
process.chdir(tempRoot);

const { FakeFirestore } = await import('./fakeFirestore');
const fake = new FakeFirestore({ concurrency: 'optimistic' });
const { setFirestoreDbForTesting } = await import('../src/services/firebaseAdmin');
setFirestoreDbForTesting(fake as unknown as Firestore);

const { storageProvider } = await import('../src/services/storage');
const { isStorageUnavailableError } = await import('../src/services/storage/availability');
const { FirestoreDataStore } = await import('../src/services/storage/FirestoreDataStore');
const { adminStore, MaterialConflictError } = await import('../src/services/adminStore');
const { assetStore } = await import('../src/services/assetStore');
const { bundleStore, BundleStateError } = await import('../src/services/bundleStore');
const { publishBundle, transitionBundle } = await import('../src/services/bundleService');
const { authService } = await import('../src/services/authService');
const { generationLog } = await import('../src/services/bookToTest/generationLog');
const { requestRateLimitService } = await import('../src/services/requestRateLimitService');
const { materialContentHash } = await import('../src/services/materialVersion');
const { publishBlockers } = await import('../src/services/publishGate');
const { describeQuestionIssue } = await import('../src/schemas/question');

// Bytes would go to Cloud Storage; the records go to (fake) Firestore, which is what is under test.
storageProvider.uploadFile = async (storagePath: string) => ({ storagePath });

after(() => {
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

const winners = <T>(results: PromiseSettledResult<T>[]): T[] =>
  results.filter((result): result is PromiseFulfilledResult<T> => result.status === 'fulfilled').map((result) => result.value);
const losers = <T>(results: PromiseSettledResult<T>[]): unknown[] =>
  results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
const codeOf = (error: unknown): string =>
  error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.message : String(error);

/** Starts every contender with the first `reads` transactional reads held, and counts the conflicts they produced. */
async function race<T>(reads: number, contenders: Array<() => Promise<T>>) {
  const conflictsBefore = fake.conflicts;
  fake.holdTransactionReads(reads);
  const results = await Promise.allSettled(contenders.map((start) => start()));
  return { results, conflicts: fake.conflicts - conflictsBefore };
}

function readingWithText(text: string, id?: string) {
  const payload = readingPayload(1);
  return { ...payload, ...(id ? { id } : {}), content: { ...payload.content, passage: { ...payload.content.passage, text } } };
}

const passageText = (material: AdminMaterial | Record<string, unknown> | undefined): string => {
  const content = material?.content as { passage?: { text?: string } } | undefined;
  return content?.passage?.text ?? '';
};

describe('materials', () => {
  it('two editors saving from one revision: one save lands, the other is refused as stale, and storage holds the one that landed', async () => {
    const created = await adminStore.saveMaterial('reading', readingWithText('Opened by both editors.'), 'test');
    const save = (text: string) => () =>
      adminStore.saveMaterialDetailed('reading', readingWithText(text, created.id), 'test', { expectedUpdatedAt: created.updatedAt, requireRevision: true });
    const { results, conflicts } = await race(2, [save('First editor.'), save('Second editor.')]);

    const landed = winners(results);
    expect(landed).toHaveLength(1);
    expect(losers(results).map(codeOf)).toEqual(['material_stale']);
    expect(losers(results)[0] instanceof MaterialConflictError).toBe(true);
    expect(conflicts).toBeGreaterThan(0);
    expect(passageText(fake.documents.get(`admin_content/reading/items/${created.id}`))).toBe(passageText(landed[0].material));
  });

  it('a publish racing an edit that empties the material never leaves a published material its gate did not pass', async () => {
    const created = await adminStore.saveMaterial('reading', readingWithText('A complete material.'), 'test');
    const emptied = {
      id: created.id,
      title: 'Emptied',
      section: 'reading' as const,
      module: 'academic' as const,
      content: { passage: { passageNumber: 1, title: 'Emptied', text: 'Nothing to answer.', questions: [] } },
    };
    const conflictsBefore = fake.conflicts;
    fake.holdTransactionReads(2);
    const [saved, published] = await Promise.allSettled([
      adminStore.saveMaterialDetailed('reading', emptied, 'test', { expectedUpdatedAt: created.updatedAt, requireRevision: true }),
      adminStore.setMaterialStatus('reading', created.id, 'published', { assetExists: () => true }),
    ]);
    expect(fake.conflicts - conflictsBefore).toBeGreaterThan(0);

    // Exactly one had its way: the edit landed and the publish was refused on the edited content, or the publish landed and the edit was refused as stale.
    const saveLanded = saved.status === 'fulfilled';
    const publishLanded = published.status === 'fulfilled' && published.value.ok;
    expect(saveLanded !== publishLanded).toBe(true);

    const review = await adminStore.reviewMaterial('reading', created.id);
    if (!review) throw new Error('material missing');
    if (review.material.status === 'published') {
      expect(publishBlockers(review.material, { assetExists: () => true, needsReview: review.needsReview.map(describeQuestionIssue) })).toEqual([]);
    }
    expect([review.material.status, passageText(review.material)]).toEqual(publishLanded ? ['published', 'A complete material.'] : ['draft', 'Nothing to answer.']);
  });

  it('a commit that fails leaves the material exactly as stored, and the same save succeeds once Firestore answers', async () => {
    const created = await adminStore.saveMaterial('reading', readingWithText('Before the outage.'), 'test');
    const documentPath = `admin_content/reading/items/${created.id}`;
    const before = structuredClone(fake.documents.get(documentPath));
    const apply = fake.apply.bind(fake);
    fake.apply = () => {
      fake.apply = apply;
      throw Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14, details: 'No connection established' });
    };
    const save = () => adminStore.saveMaterialDetailed('reading', readingWithText('During the outage.', created.id), 'test', { expectedUpdatedAt: created.updatedAt, requireRevision: true });
    let failure: unknown = null;
    try {
      await save();
    } catch (error) {
      failure = error;
    } finally {
      fake.apply = apply;
    }
    expect(isStorageUnavailableError(failure)).toBe(true);
    expect(fake.documents.get(documentPath)).toEqual(before);
    expect(passageText((await save()).material)).toBe('During the outage.');
  });
});

describe('exam sessions and attempts', () => {
  const store = new FirestoreDataStore();
  const USER = 'usr_transactionLearner';
  const SESSION = 'attempt-00000000-race-0001';
  const session = (patch: Partial<ExamSessionRecord>): ExamSessionRecord => ({
    id: SESSION,
    userId: USER,
    bundleId: 'cdi-bundle-race',
    bundlePublishedAt: '2026-09-12T10:00:00.000Z',
    pins: [],
    status: 'active',
    revision: 0,
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
    progress: { sections: {} } as unknown as ExamSessionRecord['progress'],
    ...patch,
  });

  it('two writes carrying the same revision: exactly one is stored', async () => {
    expect(await store.saveExamSession(USER, session({}), null)).toBe(true);
    const { results, conflicts } = await race(2, [
      () => store.saveExamSession(USER, session({ revision: 1, status: 'finished' }), 0),
      () => store.saveExamSession(USER, session({ revision: 1, status: 'abandoned' }), 0),
    ]);
    const outcomes = winners(results);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(conflicts).toBeGreaterThan(0);
    const stored = await store.getExamSession(USER, SESSION);
    expect([stored?.revision, stored?.status]).toEqual([1, outcomes[0] ? 'finished' : 'abandoned']);
  });

  it('an attempt written twice under its session id — a finish retried after a lost race — is one document', async () => {
    const attempt = { id: SESSION, testId: 'cdi-bundle-race', date: '2026-09-12', scores: {}, notes: 'first write' };
    await Promise.all([store.saveUserAttempt(USER, attempt), store.saveUserAttempt(USER, { ...attempt, notes: 'second write' })]);
    const attempts = await store.getUserAttempts(USER);
    expect(attempts.map((stored) => [stored.id, stored.notes])).toEqual([[SESSION, 'second write']]);
  });
});

describe('bundles', () => {
  let input: BundleDraftInput;

  async function publishedMaterial(section: AdminMaterial['section'], payload: object, known: Set<string>) {
    const saved = await adminStore.saveMaterial(section, payload, 'test');
    const result = await adminStore.setMaterialStatus(section, saved.id, 'published', { assetExists: (id) => known.has(id) });
    if (!result.ok) throw new Error(`fixture did not publish: ${JSON.stringify(result.blockers)}`);
    return saved.id;
  }

  before(async () => {
    const known = new Set<string>();
    const ids: Record<string, string> = {};
    for (const part of [1, 2, 3, 4]) {
      const asset = await assetStore.create({ originalName: `part-${part}.mp3`, content: Buffer.from(`ID3 part ${part}`), mimeType: 'audio/mpeg', kind: 'audio', createdBy: 'test', sourceType: 'upload' });
      known.add(asset.id);
      ids[`listening-${part}`] = await publishedMaterial('listening', listeningPayload(part, asset.id), known);
    }
    for (const part of [1, 2, 3]) ids[`reading-${part}`] = await publishedMaterial('reading', readingPayload(part), known);
    ids['writing-1'] = await publishedMaterial('writing', writingPayload(), known);
    ids['speaking-1'] = await publishedMaterial('speaking', speakingPayload(), known);
    const components = await Promise.all(
      FULL_SLOTS.map(async ({ section, part }) => {
        const materialId = ids[`${section}-${part}`];
        const material = await adminStore.getMaterial(section, materialId);
        if (!material) throw new Error(`fixture ${section}-${part} is missing`);
        return { section, part, materialId, contentHash: materialContentHash(material) };
      }),
    );
    input = { title: 'Race bundle', module: 'academic', components, timing: CUSTOM_TIMING };
  });

  it('a draft edited while the publish gate is reading it is not published: the publish is refused as changed', async () => {
    const draft = await bundleStore.create(input);
    const list = assetStore.list.bind(assetStore);
    // The gate reads the bundle's components and then the asset index; the edit lands in between.
    assetStore.list = async () => {
      assetStore.list = list;
      await bundleStore.updateDraft(draft.id, { ...input, title: 'Edited while the gate ran', components: [] });
      return list();
    };
    let refused: unknown = null;
    try {
      await publishBundle(draft.id);
    } catch (error) {
      refused = error;
    } finally {
      assetStore.list = list;
    }
    expect(refused instanceof BundleStateError ? refused.code : String(refused)).toBe('bundle_changed');
    const stored = await bundleStore.get(draft.id);
    expect([stored?.status, stored?.title, stored?.components.length]).toEqual(['draft', 'Edited while the gate ran', 0]);
    // Checked again, the gate reads the edited bundle and refuses it on its merits.
    expect((await publishBundle(draft.id)).ok).toBe(false);
  });

  it('withdrawing and retiring a published bundle at the same moment: one happens, the other is refused as changed', async () => {
    const bundle = await bundleStore.create(input);
    expect((await publishBundle(bundle.id)).ok).toBe(true);
    const { results, conflicts } = await race(2, [() => transitionBundle(bundle.id, 'unpublish'), () => transitionBundle(bundle.id, 'archive')]);
    const landed = winners(results);
    expect(landed).toHaveLength(1);
    expect(losers(results).map(codeOf)).toEqual(['bundle_changed']);
    expect(conflicts).toBeGreaterThan(0);
    expect((await bundleStore.get(bundle.id))?.status).toBe(landed[0].status);
  });
});

describe('password reset', () => {
  it('one reset token carried by two requests at once resets the password once', async () => {
    const email = 'reset-race@example.com';
    await authService.register({ email, username: 'reset_race', password: 'Original-Passw0rd' });
    const reset = await authService.requestPasswordReset(email);
    const token = 'resetToken' in reset && reset.resetToken ? reset.resetToken : '';
    expect(token.length).toBeGreaterThan(0);

    const { results, conflicts } = await race(2, [
      () => authService.resetPassword(email, token, 'First-New-Passw0rd'),
      () => authService.resetPassword(email, token, 'Second-New-Passw0rd'),
    ]);
    expect(winners(results)).toHaveLength(1);
    expect(losers(results).map(codeOf)).toEqual(['Invalid or expired reset token.']);
    expect(conflicts).toBeGreaterThan(0);
    const stored = [...fake.documents.entries()].find(([documentPath, data]) => documentPath.startsWith('auth_users/') && data.email === email)?.[1] ?? {};
    expect([stored.sessionVersion, 'resetTokenHash' in stored, 'resetTokenExpiresAt' in stored]).toEqual([1, false, false]);
  });
});

describe('generation ledger and rate limits', () => {
  it('two arrivals of one generation request: one claims it, the other is told it is in progress', async () => {
    const request = { requestId: 'req-race-0001', fingerprint: 'f'.repeat(64), sourceId: 'src-race' };
    const { results, conflicts } = await race(2, [() => generationLog.claim(request, 60_000), () => generationLog.claim(request, 60_000)]);
    expect(winners(results).map((claim) => claim.kind).sort()).toEqual(['claimed', 'in_progress']);
    expect(conflicts).toBeGreaterThan(0);
  });

  it('two requests arriving for the last allowed slot: one is let through, the other refused', async () => {
    const key = 'race-client';
    for (let index = 0; index < 4; index += 1) expect((await requestRateLimitService.check(key, 'forgot_password')).allowed).toBe(true);
    const { results, conflicts } = await race(2, [() => requestRateLimitService.check(key, 'forgot_password'), () => requestRateLimitService.check(key, 'forgot_password')]);
    expect(winners(results).map((decision) => decision.allowed).sort()).toEqual([false, true]);
    expect(conflicts).toBeGreaterThan(0);
  });
});
