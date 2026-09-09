import type { AssetKind } from '../services/fileTypeSniffer';

export type { AssetKind };

/**
 * `staged` — uploaded, not yet referenced by a saved material. The reaper
 * removes staged assets that stay unreferenced.
 * `active` — referenced by at least one material.
 */
export type AssetState = 'staged' | 'active';

export type AssetSourceType = 'upload' | 'paste' | 'derived';

/**
 * One stored file.
 *
 * Materials reference assets by id rather than copying their content, which is
 * what makes it possible to answer "which materials use this file", to delete a
 * material without orphaning its audio, and — for imported HTML — to keep the
 * original bytes so a better parser can be run over them later.
 */
export interface Asset {
  id: string;
  originalName: string;
  /** Where the bytes live: a filename locally, an object key in the cloud. */
  storagePath: string;
  /** Sniffed from the bytes, never taken from the request. */
  mimeType: string;
  size: number;
  sha256: string;
  kind: AssetKind;
  state: AssetState;
  createdAt: string;
  createdBy: string;
  sourceType: AssetSourceType;
  /**
   * For an asset produced from another one — sanitised HTML derived from an
   * uploaded original, say. The original is never served to a browser.
   */
  derivedFromAssetId?: string;
}

/** What the upload endpoint hands back to the editor. */
export interface UploadedAssetSummary {
  assetId: string;
  originalName: string;
  size: number;
  mimeType: string;
  kind: AssetKind;
  /** Admin-only URL for previewing the asset. */
  url: string;
  /** Sanitised markup, for an HTML upload. */
  extractedHtml?: string;
  /** Plain text pulled out of a document, for prefilling an editor. */
  extractedText?: string;
  /** The asset holding the untouched original, when one was kept. */
  sourceAssetId?: string;
  /**
   * Set when the file stored fine but its text could not be read. Surfaced so
   * an empty passage is never presented as a successful extraction.
   */
  extractionError?: string;
}
