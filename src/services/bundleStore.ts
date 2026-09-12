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
 *
 * Every change to a stored bundle reads it, decides and writes in one step — a
 * transaction on Firestore, a read-modify-write with nothing awaited in between
 * locally — so an edit, a publish and a withdrawal cannot interleave between the
 * check and the write. A status change can also name the revision (`updatedAt`)
 * it was decided on, and is refused if the bundle has moved on since: a publish
 * names the revision its gate read, so a draft edited while the gate was running
 * is never published without the gate having read it.
 */

const dataDir = () => path.join(process.cwd(), 'data', 'admin_content');
const useFirestore = () => process.env.NODE_ENV === 'production' || process.env.STORAGE_BACKEND === 'gcs_firestore';
const ID = /^[A-Za-z0-9_.-]{1,160}$/;

export type BundleStateCode =
  | 'bundle_not_found'
  | 'bundle_not_draft'
  | 'bundle_published'
  | 'bundle_was_published'
  | 'bundle_changed'
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

const notFound = () => new BundleStateError('bundle_not_found', 'Bundle not found.');

/**
 * The revision a change stamps: now, and always later than the one it replaces.
 * Two changes inside one millisecond would otherwise share a revision, and a
 * caller still holding it would pass the check.
 */
function nextRevision(previous: string): string {
  const now = Date.now();
  const last = Date.parse(previous);
  return new Date(Number.isFinite(last) && last >= now ? last + 1 : now).toISOString();
}

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

  private indexOf(rows: unknown[], id: string): number {
    return rows.findIndex((row) => (row as { id?: unknown })?.id === id);
  }

  /**
   * Reads one bundle, decides what it becomes, and writes that — with nothing able
   * to land in between. `decide` is synchronous and refuses by throwing.
   */
  private async change(id: string, decide: (existing: FullCdiBundle) => FullCdiBundle): Promise<FullCdiBundle> {
    if (!ID.test(id)) throw notFound();
    if (useFirestore()) {
      const db = getFirestoreDb();
      const ref = this.collection().doc(id);
      return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) throw notFound();
        const next = plain(decide(readStoredBundle(snapshot.data())));
        tx.set(ref, next);
        return next;
      });
    }
    const rows = this.readLocal();
    const index = this.indexOf(rows, id);
    if (index < 0) throw notFound();
    const next = plain(decide(readStoredBundle(rows[index])));
    rows[index] = next;
    this.writeLocal(rows);
    return next;
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
    const stored = plain<FullCdiBundle>({
      id: `cdi-bundle-${Date.now()}-${nanoid(5)}`,
      schemaVersion: 2,
      ...input,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });
    if (useFirestore()) {
      await this.collection().doc(stored.id).set(stored);
      return stored;
    }
    const rows = this.readLocal();
    rows.unshift(stored);
    this.writeLocal(rows);
    return stored;
  }

  async updateDraft(id: string, input: BundleDraftInput): Promise<FullCdiBundle> {
    return this.change(id, (existing) => {
      if (existing.status !== 'draft') {
        throw new BundleStateError(
          'bundle_not_draft',
          existing.status === 'published'
            ? 'This bundle is published. Unpublish it before changing it, so what learners sat stays reproducible.'
            : 'This bundle is archived. Restore it before changing it.',
        );
      }
      return {
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
        updatedAt: nextRevision(existing.updatedAt),
        publishedAt: existing.publishedAt,
        firstPublishedAt: existing.firstPublishedAt,
        archivedAt: existing.archivedAt,
      };
    });
  }

  /**
   * Moves a bundle to `status`. `expectedUpdatedAt` is the revision the caller
   * decided on — for a publish, the one the bundle gate read — and the change is
   * refused with `bundle_changed` when the stored bundle is no longer that revision.
   */
  async setStatus(id: string, status: BundleLifecycleStatus, expectedUpdatedAt?: string): Promise<FullCdiBundle> {
    const now = new Date().toISOString();
    return this.change(id, (existing) => {
      if (expectedUpdatedAt !== undefined && existing.updatedAt !== expectedUpdatedAt) {
        throw new BundleStateError('bundle_changed', 'This bundle changed while the request was being handled, so nothing was changed. Reload it and try again.');
      }
      return {
        ...existing,
        status,
        updatedAt: nextRevision(existing.updatedAt),
        ...(status === 'published' ? { publishedAt: now, firstPublishedAt: existing.firstPublishedAt ?? now } : {}),
        ...(status === 'archived' ? { archivedAt: now } : {}),
      };
    });
  }

  async remove(id: string): Promise<void> {
    const refuse = (existing: FullCdiBundle) => {
      if (existing.status === 'published') {
        throw new BundleStateError('bundle_published', 'This bundle is published. Unpublish or archive it instead.');
      }
      if (existing.firstPublishedAt) {
        throw new BundleStateError(
          'bundle_was_published',
          'This bundle has been published, so attempts may refer to it. Archive it instead of deleting it.',
        );
      }
    };
    if (!ID.test(id)) throw notFound();
    if (useFirestore()) {
      const db = getFirestoreDb();
      const ref = this.collection().doc(id);
      await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) throw notFound();
        refuse(readStoredBundle(snapshot.data()));
        tx.delete(ref);
      });
      return;
    }
    const rows = this.readLocal();
    const index = this.indexOf(rows, id);
    if (index < 0) throw notFound();
    refuse(readStoredBundle(rows[index]));
    this.writeLocal(rows.filter((row) => (row as { id?: unknown })?.id !== id));
  }
}

export const bundleStore = new BundleStore();
