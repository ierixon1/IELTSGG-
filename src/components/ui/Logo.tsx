import React from 'react';

interface LogoProps {
  /** `dark` renders for light backgrounds, `light` for the ink surfaces. */
  tone?: 'dark' | 'light';
  showWordmark?: boolean;
  className?: string;
}

/**
 * The Ever Study mark: a rising arc inside a rounded token — progress, drawn
 * once so it stays identical in the navbar, the landing hero and the favicon.
 */
export const LogoMark: React.FC<{ className?: string }> = ({ className = 'w-9 h-9' }) => (
  <svg viewBox="0 0 40 40" fill="none" className={className} aria-hidden="true">
    <defs>
      <linearGradient id="es-logo-grad" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
        <stop stopColor="#8B6DFF" />
        <stop offset="1" stopColor="#4A27CC" />
      </linearGradient>
    </defs>
    <rect width="40" height="40" rx="12" fill="url(#es-logo-grad)" />
    <path
      d="M11 26.5C13.8 18.8 18.2 14.5 24.5 13"
      stroke="white"
      strokeWidth="3.2"
      strokeLinecap="round"
    />
    <path
      d="M20.4 12.2L25.6 12.4L25.2 17.6"
      stroke="white"
      strokeWidth="3.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="11" cy="26.5" r="2.6" fill="white" />
  </svg>
);

export const Logo: React.FC<LogoProps> = ({ tone = 'dark', showWordmark = true, className = '' }) => (
  <span className={`inline-flex items-center gap-2.5 ${className}`}>
    <LogoMark />
    {showWordmark && (
      <span
        className={`font-display text-[1.35rem] font-extrabold tracking-[-0.03em] ${
          tone === 'light' ? 'text-white' : 'text-ink-900'
        }`}
      >
        Ever Study
      </span>
    )}
  </span>
);
