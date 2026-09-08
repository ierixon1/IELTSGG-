import React from 'react';

/* ===========================================================================
   EVER STUDY UI PRIMITIVES
   Every screen composes these instead of re-inventing padding, radius and
   colour. If a screen needs a variant that is not here, add it here.
   =========================================================================== */

export { Logo, LogoMark } from './Logo';
export { LanguageSwitcher } from './LanguageSwitcher';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* --- Button --------------------------------------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'inverse';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-500 text-white shadow-[var(--shadow-brand)] hover:bg-brand-600 active:bg-brand-700 disabled:bg-ink-200 disabled:text-ink-400 disabled:shadow-none',
  secondary:
    'bg-white text-ink-800 border border-ink-200 hover:border-ink-300 hover:bg-ink-50 disabled:text-ink-300',
  ghost: 'text-ink-600 hover:text-ink-900 hover:bg-ink-100 disabled:text-ink-300',
  danger: 'bg-danger-500 text-white hover:bg-danger-700 disabled:bg-ink-200',
  inverse: 'bg-white text-ink-900 hover:bg-ink-100 disabled:bg-white/40',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 px-3.5 text-[0.8125rem] gap-1.5 rounded-[var(--radius-control)]',
  md: 'h-11 px-5 text-sm gap-2 rounded-[var(--radius-control)]',
  lg: 'h-14 px-7 text-base gap-2.5 rounded-[var(--radius-control)]',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  fullWidth,
  className,
  children,
  ...rest
}) => (
  <button
    className={cx(
      'inline-flex items-center justify-center font-semibold whitespace-nowrap',
      'transition-all duration-200 ease-[var(--ease-out-soft)]',
      'disabled:cursor-not-allowed active:scale-[0.98]',
      BUTTON_VARIANTS[variant],
      BUTTON_SIZES[size],
      fullWidth && 'w-full',
      className,
    )}
    {...rest}
  >
    {children}
  </button>
);

/* --- Card ----------------------------------------------------------------- */

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  padded?: boolean;
}

export const Card: React.FC<CardProps> = ({
  interactive,
  padded = true,
  className,
  children,
  ...rest
}) => (
  <div
    className={cx('es-card', interactive && 'es-card-interactive', padded && 'p-6', className)}
    {...rest}
  >
    {children}
  </div>
);

/* --- Badge ---------------------------------------------------------------- */

export type BadgeTone =
  | 'neutral'
  | 'brand'
  | 'success'
  | 'warning'
  | 'danger'
  | 'listening'
  | 'reading'
  | 'writing'
  | 'speaking';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-ink-100 text-ink-600',
  brand: 'bg-brand-50 text-brand-700',
  success: 'bg-success-50 text-success-700',
  warning: 'bg-warning-50 text-warning-700',
  danger: 'bg-danger-50 text-danger-700',
  listening: 'bg-listening-tint text-listening-ink',
  reading: 'bg-reading-tint text-reading-ink',
  writing: 'bg-writing-tint text-writing-ink',
  speaking: 'bg-speaking-tint text-speaking-ink',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export const Badge: React.FC<BadgeProps> = ({ tone = 'neutral', className, children, ...rest }) => (
  <span
    className={cx(
      'inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] px-2.5 py-1',
      'text-[0.6875rem] font-bold uppercase tracking-[0.08em]',
      BADGE_TONES[tone],
      className,
    )}
    {...rest}
  >
    {children}
  </span>
);

/* --- Section heading ------------------------------------------------------ */

export const Eyebrow: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className,
}) => <p className={cx('es-eyebrow', className)}>{children}</p>;

export interface SectionHeadingProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  align?: 'left' | 'center';
  tone?: 'dark' | 'light';
  className?: string;
}

export const SectionHeading: React.FC<SectionHeadingProps> = ({
  eyebrow,
  title,
  subtitle,
  align = 'left',
  tone = 'dark',
  className,
}) => (
  <div
    className={cx(
      'flex flex-col gap-3',
      align === 'center' && 'items-center text-center',
      className,
    )}
  >
    {eyebrow && (
      <Eyebrow className={tone === 'light' ? 'text-brand-200' : undefined}>{eyebrow}</Eyebrow>
    )}
    <h2
      className={cx(
        'text-display-md sm:text-display-lg max-w-3xl',
        tone === 'light' ? 'text-white' : 'text-ink-900',
      )}
    >
      {title}
    </h2>
    {subtitle && (
      <p
        className={cx(
          'max-w-2xl text-base leading-relaxed',
          tone === 'light' ? 'text-ink-300' : 'text-ink-500',
        )}
      >
        {subtitle}
      </p>
    )}
  </div>
);

/* --- Band score ----------------------------------------------------------- */

export interface BandScoreProps {
  value: number;
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  tone?: 'dark' | 'light';
  className?: string;
}

/**
 * Band scores are data, not prose: monospaced, tabular, always one decimal so
 * columns of scores line up wherever they appear.
 */
export const BandScore: React.FC<BandScoreProps> = ({
  value,
  label,
  size = 'md',
  tone = 'dark',
  className,
}) => {
  const sizes = {
    sm: 'text-xl',
    md: 'text-3xl',
    lg: 'text-display-lg',
  } as const;

  return (
    <div className={cx('flex flex-col gap-0.5', className)}>
      {label && (
        <span
          className={cx(
            'text-[0.625rem] font-bold uppercase tracking-[0.12em]',
            tone === 'light' ? 'text-white/50' : 'text-ink-400',
          )}
        >
          {label}
        </span>
      )}
      <span
        className={cx(
          'font-mono font-bold tabular leading-none',
          sizes[size],
          tone === 'light' ? 'text-white' : 'text-ink-900',
        )}
      >
        {value.toFixed(1)}
      </span>
    </div>
  );
};

/* --- Progress bar --------------------------------------------------------- */

export interface ProgressProps {
  /** 0–1. */
  value: number;
  tone?: 'dark' | 'light';
  className?: string;
}

export const Progress: React.FC<ProgressProps> = ({ value, tone = 'dark', className }) => {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className={cx(
        'h-2 w-full overflow-hidden rounded-[var(--radius-pill)]',
        tone === 'light' ? 'bg-white/15' : 'bg-ink-100',
        className,
      )}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-[var(--radius-pill)] bg-brand-500 transition-[width] duration-500 ease-[var(--ease-out-soft)]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
};

/* --- Stat ----------------------------------------------------------------- */

export const Stat: React.FC<{
  value: string;
  label: string;
  tone?: 'dark' | 'light';
}> = ({ value, label, tone = 'dark' }) => (
  <div className="flex flex-col gap-1">
    <span
      className={cx(
        'font-display text-display-md tabular',
        tone === 'light' ? 'text-white' : 'text-ink-900',
      )}
    >
      {value}
    </span>
    <span className={cx('text-sm', tone === 'light' ? 'text-ink-300' : 'text-ink-500')}>
      {label}
    </span>
  </div>
);
