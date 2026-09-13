import './env';
import { describe, it } from 'node:test';
import { expect } from './harness';
import { createExamAudioPlayer, type ClaimOutcome, type PartPlayback, type PlaybackProblem } from '../src/services/examAudioPlayer';

/**
 * H8: the exam screen's one-time playback, without a browser.
 *
 * A part is confirmed to the server only when its recording has started and this
 * tab holds the claim. Every way a start can fail — `play()` refused, a media
 * error, no start in time, the claim refused or unreachable — leaves the part
 * playable, and a double click starts nothing twice.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function rig(options: { throwOnPlay?: boolean } = {}) {
  const log: string[] = [];
  const plays: Array<Deferred<void>> = [];
  const claims: Array<Deferred<ClaimOutcome>> = [];
  const timers: Array<{ run: () => void; cleared: boolean }> = [];
  const changes: Array<[number, PartPlayback, PlaybackProblem | undefined]> = [];
  const player = createExamAudioPlayer({
    outlet: (part) =>
      part === 9
        ? null
        : {
            play: () => {
              log.push(`play ${part}`);
              if (options.throwOnPlay) throw new Error('playback is not allowed');
              const started = deferred<void>();
              plays.push(started);
              return started.promise;
            },
            pause: () => log.push(`pause ${part}`),
          },
    claim: (part) => {
      log.push(`claim ${part}`);
      const claimed = deferred<ClaimOutcome>();
      claims.push(claimed);
      return claimed.promise;
    },
    confirm: (part) => log.push(`confirm ${part}`),
    release: (part) => log.push(`release ${part}`),
    changed: (part, state, problem) => changes.push([part, state, problem]),
    setTimer: (run) => {
      const timer = { run, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
  });
  return { player, log, plays, claims, timers, changes };
}

const last = <T>(list: T[]) => list[list.length - 1];

describe('a part is confirmed only when its recording has really started', () => {
  it('waits for both playback and the claim, whichever comes first, before confirming once', async () => {
    const first = rig();
    expect(first.player.start(1)).toBe(true);
    expect(first.log).toEqual(['play 1', 'claim 1']);
    expect(first.player.state(1)).toBe('starting');
    first.plays[0].resolve();
    await flush();
    expect(first.log.includes('confirm 1')).toBe(false);
    first.claims[0].resolve('granted');
    await flush();
    expect(first.log.filter((entry) => entry === 'confirm 1')).toHaveLength(1);
    expect([first.player.state(1), first.timers[0].cleared]).toEqual(['playing', true]);

    const second = rig();
    second.player.start(1);
    second.claims[0].resolve('granted');
    await flush();
    expect(second.log.includes('confirm 1')).toBe(false);
    second.player.playing(1);
    second.plays[0].resolve();
    await flush();
    expect(second.log.filter((entry) => entry === 'confirm 1')).toHaveLength(1);
  });

  it('does not confirm a part when play() is refused, releases the claim, and plays it on a retry', async () => {
    const { player, log, plays, claims, changes } = rig();
    player.start(2);
    claims[0].resolve('granted');
    plays[0].reject(new DOMException('The user agent refused playback.', 'NotAllowedError'));
    await flush();
    expect(log).toEqual(['play 2', 'claim 2', 'pause 2', 'release 2']);
    expect(last(changes)).toEqual([2, 'failed', 'failed']);

    expect(player.start(2)).toBe(true);
    plays[1].resolve();
    claims[1].resolve('granted');
    await flush();
    expect(log.filter((entry) => entry === 'confirm 2')).toHaveLength(1);
    expect(player.state(2)).toBe('playing');
  });

  it('treats a media or network error before playback as a failed start, and after it as the end of a heard recording', async () => {
    const { player, log, plays, claims } = rig();
    player.start(3);
    player.error(3);
    await flush();
    expect([player.state(3), log.includes('release 3'), log.includes('confirm 3')]).toEqual(['failed', true, false]);
    // The failed attempt settling later changes nothing.
    plays[0].resolve();
    claims[0].resolve('granted');
    await flush();
    expect([player.state(3), log.includes('confirm 3')]).toEqual(['failed', false]);

    player.start(3);
    plays[1].resolve();
    claims[1].resolve('granted');
    await flush();
    player.error(3);
    expect([player.state(3), log.filter((entry) => entry === 'release 3')]).toEqual(['ended', ['release 3']]);
  });

  it('gives up on a start that never begins, and leaves the part playable', async () => {
    const { player, log, plays, claims, timers, changes } = rig();
    player.start(1);
    claims[0].resolve('granted');
    await flush();
    timers[0].run();
    expect([player.state(1), last(log)]).toEqual(['failed', 'release 1']);
    expect(log.includes('pause 1')).toBe(true);
    plays[0].resolve();
    await flush();
    expect([player.state(1), log.includes('confirm 1'), last(changes)]).toEqual(['failed', false, [1, 'failed', 'failed']]);
  });

  it('stops a recording whose claim another tab holds, without releasing that tab’s claim', async () => {
    const { player, log, plays, claims, changes } = rig();
    player.start(1);
    plays[0].resolve();
    player.playing(1);
    claims[0].resolve('refused');
    await flush();
    expect([player.state(1), last(changes), log.includes('pause 1'), log.includes('release 1'), log.includes('confirm 1')]).toEqual([
      'failed',
      [1, 'failed', 'refused'],
      true,
      false,
      false,
    ]);
  });

  it('fails the start when the server cannot be reached, releasing whatever it may have recorded', async () => {
    const unreachable = rig();
    unreachable.player.start(1);
    unreachable.claims[0].reject(new TypeError('Failed to fetch'));
    await flush();
    expect([unreachable.player.state(1), unreachable.log.includes('release 1')]).toEqual(['failed', true]);

    const refusedRequest = rig();
    refusedRequest.player.start(1);
    refusedRequest.claims[0].resolve('failed');
    refusedRequest.plays[0].resolve();
    await flush();
    expect([refusedRequest.player.state(1), refusedRequest.log.includes('release 1'), refusedRequest.log.includes('confirm 1')]).toEqual(['failed', true, false]);
  });

  it('fails a start whose play() throws at once', () => {
    const { player, log } = rig({ throwOnPlay: true });
    expect(player.start(1)).toBe(true);
    expect([player.state(1), log.includes('release 1')]).toEqual(['failed', true]);
  });
});

describe('one recording at a time, each once', () => {
  it('starts a double-clicked part once', async () => {
    const { player, log } = rig();
    expect([player.start(1), player.start(1)]).toEqual([true, false]);
    expect(log).toEqual(['play 1', 'claim 1']);
  });

  it('starts no other part while one is starting or playing, and none that has played here', async () => {
    const { player, plays, claims } = rig();
    player.start(1);
    expect([player.busy(), player.start(2)]).toEqual([true, false]);
    plays[0].resolve();
    claims[0].resolve('granted');
    await flush();
    expect([player.busy(), player.start(2)]).toEqual([true, false]);
    player.ended(1);
    expect([player.busy(), player.state(1), player.start(1), player.start(9), player.start(2)]).toEqual([false, 'ended', false, false, true]);
  });
});
