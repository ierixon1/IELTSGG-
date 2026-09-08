import React, { useState } from 'react';
import { MockTest, SkillType, WritingGradingResult } from '../types';
import { PublishedTestSummary } from '../services/publishedTests';
import { ListeningSession } from './ListeningSession';
import { ReadingSession } from './ReadingSession';
import { WritingSession } from './WritingSession';
import { SpeakingSession } from './SpeakingSession';
import { Award, ArrowRight, BookOpen, Headphones, Layers, Mic, PenTool } from 'lucide-react';
import { useT } from '../i18n';
import { Badge, Button, Card } from './ui';

interface MocksHubProps {
  mockTest: MockTest;
  onRecordScore: (skill: SkillType, band: number, raw?: number) => void;
  initialSelectedSection?: SkillType | null;
  onWritingGraded?: (result: WritingGradingResult, essay: string) => void;
  onSpeakingGraded?: (transcript: string) => void;
  /** Tests published from the admin CMS, alongside the built-in one. */
  publishedTests?: PublishedTestSummary[];
  activeTestId?: string;
  builtInTestId?: string;
  onSelectTest?: (id: string) => void;
}

/**
 * The four modules share one card shape; only the icon and the skill tint
 * change, so a learner reads them as one set rather than four designs.
 */
const SECTIONS: Array<{ skill: SkillType; icon: React.ElementType; iconClass: string }> = [
  { skill: 'listening', icon: Headphones, iconClass: 'bg-listening-tint text-listening-ink' },
  { skill: 'reading', icon: BookOpen, iconClass: 'bg-reading-tint text-reading-ink' },
  { skill: 'writing', icon: PenTool, iconClass: 'bg-writing-tint text-writing-ink' },
  { skill: 'speaking', icon: Mic, iconClass: 'bg-speaking-tint text-speaking-ink' },
];

export const MocksHub: React.FC<MocksHubProps> = ({
  mockTest,
  onRecordScore,
  initialSelectedSection,
  onWritingGraded,
  onSpeakingGraded,
  publishedTests = [],
  activeTestId,
  builtInTestId,
  onSelectTest,
}) => {
  const t = useT();
  const [activeSection, setActiveSection] = useState<SkillType | null>(
    initialSelectedSection || null,
  );

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
        onGraded={onWritingGraded}
        onBackToMocks={() => setActiveSection(null)}
      />
    );
  }

  if (activeSection === 'speaking') {
    return (
      <SpeakingSession
        speakingData={mockTest.speaking}
        onRecordScore={(band) => onRecordScore('speaking', band)}
        onGraded={onSpeakingGraded}
        onBackToMocks={() => setActiveSection(null)}
      />
    );
  }

  return (
    <div className="space-y-6">
      <Card className="es-enter flex flex-col justify-between gap-6 p-6 sm:p-8 md:flex-row md:items-center">
        <div className="max-w-xl">
          <Badge tone="neutral">
            <Layers className="h-3 w-3" />
            {t('mocks.eyebrow')}
          </Badge>
          <h1 className="mt-3.5 text-display-sm text-ink-900">{mockTest.title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-500">{t('mocks.subtitle')}</p>
        </div>

        <div className="flex shrink-0 items-center gap-3 rounded-[var(--radius-card)] bg-ink-50 px-5 py-4">
          <Award className="h-7 w-7 text-warning-500" />
          <div>
            <p className="text-[0.625rem] font-bold uppercase tracking-[0.12em] text-ink-400">
              {t('mocks.difficulty')}
            </p>
            <p className="text-sm font-bold text-ink-800">{mockTest.difficulty}</p>
          </div>
        </div>
      </Card>

      {/* Only worth showing once something has actually been published. */}
      {publishedTests.length > 0 && onSelectTest && (
        <Card className="es-enter flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-bold text-ink-900">{t('mocks.chooseTest')}</p>
            <p className="mt-0.5 text-xs text-ink-500">{t('mocks.chooseTestHint')}</p>
          </div>

          <select
            id="select-active-test"
            value={activeTestId}
            onChange={(event) => onSelectTest(event.target.value)}
            className="w-full rounded-[var(--radius-control)] border border-ink-200 bg-white px-3.5 py-2.5 text-sm font-medium text-ink-900 outline-none focus:border-brand-400 sm:w-80"
          >
            {builtInTestId && <option value={builtInTestId}>{t('mocks.builtInTest')}</option>}
            {publishedTests.map((test) => (
              <option key={test.id} value={test.id}>
                {test.title}
              </option>
            ))}
          </select>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {SECTIONS.map(({ skill, icon: Icon, iconClass }, index) => (
          <Card
            key={skill}
            interactive
            className="es-enter flex flex-col justify-between gap-5"
            style={{ animationDelay: `${index * 70}ms` }}
          >
            <div>
              <div className="flex items-start justify-between gap-3">
                <span
                  className={`inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] ${iconClass}`}
                >
                  <Icon className="h-5 w-5" />
                </span>
                <span className="text-[0.6875rem] font-bold uppercase tracking-[0.1em] text-ink-400">
                  {t(`mocks.${skill}.meta`)}
                </span>
              </div>

              <h3 className="mt-5 font-display text-lg font-bold text-ink-900">
                {t(`mocks.${skill}.title`)}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-500">
                {t(`mocks.${skill}.body`)}
              </p>
            </div>

            <Button
              id={`btn-launch-${skill}`}
              variant="secondary"
              fullWidth
              onClick={() => setActiveSection(skill)}
              className="justify-between"
            >
              {t('mocks.start')}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
};
