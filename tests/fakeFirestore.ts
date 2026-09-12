import { FieldValue } from 'firebase-admin/firestore';

/**
 * An in-memory Firestore, for exercising the Firestore code paths where no
 * emulator is available.
 *
 * It implements only what the stores call — collections, documents, equality
 * queries with ordering and limits, batches, transactions, and the `FieldValue`
 * delete, increment and server-timestamp sentinels — and it enforces the write
 * rules real Firestore enforces, because those are exactly the defects a JSON-file store
 * can never show: an `undefined` field anywhere in a document, and an array
 * directly inside an array, are refused with an error, not silently stored.
 *
 * Each kind of write follows Firestore's semantics, because that is where the two
 * backends can disagree (H5): `set` replaces the document, `set` with `merge`
 * merges nested maps field by field, `mergeFields` replaces only the fields it
 * names, `update` replaces top-level fields of a document that must exist,
 * `create` refuses one that does, and `FieldValue.delete()` removes a field.
 *
 * Transactions run in one of two modes. `serial`, the default, runs them one at a
 * time. `optimistic` lets them interleave: each attempt records the version of
 * every document it read, and a commit whose reads have changed since is thrown
 * away and the transaction run again, up to five attempts — the outcome the
 * Firestore client gives a transaction that lost a conflict.
 * `holdTransactionReads` makes an interleaving deterministic. Neither mode models
 * a document appearing in a query a transaction has already run.
 *
 * Documents are deep-copied on write and on read, as a real client would see
 * them. This is not proof that production Firestore works — it proves the code
 * speaks the contract and respects its constraints.
 */

type Data = Record<string, unknown>;

export class FirestoreWriteError extends Error {}

/** A failure as the Firestore client raises it: a gRPC status code, named in the message. */
function grpcError(code: number, status: string, message: string): Error {
  return Object.assign(new Error(`${code} ${status}: ${message}`), { code, details: message });
}

interface WriteRules {
  /** Firestore's `ignoreUndefinedProperties`: an undefined map field is dropped instead of refused. */
  ignoreUndefinedProperties: boolean;
}

export type Concurrency = 'serial' | 'optimistic';

export interface SetOptions {
  merge?: boolean;
  mergeFields?: string[];
}

export type Operation =
  | { kind: 'set'; path: string; data: Data; options?: SetOptions }
  | { kind: 'update'; path: string; data: Data }
  | { kind: 'create'; path: string; data: Data }
  | { kind: 'delete'; path: string };

const MAX_TRANSACTION_ATTEMPTS = 5;

type Sentinel = { kind: 'delete' } | { kind: 'serverTimestamp' } | { kind: 'increment'; operand: number };

/** The `FieldValue` sentinel `value` is, or null. */
function sentinelOf(value: unknown): Sentinel | null {
  if (!(value instanceof FieldValue)) return null;
  const method: unknown = Reflect.get(value, 'methodName');
  if (method === 'FieldValue.delete') return { kind: 'delete' };
  if (method === 'FieldValue.serverTimestamp') return { kind: 'serverTimestamp' };
  const operand: unknown = Reflect.get(value, 'operand');
  if (method === 'FieldValue.increment' && typeof operand === 'number') return { kind: 'increment', operand };
  throw new FirestoreWriteError(`The fake Firestore does not implement ${String(method)}.`);
}

const isMap = (value: unknown): value is Data =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof FieldValue);

/**
 * Validates a document the way Firestore does and returns what it would accept.
 * An `undefined` array element is refused even when undefined properties are
 * ignored — Firestore only drops undefined *fields*.
 */
function toStored(value: unknown, path: string, rules: WriteRules, insideArray = false): unknown {
  if (value === undefined) {
    throw new FirestoreWriteError(`Cannot use "undefined" as a Firestore value (found in field "${path}").`);
  }
  if (value instanceof FieldValue) {
    if (insideArray) throw new FirestoreWriteError(`FieldValue sentinels cannot be used inside an array (found in field "${path}").`);
    sentinelOf(value);
    return value;
  }
  if (value instanceof Date) return new Date(value.getTime());
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

function containsDelete(value: unknown): boolean {
  const sentinel = sentinelOf(value);
  if (sentinel) return sentinel.kind === 'delete';
  if (Array.isArray(value)) return value.some(containsDelete);
  if (isMap(value)) return Object.values(value).some(containsDelete);
  return false;
}

const copy = <T>(value: T): T => structuredClone(value);

/** A value as it is stored: sentinels resolved. A `delete` here has no field to remove, and is refused. */
function materialise(value: unknown, now: Date): unknown {
  const sentinel = sentinelOf(value);
  if (sentinel?.kind === 'delete') {
    throw new FirestoreWriteError('FieldValue.delete() can only be used in update() or in set() with merge or mergeFields, on a field being written.');
  }
  if (sentinel?.kind === 'serverTimestamp') return now;
  if (sentinel?.kind === 'increment') return sentinel.operand;
  if (Array.isArray(value)) return value.map((entry) => materialise(entry, now));
  if (isMap(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, materialise(entry, now)]));
  return value;
}

