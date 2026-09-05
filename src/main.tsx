import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { AuthGate } from './components/AuthGate';
import './index.css';

type AuthUser = { id: string; email: string; username: string; name: string; role: string };

function Root() {
  const [auth, setAuth] = useState<{ user: AuthUser; token: string } | null>(() => {
    const token = localStorage.getItem('prep_auth_token');
    const raw = localStorage.getItem('prep_auth_user');
    if (!token || !raw) return null;
    try { return { token, user: JSON.parse(raw) as AuthUser }; } catch { return null; }
  });

  if (!auth) return <AuthGate onAuthenticated={(user, token) => setAuth({ user, token })} />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
