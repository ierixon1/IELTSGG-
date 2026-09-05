import React, { useState } from 'react';
import { MockTest, SkillType } from '../types';
import { ListeningSession } from './ListeningSession';
import { ReadingSession } from './ReadingSession';
import { WritingSession } from './WritingSession';
import { SpeakingSession } from './SpeakingSession';
import { 
  Headphones, 
  BookOpen, 
  PenTool, 
  Mic, 
  ArrowRight, 
  CheckCircle2, 
  Sparkles,
  Clock,
  Layers,
  Award
} from 'lucide-react';

interface MocksHubProps {
  mockTest: MockTest;
  onRecordScore: (skill: SkillType, band: number, raw?: number) => void;
  initialSelectedSection?: SkillType | null;
}

export const MocksHub: React.FC<MocksHubProps> = ({
  mockTest,
  onRecordScore,
  initialSelectedSection,
}) => {
  const [activeSection, setActiveSection] = useState<SkillType | null>(initialSelectedSection || null);

  // If a section is active, render that specific module
  if (activeSection === 'listening') {
    return (
      <ListeningSession
        listeningData={mockTest.listening}
        onRecordScore={(band, raw) => onRecordScore('listening', band, raw)}
        onBackToMocks={() => setActiveSection(null)}
      />
    );
  }

  if (activeSection === 'reading') {
    return (
      <ReadingSession
        readingData={mockTest.reading}
        onRecordScore={(band, raw) => onRecordScore('reading', band, raw)}
        onBackToMocks={() => setActiveSection(null)}
      />
    );
  }

  if (activeSection === 'writing') {
    return (
      <WritingSession
        task1Data={mockTest.writing.task1}
        task2Data={mockTest.writing.task2}
        onRecordScore={(taskNum, band) => onRecordScore('writing', band)}
        onBackToMocks={() => setActiveSection(null)}
      />
    );
  }

  if (activeSection === 'speaking') {
    return (
      <SpeakingSession
        speakingData={mockTest.speaking}
        onRecordScore={(band) => onRecordScore('speaking', band)}
        onBackToMocks={() => setActiveSection(null)}
      />
    );
  }

  // Hub overview
  return (
    <div className="space-y-6">
      {/* Hero Header */}
      <div className="bg-white p-6 sm:p-8 rounded-3xl border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="space-y-2">
          <div className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-slate-100 text-slate-700 text-xs font-semibold">
            <Layers className="w-3.5 h-3.5 text-slate-500" />
            <span>Academic Modular Practice & Diagnostics</span>
          </div>
          <h1 className="text-2xl font-extrabold text-slate-900">{mockTest.title}</h1>
          <p className="text-xs text-slate-500 max-w-xl leading-relaxed">
            Select an individual skill section for targeted drills, or practice with authentic timing and instant AI scoring.
          </p>
        </div>

        <div className="flex items-center space-x-3 bg-slate-50 p-4 rounded-2xl border border-slate-100 shrink-0">
          <Award className="w-8 h-8 text-amber-500" />
          <div>
            <div className="text-[10px] text-slate-400 font-semibold uppercase">Difficulty</div>
            <div className="text-xs font-bold text-slate-800">{mockTest.difficulty}</div>
          </div>
        </div>
      </div>

      {/* Sections Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
        {/* Listening Card */}
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:border-emerald-300 hover:shadow-md transition-all group flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold">
                <Headphones className="w-5 h-5" />
              </div>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                ~30 Mins • 4 Parts
              </span>
            </div>

            <div>
              <h3 className="text-base font-bold text-slate-900 group-hover:text-emerald-700 transition-colors">
                Academic Listening
              </h3>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                4 recorded sections with British, Australian, and American voices. Real-time answer check and official Band calculation.
              </p>
            </div>
          </div>

          <button
            id="btn-launch-listening"
            onClick={() => setActiveSection('listening')}
            className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl bg-slate-50 hover:bg-emerald-600 group-hover:bg-emerald-600 text-slate-700 group-hover:text-white font-semibold text-xs transition-all"
          >
            <span>Start Listening Section</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Reading Card */}
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:border-blue-300 hover:shadow-md transition-all group flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
                <BookOpen className="w-5 h-5" />
              </div>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                60 Mins • 3 Passages
              </span>
            </div>

            <div>
              <h3 className="text-base font-bold text-slate-900 group-hover:text-blue-700 transition-colors">
                Academic Reading
              </h3>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                Authentic academic articles covering urban microclimates, neural biology in cephalopods, and algorithmic linguistics.
              </p>
            </div>
          </div>

          <button
            id="btn-launch-reading"
            onClick={() => setActiveSection('reading')}
            className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl bg-slate-50 hover:bg-blue-600 group-hover:bg-blue-600 text-slate-700 group-hover:text-white font-semibold text-xs transition-all"
          >
            <span>Start Reading Section</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Writing Card */}
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:border-amber-300 hover:shadow-md transition-all group flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center font-bold">
                <PenTool className="w-5 h-5" />
              </div>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                60 Mins • Task 1 & 2
              </span>
            </div>

            <div>
              <h3 className="text-base font-bold text-slate-900 group-hover:text-amber-700 transition-colors">
                Academic Writing (with AI Examiner)
              </h3>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                Task 1 Renewable Energy Report + Task 2 AI in Education. Instant 4-criteria band breakdown with in-text corrections.
              </p>
            </div>
          </div>

          <button
            id="btn-launch-writing"
            onClick={() => setActiveSection('writing')}
            className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl bg-slate-50 hover:bg-amber-600 group-hover:bg-amber-600 text-slate-700 group-hover:text-white font-semibold text-xs transition-all"
          >
            <span>Start Writing Section</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Speaking Card */}
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:border-rose-300 hover:shadow-md transition-all group flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="w-10 h-10 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center font-bold">
                <Mic className="w-5 h-5" />
              </div>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                11-14 Mins • 3 Parts
              </span>
            </div>

            <div>
              <h3 className="text-base font-bold text-slate-900 group-hover:text-rose-700 transition-colors">
                Academic Speaking (Live Audio AI)
              </h3>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                Part 2 Cue Card with 1-min preparation timer. Live audio recording, hesitation pause metrics, and band diagnosis.
              </p>
            </div>
          </div>

          <button
            id="btn-launch-speaking"
            onClick={() => setActiveSection('speaking')}
            className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl bg-slate-50 hover:bg-rose-600 group-hover:bg-rose-600 text-slate-700 group-hover:text-white font-semibold text-xs transition-all"
          >
            <span>Start Speaking Section</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
