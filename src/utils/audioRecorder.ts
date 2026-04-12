import {
  createAudioContext,
  isAudioContextSupported,
} from '../infrastructure/platform/audioContext';

export type RecorderState = 'inactive' | 'recording' | 'paused';
export type RecorderKind = 'media-recorder' | 'pcm-fallback';

export type RecorderAdapter = {
  kind: RecorderKind;
  mimeType: string;
  readonly state: RecorderState;
  start: (timeslice?: number) => void;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<Blob>;
  getElapsedMs: () => number;
  dispose: () => void;
};

export type RecordingSupportInfo = {
  canRecord: boolean;
  reason?: string;
  hasGetUserMedia: boolean;
  hasMediaRecorder: boolean;
  hasWebAudioFallback: boolean;
};

const preferredMimeType = (): string | undefined => {
  if (typeof MediaRecorder === 'undefined') {
    return undefined;
  }
  const audioEl = typeof document !== 'undefined' ? document.createElement('audio') : null;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const mimeType of candidates) {
    const recorderSupported = MediaRecorder.isTypeSupported(mimeType);
    const playbackSupported = audioEl
      ? audioEl.canPlayType(mimeType) !== ''
      : true;
    if (recorderSupported && playbackSupported) {
      return mimeType;
    }
  }
  for (const mimeType of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }
  return undefined;
};

const writeAscii = (view: DataView, offset: number, value: string) => {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
};

const encodeWavBlob = (samples: Float32Array, sampleRate: number): Blob => {
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    const int16 = value < 0 ? value * 0x8000 : value * 0x7fff;
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
};

const concatFloatChunks = (chunks: Float32Array[]): Float32Array => {
  const size = chunks.reduce((acc, item) => acc + item.length, 0);
  const merged = new Float32Array(size);
  let cursor = 0;
  for (const chunk of chunks) {
    merged.set(chunk, cursor);
    cursor += chunk.length;
  }
  return merged;
};

const createMediaRecorderAdapter = (
  stream: MediaStream,
  preferredMimeType?: string,
): RecorderAdapter | null => {
  if (typeof MediaRecorder === 'undefined') {
    return null;
  }

  let recorder: MediaRecorder;
  try {
    recorder = preferredMimeType
      ? new MediaRecorder(stream, { mimeType: preferredMimeType })
      : new MediaRecorder(stream);
  } catch {
    recorder = new MediaRecorder(stream);
  }

  const chunks: BlobPart[] = [];
  let stopPromise: Promise<Blob> | null = null;
  let resolveStop: ((blob: Blob) => void) | null = null;
  let rejectStop: ((error: unknown) => void) | null = null;
  let accumulatedMs = 0;
  let activeStartedAt = 0;

  const nowMs = () => performance.now();

  const beginActiveTimer = () => {
    if (activeStartedAt <= 0) {
      activeStartedAt = nowMs();
    }
  };

  const flushActiveTimer = () => {
    if (activeStartedAt <= 0) {
      return;
    }
    accumulatedMs += Math.max(0, nowMs() - activeStartedAt);
    activeStartedAt = 0;
  };

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  recorder.onerror = (event: Event) => {
    const error = (event as Event & { error?: unknown }).error ?? new Error('MediaRecorder failed');
    if (rejectStop) {
      rejectStop(error);
      stopPromise = null;
      resolveStop = null;
      rejectStop = null;
    }
  };

  recorder.onstop = () => {
    const blobType = recorder.mimeType || preferredMimeType || 'audio/webm';
    const blob = new Blob(chunks, { type: blobType });
    if (resolveStop) {
      resolveStop(blob);
    }
    stopPromise = null;
    resolveStop = null;
    rejectStop = null;
  };

  const ensureStopPromise = (): Promise<Blob> => {
    if (stopPromise) {
      return stopPromise;
    }
    stopPromise = new Promise<Blob>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    return stopPromise;
  };

  return {
    kind: 'media-recorder',
    mimeType: recorder.mimeType || preferredMimeType || 'audio/webm',
    get state() {
      return recorder.state as RecorderState;
    },
    start: (timeslice) => {
      chunks.length = 0;
      accumulatedMs = 0;
      activeStartedAt = 0;
      beginActiveTimer();
      recorder.start(timeslice ?? 200);
    },
    pause: () => {
      if (recorder.state === 'recording') {
        flushActiveTimer();
        recorder.pause();
      }
    },
    resume: () => {
      if (recorder.state === 'paused') {
        beginActiveTimer();
        recorder.resume();
      }
    },
    stop: async () => {
      if (recorder.state === 'inactive') {
        return new Blob(chunks, { type: recorder.mimeType || preferredMimeType || 'audio/webm' });
      }

      flushActiveTimer();
      const promise = ensureStopPromise();
      recorder.stop();
      return promise;
    },
    getElapsedMs: () => {
      if (activeStartedAt > 0) {
        return Math.max(0, accumulatedMs + (nowMs() - activeStartedAt));
      }
      return Math.max(0, accumulatedMs);
    },
    dispose: () => {
      flushActiveTimer();
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      } catch {
        // ignore dispose race
      }
    },
  };
};

