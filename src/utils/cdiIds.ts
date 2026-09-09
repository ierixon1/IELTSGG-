/**
 * Namespacing for `id` attributes that arrive inside imported CDI markup.
 *
 * Both sanitisers — `sanitizeHtmlServer` on the way in and DOMPurify on the way
 * to the DOM — apply this. Without it, a CDI page carrying `id="root"` or
 * `id="btn-recalculate-plan"` shadows the app's own elements: those ids exist
 * in `index.html` and `PlanView`, and `document.getElementById` plus `window`
 * named access would resolve to the injected node instead. Namespacing also
 * removes the duplicate-id problem when two imported materials render together.
 *
 * Lives in its own module so the browser bundle does not have to import the
 * Express admin router to get at it.
 */
export const CDI_ID_PREFIX = 'cdi-id-';

export function namespaceCdiId(value: string): string {
  const clean = String(value)
    .trim()
    // Keep only characters that are legal and unambiguous in a fragment.
    .replace(/[^A-Za-z0-9_:.-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return clean ? CDI_ID_PREFIX + clean : '';
}
