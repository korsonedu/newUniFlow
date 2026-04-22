import { normalizeTimelineTime } from '../../domain/time';
import { platformNowMs } from '../../infrastructure/platform/frameScheduler';

type ClockNowFn = () => number;

export class RecordingTimelineClock {
  private started = false;
  private timelineOriginMs = 0;
  private wallOriginMs = 0;
  private externalClockOriginMs: number | null = null;
  private externalNow: ClockNowFn | null = null;

  start(timelineOriginMs: number, wallNowMs = platformNowMs()): void {
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
  attachExternalClock(now: ClockNowFn, wallNowMs = platformNowMs()): void {
    if (!this.started) {
      return;
    }
    const elapsedFromWall = Math.max(0, wallNowMs - this.wallOriginMs);
    const nowMs = now();
    this.externalNow = now;
    this.externalClockOriginMs = nowMs - elapsedFromWall;
  }

  detachExternalClock(wallNowMs = platformNowMs()): void {
    if (!this.started) {
      return;
    }
    const elapsed = this.getElapsedMs(wallNowMs);
    this.wallOriginMs = wallNowMs - elapsed;
    this.externalNow = null;
    this.externalClockOriginMs = null;
  }

  getElapsedMs(wallNowMs = platformNowMs()): number {
    if (!this.started) {
      return 0;
    }
    const wallElapsed = Math.max(0, wallNowMs - this.wallOriginMs);
    if (this.externalNow && this.externalClockOriginMs !== null) {
      // Some browsers/devices can keep AudioContext alive but stop advancing currentTime
      // (suspend race, route change). Falling back to wall clock prevents timeline stall.
      const externalElapsed = Math.max(0, this.externalNow() - this.externalClockOriginMs);
      return Math.max(externalElapsed, wallElapsed);
    }
    return wallElapsed;
  }

  getTimelineNowMs(wallNowMs = platformNowMs()): number {
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
