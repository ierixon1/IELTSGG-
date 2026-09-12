# Production Readiness Audit (Phase 17)

Audited commit: `5ebe768 phase-16-ielts-fidelity-corrections`

Audit-only phase. No production code, tests, schemas or data were changed. Findings were reproduced with throwaway probes outside the repository (see "Method").

## Executive summary

**Overall status: NOT READY**

> **Update after Phase 18.**
> - **C1 is resolved.** Exam content (any material a published bundle pins, and a published bundle itself) is no longer practice content, and the server refuses to open or mark it. See the C1 resolution.
> - **New finding H11.** The same phase's bypass audit found a slower answer-derivation path through exam-session score counts.
> - **Status is still NOT READY** because of the remaining High findings.

> **Update after Phase 19.**
> - **H11 is resolved.** During an exam, every exam-session response carries progress and the learner's own work only; section counts, bands and grading feedback reach the learner only once the whole exam has finished. See the H11 resolution.
> - **Status is still NOT READY.** H1–H10 are unchanged.

> **Update after Phase 20.**
> - **H1 is resolved.** A failed API request no longer takes the process down. Every async handler's rejection reaches one JSON error boundary: 400/413/415 for input the server cannot use, 503 when storage is unavailable, 500 otherwise, with nothing internal in the body. A Firestore deployment without credentials answers 503 instead of exiting, and `/api/health` answers 503 when the data backend cannot be used. See the H1 resolution.
> - **Status is still NOT READY.** H2–H10 are unchanged.

> **Update after Phase 21.**
> - **H4 is resolved.** A save that changes a published material in any way writes it back as a draft in the same write, so learners never see content the publish gate has not passed. Saves through the admin API must name the revision they were opened at. Publishing, reviewer decisions and deletes re-check the row inside the write. See the H4 resolution.
> - **Status is still NOT READY.** H2, H3 and H5–H10 are unchanged.

The exam engine, scoring, ownership checks and key redaction are in good shape, and most of the audited boundaries held when probed against the real server. Anonymous and learner-to-admin requests were refused, no learner could reach another learner's sessions or data, draft and archived content stayed hidden, practice payloads carried no keys, and encoded path traversal returned nothing.

Several problems remain that would show up quickly in production.

- **Exam answer keys can be fetched before sitting the exam** (Critical, reproduced). An empty practice submission against a published exam bundle returns the full Listening and Reading key. A learner then scored 40/40 (band 9) in both sections.
- **The server process can be crashed** (High, reproduced). One staff request with a malformed id kills it, because several async routes have no error handling and there is no process-level handler. The same mechanism applies to Firestore errors on an anonymous route.
- **The API rate limiter is keyed by client IP**, and `trust proxy` is not set (High, reproduced). One learner's traffic returned 429 to a different learner on the same IP. Behind a proxy or a school network, exam autosaves and logins fail for everyone.
- **Published content can change without passing the publish gate again** (High, reproduced). Editing a published material to have no questions kept it published and served to learners.
- **The untouched original of an imported page** — which carries its printed answer key — can be downloaded by any signed-in learner who has the asset id (High, reproduced).
- **Exam results can be wrong under realistic conditions** (High, reproduced).
  - Writing or Speaking submitted before the deadline is discarded if grading finishes after it.
  - Grading calls have no timeout.
  - One grading during a model outage uses three quota units.
- **Firestore differs from local storage** (High). Saving with `merge: true` keeps fields the editor removed (reproduced against a Firestore fake). Large parts of the Firestore path — auth, sources, Book → Test, quotas and write contention — have never been run.
- **Deployment gaps** (High/Medium, confirmed).
  - Runtime packages are listed as devDependencies.
  - The port is hard-coded to 3000.
  - There are no security headers.
  - A production (Firestore) deployment has no way to create the first administrator.

Checks run: `tsc --noEmit` clean; full suite **555 tests, 555 pass, 0 fail**.

Finding count: 1 Critical (resolved in Phase 18), 11 High (H11 added in Phase 18 and resolved in Phase 19, H1 resolved in Phase 20, H4 resolved in Phase 21; 8 open), 14 Medium, 12 Low.

## Method and evidence legend

**Status values**

| Status | Meaning |
|---|---|
| `reproduced` | Observed by executing the code: a probe against the real server, an in-process probe, or the production build. |
| `confirmed` | Established by reading the exact code path; not executed. |
| `unverified` | Could not be exercised here, most notably a real Firestore project and Safari/iOS. |
| `hypothesis` | A plausible consequence of confirmed code that was not demonstrated. |

**Probes** (in `%TEMP%\p17probe`, not committed)

