import { closest, elementText, findElements, rangeOf } from '../normalize';
import type { ChildNode, Element } from '../normalize';
import { headerFor } from './shared';
import type { QuestionSite } from './shared';
import type { DetectedAsset, ImportDiagnostic } from '../types';
import type { Question } from '../../../types';

/**
 * Diagram, plan and map labelling.
 *
 * These are gap fills whose prompt is meaningless without the picture — "the
 * library is at 12." tells a learner nothing on its own. The type therefore
 * survives as `map_label` or `diagram_label` rather than collapsing into a
 * generic gap, and the parser records which image the question depends on.
 *
 * The image is *not* resolved to a URL here. It is reported as a detected
 * asset, and the review step attaches a stored asset id — the question then
 * carries `mediaRef`, which is what the learner engine renders from. A path
 * copied out of someone's export is not a source of truth.
 */

/** The nearest image above or inside the region a labelling group occupies. */
export function imageForGroup(
  site: QuestionSite,
  root: ChildNode[],
  assets: DetectedAsset[],
): { asset: DetectedAsset; element: Element } | null {
  const images = findElements(root, (element) => element.name === 'img');
  if (images.length === 0) return null;

  const at = site.container.startIndex ?? 0;
  // The label refers to the picture printed above it, so the nearest image that
  // precedes the question wins; failing that, the nearest one at all.
  const before = images.filter((image) => (image.startIndex ?? 0) <= at);
  const chosen = before.length > 0 ? before[before.length - 1] : images[0];

  const src = String(chosen.attribs.src || '').trim();
  const asset = assets.find((candidate) => candidate.originalSrc === src);
  return asset ? { asset, element: chosen } : null;
}

/**
 * Builds the `mediaRef` for a labelling question, when the asset is one that
 * can actually be stored.
 *
 * An external URL is never turned into a `mediaRef`: it would render as a
 * blocked image for the learner and pretend the question was complete.
 */
export function mediaRefFor(
  asset: DetectedAsset | undefined,
  altText: string | undefined,
): { mediaRef?: Question['mediaRef']; diagnostics: ImportDiagnostic[] } {
  const diagnostics: ImportDiagnostic[] = [];
  if (!asset) return { diagnostics };

  if (!asset.assetId) {
    diagnostics.push({
      code: asset.origin === 'external' ? 'asset_external' : 'asset_missing',
      message:
        asset.origin === 'external'
          ? `The image for this question is an external URL (${asset.originalSrc}) and was not imported. Attach the file to complete the question.`
          : `The image for this question (${asset.originalSrc}) is not contained in the page. Attach the file to complete the question.`,
      sourceRange: asset.sourceRange,
    });
    return { diagnostics };
  }

  return {
    mediaRef: { assetId: asset.assetId, kind: asset.kind, alt: altText },
    diagnostics,
  };
}

/** True when the rubric for this site describes a labelling task. */
export function isLabellingSite(
  site: QuestionSite,
  headers: Parameters<typeof headerFor>[0],
): 'map_label' | 'diagram_label' | null {
  const header = headerFor(headers, site.number);
  const type = header?.inferredType;
  return type === 'map_label' || type === 'diagram_label' ? type : null;
}

/** The alt text of the picture a labelling group refers to. */
export function captionFor(element: Element, source: string): { alt?: string; range: ReturnType<typeof rangeOf> } {
  const figure = closest(element, (parent) => parent.name === 'figure');
  const caption = figure
    ? findElements([figure], (child) => child.name === 'figcaption')[0]
    : undefined;
  const alt = String(element.attribs.alt || '') || (caption ? elementText(caption) : '');
  return { alt: alt || undefined, range: rangeOf(element, source) };
}
