import { z } from 'zod';

export const GenerateMockRequestSchema = z.object({
  module: z.enum(['academic', 'general']).default('academic'),
  section: z.enum(['reading', 'listening', 'writing', 'speaking', 'full_mock']),
  targetBand: z.enum(['5.0-5.5', '6.0-6.5', '7.0-7.5', '8.0+']).default('7.0-7.5'),
  theme: z.string().min(2).max(120).optional(),
  partNumber: z.number().int().min(1).max(4).optional(),
  passageCount: z.number().int().min(1).max(3).optional(),
  requestedQuestionTypes: z.array(z.string()).optional(),
  negativeTopics: z.array(z.string()).optional(),
  task1Type: z.string().optional(),
  task2Type: z.string().optional(),
  cueCardCategory: z.enum(['person', 'place', 'object', 'event', 'experience', 'activity']).optional()
});

export type GenerateMockRequest = z.infer<typeof GenerateMockRequestSchema>;

export const SaveAttemptRequestSchema = z.object({
  mockId: z.string(),
  section: z.enum(['reading', 'listening', 'writing', 'speaking', 'full_mock']),
  module: z.enum(['academic', 'general']),
  bandScore: z.number().min(0).max(9),
  correctCount: z.number().optional(),
  totalQuestions: z.number().optional(),
  timeSpentMinutes: z.number(),
  answers: z.record(z.string(), z.any()).optional(),
  feedback: z.any().optional(),
  isFullMock: z.boolean().optional()
});
