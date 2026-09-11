import express, { Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/authMiddleware';
import { createDefaultExamSessionService, type ExamSessionService, type SessionOutcome } from '../services/examSession';

/**
 * Full exams for a signed-in learner, sat through a server-held exam session.
 *
 * Mounted behind `authenticateRequest`. Nothing here returns an answer key:
 * the paper carries questions without keys, Listening and Reading are marked on
 * the server when answers are submitted, and Writing and Speaking are graded on
 * the server against the pinned prompts.
 */

const answerValue = z.union([z.string().max(2000), z.array(z.string().max(2000)).max(50)]);

const clientEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }).strict(),
  z
    .object({
      type: z.literal('answers'),
      answers: z.record(z.string().min(1).max(128), answerValue).refine((answers) => Object.keys(answers).length <= 400, 'Too many answers.'),
    })
    .strict(),
  z.object({ type: z.literal('submit_answers') }).strict(),
  z.object({ type: z.literal('audio_started'), part: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) }).strict(),
  z.object({ type: z.literal('writing_draft'), task: z.union([z.literal(1), z.literal(2)]), text: z.string().max(30000) }).strict(),
  z.object({ type: z.literal('finish_section') }).strict(),
  z.object({ type: z.literal('sync') }).strict(),
]);

const openBody = z.object({ bundleId: z.string().min(1).max(200) }).strict();
const eventsBody = z.object({ events: z.array(clientEvent).min(1).max(50) }).strict();
const writingBody = z.object({ essay: z.string().max(30000) }).strict();
const speakingBody = z
  .object({
    audioBase64: z.string().max(12_000_000).optional(),
    mimeType: z.string().max(100).optional(),
    transcriptProvided: z.string().max(30000).optional(),
    clientMetrics: z
      .object({
        durationSeconds: z.number().min(0).max(3600).optional(),
        pausesCount: z.number().min(0).max(10000).optional(),
        totalPauseDurationSeconds: z.number().min(0).max(3600).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function send<T>(res: Response, outcome: SessionOutcome<T>, status = 200) {
  if (outcome.ok) return res.status(status).json(outcome.value);
  return res.status(outcome.status).json({ error: outcome.error, code: outcome.code, ...(outcome.details ? { details: outcome.details } : {}) });
}

export function createExamSessionRouter(service: ExamSessionService | (() => Promise<ExamSessionService>)) {
  const router = express.Router();
  let resolved: Promise<ExamSessionService> | null = null;
  const sessions = () => {
    if (typeof service !== 'function') return Promise.resolve(service);
    resolved ??= service();
    return resolved;
  };

  const handle =
    (run: (req: AuthenticatedRequest, res: Response, userId: string, svc: ExamSessionService) => Promise<unknown>) =>
    async (req: AuthenticatedRequest, res: Response) => {
      if (!req.userId) return res.status(401).json({ error: 'Unauthorized.' });
      try {
        return await run(req, res, req.userId, await sessions());
      } catch (error) {
        console.error('[ExamSession] request failed:', error);
        return res.status(500).json({ error: 'The exam session could not be updated.', code: 'invalid_bundle' });
      }
    };

  router.get(
    '/learner/exams',
    handle(async (_req, res, userId, svc) => res.json({ sessions: await svc.list(userId) })),
  );

  router.post(
    '/learner/exams',
    handle(async (req, res, userId, svc) => {
      const body = openBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'A bundle id is required.' });
      return send(res, await svc.open(userId, body.data.bundleId));
    }),
  );

  router.get(
    '/learner/exams/:id',
    handle(async (req, res, userId, svc) => send(res, await svc.get(userId, req.params.id))),
  );

  router.post(
    '/learner/exams/:id/events',
    handle(async (req, res, userId, svc) => {
      const body = eventsBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'Invalid exam events.' });
      return send(res, await svc.apply(userId, req.params.id, body.data.events));
    }),
  );

  router.post(
    '/learner/exams/:id/writing/:task(1|2)',
    handle(async (req, res, userId, svc) => {
      const body = writingBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'An essay is required.' });
      return send(res, await svc.gradeWriting(userId, req.params.id, req.params.task === '1' ? 1 : 2, body.data.essay));
    }),
  );

  router.post(
    '/learner/exams/:id/speaking/:part(1|2|3)',
    handle(async (req, res, userId, svc) => {
      const body = speakingBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'Invalid speaking answer.' });
      const part = req.params.part === '1' ? 1 : req.params.part === '2' ? 2 : 3;
      return send(res, await svc.gradeSpeaking(userId, req.params.id, part, body.data));
    }),
  );

  router.post(
    '/learner/exams/:id/abandon',
    handle(async (req, res, userId, svc) => send(res, await svc.abandon(userId, req.params.id))),
  );

  return router;
}

export const examSessionRouter = createExamSessionRouter(createDefaultExamSessionService);
