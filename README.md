# PrepIELTS AI Studio

PrepIELTS AI Studio is an independent AI-assisted IELTS preparation platform.

## Production architecture

The application is designed for multiple users. Authentication is required for protected APIs, and user data is scoped by the authenticated user ID. Production persistence uses Firestore for application data and Google Cloud Storage for files.

The mobile client must be treated as an untrusted client: authorization, ownership, quotas and privileged roles are enforced server-side.

## Security requirements

Production must keep `EXPLICIT_DEV_AUTH=false` and `SEED_DEFAULT_ACCOUNTS=false` unless a controlled bootstrap is explicitly required. Production must provide valid Firebase/Google Cloud credentials and `STORAGE_BACKEND=gcs_firestore`.

Never commit `.env` files, service-account keys, API keys or administrator credentials.

## Development

Set `STORAGE_BACKEND=local` for explicit local development. The optional `EXPLICIT_DEV_AUTH=true` mode is only for local testing with an existing local user and must never be enabled in a public deployment.

## Scope

IELTS® is a registered trademark of University of Cambridge, British Council, and IDP Education Australia. This project is an independent educational tool and is not affiliated with or endorsed by those organizations.
