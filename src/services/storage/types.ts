import { UserProfile, MockAttempt, PlanTask, ChecklistWeek } from '../../types';

export interface GeneratedTestRecord {
  id: string;
  userId: string;
  timestamp: string;
  module: 'academic' | 'general';
  section: 'reading' | 'listening' | 'writing' | 'speaking' | 'full_mock';
  targetBand: string;
  theme: string;
  contentHash: string;
  title: string;
  questionTypes: string[];
  data: any; // Full generated test JSON
}

/**
 * Textbooks used to live here, per learner, with a chunk that could record only
 * a page number and a section title. Nothing ever called any of it.
 *
 * A source library is shared admin content rather than one learner's upload,
 * and a chunk has to carry enough provenance to quote it back with a citation —
 * neither of which that model could do. It is replaced by `types/source.ts`
 * and `services/sourceStore.ts`.
 */
