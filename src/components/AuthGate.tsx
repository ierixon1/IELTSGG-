import React, { useState } from 'react';

type AuthUser = { id: string; email: string; username: string; name: string; role: string };
type Props = { onAuthenticated: (user: AuthUser) => void };

export function AuthGate({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = mode === 'login' ? { username, password } : { username, email, password, name };
      const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.user) throw new Error(data.error || 'Authentication failed.');
      onAuthenticated(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally { setBusy(false); }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-sm p-7">
        <h1 className="text-2xl font-bold text-slate-900">PrepIELTS</h1>
        <p className="mt-1 text-sm text-slate-500">Your personal IELTS preparation workspace.</p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          {mode === 'register' && <>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" className="w-full rounded-xl border px-4 py-3" required maxLength={80} />
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" type="email" className="w-full rounded-xl border px-4 py-3" required maxLength={254} />
          </>}
          <input value={username} onChange={e => setUsername(e.target.value)} placeholder="Username" className="w-full rounded-xl border px-4 py-3" required minLength={3} maxLength={32} autoComplete="username" />
          <input value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" type="password" className="w-full rounded-xl border px-4 py-3" required minLength={10} maxLength={128} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          {error && <div className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2">{error}</div>}
          <button disabled={busy} className="w-full rounded-xl bg-slate-900 text-white py-3 font-semibold disabled:opacity-50">
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <button type="button" className="mt-4 text-sm text-slate-600 underline" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
          {mode === 'login' ? 'Create a new account' : 'I already have an account'}
        </button>
      </div>
    </div>
  );
}
