import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import type { AuthenticatedRequest } from '../middleware/authMiddleware';
import { isStorageUnavailableError } from '../services/storage/availability';
import { ClientRequestError } from './errors';

/**
 * The one place a failed API request is answered.
 *
 * Every `/api` route and middleware reaches it by calling `next(error)`, or by
 * rejecting, which `guardAsyncHandlers` turns into the same thing. It answers
 * `{ error, code }` with a status that says whose failure it was:
 *
 *   - 4xx: the client sent something the server cannot use — a body that is not
 *     JSON, an upload the limits refuse, an id that could never exist;
 *   - 503: the data backend cannot be used right now;
 *   - 500: anything else, which is a defect.
 *
 * The client gets a fixed message for its class of failure and nothing taken
 * from the error itself: no stack, no file path, no library message, no stored
 * content. The server log gets the method, path, user and status, and for a 5xx
 * the error with its stack.
 *
 * A route that answers its own refusals (404, 409, a validation 400) keeps
 * doing so; this is for what nothing else answered.
 */

export interface ApiFailure {
  status: number;
  code: string;
  message: string;
}

const INTERNAL_ERROR: ApiFailure = { status: 500, code: 'internal_error', message: 'Something went wrong on the server.' };
const STORAGE_UNAVAILABLE: ApiFailure = { status: 503, code: 'storage_unavailable', message: 'The data service is unavailable right now. Please try again shortly.' };
const INVALID_UPLOAD: ApiFailure = { status: 400, code: 'invalid_upload', message: 'The upload could not be read.' };

/** multer's limit errors, by their code. */
const UPLOAD_FAILURES: Record<string, ApiFailure> = {
  LIMIT_FILE_SIZE: { status: 413, code: 'file_too_large', message: 'The uploaded file is too large.' },
  LIMIT_FILE_COUNT: { status: 400, code: 'too_many_files', message: 'Upload one file at a time.' },
  LIMIT_UNEXPECTED_FILE: { status: 400, code: 'unexpected_file', message: 'The upload has a file in an unexpected field.' },
};

/** body-parser's errors say what went wrong in `type`, with the status it recommends. */
function readBodyFailure(error: Error): ApiFailure | null {
  const { type, status } = error as Error & { type?: unknown; status?: unknown };
  if (typeof type !== 'string' || typeof status !== 'number') return null;
  switch (type) {
    case 'entity.parse.failed':
      return { status: 400, code: 'invalid_json', message: 'The request body is not valid JSON.' };
    case 'entity.too.large':
      return { status: 413, code: 'payload_too_large', message: 'The request body is too large.' };
    case 'charset.unsupported':
    case 'encoding.unsupported':
      return { status: 415, code: 'unsupported_encoding', message: 'The request body encoding is not supported.' };
    default:
      return status >= 400 && status < 500 ? { status, code: 'invalid_request_body', message: 'The request body could not be read.' } : null;
  }
}

export function classifyApiError(error: unknown): ApiFailure {
  if (error instanceof ClientRequestError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof multer.MulterError) return UPLOAD_FAILURES[error.code] ?? INVALID_UPLOAD;
  if (error instanceof Error) {
    const body = readBodyFailure(error);
    if (body) return body;
  }
  if (isStorageUnavailableError(error)) return STORAGE_UNAVAILABLE;
  return INTERNAL_ERROR;
}

export function apiErrorBoundary(error: unknown, req: Request, res: Response, next: NextFunction): void {
  const failure = classifyApiError(error);
  const { userId } = req as AuthenticatedRequest;
  const adminId = (req as Request & { adminUser?: { id?: string } }).adminUser?.id;
  const actor = userId ? ` (user ${userId})` : adminId ? ` (admin ${adminId})` : '';
  const where = `${req.method} ${req.baseUrl}${req.path}${actor}`;
  if (res.headersSent) {
    // Part of the answer is already on the wire; Express closes the connection.
    console.error(`[HTTP] ${where} failed after its response had started:`, error);
    next(error);
    return;
  }
  if (failure.status >= 500) console.error(`[HTTP] ${where} -> ${failure.status} ${failure.code}:`, error);
  else console.warn(`[HTTP] ${where} -> ${failure.status} ${failure.code}: ${failure.message}`);
  res.status(failure.status).json({ error: failure.message, code: failure.code });
}
