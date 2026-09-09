import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { getFirestoreDb } from './firebaseAdmin';
import { storageProvider } from './storage';
import { adminStore, PRIVATE_UPLOADS_DIR } from './adminStore';
import type { Asset, AssetKind, AssetSourceType, AssetState } from '../types/asset';

/**
 * Storage for uploaded files, addressed by id.
 *
 * Before this existed, an upload wrote a file record and returned a URL, and
 * the editor copied the *content* into the material. Nothing recorded which
 * material used which file, so `StorageProvider.deleteFile` — implemented in
 * both providers — had no caller at all and every upload was a guaranteed
 * orphan. Deleting a material removed the record and left the bytes behind.
 *
 * Assets now have a lifecycle. An upload lands `staged`; saving a material that
 * references it promotes it to `active`; deleting the last material that
 * references it releases it. `reapUnreferenced` clears whatever is left.
 */

const DATA_DIR = path.join(process.cwd(), 'data', 'admin_content');
const ASSETS_FILE = path.join(DATA_DIR, 'assets.json');
const useFirestore = () =>
  process.env.NODE_ENV === 'production' || process.env.STORAGE_BACKEND === 'gcs_firestore';
const useCloudFiles = () => useFirestore();

/** How long a staged asset may sit unreferenced before the reaper takes it. */
export const STAGED_ASSET_TTL_MS = 24 * 60 * 60 * 1000;

const ASSET_ID = /^ast_[A-Za-z0-9_-]{10,32}$/;
export const isAssetId = (value: unknown): value is string => ASSET_ID.test(String(value));

function ensureLocalDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PRIVATE_UPLOADS_DIR)) fs.mkdirSync(PRIVATE_UPLOADS_DIR, { recursive: true });
}

export interface CreateAssetInput {
  originalName: string;
  content: Buffer;
  mimeType: string;
  kind: AssetKind;
  createdBy: string;
  sourceType: AssetSourceType;
  derivedFromAssetId?: string;
}

class AssetStore {
  private readAll(): Asset[] {
    ensureLocalDirs();
    try {
      if (!fs.existsSync(ASSETS_FILE)) {
        fs.writeFileSync(ASSETS_FILE, '[]', 'utf-8');
        return [];
      }
      const value = JSON.parse(fs.readFileSync(ASSETS_FILE, 'utf-8'));
      return Array.isArray(value) ? (value as Asset[]) : [];
    } catch {
      return [];
    }
  }

  private writeAll(assets: Asset[]): void {
    ensureLocalDirs();
    const tmp = `${ASSETS_FILE}.tmp.${process.pid}.${Date.now()}.${nanoid(4)}`;
    fs.writeFileSync(tmp, JSON.stringify(assets, null, 2), 'utf-8');
    fs.renameSync(tmp, ASSETS_FILE);
  }

  /**
   * Stores bytes and records them as a staged asset.
   *
   * The storage path is derived from the generated id, never from the uploaded
   * filename, so a name can never escape the uploads directory.
   */
  public async create(input: CreateAssetInput): Promise<Asset> {
    const id = `ast_${nanoid(16)}`;
    const sha256 = crypto.createHash('sha256').update(input.content).digest('hex');
    const storagePath = useCloudFiles() ? `admin_assets/${id}` : id;

    if (useCloudFiles()) {
      await storageProvider.uploadFile(storagePath, input.content, input.mimeType);
    } else {
      ensureLocalDirs();
      fs.writeFileSync(path.join(PRIVATE_UPLOADS_DIR, id), input.content);
    }

    const asset: Asset = {
      id,
      originalName: String(input.originalName || 'upload').slice(0, 200),
      storagePath,
      mimeType: input.mimeType,
      size: input.content.length,
      sha256,
      kind: input.kind,
      state: 'staged',
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
      sourceType: input.sourceType,
      derivedFromAssetId: input.derivedFromAssetId,
    };

    if (useFirestore()) {
      await getFirestoreDb().collection('admin_assets').doc(id).set(asset);
    } else {
      const assets = this.readAll();
      assets.unshift(asset);
      this.writeAll(assets);
    }
    return asset;
  }

  public async get(id: string): Promise<Asset | null> {
    if (!isAssetId(id)) return null;
    if (useFirestore()) {
      const snap = await getFirestoreDb().collection('admin_assets').doc(id).get();
      return snap.exists ? ((snap.data() || null) as Asset | null) : null;
    }
    return this.readAll().find((a) => a.id === id) || null;
  }

  public async list(): Promise<Asset[]> {
    if (useFirestore()) {
      const snap = await getFirestoreDb().collection('admin_assets').get();
      return snap.docs.map((d: any) => d.data() as Asset);
    }
    return this.readAll();
  }

  public async readContent(asset: Asset): Promise<Buffer> {
    if (useCloudFiles()) return storageProvider.downloadFile(asset.storagePath);
    const full = path.resolve(PRIVATE_UPLOADS_DIR, path.basename(asset.storagePath));
    if (!full.startsWith(path.resolve(PRIVATE_UPLOADS_DIR) + path.sep)) {
      throw new Error('Refusing to read outside the uploads directory.');
    }
    return fs.promises.readFile(full);
  }

