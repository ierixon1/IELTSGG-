import { existsSync } from 'node:fs';
import { trustProxySetting, TrustProxyConfigError, type TrustProxySetting } from '../http/clientAddress';

/**
 * What the server needs from its environment, checked before anything else is
 * loaded, so a deployment that is missing something stops at once with every
 * problem named — instead of starting and failing on the first request that needs
 * the missing piece, or quietly doing without it (a password reset that sends
 * nothing, an app nobody can route to).
 *
 * In every mode: `PORT` and `TRUST_PROXY` must be readable, and a configured
 * promotion must name a real role. Outside production an unset `PORT` is 3000.
 *
 * In production (`NODE_ENV=production`), nothing is assumed:
 *   - `PORT` and `TRUST_PROXY` are set explicitly (`TRUST_PROXY=false` when
 *     clients connect directly);
 *   - `STORAGE_BACKEND=gcs_firestore` and `GCS_BUCKET_NAME`;
 *   - Firestore credentials are either a complete service-account key
 *     (`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`) or
 *     none of the key's parts, for Application Default Credentials — and a
 *     `GOOGLE_APPLICATION_CREDENTIALS` file that is named exists;
 *   - password reset email: `RESEND_API_KEY`, `EMAIL_FROM`, and an https `APP_URL`;
 *   - development switches are off: `EXPLICIT_DEV_AUTH` and `SEED_DEFAULT_ACCOUNTS`.
 *
 * No message repeats a secret's value.
 */

export const DEVELOPMENT_PORT = 3000;

export interface StartupConfig {
  port: number;
  trustProxy: TrustProxySetting;
  production: boolean;
}

type Env = Record<string, string | undefined>;

const read = (env: Env, name: string) => (env[name] ?? '').trim();

export function checkStartupConfig(env: Env): { config: StartupConfig | null; problems: string[] } {
  const problems: string[] = [];
  const production = read(env, 'NODE_ENV') === 'production';

  let port = DEVELOPMENT_PORT;
  const rawPort = read(env, 'PORT');
  if (rawPort) {
    if (/^\d{1,5}$/.test(rawPort) && Number(rawPort) >= 1 && Number(rawPort) <= 65535) port = Number(rawPort);
    else problems.push(`PORT must be a whole number from 1 to 65535; got "${rawPort.slice(0, 16)}".`);
  } else if (production) {
    problems.push('PORT must be set in production: the port the platform sends traffic to (Cloud Run sets it).');
  }

  let trustProxy: TrustProxySetting = false;
  try {
    trustProxy = trustProxySetting(env.TRUST_PROXY);
  } catch (error) {
    if (!(error instanceof TrustProxyConfigError)) throw error;
    problems.push(error.message);
  }
  if (production && !read(env, 'TRUST_PROXY')) {
    problems.push(
      'TRUST_PROXY must be set in production: the number of proxies in front of the server (1 behind Cloud Run or one load balancer), their addresses, or false when clients connect directly.',
    );
  }

  // M11: the impersonation switch needs NODE_ENV to say development or test, not merely "not production".
  const nodeEnv = read(env, 'NODE_ENV');
  if (!production && read(env, 'EXPLICIT_DEV_AUTH') === 'true' && nodeEnv !== 'development' && nodeEnv !== 'test') {
    problems.push(
      `EXPLICIT_DEV_AUTH=true lets any request act as any account; it is allowed only with NODE_ENV=development or test, and NODE_ENV is ${nodeEnv ? `"${nodeEnv.slice(0, 32)}"` : 'unset'}.`,
    );
  }

  if (read(env, 'ADMIN_PROMOTE_USERNAME')) {
    const role = (read(env, 'ADMIN_PROMOTE_ROLE') || 'admin').toLowerCase();
    if (role !== 'admin' && role !== 'examiner') problems.push(`ADMIN_PROMOTE_ROLE must be admin or examiner; got "${role.slice(0, 32)}".`);
  }

  if (production) {
    if (read(env, 'STORAGE_BACKEND') !== 'gcs_firestore') problems.push('STORAGE_BACKEND must be gcs_firestore in production; local file storage is not permitted.');
    if (!read(env, 'GCS_BUCKET_NAME')) problems.push('GCS_BUCKET_NAME must name the Cloud Storage bucket uploaded files are kept in.');

    const keyParts = ['FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'].filter((name) => read(env, name));
    if (keyParts.length === 1) {
      problems.push(
        'FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY go together: set both, with FIREBASE_PROJECT_ID, to use a service-account key, or neither to use Application Default Credentials.',
      );
    } else if (keyParts.length === 2) {
      if (!read(env, 'FIREBASE_PROJECT_ID')) problems.push('FIREBASE_PROJECT_ID must be set with FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.');
      if (!read(env, 'FIREBASE_PRIVATE_KEY').includes('PRIVATE KEY')) {
        problems.push('FIREBASE_PRIVATE_KEY is not a PEM private key (it should contain -----BEGIN PRIVATE KEY-----, with \\n for line breaks).');
      }
    }
    const credentialsFile = read(env, 'GOOGLE_APPLICATION_CREDENTIALS');
    if (credentialsFile && !existsSync(credentialsFile)) problems.push(`GOOGLE_APPLICATION_CREDENTIALS names a file that does not exist: ${credentialsFile.slice(0, 200)}`);

    for (const name of ['RESEND_API_KEY', 'EMAIL_FROM', 'APP_URL']) {
      if (!read(env, name)) problems.push(`${name} must be set in production: without it password reset emails cannot be sent.`);
    }
    const appUrl = read(env, 'APP_URL');
    if (appUrl) {
      let protocol = '';
      try {
        protocol = new URL(appUrl).protocol;
      } catch {
        protocol = 'invalid';
      }
      if (protocol !== 'https:') problems.push(`APP_URL must be the https:// address learners open the app at; got "${appUrl.slice(0, 100)}".`);
    }

    if (read(env, 'EXPLICIT_DEV_AUTH') === 'true') problems.push('EXPLICIT_DEV_AUTH=true is a development switch (acting as any account through x-user-id) and is refused in production.');
    if (read(env, 'SEED_DEFAULT_ACCOUNTS') === 'true') {
      problems.push(
        'SEED_DEFAULT_ACCOUNTS seeds only the local development store and does nothing on Firestore. Create the first administrator with ADMIN_PROMOTE_USERNAME or npm run admin:promote (README, Deployment).',
      );
    }
  }

  return { config: problems.length === 0 ? { port, trustProxy, production } : null, problems };
}
