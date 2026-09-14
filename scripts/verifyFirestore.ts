/**
 * H10: the application's Firestore paths against a real Firestore project.
 *
 *   STORAGE_BACKEND=gcs_firestore FIRESTORE_VERIFY_PROJECT=<project id> \
 *     npm run verify:firestore -- --confirm-dedicated-project
 *
 * Use a project that holds no production data. The run writes to the collections
 * the application uses (`auth_users`, `auth_sessions`, `users`, `rate_limits`),
 * under ids named after a random run id, and deletes them at the end.
 *
 * Credentials are the application's: `FIREBASE_PROJECT_ID`,
 * `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`, or Application Default
 * Credentials. `FIRESTORE_VERIFY_PROJECT` must name the same project the
 * credentials are for, and `--confirm-dedicated-project` must be given: both
 * guard against running this against the wrong project by accident.
 *
 * Checked (scripts/firestoreVerification.ts): a read; register, sign-in and
 * session validation; `expireAt` on sessions; a learner refused at staff sign-in
 * before any session is created; a profile written and read back; a transactional
 * promotion ending all of an account's sessions, 450 extra included, in chunked
 * commits; a source with 450 chunks deleted in chunked commits; concurrent requests
 * on one rate-limit key never exceeding the allowance, with any transaction that
 * fails under contention classified as storage unavailable (503); attempts given
 * back concurrently; and `expiresAt` on rate-limit documents. The TTL policies on
 * `rate_limits.expiresAt` and `auth_sessions.expireAt` are read through the
 * Firestore Admin API, which needs the Cloud Datastore Index Admin role (or Owner)
 * for these credentials. The run also writes `admin_content/sources`.
 *
 * Not exercised against the real project: an outage and recovery — cutting a real
 * project off safely is not something a script can do. Block the host's access to
 * firestore.googleapis.com while the server runs and check that API requests
 * answer 503 `storage_unavailable` and succeed again once access returns.
 *
 * Exit status: 0 every step passed; 1 a step failed; 78 not configured.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';

const refuse = (message: string): never => {
  console.error(message);
  process.exit(78);
};

const project = (process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '').trim();
const confirmed = (process.env.FIRESTORE_VERIFY_PROJECT || '').trim();
if (process.env.STORAGE_BACKEND !== 'gcs_firestore') refuse('Set STORAGE_BACKEND=gcs_firestore: this verifies Firestore.');
if (process.env.NODE_ENV === 'production') refuse('Refused with NODE_ENV=production: run it against a dedicated verification project, not a deployment.');
if (!process.argv.includes('--confirm-dedicated-project')) refuse('Pass --confirm-dedicated-project to confirm the project holds no production data.');
if (!project) refuse('Set FIREBASE_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) to the project to verify.');
if (confirmed !== project) refuse(`FIRESTORE_VERIFY_PROJECT must repeat the project id the credentials are for (${project}).`);

const { runFirestoreVerification } = await import('./firestoreVerification');

async function checkTtl(collectionGroup: string, fieldPath: string): Promise<{ ok: boolean; detail: string }> {
  const { v1 } = await import('@google-cloud/firestore');
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const client = new v1.FirestoreAdminClient(clientEmail && privateKey ? { projectId: project, credentials: { client_email: clientEmail, private_key: privateKey } } : { projectId: project });
  try {
    const [field] = await client.getField({ name: `projects/${project}/databases/(default)/collectionGroups/${collectionGroup}/fields/${fieldPath}` });
    const state = field.ttlConfig?.state;
    // The generated client types the enum as its name; over gRPC it can also arrive as its number (ACTIVE = 2).
    const active = String(state) === 'ACTIVE' || Number(state) === 2;
    return { ok: active, detail: field.ttlConfig ? `ttlConfig.state ${String(state)}` : `no TTL policy on ${collectionGroup}.${fieldPath} — see README, Deployment` };
  } finally {
    await client.close();
  }
}

const runId = `run_${randomBytes(6).toString('hex')}`;
console.log(`H10 Firestore verification — project ${project}, run ${runId}`);
const steps = await runFirestoreVerification({ runId, checkTtl });
for (const step of steps) console.log(`${step.ok ? 'PASS' : 'FAIL'}  ${step.name} — ${step.detail}`);
console.log('NOT EXERCISED  an outage and recovery against the real project (see the header of this script).');
const failed = steps.filter((step) => !step.ok).length;
console.log(`RESULT  ${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed === 0 ? 0 : 1);
