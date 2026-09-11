import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { getFirestoreDb } from '../firebaseAdmin';
import type { AttemptRecord, ModelFailureClass } from '../../../prompts/geminiRetry';

/**
 * Two small records the generation boundary keeps beside the materials.
 *
 * The request ledger makes a generation request idempotent. An entry is keyed by
 * the request id and holds the fingerprint of what was asked. A second arrival of
 * the same id finds the entry and is given the draft the first arrival made, or
 * told the first is still running — it does not start a second generation.
 *
 * The run log is what an operator reads when a generation produced no draft:
 * when, from which source, what was asked, how it failed, after how many
 * attempts, against which model. It holds no source text and no prompt — chunk
 * ids and scores only — so it can be kept and shown without becoming a second
 * copy of a licensed book.
 */

const dataDir = () => path.join(process.cwd(), 'data', 'admin_content');
const useFirestore = () =>
  process.env.NODE_ENV === 'production' || process.env.STORAGE_BACKEND === 'gcs_firestore';

const REQUESTS = 'generation_requests';
const RUNS = 'generation_runs';
const MAX_LOCAL_REQUESTS = 2000;
const MAX_LOCAL_RUNS = 500;

export type LedgerStatus = 'running' | 'succeeded' | 'failed' | 'rejected';

export interface GenerationLedgerEntry {
  requestId: string;
  fingerprint: string;
  sourceId: string;
  status: LedgerStatus;
  materialId?: string;
  /** How many times this request has been started. A request that failed may be run again. */
  runs: number;
  createdAt: string;
  updatedAt: string;
  /** Until when (epoch ms) a running entry holds its id. A run that died lapses instead of blocking forever. */
  leaseUntil: number;
}

export type ClaimKind =
  /** This arrival runs the generation. */
  | 'claimed'
  /** Another arrival with the same id is running it now. */
  | 'in_progress'
  /** A draft already exists for this id. */
  | 'completed'
  /** The id was used before for a different request. */
  | 'conflict';

export interface ClaimResult {
  kind: ClaimKind;
  entry: GenerationLedgerEntry;
}

export interface ClaimRequest {
  requestId: string;
  fingerprint: string;
  sourceId: string;
}

/**
 * The claim rule, shared by both backends.
 *
 * `reclaimCompleted` is for a completed request whose draft no longer exists:
 * there is nothing left to duplicate, so the request may run again.
 */
export function decideClaim(
  existing: GenerationLedgerEntry | undefined,
  request: ClaimRequest,
  now: number,
  leaseMs: number,
  reclaimCompleted = false,
): ClaimResult & { write: boolean } {
  const stamp = new Date(now).toISOString();
  if (!existing) {
    return {
      kind: 'claimed',
      write: true,
      entry: { ...request, status: 'running', runs: 1, createdAt: stamp, updatedAt: stamp, leaseUntil: now + leaseMs },
    };
  }
  if (existing.fingerprint !== request.fingerprint) return { kind: 'conflict', entry: existing, write: false };
  if (existing.status === 'running' && existing.leaseUntil > now) return { kind: 'in_progress', entry: existing, write: false };
  if (existing.status === 'succeeded' && existing.materialId && !reclaimCompleted) {
    return { kind: 'completed', entry: existing, write: false };
  }
  const { materialId: _previous, ...rest } = existing;
  return {
    kind: 'claimed',
    write: true,
    entry: { ...rest, status: 'running', runs: existing.runs + 1, updatedAt: stamp, leaseUntil: now + leaseMs },
  };
}

export interface GenerationRunFailure {
  code: string;
  /** Present for model failures; absent for request failures such as "nothing relevant in the source". */
  failureClass?: ModelFailureClass;
  httpStatus: number;
  message: string;
  reason?: string;
}

export interface GenerationRun {
  runId: string;
  requestId: string;
  sourceId: string;
  sourceTitle: string;
  request: {
    topic: string;
    questionType: string;
    count: number;
    module: 'academic' | 'general';
    targetBand?: string;
  };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: 'draft_created' | 'all_rejected' | 'failed';
  failure?: GenerationRunFailure;
  modelCalled: boolean;
  model?: string;
  modelVersion?: string;
  attempts: number;
  attemptLog: AttemptRecord[];
  generatorVersion: string;
  promptVersion: string;
  generationId?: string;
  materialId?: string;
  /** Which chunks retrieval chose, by id and score only. */
  retrieval?: { status: string; hits: Array<{ chunkId: string; score: number }> };
}