const createPcmFallbackAdapter = (stream: MediaStream): RecorderAdapter | null => {
  const context = createAudioContext();
  if (!context) {
    return null;
  }
  if (typeof context.createScriptProcessor !== 'function') {
    void context.close();
    return null;
  }

  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const sink = context.createGain();
  sink.gain.value = 0;

  const chunks: Float32Array[] = [];
  const sampleRate = Math.max(8000, Math.floor(context.sampleRate));
  let state: RecorderState = 'inactive';
  let stopped = false;
  let stopPromise: Promise<Blob> | null = null;
  let capturedSamples = 0;
  let accumulatedMs = 0;
  let activeStartedAt = 0;
  const nowMs = () => performance.now();

  const beginActiveTimer = () => {
    if (activeStartedAt <= 0) {
      activeStartedAt = nowMs();
    }
  };

  const flushActiveTimer = () => {
    if (activeStartedAt <= 0) {
      return;
    }
    accumulatedMs += Math.max(0, nowMs() - activeStartedAt);
    activeStartedAt = 0;
  };

  processor.onaudioprocess = (event) => {
    if (state !== 'recording') {
      return;
    }

    const channel = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(channel.length);
    copy.set(channel);
    chunks.push(copy);
    capturedSamples += copy.length;
  };

  source.connect(processor);
  processor.connect(sink);
  sink.connect(context.destination);

  const finalize = async (): Promise<Blob> => {
    if (stopped) {
      return stopPromise ?? new Blob([], { type: 'audio/wav' });
    }

    stopped = true;
    state = 'inactive';
    processor.onaudioprocess = null;

    try {
      processor.disconnect();
      source.disconnect();
      sink.disconnect();
    } catch {
      // ignore disconnection races
    }

    try {
      await context.close();
    } catch {
      // ignore close errors
    }

    const merged = concatFloatChunks(chunks);
    return encodeWavBlob(merged, sampleRate);
  };

  return {
    kind: 'pcm-fallback',
    mimeType: 'audio/wav',
    get state() {
      return state;
    },
    start: () => {
      chunks.length = 0;
      capturedSamples = 0;
      accumulatedMs = 0;
      activeStartedAt = 0;
      beginActiveTimer();
      state = 'recording';
      if (context.state === 'suspended') {
        void context.resume();
      }
    },
    pause: () => {
      if (state === 'recording') {
        flushActiveTimer();
        state = 'paused';
      }
    },
    resume: () => {
      if (state === 'paused') {
        beginActiveTimer();
        state = 'recording';
      }
      if (context.state === 'suspended') {
        void context.resume();
      }
    },
    stop: async () => {
      flushActiveTimer();
      if (!stopPromise) {
        stopPromise = finalize();
      }
      return stopPromise;
    },
    getElapsedMs: () => {
      const sampleDrivenMs = (capturedSamples / sampleRate) * 1000;
      if (sampleDrivenMs > 0) {
        return Math.max(0, sampleDrivenMs);
      }
      if (activeStartedAt > 0) {
        return Math.max(0, accumulatedMs + (nowMs() - activeStartedAt));
      }
      return Math.max(0, accumulatedMs);
    },
    dispose: () => {
      flushActiveTimer();
      if (!stopPromise) {
        stopPromise = finalize();
      }
      void stopPromise;
    },
  };
};

export const detectRecordingSupport = (): RecordingSupportInfo => {
  const hasGetUserMedia = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const hasMediaRecorder = typeof MediaRecorder !== 'undefined';
  const hasWebAudioFallback = isAudioContextSupported();
  const canRecord = hasGetUserMedia && (hasMediaRecorder || hasWebAudioFallback);

  if (canRecord) {
    return { canRecord: true, hasGetUserMedia, hasMediaRecorder, hasWebAudioFallback };
  }

  if (!hasGetUserMedia) {
    return {
      canRecord: false,
      reason:
        '当前运行时未提供麦克风采集接口（navigator.mediaDevices.getUserMedia）。请检查系统麦克风权限或升级 WebView/浏览器。',
      hasGetUserMedia,
      hasMediaRecorder,
      hasWebAudioFallback,
    };
  }

  return {
    canRecord: false,
    reason:
      '当前运行时不支持音频编码（MediaRecorder 与 WebAudio 回退均不可用）。请升级系统或切换到支持录音的运行环境。',
    hasGetUserMedia,
    hasMediaRecorder,
    hasWebAudioFallback,
  };
};

export const createRecorderAdapter = (stream: MediaStream): RecorderAdapter | null => {
  try {
    const pcm = createPcmFallbackAdapter(stream);
    if (pcm) {
      return pcm;
    }
  } catch {
    // fallback to MediaRecorder adapter below
  }

  try {
    const media = createMediaRecorderAdapter(stream, preferredMimeType());
    if (media) {
      return media;
    }
  } catch {
    return null;
  }

  return null;
};
