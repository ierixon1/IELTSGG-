import type { Request, Response } from 'express';

/**
 * Sends a stored file that a route has already authorised (`authorizeAssetRead`).
 *
 * The stored MIME type is sniffed from the bytes, never taken from the upload,
 * and only media a page renders is served inline. Everything else — documents,
 * and imported HTML above all — is a download with a neutral type, so an
 * uploaded page can never execute on this origin and nothing can be served as
 * audio unless its bytes are audio.
 *
 * Inline media answers byte-range requests (H8). A browser's media player asks
 * for ranges — Safari and iOS for every recording, before playing a second of
 * it — and a server that ignores them makes the player download the whole file
 * or give up. Ranges are read from the bytes this request was authorised for,
 * so a `Range` header can narrow a response but never widen what is served.
 */

const INLINE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'application/pdf']);

export interface SendableAsset {
  mimeType: string;
  originalName: string;
  /** The stored bytes' digest. Assets are never overwritten, so it is a strong validator. */
  sha256?: string;
}

export type ByteRange = { start: number; end: number };

/**
 * The single byte range a request asks for; `'unsatisfiable'` when it asks only
 * for bytes the file does not have; null when the whole file is sent — no
 * `Range`, another unit, a malformed header, or several ranges, which a server
 * may answer with the whole representation.
 */
export function requestedRange(req: Request, size: number): ByteRange | 'unsatisfiable' | null {
  const header = req.headers.range;
  if (!header) return null;
  // Only bytes are served. A header in any other unit is ignored, however it is written.
  const equals = header.indexOf('=');
  if (equals === -1 || header.slice(0, equals).trim().toLowerCase() !== 'bytes') return null;
  const ranges = req.range(size, { combine: true });
  if (ranges === -1) return 'unsatisfiable';
  if (ranges === undefined || ranges === -2 || ranges.length !== 1) return null;
  return { start: ranges[0].start, end: ranges[0].end };
}

export function sendAsset(req: Request, res: Response, asset: SendableAsset, data: Buffer) {
  const inline = INLINE_MEDIA_TYPES.has(asset.mimeType);
  // Word characters, dots, spaces and hyphens only: nothing that could end the quoted header value (L1).
  const filename = asset.originalName.replace(/[^\w. -]/g, '_').slice(0, 120) || 'download';
  res.setHeader('Content-Type', inline ? asset.mimeType : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  // Every read is authorised afresh, so no shared cache may keep a file and a private one must ask again.
  res.setHeader('Cache-Control', 'private, no-cache');
  const etag = asset.sha256 ? `"${asset.sha256}"` : undefined;
  if (etag) res.setHeader('ETag', etag);

  if (!inline) {
    res.setHeader('Accept-Ranges', 'none');
    return res.send(data);
  }

  res.setHeader('Accept-Ranges', 'bytes');
  // A range is only good against the version it was taken from; anything else gets the whole file.
  const ifRange = req.headers['if-range'];
  const range = ifRange !== undefined && ifRange !== etag ? null : requestedRange(req, data.length);
  if (range === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${data.length}`);
    return res.status(416).end();
  }
  // `res.send` answers a matching `If-None-Match` with 304 and a HEAD request without a body.
  if (!range) return res.send(data);

  res.status(206);
  res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${data.length}`);
  res.setHeader('Content-Length', String(range.end - range.start + 1));
  return res.end(data.subarray(range.start, range.end + 1));
}
