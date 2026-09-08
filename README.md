# Ever Study

Ever Study is an independent AI-assisted Academic IELTS preparation platform: a
public marketing page, and behind an account, an adaptive study plan, full mock
tests in the computer-delivered format, and an AI examiner that grades Writing
and Speaking against the public IELTS band descriptors.

It is not affiliated with, approved by or certified by the IELTS partners.
IELTS® is a registered trademark of British Council, IDP Education and
Cambridge University Press & Assessment.

## Running it locally

```bash
npm install
npm run dev          # http://localhost:3000
```

The AI examiner needs a Google Gemini key. Create a `.env` file in the project
root with:

```
GEMINI_API_KEY="your key"
STORAGE_BACKEND=local
```

Without the key the app still runs: grading endpoints return a fixed sample
response so the interface can be exercised, but the bands are not real
assessments.

`npm run lint` type-checks the project. `npm run build` produces `dist/`.

## Architecture

- **Frontend**: React 19, TypeScript, Tailwind v4, Motion, Lucide.
- **Backend**: Node, Express, Vite middleware in development.
- **AI**: Google Gemini via `@google/genai`, with structured JSON schemas and
  exponential backoff on transient rate limits.
- **Storage**: pluggable. `STORAGE_BACKEND=local` writes to `data/`;
  `gcs_firestore` uses Firestore for documents and Google Cloud Storage for
  files.

### Design system

All colour, type, radius and elevation live as tokens in `src/index.css` under
`@theme`. Components compose the primitives in `src/components/ui` rather than
re-deriving styling. There is one brand accent; the three signal ramps
(success, warning, danger) define only 50/500/700, and each IELTS module has a
tint/ink pair. Do not hard-code a hex value or a raw Tailwind palette shade in
a component.

### Interface languages

English, Russian and Uzbek, in `src/i18n/locales`. English is the reference
dictionary: add every new key there first, and the other locales fall back to
it until translated, so a partly translated screen never renders a raw key.

Generated study-plan text is stored as a translation key plus parameters rather
than a rendered sentence, so an existing plan follows the learner's language.

## Security

The client is untrusted: authorization, ownership, quotas and privileged roles
are all enforced server-side.

- Learner data is scoped to the authenticated user id. `/api/data*` returns 401
  without a session.
- Admin routes sit behind `enforceAdminSecurity` and a role check, and return
  403 without an admin session.
- Sessions are HttpOnly cookies. Anything cached in `localStorage` is a UI hint
  only and is never trusted for access.

Production must keep `EXPLICIT_DEV_AUTH=false` and `SEED_DEFAULT_ACCOUNTS=false`
unless a controlled bootstrap is explicitly required, must supply valid
Google/Firebase credentials, and must use `STORAGE_BACKEND=gcs_firestore`.
`EXPLICIT_DEV_AUTH=true` is for local testing only and must never be enabled on
a public deployment.

Never commit `.env` files, service-account keys, API keys or administrator
credentials. `data/users.json`, `data/sessions.json` and `data/db.json` are
runtime state and are git-ignored.

## API

- `GET /api/health` — service status and whether an AI key is configured.
- `GET /api/taxonomy` — the IELTS theme and question-type catalogue.
- `GET /api/quotas` — the caller's remaining daily generation and upload quota.
- `GET|PUT|POST /api/data*` — the caller's own profile, plan, checklist and
  attempts.
- `POST /api/mocks/generate`, `GET /api/mocks/history`, `GET /api/mocks/:id`.
- `POST /api/grade/writing` — band 0–9 across the four criteria with inline
  annotations.
- `POST /api/grade/speaking` — multimodal evaluation of a recorded answer.
- `POST /api/preppy/chat` — the AI mentor.
