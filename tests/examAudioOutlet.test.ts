import './env';
import { describe, it } from 'node:test';
import { expect } from './harness';
import { createExamAudioPlayer, mediaElementOutlet, type MediaElementLike, type PartPlayback } from '../src/services/examAudioPlayer';

/**
 * H8, found in a real browser (Phase 28, scripts/e2eListeningAudio.ts): a Listening
 * recording whose request failed left its `<audio>` element in the error state.
 * `play()` on that element rejects at once, so after the network came back the
 * learner's retry failed again, and again, until the page was reloaded.
 *
 * `mediaElementOutlet` loads the source again before starting an element in
 * error. The element here behaves as Chromium's did: in error, `play()` rejects
 * until `load()` has been called.
 */

class FakeAudioElement implements MediaElementLike {
  error: { code: number } | null = null;
  currentTime = 0;
  networkUp = true;
  readonly calls: string[] = [];

  load(): void {
    this.calls.push('load');
    this.error = this.networkUp ? null : { code: 4 };
  }

  play(): Promise<void> {
    this.calls.push('play');
    if (this.error) return Promise.reject(new DOMException('The element has no supported sources.', 'NotSupportedError'));
    return Promise.resolve();
  }

  pause(): void {
    this.calls.push('pause');
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the audio element as the exam player sees it', () => {
  it('an element that failed to load is loaded again before it is played', async () => {
    const element = new FakeAudioElement();
    element.error = { code: 4 };
    await mediaElementOutlet(element).play();
    expect(element.calls).toEqual(['load', 'play']);
  });

  it('an element that loaded is played without loading it again, and a stop rewinds it', async () => {
    const element = new FakeAudioElement();
    element.currentTime = 2.5;
    const outlet = mediaElementOutlet(element);
    await outlet.play();
    outlet.pause();
    expect([element.calls, element.currentTime]).toEqual([['play', 'pause'], 0]);
  });

  it('through the player: a part whose recording failed to load fails while the network is down, and plays on the next try once it is back', async () => {
    const element = new FakeAudioElement();
    element.error = { code: 4 };
    element.networkUp = false;
    const states: PartPlayback[] = [];
    const releases: number[] = [];
    const player = createExamAudioPlayer({
      outlet: () => mediaElementOutlet(element),
      claim: async () => 'granted',
      confirm: () => undefined,
      release: (part) => releases.push(part),
      changed: (_part, state) => states.push(state),
    });

    player.start(2);
    await tick();
    expect([player.state(2), releases]).toEqual(['failed', [2]]);

    // Once the network is back the element is loaded again, play() resolves, and the granted claim confirms the start.
    element.networkUp = true;
    player.start(2);
    await tick();
    expect(player.state(2)).toBe('playing');
    expect(states).toEqual(['starting', 'failed', 'starting', 'playing']);
    expect(element.calls.filter((call) => call === 'load').length).toBe(2);
  });
});
