import React, { useState, useEffect } from 'react';
import { 
  UserProfile, 
  PlanTask, 
  MockAttempt, 
  ChecklistWeek, 
  SkillType 
} from './types';
import { MOCK_TEST_1 } from './data/mockBank';
import { fetchInitialData, syncDataToServer } from './services/api';
import { generateInitialPlan, recalculatePlan } from './utils/planEngine';
import { calculateOverallBand } from './utils/ieltsScoring';
import { Navbar, NavTab } from './components/Navbar';
import { PlanView } from './components/PlanView';
import { MocksHub } from './components/MocksHub';
import { ExamMode } from './components/ExamMode';
import { SpeakOrDieArcade } from './components/SpeakOrDieArcade';
import { StatisticsView } from './components/StatisticsView';
import { OnboardingModal } from './components/OnboardingModal';
import { PreppyAIAssistant } from './components/PreppyAIAssistant';
import { AdminLogin } from './components/admin/AdminLogin';
import { AdminDashboard } from './components/admin/AdminDashboard';
import { AdminUser } from './types/admin';

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('plan');
  const [profile, setProfile] = useState<UserProfile>({
    id: 'user_local',
    targetBand: 7.5,
    currentLevel: 6.0,
    hoursPerWeek: 12,
    weakSection: 'writing',
    isOnboarded: false,
  });
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [attempts, setAttempts] = useState<MockAttempt[]>([]);
  const [checklist, setChecklist] = useState<ChecklistWeek>({
    weekNumber: 1,
    weekStart: new Date().toISOString().split('T')[0],
    mocksDone: 0,
    mocksTarget: 2,
    essaysDone: 0,
    essaysTarget: 4,
    speakingDone: 0,
    speakingTarget: 5,
  });

  const [isOnboardingOpen, setIsOnboardingOpen] = useState<boolean>(false);
  const [isPreppyOpen, setIsPreppyOpen] = useState<boolean>(false);
  const [lastRecalcReason, setLastRecalcReason] = useState<string | undefined>(undefined);
  const [targetedMocksSection, setTargetedMocksSection] = useState<SkillType | null>(null);

  // Admin CMS authentication state
  const [adminUser, setAdminUser] = useState<AdminUser | null>(() => {
    try {
      const saved = localStorage.getItem('prep_admin_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  // Load initial data on mount
  useEffect(() => {
    async function init() {
      const data = await fetchInitialData();
      setProfile(data.profile);
      setAttempts(data.attempts || []);
      setChecklist(data.checklist);

      if (data.tasks && data.tasks.length > 0) {
        setTasks(data.tasks);
      } else {
        const initialTasks = generateInitialPlan(data.profile);
        setTasks(initialTasks);
        syncDataToServer({ tasks: initialTasks });
      }

      if (!data.profile.isOnboarded) {
        setIsOnboardingOpen(true);
      }
    }
    init();
  }, []);

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
    if (task.sectionId === 'arcade' || task.taskType === 'criteria_drill') {
      setActiveTab('arcade');
    } else if (task.sectionId === 'exam-mode' || task.taskType === 'full_mock') {
      setActiveTab('exam');
    } else {
      setTargetedMocksSection(task.skill);
      setActiveTab('mocks');
    }
  };

  const handleRecalculatePlan = () => {
    const { updatedTasks, reason } = recalculatePlan(tasks, attempts, profile);
    setTasks(updatedTasks);
    setLastRecalcReason(reason);
    syncDataToServer({ tasks: updatedTasks });
  };

  const handleRecordScore = (skill: SkillType, band: number, raw?: number) => {
    // Record new attempt
    const newAttempt: MockAttempt = {
      id: `attempt-${Date.now()}`,
      testId: 'test-1',
      date: new Date().toISOString().split('T')[0],
      isFullMock: false,
      scores: {
        overall: band,
        [skill]: { band, rawScore: raw },
      },
      durationMinutes: skill === 'reading' || skill === 'writing' ? 60 : 30,
    };

    const nextAttempts = [...attempts, newAttempt];
    setAttempts(nextAttempts);

    // Update checklist counters
    const nextChecklist = { ...checklist };
    if (skill === 'writing') nextChecklist.essaysDone = (nextChecklist.essaysDone || 0) + 1;
    if (skill === 'speaking') nextChecklist.speakingDone = (nextChecklist.speakingDone || 0) + 1;
    setChecklist(nextChecklist);

    // Dynamic Recalculation after test
    const { updatedTasks, reason } = recalculatePlan(tasks, nextAttempts, profile);
    setTasks(updatedTasks);
    setLastRecalcReason(reason);

    syncDataToServer({
      attempts: nextAttempts,
      checklist: nextChecklist,
      tasks: updatedTasks,
    });
  };

  const handleCompleteFullExam = (attempt: MockAttempt) => {
    const nextAttempts = [...attempts, attempt];
    setAttempts(nextAttempts);

    const nextChecklist = {
      ...checklist,
      mocksDone: (checklist.mocksDone || 0) + 1,
    };
    setChecklist(nextChecklist);

    const { updatedTasks, reason } = recalculatePlan(tasks, nextAttempts, profile);
    setTasks(updatedTasks);
    setLastRecalcReason(reason);

    syncDataToServer({
      attempts: nextAttempts,
      checklist: nextChecklist,
      tasks: updatedTasks,
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans antialiased">
      {/* Navbar */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={(tab) => {
          setActiveTab(tab);
          setTargetedMocksSection(null);
        }}
        profile={profile}
        onOpenOnboarding={() => setIsOnboardingOpen(true)}
        onOpenPreppy={() => setIsPreppyOpen(true)}
        isAdminAuthenticated={Boolean(adminUser)}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {activeTab === 'plan' && (
          <PlanView
            tasks={tasks}
            profile={profile}
            attempts={attempts}
            onToggleTask={handleToggleTask}
            onStartTask={handleStartTask}
            onRecalculatePlan={handleRecalculatePlan}
            lastRecalcReason={lastRecalcReason}
          />
        )}

        {activeTab === 'mocks' && (
          <MocksHub
            mockTest={MOCK_TEST_1}
            onRecordScore={handleRecordScore}
            initialSelectedSection={targetedMocksSection}
          />
        )}

        {activeTab === 'exam' && (
          <ExamMode
            mockTest={MOCK_TEST_1}
            onCompleteExam={handleCompleteFullExam}
            onExitExam={() => setActiveTab('plan')}
          />
        )}

        {activeTab === 'arcade' && <SpeakOrDieArcade />}

        {activeTab === 'stats' && (
          <StatisticsView
            profile={profile}
            attempts={attempts}
            tasks={tasks}
            checklist={checklist}
            onOpenExamMode={() => setActiveTab('exam')}
          />
        )}

        {activeTab === 'admin' && (
          <div>
            {!adminUser ? (
              <AdminLogin
                onLoginSuccess={(user) => setAdminUser(user)}
              />
            ) : (
              <AdminDashboard
                adminUser={adminUser}
                onLogout={async () => { try { await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }); } finally { localStorage.removeItem('prep_admin_user'); setAdminUser(null); } }}
              />
            )}
          </div>
        )}
      </main>

      {/* Legal & Educational Disclaimer Footer */}
      <footer className="bg-white border-t border-slate-200 mt-12 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-3 text-center sm:text-left">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center space-x-2 justify-center sm:justify-start">
              <span className="font-bold text-slate-900 text-sm">PrepIELTS AI Studio</span>
              <span className="text-xs text-slate-400">• Personal IELTS® Preparation Platform</span>
            </div>
            <div className="text-xs text-slate-500 font-medium">
              Single-User Private Architecture • Local & Cloud Storage • Zero Third-Party Tracking
            </div>
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed max-w-4xl">
            IELTS® is a registered trademark of University of Cambridge, British Council, and IDP Education Australia.
            This application is an independent educational tool designed exclusively for personal non-commercial study.
            All academic passages, listening dialogues, questions, and cue cards are original synthetic materials crafted for skill mastery and are not affiliated with or endorsed by Cambridge, British Council, or IDP.
          </p>
        </div>
      </footer>

      {/* Modals & Slide-overs */}
      <OnboardingModal
        isOpen={isOnboardingOpen}
        onClose={() => setIsOnboardingOpen(false)}
        initialProfile={profile}
        onSave={handleSaveProfile}
      />

      <PreppyAIAssistant
        isOpen={isPreppyOpen}
        onClose={() => setIsPreppyOpen(false)}
        profile={profile}
      />
    </div>
  );
}
