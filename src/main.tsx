import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { I18nProvider } from './i18n';
import './index.css';

/**
 * Session tokens live in an HttpOnly cookie. An older build also mirrored the
 * token into `localStorage`, so purge those keys on boot: a browser that ran
 * the old build would otherwise keep a readable bearer token indefinitely.
 */
try {
  localStorage.removeItem('prep_auth_token');
  localStorage.removeItem('prep_admin_token');
} catch {
  /* A browser with site data blocked has nothing to purge. */
}

/**
 * The auth gate lives inside `App`, not here: the landing page is public and
 * must render for a signed-out visitor, while the product behind `#/app`
 * requires a session.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