/**
 * Writes `patch` over `base`. A top-level sentinel acts on the field it names.
 * With `deep` — `set` with `merge` — a map merges into the map already there,
 * field by field, and a nested `delete` removes that nested field; otherwise a
 * value replaces its field whole.
 */
function writeFields(base: Data, patch: Data, deep: boolean, now: Date): Data {
  const out: Data = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const sentinel = sentinelOf(value);
    const current = out[key];
    if (sentinel?.kind === 'delete') delete out[key];
    else if (sentinel?.kind === 'serverTimestamp') out[key] = now;
    else if (sentinel?.kind === 'increment') out[key] = (typeof current === 'number' ? current : 0) + sentinel.operand;
    else if (deep && isMap(value)) out[key] = writeFields(isMap(current) ? current : {}, value, true, now);
    else out[key] = materialise(value, now);
  }
  return out;
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  throw new FirestoreWriteError('The fake Firestore orders only by numbers, or by strings, of one type.');
}

export interface FakeTransaction {
  get(target: FakeDocument | FakeQuery): Promise<FakeSnapshot | FakeQueryResult>;
  set(ref: FakeDocument, data: Data, options?: SetOptions): FakeTransaction;
  update(ref: FakeDocument, data: Data): FakeTransaction;
  create(ref: FakeDocument, data: Data): FakeTransaction;
  delete(ref: FakeDocument): FakeTransaction;
}

export interface FakeBatch {
  set(ref: FakeDocument, data: Data, options?: SetOptions): FakeBatch;
  update(ref: FakeDocument, data: Data): FakeBatch;
  create(ref: FakeDocument, data: Data): FakeBatch;
  delete(ref: FakeDocument): FakeBatch;
  commit(): Promise<void>;
}

export interface FakeSnapshot {
  id: string;
  exists: boolean;
  ref: FakeDocument;
  data(): Data | undefined;
}

export interface FakeQueryResult {
  docs: FakeSnapshot[];
  size: number;
  empty: boolean;
}

interface ReadBarrier {
  expected: number;
  arrived: number;
  open: () => void;
  opened: Promise<void>;
}

export class FakeFirestore {
  readonly documents = new Map<string, Data>();
  readonly rules: WriteRules = { ignoreUndefinedProperties: false };
  readonly concurrency: Concurrency;
  writes = 0;
  /** Commits thrown away because a document their transaction read had changed; each was run again. */
  conflicts = 0;
  private readonly versions = new Map<string, number>();
  private used = false;
  private barrier: ReadBarrier | null = null;

  constructor(options: { concurrency?: Concurrency } = {}) {
    this.concurrency = options.concurrency ?? 'serial';
  }

  /** Like Firestore, settings can be applied only before the instance is first used. */
  settings(options: Partial<WriteRules>) {
    if (this.used) throw new Error('Firestore has already been started and its settings can no longer be changed.');
    Object.assign(this.rules, options);
  }

  /** What Firestore would accept for `data`, or the error it would raise. */
  stored(data: Data): Data {
    this.used = true;
    return toStored(data, '', this.rules) as Data;
  }

  collection(name: string): FakeCollection {
    this.used = true;
    return new FakeCollection(this, name);
  }

  /** How many times the document at `path` has been written or deleted. */
  version(path: string): number {
    return this.versions.get(path) ?? 0;
  }

