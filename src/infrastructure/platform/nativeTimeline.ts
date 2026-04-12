import { normalizeTimelineTime } from '../../domain/time';
import {
  ProjectState,
  TimelineEvent,
  TimelineSplit,
} from '../../domain/types';
import {
  applyEvent,
  applyEvents,
  deleteEvent,
  deleteTimeRange,
  getStateAtTime,
  getTimelineMaxTime,
  insertEvent,
  insertTimeGap,
  moveEvent,
  rippleDeleteTimeRange,
  splitTimeline,
} from '../../engine/timelineEngine';

type TauriInvoke = <T>(command: string, payload?: Record<string, unknown>) => Promise<T>;

type TauriRuntimeWindow = Window & typeof globalThis & {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
};

const toNativeTime = (value: number): number => Math.round(normalizeTimelineTime(value));

const hasTauriRuntime = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  const runtimeWindow = window as TauriRuntimeWindow;
  return !!runtimeWindow.__TAURI__ || !!runtimeWindow.__TAURI_INTERNALS__;
};

let invokeCachePromise: Promise<TauriInvoke | null> | null = null;
let printedFallbackWarning = false;

const loadInvoke = async (): Promise<TauriInvoke | null> => {
  if (!hasTauriRuntime()) {
    return null;
  }
  if (invokeCachePromise) {
    return invokeCachePromise;
  }
  invokeCachePromise = import('@tauri-apps/api/core')
    .then((core) => core.invoke as TauriInvoke)
    .catch(() => null);
  return invokeCachePromise;
};

const warnFallbackOnce = (): void => {
  if (printedFallbackWarning) {
    return;
  }
  printedFallbackWarning = true;
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn('[UniFlow] Native timeline unavailable, fallback to TypeScript engine.');
  }
};

const invokeOrFallback = async <T>(
  command: string,
  payload: Record<string, unknown>,
  fallback: () => T,
): Promise<T> => {
  const invoke = await loadInvoke();
  if (!invoke) {
    return fallback();
  }
  try {
    return await invoke<T>(command, payload);
  } catch {
    warnFallbackOnce();
    return fallback();
  }
};

export type NativeTimelineAdapter = {
  isAvailable: () => Promise<boolean>;
  applyEvent: (state: ProjectState, event: TimelineEvent) => Promise<ProjectState>;
  applyEvents: (initialState: ProjectState, events: TimelineEvent[]) => Promise<ProjectState>;
  getStateAtTime: (
    initialState: ProjectState,
    events: TimelineEvent[],
    time: number,
  ) => Promise<ProjectState>;
  insertEvent: (events: TimelineEvent[], event: TimelineEvent) => Promise<TimelineEvent[]>;
  deleteEvent: (events: TimelineEvent[], eventId: string) => Promise<TimelineEvent[]>;
  deleteTimeRange: (events: TimelineEvent[], start: number, end: number) => Promise<TimelineEvent[]>;
  rippleDeleteTimeRange: (
    events: TimelineEvent[],
    start: number,
    end: number,
  ) => Promise<TimelineEvent[]>;
  splitTimeline: (events: TimelineEvent[], time: number) => Promise<TimelineSplit>;
  moveEvent: (events: TimelineEvent[], eventId: string, newTime: number) => Promise<TimelineEvent[]>;
  insertTimeGap: (
    events: TimelineEvent[],
    startTime: number,
    duration: number,
    eventIds?: string[],
  ) => Promise<TimelineEvent[]>;
  getTimelineMaxTime: (events: TimelineEvent[]) => Promise<number>;
};

export const nativeTimelineAdapter: NativeTimelineAdapter = {
  isAvailable: async () => (await loadInvoke()) !== null,
  applyEvent: async (state, event) => {
    return invokeOrFallback(
      'native_timeline_apply_event',
      {
        state,
        event,
      },
      () => applyEvent(state, event),
    );
  },
  applyEvents: async (initialState, events) => {
    return invokeOrFallback(
      'native_timeline_apply_events',
      {
        initial_state: initialState,
        events,
      },
      () => applyEvents(initialState, events),
    );
  },
  getStateAtTime: async (initialState, events, time) => {
    return invokeOrFallback(
      'native_timeline_get_state_at_time',
      {
        initial_state: initialState,
        events,
        time: toNativeTime(time),
      },
      () => getStateAtTime(initialState, events, time),
    );
  },
  insertEvent: async (events, event) => {
    return invokeOrFallback(
      'native_timeline_insert_event',
      {
        events,
        event,
      },
      () => insertEvent(events, event),
    );
  },
  deleteEvent: async (events, eventId) => {
    return invokeOrFallback(
      'native_timeline_delete_event',
      {
        events,
        event_id: eventId,
      },
      () => deleteEvent(events, eventId),
    );
  },
  deleteTimeRange: async (events, start, end) => {
    return invokeOrFallback(
      'native_timeline_delete_time_range',
      {
        events,
        start: toNativeTime(start),
        end: toNativeTime(end),
      },
      () => deleteTimeRange(events, start, end),
    );
  },
  rippleDeleteTimeRange: async (events, start, end) => {
    return invokeOrFallback(
      'native_timeline_ripple_delete_time_range',
      {
        events,
        start: toNativeTime(start),
        end: toNativeTime(end),
      },
      () => rippleDeleteTimeRange(events, start, end),
    );
  },
  splitTimeline: async (events, time) => {
    return invokeOrFallback(
      'native_timeline_split_timeline',
      {
        events,
        time: toNativeTime(time),
      },
      () => splitTimeline(events, time),
    );
  },
  moveEvent: async (events, eventId, newTime) => {
    return invokeOrFallback(
      'native_timeline_move_event',
      {
        events,
        event_id: eventId,
        new_time: toNativeTime(newTime),
      },
      () => moveEvent(events, eventId, newTime),
    );
  },
  insertTimeGap: async (events, startTime, duration, eventIds) => {
    return invokeOrFallback(
      'native_timeline_insert_time_gap',
      {
        events,
        start_time: toNativeTime(startTime),
        duration: toNativeTime(duration),
        event_ids: eventIds,
      },
      () => insertTimeGap(events, startTime, duration, eventIds),
    );
  },
  getTimelineMaxTime: async (events) => {
    return invokeOrFallback(
      'native_timeline_max_time',
      {
        events,
      },
      () => getTimelineMaxTime(events),
    );
  },
};
