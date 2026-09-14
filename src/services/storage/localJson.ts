import fs from 'fs';
import path from 'path';

/**
 * Reading a JSON file of the local development store (M4).
 *
 * The local stores used to read a file that could not be parsed — truncated by a
 * crash, hand-edited, half-written — as empty, and the next write replaced it with
 * that emptiness: a whole collection of users, materials or assets gone without a
 * word. Now only a file that does not exist reads as the fallback. A file that
 * exists but cannot be read, is not JSON, or does not hold the expected shape
 * throws `LocalStoreCorruptError`, which the API error boundary answers 503
 * `storage_unavailable`; nothing is overwritten.
 *
 * Production never uses the local store (`STORAGE_BACKEND=gcs_firestore`).
 */

export class LocalStoreCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalStoreCorruptError';
  }
}

export const isJsonArray = (value: unknown): value is unknown[] => Array.isArray(value);
export const isJsonObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function readLocalJson<T>(file: string, fallback: T, isShape: (value: unknown) => boolean): T {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw new LocalStoreCorruptError(`${path.basename(file)} could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LocalStoreCorruptError(`${path.basename(file)} is not valid JSON; it is not read as empty, so nothing overwrites it.`);
  }
  if (!isShape(value)) throw new LocalStoreCorruptError(`${path.basename(file)} does not hold the data it should; it is not read as empty.`);
  return value as T;
}
