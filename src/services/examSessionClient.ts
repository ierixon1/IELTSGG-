import type {
  ExamClientEvent,
  ExamSessionOpened,
  ExamSessionSummary,
  ExamSessionView,
  SpeakingGradedResponse,
  WritingGradedResponse,
} from '../types/examSession';
import type { SpokenAnswer } from '../components/SpeakingSession';

/**
 * The browser side of an exam session. Every call answers with the value or
 * with the server's refusal — status, code and message — never a guess.
 */

export type SessionCall<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string; details?: Record<string, unknown> };

async function call<T>(url: string, init: RequestInit = {}): Promise<SessionCall<T>> {
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    const body = await response.json().catch(() => null);
    if (response.status === 401) return { ok: false, status: 401, code: 'unauthorized', message: 'Sign in to sit this exam.' };
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code: typeof body?.code === 'string' ? body.code : 'invalid_bundle',
        message: typeof body?.error === 'string' ? body.error : `The exam session did not answer (${response.status}).`,
        ...(body?.details && typeof body.details === 'object' ? { details: body.details as Record<string, unknown> } : {}),
      };
    }
    return { ok: true, value: body as T };
  } catch {
    return { ok: false, status: 0, code: 'network', message: 'The server did not answer.' };
  }
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const at = (sessionId: string) => `/api/learner/exams/${encodeURIComponent(sessionId)}`;

export const listExamSessions = () => call<{ sessions: ExamSessionSummary[] }>('/api/learner/exams');
export const openExamSession = (bundleId: string) => call<ExamSessionOpened>('/api/learner/exams', post({ bundleId }));
export const getExamSession = (sessionId: string) => call<ExamSessionOpened>(at(sessionId));
export const sendExamEvents = (sessionId: string, events: ExamClientEvent[]) => call<ExamSessionView>(`${at(sessionId)}/events`, post({ events }));

/** Submits a Writing task. The server stores it, grading pending, and answers without waiting for any model. */
export const submitExamWriting = (sessionId: string, task: 1 | 2, essay: string) =>
  call<WritingGradedResponse>(`${at(sessionId)}/writing/${task}`, post({ essay }));
/** Asks the server to grade a submitted Writing task: pending, or failed with a run left. */
export const gradeExamWriting = (sessionId: string, task: 1 | 2) => call<WritingGradedResponse>(`${at(sessionId)}/writing/${task}/grade`, post({}));

export const submitExamSpeaking = (sessionId: string, part: 1 | 2 | 3, answer: SpokenAnswer) =>
  call<SpeakingGradedResponse>(`${at(sessionId)}/speaking/${part}`, post(answer));
export const gradeExamSpeaking = (sessionId: string, part: 1 | 2 | 3) => call<SpeakingGradedResponse>(`${at(sessionId)}/speaking/${part}/grade`, post({}));

export const abandonExamSession = (sessionId: string) => call<ExamSessionView>(`${at(sessionId)}/abandon`, post({}));

/**
 * Sends events while the page is being hidden or unloaded. `keepalive` lets the
 * request outlive the page, so answers typed in the last moments before a
 * reload are stored rather than dropped.
 */
export function sendExamEventsOnExit(sessionId: string, events: ExamClientEvent[]): void {
  if (events.length === 0) return;
  void fetch(`${at(sessionId)}/events`, {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  }).catch(() => undefined);
}
