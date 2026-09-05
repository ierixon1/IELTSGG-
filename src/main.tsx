import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { AuthGate } from './components/AuthGate';
import './index.css';

type AuthUser = { id: string; email: string; username: string; name: string; role: string };

function Root() {
  const [auth, setAuth] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(async response => response.ok ? response.json() : null)
      .then(data => setAuth(data?.user || null))
      .catch(() => setAuth(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <div className="min-h-screen bg-slate-50 flex items-center justify-center text-slate-500">Loading…</div>;
  if (!auth) return <AuthGate onAuthenticated={user => setAuth(user)} />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
