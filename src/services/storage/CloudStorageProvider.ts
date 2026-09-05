import { Storage } from '@google-cloud/storage';
import { StorageProvider } from './StorageProvider';

export class CloudStorageProvider implements StorageProvider {
  private readonly bucketName: string;
  private readonly storage: Storage;

  constructor(bucketName = process.env.GCS_BUCKET_NAME) {
    if (!bucketName) throw new Error('GCS_BUCKET_NAME is required for cloud storage.');
    this.bucketName = bucketName;
    this.storage = new Storage({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
  }

  private bucket() { return this.storage.bucket(this.bucketName); }

  async uploadFile(storagePath: string, content: Buffer | Uint8Array | string, contentType?: string): Promise<{ storagePath: string; publicUrl?: string }> {
    const file = this.bucket().file(storagePath);
    await file.save(content, { resumable: false, contentType, metadata: { cacheControl: 'private, max-age=0, no-store' } });
    return { storagePath };
  }

  async downloadFile(storagePath: string): Promise<Buffer> {
    const [data] = await this.bucket().file(storagePath).download();
    return data;
  }

  async deleteFile(storagePath: string): Promise<void> {
    await this.bucket().file(storagePath).delete({ ignoreNotFound: true });
  }

  async fileExists(storagePath: string): Promise<boolean> {
    const [exists] = await this.bucket().file(storagePath).exists();
    return exists;
  }
}
