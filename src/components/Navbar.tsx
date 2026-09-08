import React, { useEffect, useRef, useState } from 'react';
import {
  BarChart3,
  BookOpen,
  Calendar,
  ChevronDown,
  Clock,
  Flame,
  LogOut,
  Settings2,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { UserProfile } from '../types';
import { useT } from '../i18n';
import { Button, LanguageSwitcher, Logo, cx } from './ui';

export type NavTab = 'plan' | 'mocks' | 'exam' | 'stats' | 'arcade' | 'admin';

interface NavbarProps {
  activeTab: NavTab;
  setActiveTab: (tab: NavTab) => void;
  profile: UserProfile;
  onOpenOnboarding: () => void;
  onOpenPreppy: () => void;
  onGoHome?: () => void;
  onSignOut?: () => void;
  isAdminAuthenticated?: boolean;
}

/**
 * Primary product navigation.
 *
 * Only learner-facing destinations live in the tab strip; the admin CMS is an
 * operator tool and sits inside the account menu, where it does not compete for
 * a learner's attention.
 */
export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  profile,
  onOpenOnboarding,
  onOpenPreppy,
  onGoHome,
  onSignOut,
  isAdminAuthenticated,
}) => {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const tabs: Array<{ id: NavTab; label: string; icon: React.ElementType }> = [
    { id: 'plan', label: t('nav.planLong'), icon: Calendar },
    { id: 'mocks', label: t('nav.mocksLong'), icon: BookOpen },
    { id: 'exam', label: t('nav.exam'), icon: Clock },
    { id: 'arcade', label: t('nav.arcade'), icon: Flame },
    { id: 'stats', label: t('nav.stats'), icon: BarChart3 },
  ];

  const tabClasses = (isActive: boolean) =>
    cx(
      'flex items-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] px-3.5 py-2',
      'text-sm font-semibold transition-colors duration-200',
      isActive ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-900',
    );

  return (
    <header className="sticky top-0 z-40 border-b border-ink-100 bg-white/90 backdrop-blur-xl">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between gap-3">
          <button
            onClick={onGoHome}
            className="shrink-0 transition-opacity hover:opacity-80"
            aria-label="Ever Study"
          >
            <Logo compact />
          </button>

          <nav className="hidden items-center gap-1 lg:flex">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  id={`nav-tab-${tab.id}`}
                  onClick={() => setActiveTab(tab.id)}
                  className={tabClasses(activeTab === tab.id)}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </button>
              );
            })}
          </nav>

          <div className="flex items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              id="btn-open-preppy"
              onClick={onOpenPreppy}
              className="hidden sm:inline-flex"
            >
              <Sparkles className="h-4 w-4 text-brand-500" />
              {t('nav.preppy')}
            </Button>

            <LanguageSwitcher />

            {/* Account menu — target band, settings and operator tools. */}
            <div ref={menuRef} className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="flex items-center gap-2 rounded-[var(--radius-control)] border border-ink-200 py-1.5 pl-2.5 pr-2 transition-colors hover:border-ink-300 hover:bg-ink-50"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <span className="hidden text-left sm:block">
                  <span className="block text-[0.625rem] font-bold uppercase tracking-[0.1em] text-ink-400">
                    {t('common.target')}
                  </span>
                  <span className="block font-mono text-xs font-bold tabular text-ink-900">
                    {profile.targetBand.toFixed(1)}
                  </span>
                </span>
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-500 font-mono text-[0.6875rem] font-bold text-white tabular">
                  {profile.targetBand.toFixed(1)}
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-ink-400" />
              </button>

              {menuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-[var(--radius-control)] border border-ink-100 bg-white p-1 shadow-[var(--shadow-lg)]"
                >
                  <button
                    onClick={() => {
                      onOpenOnboarding();
                      setMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-50"
                  >
                    <Settings2 className="h-4 w-4 text-ink-400" />
                    {t('nav.targetBand')}
                  </button>

                  <button
                    onClick={() => {
                      onOpenPreppy();
                      setMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-50 sm:hidden"
                  >
                    <Sparkles className="h-4 w-4 text-brand-500" />
                    {t('nav.preppy')}
                  </button>

                  <div className="my-1 h-px bg-ink-100" />

                  <button
                    id="btn-open-admin-cms"
                    onClick={() => {
                      setActiveTab('admin');
                      setMenuOpen(false);
                    }}
                    className={cx(
                      'flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                      activeTab === 'admin'
                        ? 'bg-brand-50 text-brand-700'
                        : 'text-ink-600 hover:bg-ink-50',
                    )}
                  >
                    <ShieldCheck
                      className={cx(
                        'h-4 w-4',
                        isAdminAuthenticated ? 'text-success-500' : 'text-ink-400',
                      )}
                    />
                    {t('nav.admin')}
                  </button>

                  {onSignOut && (
                    <button
                      onClick={() => {
                        onSignOut();
                        setMenuOpen(false);
                      }}
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-50"
                    >
                      <LogOut className="h-4 w-4 text-ink-400" />
                      {t('auth.signOut')}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Compact tab strip for tablet and phone. */}
        <div className="es-scroll -mx-1 flex gap-1 overflow-x-auto pb-2 lg:hidden">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cx(tabClasses(activeTab === tab.id), 'shrink-0 text-[0.8125rem]')}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>
    </header>
  );
};