- **Probe 1** starts the real `server.ts` as a subprocess in an empty temp directory.
  - It runs with `NODE_ENV=development`, `STORAGE_BACKEND=local` and no Gemini key.
  - It seeds a throwaway admin through the existing bootstrap env vars and registers two throwaway learners.
  - It builds content through the admin HTTP API: 4 Listening parts with WAV uploads, 3 Reading passages (one carrying an imported page's `sourceAssetId`), Writing, Speaking, and a published bundle.
  - It then issues the requests quoted below.
- **Probe 2** runs in process with local storage in a temp directory.
  - It uses the real exam session service with a grader that takes 25 seconds.
  - It uses the real grading and quota code with `fetch` stubbed to return Gemini 503s, or never to answer.
- **Probe 3** runs in process on the Firestore code path, against `tests/fakeFirestore.ts`. That fake implements Firestore's documented deep-merge semantics.
- **Production build.** `npm run build`, then `node dist/server.cjs` with `NODE_ENV=production` and `STORAGE_BACKEND=gcs_firestore`, without credentials.

The repository's `data/` directory was not touched. `dist/` was rebuilt; it is git-ignored.

## Risk register

| ID | Severity | Area | Finding | Status | Evidence | Production impact | Recommendation |
|---|---|---|---|---|---|---|---|
| C1 | Critical | Answer keys / exam integrity | Practice marking returns the full answer key of any published bundle or material for an empty submission, so exam keys are available before the exam. | reproduced; **resolved in Phase 18** (no longer reproducible) | Probe 1 S9a/S9b; `tests/practiceEligibility.test.ts` | Any learner can get band 9 in Listening/Reading of any published exam; exam results are not trustworthy. | Product decision required (see C1 detail). At minimum, stop revealing keys for exam bundles or their components through practice. |
| H1 | High | Runtime / availability | Async route handlers without try/catch plus no process handler: one thrown error exits the process. | reproduced; **resolved in Phase 20** (no longer reproducible over the real `server.ts`) | Probe 1 S17; production boot; `tests/serverStability.test.ts`, `tests/errorBoundary.test.ts` | Any examiner/admin typo in an id, or a Firestore error on the anonymous `/api/admin/public/materials/:section`, takes the server down for all learners mid-exam. | Wrap every async handler (or add an Express async error wrapper and a JSON error handler); add a process-level `unhandledRejection` log-and-survive policy. |
| H2 | High | Rate limiting | Global (120/min) and auth limiters are keyed by `req.ip`, with no `trust proxy`, and shared by all users behind one address. | reproduced | Probe 1 S16 | Behind a load balancer every user shares one budget; a classroom behind one NAT gets 429 on exam autosaves and logins. | Configure `trust proxy` for the deployment; key the authenticated limiter by user id; size limits against exam autosave traffic. |
| H3 | High | Source leakage | An imported page's untouched original (with its printed answer key) is served to any signed-in learner by `/api/assets/:id` once the material is published. | reproduced | Probe 1 S4 | Boundary broken; exploit needs the asset id, which no learner payload exposes (S10). | Exclude `assetIds` entries that name the source original from the learner allowlist, or strip `assetIds` in `toLearnerMaterial`. |
| H4 | High | Publication integrity | Saving a published material keeps it published without re-running the publish gate. | reproduced; **resolved in Phase 21** (a changed published material is withdrawn to draft in the same write) | Probe 1 D1; `tests/publishedMaterialProtection.test.ts` | Learners are served content the gate would refuse: no questions, missing classification, stale confirmations of generated questions, missing assets. | Re-run the gate on save of a published material (refuse, or move to draft); or require unpublish before edit, as bundles do. |
| H5 | High | Firestore divergence | `adminStore.saveMaterial` writes with `set(..., { merge: true })`; nested fields the editor removed survive in Firestore. | reproduced (fake); unverified (real Firestore) | Probe 3 F1/F2 | Learners keep seeing removed `htmlContent`, audio ids and similar; local and production behave differently; stored hash ≠ saved item hash. | Write the finalised material without merge (the local store replaces the row); same review for `sourceStore.save`. |
| H6 | High | Exam correctness | Writing/Speaking are scored only if grading finishes before the section deadline; drafts at the deadline are never graded. | reproduced | Probe 2 A; `examSession.ts:299-319`, `examRun.ts:299-305` | A learner who submits in the last seconds, or writes but does not press submit, gets no Writing band and no overall. | Accept by submission time, not grading-completion time; decide policy for ungraded drafts at the deadline. Record as a known limitation until decided. |
| H7 | High | AI reliability | Grading, rewrite, transcribe and mentor calls have no timeout; each fallback model consumes a quota unit; at the limit the learner gets 500 instead of a quota message. | reproduced | Probe 2 B1/B2/C | One outage burns ~3 units per grading (default 4/hour); a hung call holds the request indefinitely; exams can become impossible to finish. | Add per-attempt and total timeouts; charge quota once per grading; map quota refusal to 429 with a clear code. |
| H8 | High | Listening delivery | Audio is sent without HTTP Range support, and the exam records a part as played before `play()` succeeds. | reproduced (server); confirmed (client); unverified (Safari/iOS device) | Probe 1 S4b; `ListeningSession.tsx:86-92` | Safari/iOS media playback expects byte ranges; if playback fails the part is still consumed and cannot be replayed. | Serve assets with Range/206 support; record the start only after playback actually begins. |
| H9 | High | Deployment | `multer`, `mammoth` and `pdf-parse` are runtime imports but devDependencies; `nanoid` is imported but undeclared; the build externalises packages. | confirmed (manifest); hypothesis (boot failure under `--omit=dev`) | `package.json`; `adminRoutes.ts:2,6`; `sourceRoutes.ts:2` | A production install that prunes devDependencies fails at startup. | Move them to dependencies and declare `nanoid`; pin a Node version (`engines`). |
| H10 | High | Firestore verification | No real Firestore project has been run, and the fake leaves large paths unexercised. | unverified | Firestore audit below | Production requires Firestore; auth, quotas, sources, Book → Test and contention behaviour are unknown. | Run the full suite and a smoke test against an emulator or staging project before production. |
| H11 | High | Answer keys / exam integrity | The exam session's run view exposes each closed Listening/Reading section's correct count and band before the exam ends; abandoned sessions can be reopened without limit. | reproduced (counts exposed mid-exam); hypothesis (key derivation); **resolved in Phase 19** (no marks in any response before the exam finishes) | Probe 1 S9b; `tests/examOracle.test.ts` | Repeated sessions let a learner infer closed-choice keys from count changes; far slower than C1 and bounded by timing when early finish is off. | Withhold objective counts and bands from the run view until the exam is finished; consider limiting abandoned sittings per bundle. Exam session logic was out of Phase 18 scope. |
| M1 | Medium | Deployment | Port is hard-coded to 3000; `process.env.PORT` is ignored. | confirmed | `server.ts:24,179` | Platforms that assign `PORT` (Heroku, Railway; Cloud Run defaults to 8080) cannot route to the app without extra configuration. | Honour `PORT`. |
| M2 | Medium | Web security | No CSP, frame protection, HSTS, nosniff or Referrer-Policy on app or API responses; `X-Powered-By: Express`. | reproduced | Probe 1 H1 | The exam and admin UIs can be framed (clickjacking); weaker defence in depth. | Add security headers in production. |
| M3 | Medium | Admin bootstrap | In Firestore mode `seedInitialAccounts` and `ADMIN_PROMOTE_USERNAME` never run, so there is no supported way to create the first administrator. | confirmed | `authService.ts:39` | Nobody can publish content until a Firestore document is edited by hand. | Provide a production bootstrap path (one-off script or env-gated promote on Firestore). |
| M4 | Medium | Local storage integrity | An unreadable or corrupt JSON file is read as empty and overwritten on the next write. | reproduced | Probe 1 D2 | Local mode only (production refuses local storage), but any local or demo deployment can lose a whole collection. | Fail loudly on parse or read errors; never write over a file that failed to read. |
| M5 | Medium | Stored HTML | The server sanitises only `htmlContent`/`passageHtml`; `passage.text` and a Writing `prompt` are rendered as HTML by `CdiHtmlViewer` and stored raw. | reproduced (storage); confirmed (render path) | Probe 1 S13; `ReadingSession.tsx:208-209` (text that looks like HTML), `WritingSession.tsx` (`promptLooksLikeHtml`) | Client-side DOMPurify is the only defence for those fields. | Sanitise every field the client renders as HTML on the server too. |
| M6 | Medium | Performance / cost | Every exam event re-resolves the whole bundle; the learner catalog runs the full gate per bundle; each asset request scans all published materials. | confirmed (unmeasured) | `examSession.ts:131`, `bundleService.ts:38-72,213-225`, `learnerContentRoutes.ts:179-187` | Firestore reads per autosave grow with material and asset count; latency and cost scale with concurrent learners. | Cache the resolved sitting per request or revision; index published asset ids. Measure before launch. |
| M7 | Medium | Observability | Console logs only; no request ids or error reporting; `auditLogService` is never called; attempts do not record the grading model; `/api/health` checks no dependencies. | confirmed | grep; `server.ts:38`; production boot | Admin actions are not audited; failures are hard to trace; health stays green while Firestore is unusable. | Structured logs with request ids; wire the audit log; dependency-aware health check. |
| M8 | Medium | Attempt reconstruction | Attempts pin `materialId` + `contentHash`, but materials are edited in place. | confirmed | `attemptVerification.ts:81-86`; `materialVersion.ts` | After any edit, what a learner actually sat cannot be reconstructed. | Snapshot sat content (or immutable material versions) with the attempt. |
| M9 | Medium | Exam operations | Any edit to a pinned material stops every in-progress sitting (`component_changed`); republishing supersedes them and learners lose their progress. | confirmed (designed); covered by tests | `examSession.test.ts` "a sitting that cannot go on…" | A typo fix during an exam window ends all live exams. | Operational rule (no edits during live windows) until immutable versions exist. |
| M10 | Medium | Firestore write limits and atomicity | Source delete puts every chunk in one batch (Firestore caps at 500); multi-step operations are not atomic. | confirmed | `sourceStore.ts:94-104`, `assetStore.ts:143-150`, `adminRoutes.ts:240-276` | A large book cannot be deleted; partial failure leaves assets mis-staged or orphaned (logged only). | Chunked batches; retries or reconciliation for multi-step operations. |
| M11 | Medium | Configuration | `EXPLICIT_DEV_AUTH` impersonation is guarded only by `NODE_ENV !== 'production'`. | confirmed | `authMiddleware.ts:8` | A staging host with `NODE_ENV` unset and the flag on allows impersonating any user via `x-user-id`. | Remove the flag from any hosted environment; fail boot if set outside local. |
| M12 | Medium | Migration / deploy artefacts | No local→Firestore migration script; no Firestore index or rules files; no deployment descriptor. | confirmed | repo listing | Existing local content cannot be moved to production; deployment is undocumented. | Write the migration and deployment runbook before production. |
| M13 | Medium | Auth performance | `bcrypt.hashSync`/`compareSync` (cost 12) run on the request thread. | confirmed | `authService.ts:44,74,75` | Each login or register blocks the event loop for all learners for hundreds of milliseconds. | Use the async bcrypt API. |
| M14 | Medium | Test quality | `security.test.ts` (15 tests) only asserts source text; no test mounts `server.ts`; its inline routes, rate limiting and crash behaviour are untested. | confirmed | Test audit below | Green tests did not catch H1, H2 or H7. | Add behavioural tests on the real app wiring for the confirmed findings when fixing them. |
| L1 | Low | Assets | Download filename sanitiser `/[^w. -]/g` is missing its backslash, so names become underscores. | reproduced | Probe 1 S4 (`filename="____-____.____"`) | Cosmetic. | Fix the pattern to `\w`. |
| L2 | Low | Admin upload | PDF text extraction on `/api/admin/upload` calls the pdf-parse v2 class without `new`, so it always fails. | reproduced | Direct call: "Class constructor PDFParse cannot be invoked without 'new'" | PDF uploads never pre-fill text (the Source Library path uses `new PDFParse` correctly). | Use the same call as `sourceIngest/extract.ts`. |
| L3 | Low | Error handling | Malformed JSON returns Express's HTML error page (stack trace in development); unknown `GET /api/*` returns `index.html` in production. | reproduced (dev); confirmed (prod) | Probe 1 S15; `server.ts:177` | Non-JSON errors confuse clients. | JSON error handler; 404 for unknown `/api`. |
| L4 | Low | Copy | The `mocks.incompleteBody` text says built-in material is shown instead, but nothing is substituted. | confirmed | `en.ts:102` | Misleading message. | Update the copy. |
| L5 | Low | Docs | README says grading returns a fixed sample response without a key; the code returns 503. | confirmed | `README.md`; `grading.ts:194` | Misleading documentation. | Update the README. |
| L6 | Low | Attempts | Practice attempts are client-reported (`POST /api/data/attempts` accepts any practice band). Exam attempts are refused. | reproduced | Probe 1 S8 | Affects only the learner's own plan and statistics. | Accept as design, or mark practice bands as self-reported. |
| L7 | Low | Dead surface | `/api/mocks/generate`, `/history`, `/:id` have no client caller but spend Gemini quota. | confirmed | grep | Unused cost and attack surface. | Remove or gate. |
| L8 | Low | Repository data | Per-user learning data is tracked in git (`data/users/usr_89Byxf2yeZsgb0fp/*`), intentionally per commit `fb82b24`. | confirmed | `git ls-files data` | Personal study data in version control. | Keep a deliberate decision on record. |
| L9 | Low | Firestore growth | `rate_limits` and `auth_sessions` documents are never deleted except on use. | confirmed | `requestRateLimitService.ts:24`; `authService.ts:76` | Unbounded collection growth. | Firestore TTL policies. |
| L10 | Low | AI output validation | Only `band_overall` is range-checked; criterion bands and non-half-band values are accepted. | confirmed | `grading.ts:139,204,273` | Odd bands shown in practice; exam rounding absorbs them. | Validate criterion bands. |
| L11 | Low | Input size | `express.json({ limit: '16mb' })` applies to every route, including anonymous `/api/auth/*`, before rate limiting. | confirmed | `server.ts:30` | Parse-cost denial-of-service surface. | Route-specific limits. |
| L12 | Low | Local runtime | Local stores read and rewrite whole JSON files synchronously per request; the rate-limit file grows without pruning. | confirmed | `requestRateLimitService.ts:25`; `authService.ts:40-43` | Local mode only. | None unless local mode is used beyond development. |

## Detailed findings

### C1 — Exam answer keys are available through practice marking — Critical, reproduced

- **Route:** `POST /api/learner/practice/mark`.
- **Code path:** `learnerContentRoutes.ts:139-149` → `practiceMarking.ts` `markPractice` → `adaptedFor({kind:'bundle'})`. It uses `openSitting` for any published bundle, and a material source for any published material. Every question's `answers` and `explanation` are returned regardless of what was submitted.

**Reproduction (Probe 1)**

1. A signed-in learner POSTs `{"source":{"kind":"bundle","bundleId":"<published exam bundle>"},"section":"reading","answers":{}}`. The response is 200 with 40 results, each carrying the correct answer, e.g. `["rea-p1-q1","gamma1"]`. The same request for `listening` also returns 40.
2. The learner opens the exam session for the same bundle and submits those answers. Result: `listening {"correct":40,"total":40,"band":9}` and `reading {"correct":40,"total":40,"band":9}`.

**Behaviour**

- **Expected:** answer keys never reach a learner before the learner has sat the exam content they belong to.
- **Actual:** exam content is also practice content by construction — bundles pin published materials, and published bundles and materials are both practice sources. Practice marking reveals keys unconditionally.
- **Why it matters:** exam attempts are stored as server-marked results. Their integrity is the purpose of the Phase 14 session design.

**Recommendation.** This needs a product decision, not only a patch. Either:
- segregate exam-only content from practice (exam bundles and their components are not practice sources); or
- only return feedback for questions the learner actually answered, and never for a bundle that is available as an exam.

Rate limiting alone does not fix it.

**Resolution (Phase 18)**

- **Policy.** A material named by any component of a currently published bundle — any of the nine slots, any section — is exam content and not practice content while that bundle is published. A published bundle itself is never practice content.
- **Enforcement point.** `src/services/practiceEligibility.ts`: `loadExamUse()` reads the published bundles on every call, and `practiceEligibility(materialId, use)` is the single rule.
  - It is applied in `practiceMarking.ts` `adaptedFor`, the one resolver behind both practice detail (`GET /api/learner/materials/:section/:id`, `GET /api/learner/bundles/:id`) and marking (`POST /api/learner/practice/mark`), before any content or key is built.
  - Refusals are 403 `exam_content`, with no content.
  - The learner catalog carries a `practiceAvailable` hint from the same rule; the UI disables exam content and no longer offers published bundles for practice. The API does not rely on either.
- **After the bundle is unpublished or archived.** When no published bundle names a material any more, it is ordinary published content and can be practised again. Republishing makes it exam content again; that cannot take back keys seen in between.
- **Previous practice attempts.** They stay accessible: they store bands only, no keys.
- **Residual risks.**
  - A published material is practice content from publication until a bundle that pins it is published.
  - The rule is by material id, so re-authoring the same questions under another id is not detected (content management).
  - Exam-session score counts (H11, resolved in Phase 19).
- **Verification.**
  - `tests/practiceEligibility.test.ts` (10 behavioural tests) and updated `practiceKeys`/`bundleExam` tests; 7/7 mutations caught, including removing the central check.
  - Browser: exam materials shown as "In an exam" and disabled; forged HTTP requests refused with no answer data; practice available after unpublishing through the admin UI; refused again on republish.

### H1 — One thrown error in an async route exits the server — High, reproduced

**Code path.** Express 4 does not catch rejected promises from async handlers, and nothing registers `process.on('unhandledRejection')`. Handlers without try/catch:

- `adminRoutes.ts:221` — `GET /materials`
- `adminRoutes.ts:231` — `GET /materials/:section/:id`
- `adminRoutes.ts:303` — `DELETE /materials/:id`
- `adminRoutes.ts:304` — `DELETE /materials/:section/:id`
- `adminRoutes.ts:323` — `publish-check`
- `adminRoutes.ts:365` — `GET /public/materials/:section` (**anonymous**)

**Reproduction**

- **Probe 1 S17.** With an admin session, `GET /api/admin/materials/reading/..%2F..%2Fusers`. `assertId` throws "Invalid identifier." and the process exits. The next `/api/health` fails with `fetch failed`. Earlier runs crashed the same way on a 200-character id. An examiner session is sufficient (the route needs `requireAdminAuth` only).
- **Production build.** With `NODE_ENV=production` and `STORAGE_BACKEND=gcs_firestore` but no credentials:
  - `/api/health` returned `{"status":"ok"}` and `/` served the SPA;
  - the first request that reached Firestore (the rate limiter) terminated the process with "Could not load the default credentials", thrown from inside google-gax;
  - `authenticateRequest`'s own try/catch did not contain it.

**Behaviour**

- **Expected:** a 400/404 or 500 JSON response, with the process still running.
- **Actual:** process exit.
- **Impact:** every in-flight learner request fails and exams stall until the platform restarts the instance.
  - The anonymous public route has the same flaw for any Firestore error. That path is confirmed by code but was not demonstrated with a real Firestore failure (hypothesis).
  - Because `/api/health` does not check storage, a misconfigured deployment passes health checks and crash-loops.

**Recommendation.** Add an async error wrapper and a final JSON error handler, a process-level log-and-survive policy, and a startup or health check that exercises storage.

**Resolution (Phase 20)**

- **Crash paths before.** Reproduced by running the real `server.ts` in a child process.
  - **Local storage.** An admin request to any of these routes, with an encoded traversal id or a 200-character id, exited the process with code 1:
    - `GET /materials/:section/:id`;
    - its `publish-check`;
    - `DELETE /materials/:section/:id`;
    - `DELETE /materials/:id`.
    `assertId` threw inside an async handler with no try/catch. Express 4 does not await the handler, so the rejection went unhandled and Node exited. The connection was reset and the next `/api/health` got no answer.
  - **Firestore with `FIREBASE_PROJECT_ID` set and no credentials.** The first request that reached Firestore exited the process after about 3 s. That covered the admin security check on the anonymous `/api/admin/public/*` routes, learner and admin sign-in, `/api/auth/me`, and `authenticateRequest` on every learner route.
    - The Firestore client (google-gax) creates promises for its own connection setup that nothing awaits. Each one rejected with "Could not load the default credentials" by itself.
    - The caller that was actually waiting received the same error only after about 10 s, so no route try/catch could contain the first rejection.
    - Without a project id the same requests did not crash. They answered 429 "Request could not be validated." or 401.
    - In both cases `/api/health` said `ok`.
  - **Uncontrolled but not a crash.** Malformed JSON on any route got Express's HTML error page, with a stack trace and file paths in development. multer upload errors got a 500 HTML page with a stack trace.
- **Design.**
  - **`src/http/asyncHandlers.ts`: `guardAsyncHandlers(appOrRouter)`.**
    - Applied where the app and each router are created: `server.ts` and the admin, auth, source, bundle, user-data, learner-content, exam-session and mock routers.
    - Every handler registered through it has a returned promise's rejection passed to `next`.
    - A rejection that is not an `Error` is wrapped, so it can never act as `next('route')`.
    - Error handlers keep their four parameters.
    - This is one wrapper. No route was rewritten.
  - **`src/http/errorBoundary.ts`: `apiErrorBoundary`.** Registered once in `server.ts`, after every `/api` route and before the app shell. It answers `{ error, code }`:

    | Cause | Status and code |
    |---|---|
    | `ClientRequestError` | its own status (`invalid_id` 400, `unsupported_file_type` 400) |
    | body-parser | `invalid_json` 400, `payload_too_large` 413, `unsupported_encoding` 415 |
    | multer | `file_too_large` 413; `too_many_files`, `unexpected_file`, `invalid_upload` 400 |
    | storage unavailable | `storage_unavailable` 503 |
    | anything else | `internal_error` 500 |

    - Storage unavailable is decided by `src/services/storage/availability.ts`: a gRPC error with code 4, 7, 8, 14 or 16 and details, or google-auth's missing-credentials or missing-project message.
    - The body carries a fixed message for its class, never text taken from the error.
    - The log carries the method, path, user or admin id, status and code. A 5xx also logs the error with its stack; a 4xx is a one-line warning.
    - A failure after the response has started closes the connection.
  - **`src/http/processGuards.ts`: `installProcessGuards()`**, called in `server.ts`.
    - An `unhandledRejection` is logged and the process keeps serving. The request that caused it still gets its own answer through the boundary.
    - An uncaught synchronous exception keeps Node's default exit.
  - **Middleware that turned a failing store into a client error now forwards it:**
    - `authenticateRequest` (was 401);
    - `enforceAdminSecurity` (was 429);
    - `requireAdminAuth` (was 403).

    A cookie that is not valid percent-encoding is still 401 or 403. Learner sign-in, `me`, register, forgot and reset password, and admin sign-in forward only storage-unavailable errors, and keep their own refusals.
  - **Client errors.** `adminStore.assertId` throws `InvalidIdentifierError`, with the same message, so existing route catches answer as before. The admin upload file filter refuses with a 400 `ClientRequestError`.
  - **`/api/health`.** `checkStorageHealth()` reads one document through the same Firestore client and collection the rate limiter reads on every request; it never writes. On local storage it checks that the data directory is readable and writable. The check is bounded at 5 s. Answers:
    - 200 `{ status: 'ok', aiConfigured, storage: { backend, status: 'ok' } }`;
    - 503 with `status: 'unavailable'`.
- **Status semantics.**
  - Malformed input is 400, unauthenticated 401, forbidden 403, a missing resource 404, storage unavailable 503, and a defect 500. Route-level refusals are unchanged.
  - Routes that already answered their own errors are unchanged, including exam-session routes (500 `invalid_bundle` on an unexpected error).
  - Routes that answer 404 on any read error are also unchanged: admin and learner assets, and a source by id. With Firestore down they are reached only through the rate limiter, which now answers 503 first.
- **Security.** Error bodies are tested for:
  - stack frames and file paths;
  - `node_modules`;
  - library names (google-gax, firebase, grpc);
  - error class names;
  - the credentials message;
  - a secret embedded in an error.

  Boundary answers are built only from fixed strings, so no source text, answer key or provenance can reach one.
- **Not changed.** Scoring, exam-session semantics, practice policy, Book → Test, the CDI parser, H2–H10, logging beyond the boundary's lines, and the port (M1). An unknown `GET /api/*` still falls through to the app shell (the second half of L3).
- **Verification.**
  - **`tests/serverStability.test.ts` (6 tests).** Runs the real `server.ts` in a child process; a preload only moves ports 3000 and 24678 to free ports. Every failure is held to one sequence: a JSON error with the right status and nothing internal, the process still running, then a valid request that succeeds.
    - **Local storage:**
      - malformed material ids on five routes;
      - an unsupported upload;
      - a source upload with two files;
      - malformed JSON to bundle, exam-session, learner-data and sign-in routes;
      - failures logged with route, actor and status;
      - health 200.
    - **Firestore without credentials:**
      - health 503;
      - anonymous public materials, learner data and sign-in 503 `storage_unavailable`;
      - the process alive and the app shell 200;
      - health answers again;
      - the boundary and process-guard lines in the log.
  - **`tests/errorBoundary.test.ts` (13 tests).**
    - **Synthetic failures:** a rejection, `next('route')` misuse, a synchronous throw, a client-error status, gRPC unavailable, missing credentials, bad JSON, an oversized body, upload limits, and a failure after the response started.
    - **Real routers over the in-memory Firestore, failed underneath:**
      - anonymous public materials 503, then 200 once Firestore answers (the former H1 hypothesis);
      - a failing rate limiter answers 503 for admin, learner and sign-in requests (was 429 or 401);
      - a failing session store answers 503;
      - invalid cookie encoding still 401 or 403;
      - a malformed id 400;
      - health ok, unavailable, and unavailable on timeout.
  - **Suites.** Full suite 590/590. `tsc --noEmit` clean. The two new suites passed three consecutive runs, 19/19 each.
  - **Mutations: 8/8 caught.** Each of these made the new suites fail:
    - guard bypassed;
    - boundary not registered;
    - process guard not installed;
    - `authenticateRequest` 401 again;
    - health not checking storage;
    - boundary sending the error message;
    - storage failures not recognised;
    - a malformed id thrown as a plain `Error`.
  - **Probe over the real `server.ts` (dev mode), before and after.**
    - Local cases A1–A5: process exit before; 400 JSON after.
    - Upload, bundle, session, sign-in and learner cases: HTML errors before; JSON 400 after.
    - Firestore cases F2–F7: process exit before; 503 JSON with the process alive after.
    - `/api/health` answers 503 with Firestore unavailable.
  - **Browser (real admin UI, dev server, the user's own session).**
    - In the Reading editor, a file named `notes.exe` went to the text-document upload zone. The request got 400 `{"error":"Unsupported file type: .exe","code":"unsupported_file_type"}`, and the zone showed that message; before this phase the response was a 500 HTML page.
    - A `.txt` file then attached normally (200), and `/api/admin/materials` and `/api/health` answered 200.
    - The same session's direct request to `/api/admin/materials/reading/<200 characters>` answered 400 `invalid_id`, and the next requests succeeded.
    - The server log recorded both failures with route, admin id and status.

### H2 — Rate limits shared by everyone behind one IP — High, reproduced

**Code path.**
- `authenticateRequest` checks `api:${req.ip}` against `api_global` (120 requests per minute).
- The auth routes use `login:${req.ip}` (20 per 10 minutes) and `register:${req.ip}`.
- `enforceAdminSecurity` uses `admin:${ip}`.
- `app.set('trust proxy', …)` appears nowhere.

**Reproduction (Probe 1 S16).** Learner "ben" polled `/api/learner/exams` from 127.0.0.1 and got 429 at request 84, after earlier probe traffic. Learner "ana", on the same IP, then got **429** on `/api/data`.

**Behaviour**

- **Expected:** one learner's traffic does not throttle another learner.
- **Actual:** one shared budget per IP. Behind a reverse proxy without `trust proxy`, `req.ip` is the proxy's address, so the whole platform shares one budget.
- **Why it matters:** the exam client flushes answers 700 ms after typing stops and drafts after 1.5 s. A handful of active learners saturate 120 per minute, and failed autosaves show save errors mid-exam. Twenty failed logins per 10 minutes, platform-wide, lock out sign-in for everyone.

**Recommendation.** Set `trust proxy` for the actual proxy hop count, key authenticated limits by user id, and size budgets against exam traffic.

### H3 — Private original of an imported page reachable by learners — High, reproduced

**Code path.**
1. The Reading and Listening editors and the import review store `content.assetIds` including `sourceAssetId`: `AdminReadingEditor.tsx:130`, `AdminListeningEditor.tsx:119`, `cdiImport/review.ts:400-425`.
2. `toLearnerMaterial` removes `sourceAssetId` but not `assetIds` (`sittingView.ts:408,424`).
3. `collectPublishedAssetIds` runs `extractAssetIds` over the learner view (`learnerContentRoutes.ts:179-187`).
4. `extractAssetIds` matches any key ending in `assetIds` (`assetStore.ts:313`), so the original is on the learner allowlist.

**Reproduction (Probe 1 S4).**
- An imported page containing `SECRET-KEY-MARKER` in its printed answer key section was published as a Reading material with `sourceAssetId` and `assetIds: [sourceAssetId]`.
- `GET /api/assets/<sourceAssetId>` as a learner returned **200**, `attachment`, and the body contained the marker.

**Behaviour**

- **Expected:** 404. The Phase 14.1 design says the untouched original is never learner-reachable.
- **Actual:** downloadable.
- **Mitigation:** S10 found the id in no learner payload (practice material, practice bundle), and ids are `nanoid(16)`. Exploitation needs the id from elsewhere (admin UI, logs, a shared link), so this is not Critical.

**Recommendation.** Drop `assetIds` (or source ids) from the learner view before building the allowlist, and add a behavioural test.

### H4 — Editing a published material skips the publish gate — High, reproduced

**Code path.** `respondWithSave` → `adminStore.saveMaterial` → `finalise` keeps `status: previous.status` (`adminStore.ts:144`). The gate `publishBlockers` runs only in `setMaterialStatus` (`adminStore.ts:256-258`).

**Reproduction (Probe 1 D1).**
- A published Reading material was saved with `theme: ""` and `questions: []`. PUT returned 200 with `status: published`.
- The learner `GET /api/learner/materials/reading/<id>` returned 200 with 0 questions.
- `publish-check` on the same material now reports `["classification_incomplete","no_questions"]`.

**Behaviour**

- **Expected:** a published material cannot be left in a state the gate refuses.
- **Actual:** it stays published. The same path lets a confirmed generated question be edited after publication without re-confirmation (`generation_confirmation_stale` is only evaluated on publish).
- **Limits:** bundles are protected by pinned hashes (`component_changed`); the practice catalog is not. The schema still rejects structurally invalid questions on save.

**Recommendation.** Re-run the gate on saves of published materials (refuse, or unpublish), or require unpublish-before-edit as bundles already do.

**Resolution (Phase 21)**

- **Write paths audited.**
  - `saveMaterial`: every POST/PUT `/api/admin/materials` route. It serves the four material editors and the import and generated-draft review (`toSavePayload`). Book → Test also calls it, but only to create a new draft.
  - `setMaterialStatus`: `/materials/:section/:id/(publish|unpublish|archive|restore)`.
  - `appendGenerationReview`: `/sources/generated/:id/questions/:questionId/reviews`.
  - `deleteMaterial`: both DELETE routes.
  - Asset changes are content edits (asset ids and URLs in content). The reaper removes only unreferenced assets.
- **What could happen to a published material before.**
  - Every save kept `published`: content, questions, classification and asset references alike.
  - A reviewer decision could land on a published material if a publish slipped in after the route's draft check.
  - Publish gated one read, then merged `status` into whatever row existed at write time. On Firestore nothing was transactional.
  - Delete checked for `published` only in the route.
  - Nothing detected a stale editor overwriting someone else's change.
- **Policy: the smallest behaviour consistent with explicit publishing.**
  - A save that changes a published material in any way writes it back as `draft` in the same write (`adminStore.saveMaterialDetailed` → `applySave`). "Any way" means anything in the stored record except the revision stamp.
  - It reaches learners again only through Check and Publish.
  - There is no metadata exception. The one save that leaves a material published is one that leaves the whole record identical (`materialRecordFingerprint`); nothing is written.
  - Drafts stay drafts and archived materials stay archived.
- **Invariant.**
  - Learners read only rows stored as `published`.
  - The only write that sets `published` is `setMaterialStatus`. It gates the row it read and writes the status onto that same row: the local store re-reads and compares the revision, and Firestore does both in one transaction. Otherwise it refuses with 409 `material_changed_during_publish`.
  - Every other write that changes a published row sets it to `draft` in the same atomic write.
  - So after every successful write, a published material passes its gate on exactly the stored content, with no window in which learners could see anything else.
- **Concurrency.**
  - Saves through the admin API must name the revision (`updatedAt`) they were opened at, checked inside the write. A missing revision is 428 `material_revision_required`; a stale one is 409 `material_stale`.
  - Revisions strictly increase, so two writes within one millisecond cannot share one.
  - Status transitions and reviewer decisions also advance the revision, so an editor opened before a publish cannot save over it unseen.
  - `appendGenerationReview` accepts only a draft, and `deleteMaterial` refuses a published material, both inside the write.
  - On Firestore, save, status transitions, reviewer decisions and delete each run in a transaction. Material writes keep `merge: true` (H5 unchanged).
- **Bundles.**
  - Editing a material pinned by a published bundle withdraws it. The save response lists the published bundles affected, and the dashboard says they cannot be opened.
  - Learners get `component_unpublished`. Once the material is republished they get `component_changed` until the bundle is re-pinned.
  - Nothing is re-pinned or replaced automatically.
- **UI.**
  - The four editors send `updatedAt`. The generated-draft review sends it too, refreshed after a reviewer decision.
  - The dashboard says when a save withdrew a published material, or changed nothing.
  - Conflicts show the server's message.
- **Tests.**
  - **`tests/publishedMaterialProtection.test.ts` (10 tests).** After every write, each test checks from storage that every published material passes its gate. They cover:
    - the exact Phase 17 reproduction: publish, then save with no questions and no theme. Result: draft, learner 404, publish 409;
    - a valid edit also withdraws, and republishing serves the edit;
    - changing an answer, adding or removing a question, or changing the title, theme, band, module or an asset reference each withdraws;
    - a reference to a missing asset withdraws and blocks publishing;
    - an unchanged save writes nothing and stays published;
    - a missing revision gets 428, a stale revision gets 409 and the first edit is kept, and exactly one of two simultaneous edits succeeds;
    - a save from an editor opened before a publish is refused;
    - a save landing while the gate reads the material aborts the publish;
    - a reviewer decision and a delete are refused on a published material.
  - **Updated to the new policy:**
    - `bundleExam`: an edit gives `component_unpublished` and names the bundle; after republishing, `component_changed` until re-pinned;
    - `examSession`: a mid-exam edit stops the sitting, and restoring the pinned content is itself an edit that needs republishing before the sitting resumes;
    - `firestoreExam`: the same on the Firestore path, in one transaction;
    - `materialPipeline`: a claimed status is ignored as a no-op.
  - **Revisions threaded** through `bookToTest`, `questionQuality` and `materialLifecycle`.
  - **Suite:** full suite 600/600, `tsc --noEmit` clean.
  - **Mutations: 8/8 caught.**
    - status transition bypassed;
    - publish gate bypassed;
    - published kept after invalid content;
    - stale write accepted;
    - revision not required;
    - publish written onto a row the gate did not read;
    - reviewer decision accepted on a published material;
    - published material deleted by the store.
- **Browser (real admin UI, dev server, the user's own sessions).**
  - Created "H4 Browser Check Reading" in the Reading editor. Check said publishable. After Publish, the learner saw it listed and could open it (2 questions).
  - Opened it in the editor, deleted both questions, cleared the theme and saved. The request carried the revision, and the response was 200 with `status: draft` and `unpublished: true`.
  - The catalog showed Draft, "no theme", 0 questions. The learner catalog no longer listed it, and opening it gave 404. Check listed the missing theme and the missing questions.
  - Fixed it (theme "Corrected Navigation", one new question) and saved. It was still a draft and the learner still got 404. Check said publishable; Publish returned 200.
  - The learner catalog listed it with the corrected theme and 1 question. Opening it served the corrected prompt, with no answer key.
- **Not changed.**
  - Scoring, Book → Test generation, the CDI parser, the lifecycle states and transitions, and H2, H3 and H5–H10.
  - `cdiImport/review.ts` gained only the optional revision, passed into the save payload.
- **Residual.**
  - A row written before revisions were stamped accepts its first save without a revision check, since there is nothing to compare, and is stamped by that save.
  - A bundle still relies on its pinned hashes to refuse a changed material (M9 unchanged).

### H5 — Firestore keeps fields an edit removed — High, reproduced on the fake, unverified on real Firestore

**Code path.** `adminStore.ts:112` writes `ref.set(item, { merge: true })`. Firestore merges nested maps field by field, so keys absent from `item.content` keep their old values. The local store replaces the row. `sourceStore.save` also merges (`sourceStore.ts:83`).

**Reproduction (Probe 3).** On the Firestore path, a Reading material was saved with `passage.htmlContent`, then saved again without it.

| F | Result |
|---|---|
| F1 | `returnedBySave.htmlContent = undefined`, but `storedAfterSave.htmlContent = "<p>OLD PASSAGE MARKUP…"`. |
| F2 | `hash(returned) ≠ hash(stored)`. |

**Why it matters.** The learner adapters prefer `htmlContent` over `text`, so a learner keeps seeing the old passage after an admin removed it. The same applies to any optional nested field: an audio asset id, a Speaking model answer, an import's `htmlContent`. Production and local behave differently, which is exactly what the Firestore adapter must not do.

**Recommendation.** Write the fully validated material without merge. Verify on an emulator.

### H6 — Exam Writing/Speaking lost at the deadline — High, reproduced

**Code path.**
- `examSession.gradeWriting` checks `writingOpen`, calls the grader, then re-checks `writingOpen` on the post-grading clock and refuses with `section_closed` (`examSession.ts:299-319`). Speaking is the same (`:322-350`).
- At the deadline, `closeCurrent` expires Writing when either task has no band (`examRun.ts:299-305`). Drafts saved through `writing_draft` are never graded.

**Reproduction (Probe 2 A).** Both Writing tasks were submitted with 10 seconds left, and the grader took 25 seconds. Result: `409 section_closed`, Writing `status=expired`, `band=undefined`, no tasks recorded — so the attempt can only be incomplete, with no overall.

**Behaviour**

- **Expected:** work submitted in time is scored; the Phase 15 audit already lists "Writing is still scored officially when a task is missing" as unresolved.
- **Actual:** refused.
- **Why realistic:** real grading calls take seconds to tens of seconds, and under fallback far longer (Probe 2 B1: 11 s of 503s before failing). Learners commonly submit in the last minute.

**Recommendation.** Stamp acceptance at submission and grade afterwards, and decide the policy for drafts at the deadline. Until then, list this as a known limitation.

### H7 — AI calls: no timeout, triple quota use, wrong error at the limit — High, reproduced

**Code path.**
- `executeGeminiWithRetry` passes no `attemptTimeoutMs`/`totalTimeoutMs` (`geminiRetry.ts:310-315`).
- The SDK client has no `httpOptions.timeout` (`grading.ts:36`).
- `gradeWithFallback` calls `executeGeminiWithRetry` once per model, and each call consumes quota (`grading.ts:47-49`, `geminiRetry.ts:295-298`).
- `AiQuotaExceededError` is not an `AiUnavailableError`, so grading answers 500 `grading_failed` (`grading.ts:206-210`).

**Reproduction (Probe 2).**

| Step | Result |
|---|---|
| B1 | All models return 503: 9 model calls across 3 models, 11 s, **3 hourly quota units** used for one grading. |
| B2 | The next grading (limit 4/hour) returns **500 "Failed to grade writing submission."** |
| C | The model never answers: the request is **still pending after 90 s**. |

**Impact.** The defaults are 4 Writing and 4 Speaking gradings per hour. One outage while a learner works on an exam can exhaust quota. The learner then cannot complete Writing or Speaking, and H6 turns that into an incomplete attempt. Hung requests hold server resources.

**Contrast.** Book → Test already has explicit timeouts (60 s per attempt, 100 s total) and idempotency (`bookToTest/reliability.ts`, `generationLog.ts`).

**Recommendation.** Timeouts on every grading/chat/rewrite/transcribe call; one quota charge per logical grading; a 429 `quota_exceeded` response with a clear message.

### H8 — Listening audio on Safari/iOS — High

**Status:** reproduced on the server; confirmed on the client; unverified on a device.

**Code path.**
- `sendAsset` sends the whole buffer with `res.send` and no `Accept-Ranges` (`adminRoutes.ts:77-85`).
- The exam's `playOnce` sends `onAudioStart(part)` to the server **before** `element.play()`, and on rejection only resets local state (`ListeningSession.tsx:86-92`).

**Reproduction (Probe 1 S4b).** `Range: bytes=0-99` on a learner audio asset returned `200`, `accept-ranges=null`, and the full 16,044 bytes.

**Behaviour**

- **Expected:** 206 partial content for media, and a part counted as started only once audio is actually playing.
- **Actual:** no range support, and a failed `play()` (autoplay policy, format, network) permanently consumes the part.
- **Unverified:** actual Safari/iOS playback failure. No Apple device or Safari was available; the byte-range expectation is Apple's documented requirement for media servers.

**Recommendation.** Range-capable asset serving; record `audio_started` after the `playing` event; test on Safari/iOS.

### H9 — Runtime dependencies misdeclared — High

**Status:** confirmed (manifest and imports); hypothesis (boot failure when devDependencies are pruned).

| Package | Declared as | Used at runtime in |
|---|---|---|
| `multer` | devDependency | `adminRoutes.ts:2` and `sourceRoutes.ts:2` (static import, loaded at boot) |
| `mammoth` | devDependency | `adminRoutes.ts:6`, `sourceIngest/extract.ts:188` |
| `pdf-parse` | devDependency | `adminRoutes.ts:143`, `extract.ts:149` |
| `nanoid` | undeclared (resolves to transitive 3.3.18) | several stores |

`npm run build` bundles with `--packages=external`, so `dist/server.cjs` resolves these from `node_modules` at runtime. A production install with `--omit=dev` (common on PaaS) would fail to start. That install was not executed here.

There is no `engines` field; the production bundle booted on Node 24.15.

### H10 — Firestore production path largely unverified — High, unverified

See the Firestore audit. In summary:
- no real project or emulator run;
- the fake serialises all transactions, so real optimistic contention is not modelled;
- the fake lacks `orderBy` (Probe 3 F3: `getRecentGenerations` throws on the fake);
- authentication, quotas, rate limits, sources, Book → Test ledger and chunks, and user tasks/checklist/vocab never run against it.

### H11 — Exam-session score counts as an answer oracle — High (added in Phase 18)

**Status:** reproduced (exposure); hypothesis (derivation).

- **Route:** `POST /api/learner/exams/:id/events` and `GET /api/learner/exams/:id`.
- **Code path.** `toRunView` spreads `progressOf(state)`, so each section record's `objective {correct,total,band}` and `band` reach the browser as soon as the section closes (`examRun.ts:217-228`), not when the exam ends. The exam UI hides bands until the end; the API does not.
- **Reproduction (exposure).**
  - Phase 17 Probe 1 S9b read `listening {"correct":40,"total":40,"band":9}` from the events response while Reading was still in progress.
  - `examSession.test.ts` asserts `listening.objective.correct` mid-exam.
- **Derivation (not executed).**
  - Open → start → answer a chosen subset → submit and finish Listening → read the count → abandon → reopen a fresh session → repeat. Count changes reveal which candidate answers are correct.
  - Practical for closed-choice questions (MC, TFNG/YNNG, matching) with automation.
  - Bounded by the section timer when early finish is disabled, and by rate limits.
- **Recommendation.** Withhold per-section counts and bands from the run view until the attempt is finished; consider a cap on abandoned sittings per bundle.

**Resolution (Phase 19)**

- **Leaks found.** Before the change, marks reached the learner in two places:
  - **Every session view.** `toRunView` spread the stored progress into `run`: each closed section's `objective {correct,total,band}` and `band`, each graded Writing task's `band`, and each graded Speaking part's `band`. This affected open, resume, `GET`, events (answers, submit, finish section, sync, tick) and abandon.
  - **Writing/Speaking grading responses** (`POST /api/learner/exams/:id/writing/:task`, `/speaking/:part`). These returned the grader's whole `result`: bands, criteria, commentary and annotations.
- **Policy.** Until the exam has finished, a learner sees only the operational state of the sitting and their own work. Marks appear only once the last section has closed — the learner finished it or its time ran out.
- **Contract.** `src/types/examSession.ts`, built only by `src/services/examDisclosure.ts`. The builder lists the fields that go out; it never deletes the ones that should not. A field added to the stored run later stays withheld until someone adds it there.
  - **`run: LearnerRunView`.** Always sent, never a mark. It carries:
    - the attempt id and the plan (sections, parts and question ids, with no question content);
    - per section: status, start, deadline, end and who ended it;
    - the learner's own answers, submission time and drafts;
    - graded Writing tasks as `{ essay }` and graded Speaking parts as `{ transcript }`;
    - Listening audio starts;
    - the current section index and the exam start/finish times.
  - **`result?: ExamResultView`.** `complete`, `overall`, section `bands`, and Listening/Reading `raw {correct,total}`. Only when the run has `finishedAt`.
  - **`attempt?`.** Only once the finished attempt is stored (unchanged).
  - **Grading responses.** `WritingGradedResponse` and `SpeakingGradedResponse` are `{ view }`. The band is recorded in the session; the grader's feedback is not returned in an exam.
  - **Session list.** `ExamSessionSummary` has no marks (unchanged).
- **Enforcement points.**
  - `examSession.ts` `viewOf` is the only place a session view is built for any route.
  - `gradeWriting`/`gradeSpeaking` return `{ view }` only.
  - `ExamMode` reads the final screen from `result`.
  - The client no longer computes a result from the run.
- **Unchanged.**
  - Marking still happens on the server when a section closes.
  - Stored progress still holds `objective`, section bands and task/part bands, and the stored attempt keeps its raw scores and bands.
  - Scoring rules, practice policy, Book → Test, the CDI parser and the bundle schema are unchanged.
- **Side channels.**
  - **HTTP status.** Identical for right and wrong answers; the attack test compares every status across rounds.
  - **Response body.** Identical for right and wrong answers once session ids, timestamps and the learner's own answers are normalised; asserted by the attack test.
  - **Event names and error codes.** No event or error depends on correctness. Forged `reveal_score`, `finish_exam`, `writing_graded`, `tick` and `sync` with extra fields are 400 "Invalid exam events." with no marks. Query parameters are ignored, another learner gets 404, and marking has no error of its own.
  - **Progress.**
    - A closed Listening/Reading section is `completed` whatever the score.
    - Finish-section readiness depends on whether answers were submitted and tasks/parts graded, not on correctness.
    - There are no progress percentages.
  - **Completion messages.**
    - Listening/Reading say "Answers submitted. They are marked when the exam ends."
    - Writing/Speaking say the task was graded and recorded, with bands shown after the exam.
    - The exam-mode submit button no longer says "Submit and see my band"; it says "Submit answers" (the practice label is unchanged).
  - **Result summaries.** `/api/data` holds only stored attempts; an active or abandoned sitting stores none (tested). The statistics page reads stored attempts only.
  - **Timing.** Marking is the same in-memory comparison for right and wrong answers when a section closes. Not measured.
- **Residual.**
  - **Finished sittings show marks, by design.** Using that as an oracle costs a whole sitting per probe. Writing and Speaking must be graded (AI quota, 4/hour each by default) or wait out their timers (about 74 minutes under reference timing). Each probe also leaves a stored attempt in the learner's history.
  - **Abandoned sittings are still unlimited.** They now reveal nothing, so no cap was added.
- **Verification.**
  - **`tests/examOracle.test.ts` (8 tests).**
    - The exact H11 attack: two rounds with right vs wrong answers. The server stores 40 vs 0 correct; every response is mark-free, with identical statuses and identical normalised bodies.
    - Open/start, closing Listening and closing Reading all return no count or band.
    - Writing/Speaking grading responses carry no band or feedback, while the stored bands are 7.
    - Resume by reopen, `GET` and list returns no marks.
    - Forged, foreign and query-parameter requests reveal nothing.
    - The finished exam returns `result`, and it matches the stored attempt (raw score and bands).
  - **Updated tests.** `tests/examSession.test.ts` now reads mid-exam marks from stored progress and asserts the responses carry none.
  - **Mutations: 6/6 caught.**
    - Section `objective` back in the view.
    - Section `band` back in the view.
    - Writing task band back in the view.
    - `result` before finish.
    - Grading response returning the grader's result.
    - Stored progress spread into `run`.
  - **Browser (real learner UI, fetch responses recorded in the page).** Every learner response before the finish carried no marks, while the stored progress held them.
    - Answered a Listening subset (one right, one wrong); submitted and finished Listening; did the same for Reading. Server stored 1/40 for each.
    - Reloaded the page and resumed from the catalog (`resumed: true`).
    - Graded both Writing tasks and all three Speaking parts with real Gemini. Stored bands: 7.5/6.5 and 8/8/8.5.
    - Finishing Speaking returned `result` (overall 5.0; L 2.5, R 2.0, W 7.0, S 8.0; raw 1/40 and 1/40) and the stored attempt, and the results screen showed them.
    - Then repeated the attack in the UI: new sitting, a wrong Listening answer, finish Listening, abort, reopen. Stored 0/40 vs the earlier 1/40; every response had no marks.
    - Speaking Part 3 first answered 500 `grading_failed` twice because the learner's hourly Speaking quota was used up. Fallback models had charged quota for Part 2 (H7, unchanged). It graded once the hour rolled over.

## Security audit

All requests below were made against the real `server.ts` (Probe 1) unless stated.

| Boundary | Test | Result | Status |
|---|---|---|---|
| Anonymous → learner endpoints | `/api/data`, `/api/learner/materials/*`, `/api/learner/exams`, `/api/learner/practice/mark`, `/api/assets/:id`, `/api/grade/writing` | all 401 | reproduced — holds |
| Anonymous → admin endpoints | `/api/admin/materials`, `/api/admin/sources`, `/api/admin/assets/:id` | all 403 | reproduced — holds |
| Anonymous public summaries | `/api/admin/public/materials/reading` | 200; no keys, transcripts, provenance or source ids | reproduced — holds |
| Learner → admin | Learner token sent as `prep_auth` and as `prep_admin_auth` to materials (GET/POST), sources, assets | all 403 | reproduced — holds |
| Learner → other learner | B: GET session, POST events, Writing, abandon on A's session; B's session list | all 404; B lists 0 | reproduced — holds |
| Learner data routes | Scoped by session user id; no client-supplied user id | by code | confirmed — holds |
| Learner → private source asset | `/api/assets/<imported original>` | **200 with the printed key** | reproduced — **H3** |
| Draft / archived materials | By id, and via practice marking | all 404 | reproduced — holds |
| Draft bundles | Learner bundle 409, exam open 409, public summary 404, practice marking 409 | refused | reproduced — holds |
| Exam session ownership | See above; `getExamSession` is keyed by user | holds | reproduced |
| Attempt ownership / forging | Exam-shaped attempt via `/api/data/attempts` 403; practice attempt accepted, visible only to its owner | holds (L6) | reproduced |
| Answer-key leakage | Practice payloads (material, bundle) and exam paper: none | holds | reproduced (S10) plus Phase 14.1 tests |
| Answer-key leakage via marking | Empty practice submission | **keys returned** | reproduced — **C1** |
| Answer oracle via exam-session marks | Section counts/bands and grading feedback in session and grading responses before the exam ends | withheld until the exam finishes (Phase 19) | resolved — **H11** |
| Provenance / generation metadata | Not in learner payloads (S10); `withoutAnswerKeys` covers mocks | holds | reproduced / confirmed |
| Source asset id leakage | Not in learner payloads | holds | reproduced |
| Path traversal | Encoded `..%2F` on `/api/assets`, `/api/admin/assets`, `/api/admin/sources` | 404, no file content | reproduced — holds |
| Path traversal on `/api/admin/materials/:section/:id` | Encoded traversal id | no file read; was a **process crash**, now 400 `invalid_id` with the process running (Phase 20) | reproduced — **H1**, resolved |
| Unsafe HTML (`htmlContent`) | script, onerror, `javascript:`, iframe, `url()`, external img | all removed server-side | reproduced — holds |
| Unsafe HTML (other rendered fields) | `passage.text` with script/onerror | stored raw; client DOMPurify only | reproduced — **M5** |
| HTML upload sanitisation | Original kept private; derived sanitised copy; served with CSP sandbox and attachment | by code and existing tests | confirmed — holds |
| CSRF | Admin: Origin/Referer check + SameSite=Strict. Learner: SameSite=Strict only | safe for modern browsers | confirmed |
| API input validation | Zod on learner, exam, bundle and practice bodies; material schema on save | holds | confirmed |
| Rate limiting | IP-keyed and shared | **fails** | reproduced — **H2** |
| Error-message leakage | Dev: HTML stack for malformed JSON (L3), and multer upload errors as HTML with stack and file paths. Since Phase 20 every `/api` failure that reaches the error boundary is JSON with a fixed message and no stack, path or library text (tested for learner, public and admin routes). Material save still returns `error.message` to admins | low | reproduced (dev) / confirmed; `/api` part resolved |
| Security headers | None; `X-Powered-By: Express` | **missing** | reproduced — **M2** |
| Session handling | HttpOnly, SameSite=Strict, Secure in production; tokens stored hashed; role/version checked per request | holds | confirmed |

## Data integrity audit

| Area | Finding | Status |
|---|---|---|
| Material save / publish / delete transitions | Save never publishes; publish is gated; delete refused while published or referenced by any bundle. An edit to a published material was not re-gated (H4); since Phase 21 any change withdraws it to draft in the same write, saves name their revision, and publish, reviewer decisions and deletes re-check the row inside the write. | reproduced (D1); resolved (`publishedMaterialProtection`, updated bundle/session/Firestore tests) |
| Source ingestion states | Original stored first; `ready` written after chunks; failures stored with a reason. Firestore `saveChunks` is multi-batch and not atomic, but a failure leaves status `failed`, so chunks are not searchable. | confirmed |
| Asset reference counting | Computed by scanning materials and sources, not a counter. `reconcile` runs after save or delete; failures only logged. Firestore batch cap unhandled (M10). | confirmed |
| Reaper safety | Only unreferenced assets older than 24 h. Race: a manual reap concurrent with a save naming a >24 h staged asset can delete it (manual trigger; low likelihood). | confirmed / hypothesis |
| Bundle pinned fingerprints | Hash excludes provenance; published bundles re-gated on every open. | tests (bundleGate, bundleExam, firestoreExam) |
| Changed component detection | `component_changed` stops sittings; exercised by tests. | tested |
| Exam session revision checks | Compare-and-set with retries (local lock; Firestore transaction). Deterministic race test exists. | tested (local); tested indirectly (Firestore fake) |
| Attempt reconstruction | Server-built, verified before storing, idempotent by session id; content not snapshotted (M8). | tested + confirmed |
| Generated provenance / review history | Write-once generation record and append-only reviews enforced on save. Firestore `appendGenerationReview` is read-modify-write without a transaction, so concurrent reviews could drop one (hypothesis; low concurrency). | tested (local) / hypothesis |
| Draft reopening | Generated drafts reopen from the stored material. | tested (bookToTest) |
| Cleanup after failed operations | Import writes inline assets after parsing; save→promote/reconcile and delete→release swallow errors and log. | confirmed |
| Partial failure recovery | Multi-step operations (material write then asset state; source delete then reconcile; exam attempt write then session CAS) have no compensation. Attempt write is idempotent; the asset steps are reconciled on the next save. | confirmed |
| Local JSON corruption | Silent empty read then overwrite (M4). | reproduced (D2) |

## Firestore audit

`verified` would mean run against a real Firestore project. **Nothing in this table is verified.**

| Store / operation | Local semantics | Firestore implementation | Equivalent? | Status |
|---|---|---|---|---|
| `FirestoreDataStore` profile | Replace file | `set({profile}, {merge:true})`; profile schema has all-required fields | Yes in practice | tested indirectly (session tests read profile) |
| tasks / checklist / vocab | Replace file | Transaction: `tx.get(collection)`, delete missing, set others | Yes by design | unverified (no test; the fake's `tx.get` takes a document, not a collection) |
| attempts | Upsert by id under lock | `doc(id).set` | Yes | tested indirectly |
| exam sessions CAS | Lock + revision compare | Transaction get + revision compare + set; progress stored as a JSON string | Yes by design | tested indirectly (fake serialises transactions; real optimistic retries not modelled) |
| generated tests (mocks) | Array in file, newest first | `orderBy('timestamp','desc')` | Yes by design | unverified (fake lacks `orderBy`; Probe 3 F3) |
| daily quota | Lock + file | `FieldValue.increment` / transaction | Yes by design | unverified |
| `adminStore.saveMaterial` | Replace row | `get` then `set(merge:true)` | **No** — removed nested fields persist (H5) | reproduced on fake |
| `setMaterialStatus` | Rewrite row | `set({status,updatedAt},{merge:true})` | Yes; gate read and write not transactional | tested indirectly |
| `deleteMaterial` | Filter file | `get` + `delete` | Yes | tested indirectly |
| `appendGenerationReview` | Rewrite row | `get` + `set` (no transaction) | Yes serially; concurrent reviews can lose one | unverified / hypothesis |
| `bundleStore` | Rewrite file | Document `set` (replace); `setStatus` get+set not transactional | Yes serially | tested indirectly (firestoreExam) |
| `assetStore` create / get / list / promote | Files + JSON | Cloud Storage + `admin_assets`; batch `set(merge)` for state | Yes; batch >500 unhandled | tested indirectly (Cloud Storage stubbed) |
| `assetStore.readContent` | Local file | GCS download | — | unverified (stubbed) |
| `sourceStore.save` | Replace row | `set(merge:true)` | **No** (stale fields persist) | confirmed |
| `sourceStore.delete` | Filter + remove chunk file | One batch: all chunks + document | **No** for >500 chunks (M10) | confirmed |
| `sourceStore.getChunks` | Sort in memory | `orderBy('ordinal')` | Yes by design | unverified (fake lacks `orderBy`) |
| `generationLog` ledger | File + lock | Transactions | Yes by design | unverified |
| `authService` register / login / reset | JSON files | Transactions with queries, lockout via transaction, session documents | Yes by design | unverified (never exercised, even on the fake) |
| Admin bootstrap | Seeds or promotes from env | Not implemented (M3) | **No** | confirmed |
| Request rate limit | JSON file + lock | Transaction per request on a bucket document; never deleted | Yes; cost per request | unverified |
| AI quota | JSON file + lock | Transaction on day/hour documents | Yes | unverified |
| Undefined values | JSON drops them | `ignoreUndefinedProperties: true`; arrays with undefined still refused | Yes | tested indirectly (fake enforces) |
| Queries / filtering | In-memory filters | `where('status','==')`; `where('sourceId','==')` | Yes; no composite index needed for current callers | tested indirectly (status); unverified (sourceId) |
| Migrations | Read-time migration of legacy question shapes | Same function on read | Yes | tested indirectly |
| Local → Firestore data migration | — | None exists (M12) | — | confirmed |
| Transactions required but missing | `saveMaterial`, `setMaterialStatus` (gate check vs content write), `appendGenerationReview`, `bundleStore.setStatus` | read-modify-write without a transaction | Risk only under concurrent admin writes | confirmed |

## Exam correctness re-check (current state after Phases 15/16)

No new IELTS rules were introduced. Evidence is the existing tests unless stated otherwise.

| Area | Current behaviour | Evidence | Status |
|---|---|---|---|
| Section progression | L → R → W → S in order; server clock; early finish only when configured and content complete | `examRun.test.ts`, `examSession.test.ts`, Phase 14 browser E2E | holds |
| Completion conditions | L/R need submission; W needs both tasks graded; S needs 3 parts graded | `examRun.test.ts` (mutations killed in Phase 15) | holds |
| Timers | Deadlines from bundle minutes; ticks close sections on the server clock; client displays `serverNow` | `examSession.test.ts` "time is the server's" | holds |
| Listening once-only | Server records one start per part, kept across reload | `examSession.test.ts`, Phase 15 browser | holds, but **H8** (start recorded before playback succeeds) |
| Reading parts | 3 passages, 40 questions enforced at publish | `bundleGate.test.ts` | holds |
| Writing Task 1/2 | Graded per task against pinned prompts with the bundle module | `examSession.test.ts`, `writingModule.test.ts` | holds, but **H6/H7** |
| Speaking Parts 1–3 | Graded per part; section band is the average of 3 parts (non-official, documented) | `examRun.test.ts` | holds (known deviation) |
| Academic vs GT | Module-specific Reading conversion and Writing Task 1 grading; labels (Phase 16) | `examIntegrity`, `examRun`, `practiceKeys`, `moduleLabels` | holds |
| Score conversion / overall | Published tables; half-band rounding; Task 2 double weight; band 0 counted | `examIntegrity.test.ts` (mutation-checked) | holds |
| Failed AI grading | No band recorded, learner can retry; **but** quota and timeout behaviour (H7) and deadline (H6) | `examSession.test.ts`, Probe 2 | partial |
| Incomplete exam | No overall; attempt stored as incomplete and verified | `examSession.test.ts` | holds |
| Material changed during exam | Sitting stops with `component_changed`; resumes if content reverted | `examSession.test.ts` | holds (M9 operational) |
| Superseded bundles | Republish supersedes open sittings; fresh session on reopen | `examSession.test.ts` | holds |
| Attempt reconstruction | Verified against bundle pins before storing; content not snapshotted | `attemptVerification`, tests | holds (M8) |
| Key exposure around the exam | Paper carries no keys; practice marking reveals them | Probe 1 S9 | **fails — C1** |

## AI reliability audit

| Topic | Current state | Status |
|---|---|---|
| Retry policy | Grading, chat and rewrite retry unavailable/timeout/quota up to 3 attempts per model with backoff; permanent errors are not retried; the SDK's own retries are off (no `retryOptions`). | confirmed; reproduced (B1: 9 calls) |
| Timeouts | **None** for grading, rewrite, transcribe or chat (H7). Book → Test: 60 s per attempt, 100 s total. | reproduced (C) |
| Quota | Per-user hourly/daily per operation; **charged per fallback model** (H7). Admin generation (not under `authenticateRequest`) has no per-user quota. | reproduced (B1/B2) / confirmed |
| Idempotency / duplicates | Book → Test: persisted request ledger with lease, replay and conflict handling. Exam grading: a second concurrent grading of the same task calls the model twice and the loser gets `already_graded` (quota wasted). Practice grading has no idempotency. | confirmed |
| Malformed output | `JSON.parse` failure → 500 `grading_failed`; missing or out-of-range `band_overall` → 502; criterion bands not validated (L10). Book → Test validates every question against schema, grounding and quality. | confirmed + tests |
| Provenance / grounding | Book → Test records source chunks, prompt version, generator version, model, attempts and per-question evidence; unverified questions cannot be published (the H4 path — editing a question after publication — closed in Phase 21: the edit withdraws the material, and republishing re-runs the gate, including stale confirmations). | tests (generationBoundary, bookToTest) |
| Writing/Speaking failure handling | No invented bands; 503/500 surfaced; exam records nothing. | tests |
| Fallback model behaviour | 3.8 → 3.7 → 3.6 flash on unavailability only; model names hard-coded. | confirmed |
| Model/prompt version recording | Book → Test: yes. Grading: model logged in the AI usage log only; attempts store bands without model or prompt version. | confirmed (M7) |
| Not equivalent to official IELTS | AI examiner instead of certified examiners; Speaking graded per part and averaged instead of holistic; typed-transcript Speaking assesses pronunciation without audio; practice bands on partial sections are scaled estimates; GT/Academic prompts differ only in instruction text; AI bands vary between calls (temperature 0.25) and are not calibrated against examiner scripts. | documented (IELTS_CORRECTNESS_AUDIT.md) |

## Runtime / reliability audit

**`fetch failed` / `ECONNRESET` in the test suite — unreproduced**

- Phase 14.2 ran 100 consecutive isolated runs and a concurrent stress run; all passed. This phase's full run passed 555/555.
- Scope: in-process test servers only. There is no production evidence.
- A crashed server also presents as `fetch failed` (H1). Inside a test process, though, a crash ends the whole run, so it does not explain the intermittent single failures.
- Further reproduction is not justified unless it recurs; if it does, capture the server stderr.

**First click after reload — unreproduced outside automation**

- Seen only while driving Chrome through automation (Phases 15/16). There the tab reported `document.visibilityState === 'hidden'`.
- The first clicks landed while the session-check screen ("Проверяем сессию…") was still replacing the DOM.
- The navbar renders two copies of each navigation button (desktop and mobile). Element-reference clicks resolved to the hidden copy, while coordinate clicks on the visible one worked.
- Likely scope: automation artefact. Production impact: unknown, likely low.
- A short manual check in a visible browser is justified; code changes are not.

**Other runtime checks**

| Topic | Finding | Status |
|---|---|---|
| Long-running requests | Source ingestion awaited in-request (60 MB limit); grading without timeout (H7); Book → Test bounded at 100 s. | confirmed |
| Synchronous JSON persistence | Local stores use synchronous whole-file reads and writes, including users and sessions per request (L12). Local mode only. | confirmed |
| Concurrent writes | Exam CAS correct; local stores atomic within one process (tmp + rename, no await between read and write); Firestore admin writes not transactional. | confirmed / tested |
| Server restart | Exam state, ledger, quotas and rate limits persisted; in-memory locks only coordinate one process (fine for Firestore, which uses transactions). | confirmed |
| Stale browser state | Session and admin state validated server-side; exam resumes from the server. | tested / browser (Phase 14) |
| Time handling | UTC ISO timestamps; server clock for exams; daily quotas by UTC date. | confirmed |
| Cleanup failures | Logged, not retried (M10). | confirmed |
| Process crashes | H1 — resolved in Phase 20: async failures reach the JSON error boundary; stray library rejections are logged and the process keeps serving; an uncaught synchronous exception still exits (by design). | reproduced; resolved (tested over the real `server.ts`) |
| Health checks | Health was not dependency-aware (M7). Since Phase 20 `/api/health` reads the data backend and answers 503 when it cannot be used; the rest of M7 (structured logs, audit log) is unchanged. | reproduced (production boot); storage part resolved |

## Legacy / migration audit

| Item | Finding | Classification |
|---|---|---|
| `test-1` / `MOCK_TEST_1` | Built-in demo practice test (`mockBank.ts`), offered by name in practice; plan tasks point to it. Never used as an exam or to fill a gap (tests assert this). | intentional demo |
| Silent content substitution | None found. Missing bundle sections and materials are refused (tests). The only stale trace is the copy in L4. | none (no High) |
| Other silent fallbacks | `/api/data` returns a default profile for new users (UI default, not content); adapters default Listening accent to "British" and titles to the material title (cosmetic). | acceptable |
| Old material schemas | Migrated on read (`migrateStoredMaterial`); unconvertible questions surface as `needsReview` and block publish. | intentional |
| Old bundle schemas | `readStoredBundle` rejects unreadable rows and reports them. | intentional |
| `StoredTextbook` | Only mentioned in comments; the type is removed. | cleaned |
| Deprecated endpoints / dead code | `/api/mocks/*` (no client, L7); `auditLogService` (never called, M7); `LocalStorageProvider` returns a `/api/storage/raw` URL for a route that does not exist (unused return value); `redactAnswerKeys` unused; `PUBLIC_UPLOADS_DIR` kept for old deployments. | dead code |
| Duplicate adapters | One learner view (`toLearnerMaterial`) and one sittable adapter; `withoutAnswerKeys` separately for mocks. Two HTML sanitisers (server sanitize-html, client DOMPurify) by design. | acceptable |
| Hard-coded IELTS assumptions | Grading model names, Speaking prep/speak 60/120 s, Writing 150/250 words and 20/40 min, Listening 10/part, Reading 40 total (all from official format); the 30/60/60/14 reference timing omits the 2-minute computer-delivered review (documented). | documented |
| Status names | Materials and bundles: draft/published/archived. Sessions: active/finished/abandoned/superseded. Attempts: completed/incomplete. Sources: extracting/ready/failed. Consistent within each domain. | ok |

## Asset and licensing audit

**Asset handling**

| Topic | Current state |
|---|---|
| Source asset privacy | Originals of books and imported pages are private assets. They are served to admins as `attachment` with CSP `sandbox`, and to learners only when referenced by published content — broken for imported originals (H3). |
| Imported HTML | Original kept untouched and private. Display markup normalised (scripts removed) and sanitised. Printed answer-key sections cut from learner views. |
| Textbook originals | Kept indefinitely while the source exists. Deleting a source releases its assets to the reaper. Generated materials keep chunk text in their generation record, so provenance text outlives the source. |
| Audio | Uploaded, sniffed by content, served whole (H8). The once-only rule applies to the exam UI, not the file: the URL remains downloadable by signed-in learners (Phase 15 known limitation). |
| Asset routes | Admin: any asset by id with an admin/examiner session. Learner: only ids reachable from published learner views. No public asset route. |
| Retention and deletion | Staged assets unreferenced for 24 h are reaped by a manual `POST /api/admin/assets/reap`; there is no scheduled job. Bytes are deleted from disk or GCS with the record. No retention policy for learner audio, which is not stored. |

**Copyright and licensing risk — current state, not solved**

- **Book → Test passages are verbatim source text.** `buildPassage` concatenates retrieved textbook chunks unchanged ("the retrieved source text itself, not something written about it", `bookToTest/passage.ts`). Publishing such a material publishes verbatim excerpts of the uploaded book to every learner.
- **CDI imports are third-party exam-preparation pages** stored and republished verbatim, including their audio where uploaded (e.g. the untracked `data/private_uploads/Listening__Fozilbek_IELTS__17__….html`).
- **No licence metadata.** There is no rights, licence or permission field on sources, assets or materials, and no publish-gate check for rights clearance. Book → Test and the Source Library explicitly treat textbooks as "licensed material", but the system neither records nor verifies that licence.
- **Exposure is larger than intended.** The H3 defect lets learners download untouched originals.
- **Trademark.** The README carries the IELTS trademark disclaimer. Nothing checks that published material is not official Cambridge/IELTS content.

**Risk:** publishing textbook-derived or third-party CDI content without a recorded licence exposes the operator to copyright claims. This is a legal and product decision, outside code.

## Configuration / deployment audit

| Setting | Behaviour | Classification |
|---|---|---|
| `NODE_ENV` | Must be `production`: selects Firestore auth and rate limits, `Secure` cookies, static `dist/`, disables dev impersonation. Unset means Vite dev middleware and insecure cookies. | **production blocker if wrong** |
| `STORAGE_BACKEND` | Required; refuses to start without it, and refuses `local` in production. | safe default (fail closed) |
| `GCS_BUCKET_NAME` | Required with Firestore; throws at boot. | safe default |
| `FIREBASE_*` / ADC | Missing credentials: before Phase 20 the server booted, reported healthy, then crashed on the first Firestore request (H1). Now it boots, `/api/health` answers 503 `unavailable`, and every Firestore-backed request answers 503 `storage_unavailable` (after the client gives up, about 10 s) while the process keeps running. Working credentials against a real project remain unverified (H10). | **production blocker to verify** (credentials must be supplied; misconfiguration is now visible) |
| `GEMINI_API_KEY` | Missing: AI endpoints return 503; health reports `aiConfigured:false`. | safe default |
| `APP_URL` | Admin origin allowlist behind a proxy; password-reset links. | required for production |
| `RESEND_API_KEY`, `EMAIL_FROM` | Production password reset throws; the route still answers "instructions will be sent" and no email goes out. | **production blocker for account recovery** |
| `EXPLICIT_DEV_AUTH` | Header impersonation when not production (M11). | development-only |
| `SEED_DEFAULT_ACCOUNTS`, `ADMIN_*`, `ADMIN_PROMOTE_*` | Local mode only; no Firestore equivalent (M3). | development-only / **production gap** |
| `RATE_LIMIT_*` | Positive-integer overrides; defaults 10 generations/day, 4 grades/hour. | safe default |
| `BOOK_TO_TEST_*` | Bounded overrides; fixture model refused in production. | safe default |
| `PORT` | Ignored; always 3000 (M1). | **production blocker on PORT-assigning platforms** |
| CORS | None configured; same-origin only. | safe default |
| File paths | `data/` and `dist/` relative to the working directory; `adminStore` creates `data/private_uploads` at import even in production (needs a writable FS at boot). | deployment assumption |
| Upload limits | JSON 16 MB global; admin upload 35 MB; source upload 60 MB, all in memory. | acceptable; review memory sizing |
| Build / start | `npm run build` succeeds (Vite + esbuild CJS, 860 kB main chunk warning). `node dist/server.cjs` boots and serves `index.html`. devDependency runtime packages at risk (H9). | reproduced |
| Static assets | `express.static(dist)` plus catch-all `index.html`; no cache or security headers (M2, L3). | confirmed |
| Secrets | `.env*` git-ignored (only `.env.example` tracked); tokens hashed at rest; the Gemini key stays server-side. | safe |
| Missing deployment artefacts | No Dockerfile, platform descriptor, Firestore indexes/rules or runbook (M12). | gap |

## Test quality audit

Inventory: 28 test files; 555 tests, all passing; no `skip`, `only` or `todo`.

**How tests exercise the system**

| Kind | Coverage |
|---|---|
| Behavioural, route-level | 17 files mount their own Express app with a subset of routers over HTTP: material lifecycle, practice keys, exam session, bundles, sources, imports, public endpoints. |
| Unit / pure | Scoring tables (mutation-checked), exam state machine, CDI parser, question schema/engine, sanitiser, bundle gate. |
| Render tests | `lifecycleUi`, `moduleLabels` (renderToStaticMarkup). |
| Static text assertions | **`security.test.ts` (15 tests) only checks source text.** It would pass with the behaviour broken: it asserts the IP-keyed limiter string that H2 shows is defective. |
| Browser | Manual only (Phases 14–16); no automated browser tests. |

**Gaps that matter**

- **No test mounts the real `server.ts`.** Suites wire their own apps (for example, `materialLifecycle` omits `enforceAdminSecurity`, and suites use 5 MB JSON limits instead of 16 MB). The following are therefore untested:
  - middleware order, the global limiter, unhandled-error behaviour (H1) — the H1 part is now covered: `tests/serverStability.test.ts` runs the real `server.ts` in a child process (Phase 20);
  - `server.ts` inline routes (`/api/grade/*`, `/api/writing/improve`, `/api/writing/transcribe`, `/api/preppy/chat`, `/api/mocks/*`).
- **Mocks that bypass important code.**
  - Exam tests inject fake graders, so AI timeout, quota and fallback interaction with the exam is untested (H6/H7).
  - Firestore tests use `FakeFirestore`, which serialises transactions and lacks `orderBy`, collection reads in transactions, and query reads in transactions.
- **Firestore paths never executed:** auth, rate limits, AI quota, sources, Book → Test ledger, tasks/checklist/vocab, generated mocks.
- **Tests that can pass with empty data:** none found in the core exam and scoring suites (fixtures are full-size since Phase 15, and totals are asserted). The static security tests are the exception.
- **Shared global state:** each suite `chdir`s into its own temp directory before importing stores. Module-level singletons (stores, rate limiters) persist per process, and `node:test` runs files in separate processes. No cross-suite leakage found.
- **Platform-specific:** `removeTempRoot` swallows Windows EPERM. The suite runs on Windows here; Linux CI has not been observed.
- **Flaky:** the historical intermittent `fetch failed` in `examSession.test.ts` is unreproduced (see runtime audit).

## Browser verification

- **No browser checks this phase.** Every finding was reproduced at HTTP or process level against the real server or production bundle; the brief asks for browser checks only where they validate a finding.
- **H8 on Safari/iOS is unverified.** No Safari or Apple device was available.
- **This is not `BROWSER_AUDIT_BLOCKED`.** No browser check was attempted. Chrome was available with a learner session; the admin session had expired in Phase 16 and would need the user to sign in again.

## Confirmed blockers

These Critical/High issues genuinely block production.

1. ~~**C1** — exam keys obtainable through practice marking.~~ Resolved in Phase 18.
1. ~~**H11** — exam-session score counts usable to derive closed-choice keys (added in Phase 18).~~ Resolved in Phase 19.
2. ~~**H1** — server crash on unhandled async errors; health does not reflect storage.~~ Resolved in Phase 20.
3. **H2** — IP-keyed shared rate limits.
4. **H3** — private imported originals downloadable by learners.
5. ~~**H4** — published content edited without the gate.~~ Resolved in Phase 21.
6. **H5** — Firestore merge keeps removed fields (production path).
7. **H6** — exam Writing/Speaking lost at the deadline.
8. **H7** — AI timeout, quota and error-mapping defects.
9. **H8** — Listening audio range support and once-only start on playback failure (device impact to verify).
10. **H9** — runtime dependencies misdeclared (blocker for any install that prunes devDependencies).
11. **H10** — Firestore production path unverified.

M1 (port), M3 (admin bootstrap) and the email configuration are deployment prerequisites rather than code defects, but a production launch cannot proceed without them.

## Known limitations (deliberate deviations)

From `IELTS_CORRECTNESS_AUDIT.md` (Phases 15/16) and product policy:

- **AI grading instead of certified examiners.** Speaking is scored per part and averaged, not holistically; a typed transcript can be graded.
- **Practice bands on a partial section** are scaled estimates.
- **Timing.** Timing is configurable per bundle. The reference timing omits the computer-delivered Listening review, and Speaking uses the 14-minute upper bound.
- **Exam order.** Fixed L → R → W → S in one sitting; early finish is configurable.
- **Listening.**
  - Once-only is enforced in the exam UI, not on the audio file.
  - A reload mid-recording cannot resume it.
  - Part navigation is free.
- **Missing Writing task.** A missing task leaves Writing without a band and the attempt without an overall. Officially Writing is still scored; this is unresolved.
- **Module rule.** Listening and Speaking components must match the bundle module, which is stricter than official.
- **Question types.** Flow-chart completion is stored as a diagram label (interaction equivalent); Listening map labelling is a typed gap; `acceptableAnswers` is not consulted.
- **Book → Test passages** are verbatim source text by design (see licensing).
- **Exam content edits** stop live sittings by design (M9).

## Unverified areas

- **Real Firestore** (H10): no project or emulator run. Unverified paths include auth transactions with queries, rate limits and quotas under contention, sources, `orderBy` queries, the Book → Test ledger, tasks/checklist/vocab, batch limits, and real optimistic transaction retries.
- **Real Cloud Storage:** upload, download and delete are stubbed in tests.
- **Safari/iOS Listening playback** (H8).
- **Production install with pruned devDependencies** (H9).
- **Real Gemini behaviour.** Latency distribution, actual 503 frequency, output variance between calls, and calibration against human examiner scores.
- **The anonymous public route under a real Firestore partial outage** (formerly the H1 hypothesis). Since Phase 20 it answers 503 through the error boundary when its query fails behind a working rate limiter — tested against the in-memory Firestore, not a real project (H10).
- **Load:** Firestore read cost and latency per exam autosave and catalog load (M6).
- **Intermittent `fetch failed`** in tests, and the first click after reload (unreproduced).
- **Linux CI run** of the test suite.

## Recommended order

### Before beta

- ~~**C1**~~ — done in Phase 18 (exam content is not practice content).
- ~~**H11**~~ — done in Phase 19 (no marks in exam-session responses until the exam has finished).
- ~~**H1**~~ — done in Phase 20 (async error boundary, process policy for stray rejections, storage-aware health).
- **H2** — `trust proxy`, per-user limits sized for exam autosaves.
- **H3** — remove imported originals from the learner asset allowlist.
- ~~**H4**~~ — done in Phase 21 (a changed published material is withdrawn to draft; revisioned saves; publish re-checks the row it gated).
- **H6 + H7** — timeouts, single quota charge per grading, 429 for quota, submission-time acceptance for Writing/Speaking (or document the limitation explicitly).
- **H8** — Range support and start-on-playing, then a Safari/iOS check.
- **H9, M1, M3** — dependency declarations, `PORT`, admin bootstrap for the target deployment.
- **M2** — security headers.
- **M11** — ensure no hosted environment runs with `EXPLICIT_DEV_AUTH`.
- Short manual check of the first-click issue in a visible browser.

If the beta runs on production infrastructure, **H5** and **H10** belong here too.

### Before production

- **H5** — non-merge material writes; review `sourceStore.save`.
- **H10** — run the suite and a smoke test against a Firestore emulator or staging project (auth, quotas, sources, Book → Test, contention).
- **M4** — local store fail-loud (if any non-dev local use remains).
- **M5** — server-side sanitisation of every HTML-rendered field.
- **M6** — measure and reduce per-event Firestore reads.
- **M7** — structured logging, audit log, grading model recorded on attempts.
- **M10** — batch limits and multi-step failure handling.
- **M12** — local → Firestore migration script, indexes and rules, deployment runbook; email configuration.
- **M13** — async bcrypt.
- **M14** — behavioural tests on the real `server.ts` wiring for every fixed finding.
- **Licensing** — record rights for sources and CDI imports before publishing derived content.

### Post-launch

- **M8** — immutable material versions or attempt snapshots.
- **M9** — edit policy for pinned materials during live exam windows.
- **Lows L1–L12.**
