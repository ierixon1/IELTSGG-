import './env';
import { after, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Firestore } from 'firebase-admin/firestore';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';

/**
 * The scenarios of `npm run verify:firestore` (scripts/firestoreVerification.ts),
 * run against the in-memory Firestore in its optimistic mode.
 *
 * This proves the scenarios are sound and clean up after themselves, so a run
 * against a real project reports on Firestore and not on the script. It proves
 * nothing about real Firestore: H10 stays open until the command has been run
 * against a real project.
 */
process.env.STORAGE_BACKEND = 'gcs_firestore';
process.env.GCS_BUCKET_NAME = 'not-used-uploads-are-stubbed';
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-firestore-verification-'));
process.chdir(tempRoot);

const { FakeFirestore } = await import('./fakeFirestore');
const fake = new FakeFirestore({ concurrency: 'optimistic' });
const { setFirestoreDbForTesting } = await import('../src/services/firebaseAdmin');
setFirestoreDbForTesting(fake as unknown as Firestore);
const { runFirestoreVerification } = await import('../scripts/firestoreVerification');

after(() => {
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

describe('the Firestore verification scenarios, on the in-memory Firestore', () => {
  it('every step passes, and the run leaves nothing behind', async () => {
    const before = new Set(fake.documents.keys());
    const steps = await runFirestoreVerification({ runId: 'suite_run_01', checkTtl: async () => ({ ok: true, detail: 'not applicable to the in-memory Firestore' }) });
    for (const step of steps) expect([step.name, step.ok, step.detail]).toEqual([step.name, true, step.detail]);
    expect(steps.length).toBe(14);
    const left = [...fake.documents.keys()].filter((key) => !before.has(key));
    expect(left).toEqual([]);
  });

  it('asks for both TTL policies, and without Admin API access both fail as not checked, rather than passing', async () => {
    const asked: string[] = [];
    await runFirestoreVerification({ runId: 'suite_run_03', checkTtl: async (collectionGroup, field) => (asked.push(`${collectionGroup}.${field}`), { ok: true, detail: 'recorded' }) });
    expect(asked).toEqual(['rate_limits.expiresAt', 'auth_sessions.expireAt']);
    const steps = await runFirestoreVerification({ runId: 'suite_run_02' });
    const ttl = steps.filter((step) => step.name.startsWith('a TTL policy is active on'));
    expect(ttl.map((step) => [step.ok, step.detail.startsWith('not checked')])).toEqual([[false, true], [false, true]]);
  });
});
