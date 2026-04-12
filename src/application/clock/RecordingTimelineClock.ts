import { normalizeTimelineTime } from '../../domain/time';

type ClockNowFn = () => number;

export class RecordingTimelineClock {
  private started = false;
  private timelineOriginMs = 0;
  private wallOriginMs = 0;
  private externalClockOriginMs: number | null = null;
  private externalNow: ClockNowFn | null = null;

  start(timelineOriginMs: number, wallNowMs = performance.now()): void {
    this.started = true;
    this.timelineOriginMs = normalizeTimelineTime(timelineOriginMs);
    this.wallOriginMs = wallNowMs;
    this.externalClockOriginMs = null;
    this.externalNow = null;
  }

  isStarted(): boolean {
    return this.started;
  }

  /**
   * Attach a high-precision external clock (e.g. AudioContext.currentTime * 1000).
   * We preserve elapsed continuity at attach time so timeline does not jump.
   */
  attachExternalClock(now: ClockNowFn, wallNowMs = performance.now()): void {
    if (!this.started) {
      return;
    }
    const elapsedFromWall = Math.max(0, wallNowMs - this.wallOriginMs);
    const nowMs = now();
    this.externalNow = now;
    this.externalClockOriginMs = nowMs - elapsedFromWall;
  }

  detachExternalClock(wallNowMs = performance.now()): void {
    if (!this.started) {
      return;
    }
    const elapsed = this.getElapsedMs(wallNowMs);
    this.wallOriginMs = wallNowMs - elapsed;
    this.externalNow = null;
    this.externalClockOriginMs = null;
  }

  getElapsedMs(wallNowMs = performance.now()): number {
    if (!this.started) {
      return 0;
    }
    if (this.externalNow && this.externalClockOriginMs !== null) {
      return Math.max(0, this.externalNow() - this.externalClockOriginMs);
    }
    return Math.max(0, wallNowMs - this.wallOriginMs);
  }

  getTimelineNowMs(wallNowMs = performance.now()): number {
    if (!this.started) {
      return normalizeTimelineTime(this.timelineOriginMs);
    }
    return normalizeTimelineTime(this.timelineOriginMs + this.getElapsedMs(wallNowMs));
  }

  reset(): void {
    this.started = false;
    this.timelineOriginMs = 0;
    this.wallOriginMs = 0;
    this.externalClockOriginMs = null;
    this.externalNow = null;
  }
}
