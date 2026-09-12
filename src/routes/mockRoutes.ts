import express from 'express';
import type { AuthenticatedRequest } from '../middleware/authMiddleware';
import { dataStore } from '../services/storage';
import { mockGeneratorService } from '../services/mockGenerator';
import { GenerateMockRequestSchema } from '../schemas/mockGeneratorSchema';
import { withoutAnswerKeys } from '../services/learnerRedaction';

/**
 * AI-generated mock tests, owned by the learner who generated them.
 *
 * A generated mock is written by the model from a theme, never from an admin
 * material, so no route here can reach exam content. Its stored record keeps
 * the keys the generator produced; every response sends it without them.
 *
 * Mounted behind `authenticateRequest` (moved here from `server.ts` unchanged,
 * so the routes can be exercised by the security tests).
 */
export const mockRouter = express.Router();

const RATE_LIMIT_GENERATIONS = parseInt(process.env.RATE_LIMIT_GENERATIONS || '10', 10);

mockRouter.post('/mocks/generate', async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized.' });
    const parsed = GenerateMockRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request payload format.' });
    const recent = await dataStore.getRecentGenerations(req.userId, 20);
    const recentThemes = recent.map((t) => t.theme).filter(Boolean);
    const result = await mockGeneratorService.generateMock(parsed.data, recentThemes);
    await dataStore.recordGeneratedTest(req.userId, {
      id: result.id,
      userId: req.userId,
      timestamp: new Date().toISOString(),
      module: result.module,
      section: result.section,
      targetBand: result.targetBand,
      theme: result.theme,
      contentHash: result.contentHash,
      title: result.title,
      questionTypes: result.questionTypes,
      data: result.testData,
    });
    const quota = await dataStore.getDailyQuota(req.userId);
    // The learner is sent the test without its keys, explanations or provenance; the stored record keeps them.
    return res.json({
      success: true,
      test: withoutAnswerKeys(result),
      remainingGenerations: Math.max(0, RATE_LIMIT_GENERATIONS - quota.generationsCount),
      recentThemesCount: recentThemes.length,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Daily generation limit reached.') return res.status(429).json({ error: error.message, quota: { max: RATE_LIMIT_GENERATIONS } });
    console.error('[Mocks]', error);
    return res.status(500).json({ error: 'Failed to generate mock test.' });
  }
});

mockRouter.get('/mocks/history', async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized.' });
    const n = Number.parseInt(String(req.query.limit || '20'), 10);
    const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 50) : 20;
    const tests = await dataStore.getRecentGenerations(req.userId, limit);
    return res.json({
      tests: tests.map((t) => ({ id: t.id, timestamp: t.timestamp, module: t.module, section: t.section, targetBand: t.targetBand, theme: t.theme, title: t.title, questionTypes: t.questionTypes })),
    });
  } catch (error) {
    console.error('[Mocks history]', error);
    return res.status(500).json({ error: 'Unable to load mock history.' });
  }
});

mockRouter.get('/mocks/:id', async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized.' });
    const test = await dataStore.getGeneratedTestById(req.userId, req.params.id);
    if (!test) return res.status(404).json({ error: 'Mock test not found.' });
    return res.json(withoutAnswerKeys(test));
  } catch (error) {
    console.error('[Mock lookup]', error);
    return res.status(500).json({ error: 'Unable to load mock test.' });
  }
});
