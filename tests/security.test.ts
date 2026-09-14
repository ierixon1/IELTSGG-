import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { expect } from './harness';

const read = (path: string) => readFile(path, 'utf8');

describe('security regressions', () => {
  it('keeps private admin uploads outside the public static directory and stages cloud uploads safely', async () => {
    const routes = await read('src/routes/adminRoutes.ts');
    const store = await read('src/services/adminStore.ts');
    const server = await read('server.ts');
    expect(routes).toContain('PRIVATE_UPLOADS_DIR');
    expect(store).toContain("fs.mkdirSync(PRIVATE_UPLOADS_DIR");
    // Nothing is served statically any more. Assets go out through
    // /api/admin/assets/:id and /api/learner/assets/:id, which check the
    // caller and set their own headers — an uploaded file's directory is
    // never exposed.
    expect(server).not.toContain('express.static(UPLOADS_DIR');
    expect(server).not.toContain('express.static(PRIVATE_UPLOADS_DIR');
  });
  it('does not trust client supplied userId for user data routes', async () => {
    const routes = await read('src/routes/userDataRoutes.ts');
    expect(routes).toContain('const userId=requireUser(req,res)');
    expect(routes).not.toContain('req.body.userId');
  });
  it('no longer carries the unused mock-generation API or its demo fallback (L7)', async () => {
    const exists = (file: string) => readFile(file).then(() => true, () => false);
    expect(await read('server.ts')).not.toContain('mockRouter');
    for (const file of ['src/routes/mockRoutes.ts', 'src/services/mockGenerator.ts', 'src/schemas/mockGeneratorSchema.ts']) expect([file, await exists(file)]).toEqual([file, false]);
  });
  it('uses operation-specific AI quota guards', async () => {
    const retry = await read('prompts/geminiRetry.ts');
    const server = await read('server.ts');
    const grading = await read('src/services/grading.ts');
    expect(retry).toContain("quotaOperation: AiOperationType = 'ai_request'");
    expect(grading).toContain("'writing_grade'");
    expect(grading).toContain("'speaking_grade'");
    expect(server).toContain("'preppy_chat'");
  });
  it('invalidates sessions after password reset and rejects stale role snapshots', async () => {
    const auth = await read('src/services/authService.ts');
    expect(auth).toContain('sessionVersion:(d.sessionVersion||0)+1');
    expect(auth).toContain('invalidateFirestoreSessions(u.id)');
    expect(auth).toContain('user.role!==s.role');
  });
  it('uses httpOnly cookie auth and never persists the session token in localStorage', async () => {
    const middleware = await read('src/middleware/authMiddleware.ts');
    const routes = await read('src/routes/authRoutes.ts');
    const gate = await read('src/components/AuthGate.tsx');
    const main = await read('src/main.tsx');
    const api = await read('src/services/api.ts');
    expect(middleware).toContain("AUTH_COOKIE='prep_auth'");
    expect(middleware).not.toContain('authorization');
    expect(routes).toContain('httpOnly:true');
    expect(routes).toContain("sameSite:'strict'");
    expect(routes).not.toContain('Authorization');
    expect(routes).not.toContain('const bearer=');
    expect(gate).not.toContain('prep_auth_token');
    expect(main).toContain("localStorage.removeItem('prep_auth_token')");
    expect(api).not.toContain('Authorization: `Bearer');
  });
  it('uses HttpOnly admin cookie auth and enforces global admin security', async () => {
    const routes = await read('src/routes/adminRoutes.ts');
    const staffSession = await read('src/middleware/staffSession.ts');
    const middleware = await read('src/middleware/adminSecurityMiddleware.ts');
    const server = await read('server.ts');
    expect(staffSession).toContain("export const ADMIN_AUTH_COOKIE='prep_admin_auth'");
    expect(routes).toContain('httpOnly:true');
    expect(routes).not.toContain('req.headers.authorization');
    expect(middleware).toContain('Cross-site request blocked.');
    expect(middleware).toContain("'staff_api'");
    expect(server).toContain("app.use('/api/admin',adminAuditTrail(),enforceAdminSecurity,staffSizedBody,adminRouter)");
  });
  it('does not pass or persist an admin session token in the login UI', async () => {
    const login = await read('src/components/admin/AdminLogin.tsx');
    const app = await read('src/App.tsx');
    const types = await read('src/types/admin.ts');
    expect(login).toContain('onLoginSuccess(data.admin)');
    expect(login).not.toContain('data.token');
    expect(login).not.toContain('prep_admin_token');
    expect(app).toContain("fetch('/api/admin/me', { credentials: 'same-origin' })");
    expect(app).toContain("localStorage.removeItem('prep_admin_user')");
    expect(types).toContain("role: 'admin' | 'examiner'");
    expect(types).not.toContain('superadmin');
    expect(types).not.toContain('content_manager');
  });
  it('validates complete password reset email configuration', async () => {
    const email = await read('src/services/emailService.ts');
    const auth = await read('src/services/authService.ts');
    expect(email).toContain("process.env.RESEND_API_KEY?.trim()");
    expect(email).toContain("process.env.EMAIL_FROM?.trim()");
    expect(email).toContain("process.env.APP_URL?.trim()");
    expect(email).toContain('AbortSignal.timeout(10000)');
    expect(auth).toContain('sendPasswordResetEmail({to:user.email,token})');
    expect(auth).not.toContain("process.env.NODE_ENV!=='production'&&isEmailDeliveryConfigured()");
  });
  it('does not allow draft materials to escape through a published bundle', async () => {
    const gate = await read('src/services/bundleGate.ts');
    const service = await read('src/services/bundleService.ts');
    expect(gate).toContain("code: 'component_unpublished'");
    expect(gate).toContain("code: 'component_archived'");
    expect(service).toContain('return refuse(learnerProblem(blockers));');
  });
  it('fails closed for explicit dev impersonation outside development and test (M11)', async () => {
    // Behaviour: tests/finalHardening.test.ts starts the real server.ts with NODE_ENV unset and the switch on.
    const middleware = await read('src/middleware/authMiddleware.ts');
    const devAuth = await read('src/config/devAuth.ts');
    expect(middleware).toContain('isExplicitDevAuthEnabled=explicitDevAuthEnabled');
    expect(devAuth).toContain("DEV_AUTH_ENVIRONMENTS = new Set(['development', 'test'])");
    expect(middleware).not.toContain("NODE_ENV!=='production'");
  });
  it('serializes local quota writes', async () => {
    const store = await read('src/services/storage/LocalJsonDataStore.ts');
    expect(store).toContain('withLock(`${userId}:quota`');
  });
  it('throttles API requests per signed-in account, and per address only without a session', async () => {
    // The behaviour is held by userRateLimits.test.ts and rateLimitStorage.test.ts; this pins the wiring.
    const middleware = await read('src/middleware/authMiddleware.ts');
    const limiter = await read('src/services/requestRateLimitService.ts');
    const server = await read('server.ts');
    expect(middleware).toContain("admitRequest(res,accountKey(userId),'api_user')");
    expect(middleware).toContain("admitRequest(res,clientAddressKey(req),'api_anonymous')");
    expect(limiter).toContain('api_user: { windowMs: 60 * 1000, max: 120 }');
    expect(server).toContain("app.set('trust proxy',trustProxy)");
  });
  it('validates persisted CMS payloads before writing them', async () => {
    const store = await read('src/services/adminStore.ts');
    // Materials are now validated against the canonical Zod schema on the
    // merged record, not by a hand-rolled check of four scalar fields.
    // The rendered-HTML fields are sanitised on the merged record first, whichever route wrote it (M5).
    expect(store).toContain('parseMaterialForWrite(section,sanitizeRenderedMaterialHtml(section,candidate))');
    expect(store).toContain('MaterialValidationError');
    const bundles = await read('src/routes/bundleRoutes.ts');
    expect(bundles).toContain('BundleDraftInputSchema.safeParse(req.body)');
    expect(store).toContain('maxBytes=2_000_000');
  });
  it('uses Firestore for production admin CMS state and Cloud Storage for production files', async () => {
    const adminStore = await read('src/services/adminStore.ts');
    const assetStore = await read('src/services/assetStore.ts');
    expect(adminStore).toContain("collection('admin_content')");
    // File storage moved out of adminStore into the asset store, which is
    // also the only place that calls the storage provider.
    expect(assetStore).toContain("collection('admin_assets')");
    expect(assetStore).toContain('storageProvider.uploadFile');
    expect(assetStore).toContain('storageProvider.downloadFile');
    expect(assetStore).toContain('storageProvider.deleteFile');
  });
});