/** Firestore refuses `undefined`; JSON drops it. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function readLocal<T>(name: string): T[] {
  const file = path.join(dataDir(), `${name}.json`);
  if (!fs.existsSync(file)) return [];
  // A corrupt ledger is an error to see, not an empty ledger to write over.
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!Array.isArray(value)) throw new Error(`${name}.json is not a list.`);
  return value as T[];
}

function writeLocal<T>(name: string, items: T[]): void {
  const directory = dataDir();
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${name}.json`);
  const temp = `${file}.tmp.${process.pid}.${Date.now()}.${nanoid(4)}`;
  fs.writeFileSync(temp, JSON.stringify(items, null, 2), 'utf-8');
  fs.renameSync(temp, file);
}

let queue: Promise<unknown> = Promise.resolve();

/** Local writes are read-modify-write; one at a time, so two claims cannot both see "absent". */
function exclusive<T>(task: () => T | Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

class GenerationLog {
  private requests() {
    return getFirestoreDb().collection('admin_content').doc('generation').collection('requests');
  }

  private runs() {
    return getFirestoreDb().collection('admin_content').doc('generation').collection('runs');
  }

  async claim(request: ClaimRequest, leaseMs: number, reclaimCompleted = false): Promise<ClaimResult> {
    if (useFirestore()) {
      const reference = this.requests().doc(request.requestId);
      return getFirestoreDb().runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        const existing = snapshot.exists ? (snapshot.data() as GenerationLedgerEntry) : undefined;
        const decision = decideClaim(existing, request, Date.now(), leaseMs, reclaimCompleted);
        if (decision.write) transaction.set(reference, plain(decision.entry));
        return { kind: decision.kind, entry: decision.entry };
      });
    }
    return exclusive(() => {
      const items = readLocal<GenerationLedgerEntry>(REQUESTS);
      const index = items.findIndex((item) => item.requestId === request.requestId);
      const decision = decideClaim(index >= 0 ? items[index] : undefined, request, Date.now(), leaseMs, reclaimCompleted);
      if (decision.write) {
        if (index >= 0) items.splice(index, 1);
        items.unshift(decision.entry);
        writeLocal(REQUESTS, items.slice(0, MAX_LOCAL_REQUESTS));
      }
      return { kind: decision.kind, entry: decision.entry };
    });
  }

  async finish(requestId: string, outcome: { status: Exclude<LedgerStatus, 'running'>; materialId?: string }): Promise<void> {
    const apply = (entry: GenerationLedgerEntry): GenerationLedgerEntry => {
      const { materialId: _previous, ...rest } = entry;
      return {
        ...rest,
        ...(outcome.materialId ? { materialId: outcome.materialId } : {}),
        status: outcome.status,
        updatedAt: new Date().toISOString(),
        leaseUntil: 0,
      };
    };
    if (useFirestore()) {
      const reference = this.requests().doc(requestId);
      await getFirestoreDb().runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        if (snapshot.exists) transaction.set(reference, plain(apply(snapshot.data() as GenerationLedgerEntry)));
      });
      return;
    }
    await exclusive(() => {
      const items = readLocal<GenerationLedgerEntry>(REQUESTS);
      const index = items.findIndex((item) => item.requestId === requestId);
      if (index < 0) return;
      items[index] = apply(items[index]);
      writeLocal(REQUESTS, items);
    });
  }

  async getRequest(requestId: string): Promise<GenerationLedgerEntry | null> {
    if (useFirestore()) {
      const snapshot = await this.requests().doc(requestId).get();
      return snapshot.exists ? (snapshot.data() as GenerationLedgerEntry) : null;
    }
    return readLocal<GenerationLedgerEntry>(REQUESTS).find((item) => item.requestId === requestId) ?? null;
  }

  newRunId(): string {
    return `run-${Date.now()}-${nanoid(6)}`;
  }

  async recordRun(run: GenerationRun): Promise<void> {
    if (useFirestore()) {
      await this.runs().doc(run.runId).set(plain(run));
      return;
    }
    await exclusive(() => {
      const items = readLocal<GenerationRun>(RUNS);
      items.unshift(plain(run));
      writeLocal(RUNS, items.slice(0, MAX_LOCAL_RUNS));
    });
  }

  /** The most recent runs for one source, newest first. */
  async listRuns(sourceId: string, limit = 20): Promise<GenerationRun[]> {
    const rows = useFirestore()
      ? (await this.runs().where('sourceId', '==', sourceId).limit(200).get()).docs.map(
          (doc) => doc.data() as GenerationRun,
        )
      : readLocal<GenerationRun>(RUNS).filter((run) => run.sourceId === sourceId);
    return rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, limit);
  }
}

export const generationLog = new GenerationLog();
