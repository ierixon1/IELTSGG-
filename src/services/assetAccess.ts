import type { Question } from '../types';
import type { AdminMaterial } from '../types/admin';
import type { Asset } from '../types/asset';
import { adminStore } from './adminStore';
import { assetStore, isAssetId } from './assetStore';
import { sourceStore } from './sourceStore';
import { toLearnerMaterial } from './sittingView';

/**
 * Who may read which stored file (H3).
 *
 * Files are addressed by id, and an id is not a secret: it shows up in admin
 * screens, logs and links people share. A request naming an id therefore proves
 * nothing, and every route that serves a file asks this module rather than
 * deciding for itself.
 *
 * What a file *is* comes from the records that name it — never from its name,
 * its id, or the route it was uploaded through:
 *
 *   - an original: named as `sourceAssetId` by a material or by its import
 *     record — the untouched imported page, printed answer key and all;
 *   - a source-library file: named by an ingested source as its original or its
 *     extracted text — a whole licensed book;
 *   - learner media: rendered to learners by a published material — its
 *     Listening audio, a question's image or audio, an image or audio URL in
 *     what it shows.
 *
 * Anything else — a staged upload, the sanitised copy of an import, a file only
 * listed in a material's `assetIds` bookkeeping — is private.
 *
 *   learner  → learner media only; never an original or a source-library file,
 *              even where some content points at one; and only audio or an image
 *              (the kind sniffed from the bytes when it was stored). Every
 *              refusal looks exactly like an id that does not exist.
 *   examiner → any material's files, originals included; not the source
 *              library, which belongs to administrators (as `/api/admin/sources`).
 *   admin    → every file.
 */

export type AssetViewer = 'learner' | 'examiner' | 'admin';

export interface AssetRoles {
  original: boolean;
  sourceLibrary: boolean;
  learnerMedia: boolean;
}

export type AssetAccess = { allowed: true; asset: Asset } | { allowed: false };

/** What a learner's page renders from a file: an `<audio>` or an `<img>`. HTML and documents never. */
const LEARNER_KINDS: ReadonlySet<Asset['kind']> = new Set<Asset['kind']>(['audio', 'image']);
const LEARNER_ASSET_URL = /\/api\/assets\/(ast_[A-Za-z0-9_-]{10,32})/g;

function learnerUrlsIn(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(LEARNER_ASSET_URL)) into.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const entry of value) learnerUrlsIn(entry, into);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) learnerUrlsIn(entry, into);
  }
}

function questionMedia(questions: Question[], into: Set<string>): void {
  for (const question of questions) {
    if (question.mediaRef && isAssetId(question.mediaRef.assetId)) into.add(question.mediaRef.assetId);
  }
}

/**
 * The files a learner view of a material renders: the fields that hold its
 * media, and the learner asset URLs in what it shows. Bookkeeping lists and
 * provenance are not rendered, so nothing is taken from them.
 */
export function learnerMediaReferences(view: AdminMaterial): Set<string> {
  const ids = new Set<string>();
  if (view.section === 'listening') {
    if (view.content.audioAssetId && isAssetId(view.content.audioAssetId)) ids.add(view.content.audioAssetId);
    questionMedia(view.content.section.questions, ids);
  } else if (view.section === 'reading') {
    questionMedia(view.content.passage.questions, ids);
  }
  learnerUrlsIn(view.content, ids);
  return ids;
}

/** Every role the stored records give one file. */
export async function assetRoles(assetId: string): Promise<AssetRoles> {
  const roles: AssetRoles = { original: false, sourceLibrary: false, learnerMedia: false };
  if (!isAssetId(assetId)) return roles;

  const sections = ['reading', 'listening', 'writing', 'speaking'] as const;
  const materials = (await Promise.all(sections.map((section) => adminStore.listMaterials(section)))).flat();
  for (const material of materials) {
    const content = material.content as { sourceAssetId?: unknown; importRecord?: { sourceAssetId?: unknown } };
    if (content.sourceAssetId === assetId || content.importRecord?.sourceAssetId === assetId) roles.original = true;
    if (material.status === 'published' && learnerMediaReferences(toLearnerMaterial(material, { keepTranscript: true })).has(assetId)) {
      roles.learnerMedia = true;
    }
  }
  roles.sourceLibrary = (await sourceStore.list()).some(
    (source) => source.sourceAssetId === assetId || source.extractedTextAssetId === assetId,
  );
  return roles;
}

/** Whether `viewer` may read the file `assetId` names, and the file when it may. */
export async function authorizeAssetRead(viewer: AssetViewer, assetId: string): Promise<AssetAccess> {
  // Read together, so a refusal takes as long whether or not the file exists.
  const [asset, roles] = await Promise.all([assetStore.get(assetId), viewer === 'admin' ? null : assetRoles(assetId)]);
  if (!asset) return { allowed: false };
  if (viewer === 'admin') return { allowed: true, asset };
  if (!roles) return { allowed: false };
  if (viewer === 'examiner') return roles.sourceLibrary ? { allowed: false } : { allowed: true, asset };
  const allowed = roles.learnerMedia && !roles.original && !roles.sourceLibrary && LEARNER_KINDS.has(asset.kind);
  return allowed ? { allowed: true, asset } : { allowed: false };
}

/** The stored files a member of staff may list: all of them for an administrator; not the source library for an examiner. */
export async function listAssetsFor(viewer: Exclude<AssetViewer, 'learner'>): Promise<Asset[]> {
  const assets = await assetStore.list();
  if (viewer === 'admin') return assets;
  const library = new Set<string>();
  for (const source of await sourceStore.list()) {
    library.add(source.sourceAssetId);
    if (source.extractedTextAssetId) library.add(source.extractedTextAssetId);
  }
  return assets.filter((asset) => !library.has(asset.id));
}
