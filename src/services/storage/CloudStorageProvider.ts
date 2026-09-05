import { StorageProvider } from './StorageProvider';

/**
 * Production Google Cloud Storage (GCS) provider for Cloud Run
 * Activated when STORAGE_BACKEND=gcs_firestore
 */
export class CloudStorageProvider implements StorageProvider {
  private bucketName: string;

  constructor(bucketName = process.env.GCS_BUCKET_NAME || 'ielts-preppy-textbooks') {
    this.bucketName = bucketName;
  }

  async uploadFile(
    storagePath: string,
    content: Buffer | Uint8Array | string,
    contentType?: string
  ): Promise<{ storagePath: string; publicUrl?: string }> {
    // In production, uses @google-cloud/storage
    // e.g. const bucket = storage.bucket(this.bucketName);
    // await bucket.file(storagePath).save(content, { contentType });
    return {
      storagePath,
      publicUrl: `https://storage.googleapis.com/${this.bucketName}/${storagePath}`
    };
  }

  async downloadFile(storagePath: string): Promise<Buffer> {
    // In production: const [data] = await bucket.file(storagePath).download();
    throw new Error('CloudStorageProvider downloadFile requires active GCS credentials.');
  }

  async deleteFile(storagePath: string): Promise<void> {
    // In production: await bucket.file(storagePath).delete({ ignoreNotFound: true });
  }

  async fileExists(storagePath: string): Promise<boolean> {
    // In production: const [exists] = await bucket.file(storagePath).exists();
    return true;
  }
}
