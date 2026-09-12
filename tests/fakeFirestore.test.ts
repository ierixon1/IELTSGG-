import './env';
import { describe, it } from 'node:test';
import { FieldValue } from 'firebase-admin/firestore';
import { expect } from './harness';
import { FakeFirestore } from './fakeFirestore';

/**
 * The Firestore behaviour the Firestore suites rely on, pinned in the in-memory
 * Firestore they run against.
 *
 * Each case is a documented Firestore rule that a store depends on: `set`
 * replaces while `merge` keeps nested fields it does not name (H5), `mergeFields`
 * replaces only the fields it names, `FieldValue.delete()` removes a field, a
 * transaction whose read changed runs again, and reads come before writes. If the
 * fake got one of these wrong, a store could pass against it and still fail
 * against Firestore, so the rules are tested here rather than assumed.
 */

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('the in-memory Firestore', () => {
  it('set replaces the document; set with merge keeps the nested fields the write does not name', async () => {
    const db = new FakeFirestore();
    const doc = db.collection('materials').doc('one');
    await doc.set({ content: { htmlContent: 'old markup', text: 'a' }, title: 'Title' });
    await doc.set({ content: { text: 'b' } }, { merge: true });
    expect(db.documents.get('materials/one')).toEqual({ content: { htmlContent: 'old markup', text: 'b' }, title: 'Title' });
    await doc.set({ content: { text: 'c' } });
    expect(db.documents.get('materials/one')).toEqual({ content: { text: 'c' } });
  });

  it('mergeFields replaces each named field whole and leaves every other field alone', async () => {
    const db = new FakeFirestore();
    const doc = db.collection('users').doc('one');
    await doc.set({ profile: { examDate: '2026-12-01', targetBand: 7 }, other: 'kept' });
    await doc.set({ profile: { targetBand: 8 }, other: 'not written' }, { mergeFields: ['profile'] });
    expect(db.documents.get('users/one')).toEqual({ profile: { targetBand: 8 }, other: 'kept' });
    expect(await refusal(() => doc.set({ other: 'x' }, { mergeFields: ['profile'] }))).toContain('missing for field "profile"');
  });

  it('FieldValue.delete removes a field in update and in merge, and is refused in a plain set', async () => {
    const db = new FakeFirestore();
    const doc = db.collection('users').doc('two');
    await doc.set({ resetTokenHash: 'h', nested: { a: 1, b: 2 }, keep: true });
    await doc.update({ resetTokenHash: FieldValue.delete() });
    await doc.set({ nested: { a: FieldValue.delete() } }, { merge: true });
    expect(db.documents.get('users/two')).toEqual({ nested: { b: 2 }, keep: true });
    expect(await refusal(() => doc.set({ keep: FieldValue.delete() }))).toContain('FieldValue.delete()');
  });

  it('increment adds to the stored number, and serverTimestamp stores a time', async () => {
    const db = new FakeFirestore();
    const doc = db.collection('quotas').doc('day');
    await doc.set({ count: FieldValue.increment(2) }, { merge: true });
    await doc.set({ count: FieldValue.increment(3), at: FieldValue.serverTimestamp() }, { merge: true });
    const stored = db.documents.get('quotas/day');
    expect(stored?.count).toBe(5);
    expect(stored?.at instanceof Date).toBe(true);
  });

  it('update needs the document to exist, and create refuses one that does', async () => {
    const db = new FakeFirestore();
    const doc = db.collection('auth_users').doc('three');
    expect(await refusal(() => doc.update({ a: 1 }))).toContain('NOT_FOUND');
    await doc.create({ a: 1 });
    expect(await refusal(() => doc.create({ a: 2 }))).toContain('ALREADY_EXISTS');
    expect(db.documents.get('auth_users/three')).toEqual({ a: 1 });
  });

  it('runs a transaction whose read changed again on the new data, and aborts after five such losses', async () => {
    const db = new FakeFirestore({ concurrency: 'optimistic' });
    const doc = db.collection('counters').doc('n');
    await doc.set({ n: 0 });
    const increment = () =>
      db.runTransaction(async (tx) => {
        const snapshot = await tx.get(doc);
        const current = snapshot && 'data' in snapshot ? Number(snapshot.data()?.n ?? 0) : 0;
        tx.set(doc, { n: current + 1 });
      });
    db.holdTransactionReads(2);
    await Promise.all([increment(), increment()]);
    expect([db.documents.get('counters/n')?.n, db.conflicts]).toEqual([2, 1]);

    let attempts = 0;
    const alwaysLoses = db.runTransaction(async (tx) => {
      attempts += 1;
      await tx.get(doc);
      await doc.set({ n: attempts * 100 });
      tx.set(doc, { n: -1 });
    });
    expect(await refusal(() => alwaysLoses)).toContain('ABORTED');
    expect(attempts).toBe(5);
  });

  it('refuses a read after a write inside a transaction', async () => {
    const db = new FakeFirestore({ concurrency: 'optimistic' });
    const doc = db.collection('c').doc('d');
    const readAfterWrite = db.runTransaction(async (tx) => {
      tx.set(doc, { a: 1 });
      await tx.get(doc);
    });
    expect(await refusal(() => readAfterWrite)).toContain('reads to be executed before all writes');
  });

  it('orders and limits a query, leaving out documents that lack the ordered field', async () => {
    const db = new FakeFirestore();
    const items = db.collection('chunks');
    await items.doc('a').set({ ordinal: 2 });
    await items.doc('b').set({ ordinal: 0 });
    await items.doc('c').set({ other: true });
    await items.doc('d').set({ ordinal: 1 });
    const ascending = await items.orderBy('ordinal').get();
    expect(ascending.docs.map((doc) => doc.id)).toEqual(['b', 'd', 'a']);
    const newest = await items.orderBy('ordinal', 'desc').limit(2).get();
    expect(newest.docs.map((doc) => doc.id)).toEqual(['a', 'd']);
  });
});
