/**
 * Where a stored asset is read from.
 *
 * Assets are addressed by id, never by a path baked into content: the learner
 * route checks that a *published* material actually references the asset before
 * serving it, and the admin route checks for an admin session. Building the URL
 * in one place is what keeps a component from hardcoding either.
 */

/** The URL a signed-in learner reads an asset from. */
export function learnerAssetUrl(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}`;
}

/** The URL an administrator previews an asset from. */
export function adminAssetUrl(assetId: string): string {
  return `/api/admin/assets/${encodeURIComponent(assetId)}`;
}
