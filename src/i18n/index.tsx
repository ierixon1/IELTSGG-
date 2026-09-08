import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Dictionary, Locale, LOCALES, LOCALE_LABELS } from './types';
import { en } from './locales/en';
import { ru } from './locales/ru';
import { uz } from './locales/uz';

export type { Locale };
export { LOCALES, LOCALE_LABELS };

const DICTIONARIES: Record<Locale, Dictionary> = { en, ru, uz };

const STORAGE_KEY = 'ever_study_locale';

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Reads a dotted path out of a nested dictionary. */
function lookup(dict: Dictionary, path: string): string | undefined {
  const value = path.split('.').reduce<string | Dictionary | undefined>((node, segment) => {
    if (node && typeof node === 'object') return node[segment];
    return undefined;
  }, dict);

  return typeof value === 'string' ? value : undefined;
}

/** Replaces `{name}` placeholders with the supplied values. */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    key in vars ? String(vars[key]) : match,
  );
}

/**
 * Detects a sensible starting language: an explicit past choice wins, then the
 * browser's preference, then English.
 */
function detectLocale(): Locale {
  if (typeof window === 'undefined') return 'en';

  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    /* Private mode or blocked storage — fall through to browser detection. */
  }

  const browser = (window.navigator.language || 'en').slice(0, 2).toLowerCase();
  return isLocale(browser) ? browser : 'en';
}

/**
 * A key missing from every dictionary is a bug worth seeing, but a render loop
 * would flood the console — so each key is reported at most once.
 */
const reportedMissingKeys = new Set<string>();

function warnOnceAboutMissingKey(key: string): void {
  if (reportedMissingKeys.has(key)) return;
  reportedMissingKeys.add(key);
  console.warn(`[i18n] missing key: ${key}`);
}

export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TranslateFn;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale());

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      /* Persisting the choice is a convenience, never a requirement. */
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    if (isLocale(next)) setLocaleState(next);
  }, []);

  const t = useCallback<TranslateFn>(
    (key, vars) => {
      const translated = lookup(DICTIONARIES[locale], key) ?? lookup(en, key);

      if (translated === undefined) {
        // Surfacing the key beats rendering an empty gap while translating.
        warnOnceAboutMissingKey(key);
        return key;
      }

      return interpolate(translated, vars);
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

/** Convenience hook for the common case of only needing the translate fn. */
export function useT(): TranslateFn {
  return useI18n().t;
}
