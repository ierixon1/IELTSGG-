import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  Calendar,
  ChevronDown,
  Flame,
  Headphones,
  Languages,
  Mic,
  PenLine,
  Sparkles,
  Waves,
} from 'lucide-react';
import { useT } from '../../i18n';
import { Badge, Button, Card, Eyebrow, LanguageSwitcher, Logo, SectionHeading } from '../ui';
import { TESTIMONIALS } from '../../data/landingContent';

interface LandingPageProps {
  onEnterApp: () => void;
}

/**
 * Entrance motion is CSS-only (`.es-enter` on load, `.es-reveal` scroll-linked
 * where supported). Nothing on this page is hidden behind a JavaScript
 * observer, so a blocked script or an unsupported browser costs a fade, never
 * the content itself.
 */
const enterDelay = (index: number): React.CSSProperties => ({
  animationDelay: `${index * 80}ms`,
});

/* --- Header ---------------------------------------------------------------- */

const LandingHeader: React.FC<{ onEnterApp: () => void }> = ({ onEnterApp }) => {
  const t = useT();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const links = [
    { href: '#platform', label: t('landing.nav.platform') },
    { href: '#speaking', label: t('landing.tools.speaking.title') },
    { href: '#how', label: t('landing.howItWorks.eyebrow') },
    { href: '#faq', label: t('landing.nav.faq') },
  ];

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ease-[var(--ease-out-soft)] ${
        scrolled
          ? 'border-b border-ink-100 bg-white/85 backdrop-blur-xl'
          : 'border-b border-transparent'
      }`}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-5 sm:px-8">
        <Logo tone={scrolled ? 'dark' : 'light'} />

        <nav className="hidden items-center gap-1 lg:flex">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={`rounded-[var(--radius-control)] px-3.5 py-2 text-sm font-semibold transition-colors ${
                scrolled
                  ? 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
                  : 'text-white/75 hover:bg-white/10 hover:text-white'
              }`}
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-1.5">
          <LanguageSwitcher tone={scrolled ? 'dark' : 'light'} />
          <Button
            variant={scrolled ? 'primary' : 'inverse'}
            size="sm"
            onClick={onEnterApp}
            id="btn-landing-enter"
          >
            {t('common.startPrep')}
          </Button>
        </div>
      </div>
    </header>
  );
};

/* --- Hero ------------------------------------------------------------------ */

/**
 * An abstract stand-in for the product's own Speaking result card. Built from
 * live markup rather than a screenshot so it stays sharp at any size and never
 * drifts out of date with the real design tokens.
 */
const HeroResultCard: React.FC = () => {
  const t = useT();
  const criteria = [
    { key: 'Fluency & Coherence', band: 7.0, width: '78%' },
    { key: 'Lexical Resource', band: 7.5, width: '84%' },
    { key: 'Grammatical Range', band: 6.5, width: '72%' },
    { key: 'Pronunciation', band: 7.0, width: '78%' },
  ];

  return (
    <div
      className="es-glass es-enter w-full max-w-md rounded-[var(--radius-card)] p-6 shadow-[var(--shadow-lg)]"
      style={enterDelay(4)}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[0.625rem] font-bold uppercase tracking-[0.14em] text-white/50">
            {t('landing.tools.speaking.title')}
          </p>
          <p className="mt-1 text-sm font-semibold text-white/90">IELTS Speaking · Part 2</p>
        </div>
        <div className="text-right">
          <p className="text-[0.625rem] font-bold uppercase tracking-[0.14em] text-white/50">
            {t('common.overall')}
          </p>
          <p className="font-mono text-4xl font-bold leading-none tabular text-white">7.0</p>
        </div>
      </div>

      <div className="mt-6 space-y-3.5">
        {criteria.map((c) => (
          <div key={c.key}>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-white/70">{c.key}</span>
              <span className="font-mono text-xs font-bold tabular text-white">
                {c.band.toFixed(1)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-[var(--radius-pill)] bg-white/12">
              <div
                className="h-full rounded-[var(--radius-pill)] bg-gradient-to-r from-brand-300 to-brand-500"
                style={{ width: c.width }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-3 gap-3 border-t border-white/10 pt-5">
        {[
          { v: '132', l: 'wpm' },
          { v: '4', l: 'pauses' },
          { v: '3', l: 'fillers' },
        ].map((m) => (
          <div key={m.l}>
            <p className="font-mono text-lg font-bold tabular text-white">{m.v}</p>
            <p className="text-[0.625rem] uppercase tracking-[0.1em] text-white/45">{m.l}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

const Hero: React.FC<{ onEnterApp: () => void }> = ({ onEnterApp }) => {
  const t = useT();

  return (
    <section className="es-ink-surface relative overflow-hidden pb-24 pt-32 sm:pb-32 sm:pt-40">
      {/* Faint grid, kept near-invisible so it reads as depth rather than decoration. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)',
          backgroundSize: '72px 72px',
          maskImage: 'radial-gradient(80% 60% at 50% 0%, #000, transparent)',
        }}
      />

      <div className="relative mx-auto grid max-w-7xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-[1.05fr_0.95fr]">
        <div>
          <div className="es-enter" style={enterDelay(0)}>
            <Badge tone="brand" className="bg-white/10 text-brand-100">
              <Sparkles className="h-3 w-3" />
              {t('landing.hero.eyebrow')}
            </Badge>
          </div>

          <h1
            className="es-enter mt-6 text-display-lg text-white sm:text-display-xl lg:text-display-2xl"
            style={enterDelay(1)}
          >
            {t('landing.hero.title')}
          </h1>

          <p
            className="es-enter mt-6 max-w-xl text-lg leading-relaxed text-ink-300"
            style={enterDelay(2)}
          >
            {t('landing.hero.subtitle')}
          </p>

          <div
            className="es-enter mt-9 flex flex-col gap-3 sm:flex-row sm:items-center"
            style={enterDelay(3)}
          >
            <Button size="lg" onClick={onEnterApp} id="btn-hero-start">
              {t('landing.hero.primaryCta')}
              <ArrowRight className="h-5 w-5" />
            </Button>
            <a href="#platform">
              <Button
                size="lg"
                variant="ghost"
                className="text-white/80 hover:bg-white/10 hover:text-white"
              >
                {t('landing.hero.secondaryCta')}
              </Button>
            </a>
          </div>

          <p className="es-enter mt-6 text-sm text-white/45" style={enterDelay(4)}>
            {t('landing.hero.note')}
          </p>
        </div>

        <div className="flex justify-center lg:justify-end">
          <HeroResultCard />
        </div>
      </div>
    </section>
  );
};

/* --- Proof strip ----------------------------------------------------------- */

const ProofStrip: React.FC = () => {
  const t = useT();
  const stats = ['modules', 'questionTypes', 'themes', 'speed'];

  return (
    <section className="border-b border-ink-100 bg-white">
      <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8">
        <p className="es-reveal mb-10 max-w-2xl font-display text-display-sm text-ink-900">
          {t('landing.proof.title')}
        </p>
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          {stats.map((key) => (
            <div key={key} className="es-reveal flex flex-col gap-1">
              <span className="font-display text-display-md tabular text-brand-600">
                {t(`landing.proof.${key}.value`)}
              </span>
              <span className="text-sm leading-snug text-ink-500">
                {t(`landing.proof.${key}.label`)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

/* --- Tools ----------------------------------------------------------------- */

/**
 * Spans are chosen so every row fills the four-column grid exactly: 2+1+1,
 * 2+1+1, 2+2. `soon` marks a tool that is designed but not shipped — the card
 * stays, the badge keeps the claim honest.
 */
const TOOLS = [
  { key: 'plan', icon: Calendar, span: 'lg:col-span-2', soon: false },
  { key: 'mocks', icon: BookOpen, span: '', soon: false },
  { key: 'writing', icon: PenLine, span: '', soon: false },
  { key: 'speaking', icon: Mic, span: 'lg:col-span-2', soon: false },
  { key: 'stats', icon: BarChart3, span: '', soon: false },
  { key: 'arcade', icon: Flame, span: '', soon: false },
  { key: 'preppy', icon: Sparkles, span: 'lg:col-span-2', soon: false },
  { key: 'vocab', icon: Languages, span: 'lg:col-span-2', soon: true },
] as const;

const Tools: React.FC = () => {
  const t = useT();

  return (
    <section id="platform" className="scroll-mt-20 py-24 sm:py-28">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <SectionHeading
          className="es-reveal"
          eyebrow={t('landing.tools.eyebrow')}
          title={t('landing.tools.title')}
          subtitle={t('landing.tools.subtitle')}
        />

        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TOOLS.map((tool) => {
            const Icon = tool.icon;
            return (
              <div key={tool.key} className={`es-reveal ${tool.span}`}>
                <Card interactive className="h-full">
                  <div className="flex items-start justify-between gap-3">
                    <span className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] bg-brand-50 text-brand-600">
                      <Icon className="h-5 w-5" />
                    </span>
                    {tool.soon && <Badge tone="neutral">{t('common.soon')}</Badge>}
                  </div>
                  <h3 className="mt-5 text-lg font-bold text-ink-900">
                    {t(`landing.tools.${tool.key}.title`)}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-500">
                    {t(`landing.tools.${tool.key}.body`)}
                  </p>
                </Card>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

/* --- Speaking spotlight ---------------------------------------------------- */

const SpeakingSpotlight: React.FC<{ onEnterApp: () => void }> = ({ onEnterApp }) => {
  const t = useT();
  const points = ['point1', 'point2', 'point3', 'point4'];

  return (
    <section id="speaking" className="scroll-mt-20 px-5 pb-24 sm:px-8 sm:pb-28">
      <div className="es-ink-surface mx-auto max-w-7xl overflow-hidden rounded-[2rem]">
        <div className="grid items-center gap-12 p-8 sm:p-14 lg:grid-cols-2 lg:p-16">
          <div className="es-reveal">
            <Eyebrow className="text-brand-200">{t('landing.speaking.eyebrow')}</Eyebrow>
            <h2 className="mt-4 text-display-md text-white sm:text-display-lg">
              {t('landing.speaking.title')}
            </h2>
            <p className="mt-5 text-base leading-relaxed text-ink-300">
              {t('landing.speaking.body')}
            </p>

            <ul className="mt-8 space-y-3.5">
              {points.map((p) => (
                <li key={p} className="flex gap-3 text-sm text-white/85">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" />
                  {t(`landing.speaking.${p}`)}
                </li>
              ))}
            </ul>

            <Button size="lg" className="mt-9" onClick={onEnterApp}>
              {t('landing.speaking.cta')}
              <ArrowRight className="h-5 w-5" />
            </Button>
          </div>

          <div className="es-reveal es-glass rounded-[var(--radius-card)] p-6 sm:p-7">
            <div className="flex items-center gap-3 border-b border-white/10 pb-5">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-brand-500">
                <Mic className="h-5 w-5 text-white" />
              </span>
              <div>
                <p className="text-sm font-semibold text-white">Part 2 · Cue card</p>
                <p className="text-xs text-white/50">Describe a skill you would like to learn</p>
              </div>
            </div>

            {/* Waveform stand-in — decorative and deliberately abstract. */}
            <div className="flex h-16 items-end gap-[3px] py-5" aria-hidden>
              {Array.from({ length: 48 }).map((_, i) => (
                <span
                  key={i}
                  className="w-full rounded-full bg-gradient-to-t from-brand-500 to-brand-300"
                  style={{ height: `${25 + Math.abs(Math.sin(i * 0.7)) * 70}%` }}
                />
              ))}
            </div>

            <div className="space-y-3 border-t border-white/10 pt-5 text-sm leading-relaxed text-white/70">
              <p>
                <span className="rounded bg-warning-500/25 px-1 text-white">Um,</span> the skill I'd
                really like to pick up{' '}
                <span className="rounded bg-danger-500/25 px-1 text-white">is</span> sign language,
                because…
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Badge tone="warning" className="bg-warning-500/20 text-warning-50">
                  filler
                </Badge>
                <Badge tone="danger" className="bg-danger-500/20 text-danger-50">
                  grammar
                </Badge>
                <Badge tone="brand" className="bg-white/10 text-brand-100">
                  <Waves className="h-3 w-3" />
                  132 wpm
                </Badge>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

/* --- How it works ---------------------------------------------------------- */

const HowItWorks: React.FC = () => {
  const t = useT();
  const steps = [
    { key: 'step1', icon: Headphones },
    { key: 'step2', icon: Calendar },
    { key: 'step3', icon: BarChart3 },
  ];

  return (
    <section id="how" className="scroll-mt-20 border-y border-ink-100 bg-white py-24 sm:py-28">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <SectionHeading
          className="es-reveal mx-auto"
          eyebrow={t('landing.howItWorks.eyebrow')}
          title={t('landing.howItWorks.title')}
          align="center"
        />

        <div className="mt-14 grid gap-8 sm:grid-cols-3">
          {steps.map((step, i) => {
            const Icon = step.icon;
            return (
              <div
                key={step.key}
                className="es-reveal relative flex flex-col items-center px-4 text-center"
              >
                <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-ink-900 text-white">
                  <Icon className="h-6 w-6" />
                </span>
                <span className="mt-5 font-mono text-xs font-bold tabular text-brand-500">
                  0{i + 1}
                </span>
                <h3 className="mt-2 text-lg font-bold text-ink-900">
                  {t(`landing.howItWorks.${step.key}.title`)}
                </h3>
                <p className="mt-2 max-w-xs text-sm leading-relaxed text-ink-500">
                  {t(`landing.howItWorks.${step.key}.body`)}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

/* --- Testimonials ---------------------------------------------------------- */

/**
 * Renders nothing until real, permissioned reviews exist in
 * `src/data/landingContent.ts` — an empty wall beats a fabricated one.
 */
const Testimonials: React.FC = () => {
  const t = useT();
  if (TESTIMONIALS.length === 0) return null;

  return (
    <section className="py-24 sm:py-28">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <SectionHeading
          className="es-reveal"
          eyebrow={t('landing.testimonials.eyebrow')}
          title={t('landing.testimonials.title')}
        />

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TESTIMONIALS.map((review, i) => (
            <div key={i} className="es-reveal">
              <Card className="h-full">
                <p className="text-sm leading-relaxed text-ink-700">“{review.quote}”</p>
                <div className="mt-5 flex items-center justify-between border-t border-ink-100 pt-4">
                  <div>
                    <p className="text-sm font-bold text-ink-900">{review.name}</p>
                    {review.location && <p className="text-xs text-ink-400">{review.location}</p>}
                  </div>
                  {review.band !== undefined && (
                    <span className="font-mono text-lg font-bold tabular text-brand-600">
                      {review.band.toFixed(1)}
                    </span>
                  )}
                </div>
              </Card>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

/* --- FAQ ------------------------------------------------------------------- */

const Faq: React.FC = () => {
  const t = useT();
  const [open, setOpen] = useState<number | null>(0);
  const items = [1, 2, 3, 4];

  return (
    <section id="faq" className="scroll-mt-20 py-24 sm:py-28">
      <div className="mx-auto max-w-3xl px-5 sm:px-8">
        <SectionHeading
          className="es-reveal mx-auto"
          eyebrow={t('landing.faq.eyebrow')}
          title={t('landing.faq.title')}
          align="center"
        />

        <div className="es-reveal mt-12 divide-y divide-ink-100 overflow-hidden rounded-[var(--radius-card)] border border-ink-100 bg-white">
          {items.map((n, i) => {
            const isOpen = open === i;
            return (
              <div key={n}>
                <button
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left transition-colors hover:bg-ink-50"
                  aria-expanded={isOpen}
                >
                  <span className="text-base font-bold text-ink-900">{t(`landing.faq.q${n}`)}</span>
                  <ChevronDown
                    className={`h-5 w-5 shrink-0 text-ink-400 transition-transform duration-300 ${
                      isOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>
                <div
                  className="grid transition-[grid-template-rows] duration-300 ease-[var(--ease-out-soft)]"
                  style={{ gridTemplateRows: isOpen ? '1fr' : '0fr' }}
                >
                  <div className="overflow-hidden">
                    <p className="px-6 pb-5 text-sm leading-relaxed text-ink-500">
                      {t(`landing.faq.a${n}`)}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

/* --- Final CTA + footer ---------------------------------------------------- */

const FinalCta: React.FC<{ onEnterApp: () => void }> = ({ onEnterApp }) => {
  const t = useT();

  return (
    <section className="px-5 pb-24 sm:px-8">
      <div className="es-reveal es-ink-surface mx-auto max-w-7xl rounded-[2rem] px-8 py-16 text-center sm:px-14 sm:py-20">
        <h2 className="mx-auto max-w-2xl text-display-md text-white sm:text-display-lg">
          {t('landing.finalCta.title')}
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-ink-300">
          {t('landing.finalCta.body')}
        </p>
        <Button size="lg" className="mt-9" onClick={onEnterApp} id="btn-final-cta">
          {t('landing.finalCta.cta')}
          <ArrowRight className="h-5 w-5" />
        </Button>
      </div>
    </section>
  );
};

const LandingFooter: React.FC = () => {
  const t = useT();

  return (
    <footer className="border-t border-ink-100 bg-white">
      <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-center sm:justify-between">
          <Logo />
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-ink-500">
            <a href="#platform" className="hover:text-ink-900">
              {t('landing.nav.platform')}
            </a>
            <a href="#faq" className="hover:text-ink-900">
              {t('landing.nav.faq')}
            </a>
          </div>
        </div>

        <p className="mt-10 max-w-4xl text-xs leading-relaxed text-ink-400">
          {t('landing.footer.disclaimer')}
        </p>
        <p className="mt-4 text-xs text-ink-400">
          © {new Date().getFullYear()} Ever Study. {t('landing.footer.rights')}
        </p>
      </div>
    </footer>
  );
};

/* --- Page ------------------------------------------------------------------ */

export const LandingPage: React.FC<LandingPageProps> = ({ onEnterApp }) => (
  <div className="min-h-screen bg-canvas">
    <LandingHeader onEnterApp={onEnterApp} />
    <main>
      <Hero onEnterApp={onEnterApp} />
      <ProofStrip />
      <Tools />
      <SpeakingSpotlight onEnterApp={onEnterApp} />
      <HowItWorks />
      <Testimonials />
      <Faq />
      <FinalCta onEnterApp={onEnterApp} />
    </main>
    <LandingFooter />
  </div>
);
