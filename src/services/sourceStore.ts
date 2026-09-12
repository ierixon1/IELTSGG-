import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { getFirestoreDb } from './firebaseAdmin';
import type { SourceChunk, StoredSource, StoredSourceSummary } from '../types/source';

/**
 * Where ingested sources and their chunks live.
 *
 * Deliberately alongside materials in `data/admin_content` rather than under
 * `data/users/<id>`: a textbook is library content that every admin works from,
 * and the per-learner `StoredTextbook` this replaces could never be shared.
 *
 * Chunks are stored in their own collection, keyed by source, because a book is
 * thousands of them and the list view has no business loading any. They are
 * written whole and replaced whole — a partial chunk set is the failure mode
 * that would let a half-ingested book answer a search.
 */

const DATA_DIR = path.join(process.cwd(), 'data', 'admin_content');
const useFirestore = () =>
  process.env.NODE_ENV === 'production' || process.env.STORAGE_BACKEND === 'gcs_firestore';

const assertId = (value: string) => {
  if (!/^[A-Za-z0-9_.-]{1,160}$/.test(value)) throw new Error('Invalid identifier.');
};

class SourceStore {
  private file(name: string) {
    return path.join(DATA_DIR, `${name}.json`);
  }

  private read<T>(name: string): T[] {
    const filePath = this.file(name);
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (!fs.existsSync(filePath)) return [];
      const value = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return Array.isArray(value) ? (value as T[]) : [];
    } catch {
      return [];
    }
  }

  private write<T>(name: string, items: T[]): void {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const filePath = this.file(name);
    const temp = `${filePath}.tmp.${process.pid}.${Date.now()}.${nanoid(4)}`;
    fs.writeFileSync(temp, JSON.stringify(items, null, 2), 'utf-8');
    fs.renameSync(temp, filePath);
  }

  private collection() {
    return getFirestoreDb().collection('admin_content').doc('sources').collection('items');
  }

  newId(): string {
    return `src-${Date.now()}-${nanoid(6)}`;
  }

  async list(): Promise<StoredSourceSummary[]> {
    const rows = useFirestore()
      ? (await this.collection().get()).docs.map((doc) => doc.data() as StoredSource)
      : this.read<StoredSource>('sources');

    return rows
      .map(({ warnings, ...rest }) => ({ ...rest, warningCount: (warnings || []).length }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async get(id: string): Promise<StoredSource | null> {
    assertId(id);
    if (useFirestore()) {
      const snapshot = await this.collection().doc(id).get();
      return snapshot.exists ? (snapshot.data() as StoredSource) : null;
    }
    return this.read<StoredSource>('sources').find((item) => item.id === id) ?? null;
  }

  async save(source: StoredSource): Promise<StoredSource> {
    assertId(source.id);
    if (useFirestore()) {
      // A source is always saved whole, so it replaces what is stored, as the local
      // store does. A merge would keep the `error` of a failed run on the source a
      // later run made ready (H5).
      await this.collection().doc(source.id).set(source);
      return source;
    }
    const items = this.read<StoredSource>('sources');
    const index = items.findIndex((item) => item.id === source.id);
    if (index >= 0) items[index] = source;
    else items.unshift(source);
    this.write('sources', items);
    return source;
  }

  async delete(id: string): Promise<boolean> {
    assertId(id);
    if (useFirestore()) {
      const reference = this.collection().doc(id);
      if (!(await reference.get()).exists) return false;
      const chunks = await reference.collection('chunks').get();
      const batch = getFirestoreDb().batch();
      chunks.docs.forEach((doc) => batch.delete(doc.ref));
      batch.delete(reference);
      await batch.commit();
      return true;
    }
    const items = this.read<StoredSource>('sources');
    const remaining = items.filter((item) => item.id !== id);
    if (remaining.length === items.length) return false;
    this.write('sources', remaining);
    const chunkFile = this.file(`source_${id}_chunks`);
    if (fs.existsSync(chunkFile)) fs.rmSync(chunkFile, { force: true });
    return true;
  }

  /**
   * Replaces a source's chunks wholesale.
   *
   * There is no append: a re-ingestion produces a complete chunk set or the
   * job fails, and mixing chunks from two runs would give a book two passages
   * with the same ordinal and different text.
   */
  async saveChunks(sourceId: string, chunks: SourceChunk[]): Promise<void> {
    assertId(sourceId);
    if (useFirestore()) {
      const reference = this.collection().doc(sourceId).collection('chunks');
      const existing = await reference.get();
      const database = getFirestoreDb();
      // Firestore batches cap at 500 writes, and a book exceeds that easily.
      let batch = database.batch();
      let pending = 0;
      const commit = async () => {
        if (pending === 0) return;
        await batch.commit();
        batch = database.batch();
        pending = 0;
      };
      for (const doc of existing.docs) {
        batch.delete(doc.ref);
        if (++pending >= 400) await commit();
      }
      for (const chunk of chunks) {
        batch.set(reference.doc(chunk.id), chunk);
        if (++pending >= 400) await commit();
      }
      await commit();
      return;
    }
    this.write(`source_${sourceId}_chunks`, chunks);
  }

  async getChunks(sourceId: string): Promise<SourceChunk[]> {
    assertId(sourceId);
    if (useFirestore()) {
      const snapshot = await this.collection()
        .doc(sourceId)
        .collection('chunks')
        .orderBy('ordinal')
        .get();
      return snapshot.docs.map((doc) => doc.data() as SourceChunk);
    }
    return this.read<SourceChunk>(`source_${sourceId}_chunks`).sort((a, b) => a.ordinal - b.ordinal);
  }
}

export const sourceStore = new SourceStore();
