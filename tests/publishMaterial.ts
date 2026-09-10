import type { AdminMaterial } from '../src/types/admin';
import type { PublishGateContext } from '../src/services/publishGate';

type SectionType = 'speaking' | 'reading' | 'listening' | 'writing';

interface StoreLike {
  setMaterialStatus(
    section: SectionType,
    id: string,
    status: 'draft' | 'published' | 'archived',
    context: PublishGateContext,
  ): Promise<{ ok: true; material: AdminMaterial } | { ok: false; blockers: { message: string }[] }>;
}

/**
 * Publishes a fixture the way an admin does — through the gate.
 *
 * Fixtures used to publish by passing `status: 'published'` to `saveMaterial`,
 * which is exactly the shortcut this phase removed. Taking the store as an
 * argument rather than importing it keeps the import-order rule intact: every
 * suite that touches storage sets its environment and changes directory before
 * it imports `adminStore`, and a helper that imported it here would run first.
 *
 * A refused publish throws with the blockers, so a fixture that is not fit to
 * publish fails loudly instead of quietly staying a draft and making some later
 * assertion look like the bug.
 */
export async function publishMaterial(
  store: StoreLike,
  section: SectionType,
  material: { id: string },
  context: PublishGateContext = { assetExists: () => true },
): Promise<AdminMaterial> {
  const result = await store.setMaterialStatus(section, material.id, 'published', context);
  if (!result.ok) {
    throw new Error(
      `fixture is not publishable: ${result.blockers.map((blocker) => blocker.message).join(' | ')}`,
    );
  }
  return result.material;
}
