import { describe, expect, it } from 'bun:test';

// Static regression tests intentionally avoid requiring Firestore credentials.
const read = async (path: string) => Bun.file(path).text();

describe('security regressions', () => {
  it('does not expose a public private-upload directory', async () => {
    const server = await read('server.ts');
    expect(server).toContain("express.static(UPLOADS_DIR");
    expect(server).not.toContain("express.static(PRIVATE_UPLOADS_DIR");
  });

  it('does not trust client supplied userId for user data routes', async () => {
    const routes = await read('src/routes/userDataRoutes.ts');
    expect(routes).toContain('const userId=requireUser(req,res)');
    expect(routes).not.toContain('req.body.userId');
  });

  it('uses atomic generation reservation in the mock endpoint', async () => {
    const server = await read('server.ts');
    expect(server).toContain('dataStore.reserveGeneration(req.userId,RATE_LIMIT_GENERATIONS)');
    expect(server).not.toContain('dataStore.incrementGenerationCount(req.userId)');
  });

  it('uses operation-specific AI quota guards', async () => {
    const retry = await read('prompts/geminiRetry.ts');
    expect(retry).toContain("quotaOperation: AiOperationType = 'ai_request'");
    const server = await read('server.ts');
    expect(server).toContain("'writing_grade'");
    expect(server).toContain("'speaking_grade'");
    expect(server).toContain("'preppy_chat'");
  });

  it('invalidates sessions after password reset', async () => {
    const auth = await read('src/services/authService.ts');
    expect(auth).toContain('sessionVersion:(d.sessionVersion||0)+1');
    expect(auth).toContain('invalidateFirestoreSessions(u.id)');
  });

  it('production admin content is Firestore-backed', async () => {
    const adminStore = await read('src/services/adminStore.ts');
    expect(adminStore).toContain("const useFirestore = () => process.env.NODE_ENV === 'production' || process.env.STORAGE_BACKEND === 'gcs_firestore'");
    expect(adminStore).toContain("collection('admin_content')");
    expect(adminStore).toContain("collection('admin_files')");
  });
});