  /** Validates a write when it is made, as the client does, and returns it ready to apply. */
  prepare(operation: Operation): Operation {
    if (operation.kind === 'delete') return operation;
    const data = this.stored(operation.data);
    const fieldWrite = operation.kind === 'update' || (operation.kind === 'set' && Boolean(operation.options?.merge || operation.options?.mergeFields));
    if (!fieldWrite && containsDelete(data)) {
      throw new FirestoreWriteError('FieldValue.delete() can only be used in update() or in set() with merge or mergeFields.');
    }
    if (operation.kind === 'update' && Object.keys(data).some((key) => key.includes('.'))) {
      throw new FirestoreWriteError('The fake Firestore does not implement field paths in update().');
    }
    if (operation.kind === 'set' && operation.options?.mergeFields) {
      for (const field of operation.options.mergeFields) {
        if (field.includes('.')) throw new FirestoreWriteError('The fake Firestore does not implement nested field paths in mergeFields.');
        if (!(field in data)) throw new FirestoreWriteError(`Input data is missing for field "${field}".`);
      }
    }
    return { ...operation, data };
  }

  /** Applies prepared writes as one commit: every write is decided before any of them lands. */
  apply(operations: Operation[]): void {
    const now = new Date();
    const next = new Map<string, Data | null>();
    const current = (path: string): Data | undefined => (next.has(path) ? (next.get(path) ?? undefined) : this.documents.get(path));
    for (const operation of operations) {
      const existing = current(operation.path);
      switch (operation.kind) {
        case 'delete':
          next.set(operation.path, null);
          break;
        case 'create':
          if (existing) throw grpcError(6, 'ALREADY_EXISTS', `Document already exists: ${operation.path}`);
          next.set(operation.path, writeFields({}, operation.data, false, now));
          break;
        case 'update':
          if (!existing) throw grpcError(5, 'NOT_FOUND', `No document to update: ${operation.path}`);
          next.set(operation.path, writeFields(existing, operation.data, false, now));
          break;
        case 'set': {
          const { merge, mergeFields } = operation.options ?? {};
          const data = operation.data;
          if (mergeFields) next.set(operation.path, writeFields(existing ?? {}, Object.fromEntries(mergeFields.map((field) => [field, data[field]])), false, now));
          else if (merge) next.set(operation.path, writeFields(existing ?? {}, data, true, now));
          else next.set(operation.path, writeFields({}, data, false, now));
          break;
        }
      }
    }
    for (const [path, document] of next) {
      if (document === null) this.documents.delete(path);
      else this.documents.set(path, copy(document));
      this.versions.set(path, this.version(path) + 1);
    }
    this.writes += operations.filter((operation) => operation.kind !== 'delete').length;
  }

  batch(): FakeBatch {
    const operations: Operation[] = [];
    const batch: FakeBatch = {
      set: (ref, data, options) => {
        operations.push(this.prepare({ kind: 'set', path: ref.path, data, options }));
        return batch;
      },
      update: (ref, data) => {
        operations.push(this.prepare({ kind: 'update', path: ref.path, data }));
        return batch;
      },
      create: (ref, data) => {
        operations.push(this.prepare({ kind: 'create', path: ref.path, data }));
        return batch;
      },
      delete: (ref) => {
        operations.push({ kind: 'delete', path: ref.path });
        return batch;
      },
      commit: async () => {
        this.apply(operations);
      },
    };
    return batch;
  }

  /**
   * Holds the next `count` transactional reads until all of them have arrived, so
   * that many transactions have read before any of them commits. Reads after
   * those go straight through. A barrier that is never filled fails its reads
   * after `timeoutMs` rather than hanging the test.
   */
  holdTransactionReads(count: number, timeoutMs = 5000): void {
    let open!: () => void;
    let fail!: (error: Error) => void;
    const opened = new Promise<void>((resolve, reject) => {
      open = resolve;
      fail = reject;
    });
    opened.catch(() => undefined);
    const barrier: ReadBarrier = { expected: count, arrived: 0, open, opened };
    this.barrier = barrier;
    setTimeout(() => {
      if (this.barrier !== barrier) return;
      this.barrier = null;
      fail(new Error(`holdTransactionReads(${count}): only ${barrier.arrived} transactional reads arrived.`));
    }, timeoutMs).unref();
  }

  private async passBarrier(): Promise<void> {
    const barrier = this.barrier;
    if (!barrier) return;
    barrier.arrived += 1;
    if (barrier.arrived >= barrier.expected) {
      this.barrier = null;
      barrier.open();
    }
    await barrier.opened;
  }

  private chain: Promise<unknown> = Promise.resolve();

