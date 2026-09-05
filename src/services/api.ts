import {
  UserProfile,
  PlanTask,
  MockAttempt,
  ChecklistWeek,
  WritingGradingResult,
  SpeakingGradingResult,
} from '../types';

export interface SyncDataPayload {
  profile?: UserProfile;
  tasks?: PlanTask[];
  attempts?: MockAttempt[];
  checklist?: ChecklistWeek;
}

const LOCAL_STORAGE_KEY = 'prepielts_app_data_v1';

export async function fetchInitialData(): Promise<{
  profile: UserProfile;
  tasks: PlanTask[];
  attempts: MockAttempt[];
  checklist: ChecklistWeek;
}> {
  // Default fallback data
  const fallback = {
    profile: {
      id: 'user_local',
      targetBand: 7.5,
      currentLevel: 6.0,
      hoursPerWeek: 12,
      weakSection: 'writing' as const,
      isOnboarded: false,
    },
    tasks: [] as PlanTask[],
    attempts: [] as MockAttempt[],
    checklist: {
      weekNumber: 1,
      weekStart: new Date().toISOString().split('T')[0],
      mocksDone: 0,
      mocksTarget: 2,
      essaysDone: 0,
      essaysTarget: 4,
      speakingDone: 0,
      speakingTarget: 5,
    },
  };

  // Try fetching from server
  try {
    const res = await fetch('/api/data');
    if (res.ok) {
      const data = await res.json();
      if (data && data.profile) {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
        return {
          profile: data.profile,
          tasks: data.tasks || [],
          attempts: data.attempts || [],
          checklist: data.checklist || fallback.checklist,
        };
      }
    }
  } catch (e) {
    console.warn('Backend sync unavailable, using local cache:', e);
  }

  // Fallback to localStorage
  try {
    const cached = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (e) {
    console.error('LocalStorage parse error:', e);
  }

  return fallback;
}

export async function syncDataToServer(payload: SyncDataPayload) {
  // Optimistically store locally
  try {
    const current = localStorage.getItem(LOCAL_STORAGE_KEY);
    const parsed = current ? JSON.parse(current) : {};
    const merged = { ...parsed, ...payload };
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(merged));
  } catch (e) {
    console.error('Local save error:', e);
  }

  // Send to server
  try {
    await fetch('/api/data/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn('Could not sync to backend:', e);
  }
}

export async function requestWritingGrading(params: {
  taskType: 'task1' | 'task2';
  prompt: string;
  essay: string;
}): Promise<WritingGradingResult> {
  const res = await fetch('/api/grade/writing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Grading failed' }));
    throw new Error(err.error || 'Server failed to grade writing');
  }

  return res.json();
}

export async function requestSpeakingGrading(params: {
  topic: string;
  cueCard?: string;
  partNumber: number;
  audioBase64?: string;
  mimeType?: string;
  transcriptProvided?: string;
  clientMetrics?: any;
}): Promise<SpeakingGradingResult> {
  const res = await fetch('/api/grade/speaking', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Speaking grading failed' }));
    throw new Error(err.error || 'Server failed to grade speaking');
  }

  return res.json();
}

export async function sendPreppyMessage(
  messages: { role: 'user' | 'assistant'; content: string }[],
  userContext: any
): Promise<string> {
  const res = await fetch('/api/preppy/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, userContext }),
  });

  if (!res.ok) {
    throw new Error('Preppy AI service temporarily unavailable');
  }

  const data = await res.json();
  return data.reply;
}
