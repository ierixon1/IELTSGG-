/**
 * One-time exam Listening playback, as the browser runs it (H8).
 *
 * An IELTS recording is heard once, and the exam session is the authority on
 * whether a part has been heard. A part is recorded as heard only when its
 * recording has really started playing — not when Play was clicked:
 *
 *   1. Play calls `play()` at once, inside the click, so a browser that allows
 *      playback only in answer to a gesture (Safari, iOS) still allows it; and at
 *      the same time it claims the part on the server. A claim holds a lease, so
 *      a second tab cannot start the part while this one is starting it.
 *   2. When playback has started and the claim was granted, the start is
 *      confirmed to the server, which records the part as played. From then on
 *      it never plays again — not after a reload, not in another tab.
 *   3. Anything that stops the recording from starting — `play()` rejected, a
 *      media or network error, no start within the timeout, the claim refused or
 *      unreachable — pauses it and releases the claim. The part stays playable.
 *
 * No DOM or React here: the screen hands in its audio elements and session
 * calls, so every path above is tested without a browser.
 */

export type PartPlayback = 'idle' | 'starting' | 'playing' | 'ended' | 'failed';
export type ClaimOutcome = 'granted' | 'refused' | 'failed';
/** Why a start did not happen: another tab holds or played the part, or playback or the network failed. */
export type PlaybackProblem = 'refused' | 'failed';

export interface AudioOutlet {
  play(): Promise<void>;
  pause(): void;
}

export interface ExamAudioPorts {
  /** The part's audio element, or null when the part has none. */
  outlet: (part: number) => AudioOutlet | null;
  /** Claims the part on the server, resolving with whether this tab holds it. */
  claim: (part: number) => Promise<ClaimOutcome>;
  /** Tells the server the recording has started playing. */
  confirm: (part: number) => void;
  /** Tells the server the start failed, releasing this tab's claim. */
  release: (part: number) => void;
  changed: (part: number, state: PartPlayback, problem?: PlaybackProblem) => void;
  /** How long a start may take before it counts as failed. Shorter than the server's claim lease. */
  startTimeoutMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export const AUDIO_START_TIMEOUT_MS = 20_000;

interface Attempt {
  part: number;
  outlet: AudioOutlet;
  claim?: ClaimOutcome;
  started: boolean;
  timer: unknown;
}

export function createExamAudioPlayer(ports: ExamAudioPorts) {
  const states = new Map<number, PartPlayback>();
  let attempt: Attempt | null = null;
  const setTimer = ports.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer = ports.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  const record = (part: number, state: PartPlayback, problem?: PlaybackProblem) => {
    states.set(part, state);
    ports.changed(part, state, problem);
  };
  const anyPlaying = () => [...states.values()].includes('playing');

  /** The start did not happen: stop what may have begun and leave the part playable. */
  function fail(current: Attempt, problem: PlaybackProblem) {
    if (attempt !== current) return;
    attempt = null;
    clearTimer(current.timer);
    current.outlet.pause();
    // A refused claim belongs to another tab and is not this tab's to release.
    if (current.claim !== 'refused') ports.release(current.part);
    record(current.part, 'failed', problem);
  }

  /** Confirms the start once playback has begun and the claim is this tab's. */
  function confirmIfStarted(current: Attempt) {
    if (attempt !== current || !current.started || current.claim !== 'granted') return;
    attempt = null;
    clearTimer(current.timer);
    ports.confirm(current.part);
    record(current.part, 'playing');
  }

  return {
    state: (part: number): PartPlayback => states.get(part) ?? 'idle',
    /** Whether a recording is starting or playing: no other part may start meanwhile. */
    busy: (): boolean => attempt !== null || anyPlaying(),

    /**
     * Starts a part the server has not recorded as played. Returns false when it
     * may not start now: another part is starting or playing, or this one already
     * started here.
     */
    start(part: number): boolean {
      const state = states.get(part) ?? 'idle';
      if (attempt || anyPlaying() || (state !== 'idle' && state !== 'failed')) return false;
      const outlet = ports.outlet(part);
      if (!outlet) return false;

      const current: Attempt = { part, outlet, started: false, timer: undefined };
      attempt = current;
      record(part, 'starting');
      current.timer = setTimer(() => fail(current, 'failed'), ports.startTimeoutMs ?? AUDIO_START_TIMEOUT_MS);

      let playing: Promise<void>;
      try {
        playing = outlet.play();
      } catch {
        fail(current, 'failed');
        return true;
      }
      playing.then(
        () => {
          current.started = true;
          confirmIfStarted(current);
        },
        () => fail(current, 'failed'),
      );
      ports.claim(part).then(
        (outcome) => {
          current.claim = outcome;
          if (outcome === 'granted') confirmIfStarted(current);
          else fail(current, outcome === 'refused' ? 'refused' : 'failed');
        },
        () => {
          current.claim = 'failed';
          fail(current, 'failed');
        },
      );
      return true;
    },

    /** The element's `playing` event. */
    playing(part: number): void {
      if (attempt?.part !== part) return;
      attempt.started = true;
      confirmIfStarted(attempt);
    },

    /** The element's `error` event: a failed start stays playable; a recording that had started has been heard. */
    error(part: number): void {
      if (attempt?.part === part) fail(attempt, 'failed');
      else if (states.get(part) === 'playing') record(part, 'ended');
    },

    /** The element's `ended` event. */
    ended(part: number): void {
      if (states.get(part) === 'playing') record(part, 'ended');
    },
  };
}

export type ExamAudioPlayer = ReturnType<typeof createExamAudioPlayer>;
