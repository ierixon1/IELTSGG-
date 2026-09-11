import { z } from 'zod';
import {
  BUNDLE_SECTIONS,
  MAX_SECTION_MINUTES,
  type BundleComponentRef,
  type BundleSection,
  type FullCdiBundle,
} from '../types/bundle';

/**
 * The bundle write contract, and the migration from the shape bundles had
 * before components were pinned.
 *
 * What an admin sends is a draft: title, module, components and timing. There
 * is no status in it. Saving never publishes, and publishing is its own action
 * behind the bundle gate.
 */

const Id = z.string().trim().regex(/^[A-Za-z0-9_.-]{1,160}$/, 'Invalid identifier.');
const Section = z.enum(['listening', 'reading', 'writing', 'speaking']);
const ContentHash = z.string().regex(/^[a-f0-9]{64}$/, 'A component must pin a content fingerprint.');
const Minutes = z
  .number()
  .int('Minutes must be a whole number.')
  .min(1, 'A section must last at least a minute.')
  .max(MAX_SECTION_MINUTES, `A section cannot last more than ${MAX_SECTION_MINUTES} minutes.`);

export const BundleComponentSchema = z
  .object({
    section: Section,
    part: z.number().int().min(1).max(4),
    materialId: Id,
    contentHash: ContentHash,
  })
  .strict();

export const BundleTimingSchema = z
  .object({
    listeningMinutes: Minutes,
    readingMinutes: Minutes,
    writingMinutes: Minutes,
    speakingMinutes: Minutes,
    basis: z.enum(['custom', 'ielts_reference']),
    allowEarlyFinish: z.boolean(),
  })
  .strict();

/** What a save may carry. Unknown keys, `status` included, are dropped. */
export const BundleDraftInputSchema = z.object({
  title: z.string().trim().min(1, 'A bundle needs a title.').max(200),
  module: z.enum(['academic', 'general']),
  targetBand: z.string().trim().max(20).optional(),
  description: z.string().trim().max(2000).optional(),
  components: z.array(BundleComponentSchema).max(12),
  timing: BundleTimingSchema,
});

export type BundleDraftInput = z.infer<typeof BundleDraftInputSchema>;

const StoredComponent = z.object({
  section: Section,
  part: z.number().int().min(1).max(4),
  materialId: Id,
  contentHash: z.union([ContentHash, z.literal('')]),
});

const StoredTiming = z.object({
  listeningMinutes: z.number(),
  readingMinutes: z.number(),
  writingMinutes: z.number(),
  speakingMinutes: z.number(),
  basis: z.enum(['custom', 'ielts_reference']),
  allowEarlyFinish: z.boolean(),
});

const StoredBundleSchema = z.object({
  id: Id,
  schemaVersion: z.literal(2),
  title: z.string(),
  module: z.enum(['academic', 'general']),
  targetBand: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(['draft', 'published', 'archived']),
  components: z.array(StoredComponent),
  timing: StoredTiming,
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().optional(),
  firstPublishedAt: z.string().optional(),
  archivedAt: z.string().optional(),
});

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

/**
 * A bundle from before pinning: one id per section and free-form timings.
 *
 * Its components come back unpinned (empty fingerprint) and with the parts
 * they are presumed to be. The bundle gate refuses both, so a migrated bundle
 * cannot be sat until an admin opens it, sees what it references, and pins it.
 * Nothing about it is guessed into validity.
 */
function migrateLegacy(raw: Record<string, unknown>): unknown {
  const materials = record(raw.materials);
  const timings = record(raw.timings);
  const components: BundleComponentRef[] = [];
  for (const section of BUNDLE_SECTIONS) {
    const materialId = text(materials[`${section}Id`]);
    if (materialId) components.push({ section, part: 1, materialId, contentHash: '' });
  }
  const minutes = (key: string) => (typeof timings[key] === 'number' ? (timings[key] as number) : 0);
  return {
    id: raw.id,
    schemaVersion: 2,
    title: text(raw.title) ?? '',
    module: raw.module === 'general' ? 'general' : 'academic',
    targetBand: text(raw.targetBand),
    description: text(raw.description),
    status: raw.status === 'published' ? 'published' : 'draft',
    components,
    timing: {
      listeningMinutes: minutes('listeningMinutes'),
      readingMinutes: minutes('readingMinutes'),
      writingMinutes: minutes('writingMinutes'),
      speakingMinutes: minutes('speakingMinutes'),
      basis: 'custom',
      allowEarlyFinish: true,
    },
    createdAt: text(raw.createdAt) ?? text(raw.updatedAt) ?? new Date(0).toISOString(),
    updatedAt: text(raw.updatedAt) ?? new Date(0).toISOString(),
    ...(raw.status === 'published' ? { publishedAt: text(raw.updatedAt), firstPublishedAt: text(raw.updatedAt) } : {}),
  };
}

export class StoredBundleError extends Error {
  constructor(readonly issues: string[]) {
    super(`Stored bundle is unreadable: ${issues.join(' | ')}`);
    this.name = 'StoredBundleError';
  }
}

/** Reads one stored row as a current bundle, migrating the legacy shape. Throws on anything else. */
export function readStoredBundle(value: unknown): FullCdiBundle {
  const raw = record(value);
  const candidate = raw.schemaVersion === 2 ? raw : migrateLegacy(raw);
  const parsed = StoredBundleSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new StoredBundleError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  }
  return parsed.data;
}

export const isBundleSection = (value: unknown): value is BundleSection =>
  typeof value === 'string' && (BUNDLE_SECTIONS as readonly string[]).includes(value);
