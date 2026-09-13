import './env';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect } from './harness';
import { I18nProvider } from '../src/i18n';
import { ListeningSession } from '../src/components/ListeningSession';
import { materialToSittable, toPracticeTest } from '../src/services/publishedTests';
import type { AdminMaterial } from '../src/types/admin';
import { listeningPayload } from './bundleFixtures';

/**
 * H8: practice and exam Listening play recordings differently, and must stay so.
 *
 * Practice gives the learner a normal player: pause, seek, replay. The exam gives
 * one Play that a server-confirmed start spends. Neither may inherit the other's
 * rules.
 */

const AUDIO = 'ast_audiopart1000000';
const MY_CLAIM = 'this-tab-claim-01';
const noop = () => {};
const render = (element: ReactElement) => renderToStaticMarkup(createElement(I18nProvider, null, element));

function listeningData() {
  const payload = listeningPayload(1, AUDIO);
  const material = {
    id: 'lis-modes',
    status: 'published',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...payload,
    // As a learner view carries it: the recording's URL next to its asset id.
    content: { ...payload.content, audioUrl: `/api/assets/${AUDIO}` },
  } as AdminMaterial;
  const test = toPracticeTest(materialToSittable(material).test);
  if (!test.listening) throw new Error('fixture has no Listening');
  return test.listening;
}

const audioTag = (html: string) => html.match(/<audio[^>]*id="listening-audio-part-1"[^>]*>/)?.[0] ?? '';
const playButton = (html: string) => html.match(/<button[^>]*id="btn-play-listening-part-1"[^>]*>/)?.[0] ?? '';

function exam(overrides: { audioStarted?: Record<number, number>; audioClaims?: Record<number, { claim: string; leaseUntil: number }>; serverNow?: number } = {}) {
  return render(
    createElement(ListeningSession, {
      examMode: true,
      listeningData: listeningData(),
      initialAnswers: {},
      submitted: false,
      onAnswersChange: noop,
      onSubmitAnswers: noop,
      audioStarted: overrides.audioStarted ?? {},
      audioClaims: overrides.audioClaims ?? {},
      serverNow: overrides.serverNow ?? 1_000,
      claimOf: () => MY_CLAIM,
      claimAudio: () => Promise.resolve('failed' as const),
      confirmAudio: noop,
      releaseAudio: noop,
    }),
  );
}

describe('practice keeps a normal player', () => {
  it('shows the recording with its controls and no one-time Play', () => {
    const html = render(createElement(ListeningSession, { listeningData: listeningData(), mark: () => Promise.reject(new Error('not marked in a render test')) }));
    const tag = audioTag(html);
    expect(tag.includes(`src="/api/assets/${AUDIO}"`)).toBe(true);
    expect(tag.includes('controls=""')).toBe(true);
    expect(html.includes('btn-play-listening-part-1')).toBe(false);
    expect(html.includes('data-playback')).toBe(false);
  });
});

describe('the exam gives one Play', () => {
  it('offers Play once, with no player controls, for a part not yet heard', () => {
    const html = exam();
    expect(audioTag(html).includes('controls')).toBe(false);
    expect(audioTag(html).includes('preload="auto"')).toBe(true);
    expect(playButton(html).includes(' disabled=""')).toBe(false);
    expect(html).toContain('Play recording (once only)');
    expect(html).toContain('data-playback="idle"');
    expect(html).toContain('data-heard="false"');
  });

  it('locks a part the session has recorded as heard', () => {
    const html = exam({ audioStarted: { 1: 500 } });
    expect(playButton(html).includes('disabled=""')).toBe(true);
    expect(html).toContain('Recording played — heard once only');
    expect(html).toContain('data-heard="true"');
  });

  it('holds a part another tab is starting until its claim lapses, and lets this tab pick its own claim up after a reload', () => {
    const elsewhere = exam({ audioClaims: { 1: { claim: 'other-tab-claim-9', leaseUntil: 2_000 } }, serverNow: 1_000 });
    expect(playButton(elsewhere).includes('disabled=""')).toBe(true);
    expect(elsewhere).toContain('id="listening-audio-problem-1"');
    expect(elsewhere).toContain('data-problem="refused"');

    const lapsed = exam({ audioClaims: { 1: { claim: 'other-tab-claim-9', leaseUntil: 2_000 } }, serverNow: 2_000 });
    expect(playButton(lapsed).includes(' disabled=""')).toBe(false);
    expect(lapsed.includes('listening-audio-problem-1')).toBe(false);

    const mine = exam({ audioClaims: { 1: { claim: MY_CLAIM, leaseUntil: 2_000 } }, serverNow: 1_000 });
    expect(playButton(mine).includes(' disabled=""')).toBe(false);
  });
});
