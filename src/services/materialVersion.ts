import { createHash } from 'node:crypto';
import type { AdminMaterial } from '../types/admin';

/**
 * The version of a material, for the purpose of pinning it into a bundle.
 *
 * Materials are edited in place; there is no immutable revision to point at.
 * So a bundle pins a fingerprint of what a learner would actually meet — the
 * section, the module and the content — and a published bundle is valid only
 * while each material still hashes to what was pinned.
 *
 * Provenance records are left out on purpose. A reviewer confirming a flagged
 * question, or a re-import note, does not change what a candidate sits, and must
 * not invalidate every bundle that uses the material.
 */

const NOT_LEARNER_CONTENT = new Set(['importRecord', 'generationRecord', 'generationReviews']);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = canonical(child);
    }
    return out;
  }
  return value;
}

export function materialContentHash(material: AdminMaterial): string {
  const content = Object.fromEntries(
    Object.entries(material.content as Record<string, unknown>).filter(([key]) => !NOT_LEARNER_CONTENT.has(key)),
  );
  const payload = JSON.stringify(canonical({ section: material.section, module: material.module, content }));
  return createHash('sha256').update(payload).digest('hex');
}
