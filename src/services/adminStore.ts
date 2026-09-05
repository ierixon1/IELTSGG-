import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { 
  AdminSpeakingMaterial, 
  AdminReadingMaterial, 
  AdminListeningMaterial, 
  AdminWritingMaterial, 
  FullCdiBundle,
  AdminStats 
} from '../types/admin';

const DATA_DIR = path.join(process.cwd(), 'data', 'admin_content');
const UPLOADS_DIR = path.join(process.cwd(), 'data', 'uploads');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

type SectionType = 'speaking' | 'reading' | 'listening' | 'writing';

class AdminStore {
  private getFilePath(collection: string): string {
    return path.join(DATA_DIR, `${collection}.json`);
  }

  private readCollection<T>(collection: string): T[] {
    const filePath = this.getFilePath(collection);
    try {
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify([], null, 2), 'utf-8');
        return [];
      }
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as T[];
    } catch (err) {
      console.error(`[AdminStore] Error reading collection ${collection}:`, err);
      return [];
    }
  }

  private writeCollection<T>(collection: string, items: T[]): void {
    const filePath = this.getFilePath(collection);
    try {
      fs.writeFileSync(filePath, JSON.stringify(items, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[AdminStore] Error writing collection ${collection}:`, err);
    }
  }

  // Generic CRUD for Materials
  public listMaterials(section: SectionType, statusFilter?: 'all' | 'published' | 'draft'): any[] {
    const items = this.readCollection<any>(section);
    if (statusFilter && statusFilter !== 'all') {
      return items.filter(item => item.status === statusFilter);
    }
    return items;
  }

  public getMaterial(section: SectionType, id: string): any | null {
    const items = this.readCollection<any>(section);
    return items.find(item => item.id === id) || null;
  }

  public saveMaterial(section: SectionType, materialData: any, author: string = 'Admin'): any {
    const items = this.readCollection<any>(section);
    const now = new Date().toISOString();

    if (materialData.id) {
      // Update
      const index = items.findIndex(item => item.id === materialData.id);
      if (index >= 0) {
        const updated = {
          ...items[index],
          ...materialData,
          updatedAt: now,
        };
        items[index] = updated;
        this.writeCollection(section, items);
        return updated;
      }
    }

    // Create new
    const newId = materialData.id || `adm-${section.substring(0, 3)}-${Date.now()}-${nanoid(5)}`;
    const newItem = {
      ...materialData,
      id: newId,
      section,
      status: materialData.status || 'published',
      author: materialData.author || author,
      createdAt: now,
      updatedAt: now,
    };

    items.unshift(newItem);
    this.writeCollection(section, items);
    return newItem;
  }

  public deleteMaterial(section: SectionType, id: string): boolean {
    const items = this.readCollection<any>(section);
    const initialLen = items.length;
    const filtered = items.filter(item => item.id !== id);
    if (filtered.length !== initialLen) {
      this.writeCollection(section, filtered);
      return true;
    }
    return false;
  }

  // CDI Bundles CRUD
  public listBundles(statusFilter?: 'all' | 'published' | 'draft'): FullCdiBundle[] {
    const items = this.readCollection<FullCdiBundle>('bundles');
    if (statusFilter && statusFilter !== 'all') {
      return items.filter(item => item.status === statusFilter);
    }
    return items;
  }

  public getBundle(id: string): FullCdiBundle | null {
    const items = this.readCollection<FullCdiBundle>('bundles');
    return items.find(b => b.id === id) || null;
  }

  public saveBundle(bundleData: Partial<FullCdiBundle>): FullCdiBundle {
    const items = this.readCollection<FullCdiBundle>('bundles');
    const now = new Date().toISOString();

    if (bundleData.id) {
      const index = items.findIndex(b => b.id === bundleData.id);
      if (index >= 0) {
        const updated: FullCdiBundle = {
          ...items[index],
          ...bundleData,
          updatedAt: now,
        } as FullCdiBundle;
        items[index] = updated;
        this.writeCollection('bundles', items);
        return updated;
      }
    }

    const newId = bundleData.id || `cdi-bundle-${Date.now()}-${nanoid(5)}`;
    const newBundle: FullCdiBundle = {
      id: newId,
      title: bundleData.title || 'Untitled IELTS Full CDI Test',
      module: bundleData.module || 'academic',
      targetBand: bundleData.targetBand || '7.0-7.5',
      status: bundleData.status || 'draft',
      description: bundleData.description || '',
      createdAt: now,
      updatedAt: now,
      timings: bundleData.timings || {
        listeningMinutes: 30,
        readingMinutes: 60,
        writingMinutes: 60,
        speakingMinutes: 15,
      },
      materials: bundleData.materials || {},
    };

    items.unshift(newBundle);
    this.writeCollection('bundles', items);
    return newBundle;
  }

  public deleteBundle(id: string): boolean {
    const items = this.readCollection<FullCdiBundle>('bundles');
    const initialLen = items.length;
    const filtered = items.filter(b => b.id !== id);
    if (filtered.length !== initialLen) {
      this.writeCollection('bundles', filtered);
      return true;
    }
    return false;
  }

  // Stats
  public getStats(): AdminStats {
    const speaking = this.readCollection<AdminSpeakingMaterial>('speaking');
    const reading = this.readCollection<AdminReadingMaterial>('reading');
    const listening = this.readCollection<AdminListeningMaterial>('listening');
    const writing = this.readCollection<AdminWritingMaterial>('writing');
    const bundles = this.readCollection<FullCdiBundle>('bundles');
    
    let fileCount = 0;
    let totalBytes = 0;
    if (fs.existsSync(UPLOADS_DIR)) {
      const files = fs.readdirSync(UPLOADS_DIR);
      fileCount = files.length;
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(UPLOADS_DIR, f));
          totalBytes += stat.size;
        } catch {}
      }
    }

    const allMaterials = [...speaking, ...reading, ...listening, ...writing];

    return {
      totalMaterials: allMaterials.length,
      publishedMaterials: allMaterials.filter(m => m.status === 'published').length,
      draftMaterials: allMaterials.filter(m => m.status === 'draft').length,
      bySection: {
        speaking: speaking.length,
        reading: reading.length,
        listening: listening.length,
        writing: writing.length,
      },
      totalBundles: bundles.length,
      uploadedFilesCount: fileCount,
      uploadedTotalBytes: totalBytes,
    };
  }

  // Retrieve full resolved bundle with its sub-materials for student exam taking
  public getResolvedBundle(id: string): { bundle: FullCdiBundle; resolvedMaterials: any } | null {
    const bundle = this.getBundle(id);
    if (!bundle) return null;

    const listening = bundle.materials.listeningId ? this.getMaterial('listening', bundle.materials.listeningId) : null;
    const reading = bundle.materials.readingId ? this.getMaterial('reading', bundle.materials.readingId) : null;
    const writing = bundle.materials.writingId ? this.getMaterial('writing', bundle.materials.writingId) : null;
    const speaking = bundle.materials.speakingId ? this.getMaterial('speaking', bundle.materials.speakingId) : null;

    return {
      bundle,
      resolvedMaterials: {
        listening,
        reading,
        writing,
        speaking,
      },
    };
  }
}

export const adminStore = new AdminStore();
export { UPLOADS_DIR };
