/**
 * What a file actually is, decided from its bytes.
 *
 * The upload route used to trust two things it should not have: the extension
 * (which the uploader chooses) and `file.mimetype` (which the browser sends and
 * anyone can forge). The declared type was then persisted and echoed straight
 * back out of the download route as `Content-Type`, so a file called `x.png`
 * declared as `text/html` was served as HTML from the app's own origin.
 *
 * Nothing here trusts the request. The extension and the declared MIME type are
 * inputs to a consistency check; the sniffed type is what gets stored.
 */

export type AssetKind = 'audio' | 'image' | 'document' | 'html';

export interface SniffedType {
  /** The MIME type to store and to serve with. */
  mimeType: string;
  kind: AssetKind;
}

interface Signature {
  mimeType: string;
  kind: AssetKind;
  /** Byte pattern; `null` matches any byte at that offset. */
  bytes: (number | null)[];
  offset?: number;
  /** Extra check for containers that share a magic number. */
  verify?: (buffer: Buffer) => boolean;
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

const SIGNATURES: Signature[] = [
  // Images
  { mimeType: 'image/png', kind: 'image', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'image/jpeg', kind: 'image', bytes: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/gif', kind: 'image', bytes: ascii('GIF8') },
  {
    mimeType: 'image/webp',
    kind: 'image',
    bytes: ascii('RIFF'),
    verify: (b) => b.length > 12 && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  // Audio
  { mimeType: 'audio/mpeg', kind: 'audio', bytes: ascii('ID3') },
  { mimeType: 'audio/mpeg', kind: 'audio', bytes: [0xff, 0xfb] },
  { mimeType: 'audio/mpeg', kind: 'audio', bytes: [0xff, 0xf3] },
  { mimeType: 'audio/mpeg', kind: 'audio', bytes: [0xff, 0xf2] },
  {
    mimeType: 'audio/wav',
    kind: 'audio',
    bytes: ascii('RIFF'),
    verify: (b) => b.length > 12 && b.subarray(8, 12).toString('latin1') === 'WAVE',
  },
  { mimeType: 'audio/ogg', kind: 'audio', bytes: ascii('OggS') },
  // Documents
  { mimeType: 'application/pdf', kind: 'document', bytes: ascii('%PDF-') },
  {
    // .docx is a ZIP container; the marker sits early in the archive.
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'document',
    bytes: [0x50, 0x4b, 0x03, 0x04],
    verify: (b) => b.subarray(0, 4096).toString('latin1').includes('word/'),
  },
];

/** Extensions the upload route accepts, and what each one must turn out to be. */
export const EXTENSION_EXPECTATIONS: Record<string, { kind: AssetKind; mimeTypes: string[] }> = {
  '.mp3': { kind: 'audio', mimeTypes: ['audio/mpeg'] },
  '.wav': { kind: 'audio', mimeTypes: ['audio/wav'] },
  '.ogg': { kind: 'audio', mimeTypes: ['audio/ogg'] },
  '.png': { kind: 'image', mimeTypes: ['image/png'] },
  '.jpg': { kind: 'image', mimeTypes: ['image/jpeg'] },
  '.jpeg': { kind: 'image', mimeTypes: ['image/jpeg'] },
  '.webp': { kind: 'image', mimeTypes: ['image/webp'] },
  '.gif': { kind: 'image', mimeTypes: ['image/gif'] },
  '.pdf': { kind: 'document', mimeTypes: ['application/pdf'] },
  '.docx': {
    kind: 'document',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
  '.txt': { kind: 'document', mimeTypes: ['text/plain'] },
  '.html': { kind: 'html', mimeTypes: ['text/html'] },
  '.htm': { kind: 'html', mimeTypes: ['text/html'] },
};

function matches(buffer: Buffer, signature: Signature): boolean {
  const offset = signature.offset ?? 0;
  if (buffer.length < offset + signature.bytes.length) return false;
  for (let i = 0; i < signature.bytes.length; i++) {
    const expected = signature.bytes[i];
    if (expected !== null && buffer[offset + i] !== expected) return false;
  }
  return signature.verify ? signature.verify(buffer) : true;
}

/** True when the buffer decodes as UTF-8 and carries no NUL or control bytes. */
export function looksLikeText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  for (let i = 0; i < Math.min(buffer.length, 8192); i++) {
    const byte = buffer[i];
    if (byte < 9 || byte === 11 || byte === 12 || (byte >= 14 && byte <= 31) || byte === 127) {
      return false;
    }
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

const HTML_STRUCTURE =
  /<(!DOCTYPE|html|head|body|p|div|table|h[1-6]|span|section|article|main|ul|ol|b|strong|em|i)\b/i;

/**
 * Identifies a buffer, or returns `null` when nothing recognises it.
 *
 * Text formats have no magic number, so they are decided last and only when the
 * bytes really are text: an HTML document if it carries HTML structure, plain
 * text otherwise.
 */
export function sniffFileType(buffer: Buffer): SniffedType | null {
  if (!buffer?.length) return null;

  for (const signature of SIGNATURES) {
    if (matches(buffer, signature)) return { mimeType: signature.mimeType, kind: signature.kind };
  }

  if (looksLikeText(buffer)) {
    const text = buffer.subarray(0, 65536).toString('utf8');
    return HTML_STRUCTURE.test(text)
      ? { mimeType: 'text/html', kind: 'html' }
      : { mimeType: 'text/plain', kind: 'document' };
  }

  return null;
}

export interface ValidationFailure {
  ok: false;
  error: string;
}
export interface ValidationSuccess extends SniffedType {
  ok: true;
}

/**
 * Checks that the extension, the declared MIME type and the bytes agree.
 *
 * A mismatch is refused rather than resolved: `.png` carrying HTML is either a
 * mistake or an attack, and guessing which one is not this function's job.
 */
export function validateUpload(params: {
  extension: string;
  declaredMimeType?: string;
  buffer: Buffer;
}): ValidationSuccess | ValidationFailure {
  const extension = params.extension.toLowerCase();
  const expectation = EXTENSION_EXPECTATIONS[extension];
  if (!expectation) {
    return { ok: false, error: `Unsupported file type: ${extension || 'unknown'}` };
  }

  const sniffed = sniffFileType(params.buffer);
  if (!sniffed) {
    return { ok: false, error: 'File content was not recognised, or is not a supported format.' };
  }

  // `.txt` may legitimately sniff as HTML when it happens to contain tags; it
  // is still stored and served as plain text, never as a document.
  if (extension === '.txt') {
    if (!looksLikeText(params.buffer)) return { ok: false, error: 'Binary text file rejected.' };
    return { ok: true, mimeType: 'text/plain', kind: 'document' };
  }

  if (!expectation.mimeTypes.includes(sniffed.mimeType)) {
    return {
      ok: false,
      error: `File contents do not match the ${extension} extension (detected ${sniffed.mimeType}).`,
    };
  }

  const declared = (params.declaredMimeType || '').split(';')[0].trim().toLowerCase();
  // A browser that declines to guess sends application/octet-stream; that is
  // not a contradiction, only an absence.
  const declaredIsMeaningful = declared && declared !== 'application/octet-stream';
  if (declaredIsMeaningful && !expectation.mimeTypes.includes(declared)) {
    // Tolerate the well-known synonyms browsers actually send, and refuse the
    // rest — an .mp3 announced as text/html is the case that matters.
    const synonyms: Record<string, string[]> = {
      'audio/mpeg': ['audio/mp3', 'audio/mpeg3', 'audio/x-mpeg-3'],
      'audio/wav': ['audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
      'audio/ogg': ['application/ogg', 'audio/vorbis'],
      'image/jpeg': ['image/jpg'],
      'text/html': ['application/xhtml+xml'],
    };
    const accepted = expectation.mimeTypes.flatMap((m) => [m, ...(synonyms[m] || [])]);
    if (!accepted.includes(declared)) {
      return {
        ok: false,
        error: `Declared content type ${declared} does not match a ${extension} file.`,
      };
    }
  }

  return { ok: true, mimeType: sniffed.mimeType, kind: sniffed.kind };
}
