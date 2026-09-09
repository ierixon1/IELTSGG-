import React, { useState, useEffect } from 'react';
import { 
  UserProfile, 
  PlanTask, 
  MockAttempt, 
  ChecklistWeek, 
  SkillType 
} from './types';
import { MOCK_TEST_1 } from './data/mockBank';
import { MockTest } from './types';
import { PublishedTestSummary, fetchAdaptedTest, fetchPublishedTests } from './services/publishedTests';
import { VocabCard, WritingGradingResult } from './types';
import { fetchInitialData, syncDataToServer, fetchVocabCards, saveVocabCards } from './services/api';
import { generateInitialPlan, recalculatePlan, RecalculationResult } from './utils/planEngine';
import { harvestFromSpeaking, harvestFromWriting } from './utils/vocabEngine';
import { Navbar, NavTab } from './components/Navbar';
import { PlanView } from './components/PlanView';
import { MocksHub } from './components/MocksHub';
import { ExamMode } from './components/ExamMode';
import { SpeakOrDieArcade } from './components/SpeakOrDieArcade';
import { StatisticsView } from './components/StatisticsView';
import { VocabTrainer } from './components/VocabTrainer';
import { OnboardingModal } from './components/OnboardingModal';
import { PreppyAIAssistant } from './components/PreppyAIAssistant';
import { AdminLogin } from './components/admin/AdminLogin';
import { AdminDashboard } from './components/admin/AdminDashboard';
import { AdminUser } from './types/admin';
import { LandingPage } from './components/landing/LandingPage';
import { AuthGate, AuthUser } from './components/AuthGate';
import { useT } from './i18n';

/**
 * The public marketing page and the product live at the same origin: `#/app`
 * is the product, everything else is the landing page. Returning learners skip
 * the landing entirely, so the app never gets in the way of daily practice.
 */
type View = 'landing' | 'app';

const ENTERED_KEY = 'ever_study_entered';

function readEnteredFlag(): boolean {
  try {
    return window.localStorage.getItem(ENTERED_KEY) === '1';
  } catch {
    return false;
  }
}

function resolveInitialView(): View {
  if (typeof window === 'undefined') return 'landing';
  if (window.location.hash.startsWith('#/app')) return 'app';
  return readEnteredFlag() ? 'app' : 'landing';
}

