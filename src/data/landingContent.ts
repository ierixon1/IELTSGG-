/**
 * Real, attributable landing-page content.
 *
 * IMPORTANT: everything in this file is published to the public marketing page,
 * so it must describe things that actually happened. Do not seed it with
 * invented reviews, invented score gains or invented user counts — the
 * testimonial section simply hides itself while the list is empty, which is the
 * honest state of a platform that has not collected reviews yet.
 *
 * To publish a review, add an entry below with the learner's permission.
 */
export interface Testimonial {
  /** Learner's name or initials, as they agreed to be credited. */
  name: string;
  /** City / country, optional. */
  location?: string;
  /** Verified official band, if they shared their result. Omit if unverified. */
  band?: number;
  /** The review itself, in the language it was given. */
  quote: string;
}

export const TESTIMONIALS: Testimonial[] = [];

/**
 * Product facts shown in the proof strip. These are derived from what the
 * platform actually ships (see `src/config/ieltsTaxonomy.ts`), not from
 * marketing targets.
 */
export const PROOF_STATS = ['modules', 'questionTypes', 'themes', 'speed'] as const;
