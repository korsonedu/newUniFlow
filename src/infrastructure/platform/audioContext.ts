export type AudioContextCtor = new () => AudioContext;

export type StreamAnalyserHandle = {
  context: AudioContext;
  analyser: AnalyserNode;
  close: () => Promise<void>;
};

const getGlobalScope = (): (typeof globalThis & {
  AudioContext?: AudioContextCtor;
  webkitAudioContext?: AudioContextCtor;
}) | null => {
  if (typeof globalThis === 'undefined') {
    return null;
  }
  return globalThis as typeof globalThis & {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
};

export const getAudioContextConstructor = (): AudioContextCtor | undefined => {
  const scope = getGlobalScope();
  if (!scope) {
    return undefined;
  }
  return scope.AudioContext ?? scope.webkitAudioContext;
};

export const isAudioContextSupported = (): boolean => {
  return !!getAudioContextConstructor();
};

export const createAudioContext = (): AudioContext | null => {
  const Ctor = getAudioContextConstructor();
  if (!Ctor) {
    return null;
  }
  try {
    return new Ctor();
  } catch {
    return null;
  }
};

export const createStreamAnalyser = (
  stream: MediaStream,
  fftSize = 2048,
): StreamAnalyserHandle | null => {
  const context = createAudioContext();
  if (!context) {
    return null;
  }

  try {
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    const sink = context.createGain();
    analyser.fftSize = fftSize;
    sink.gain.value = 0;
    source.connect(analyser);
    analyser.connect(sink);
    sink.connect(context.destination);
    void context.resume();

    return {
      context,
      analyser,
      close: async () => {
        try {
          source.disconnect();
        } catch {
          // ignore disconnect races
        }
        try {
          analyser.disconnect();
        } catch {
          // ignore disconnect races
        }
        try {
          sink.disconnect();
        } catch {
          // ignore disconnect races
        }
        try {
          await context.close();
        } catch {
          // ignore close errors
        }
      },
    };
  } catch {
    void context.close().catch(() => undefined);
    return null;
  }
};
