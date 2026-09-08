import React, { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
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

type Mode = 'login' | 'register' | 'forgot' | 'reset';

/** The reset email links back with the address and token in the query string. */
function readResetLink(): { email: string; token: string } | null {
  if (typeof window === 'undefined') return null;

  const params = new URLSearchParams(window.location.search);
  const email = params.get('email');
  const token = params.get('token');

  return email && token ? { email, token } : null;
}

/**
 * Sign-in, registration and password recovery for learners.
 *
 * The session itself is a server-set cookie; the copy of the user kept in
 * localStorage is only a UI hint, so a stale or forged entry cannot grant
 * access to anyone else's data.
 */
export function AuthGate({ onAuthenticated, onBack }: AuthGateProps) {
  const t = useT();

  const resetLink = readResetLink();
  const [mode, setMode] = useState<Mode>(resetLink ? 'reset' : 'login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState(resetLink?.email || '');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [resetToken, setResetToken] = useState(resetLink?.token || '');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';
  const isForgot = mode === 'forgot';
  const isReset = mode === 'reset';

  // Once the link has been read, drop the token from the address bar so it is
  // not left sitting in history or a shared screenshot.
  useEffect(() => {
    if (!resetLink) return;
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    // Reading the link once at mount is the whole point; re-running would undo it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchTo = (next: Mode) => {
    setMode(next);
    setError('');
    setNotice('');
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    if (isRegister && !USERNAME_PATTERN.test(username.trim().toLowerCase())) {
      setError(t('auth.errors.invalid_username'));
      return;
    }

    setBusy(true);
    setError('');
    setNotice('');

    try {
      if (isForgot) {
        const response = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await response.json().catch(() => ({}));

        // The endpoint deliberately answers the same way whether or not the
        // address is registered, so the form must not claim an account exists.
        setNotice(t('auth.forgotSent'));

        // Local development hands the token back directly; production emails it.
        if (typeof data.devResetToken === 'string') {
          setResetToken(data.devResetToken);
          setMode('reset');
          setNotice(t('auth.devTokenFilled'));
        }
        return;
      }

      if (isReset) {
        const response = await fetch('/api/auth/reset-password', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, token: resetToken, newPassword: password }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || t('auth.resetFailed'));

        setPassword('');
        setResetToken('');
        setMode('login');
        setNotice(t('auth.resetDone'));
        return;
      }

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

  const heading = isRegister
    ? t('auth.registerTitle')
    : isForgot
      ? t('auth.forgotTitle')
      : isReset
        ? t('auth.resetTitle')
        : t('auth.signInTitle');

  const subheading = isRegister
    ? t('auth.registerSubtitle')
    : isForgot
      ? t('auth.forgotSubtitle')
      : isReset
        ? t('auth.resetSubtitle')
        : t('auth.signInSubtitle');

  const submitLabel = isRegister
    ? t('auth.register')
    : isForgot
      ? t('auth.sendReset')
      : isReset
        ? t('auth.setPassword')
        : t('auth.signIn');

  return (
    <div className="es-ink-surface flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <Logo tone="light" compact />
        <div className="flex items-center gap-2">
          <LanguageSwitcher tone="light" />
          {onBack && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="text-white/75 hover:bg-white/10 hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" />
              {t('auth.backToSite')}
            </Button>
          )}
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center p-5 pb-16">
        <div className="es-card w-full max-w-md p-7 sm:p-8">
          <h1 className="font-display text-2xl font-bold text-ink-900">{heading}</h1>
          <p className="mt-1.5 text-sm text-ink-500">{subheading}</p>

          <form onSubmit={submit} className="mt-7 space-y-4">
            {isRegister && (
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
            )}

            {(isRegister || isForgot || isReset) && (
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
            )}

            {isReset && (
              <div>
                <label htmlFor="auth-token" className="mb-1.5 block text-xs font-bold text-ink-700">
                  {t('auth.resetCode')}
                </label>
                <input
                  id="auth-token"
                  value={resetToken}
                  onChange={(event) => setResetToken(event.target.value)}
                  className={`${fieldClass} font-mono text-xs`}
                  required
                  maxLength={200}
                />
                <p className="mt-1.5 text-xs text-ink-400">{t('auth.resetCodeHint')}</p>
              </div>
            )}

            {(mode === 'login' || isRegister) && (
              <div>
                <label
                  htmlFor="auth-username"
                  className="mb-1.5 block text-xs font-bold text-ink-700"
                >
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
                  pattern={isRegister ? '[A-Za-z0-9_.\\-]{3,32}' : undefined}
                />
                {isRegister && (
                  <p className="mt-1.5 text-xs text-ink-400">{t('auth.usernameHint')}</p>
                )}
              </div>
            )}

            {!isForgot && (
              <div>
                <label
                  htmlFor="auth-password"
                  className="mb-1.5 block text-xs font-bold text-ink-700"
                >
                  {isReset ? t('auth.newPassword') : t('auth.password')}
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
                  autoComplete={isRegister || isReset ? 'new-password' : 'current-password'}
                />
                {(isRegister || isReset) && (
                  <p className="mt-1.5 text-xs text-ink-400">{t('auth.passwordHint')}</p>
                )}
              </div>
            )}

            {notice && (
              <p className="flex items-start gap-2 rounded-[var(--radius-control)] bg-success-50 px-3.5 py-2.5 text-sm text-success-700">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                {notice}
              </p>
            )}

            {error && (
              <p
                role="alert"
                className="rounded-[var(--radius-control)] bg-danger-50 px-3.5 py-2.5 text-sm text-danger-700"
              >
                {error}
              </p>
            )}

            <Button type="submit" size="lg" fullWidth disabled={busy}>
              {busy ? t('auth.working') : submitLabel}
            </Button>
          </form>

          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <button
              type="button"
              className="font-semibold text-brand-600 transition-colors hover:text-brand-700"
              onClick={() => switchTo(isRegister ? 'login' : 'register')}
            >
              {isRegister ? t('auth.toSignIn') : t('auth.toRegister')}
            </button>

            {mode === 'login' && (
              <button
                type="button"
                className="text-ink-500 transition-colors hover:text-ink-800"
                onClick={() => switchTo('forgot')}
              >
                {t('auth.forgotLink')}
              </button>
            )}

            {(isForgot || isReset) && (
              <button
                type="button"
                className="text-ink-500 transition-colors hover:text-ink-800"
                onClick={() => switchTo('login')}
              >
                {t('auth.backToSignIn')}
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
