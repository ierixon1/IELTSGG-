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

Without the key the app still runs, but AI grading, paragraph rewriting,
handwriting transcription and the mentor chat answer `503` (`ai_not_configured`).
No band is ever invented in its place.

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
- Request rate limits count a signed-in learner or staff member against their
  own account, so people sharing an address (a classroom, an office NAT) do not
  spend each other's allowance. Requests without a session are counted per client
  address: anonymous API calls, sign-up (40 an hour) and password recovery.
  Sign-in keeps only failures counted — 20 per address in 10 minutes, and 5 per
  account name per address in 15 minutes — so a class signing in together is not
  refused. Over a limit is `429` with `code: "rate_limited"` and `Retry-After`.
- The client address is the connection's own unless `TRUST_PROXY` says which
  proxies sit in front (a hop count, or their addresses); `X-Forwarded-For` is
  otherwise ignored. Set it to `1` behind one load balancer or reverse proxy.

Production must keep `EXPLICIT_DEV_AUTH=false` and `SEED_DEFAULT_ACCOUNTS=false`
unless a controlled bootstrap is explicitly required, must supply valid
Google/Firebase credentials, and must use `STORAGE_BACKEND=gcs_firestore`.
`EXPLICIT_DEV_AUTH=true` is for local testing only and must never be enabled on
a public deployment. It takes effect only when `NODE_ENV` is `development` or
`test`; with `NODE_ENV` unset or anything else the server refuses to start.

Never commit `.env` files, service-account keys, API keys or administrator
credentials. `data/users.json`, `data/sessions.json` and `data/db.json` are
runtime state and are git-ignored.

## Deployment

Production runs the built server (`npm run build`, then `npm start`) from a
production install (`npm ci --omit=dev`) with `NODE_ENV=production`. Before
anything else loads, the server checks its configuration and refuses to start —
listing every problem — unless all of these hold:

| Setting | Required |
|---|---|
| `PORT` | the port the platform sends traffic to (Cloud Run sets it) |
| `TRUST_PROXY` | the proxy hops in front (`1` behind Cloud Run or one load balancer), their addresses, or `false` when clients connect directly |
| `STORAGE_BACKEND` | `gcs_firestore` |
| `GCS_BUCKET_NAME` | the Cloud Storage bucket for uploaded files |
| Firestore credentials | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` together, or none of the key's parts to use Application Default Credentials; a `GOOGLE_APPLICATION_CREDENTIALS` file, if named, must exist |
| `RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL` | password-reset email; `APP_URL` is the `https://` address learners use |
| `EXPLICIT_DEV_AUTH`, `SEED_DEFAULT_ACCOUNTS` | not `true` |

Once per Firestore project:

- Let Firestore delete expired rate-limit documents. Each carries `expiresAt`,
  the moment its window closes; the limiter never relies on the deletion, which
  Firestore performs some time after that moment:

  ```
  gcloud firestore fields ttls update expiresAt --collection-group=rate_limits --enable-ttl --project=<project>
  gcloud firestore fields ttls update expireAt --collection-group=auth_sessions --enable-ttl --project=<project>
  ```

  Sessions carry `expireAt` (a timestamp) for the second policy; an expired
  session is refused whether or not it has been deleted yet.
- Deploy the rules and field settings in this repository, which deny every
  client SDK read and write (the server uses the Admin SDK, which rules do not
  apply to) and declare both TTL fields:

  ```
  firebase deploy --only firestore:rules,firestore:indexes --project <project>
  ```

- The service account the server runs as needs Firestore read and write (Cloud
  Datastore User) and object read and write on the bucket (Storage Object Admin).
- Before launch, run `npm run verify:firestore` against a dedicated project that
  holds no production data (see the script's header). It exercises accounts,
  sessions, profiles, promotion and the request limiter under concurrency against
  real Firestore, checks `expiresAt` and the TTL policy, and removes what it wrote.

The first administrator is an account that registered normally, then promoted:

- start the server once with `ADMIN_PROMOTE_USERNAME=<username>` (and
  `ADMIN_PROMOTE_ROLE=admin`, the default), then remove the variable; or
- from a checkout with the deployment's environment, run
  `npm run admin:promote -- <username> admin`.

The account's sessions end, and it signs in again with the new role.
`npm run verify:production-install` checks that a clean production install boots
and serves its runtime paths. Two headless-browser checks need an installed
Chrome or Edge (`-- --browser=chrome|edge`):

- `npm run build && npm run e2e:production-csp` checks that the built app runs
  under the production Content Security Policy;
- `npm run e2e:exam-acceptance` has staff content imported and published, then
  a learner sits a whole exam through the exam screens, graded by a fixture
  model, with the stored result checked against the scoring tables.

What operators see at run time:

- Every response carries `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Cross-Origin-Opener-Policy` and `Permissions-Policy`; in
  production also `Strict-Transport-Security` and a Content Security Policy that
  allows only the app's own scripts.
- Every response carries an `X-Request-Id` the server generated. The error log
  line for a failed request ends with `[request <id>]`.
- Every state-changing admin request — sign-in, saves, publishing, deletions,
  refused ones included — writes one JSON line to stdout:
  `{"type":"admin_audit","at","requestId","actor":{"userId","role"}|null,"method","route","params","status"}`
  (staff sign-in adds the username tried; no body or password is logged). Keep
  these lines in the platform's log retention.
- On `SIGTERM` or `SIGINT` the server stops accepting connections, lets
  requests in flight finish, and exits 0 — or exits 1 after 10 seconds.
- Request bodies: sign-in, sign-up and recovery take up to 64 kB; the admin API
  takes up to 16 MB from a signed-in staff member and 64 kB otherwise; the other
  API routes read a body (up to 16 MB) only after the request is signed in.

## API

- `GET /api/health` — service status and whether an AI key is configured.
- `GET /api/taxonomy` — the IELTS theme and question-type catalogue.
- `GET /api/quotas` — the caller's remaining daily generation and upload quota.
- `GET|PUT|POST /api/data*` — the caller's own profile, plan, checklist and
  attempts.
- `POST /api/grade/writing` — band 0–9 across the four criteria with inline
  annotations.
- `POST /api/grade/speaking` — multimodal evaluation of a recorded answer.
- `POST /api/preppy/chat` — the AI mentor.