  private async setState(ids: string[], state: AssetState): Promise<void> {
    if (ids.length === 0) return;
    if (useFirestore()) {
      const db = getFirestoreDb();
      const batch = db.batch();
      for (const id of ids) batch.set(db.collection('admin_assets').doc(id), { state }, { merge: true });
      await batch.commit();
      return;
    }
    const assets = this.readAll();
    let changed = false;
    for (const asset of assets) {
      if (ids.includes(asset.id) && asset.state !== state) {
        asset.state = state;
        changed = true;
      }
    }
    if (changed) this.writeAll(assets);
  }

  /** Promotes the assets a saved material references. */
  public async promote(ids: string[]): Promise<void> {
    await this.setState(ids.filter(isAssetId), 'active');
  }

  /**
   * Every asset id referenced by any stored material, across all four sections
   * and all bundles.
   *
   * Computed by scanning rather than by keeping a counter: a counter that
   * drifts silently deletes a file that is still in use, and there are few
   * enough materials that scanning is not worth optimising away.
   */
  public async collectReferencedIds(): Promise<Set<string>> {
    const sections = ['speaking', 'reading', 'listening', 'writing'] as const;
    const lists = await Promise.all(sections.map((section) => adminStore.listMaterials(section)));
    const referenced = new Set<string>();
    for (const item of lists.flat()) for (const id of extractAssetIds(item)) referenced.add(id);
    return referenced;
  }

  /**
   * Marks assets active or staged to match what materials actually reference.
   * Run after any material write or delete.
   */
  public async reconcile(): Promise<{ active: number; staged: number }> {
    const referenced = await this.collectReferencedIds();
    const assets = await this.list();

    const toActivate: string[] = [];
    const toRelease: string[] = [];
    for (const asset of assets) {
      const shouldBeActive = referenced.has(asset.id);
      if (shouldBeActive && asset.state !== 'active') toActivate.push(asset.id);
      if (!shouldBeActive && asset.state === 'active') toRelease.push(asset.id);
    }

    await this.setState(toActivate, 'active');
    await this.setState(toRelease, 'staged');
    return { active: toActivate.length, staged: toRelease.length };
  }

  /** True when any material still references this asset. */
  public async isReferenced(id: string): Promise<boolean> {
    return (await this.collectReferencedIds()).has(id);
  }

  private async destroy(asset: Asset): Promise<void> {
    try {
      if (useCloudFiles()) await storageProvider.deleteFile(asset.storagePath);
      else await fs.promises.unlink(path.join(PRIVATE_UPLOADS_DIR, path.basename(asset.storagePath)));
    } catch {
      /* Already gone is the outcome we wanted. */
    }
    if (useFirestore()) await getFirestoreDb().collection('admin_assets').doc(asset.id).delete();
    else this.writeAll(this.readAll().filter((a) => a.id !== asset.id));
  }

  /**
   * Deletes staged assets that nothing references and that are older than the
   * grace period — an editor left open mid-upload should not lose its file.
   *
   * A derived asset is kept while its original is kept, so re-processing an
   * imported page later is still possible.
   */
  public async reapUnreferenced(now = Date.now()): Promise<string[]> {
    const referenced = await this.collectReferencedIds();
    const assets = await this.list();
    const keep = new Set(referenced);
    for (const asset of assets) {
      if (asset.derivedFromAssetId && referenced.has(asset.id)) keep.add(asset.derivedFromAssetId);
    }

    const removed: string[] = [];
    for (const asset of assets) {
      if (keep.has(asset.id)) continue;
      if (now - Date.parse(asset.createdAt || '') < STAGED_ASSET_TTL_MS) continue;
      await this.destroy(asset);
      removed.push(asset.id);
    }
    return removed;
  }

  /**
   * Releases the assets a deleted material held, removing any that nothing else
   * references. Assets shared with another material are left alone.
   */
  public async releaseForDeletedMaterial(material: unknown): Promise<string[]> {
    const candidates = extractAssetIds(material);
    if (candidates.length === 0) return [];

    const referenced = await this.collectReferencedIds();
    const removed: string[] = [];
    for (const id of candidates) {
      if (referenced.has(id)) continue;
      const asset = await this.get(id);
      if (!asset) continue;
      const derived = (await this.list()).filter((a) => a.derivedFromAssetId === id);
      for (const child of derived) {
        if (!referenced.has(child.id)) {
          await this.destroy(child);
          removed.push(child.id);
        }
      }
      await this.destroy(asset);
      removed.push(id);
    }
    return removed;
  }
}

/**
 * Every asset id a material mentions: the explicit `assetIds`/`sourceAssetId`
 * fields, and any `/api/assets/<id>` URL embedded anywhere in its content.
 */
export function extractAssetIds(value: unknown): string[] {
  const found = new Set<string>();

  const walk = (node: unknown) => {
    if (!node) return;
    if (typeof node === 'string') {
      for (const match of node.matchAll(/\/api\/(?:admin\/)?assets\/(ast_[A-Za-z0-9_-]{10,32})/g)) {
        found.add(match[1]);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object') return;

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      // Any field whose name ends in `assetId(s)` — `audioAssetId`,
      // `sourceAssetId`, `task1ImageAssetId`. Matching an exact list means a
      // new field silently stops being tracked, which is how a referenced file
      // gets reaped out from under a published test.
      if (/assetids?$/i.test(key) && child) {
        for (const id of Array.isArray(child) ? child : [child]) {
          if (isAssetId(id)) found.add(String(id));
        }
      }
      walk(child);
    }
  };

  walk(value);
  return [...found];
}

export const assetStore = new AssetStore();
