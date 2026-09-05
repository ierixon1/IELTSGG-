/**
 * Helper to execute Gemini API calls with exponential backoff
 * Handles HTTP 429 (Rate Limit), 503 (Service Unavailable), and transient timeouts.
 */
export async function executeGeminiWithRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  initialDelayMs = 1500
): Promise<T> {
  let delay = initialDelayMs;
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await operation();
    } catch (err: any) {
      lastError = err;
      const status = err?.status || err?.statusCode || (err?.message?.includes('429') ? 429 : 0);
      const isRateLimit = status === 429 || err?.message?.includes('RESOURCE_EXHAUSTED') || err?.message?.includes('rate limit');
      const isTransient = status === 503 || err?.message?.includes('UNAVAILABLE') || err?.message?.includes('timeout') || err?.code === 'ETIMEDOUT';

      if ((isRateLimit || isTransient) && attempt <= maxRetries) {
        console.warn(`[Gemini API] Transient error (status ${status || err.message}). Retrying attempt ${attempt}/${maxRetries} in ${delay}ms...`);
        await new Promise((res) => setTimeout(res, delay));
        delay *= 2; // exponential backoff
        continue;
      }

      // Non-retriable error or exceeded retries
      break;
    }
  }

  // Format a friendly user-facing error message
  const is429 = lastError?.message?.includes('429') || lastError?.message?.includes('RESOURCE_EXHAUSTED');
  if (is429) {
    throw new Error('Gemini API quota or rate limit reached. Please wait a moment before trying again.');
  }
  throw new Error(`AI generation error: ${lastError?.message || 'Unknown error occurred during synthesis.'}`);
}
