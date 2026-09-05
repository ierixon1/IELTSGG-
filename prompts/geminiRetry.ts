import { requestContext } from '../src/middleware/authMiddleware';
import { aiRateLimitService } from '../src/services/aiRateLimitService';

/**
 * Execute Gemini API calls with exponential backoff and a server-side per-user AI guard.
 */
export async function executeGeminiWithRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  initialDelayMs = 1500
): Promise<T> {
  const userId = requestContext.getStore()?.userId;
  if (userId) {
    const guard = aiRateLimitService.checkLimit(userId, 'ai_request');
    if (!guard.allowed) throw new Error(guard.reason);
  }

  let delay = initialDelayMs;
  let lastError: any = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await operation();
      if (userId) {
        try { aiRateLimitService.recordUsage({ userId, operation: 'ai_request', model: 'gemini-3.8-flash', success: true }); } catch (logError) { console.error('[AI usage log]', logError); }
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
  const is429 = lastError?.message?.includes('429') || lastError?.message?.includes('RESOURCE_EXHAUSTED');
  if (is429) throw new Error('Gemini API quota or rate limit reached. Please wait a moment before trying again.');
  throw new Error(`AI generation error: ${lastError?.message || 'Unknown error occurred during synthesis.'}`);
}
