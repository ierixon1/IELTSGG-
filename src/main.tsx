import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { I18nProvider } from './i18n';
import './index.css';

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