  runTransaction<T>(run: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    this.used = true;
    if (this.concurrency === 'optimistic') return this.runOptimistic(run);
    // One at a time: the strongest isolation Firestore offers.
    const next = this.chain.then(async () => {
      const attempt = await this.attempt(run);
      this.apply(attempt.operations);
      return attempt.result;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async runOptimistic<T>(run: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      const { result, operations, reads } = await this.attempt(run);
      if (operations.length === 0) return result;
      // Checked and applied without yielding, so nothing can land between the check and the commit.
      const stale = [...reads].some(([path, version]) => this.version(path) !== version);
      if (!stale) {
        this.apply(operations);
        return result;
      }
      this.conflicts += 1;
    }
    throw grpcError(10, 'ABORTED', 'Too much contention on these documents. Please try again.');
  }

  private async attempt<T>(run: (tx: FakeTransaction) => Promise<T>): Promise<{ result: T; operations: Operation[]; reads: Map<string, number> }> {
    const operations: Operation[] = [];
    const reads = new Map<string, number>();
    const note = (path: string) => {
      if (!reads.has(path)) reads.set(path, this.version(path));
    };
    const write = (operation: Operation): FakeTransaction => {
      operations.push(this.prepare(operation));
      return tx;
    };
    const tx: FakeTransaction = {
      get: async (target) => {
        if (operations.length > 0) throw new FirestoreWriteError('Firestore transactions require all reads to be executed before all writes.');
        await this.passBarrier();
        if (target instanceof FakeDocument) {
          note(target.path);
          return target.snapshot();
        }
        const result = target.run();
        for (const doc of result.docs) note(doc.ref.path);
        return result;
      },
      set: (ref, data, options) => write({ kind: 'set', path: ref.path, data, options }),
      update: (ref, data) => write({ kind: 'update', path: ref.path, data }),
      create: (ref, data) => write({ kind: 'create', path: ref.path, data }),
      delete: (ref) => write({ kind: 'delete', path: ref.path }),
    };
    const result = await run(tx);
    return { result, operations, reads };
  }
}

export class FakeQuery {
  constructor(
    protected readonly db: FakeFirestore,
    readonly path: string,
    private readonly filters: ReadonlyArray<readonly [string, unknown]> = [],
    private readonly max = Number.POSITIVE_INFINITY,
    private readonly ordering: ReadonlyArray<readonly [string, 'asc' | 'desc']> = [],
  ) {}

  where(field: string, operator: string, value: unknown): FakeQuery {
    if (operator !== '==') throw new Error(`The fake Firestore supports only "==" queries, not "${operator}".`);
    return new FakeQuery(this.db, this.path, [...this.filters, [field, value]], this.max, this.ordering);
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): FakeQuery {
    return new FakeQuery(this.db, this.path, this.filters, this.max, [...this.ordering, [field, direction]]);
  }

  limit(count: number): FakeQuery {
    return new FakeQuery(this.db, this.path, this.filters, count, this.ordering);
  }

  /** The query, evaluated against what is stored now. */
  run(): FakeQueryResult {
    const prefix = `${this.path}/`;
    const matches: Array<[string, Data]> = [];
    for (const [path, data] of this.db.documents) {
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
      if (!this.filters.every(([field, value]) => data[field] === value)) continue;
      // Firestore leaves out a document that lacks a field the query orders by.
      if (!this.ordering.every(([field]) => field in data)) continue;
      matches.push([path, data]);
    }
    if (this.ordering.length > 0) {
      matches.sort(([, a], [, b]) => {
        for (const [field, direction] of this.ordering) {
          const order = compareValues(a[field], b[field]);
          if (order !== 0) return direction === 'asc' ? order : -order;
        }
        return 0;
      });
    }
    const docs = matches.slice(0, this.max).map(([path]) => new FakeDocument(this.db, path).snapshot());
    return { docs, size: docs.length, empty: docs.length === 0 };
  }

  async get(): Promise<FakeQueryResult> {
    return this.run();
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

  async get() {
    return this.snapshot();
  }

  async set(data: Data, options?: SetOptions) {
    this.db.apply([this.db.prepare({ kind: 'set', path: this.path, data, options })]);
  }

  async update(data: Data) {
    this.db.apply([this.db.prepare({ kind: 'update', path: this.path, data })]);
  }

  async create(data: Data) {
    this.db.apply([this.db.prepare({ kind: 'create', path: this.path, data })]);
  }

  async delete() {
    this.db.apply([{ kind: 'delete', path: this.path }]);
  }
}
