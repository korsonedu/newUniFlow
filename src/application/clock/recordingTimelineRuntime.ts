import { normalizeTimelineTime } from '../../domain/time';
import { RecordingTimelineClock } from './RecordingTimelineClock';

const sharedClock = new RecordingTimelineClock();

export const recordingTimelineRuntime = {
  start(timelineOriginMs: number): void {
    sharedClock.start(timelineOriginMs);
  },

  attachExternalClock(now: () => number): void {
    sharedClock.attachExternalClock(now);
  },

  detachExternalClock(): void {
    sharedClock.detachExternalClock();
  },

  getElapsedMs(): number {
    return sharedClock.getElapsedMs();
  },

  getTimelineNowMs(fallbackTimeMs = 0): number {
    if (!sharedClock.isStarted()) {
      return normalizeTimelineTime(fallbackTimeMs);
    }
    return sharedClock.getTimelineNowMs();
  },

  isStarted(): boolean {
    return sharedClock.isStarted();
  },

  reset(): void {
    sharedClock.reset();
  },
};