export default function App() {
  const t = useT();
  const [view, setView] = useState<View>(() => resolveInitialView());
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [activeTab, setActiveTab] = useState<NavTab>('plan');
  const [profile, setProfile] = useState<UserProfile>({ id: 'user_local', targetBand: 7.5, currentLevel: 6.0, hoursPerWeek: 12, weakSection: 'writing', isOnboarded: false });
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [attempts, setAttempts] = useState<MockAttempt[]>([]);
  const [checklist, setChecklist] = useState<ChecklistWeek>({ weekNumber: 1, weekStart: new Date().toISOString().split('T')[0], mocksDone: 0, mocksTarget: 2, essaysDone: 0, essaysTarget: 4, speakingDone: 0, speakingTarget: 5 });
  const [isOnboardingOpen, setIsOnboardingOpen] = useState<boolean>(false);
  const [isPreppyOpen, setIsPreppyOpen] = useState<boolean>(false);
  const [lastRecalc, setLastRecalc] = useState<RecalculationResult | undefined>(undefined);
  const [targetedMocksSection, setTargetedMocksSection] = useState<SkillType | null>(null);
  const [vocabCards, setVocabCards] = useState<VocabCard[]>([]);

  /**
   * The built-in test plus anything published from the CMS. Selecting one
   * swaps the material every session screen works from.
   */
  const [publishedTests, setPublishedTests] = useState<PublishedTestSummary[]>([]);
  const [activeTest, setActiveTest] = useState<MockTest>(MOCK_TEST_1);
  const [activeTestId, setActiveTestId] = useState<string>(MOCK_TEST_1.id);
  /** Skills the selected bundle named but could not supply. */
  const [activeTestGaps, setActiveTestGaps] = useState<SkillType[]>([]);

  const [adminUser, setAdminUser] = useState<AdminUser | null>(() => {
    try {
      const saved = localStorage.getItem('prep_admin_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  // Browser cache is only a UI hint; the server-side cookie is authoritative.
  useEffect(() => {
    if (!adminUser) return;
    let active = true;
    fetch('/api/admin/me', { credentials: 'same-origin' })
      .then(async (res) => {
        if (!active) return;
        if (!res.ok) {
          localStorage.removeItem('prep_admin_user');
          setAdminUser(null);
          return;
        }
        const data = await res.json().catch(() => null);
        if (data?.admin) {
          localStorage.setItem('prep_admin_user', JSON.stringify(data.admin));
          setAdminUser(data.admin);
        } else {
          localStorage.removeItem('prep_admin_user');
          setAdminUser(null);
        }
      })
      .catch(() => {
        if (!active) return;
        localStorage.removeItem('prep_admin_user');
        setAdminUser(null);
      });
    return () => { active = false; };
  }, []);

  // The cookie is authoritative; the cached user object is only a UI hint.
  useEffect(() => {
    let active = true;
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!active) return;
        const user = (data?.user as AuthUser | undefined) || null;
        if (user) localStorage.setItem('prep_auth_user', JSON.stringify(user));
        else localStorage.removeItem('prep_auth_user');
        setAuthUser(user);
      })
      .catch(() => {
        if (!active) return;
        localStorage.removeItem('prep_auth_user');
        setAuthUser(null);
      })
      .finally(() => {
        if (active) setCheckingSession(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // A learner's plan is per-account, so there is nothing to load until we know
  // who is asking.
  useEffect(() => {
    if (!authUser) return;

    async function init() {
      const data = await fetchInitialData();
      setProfile(data.profile);
      setAttempts(data.attempts || []);
      setChecklist(data.checklist);
      if (data.tasks && data.tasks.length > 0) setTasks(data.tasks);
      else {
        const initialTasks = generateInitialPlan(data.profile);
        setTasks(initialTasks);
        syncDataToServer({ tasks: initialTasks });
      }
      if (!data.profile.isOnboarded) setIsOnboardingOpen(true);
      setVocabCards(await fetchVocabCards());
      setPublishedTests(await fetchPublishedTests());
    }
    init();
  }, [authUser]);

  // Keep the view in sync with the address bar so back/forward behave.
  useEffect(() => {
    const onHashChange = () => {
      setView(window.location.hash.startsWith('#/app') ? 'app' : 'landing');
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const handleEnterApp = () => {
    try {
      window.localStorage.setItem(ENTERED_KEY, '1');
    } catch {
      /* Remembering the choice is a convenience, not a requirement. */
    }
    window.location.hash = '#/app';
    window.scrollTo({ top: 0, behavior: 'auto' });
    setView('app');
  };

  const handleBackToLanding = () => {
    window.location.hash = '';
    setView('landing');
  };

  const handleSignOut = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      localStorage.removeItem('prep_auth_user');
      setAuthUser(null);
      handleBackToLanding();
    }
  };

  const handleSelectTest = async (id: string) => {
    if (id === MOCK_TEST_1.id) {
      setActiveTest(MOCK_TEST_1);
      setActiveTestId(MOCK_TEST_1.id);
      setActiveTestGaps([]);
      return;
    }

    const adapted = await fetchAdaptedTest(id);
    if (adapted) {
      setActiveTest(adapted.test);
      setActiveTestId(id);
      // Recorded, not hidden: a bundle that could not supply a skill is still
      // opened with built-in material today, and the learner has to be told.
      setActiveTestGaps(adapted.missingSections);
    }
  };

  const persistVocab = (cards: VocabCard[]) => {
    setVocabCards(cards);
    saveVocabCards(cards);
  };

  /**
   * Grading is the only source of vocabulary cards: whatever the examiner
   * flagged, plus the words the answer leaned on. Nothing is added from a
   * stock list.
   */
  const handleWritingGraded = (result: WritingGradingResult, essay: string) => {
    const harvested = harvestFromWriting(result, essay, vocabCards);
    if (harvested.length > 0) persistVocab([...vocabCards, ...harvested]);
  };

  const handleSpeakingGraded = (transcript: string) => {
    const harvested = harvestFromSpeaking(transcript, vocabCards);
    if (harvested.length > 0) persistVocab([...vocabCards, ...harvested]);
  };

  const handleSaveProfile = (updatedProfile: UserProfile) => {
    setProfile(updatedProfile);
    const newTasks = generateInitialPlan(updatedProfile);
    setTasks(newTasks);
    syncDataToServer({ profile: updatedProfile, tasks: newTasks });
  };

  const handleToggleTask = (taskId: string) => {
    setTasks((prev) => {
      const next = prev.map((t) => (t.id === taskId ? { ...t, completed: !t.completed } : t));
      syncDataToServer({ tasks: next });
      return next;
    });
  };

  const handleStartTask = (task: PlanTask) => {
    if (task.sectionId === 'arcade' || task.taskType === 'criteria_drill') setActiveTab('arcade');
    else if (task.sectionId === 'exam-mode' || task.taskType === 'full_mock') setActiveTab('exam');
    else { setTargetedMocksSection(task.skill); setActiveTab('mocks'); }
  };

  /**
   * Applies a recalculation: new task weights, and the weakness it diagnosed.
   *
   * The diagnosed skill used to be discarded, so the plan kept presenting the
   * learner's own self-assessment from onboarding as their "current" weakness
   * no matter how many graded attempts contradicted it.
   */
  const applyRecalculation = (
    recalculated: RecalculationResult,
    extra: { attempts?: MockAttempt[]; checklist?: ChecklistWeek } = {},
  ) => {
    setTasks(recalculated.updatedTasks);
    setLastRecalc(recalculated);

    const diagnosed = recalculated.diagnosedWeakSkill;
    const nextProfile =
      diagnosed && diagnosed !== profile.weakSection
        ? { ...profile, weakSection: diagnosed }
        : null;
    if (nextProfile) setProfile(nextProfile);

    syncDataToServer({
      tasks: recalculated.updatedTasks,
      ...(nextProfile ? { profile: nextProfile } : {}),
      ...extra,
    });
  };

  const handleRecalculatePlan = () => {
    applyRecalculation(recalculatePlan(tasks, attempts, profile));
  };

  const handleRecordScore = (skill: SkillType, band: number, raw?: number) => {
    const newAttempt: MockAttempt = {
      id: `attempt-${Date.now()}`,
      // The test actually sat, so statistics can tell a CMS-published test
      // apart from the built-in one.
      testId: activeTestId,
      testTitle: activeTest.title,
      mode: 'practice',
      date: new Date().toISOString().split('T')[0],
      isFullMock: false,
      scores: { overall: band, [skill]: { band, rawScore: raw } },
      durationMinutes: skill === 'reading' || skill === 'writing' ? 60 : 30,
    };
    const nextAttempts = [...attempts, newAttempt];
    setAttempts(nextAttempts);
    const nextChecklist = { ...checklist };
    if (skill === 'writing') nextChecklist.essaysDone = (nextChecklist.essaysDone || 0) + 1;
    if (skill === 'speaking') nextChecklist.speakingDone = (nextChecklist.speakingDone || 0) + 1;
    setChecklist(nextChecklist);
    applyRecalculation(recalculatePlan(tasks, nextAttempts, profile), {
      attempts: nextAttempts,
      checklist: nextChecklist,
    });
  };

  const handleCompleteFullExam = (attempt: MockAttempt) => {
    const nextAttempts = [...attempts, attempt];
    setAttempts(nextAttempts);
    const nextChecklist = { ...checklist, mocksDone: (checklist.mocksDone || 0) + 1 };
    setChecklist(nextChecklist);
    applyRecalculation(recalculatePlan(tasks, nextAttempts, profile), {
      attempts: nextAttempts,
      checklist: nextChecklist,
    });
  };

  if (view === 'landing') {
    return <LandingPage onEnterApp={handleEnterApp} />;
  }

  if (checkingSession) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas text-sm text-ink-400">
        {t('auth.checking')}
      </div>
    );
  }

  if (!authUser) {
    return <AuthGate onAuthenticated={setAuthUser} onBack={handleBackToLanding} />;
  }

  return (
    <div className="min-h-screen bg-canvas text-ink-900 flex flex-col font-sans antialiased">
      {/* Navbar */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={(tab) => { setActiveTab(tab); setTargetedMocksSection(null); }}
        profile={profile}
        onOpenOnboarding={() => setIsOnboardingOpen(true)}
        onOpenPreppy={() => setIsPreppyOpen(true)}
        onGoHome={handleBackToLanding}
        onSignOut={handleSignOut}
        isAdminAuthenticated={Boolean(adminUser)}
      />
      {/* Keyed on the tab so each screen replays its entrance on arrival. */}
      <main
        key={activeTab}
        className="es-enter flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8"
      >
        {activeTab === 'plan' && <PlanView tasks={tasks} profile={profile} attempts={attempts} onToggleTask={handleToggleTask} onStartTask={handleStartTask} onRecalculatePlan={handleRecalculatePlan} lastRecalc={lastRecalc} />}
        {activeTab === 'mocks' && <MocksHub mockTest={activeTest} onRecordScore={handleRecordScore} initialSelectedSection={targetedMocksSection} onWritingGraded={handleWritingGraded} onSpeakingGraded={handleSpeakingGraded} publishedTests={publishedTests} activeTestId={activeTestId} builtInTestId={MOCK_TEST_1.id} onSelectTest={handleSelectTest} missingSections={activeTestGaps} />}
        {activeTab === 'exam' && <ExamMode mockTest={activeTest} onCompleteExam={handleCompleteFullExam} onExitExam={() => setActiveTab('plan')} />}
        {activeTab === 'arcade' && <SpeakOrDieArcade />}
        {activeTab === 'vocab' && <VocabTrainer cards={vocabCards} onUpdateCards={persistVocab} />}
        {activeTab === 'stats' && <StatisticsView profile={profile} attempts={attempts} tasks={tasks} checklist={checklist} onOpenExamMode={() => setActiveTab('exam')} />}
        {activeTab === 'admin' && (
          <div>
            {!adminUser ? <AdminLogin onLoginSuccess={(user) => setAdminUser(user)} /> : (
              <AdminDashboard
                adminUser={adminUser}
                onLogout={async () => { try { await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }); } finally { localStorage.removeItem('prep_admin_user'); setAdminUser(null); } }}
              />
            )}
          </div>
        )}
      </main>

      {/* Legal & Educational Disclaimer Footer */}
      <footer className="bg-white border-t border-ink-100 mt-12 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <button
              onClick={handleBackToLanding}
              className="inline-flex items-center gap-2 text-sm font-bold text-ink-900 hover:text-brand-600 transition-colors"
            >
              Ever Study
              <span className="text-xs font-medium text-ink-400">· {t('brand.tagline')}</span>
            </button>
            <p className="text-xs text-ink-400">
              © {new Date().getFullYear()} Ever Study. {t('landing.footer.rights')}
            </p>
          </div>
          <p className="text-[11px] text-ink-400 leading-relaxed max-w-4xl">
            {t('landing.footer.disclaimer')}
          </p>
        </div>
      </footer>
      <OnboardingModal isOpen={isOnboardingOpen} onClose={() => setIsOnboardingOpen(false)} initialProfile={profile} onSave={handleSaveProfile} />
      <PreppyAIAssistant isOpen={isPreppyOpen} onClose={() => setIsPreppyOpen(false)} profile={profile} />
    </div>
  );
}
