import fs from 'fs';
import path from 'path';
import { StorageProvider } from './StorageProvider';

export class LocalStorageProvider implements StorageProvider {
  private baseDir: string;

  constructor(baseDir = 'data/uploads') {
    this.baseDir = path.resolve(process.cwd(), baseDir);
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private resolvePath(storagePath: string): string {
    // Prevent path traversal
    const safePath = path.normalize(storagePath).replace(/^(\.\.[\/\\])+/, '');
    return path.join(this.baseDir, safePath);
  }

  async uploadFile(
    storagePath: string,
    content: Buffer | Uint8Array | string,
    contentType?: string
  ): Promise<{ storagePath: string; publicUrl?: string }> {
    const fullPath = this.resolvePath(storagePath);
    const parent = path.dirname(fullPath);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }

    if (typeof content === 'string') {
      await fs.promises.writeFile(fullPath, content, 'utf8');
    } else {
      await fs.promises.writeFile(fullPath, Buffer.from(content));
    }

    return { storagePath, publicUrl: `/api/storage/raw/${encodeURIComponent(storagePath)}` };
  }

  async downloadFile(storagePath: string): Promise<Buffer> {
    const fullPath = this.resolvePath(storagePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${storagePath}`);
    }
    return await fs.promises.readFile(fullPath);
  }

  async deleteFile(storagePath: string): Promise<void> {
    const fullPath = this.resolvePath(storagePath);
    if (fs.existsSync(fullPath)) {
      await fs.promises.unlink(fullPath);
    }
  }

  async fileExists(storagePath: string): Promise<boolean> {
    const fullPath = this.resolvePath(storagePath);
    return fs.existsSync(fullPath);
  }
}
