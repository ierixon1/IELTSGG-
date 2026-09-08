import { describe, expect, it } from 'bun:test';
const read = async (path: string) => Bun.file(path).text();

describe('security regressions', () => {
  it('keeps private admin uploads outside the public static directory and stages cloud uploads safely', async () => {
    const routes = await read('src/routes/adminRoutes.ts');
    const store = await read('src/services/adminStore.ts');
    const server = await read('server.ts');
    expect(routes).toContain('PRIVATE_UPLOADS_DIR');
    expect(server).toContain('express.static(UPLOADS_DIR');
    expect(server).not.toContain('express.static(PRIVATE_UPLOADS_DIR');
    expect(store).toContain("fs.mkdirSync(PRIVATE_UPLOADS_DIR");
  });
  it('does not trust client supplied userId for user data routes', async () => {
    const routes = await read('src/routes/userDataRoutes.ts');
    expect(routes).toContain('const userId=requireUser(req,res)');
    expect(routes).not.toContain('req.body.userId');
  });
  it('reserves mock generation quota before generation', async () => {
    const service = await read('src/services/mockGenerator.ts');
    expect(service).toContain('dataStore.reserveGeneration(userId,maxGenerations)');
    expect(service).toContain("checkLimit(userId,'mock_generation')");
  });
  it('uses operation-specific AI quota guards', async () => {
    const retry = await read('prompts/geminiRetry.ts');
    const server = await read('server.ts');
    expect(retry).toContain("quotaOperation: AiOperationType = 'ai_request'");
    expect(server).toContain("'writing_grade'");
    expect(server).toContain("'speaking_grade'");
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
    const middleware = await read('src/middleware/adminSecurityMiddleware.ts');
    const server = await read('server.ts');
    expect(routes).toContain("const ADMIN_AUTH_COOKIE='prep_admin_auth'");
    expect(routes).toContain('httpOnly:true');
    expect(routes).not.toContain('req.headers.authorization');
    expect(middleware).toContain('Cross-site request blocked.');
    expect(middleware).toContain("'api_global'");
    expect(server).toContain("app.use('/api/admin',enforceAdminSecurity,adminRouter)");
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
    const store = await read('src/services/adminStore.ts');
    expect(store).toContain("if(bundle.status==='published')");
    expect(store).toContain("material.status!=='published'");
  });
  it('fails closed for explicit dev impersonation in production', async () => {
    const middleware = await read('src/middleware/authMiddleware.ts');
    expect(middleware).toContain("process.env.NODE_ENV!=='production'&&process.env.EXPLICIT_DEV_AUTH==='true'");
  });
  it('serializes local quota writes', async () => {
    const store = await read('src/services/storage/LocalJsonDataStore.ts');
    expect(store).toContain('withLock(`${userId}:quota`');
  });
  it('applies a distributed global throttle to authenticated API requests', async () => {
    const middleware = await read('src/middleware/authMiddleware.ts');
    const limiter = await read('src/services/requestRateLimitService.ts');
    expect(middleware).toContain("check(`api:${ip}`,'api_global')");
    expect(limiter).toContain("api_global: { windowMs: 60 * 1000, max: 120 }");
  });
  it('validates persisted CMS payloads before writing them', async () => {
    const store = await read('src/services/adminStore.ts');
    expect(store).toContain('validateMaterial(section,materialData)');
    expect(store).toContain('validateBundle(bundleData)');
    expect(store).toContain('maxBytes=2_000_000');
  });
  it('uses Firestore for production admin CMS state and Cloud Storage for production files', async () => {
    const adminStore = await read('src/services/adminStore.ts');
    const routes = await read('src/routes/adminRoutes.ts');
    expect(adminStore).toContain("collection('admin_content')");
    expect(adminStore).toContain("collection('admin_files')");
    expect(routes).toContain('storageProvider.uploadFile');
    expect(routes).toContain('storageProvider.downloadFile');
  });
});
