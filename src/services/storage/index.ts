import { StorageProvider } from './StorageProvider';
import { DataStore } from './DataStore';
import { LocalStorageProvider } from './LocalStorageProvider';
import { LocalJsonDataStore } from './LocalJsonDataStore';
import { CloudStorageProvider } from './CloudStorageProvider';
import { FirestoreDataStore } from './FirestoreDataStore';

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
