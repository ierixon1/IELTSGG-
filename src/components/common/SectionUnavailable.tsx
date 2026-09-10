import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { SkillType } from '../../types';

interface SectionUnavailableProps {
  skill: SkillType;
  /** The test that was supposed to carry it, named so support can find it. */
  testTitle: string;
  testId: string;
  onBack?: () => void;
  backLabel?: string;
}

/**
 * What a learner sees when the test they opened does not carry this section.
 *
 * This screen is the whole point of removing the built-in-test backfill. A
 * bundle that names a Reading passage it cannot supply used to open the
 * built-in one instead, under the chosen test's title, with a banner above it —
 * so a learner sat forty questions of unrelated material and their band score
 * was recorded against a test they never took.
 *
 * It names the test and its id because this is a configuration mistake, not a
 * learner mistake: the person who can fix it needs to know which row is wrong.
 */
export const SectionUnavailable: React.FC<SectionUnavailableProps> = ({
  skill,
  testTitle,
  testId,
  onBack,
  backLabel,
}) => (
  <div
    id={`section-unavailable-${skill}`}
    data-skill={skill}
    data-test-id={testId}
    className="es-enter rounded-[var(--radius-card)] border border-danger-500/30 bg-danger-50 p-6"
  >
    <div className="flex items-start gap-3">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger-600" />
      <div className="space-y-2">
        <h2 className="text-base font-bold capitalize text-danger-800">
          {skill} is not configured for this test
        </h2>
        <p className="text-sm leading-relaxed text-danger-700">
          “{testTitle}” does not carry a published {skill} material, so there is nothing to sit.
          Nothing has been substituted — another test&apos;s content would be marked as if it were
          this one.
        </p>
        <p className="font-mono text-[11px] text-danger-600">test id: {testId}</p>
        <p className="text-xs text-danger-700">
          Ask an administrator to attach and publish a {skill} material for this test.
        </p>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="mt-2 rounded-lg border border-danger-500/40 bg-white px-3 py-1.5 text-xs font-semibold text-danger-700 hover:bg-danger-50"
          >
            {backLabel || 'Back'}
          </button>
        )}
      </div>
    </div>
  </div>
);
