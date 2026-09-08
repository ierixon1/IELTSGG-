import { UserProfile, PlanTask, MockAttempt, ChecklistWeek, WritingGradingResult, SpeakingGradingResult, VocabCard, RewriteResult } from '../types';

/**
 * A grading request the server refused, carrying the reason. The screens map
 * `code` to a translated message; `details` holds whatever the endpoint
 * reported about the shortfall.
 */
export class GradingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GradingError';
  }
}

export interface SyncDataPayload { profile?: UserProfile; tasks?: PlanTask[]; attempts?: MockAttempt[]; checklist?: ChecklistWeek; }

function getLocalStorageKey(): string {
  try {
    const rawUser = localStorage.getItem('prep_auth_user');
    const user = rawUser ? JSON.parse(rawUser) : null;
    const userId = typeof user?.id === 'string' && user.id.length > 0 ? user.id : 'anonymous';
    return `prepielts_app_data_v1_${userId}`;
  } catch { return 'prepielts_app_data_v1_anonymous'; }
}

const sameOriginInit=(init:RequestInit={})=>({...init,credentials:'same-origin' as RequestCredentials});
const clearLocalAuth=()=>localStorage.removeItem('prep_auth_user');

export async function fetchInitialData(): Promise<{ profile: UserProfile; tasks: PlanTask[]; attempts: MockAttempt[]; checklist: ChecklistWeek }> {
  const fallback = { profile: { id: 'user_local', targetBand: 7.5, currentLevel: 6.0, hoursPerWeek: 12, weakSection: 'writing' as const, isOnboarded: false }, tasks: [] as PlanTask[], attempts: [] as MockAttempt[], checklist: { weekNumber: 1, weekStart: new Date().toISOString().split('T')[0], mocksDone: 0, mocksTarget: 2, essaysDone: 0, essaysTarget: 4, speakingDone: 0, speakingTarget: 5 } };
  const localStorageKey = getLocalStorageKey();
  try {
    const res = await fetch('/api/data', sameOriginInit());
    if (res.ok) {
      const data = await res.json();
      if (data?.profile) { localStorage.setItem(localStorageKey, JSON.stringify(data)); return { profile: data.profile, tasks: data.tasks || [], attempts: data.attempts || [], checklist: data.checklist || fallback.checklist }; }
    }
    if (res.status === 401) clearLocalAuth();
  } catch (e) { console.warn('Backend sync unavailable, using local cache:', e); }
  try { const cached = localStorage.getItem(localStorageKey); if (cached) return JSON.parse(cached); } catch (e) { console.error('LocalStorage parse error:', e); }
  return fallback;
}

export async function syncDataToServer(payload: SyncDataPayload) {
  const localStorageKey = getLocalStorageKey();
  try { const current = localStorage.getItem(localStorageKey); const parsed = current ? JSON.parse(current) : {}; localStorage.setItem(localStorageKey, JSON.stringify({ ...parsed, ...payload })); } catch (e) { console.error('Local save error:', e); }
  try {
    const requests: Promise<Response>[] = [];
    if (payload.profile) requests.push(fetch('/api/data/profile', sameOriginInit({ method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload.profile) })));
    if (payload.tasks) requests.push(fetch('/api/data/tasks', sameOriginInit({ method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({tasks:payload.tasks}) })));
    if (payload.checklist) requests.push(fetch('/api/data/checklist', sameOriginInit({ method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({checklist:[payload.checklist]}) })));
    if (payload.attempts?.length) for (const attempt of payload.attempts) requests.push(fetch('/api/data/attempts', sameOriginInit({ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(attempt) })));
    const results=await Promise.all(requests);if(results.some(r=>r.status===401))clearLocalAuth();
  } catch(e){console.warn('Could not sync to backend:',e);}
}

export async function fetchVocabCards(): Promise<VocabCard[]> {
  try {
    const res = await fetch('/api/data/vocab', sameOriginInit());
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.cards) ? data.cards : [];
  } catch (error) {
    console.warn('Could not load vocabulary:', error);
    return [];
  }
}

export async function saveVocabCards(cards: VocabCard[]): Promise<void> {
  try {
    await fetch('/api/data/vocab', sameOriginInit({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cards }) }));
  } catch (error) {
    console.warn('Could not save vocabulary:', error);
  }
}

export async function requestWritingGrading(params:{taskType:'task1'|'task2';prompt:string;essay:string}):Promise<WritingGradingResult>{const res=await fetch('/api/grade/writing',sameOriginInit({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params)}));if(!res.ok){const err=await res.json().catch(()=>({}));throw new GradingError(String(err.code||'unknown'),String(err.error||'Server failed to grade writing'),err);}return res.json();}
export async function requestSpeakingGrading(params:{topic:string;cueCard?:string;partNumber:number;audioBase64?:string;mimeType?:string;transcriptProvided?:string;clientMetrics?:any}):Promise<SpeakingGradingResult>{const res=await fetch('/api/grade/speaking',sameOriginInit({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params)}));if(!res.ok){const err=await res.json().catch(()=>({}));throw new GradingError(String(err.code||'unknown'),String(err.error||'Server failed to grade speaking'),err);}return res.json();}
export async function requestParagraphRewrite(params:{paragraph:string;prompt?:string}):Promise<RewriteResult>{const res=await fetch('/api/writing/improve',sameOriginInit({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params)}));if(!res.ok){const err=await res.json().catch(()=>({}));throw new GradingError(String(err.code||'unknown'),String(err.error||'Rewrite failed'),err);}return res.json();}

export async function sendPreppyMessage(messages:{role:'user'|'assistant';content:string}[],userContext:any):Promise<string>{const res=await fetch('/api/preppy/chat',sameOriginInit({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages,userContext})}));if(!res.ok)throw new Error('Preppy AI service temporarily unavailable');return(await res.json()).reply;}
