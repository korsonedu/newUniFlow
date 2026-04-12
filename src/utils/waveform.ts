import { WaveformPoint } from '../domain/types';
import { normalizeTimelineTime } from '../domain/time';
import { createAudioContext } from '../infrastructure/platform/audioContext';

export type WaveformBuildResult = {
  waveform: WaveformPoint[];
  sourceDurationMs: number;
};

export const buildWaveformFromAudioBlob = async (
  blob: Blob,
  startTime: number,
  endTime: number,
  bins?: number,
): Promise<WaveformBuildResult> => {
  const s = normalizeTimelineTime(startTime);
  const fallbackDuration = Math.max(1, normalizeTimelineTime(endTime) - s);
  if (blob.size <= 0) {
    return { waveform: [], sourceDurationMs: 0 };
  }

  const context = createAudioContext();
  if (!context) {
    return { waveform: [], sourceDurationMs: 0 };
  }
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
    if (audioBuffer.numberOfChannels <= 0 || audioBuffer.length === 0) {
      return { waveform: [], sourceDurationMs: 0 };
    }

    const channels: Float32Array[] = [];
    for (let i = 0; i < audioBuffer.numberOfChannels; i += 1) {
      channels.push(audioBuffer.getChannelData(i));
    }

    const sourceDurationMs = normalizeTimelineTime(Math.round(audioBuffer.duration * 1000));
    const duration = Math.max(1, sourceDurationMs || fallbackDuration);
    const timelineEnd = normalizeTimelineTime(s + duration);
    const autoBins = Math.round(duration / 2); // ~2ms per peak bucket
    const size = Math.max(512, Math.min(24000, bins ?? autoBins));
    const values: Array<{ min: number; max: number }> = [];

    for (let i = 0; i < size; i += 1) {
      const from = Math.floor((i / size) * audioBuffer.length);
      const to = Math.max(from + 1, Math.floor(((i + 1) / size) * audioBuffer.length));
      let min = 1;
      let max = -1;

      for (let p = from; p < to; p += 1) {
        let sampleMin = 1;
        let sampleMax = -1;
        for (let c = 0; c < channels.length; c += 1) {
          const sample = channels[c][p];
          if (sample < sampleMin) {
            sampleMin = sample;
          }
          if (sample > sampleMax) {
            sampleMax = sample;
          }
        }
        if (sampleMin < min) {
          min = sampleMin;
        }
        if (sampleMax > max) {
          max = sampleMax;
        }
      }

      values.push({ min, max });
    }

    let globalAbs = 0;
    for (const value of values) {
      const abs = Math.max(Math.abs(value.min), Math.abs(value.max));
      if (abs > globalAbs) {
        globalAbs = abs;
      }
    }
    const normalizer = Math.max(0.0001, globalAbs);

    const result = values.map((value, index) => {
      const t = s + Math.round((index / Math.max(1, values.length - 1)) * duration);
      const minAmp = Math.max(-1, Math.min(0, value.min / normalizer));
      const maxAmp = Math.min(1, Math.max(0, value.max / normalizer));
      return {
        t: normalizeTimelineTime(t),
        amp: Math.max(Math.abs(minAmp), Math.abs(maxAmp)),
        minAmp,
        maxAmp,
      } satisfies WaveformPoint;
    });

    if (result.length > 0) {
      result[0] = { ...result[0], t: s };
      result[result.length - 1] = { ...result[result.length - 1], t: timelineEnd };
    }

    return {
      waveform: result,
      sourceDurationMs,
    };
  } catch {
    return { waveform: [], sourceDurationMs: 0 };
  } finally {
    try {
      await context.close();
    } catch {
      // ignore close errors
    }
  }
};
