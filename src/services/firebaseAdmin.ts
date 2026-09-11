import { App, applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';

let app: App | null = null;
let db: Firestore | null = null;

export function getFirebaseApp(): App {
  if (app) return app;
  if (getApps().length > 0) {
    app = getApps()[0];
    return app;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (projectId && clientEmail && privateKey) {
    app = initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
      projectId,
    });
    return app;
  }

  app = projectId
    ? initializeApp({ projectId, credential: applicationDefault() })
    : initializeApp({ credential: applicationDefault() });
  return app;
}

/**
 * An optional field that is `undefined` is stored as absent, as it is in every
 * JSON store this app writes. Without this, Firestore refuses the whole
 * document — and canonical materials carry optional fields on every question —
 * so a save that works locally fails in production.
 */
const FIRESTORE_SETTINGS = { ignoreUndefinedProperties: true } as const;

export function getFirestoreDb(): Firestore {
  if (!db) {
    db = getFirestore(getFirebaseApp());
    db.settings(FIRESTORE_SETTINGS);
  }
  return db;
}

/**
 * Points every Firestore reader at `instance` instead of a real project.
 *
 * For tests only: there is no Firestore emulator in this environment, so the
 * Firestore code paths are exercised against an in-memory implementation that
 * enforces the rules real Firestore enforces on writes. Refused in production.
 */
export function setFirestoreDbForTesting(instance: Firestore): void {
  if (process.env.NODE_ENV === 'production') throw new Error('The Firestore test seam is not available in production.');
  instance.settings(FIRESTORE_SETTINGS);
  db = instance;
}
