# PrepIELTS AI Studio

PrepIELTS AI Studio is an independent AI-assisted IELTS preparation platform.

The application is designed for multiple users. Protected APIs require authentication, and user data is scoped by the authenticated user ID. Production persistence uses Firestore for application data and Google Cloud Storage for files.

The mobile client must be treated as untrusted: authorization, ownership, quotas and privileged roles are enforced server-side.

Production must keep EXPLICIT_DEV_AUTH=false and SEED_DEFAULT_ACCOUNTS=false unless a controlled bootstrap is explicitly required. Production must provide valid Google/Firebase credentials and use STORAGE_BACKEND=gcs_firestore.

Never commit .env files, service-account keys, API keys or administrator credentials.

For local development, STORAGE_BACKEND=local may be used. EXPLICIT_DEV_AUTH=true is only for local testing and must never be enabled on a public deployment.

IELTS® is a registered trademark of University of Cambridge, British Council, and IDP Education Australia. This project is independent and not affiliated with or endorsed by those organizations.
