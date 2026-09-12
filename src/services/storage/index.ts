import fs from 'fs';
import path from 'path';
import { StorageProvider } from './StorageProvider';
import { DataStore } from './DataStore';
import { LocalStorageProvider } from './LocalStorageProvider';
import { LocalJsonDataStore } from './LocalJsonDataStore';
import { CloudStorageProvider } from './CloudStorageProvider';
import { FirestoreDataStore } from './FirestoreDataStore';
import { getFirestoreDb } from '../firebaseAdmin';

export * from './types';
export * from './StorageProvider';
export * from './DataStore';

const isProduction = process.env.NODE_ENV === 'production';
const isProductionCloud = process.env.STORAGE_BACKEND === 'gcs_firestore';
const explicitLocalStorage = process.env.STORAGE_BACKEND === 'local';

if (isProduction && !isProductionCloud) {
  throw new Error('Production requires STORAGE_BACKEND=gcs_firestore. Local file storage is not permitted.');
}

if (!isProduction && !isProductionCloud && !explicitLocalStorage) {
  throw new Error('STORAGE_BACKEND must be explicitly set to local or gcs_firestore.');
}

export const storageProvider: StorageProvider = isProductionCloud
  ? new CloudStorageProvider()
  : new LocalStorageProvider();

export const dataStore: DataStore = isProductionCloud
  ? new FirestoreDataStore()
  : new LocalJsonDataStore();

export type StorageBackend = 'local' | 'gcs_firestore';

export interface StorageHealth {
  backend: StorageBackend;
  status: 'ok' | 'unavailable';
}

/** The data backend this process was started with. */
export const storageBackend: StorageBackend = isProductionCloud ? 'gcs_firestore' : 'local';

/**
 * Whether the data backend answers right now, for `/api/health`.
 *
 * Firestore is asked for one document through the same client, in the same
 * collection, that every API request reads first (the request rate limiter). A
 * deployment with no credentials, no project or no route to Google therefore
 * reports `unavailable` instead of `ok`. The document is never written; only its
 * absence is read. The local store reports whether its data directory can be
 * read and written.
 *
 * Bounded by `timeoutMs`: a Firestore client without credentials takes about ten
 * seconds to give up, and a health check that hangs that long answers nothing.
 */
export async function checkStorageHealth(timeoutMs = 5000): Promise<StorageHealth> {
  const probe = (async () => {
    if (storageBackend === 'gcs_firestore') await getFirestoreDb().collection('rate_limits').doc('health-check').get();
    else await fs.promises.access(path.join(process.cwd(), 'data'), fs.constants.R_OK | fs.constants.W_OK);
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`The ${storageBackend} backend did not answer within ${timeoutMs} ms.`)), timeoutMs);
  });
  try {
    await Promise.race([probe, deadline]);
    return { backend: storageBackend, status: 'ok' };
  } catch (error) {
    console.error('[Health] The data backend check failed:', error instanceof Error ? error.message : error);
    return { backend: storageBackend, status: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}
