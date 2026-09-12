import { expect } from './harness';

/**
 * What an error answer must never carry: stack frames, file paths, library
 * names, error class names, or text lifted from the error that caused it.
 */
export const INTERNALS: RegExp[] = [
  /node_modules/i,
  /\.[cm]?[jt]sx?:\d+/,
  /\bat [^\s()]+ \(/,
  /[A-Za-z]:\\/,
  /\/(Users|home|tmp|var|srv)\//,
  /Could not load the default credentials/,
  /google-gax|firebase|grpc/i,
  /\b(SyntaxError|MulterError|TypeError|RangeError)\b/,
  /secret/i,
];

export interface ErrorReply {
  status: number;
  type: string;
  text: string;
}

export function expectNoInternals(label: string, text: string): void {
  for (const pattern of INTERNALS) expect([label, String(pattern), pattern.test(text)]).toEqual([label, String(pattern), false]);
}

/** An answer from the API error boundary: this status, JSON `{ error, code }` with this code, and nothing internal. */
export function expectControlledError(label: string, reply: ErrorReply, status: number, code: string): void {
  expect([label, reply.status, reply.type.includes('application/json')]).toEqual([label, status, true]);
  const body = JSON.parse(reply.text) as Record<string, unknown>;
  expect([label, Object.keys(body).sort(), typeof body.error, body.code]).toEqual([label, ['code', 'error'], 'string', code]);
  expectNoInternals(label, reply.text);
}
