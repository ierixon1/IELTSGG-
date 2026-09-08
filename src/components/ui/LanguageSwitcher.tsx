import React, { useEffect, useRef, useState } from 'react';
import { Check, Globe } from 'lucide-react';
import { LOCALE_LABELS, LOCALES, useI18n } from '../../i18n';

interface LanguageSwitcherProps {
  /** `light` is for the ink surfaces (landing header over dark hero). */
  tone?: 'dark' | 'light';
  className?: string;
}

export const LanguageSwitcher: React.FC<LanguageSwitcherProps> = ({
  tone = 'dark',
  className = '',
}) => {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click and on Escape — a menu that traps the user is worse
  // than no menu at all.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const triggerTone =
    tone === 'light'
      ? 'text-white/80 hover:text-white hover:bg-white/10'
      : 'text-ink-500 hover:text-ink-900 hover:bg-ink-100';

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 text-xs font-bold transition-colors ${triggerTone}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('common.language')}
      >
        <Globe className="h-4 w-4" />
        {LOCALE_LABELS[locale].short}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-44 overflow-hidden rounded-[var(--radius-control)] border border-ink-100 bg-white p-1 shadow-[var(--shadow-lg)]"
        >
          {LOCALES.map((code) => (
            <button
              key={code}
              role="menuitemradio"
              aria-checked={code === locale}
              onClick={() => {
                setLocale(code);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                code === locale ? 'bg-brand-50 text-brand-700' : 'text-ink-600 hover:bg-ink-50'
              }`}
            >
              {LOCALE_LABELS[code].full}
              {code === locale && <Check className="h-4 w-4" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
