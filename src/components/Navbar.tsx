import React from 'react';
import { 
  Calendar, 
  BookOpen, 
  Clock, 
  BarChart3, 
  Flame, 
  Sparkles, 
  Settings2,
  ShieldCheck
} from 'lucide-react';
import { UserProfile } from '../types';

export type NavTab = 'plan' | 'mocks' | 'exam' | 'stats' | 'arcade' | 'admin';

interface NavbarProps {
  activeTab: NavTab;
  setActiveTab: (tab: NavTab) => void;
  profile: UserProfile;
  onOpenOnboarding: () => void;
  onOpenPreppy: () => void;
  isAdminAuthenticated?: boolean;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  profile,
  onOpenOnboarding,
  onOpenPreppy,
}) => {
  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <div className="flex items-center space-x-3 cursor-pointer" onClick={() => setActiveTab('plan')}>
            <div className="w-10 h-10 rounded-xl bg-slate-900 text-white flex items-center justify-center font-extrabold text-xl tracking-tight shadow-md">
              9
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-bold text-slate-900 text-lg tracking-tight">PrepIELTS</span>
                <span className="bg-emerald-100 text-emerald-800 text-xs font-semibold px-2 py-0.5 rounded-full">
                  AI Studio
                </span>
              </div>
              <p className="text-xs text-slate-500 font-medium">Personal Band 7.5+ Engine</p>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="hidden md:flex items-center space-x-1">
            <button
              id="nav-tab-plan"
              onClick={() => setActiveTab('plan')}
              className={`flex items-center space-x-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === 'plan'
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
              }`}
            >
              <Calendar className="w-4 h-4" />
              <span>Adaptive Plan</span>
            </button>

            <button
              id="nav-tab-mocks"
              onClick={() => setActiveTab('mocks')}
              className={`flex items-center space-x-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === 'mocks'
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
              }`}
            >
              <BookOpen className="w-4 h-4" />
              <span>Mocks & Drills</span>
            </button>

            <button
              id="nav-tab-exam"
              onClick={() => setActiveTab('exam')}
              className={`flex items-center space-x-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === 'exam'
                  ? 'bg-amber-600 text-white shadow-sm'
                  : 'text-amber-700 hover:bg-amber-50'
              }`}
            >
              <Clock className="w-4 h-4" />
              <span>Exam Mode</span>
            </button>

            <button
              id="nav-tab-arcade"
              onClick={() => setActiveTab('arcade')}
              className={`flex items-center space-x-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === 'arcade'
                  ? 'bg-rose-600 text-white shadow-sm'
                  : 'text-rose-600 hover:bg-rose-50'
              }`}
            >
              <Flame className="w-4 h-4 text-rose-500" />
              <span className="font-semibold">Speak or Die</span>
            </button>

            <button
              id="nav-tab-stats"
              onClick={() => setActiveTab('stats')}
              className={`flex items-center space-x-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === 'stats'
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
              }`}
            >
              <BarChart3 className="w-4 h-4" />
              <span>Statistics</span>
            </button>
          </nav>

          {/* Right Action Bar */}
          <div className="flex items-center space-x-2 sm:space-x-3">
            {/* Admin CMS Button */}
            <button
              id="btn-open-admin-cms"
              onClick={() => setActiveTab('admin')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border transition-colors text-xs font-semibold ${
                activeTab === 'admin'
                  ? 'bg-slate-900 border-slate-900 text-white shadow-sm'
                  : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100 hover:text-slate-900'
              }`}
              title="IELTS Materials & CDI Exam Admin CMS"
            >
              <ShieldCheck className={`w-3.5 h-3.5 ${activeTab === 'admin' ? 'text-emerald-400' : 'text-slate-500'}`} />
              <span className="hidden lg:inline">Admin CMS</span>
            </button>

            {/* Preppy AI button */}
            <button
              id="btn-open-preppy"
              onClick={onOpenPreppy}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-700 hover:bg-indigo-100 transition-colors text-xs font-semibold"
            >
              <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
              <span>Preppy AI</span>
            </button>

            {/* Profile / Target Band Pill */}
            <button
              id="btn-target-band-recalibrate"
              onClick={onOpenOnboarding}
              className="flex items-center space-x-2 px-3 py-1.5 rounded-lg border border-slate-200 hover:border-slate-300 bg-slate-50 transition-colors"
              title="Click to recalibrate your target band and diagnostic baseline"
            >
              <div className="text-left hidden sm:block">
                <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Target</div>
                <div className="text-xs font-bold text-slate-900">Band {profile.targetBand.toFixed(1)}</div>
              </div>
              <div className="w-7 h-7 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold text-xs">
                {profile.targetBand}
              </div>
              <Settings2 className="w-3.5 h-3.5 text-slate-400" />
            </button>
          </div>
        </div>

        {/* Mobile Navigation bar */}
        <div className="flex md:hidden overflow-x-auto py-2 space-x-1 border-t border-slate-100">
          <button
            onClick={() => setActiveTab('plan')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
              activeTab === 'plan' ? 'bg-slate-900 text-white' : 'text-slate-600'
            }`}
          >
            Plan
          </button>
          <button
            onClick={() => setActiveTab('mocks')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
              activeTab === 'mocks' ? 'bg-slate-900 text-white' : 'text-slate-600'
            }`}
          >
            Mocks & Drills
          </button>
          <button
            onClick={() => setActiveTab('exam')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
              activeTab === 'exam' ? 'bg-amber-600 text-white' : 'text-amber-700'
            }`}
          >
            Exam Mode
          </button>
          <button
            onClick={() => setActiveTab('arcade')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
              activeTab === 'arcade' ? 'bg-rose-600 text-white' : 'text-rose-600'
            }`}
          >
            Speak or Die
          </button>
          <button
            onClick={() => setActiveTab('stats')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
              activeTab === 'stats' ? 'bg-slate-900 text-white' : 'text-slate-600'
            }`}
          >
            Statistics
          </button>
          <button
            onClick={() => setActiveTab('admin')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
              activeTab === 'admin' ? 'bg-slate-900 text-white' : 'text-slate-600'
            }`}
          >
            Admin CMS
          </button>
        </div>
      </div>
    </header>
  );
};
