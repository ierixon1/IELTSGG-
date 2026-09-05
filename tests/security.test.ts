import { describe, expect, it } from 'bun:test';
const read = async (path: string) => Bun.file(path).text();

describe('security regressions', () => {
  it('keeps private admin uploads outside the public static directory', async () => {
    const routes = await read('src/routes/adminRoutes.ts');
    const server = await read('server.ts');
    expect(routes).toContain('PRIVATE_UPLOADS_DIR');
    expect(server).toContain('express.static(UPLOADS_DIR');
    expect(server).not.toContain('express.static(PRIVATE_UPLOADS_DIR');
  });
  it('does not trust client supplied userId for user data routes', async () => {
    const routes = await read('src/routes/userDataRoutes.ts');
    expect(routes).toContain('const userId=requireUser(req,res)');
    expect(routes).not.toContain('req.body.userId');
  });
  it('reserves mock generation quota atomically before generation', async () => {
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
  it('uses Firestore for production admin CMS state and Cloud Storage for production files', async () => {
    const adminStore = await read('src/services/adminStore.ts');
    const routes = await read('src/routes/adminRoutes.ts');
    expect(adminStore).toContain("collection('admin_content')");
    expect(adminStore).toContain("collection('admin_files')");
    expect(routes).toContain('storageProvider.uploadFile');
    expect(routes).toContain('storageProvider.downloadFile');
  });
});
