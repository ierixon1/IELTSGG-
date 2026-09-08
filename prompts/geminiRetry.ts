import { requestContext } from '../src/middleware/authMiddleware';
import { aiRateLimitService, AiOperationType } from '../src/services/aiRateLimitService';

/**
 * Raised when the model itself is unreachable — overloaded, rate limited or
 * timing out — as opposed to the request being wrong. Callers use this to tell
 * a learner "try again in a minute" instead of "grading failed".
 */
export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

/** Execute Gemini API calls with exponential backoff and a server-side AI guard. */
export async function executeGeminiWithRetry<T>(operation: () => Promise<T>, maxRetries = 3, initialDelayMs = 1500, quotaOperation: AiOperationType = 'ai_request', quotaAlreadyChecked = false, activeModelForLog = 'gemini-3.8-flash'): Promise<T> {
  const userId = requestContext.getStore()?.userId;
  if (userId && !quotaAlreadyChecked) {
    const guard = await aiRateLimitService.checkLimit(userId, quotaOperation);
    if (!guard.allowed) throw new Error(guard.reason);
  }

  let delay = initialDelayMs;
  let lastError: any = null;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    attemptsMade = attempt;
    try {
      const result = await operation();
      if (userId) {
        try {
          await aiRateLimitService.recordUsage({
            userId,
            operation: quotaOperation,
            model: activeModelForLog,
            success: true,
            notes: `completed_after_${attempt} attempt${attempt === 1 ? '' : 's'}`,
          });
        } catch (logError) {
          console.error('[AI usage log]', logError);
        }
      }
      return result;
    } catch (err: any) {
      lastError = err;
      const status = err?.status || err?.statusCode || (err?.message?.includes('429') ? 429 : 0);
      const isRateLimit = status === 429 || err?.message?.includes('RESOURCE_EXHAUSTED') || err?.message?.includes('rate limit');
      const isTransient = status === 503 || err?.message?.includes('UNAVAILABLE') || err?.message?.includes('timeout') || err?.code === 'ETIMEDOUT';
      if ((isRateLimit || isTransient) && attempt <= maxRetries) {
        console.warn(`[Gemini API] Transient error (status ${status || err.message}). Retrying attempt ${attempt}/${maxRetries} in ${delay}ms...`);
        await new Promise((res) => setTimeout(res, delay));
        delay *= 2;
        continue;
      }
      break;
    }
  }

  if (userId) {
    try {
      await aiRateLimitService.recordUsage({
        userId,
        operation: quotaOperation,
        model: activeModelForLog,
        success: false,
        notes: `failed_after_${attemptsMade}_attempt${attemptsMade === 1 ? '' : 's'}:${String(lastError?.message || 'unknown').slice(0, 240)}`,
      });
    } catch (logError) {
      console.error('[AI usage log]', logError);
    }
  }

  const message = String(lastError?.message || '');
  const exhausted = message.includes('429') || message.includes('RESOURCE_EXHAUSTED');
  const overloaded =
    message.includes('503') || message.includes('UNAVAILABLE') || message.includes('timeout');

  if (exhausted) {
    throw new AiUnavailableError(
      'Gemini API quota or rate limit reached. Please wait a moment before trying again.',
    );
  }
  if (overloaded) {
    throw new AiUnavailableError(`AI model unavailable: ${message || 'upstream did not respond.'}`);
  }
  throw new Error(`AI generation error: ${message || 'Unknown error occurred during synthesis.'}`);
}
