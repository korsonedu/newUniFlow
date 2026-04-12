import { ProjectState, TimelineEvent } from '../domain/types';
import { applyEvent, getTimelineMaxTime, sortEvents } from './timelineEngine';
import { normalizeTimelineTime, shiftTimelineTime } from '../domain/time';
import {
  cancelPlatformFrame,
  platformNowMs,
  requestPlatformFrame,
} from '../infrastructure/platform/frameScheduler';

export type ReplayClock = {
  now: () => number;
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (id: number) => void;
};

export type ReplayEngineOptions = {
  initialState: ProjectState;
  getEvents: () => TimelineEvent[];
  getMaxTime?: () => number;
  onFrame: (state: ProjectState, time: number) => void;
  fps?: number;
  clock?: ReplayClock;
};

const defaultClock: ReplayClock = {
  now: () => platformNowMs(),
  requestFrame: (callback) => requestPlatformFrame(callback),
  cancelFrame: (id) => cancelPlatformFrame(id),
};

export class ReplayEngine {
  private readonly initialState: ProjectState;
  private readonly getEvents: () => TimelineEvent[];
  private readonly getMaxTimelineTime?: () => number;
  private readonly onFrame: (state: ProjectState, time: number) => void;
  private readonly clock: ReplayClock;

  private rafId: number | null = null;
  private playing = false;
  private playOriginWallClock = 0;
  private playOriginTimelineTime = 0;
  private lastFrameWallClock = 0;
  private currentTime = 0;
  private cachedTimelineTime = 0;
  private cachedEventsRef: TimelineEvent[] | null = null;
  private cachedSortedEvents: TimelineEvent[] = [];
  private cachedState: ProjectState;
  private cachedEventCursor = 0;

  constructor(options: ReplayEngineOptions) {
    this.initialState = options.initialState;
    this.getEvents = options.getEvents;
    this.getMaxTimelineTime = options.getMaxTime;
    this.onFrame = options.onFrame;
    this.clock = options.clock ?? defaultClock;
    this.cachedState = options.initialState;
  }

  play(): void {
    if (this.playing) {
      return;
    }

    this.playing = true;
    this.playOriginWallClock = this.clock.now();
    this.playOriginTimelineTime = this.currentTime;
    this.lastFrameWallClock = this.playOriginWallClock;

    const tick: FrameRequestCallback = () => {
      if (!this.playing) {
        return;
      }

      const wallClock = this.clock.now();
      const elapsed = wallClock - this.playOriginWallClock;
      const maxTime = this.getMaxTime();
      const nextTime = Math.min(
        normalizeTimelineTime(this.playOriginTimelineTime + elapsed),
        maxTime,
      );
      this.lastFrameWallClock = wallClock;
      this.renderAt(nextTime);

      if (nextTime >= maxTime) {
        this.pause();
        return;
      }

      this.rafId = this.clock.requestFrame(tick);
    };

    this.rafId = this.clock.requestFrame(tick);
  }

  pause(): void {
    this.playing = false;
    if (this.rafId !== null) {
      this.clock.cancelFrame(this.rafId);
      this.rafId = null;
    }
  }

  seek(time: number): void {
    this.pause();
    this.renderAt(time);
  }

  step(): void {
    this.pause();
    this.renderAt(shiftTimelineTime(this.currentTime, Math.round(1000 / 60)));
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getCurrentTime(): number {
    return this.currentTime;
  }

  private renderAt(time: number): void {
    const t = Math.min(normalizeTimelineTime(time), this.getMaxTime());
    const eventsRef = this.getEvents();
    const eventsChanged = this.refreshEventsCache(eventsRef);
    if (!eventsChanged && t === this.currentTime) {
      return;
    }

    if (eventsChanged || t < this.cachedTimelineTime) {
      this.rebuildStateTo(t);
    } else {
      this.advanceStateTo(t);
    }

    const state = this.cachedState;
    this.currentTime = t;
    this.onFrame(state, t);
  }

  private refreshEventsCache(events: TimelineEvent[]): boolean {
    if (this.cachedEventsRef === events) {
      return false;
    }

    this.cachedEventsRef = events;
    this.cachedSortedEvents = sortEvents(events);
    this.cachedState = this.initialState;
    this.cachedTimelineTime = 0;
    this.cachedEventCursor = 0;
    return true;
  }

  private rebuildStateTo(time: number): void {
    const target = normalizeTimelineTime(time);
    let state = this.initialState;
    let cursor = 0;
    for (const event of this.cachedSortedEvents) {
      if (event.time > target) {
        break;
      }
      state = applyEvent(state, event);
      cursor += 1;
    }
    this.cachedState = state;
    this.cachedTimelineTime = target;
    this.cachedEventCursor = cursor;
  }

  private advanceStateTo(time: number): void {
    const target = normalizeTimelineTime(time);
    if (target <= this.cachedTimelineTime) {
      this.cachedTimelineTime = target;
      return;
    }

    let state = this.cachedState;
    let cursor = this.cachedEventCursor;
    while (cursor < this.cachedSortedEvents.length) {
      const event = this.cachedSortedEvents[cursor];
      if (event.time > target) {
        break;
      }
      state = applyEvent(state, event);
      cursor += 1;
    }

    this.cachedState = state;
    this.cachedTimelineTime = target;
    this.cachedEventCursor = cursor;
  }

  private getMaxTime(): number {
    if (!this.getMaxTimelineTime) {
      return getTimelineMaxTime(this.getEvents());
    }
    return normalizeTimelineTime(this.getMaxTimelineTime());
  }
}
