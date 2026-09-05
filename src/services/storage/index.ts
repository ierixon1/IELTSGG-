import { StorageProvider } from './StorageProvider';
import { DataStore } from './DataStore';
import { LocalStorageProvider } from './LocalStorageProvider';
import { LocalJsonDataStore } from './LocalJsonDataStore';
import { CloudStorageProvider } from './CloudStorageProvider';
import { FirestoreDataStore } from './FirestoreDataStore';

export * from './types';
export * from './StorageProvider';
export * from './DataStore';

const isProductionCloud = process.env.STORAGE_BACKEND === 'gcs_firestore';

export const storageProvider: StorageProvider = isProductionCloud
  ? new CloudStorageProvider()
  : new LocalStorageProvider();

export const dataStore: DataStore = isProductionCloud
  ? new FirestoreDataStore()
  : new LocalJsonDataStore();
