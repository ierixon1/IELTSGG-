import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { nanoid } from 'nanoid';
import mammoth from 'mammoth';
import sanitizeHtml from 'sanitize-html';
import { adminStore, UPLOADS_DIR } from '../services/adminStore';

export const adminRouter = express.Router();

/**
 * Server-side HTML Sanitizer:
 * Enforces strict security policy removing <script>, inline event handlers (onclick, onload),
 * external dangerous iframes/objects/embeds, and javascript: protocols,
 * while allowing authentic rich typography, tables, headings, and images.
 */
/**
 * Known binary file magic signatures to detect disguised executables/archives/media
 */
const BINARY_MAGIC_SIGNATURES = [
  { name: 'Windows Executable/DLL (PE)', bytes: [0x4d, 0x5a] }, // MZ
  { name: 'Linux ELF Binary', bytes: [0x7f, 0x45, 0x4c, 0x46] }, // \x7fELF
  { name: 'Mach-O Binary (32-bit)', bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { name: 'Mach-O Binary (64-bit)', bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: 'Mach-O Binary (reverse)', bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { name: 'Mach-O Binary (64-bit reverse)', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: 'Java Class / Mach-O Fat', bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { name: 'ZIP / Office OpenXML Archive', bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK..
  { name: 'PDF Document', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { name: 'PNG Image', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: 'JPEG Image', bytes: [0xff, 0xd8, 0xff] },
  { name: 'GIF Image', bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { name: 'RIFF (WAV/WebP/AVI)', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
  { name: 'GZIP Archive', bytes: [0x1f, 0x8b] },
  { name: '7-Zip Archive', bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { name: 'RAR Archive', bytes: [0x52, 0x61, 0x72, 0x21] }, // Rar!
  { name: 'XZ Archive', bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { name: 'ICO File', bytes: [0x00, 0x00, 0x01, 0x00] },
  { name: 'BZIP2 Archive', bytes: [0x42, 0x5a, 0x68] },
];

/**
 * Validates that an uploaded file buffer is authentic text/HTML, not a disguised binary
 */
export function validateHtmlFileBuffer(buffer: Buffer): { valid: boolean; error?: string } {
  if (!buffer || buffer.length === 0) {
    return { valid: false, error: 'File is empty.' };
  }
  if (buffer.length > 5 * 1024 * 1024) {
    return { valid: false, error: 'HTML file exceeds the 5MB size limit.' };
  }

  // 1. Magic byte signatures check for known binaries
  for (const sig of BINARY_MAGIC_SIGNATURES) {
    if (buffer.length >= sig.bytes.length) {
      const match = sig.bytes.every((b, idx) => buffer[idx] === b);
      if (match) {
        return { valid: false, error: `Disguised binary file detected (${sig.name}). File rejected.` };
      }
    }
  }

  // 2. Binary null byte check (UTF-8/ASCII documents must never contain 0x00)
  if (buffer.includes(0x00)) {
    return { valid: false, error: 'Binary null bytes (0x00) detected. The file is not a valid text/HTML document.' };
  }

  // 3. Binary control characters check (allows \t=0x09, \n=0x0A, \r=0x0D; rejects 0x01-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F)
  const sampleSize = Math.min(buffer.length, 8192);
  let controlCount = 0;
  for (let i = 0; i < sampleSize; i++) {
    const byte = buffer[i];
    if ((byte < 0x09) || (byte === 0x0b) || (byte === 0x0c) || (byte >= 0x0e && byte <= 0x1f) || byte === 0x7f) {
      controlCount++;
    }
  }
  if (controlCount > 0) {
    return { valid: false, error: 'Unprintable binary control bytes detected in stream. File rejected.' };
  }

  // 4. Strict UTF-8 validation
  let decodedText: string;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decodedText = decoder.decode(buffer);
  } catch {
    return { valid: false, error: 'The uploaded file contains invalid UTF-8 byte sequences.' };
  }

  // 5. Recognized HTML markup verification
  const hasHtmlMarkup = /<(!DOCTYPE|html|head|body|p|div|table|h[1-6]|span|section|article|main|ul|ol|b|strong|em|i)\b/i.test(decodedText);
  if (!hasHtmlMarkup) {
    return { valid: false, error: 'The uploaded file does not contain recognized HTML elements or document structure.' };
  }

  return { valid: true };
}

/**
 * Server-side HTML Sanitizer:
 * Enforces strict security policy:
 * - Completely disallows external tracking pixels and external image URLs (prevents student IP/UA tracking & SSRF)
 * - Restricts CSS style attributes to strict typography/table presentation rules (forbids position, z-index, url(), etc.)
 * - Filters class names to safe formatting classes, preventing layout escape via Tailwind utilities
 * - Enforces rel="noopener noreferrer nofollow" on links
 */
export const sanitizeHtmlServer = (rawHtml: string): string => {
  if (!rawHtml || typeof rawHtml !== 'string') return '';
  return sanitizeHtml(rawHtml, {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'mark', 'small', 'sub', 'sup',
      'span', 'div', 'blockquote', 'q', 'pre', 'code',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'col', 'colgroup',
      'img', 'a', 'figure', 'figcaption',
      'section', 'article', 'aside', 'header', 'footer', 'nav', 'main',
      'details', 'summary'
    ],
    allowedAttributes: {
      '*': ['class', 'id', 'style', 'title', 'lang', 'dir'],
      'img': ['src', 'alt', 'width', 'height', 'loading'],
      'a': ['href', 'target', 'rel'],
      'th': ['colspan', 'rowspan', 'headers', 'scope'],
      'td': ['colspan', 'rowspan', 'headers', 'scope']
    },
    // Explicitly allow ONLY safe table & academic typography CSS properties
    // Forbids position, z-index, url(), opacity, display, top/left/right/bottom, @import, expression
    allowedStyles: {
      '*': {
        'text-align': [/^(left|right|center|justify)$/i],
        'vertical-align': [/^(top|middle|bottom|baseline)$/i],
        'font-weight': [/^(bold|normal|[1-9]00)$/i],
        'font-style': [/^(italic|normal)$/i],
        'text-decoration': [/^(underline|line-through|none)$/i],
        'width': [/^\d+(?:\.\d+)?(?:px|%|em|rem|ch)$/i],
        'max-width': [/^\d+(?:\.\d+)?(?:px|%|em|rem|ch)$/i],
        'min-width': [/^\d+(?:\.\d+)?(?:px|%|em|rem|ch)$/i],
        'height': [/^\d+(?:\.\d+)?(?:px|%|em|rem|ch)$/i],
        'padding': [/^[0-9.]+(?:px|%|em|rem)(\s+[0-9.]+(?:px|%|em|rem))*$/i],
        'padding-left': [/^[0-9.]+(?:px|%|em|rem)$/i],
        'padding-right': [/^[0-9.]+(?:px|%|em|rem)$/i],
        'padding-top': [/^[0-9.]+(?:px|%|em|rem)$/i],
        'padding-bottom': [/^[0-9.]+(?:px|%|em|rem)$/i],
        'margin': [/^(auto|[0-9.]+(?:px|%|em|rem)(\s+[0-9.]+(?:px|%|em|rem))*)$/i],
        'margin-left': [/^(auto|[0-9.]+(?:px|%|em|rem))$/i],
        'margin-right': [/^(auto|[0-9.]+(?:px|%|em|rem))$/i],
        'margin-top': [/^(auto|[0-9.]+(?:px|%|em|rem))$/i],
        'margin-bottom': [/^(auto|[0-9.]+(?:px|%|em|rem))$/i],
        'border': [/^[0-9a-zA-Z\s#(),.-]+$/i],
        'border-top': [/^[0-9a-zA-Z\s#(),.-]+$/i],
        'border-bottom': [/^[0-9a-zA-Z\s#(),.-]+$/i],
        'border-left': [/^[0-9a-zA-Z\s#(),.-]+$/i],
        'border-right': [/^[0-9a-zA-Z\s#(),.-]+$/i],
        'border-collapse': [/^(collapse|separate)$/i],
        'border-spacing': [/^[0-9px\s]+$/i],
        'color': [/^(#[0-9a-fA-F]{3,8}|rgb\([0-9\s,]+\)|rgba\([0-9\s,.]+\)|[a-zA-Z]+)$/i],
        'background-color': [/^(#[0-9a-fA-F]{3,8}|rgb\([0-9\s,]+\)|rgba\([0-9\s,.]+\)|transparent|[a-zA-Z]+)$/i]
      }
    },
    // Filter class attribute: preserve only safe formatting classes, strip layout breakout classes
    allowedClasses: {
      '*': [
        /^cdi-[\w-]+$/,
        /^(text-(left|right|center|justify|xs|sm|base|lg|slate|gray|neutral|zinc|black|red|emerald|amber|indigo))$/,
        /^(font-(serif|sans|mono|bold|semibold|normal|medium))$/,
        /^(italic|underline|line-through)$/,
        /^(p[xytb]?-[0-8])$/,
        /^(m[xytb]?-[0-8])$/,
        /^(border|border-[a-z0-9-]+)$/,
        /^(bg-[a-z0-9-]+)$/,
        /^(table|table-[a-z]+|w-full|h-auto|max-w-[a-z0-9]+)$/,
        /^(list-[a-z]+|space-[xy]-[0-8])$/
      ]
    },
    transformTags: {
      // Security: Disallow arbitrary external img src to prevent tracking pixels, client IP leakage & SSRF
      'img': (tagName, attribs) => {
        const src = (attribs.src || '').trim();
        const isLocalUpload = src.startsWith('/api/uploads/');
        const isSafeBase64 = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(src);

        if (!isLocalUpload && !isSafeBase64) {
          // Replace external tracking pixel / untrusted source with security placeholder
          return {
            tagName: 'span',
            attribs: {
              class: 'cdi-blocked-img text-slate-400 italic text-xs block my-2 p-2 border border-dashed border-slate-300 rounded bg-slate-50'
            },
            text: '[External image blocked: only internal uploads or inline base64 data are allowed]'
          };
        }
        return { tagName, attribs };
      },
      // Security: Enforce noopener, noreferrer, nofollow on all links
      'a': (tagName, attribs) => {
        attribs.target = '_blank';
        attribs.rel = 'noopener noreferrer nofollow';
        return { tagName, attribs };
      }
    },
    allowedSchemes: ['http', 'https', 'mailto', 'data'],
    allowedSchemesByTag: {
      img: ['data'] // http/https are blocked for img in transformTags
    },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard'
  });
};

/**
 * Recursively inspect and sanitize any htmlContent or passageHtml properties
 */
export function deepSanitizeHtml(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => deepSanitizeHtml(item));
  }
  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if ((key === 'htmlContent' || key === 'passageHtml') && typeof value === 'string') {
      result[key] = sanitizeHtmlServer(value);
    } else if (typeof value === 'object' && value !== null) {
      result[key] = deepSanitizeHtml(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// Admin Accounts configuration (easily configurable via env)
const ADMIN_ACCOUNTS = [
  {
    username: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASSWORD || 'prep2026!admin',
    displayName: 'Head of IELTS Content',
    role: 'superadmin',
  },
  {
    username: 'examiner',
    password: 'cambridge2026',
    displayName: 'Senior IELTS Examiner',
    role: 'content_manager',
  },
];

const ACTIVE_ADMIN_TOKENS = new Map<
  string,
  { username: string; displayName: string; role: string; expiresAt: number }
>();

/**
 * Middleware: Verify Admin Token
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const adminKey = req.headers['x-admin-key'];

  // Master bypass for automated testing or backend tasks
  if (adminKey && adminKey === (process.env.ADMIN_SECRET_KEY || 'prep_master_admin_key_2026')) {
    (req as any).adminUser = {
      username: 'master_admin',
      displayName: 'System Master Admin',
      role: 'superadmin',
    };
    return next();
  }

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split('Bearer ')[1]?.trim();
    const session = ACTIVE_ADMIN_TOKENS.get(token);

    if (session) {
      if (Date.now() > session.expiresAt) {
        ACTIVE_ADMIN_TOKENS.delete(token);
        return res.status(401).json({ error: 'Admin session expired. Please log in again.' });
      }
      (req as any).adminUser = session;
      return next();
    }
  }

  return res.status(403).json({ error: 'Forbidden: Administrator privileges required.' });
}

/**
 * Multer Config for Audio, Images, and Documents
 */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const uniqueSuffix = `${Date.now()}-${nanoid(6)}`;
    cb(null, `${safeName}_${uniqueSuffix}${ext}`);
  },
});

const fileFilter = (_req: Request, file: any, cb: multer.FileFilterCallback) => {
  const allowedExts = ['.mp3', '.wav', '.ogg', '.png', '.jpg', '.jpeg', '.webp', '.pdf', '.docx', '.txt', '.html', '.htm'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${ext} is not allowed. Supported formats: mp3, wav, png, jpg, webp, pdf, docx, txt, html, htm.`));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 35 * 1024 * 1024, // 35MB limit
  },
});

/* ================= AUTH ROUTES ================= */

adminRouter.post('/login', (req: Request, res: Response) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const account = ADMIN_ACCOUNTS.find(
    a => a.username.toLowerCase() === String(username).toLowerCase() && a.password === String(password)
  );

  if (!account) {
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  }

  const token = `adm_sec_${Date.now()}_${nanoid(24)}`;
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

  ACTIVE_ADMIN_TOKENS.set(token, {
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    expiresAt,
  });

  res.json({
    success: true,
    token,
    admin: {
      username: account.username,
      displayName: account.displayName,
      role: account.role,
    },
    expiresAt,
  });
});

adminRouter.get('/me', requireAdminAuth, (req: Request, res: Response) => {
  res.json({
    admin: (req as any).adminUser,
  });
});

adminRouter.post('/logout', requireAdminAuth, (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.split('Bearer ')[1]?.trim();
    ACTIVE_ADMIN_TOKENS.delete(token);
  }
  res.json({ success: true, message: 'Logged out successfully.' });
});

/* ================= DASHBOARD & STATS ================= */

adminRouter.get('/stats', requireAdminAuth, (_req: Request, res: Response) => {
  try {
    const stats = adminStore.getStats();
    res.json({ stats });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= FILE UPLOADER WITH AUTO TEXT EXTRACTION ================= */

adminRouter.post('/upload', requireAdminAuth, upload.single('file'), async (req: Request, res: Response) => {
  try {
    const uploadedFile = (req as any).file;
    if (!uploadedFile) {
      return res.status(400).json({ error: 'No file was uploaded.' });
    }

    const file = uploadedFile;
    const ext = path.extname(file.originalname).toLowerCase();
    const fileUrl = `/api/uploads/${file.filename}`;

    let extractedText = '';
    let extractedHtml = '';

    // Auto extract text for reading/writing prompts
    if (ext === '.html' || ext === '.htm') {
      const fileBuffer = fs.readFileSync(file.path);

      // Deep binary validation: magic bytes, control characters, null bytes, UTF-8 validity & HTML structure
      const validation = validateHtmlFileBuffer(fileBuffer);
      if (!validation.valid) {
        try { fs.unlinkSync(file.path); } catch {}
        return res.status(400).json({ error: validation.error || 'The uploaded file is not a valid text/HTML document.' });
      }

      const rawHtml = fileBuffer.toString('utf-8');

      // Sanitize the HTML immediately on upload to protect storage and serving
      const cleanHtml = sanitizeHtmlServer(rawHtml);
      // Overwrite the uploaded file with sanitized version for safe static serving
      fs.writeFileSync(file.path, cleanHtml, 'utf-8');

      extractedHtml = cleanHtml;
      extractedText = cleanHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    } else if (ext === '.txt') {
      const txtBuffer = fs.readFileSync(file.path);
      if (txtBuffer.includes(0x00)) {
        try { fs.unlinkSync(file.path); } catch {}
        return res.status(400).json({ error: 'Binary null bytes detected in text file. Upload rejected.' });
      }
      extractedText = txtBuffer.toString('utf-8');
    } else if (ext === '.pdf') {
      try {
        const dataBuffer = fs.readFileSync(file.path);
        const pdfParseModule = await import('pdf-parse');
        const parseFn = (pdfParseModule as any).default || (pdfParseModule as any).PDFParse || pdfParseModule;
        if (typeof parseFn === 'function') {
          const parsed = await parseFn(dataBuffer);
          extractedText = parsed.text || '';
        }
      } catch (pdfErr: any) {
        console.warn('[AdminUpload] PDF parse warning:', pdfErr.message);
      }
    } else if (ext === '.docx') {
      try {
        const result = await mammoth.extractRawText({ path: file.path });
        extractedText = result.value || '';
      } catch (docxErr: any) {
        console.warn('[AdminUpload] DOCX parse warning:', docxErr.message);
      }
    }

    res.json({
      success: true,
      file: {
        filename: file.filename,
        originalName: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
        url: fileUrl,
        extractedHtml: extractedHtml || undefined,
        extractedText: extractedText.trim() ? extractedText.trim() : undefined,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'File upload failed.' });
  }
});

/* ================= CRUD FOR MATERIALS ================= */

// List materials (supports query param ?section=speaking&status=published, or returns all sections)
adminRouter.get('/materials', requireAdminAuth, (req: Request, res: Response) => {
  const section = req.query.section as any;
  const status = req.query.status as any;

  if (section && ['speaking', 'reading', 'listening', 'writing'].includes(section)) {
    const items = adminStore.listMaterials(section, status);
    return res.json({ items });
  }

  // If no section specified, aggregate all
  const speaking = adminStore.listMaterials('speaking', status);
  const reading = adminStore.listMaterials('reading', status);
  const listening = adminStore.listMaterials('listening', status);
  const writing = adminStore.listMaterials('writing', status);

  res.json({
    items: [...speaking, ...reading, ...listening, ...writing],
  });
});

// Create material without section in path (takes section from req.body)
adminRouter.post('/materials', requireAdminAuth, (req: Request, res: Response) => {
  const section = req.body.section;
  if (!section || !['speaking', 'reading', 'listening', 'writing'].includes(section)) {
    return res.status(400).json({ error: `Valid 'section' (speaking, reading, listening, writing) is required in body.` });
  }

  const sanitizedBody = deepSanitizeHtml(req.body);
  const author = (req as any).adminUser?.displayName || 'Admin';
  const saved = adminStore.saveMaterial(section, sanitizedBody, author);
  res.json({ success: true, item: saved });
});

// Update material by ID
adminRouter.put('/materials/:id', requireAdminAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const section = req.body.section;
  if (!section || !['speaking', 'reading', 'listening', 'writing'].includes(section)) {
    return res.status(400).json({ error: `Valid 'section' is required in body to update material.` });
  }

  const sanitizedBody = deepSanitizeHtml(req.body);
  const saved = adminStore.saveMaterial(section, { ...sanitizedBody, id });
  res.json({ success: true, item: saved });
});

// Delete material by ID (searches all sections)
adminRouter.delete('/materials/:id', requireAdminAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const sections: ('speaking' | 'reading' | 'listening' | 'writing')[] = ['speaking', 'reading', 'listening', 'writing'];
  let deleted = false;
  for (const s of sections) {
    if (adminStore.deleteMaterial(s, id)) {
      deleted = true;
      break;
    }
  }

  if (!deleted) {
    return res.status(404).json({ error: 'Material not found or already deleted.' });
  }
  res.json({ success: true, message: 'Material deleted successfully.' });
});

adminRouter.get('/materials/:section', requireAdminAuth, (req: Request, res: Response) => {
  const { section } = req.params;
  const status = req.query.status as any;
  if (!['speaking', 'reading', 'listening', 'writing'].includes(section)) {
    return res.status(400).json({ error: `Invalid section: ${section}` });
  }

  const items = adminStore.listMaterials(section as any, status);
  res.json({ items });
});

adminRouter.get('/materials/:section/:id', requireAdminAuth, (req: Request, res: Response) => {
  const { section, id } = req.params;
  if (!['speaking', 'reading', 'listening', 'writing'].includes(section)) {
    return res.status(400).json({ error: `Invalid section: ${section}` });
  }

  const item = adminStore.getMaterial(section as any, id);
  if (!item) {
    return res.status(404).json({ error: 'Material not found.' });
  }
  res.json({ item });
});

adminRouter.post('/materials/:section', requireAdminAuth, (req: Request, res: Response) => {
  const { section } = req.params;
  if (!['speaking', 'reading', 'listening', 'writing'].includes(section)) {
    return res.status(400).json({ error: `Invalid section: ${section}` });
  }

  const sanitizedBody = deepSanitizeHtml(req.body);
  const author = (req as any).adminUser?.displayName || 'Admin';
  const saved = adminStore.saveMaterial(section as any, sanitizedBody, author);
  res.json({ success: true, item: saved });
});

adminRouter.put('/materials/:section/:id', requireAdminAuth, (req: Request, res: Response) => {
  const { section, id } = req.params;
  if (!['speaking', 'reading', 'listening', 'writing'].includes(section)) {
    return res.status(400).json({ error: `Invalid section: ${section}` });
  }

  const sanitizedBody = deepSanitizeHtml(req.body);
  const saved = adminStore.saveMaterial(section as any, { ...sanitizedBody, id });
  res.json({ success: true, item: saved });
});

adminRouter.delete('/materials/:section/:id', requireAdminAuth, (req: Request, res: Response) => {
  const { section, id } = req.params;
  if (!['speaking', 'reading', 'listening', 'writing'].includes(section)) {
    return res.status(400).json({ error: `Invalid section: ${section}` });
  }

  const deleted = adminStore.deleteMaterial(section as any, id);
  if (!deleted) {
    return res.status(404).json({ error: 'Material not found or already deleted.' });
  }
  res.json({ success: true, message: 'Material deleted successfully.' });
});

/* ================= CRUD FOR FULL CDI TEST BUNDLES ================= */

adminRouter.get('/bundles', requireAdminAuth, (req: Request, res: Response) => {
  const status = req.query.status as any;
  const bundles = adminStore.listBundles(status);
  res.json({ bundles });
});

adminRouter.get('/bundles/:id', requireAdminAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const resolved = adminStore.getResolvedBundle(id);
  if (!resolved) {
    return res.status(404).json({ error: 'CDI Bundle not found.' });
  }
  res.json(resolved);
});

adminRouter.post('/bundles', requireAdminAuth, (req: Request, res: Response) => {
  const saved = adminStore.saveBundle(req.body);
  res.json({ success: true, bundle: saved });
});

adminRouter.put('/bundles/:id', requireAdminAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const saved = adminStore.saveBundle({ ...req.body, id });
  res.json({ success: true, bundle: saved });
});

adminRouter.delete('/bundles/:id', requireAdminAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const deleted = adminStore.deleteBundle(id);
  if (!deleted) {
    return res.status(404).json({ error: 'Bundle not found.' });
  }
  res.json({ success: true, message: 'Bundle deleted successfully.' });
});

/* ================= PUBLIC / STUDENT ACCESS TO PUBLISHED MATERIALS & CDI TESTS ================= */

// List published materials for student mock hub
adminRouter.get('/public/materials/:section', (req: Request, res: Response) => {
  const { section } = req.params;
  if (!['speaking', 'reading', 'listening', 'writing'].includes(section)) {
    return res.status(400).json({ error: `Invalid section: ${section}` });
  }
  const items = adminStore.listMaterials(section as any, 'published');
  res.json({ items });
});

// List published full CDI bundles for student exam mode
adminRouter.get('/public/bundles', (_req: Request, res: Response) => {
  const bundles = adminStore.listBundles('published');
  res.json({ bundles });
});

// Get a single published CDI bundle resolved for taking the exam
adminRouter.get('/public/bundles/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const resolved = adminStore.getResolvedBundle(id);
  if (!resolved || resolved.bundle.status !== 'published') {
    return res.status(404).json({ error: 'Published CDI exam not found.' });
  }
  res.json(resolved);
});
