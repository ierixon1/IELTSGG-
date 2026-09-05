# IELTS Prep & AI Mock Exam Studio

Production-ready, full-stack IELTS preparation platform powered by Google Gemini, featuring dynamic mock test generation, RAG textbook ingestion, personalized study planning, and real-time exam grading.

## 🛠 Architecture Overview

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Motion, Lucide icons.
- **Backend**: Node.js, Express, Vite middleware.
- **AI Core**: Google Gemini SDK (`@google/genai`) using `gemini-3.8-flash` with structured JSON schemas (`responseSchema`), exponential backoff retry for transient rate limits, and context caching for study materials.
- **Storage Layer**:
  - `StorageProvider`: Pluggable object storage interface (`LocalStorageProvider` for dev, `CloudStorageProvider` for Google Cloud Storage in Cloud Run).
  - `DataStore`: Pluggable state/document store (`LocalJsonDataStore` for dev atomic persistence, `FirestoreDataStore` for Firebase/Firestore in Cloud Run).
  - Switched seamlessly via `STORAGE_BACKEND=local|gcs_firestore`.
- **Security & Multi-tenancy**:
  - `authMiddleware`: Enforces caller identity (`req.userId`) via Bearer tokens, isolating test history, textbook uploads, and quotas per user.

---

## ⚙️ Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | *(Required)* | Google Gemini API key for mock generation, essay grading, and textbook AI drills. |
| `STORAGE_BACKEND` | `local` | `local` uses local disk (`data/`); `gcs_firestore` connects to Google Cloud Storage & Firestore for ephemeral Cloud Run. |
| `GCS_BUCKET_NAME` | `ielts-preppy-textbooks` | Target Google Cloud Storage bucket name for raw textbook PDFs and files. |
| `FIREBASE_PROJECT_ID` | `""` | GCP/Firebase Project ID for Firestore and token verification. |
| `RATE_LIMIT_GENERATIONS` | `10` | Maximum AI mock test generations allowed per user per day. |
| `RATE_LIMIT_UPLOADS` | `3` | Maximum textbook document uploads allowed per user per day. |
| `PORT` | `3000` | Port bound by server (must remain 3000 in container environment). |

---

## 📋 API Endpoints

- `GET /api/health` — Service health and Gemini key availability.
- `GET /api/taxonomy` — Complete IELTS taxonomy of 36+ themes and all 10 Reading / 6 Listening / Writing / Speaking question types.
- `GET /api/quotas` — Caller's daily generation and upload quota limits and remaining balance.
- `POST /api/mocks/generate` — Generates a new IELTS test with Zod validation, anti-repeat negative topics, and exponential backoff retry.
- `GET /api/mocks/history` — Lists previously generated tests for the authenticated user.
- `GET /api/mocks/:id` — Retrieves full test content and answer keys.
- `POST /api/grade/writing` — Band 0.0–9.0 structured evaluation of Writing Task 1/2 with annotated error highlights.
- `POST /api/grade/speaking` — Multimodal evaluation of speaking audio and transcripts.
- `POST /api/preppy/chat` — Contextual AI IELTS mentor dialogue.
