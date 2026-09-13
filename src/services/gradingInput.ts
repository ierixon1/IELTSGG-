/**
 * What a Writing or Speaking submission must be before any model is asked to grade it.
 *
 * Pure and free of the model SDK, so the exam session checks a submission with
 * exactly these rules *before* it stores it: work no model could grade — an empty
 * essay, a few words, two seconds of noise — is refused and stays in the learner's
 * hands, rather than being accepted and then failing to grade.
 *
 * The floors are deliberately low. They exist to catch "asdf", not to police
 * short-but-real attempts.
 */

export const MIN_GRADABLE_WORDS = 40;
export const MIN_GRADABLE_SPOKEN_WORDS = 15;
export const MIN_GRADABLE_SPEECH_SECONDS = 10;
/** The largest recording accepted, base64-encoded. */
export const MAX_AUDIO_BASE64_CHARS = 12_000_000;

export interface WritingSubmission {
  taskType: unknown;
  prompt: unknown;
  essay: unknown;
  /** Academic or General Training. Task 1 differs between them, so the examiner must be told which. */
  module: unknown;
}

export interface SpeakingSubmission {
  topic: unknown;
  cueCard?: unknown;
  partNumber: unknown;
  audioBase64?: unknown;
  mimeType?: unknown;
  transcriptProvided?: unknown;
  clientMetrics?: { durationSeconds?: unknown } | null;
}

export interface InputRefusal {
  ok: false;
  status: number;
  body: { error: string; code?: string } & Record<string, unknown>;
}

export interface CheckedWriting {
  ok: true;
  taskType: 'task1' | 'task2';
  module: 'academic' | 'general';
  prompt: string;
  essay: string;
  wordCount: number;
  /** The task's word target, which the result reports against. */
  minWords: number;
}

export interface CheckedSpeaking {
  ok: true;
  partNumber: 1 | 2 | 3;
  topic: string;
  cueCard?: string;
  audioBase64?: string;
  mimeType?: string;
  transcriptProvided?: string;
  /** The measured length of the recording, or 0 when none was measured. */
  spokenSeconds: number;
}

const refuse = (status: number, body: InputRefusal['body']): InputRefusal => ({ ok: false, status, body });

export function checkWritingSubmission({ taskType, prompt, essay, module }: WritingSubmission): CheckedWriting | InputRefusal {
  if (taskType !== 'task1' && taskType !== 'task2') return refuse(400, { error: 'Invalid task type.' });
  if (module !== 'academic' && module !== 'general') return refuse(400, { error: 'The test module (Academic or General Training) is required.' });
  if (typeof prompt !== 'string' || prompt.length > 12000) return refuse(400, { error: 'Invalid prompt.' });
  if (typeof essay !== 'string' || !essay.trim() || essay.length > 30000) return refuse(400, { error: 'Essay is missing or too large.' });
  const wordCount = essay.trim().split(/\s+/).filter(Boolean).length;
  // Below this there is nothing to assess against the descriptors, and a
  // band returned anyway would be a guess dressed as a measurement.
  if (wordCount < MIN_GRADABLE_WORDS) {
    return refuse(400, { error: 'Response is too short to assess.', code: 'too_short', wordCount, minimum: MIN_GRADABLE_WORDS });
  }
  return { ok: true, taskType, module, prompt, essay, wordCount, minWords: taskType === 'task1' ? 150 : 250 };
}

export function checkSpeakingSubmission({
  topic,
  cueCard,
  partNumber,
  audioBase64,
  mimeType,
  transcriptProvided,
  clientMetrics,
}: SpeakingSubmission): CheckedSpeaking | InputRefusal {
  if (partNumber !== 1 && partNumber !== 2 && partNumber !== 3) return refuse(400, { error: 'Invalid speaking part.' });
  if (typeof topic !== 'string' || topic.length > 5000) return refuse(400, { error: 'Invalid topic.' });
  if (typeof cueCard !== 'undefined' && (typeof cueCard !== 'string' || cueCard.length > 8000)) return refuse(400, { error: 'Invalid cue card.' });
  if (typeof transcriptProvided !== 'undefined' && (typeof transcriptProvided !== 'string' || transcriptProvided.length > 30000)) {
    return refuse(400, { error: 'Invalid transcript.' });
  }
  if (typeof audioBase64 !== 'undefined' && typeof audioBase64 !== 'string') return refuse(400, { error: 'Invalid audio payload.' });
  if (typeof audioBase64 === 'string' && audioBase64.length > MAX_AUDIO_BASE64_CHARS) return refuse(413, { error: 'Audio payload is too large.' });
  if (!audioBase64 && !transcriptProvided) return refuse(400, { error: 'Either audio data or transcript is required.' });
  // A couple of seconds of audio, or a handful of typed words, carries no
  // evidence for any of the four criteria.
  const spokenSeconds = Number(clientMetrics?.durationSeconds) || 0;
  const typedWords = typeof transcriptProvided === 'string' ? transcriptProvided.trim().split(/\s+/).filter(Boolean).length : 0;
  const tooShort = audioBase64 ? spokenSeconds > 0 && spokenSeconds < MIN_GRADABLE_SPEECH_SECONDS : typedWords < MIN_GRADABLE_SPOKEN_WORDS;
  if (tooShort) {
    return refuse(400, {
      error: 'Answer is too short to assess.',
      code: 'too_short',
      seconds: spokenSeconds,
      minimumSeconds: MIN_GRADABLE_SPEECH_SECONDS,
      words: typedWords,
      minimumWords: MIN_GRADABLE_SPOKEN_WORDS,
    });
  }
  return {
    ok: true,
    partNumber,
    topic,
    ...(typeof cueCard === 'string' ? { cueCard } : {}),
    ...(typeof audioBase64 === 'string' && audioBase64 ? { audioBase64 } : {}),
    ...(typeof mimeType === 'string' && mimeType ? { mimeType: mimeType.slice(0, 100) } : {}),
    ...(typeof transcriptProvided === 'string' && transcriptProvided.trim() ? { transcriptProvided } : {}),
    spokenSeconds,
  };
}
