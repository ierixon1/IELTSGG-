/**
 * Whether an error means the data backend cannot be used at all, as opposed to a
 * request being wrong or code being broken. Those are answered 503: the server
 * is up, the data it needs is not.
 */

/**
 * gRPC status codes Firestore reports when the service, not the request, is the
 * problem. `PERMISSION_DENIED` and `UNAUTHENTICATED` belong here because the
 * Admin SDK bypasses security rules: they only happen when this deployment's own
 * credentials are wrong.
 */
const UNAVAILABLE_GRPC_CODES = new Set([
  4, // DEADLINE_EXCEEDED
  7, // PERMISSION_DENIED
  8, // RESOURCE_EXHAUSTED
  14, // UNAVAILABLE
  16, // UNAUTHENTICATED
]);

/**
 * How google-auth-library says this process has nothing to authenticate with.
 * These errors carry no code, only the message — reproduced with
 * `STORAGE_BACKEND=gcs_firestore` and no credentials, with and without
 * `FIREBASE_PROJECT_ID`.
 */
const CREDENTIAL_FAILURE_PREFIXES = [
  'Could not load the default credentials',
  'Unable to detect a Project Id in the current environment',
];

export function isStorageUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, details } = error as Error & { code?: unknown; details?: unknown };
  if (typeof code === 'number' && typeof details === 'string' && UNAVAILABLE_GRPC_CODES.has(code)) return true;
  return CREDENTIAL_FAILURE_PREFIXES.some((prefix) => error.message.startsWith(prefix));
}
