export interface StorageProvider {
  uploadFile(
    storagePath: string,
    content: Buffer | Uint8Array | string,
    contentType?: string
  ): Promise<{ storagePath: string; publicUrl?: string }>;

  downloadFile(storagePath: string): Promise<Buffer>;

  deleteFile(storagePath: string): Promise<void>;

  fileExists(storagePath: string): Promise<boolean>;
}
