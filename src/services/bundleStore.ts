import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { getFirestoreDb } from './firebaseAdmin';
import { readStoredBundle, type BundleDraftInput } from '../schemas/bundle';
import type { BundleLifecycleStatus, FullCdiBundle } from '../types/bundle';

/**
 * Where bundles live, and the lifecycle rules that are about storage rather
 * than validity.
 *
 * A published bundle is not edited: it is unpublished first, so what learners
 * sat stays reproducible from what is stored. An archived bundle is restored
 * before it is edited. A bundle that was ever published is never deleted —
 * attempts point at it — and is archived instead.
 *
 * Whether a bundle is fit to publish is the bundle gate's question, asked by
 * the service before it calls `setStatus`.
 */

const dataDir = () => path.join(process.cwd(), 'data', 'admin_content');
const useFirestore = () => process.env.NODE_ENV === 'production' || process.env.STORAGE_BACKEND === 'gcs_firestore';
const ID = /^[A-Za-z0-9_.-]{1,160}$/;

export type BundleStateCode =
  | 'bundle_not_found'
  | 'bundle_not_draft'
  | 'bundle_published'
  | 'bundle_was_published'
  | 'invalid_transition';

export class BundleStateError extends Error {
  constructor(
    readonly code: BundleStateCode,
    message: string,
  ) {
    super(message);
    this.name = 'BundleStateError';
  }
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

class BundleStore {
  private collection() {
    return getFirestoreDb().collection('admin_content').doc('bundles').collection('items');
  }

  private file() {
    return path.join(dataDir(), 'bundles.json');
  }

  private readLocal(): unknown[] {
    const file = this.file();
    if (!fs.existsSync(file)) return [];
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(value)) throw new Error('bundles.json is not a list.');
    return value;
  }

  private writeLocal(rows: unknown[]): void {
    const directory = dataDir();
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
    const file = this.file();
    const temp = `${file}.tmp.${process.pid}.${Date.now()}.${nanoid(4)}`;
    fs.writeFileSync(temp, JSON.stringify(rows, null, 2), 'utf-8');
    fs.renameSync(temp, file);
  }

  private async rows(): Promise<unknown[]> {
    if (useFirestore()) return (await this.collection().get()).docs.map((doc) => doc.data());
    return this.readLocal();
  }

  private async put(bundle: FullCdiBundle): Promise<FullCdiBundle> {
    const stored = plain(bundle);
    if (useFirestore()) {
      await this.collection().doc(bundle.id).set(stored);
      return stored;
    }
    const rows = this.readLocal();
    const index = rows.findIndex((row) => (row as { id?: unknown })?.id === bundle.id);
    if (index >= 0) rows[index] = stored;
    else rows.unshift(stored);
    this.writeLocal(rows);
    return stored;
  }

  /**
   * Every readable bundle. A row that cannot be read as a bundle is reported and
   * left out of the list; it is never repaired into something it was not.
   */
  async list(status: BundleLifecycleStatus | 'all' = 'all'): Promise<FullCdiBundle[]> {
    const bundles: FullCdiBundle[] = [];
    for (const row of await this.rows()) {
      try {
        bundles.push(readStoredBundle(row));
      } catch (error) {
        console.error('[Bundles] a stored bundle could not be read:', error);
      }
    }
    return bundles
      .filter((bundle) => status === 'all' || bundle.status === status)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async get(id: string): Promise<FullCdiBundle | null> {
    if (!ID.test(id)) return null;
    if (useFirestore()) {
      const snapshot = await this.collection().doc(id).get();
      return snapshot.exists ? readStoredBundle(snapshot.data()) : null;
    }
    const row = this.readLocal().find((item) => (item as { id?: unknown })?.id === id);
    return row ? readStoredBundle(row) : null;
  }

  async create(input: BundleDraftInput): Promise<FullCdiBundle> {
    const now = new Date().toISOString();
    return this.put({
      id: `cdi-bundle-${Date.now()}-${nanoid(5)}`,
      schemaVersion: 2,
      ...input,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });
  }

  async updateDraft(id: string, input: BundleDraftInput): Promise<FullCdiBundle> {
    const existing = await this.get(id);
    if (!existing) throw new BundleStateError('bundle_not_found', 'Bundle not found.');
    if (existing.status !== 'draft') {
      throw new BundleStateError(
        'bundle_not_draft',
        existing.status === 'published'
          ? 'This bundle is published. Unpublish it before changing it, so what learners sat stays reproducible.'
          : 'This bundle is archived. Restore it before changing it.',
      );
    }
    return this.put({
      id: existing.id,
      schemaVersion: 2,
      title: input.title,
      module: input.module,
      targetBand: input.targetBand,
      description: input.description,
      components: input.components,
      timing: input.timing,
      status: 'draft',
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
      publishedAt: existing.publishedAt,
      firstPublishedAt: existing.firstPublishedAt,
      archivedAt: existing.archivedAt,
    });
  }

  async setStatus(id: string, status: BundleLifecycleStatus): Promise<FullCdiBundle> {
    const existing = await this.get(id);
    if (!existing) throw new BundleStateError('bundle_not_found', 'Bundle not found.');
    const now = new Date().toISOString();
    return this.put({
      ...existing,
      status,
      updatedAt: now,
      ...(status === 'published' ? { publishedAt: now, firstPublishedAt: existing.firstPublishedAt ?? now } : {}),
      ...(status === 'archived' ? { archivedAt: now } : {}),
    });
  }

  async remove(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw new BundleStateError('bundle_not_found', 'Bundle not found.');
    if (existing.status === 'published') {
      throw new BundleStateError('bundle_published', 'This bundle is published. Unpublish or archive it instead.');
    }
    if (existing.firstPublishedAt) {
      throw new BundleStateError(
        'bundle_was_published',
        'This bundle has been published, so attempts may refer to it. Archive it instead of deleting it.',
      );
    }
    if (useFirestore()) {
      await this.collection().doc(id).delete();
      return;
    }
    this.writeLocal(this.readLocal().filter((row) => (row as { id?: unknown })?.id !== id));
  }
}

export const bundleStore = new BundleStore();
