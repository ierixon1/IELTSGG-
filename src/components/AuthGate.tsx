import React, { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useT } from '../i18n';
import { Button, LanguageSwitcher, Logo } from './ui';

export type AuthUser = {
  id: string;
  email: string;
  username: string;
  name: string;
  role: string;
};

interface AuthGateProps {
  onAuthenticated: (user: AuthUser) => void;
  /** Lets a signed-out visitor step back to the public marketing page. */
  onBack?: () => void;
}

/** Mirrors the server rule in `authService.register`. */
const USERNAME_PATTERN = /^[a-z0-9_.-]{3,32}$/;

/**
 * Sign-in and registration for learners.
 *
 * The session itself is a server-set cookie; the copy of the user kept in
 * localStorage is only a UI hint, so a stale or forged entry cannot grant
 * access to anyone else's data.
 */
export function AuthGate({ onAuthenticated, onBack }: AuthGateProps) {
  const t = useT();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    if (isRegister && !USERNAME_PATTERN.test(username.trim().toLowerCase())) {
      setError(t('auth.errors.invalid_username'));
      return;
    }

    setBusy(true);
    setError('');

    try {
      const endpoint = isRegister ? '/api/auth/register' : '/api/auth/login';
      const body = isRegister ? { username, email, password, name } : { username, password };

      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.user) {
        // The server returns a coarse code rather than a sentence, so the
        // message a person reads is translated here.
        const code =
          response.status === 429 ? 'rate_limited' : (data.code as string) || 'unknown';
        throw new Error(isRegister ? t(`auth.errors.${code}`) : t('auth.failed'));
      }

      localStorage.setItem('prep_auth_user', JSON.stringify(data.user));
      onAuthenticated(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.failed'));
    } finally {
      setBusy(false);
    }
  }

  const fieldClass =
    'w-full rounded-[var(--radius-control)] border border-ink-200 bg-white px-4 py-3 text-sm text-ink-900 outline-none transition-colors focus:border-brand-400';

  return (
    <div className="es-ink-surface flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <Logo tone="light" compact />
        <div className="flex items-center gap-2">
          <LanguageSwitcher tone="light" />
          {onBack && (
            <Button variant="ghost" size="sm" onClick={onBack} className="text-white/75 hover:bg-white/10 hover:text-white">
              <ArrowLeft className="h-4 w-4" />
              {t('auth.backToSite')}
            </Button>
          )}
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center p-5 pb-16">
        <div className="es-card w-full max-w-md p-7 sm:p-8">
          <h1 className="font-display text-2xl font-bold text-ink-900">
            {isRegister ? t('auth.registerTitle') : t('auth.signInTitle')}
          </h1>
          <p className="mt-1.5 text-sm text-ink-500">
            {isRegister ? t('auth.registerSubtitle') : t('auth.signInSubtitle')}
          </p>

          <form onSubmit={submit} className="mt-7 space-y-4">
            {isRegister && (
              <>
                <div>
                  <label htmlFor="auth-name" className="mb-1.5 block text-xs font-bold text-ink-700">
                    {t('auth.name')}
                  </label>
                  <input
                    id="auth-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className={fieldClass}
                    required
                    maxLength={80}
                    autoComplete="name"
                  />
                </div>

                <div>
                  <label htmlFor="auth-email" className="mb-1.5 block text-xs font-bold text-ink-700">
                    {t('auth.email')}
                  </label>
                  <input
                    id="auth-email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className={fieldClass}
                    required
                    maxLength={254}
                    autoComplete="email"
                  />
                </div>
              </>
            )}

            <div>
              <label htmlFor="auth-username" className="mb-1.5 block text-xs font-bold text-ink-700">
                {t('auth.username')}
              </label>
              <input
                id="auth-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className={fieldClass}
                required
                minLength={3}
                maxLength={32}
                autoComplete="username"
                pattern={isRegister ? '[A-Za-z0-9_.\-]{3,32}' : undefined}
              />
              {isRegister && (
                <p className="mt-1.5 text-xs text-ink-400">{t('auth.usernameHint')}</p>
              )}
            </div>

            <div>
              <label htmlFor="auth-password" className="mb-1.5 block text-xs font-bold text-ink-700">
                {t('auth.password')}
              </label>
              <input
                id="auth-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={fieldClass}
                required
                minLength={10}
                maxLength={128}
                autoComplete={isRegister ? 'new-password' : 'current-password'}
              />
              {isRegister && (
                <p className="mt-1.5 text-xs text-ink-400">{t('auth.passwordHint')}</p>
              )}
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-[var(--radius-control)] bg-danger-50 px-3.5 py-2.5 text-sm text-danger-700"
              >
                {error}
              </p>
            )}

            <Button type="submit" size="lg" fullWidth disabled={busy}>
              {busy ? t('auth.working') : isRegister ? t('auth.register') : t('auth.signIn')}
            </Button>
          </form>

          <button
            type="button"
            className="mt-5 text-sm font-semibold text-brand-600 transition-colors hover:text-brand-700"
            onClick={() => {
              setMode(isRegister ? 'login' : 'register');
              setError('');
            }}
          >
            {isRegister ? t('auth.toSignIn') : t('auth.toRegister')}
          </button>
        </div>
      </main>
    </div>
  );
}
