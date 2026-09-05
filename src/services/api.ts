import { UserProfile, PlanTask, MockAttempt, ChecklistWeek, WritingGradingResult, SpeakingGradingResult } from '../types';

export interface SyncDataPayload { profile?: UserProfile; tasks?: PlanTask[]; attempts?: MockAttempt[]; checklist?: ChecklistWeek; }
const LOCAL_STORAGE_KEY = 'prepielts_app_data_v1';
function authHeaders(extra: Record<string, string> = {}): Record<string, string> { const token = localStorage.getItem('prep_auth_token'); return token ? { ...extra, Authorization: `Bearer ${token}` } : extra; }

export async function fetchInitialData(): Promise<{ profile: UserProfile; tasks: PlanTask[]; attempts: MockAttempt[]; checklist: ChecklistWeek }> {
  const fallback = { profile: { id: 'user_local', targetBand: 7.5, currentLevel: 6.0, hoursPerWeek: 12, weakSection: 'writing' as const, isOnboarded: false }, tasks: [] as PlanTask[], attempts: [] as MockAttempt[], checklist: { weekNumber: 1, weekStart: new Date().toISOString().split('T')[0], mocksDone: 0, mocksTarget: 2, essaysDone: 0, essaysTarget: 4, speakingDone: 0, speakingTarget: 5 } };
  try { const res = await fetch('/api/data', { headers: authHeaders() }); if (res.ok) { const data = await res.json(); if (data?.profile) { localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data)); return { profile: data.profile, tasks: data.tasks || [], attempts: data.attempts || [], checklist: data.checklist || fallback.checklist }; } } } catch (e) { console.warn('Backend sync unavailable, using local cache:', e); }
  try { const cached = localStorage.getItem(LOCAL_STORAGE_KEY); if (cached) return JSON.parse(cached); } catch (e) { console.error('LocalStorage parse error:', e); }
  return fallback;
}

export async function syncDataToServer(payload: SyncDataPayload) {
  try { const current = localStorage.getItem(LOCAL_STORAGE_KEY); const parsed = current ? JSON.parse(current) : {}; localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ ...parsed, ...payload })); } catch (e) { console.error('Local save error:', e); }
  try {
    const requests: Promise<Response>[] = [];
    if (payload.profile) requests.push(fetch('/api/data/profile', { method: 'PUT', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload.profile) }));
    if (payload.tasks) requests.push(fetch('/api/data/tasks', { method: 'PUT', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ tasks: payload.tasks }) }));
    if (payload.checklist) requests.push(fetch('/api/data/checklist', { method: 'PUT', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ checklist: [payload.checklist] }) }));
    if (payload.attempts?.length) {
      const lastAttempt = payload.attempts[payload.attempts.length - 1];
      if (lastAttempt) requests.push(fetch('/api/data/attempts', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(lastAttempt) }));
    }
    await Promise.all(requests);
  } catch (e) { console.warn('Could not sync to backend:', e); }
}

export async function requestWritingGrading(params: { taskType: 'task1' | 'task2'; prompt: string; essay: string }): Promise<WritingGradingResult> {
  const res = await fetch('/api/grade/writing', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(params) });
  if (!res.ok) { const err = await res.json().catch(() => ({ error: 'Grading failed' })); throw new Error(err.error || 'Server failed to grade writing'); }
  return res.json();
}

export async function requestSpeakingGrading(params: { topic: string; cueCard?: string; partNumber: number; audioBase64?: string; mimeType?: string; transcriptProvided?: string; clientMetrics?: any }): Promise<SpeakingGradingResult> {
  const res = await fetch('/api/grade/speaking', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(params) });
  if (!res.ok) { const err = await res.json().catch(() => ({ error: 'Speaking grading failed' })); throw new Error(err.error || 'Server failed to grade speaking'); }
  return res.json();
}

export async function sendPreppyMessage(messages: { role: 'user' | 'assistant'; content: string }[], userContext: any): Promise<string> {
  const res = await fetch('/api/preppy/chat', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ messages, userContext }) });
  if (!res.ok) throw new Error('Preppy AI service temporarily unavailable');
  return (await res.json()).reply;
}
