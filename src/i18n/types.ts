/**
 * Supported interface languages.
 *
 * `en` is the source of truth: every other dictionary is allowed to be
 * partial, and any missing key transparently falls back to English so a
 * half-translated screen never renders a raw key to a learner.
 */
export const LOCALES = ['en', 'ru', 'uz'] as const;

export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, { short: string; full: string }> = {
  en: { short: 'EN', full: 'English' },
  ru: { short: 'RU', full: 'Русский' },
  uz: { short: 'UZ', full: "O‘zbekcha" },
};

/** A dictionary is an arbitrarily nested tree of strings. */
export interface Dictionary {
  [key: string]: string | Dictionary;
}
