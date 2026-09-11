/**
 * An in-memory Firestore, for exercising the Firestore code paths where no
 * emulator is available.
 *
 * It implements only what the stores call — collections, documents, equality
 * queries, batches and transactions — and it enforces the write rules real
 * Firestore enforces, because those are exactly the defects a JSON-file store
 * can never show: an `undefined` field anywhere in a document, and an array
 * directly inside an array, are refused with an error, not silently stored.
 *
 * Documents are deep-copied on write and on read, as a real client would see
 * them. This is not proof that production Firestore works — it proves the code
 * speaks the contract and respects its constraints.
 */

type Data = Record<string, unknown>;

export class FirestoreWriteError extends Error {}

interface WriteRules {
  /** Firestore's `ignoreUndefinedProperties`: an undefined map field is dropped instead of refused. */
  ignoreUndefinedProperties: boolean;
}

/**
 * Validates a document the way Firestore does and returns what it would store.
 * An `undefined` array element is refused even when undefined properties are
 * ignored — Firestore only drops undefined *fields*.
 */
function toStored(value: unknown, path: string, rules: WriteRules, insideArray = false): unknown {
  if (value === undefined) {
    throw new FirestoreWriteError(`Cannot use "undefined" as a Firestore value (found in field "${path}").`);
  }
  if (Array.isArray(value)) {
    if (insideArray) throw new FirestoreWriteError(`Nested arrays are not supported (found in field "${path}").`);
    return value.map((entry, index) => toStored(entry, `${path}.${index}`, rules, true));
  }
  if (value !== null && typeof value === 'object') {
    const out: Data = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined && rules.ignoreUndefinedProperties) continue;
      out[key] = toStored(entry, path ? `${path}.${key}` : key, rules);
    }
    return out;
  }
  return value;
}

const copy = <T>(value: T): T => structuredClone(value);
const isMap = (value: unknown): value is Data => value !== null && typeof value === 'object' && !Array.isArray(value);

function mergeInto(target: Data, patch: Data): Data {
  const out: Data = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isMap(value) && isMap(out[key]) ? mergeInto(out[key] as Data, value) : value;
  }
  return out;
}

export class FakeFirestore {
  readonly documents = new Map<string, Data>();
  readonly rules: WriteRules = { ignoreUndefinedProperties: false };
  writes = 0;
  private used = false;

  /** Like Firestore, settings can be applied only before the instance is first used. */
  settings(options: Partial<WriteRules>) {
    if (this.used) throw new Error('Firestore has already been started and its settings can no longer be changed.');
    Object.assign(this.rules, options);
  }

  /** What Firestore would store for `data`, or the error it would raise. */
  stored(data: Data): Data {
    this.used = true;
    return toStored(data, '', this.rules) as Data;
  }

  collection(name: string): FakeCollection {
    this.used = true;
    return new FakeCollection(this, name);
  }

  batch() {
    const operations: Array<() => void> = [];
    return {
      set: (ref: FakeDocument, data: Data, options?: { merge?: boolean }) => {
        this.stored(data);
        operations.push(() => ref.write(data, options));
      },
      delete: (ref: FakeDocument) => {
        operations.push(() => this.documents.delete(ref.path));
      },
      commit: async () => {
        operations.forEach((operation) => operation());
      },
    };
  }

  /** Transactions run serially here, which is the strongest isolation Firestore offers. */
  private chain: Promise<unknown> = Promise.resolve();
  runTransaction<T>(run: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const staged: Array<() => void> = [];
      const tx: FakeTransaction = {
        get: async (ref: FakeDocument) => ref.snapshot(),
        set: (ref: FakeDocument, data: Data, options?: { merge?: boolean }) => {
          this.stored(data);
          staged.push(() => ref.write(data, options));
        },
        delete: (ref: FakeDocument) => {
          staged.push(() => this.documents.delete(ref.path));
        },
      };
      const result = await run(tx);
      staged.forEach((write) => write());
      return result;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export interface FakeTransaction {
  get(ref: FakeDocument): Promise<FakeSnapshot>;
  set(ref: FakeDocument, data: Data, options?: { merge?: boolean }): void;
  delete(ref: FakeDocument): void;
}

export interface FakeSnapshot {
  id: string;
  exists: boolean;
  ref: FakeDocument;
  data(): Data | undefined;
}

class FakeQuery {
  constructor(
    protected readonly db: FakeFirestore,
    readonly path: string,
    private readonly filters: Array<[string, unknown]> = [],
    private readonly max = Number.POSITIVE_INFINITY,
  ) {}

  where(field: string, operator: string, value: unknown): FakeQuery {
    if (operator !== '==') throw new Error(`The fake Firestore supports only "==" queries, not "${operator}".`);
    return new FakeQuery(this.db, this.path, [...this.filters, [field, value]], this.max);
  }

  limit(count: number): FakeQuery {
    return new FakeQuery(this.db, this.path, this.filters, count);
  }

  async get() {
    const prefix = `${this.path}/`;
    const docs: FakeSnapshot[] = [];
    for (const [path, data] of this.db.documents) {
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
      if (!this.filters.every(([field, value]) => data[field] === value)) continue;
      docs.push(new FakeDocument(this.db, path).snapshot());
      if (docs.length >= this.max) break;
    }
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

export class FakeCollection extends FakeQuery {
  doc(id: string): FakeDocument {
    return new FakeDocument(this.db, `${this.path}/${id}`);
  }
}

export class FakeDocument {
  constructor(
    private readonly db: FakeFirestore,
    readonly path: string,
  ) {}

  get id() {
    return this.path.slice(this.path.lastIndexOf('/') + 1);
  }

  collection(name: string): FakeCollection {
    return new FakeCollection(this.db, `${this.path}/${name}`);
  }

  snapshot(): FakeSnapshot {
    const stored = this.db.documents.get(this.path);
    return { id: this.id, exists: stored !== undefined, ref: this, data: () => (stored === undefined ? undefined : copy(stored)) };
  }

  write(data: Data, options?: { merge?: boolean }) {
    const accepted = this.db.stored(data);
    const existing = this.db.documents.get(this.path);
    this.db.documents.set(this.path, copy(options?.merge && existing ? mergeInto(existing, accepted) : accepted));
    this.db.writes += 1;
  }

  async get() {
    return this.snapshot();
  }

  async set(data: Data, options?: { merge?: boolean }) {
    this.write(data, options);
  }

  async delete() {
    this.db.documents.delete(this.path);
  }
}
