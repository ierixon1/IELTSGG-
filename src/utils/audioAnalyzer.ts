/**
 * Web Audio API Analyser utility for live volume detection and silence tracking.
 */

export class AudioVolumeDetector {
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private animFrameId: number | null = null;
  private isSpeaking = false;
  private silenceStartTime: number | null = null;
  private lastSpeechTimestamp = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  private onVolumeUpdate?: (volume: number, isSpeaking: boolean) => void;
  private onSilenceThresholdReached?: (silenceDurationMs: number) => void;

  constructor(
    private threshold = 0.025, // RMS amplitude threshold for speech
    private debounceMs = 300 // debounce to bridge natural pauses between words
  ) {}

  public async start(callbacks: {
    onVolumeUpdate?: (volume: number, isSpeaking: boolean) => void;
    onSilenceThresholdReached?: (silenceDurationMs: number) => void;
  }): Promise<MediaStream> {
    this.onVolumeUpdate = callbacks.onVolumeUpdate;
    this.onSilenceThresholdReached = callbacks.onSilenceThresholdReached;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioCtx = new AudioContextClass();
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.2;
    this.source.connect(this.analyser);

    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const checkAudio = () => {
      if (!this.analyser) return;

      this.analyser.getByteTimeDomainData(dataArray);

      // Compute RMS (root mean square)
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        const normalized = (dataArray[i] - 128) / 128;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / bufferLength);
      const volumeLevel = Math.min(1, rms * 4); // Boost visually for meters

      const now = performance.now();
      const rawSpeaking = rms > this.threshold;

      if (rawSpeaking) {
        this.lastSpeechTimestamp = now;
        this.silenceStartTime = null;

        if (!this.isSpeaking) {
          this.isSpeaking = true;
        }
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = null;
        }
      } else {
        // Debounce before declaring silence
        if (this.isSpeaking && !this.debounceTimer) {
          this.debounceTimer = setTimeout(() => {
            this.isSpeaking = false;
            this.silenceStartTime = performance.now();
            this.debounceTimer = null;
          }, this.debounceMs);
        }

        if (!this.isSpeaking && this.silenceStartTime) {
          const silenceMs = now - this.silenceStartTime;
          this.onSilenceThresholdReached?.(silenceMs);
        }
      }

      this.onVolumeUpdate?.(volumeLevel, this.isSpeaking);
      this.animFrameId = requestAnimationFrame(checkAudio);
    };

    this.animFrameId = requestAnimationFrame(checkAudio);
    return this.stream;
  }

  public stop() {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this.isSpeaking = false;
    this.silenceStartTime = null;
  }
}

/**
 * Converts audio Blob to base64 string
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // strip data URL prefix (e.g. data:audio/webm;base64,)
      const base64 = result.split(',')[1] || result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
