import { create } from 'zustand';
import {
  AudioSegment,
  createInitialProjectState,
  DEFAULT_PAGE_ID,
  DEFAULT_PROJECT_ID,
  ProjectMeta,
  ProjectPage,
  ProjectState,
  RecordingStatus,
  Result,
  TimelineEvent,
  TimelineEventDraft,
  TimelineEventInsertDraft,
  TimelineEventOfType,
  TimelineEventType,
  TimelineSegment,
  TimelineSplit,
} from '../domain/types';
import {
  executeTimelineCommand,
  executeTimelineCommandAsync,
  TimelineCommand,
  TimelineTransaction,
} from '../application/timeline/transactions';
import {
  applyEvent,
  getStateAtTime,
  getTimelineMaxTime,
  insertEvent,
  sortEvents,
  splitTimeline,
} from '../engine/timelineEngine';
import { generateId } from '../utils/id';
import {
  getTimelineDuration,
  normalizeTimelineRange,
  normalizeTimelineTime,
} from '../domain/time';
import {
  clearSnapshotStorage,
  createSnapshot,
  loadSnapshotFromStorage,
  parseSnapshotJson,
  snapshotToJson,
} from './snapshot';
import {
  deleteRangeFromAudioSegments,
  deriveTimelineSegments,
} from '../domain/timelineSegments';
import {
  hasNativeTimelineRuntime,
  nativeTimelineAdapter,
} from '../infrastructure/platform/nativeTimeline';

const INITIAL_STATE = createInitialProjectState(DEFAULT_PROJECT_ID, DEFAULT_PAGE_ID);
const INITIAL_PROJECT: ProjectMeta = {
  id: DEFAULT_PROJECT_ID,
  title: 'UniFlow Project',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  pages: [
    {
      id: DEFAULT_PAGE_ID,
      name: 'Page 1',
      assetType: 'blank',
      order: 0,
    },
  ],
};

const deriveState = (events: TimelineEvent[], time: number): ProjectState => {
  return getStateAtTime(INITIAL_STATE, events, time);
};

let seekCacheEventsRef: TimelineEvent[] | null = null;
let seekCacheSortedEvents: TimelineEvent[] = [];
let seekCacheState: ProjectState = INITIAL_STATE;
let seekCacheTime = 0;
let seekCacheCursor = 0;

const deriveStateFastForSeek = (events: TimelineEvent[], time: number): ProjectState => {
  const target = normalizeTimelineTime(time);
  if (seekCacheEventsRef !== events) {
    seekCacheEventsRef = events;
    seekCacheSortedEvents = sortEvents(events);
    seekCacheState = INITIAL_STATE;
    seekCacheTime = 0;
    seekCacheCursor = 0;
  }

  if (target < seekCacheTime) {
    let state = INITIAL_STATE;
    let cursor = 0;
    while (cursor < seekCacheSortedEvents.length) {
      const event = seekCacheSortedEvents[cursor];
      if (normalizeTimelineTime(event.time) > target) {
        break;
      }
      state = applyEvent(state, event);
      cursor += 1;
    }
    seekCacheState = state;
    seekCacheTime = target;
    seekCacheCursor = cursor;
    return state;
  }

  let state = seekCacheState;
  let cursor = seekCacheCursor;
  while (cursor < seekCacheSortedEvents.length) {
    const event = seekCacheSortedEvents[cursor];
    if (normalizeTimelineTime(event.time) > target) {
      break;
    }
    state = applyEvent(state, event);
    cursor += 1;
  }
  seekCacheState = state;
  seekCacheTime = target;
  seekCacheCursor = cursor;
  return state;
};

type TimelineSnapshot = {
  events: TimelineEvent[];
  audioSegments: AudioSegment[];
  transaction?: TimelineTransaction;
};

type History = {
  past: TimelineSnapshot[];
  future: TimelineSnapshot[];
};

export type WhiteboardStore = {
  project: ProjectMeta;
  state: ProjectState;
  events: TimelineEvent[];
  timelineSegments: TimelineSegment[];
  audioSegments: AudioSegment[];
  recordingStatus: RecordingStatus;
  currentTime: number;
  selectedEventId?: string;
  selectedSegmentId?: string;
  splitResult?: TimelineSplit;
  lastTransaction?: TimelineTransaction;

  dispatchEvent: (event: TimelineEvent) => void;
  insertEventAtTime: (
    event: TimelineEventInsertDraft,
    time: number,
  ) => void;
  deleteEvent: (eventId: string) => void;
  deleteRange: (start: number, end: number) => void;
  rippleDeleteRange: (start: number, end: number) => void;
  deleteFuture: (time: number) => void;
  splitAt: (time: number) => void;
  seek: (time: number) => void;
  setRuntimeCurrentTime: (time: number) => void;
  rebuild: () => void;
  undo: () => void;
  redo: () => void;

  moveEventTime: (eventId: string, newTime: number) => void;
  setSelectedEvent: (eventId?: string) => void;
  setSelectedSegment: (segmentId?: string) => void;
  splitSelectedSegmentAt: (time: number) => boolean;
  addAudioSegment: (segment: AudioSegment) => void;
  insertGap: (start: number, duration: number, options?: {
    eventIds?: string[];
    audioIds?: string[];
    pushHistory?: boolean;
  }) => void;
  setRecordingStatus: (status: RecordingStatus) => void;
  applyReplayFrame: (state: ProjectState, time: number) => void;
  setProjectTitle: (title: string) => void;
  setProjectPages: (
    pages: ProjectPage[],
    options?: {
      replace?: boolean;
      switchToPageId?: string;
      touchUpdatedAt?: boolean;
    },
  ) => void;
  renameProjectPage: (pageId: string, name: string) => void;
  moveProjectPage: (pageId: string, toIndex: number) => void;
  duplicateProjectPage: (pageId: string) => string | null;
  deleteProjectPage: (pageId: string) => void;

  createTimelineEvent: <T extends TimelineEventType>(
    event: TimelineEventDraft<T> & { time?: number },
  ) => TimelineEventOfType<T>;

  exportSnapshotJson: () => string;
  importSnapshotJson: (json: string) => Result<void, string>;
  resetProject: () => void;
};

type InternalStore = WhiteboardStore & {
  history: History;
};

const withHistoryPush = (
  history: History,
  currentEvents: TimelineEvent[],
  currentAudioSegments: AudioSegment[],
  transaction?: TimelineTransaction,
): History => ({
  past: [
    ...history.past,
    {
      events: currentEvents,
      audioSegments: currentAudioSegments,
      transaction,
    },
  ],
  future: [],
});

const getAudioMaxTime = (audioSegments: AudioSegment[]): number => {
  if (audioSegments.length === 0) {
    return 0;
  }
  return Math.max(...audioSegments.map((segment) => normalizeTimelineTime(segment.endTime)));
};

const getPlayableMaxTime = (events: TimelineEvent[], audioSegments: AudioSegment[]): number => {
  return Math.max(getTimelineMaxTime(events), getAudioMaxTime(audioSegments));
};

const clampCurrentTime = (time: number, events: TimelineEvent[], audioSegments: AudioSegment[]): number => {
  const maxTime = getPlayableMaxTime(events, audioSegments);
  return Math.min(normalizeTimelineTime(time), maxTime);
};

const buildProjectMeta = (previous: ProjectMeta, state: ProjectState): ProjectMeta => {
  const existing = [...previous.pages].sort((a, b) => a.order - b.order);
  const existingById = new Map(existing.map((page) => [page.id, page]));
  const orderIds: string[] = [];
  for (const page of existing) {
    orderIds.push(page.id);
  }

  // Keep project page metadata as the primary source of truth so deleted pages
  // are not re-hydrated from historical replay state. We only append the
  // currently active page when replay reaches a page that metadata does not yet know about.
  if (state.currentPageId && !existingById.has(state.currentPageId)) {
    orderIds.push(state.currentPageId);
  }

  const pages = orderIds.map((id, index) => {
    const existingPage = existingById.get(id);
    if (existingPage) {
      return {
        ...existingPage,
        order: index,
        name: `Page ${index + 1}`,
      };
    }

    return {
      id,
      name: `Page ${index + 1}`,
      assetType: 'blank' as const,
      order: index,
    };
  });

  return {
    ...previous,
    pages,
  };
};

const normalizeProjectPages = (pages: ProjectPage[]): ProjectPage[] => {
  return pages
    .map((page, index) => ({
      ...page,
      name: `Page ${index + 1}`,
      order: index,
    }))
    .sort((a, b) => a.order - b.order)
    .map((page, index) => ({
      ...page,
      order: index,
    }));
};

const applyTimeline = (
  events: TimelineEvent[],
  time: number,
  project: ProjectMeta,
  audioSegments: AudioSegment[],
): Pick<
  InternalStore,
  'project' | 'events' | 'timelineSegments' | 'audioSegments' | 'currentTime' | 'state'
> => {
  const sorted = sortEvents(events);
  const maxPlayableTime = getPlayableMaxTime(sorted, audioSegments);
  const safeTime = clampCurrentTime(time, sorted, audioSegments);
  const state = deriveState(sorted, safeTime);
  const timelineSegments = deriveTimelineSegments(
    project.id,
    state.currentPageId,
    sorted,
    maxPlayableTime,
  );
  const nextProject = buildProjectMeta(project, state);

  return {
    project: nextProject,
    events: sorted,
    timelineSegments,
    audioSegments,
    currentTime: safeTime,
    state,
  };
};

const applyTimelineAsync = async (
  events: TimelineEvent[],
  time: number,
  project: ProjectMeta,
  audioSegments: AudioSegment[],
): Promise<Pick<
  InternalStore,
  'project' | 'events' | 'timelineSegments' | 'audioSegments' | 'currentTime' | 'state'
>> => {
  const sorted = sortEvents(events);
  const maxPlayableTime = Math.max(
    await nativeTimelineAdapter.getTimelineMaxTime(sorted),
    getAudioMaxTime(audioSegments),
  );
  const safeTime = Math.min(normalizeTimelineTime(time), maxPlayableTime);
  const state = await nativeTimelineAdapter.getStateAtTime(INITIAL_STATE, sorted, safeTime);
  const timelineSegments = deriveTimelineSegments(
    project.id,
    state.currentPageId,
    sorted,
    maxPlayableTime,
  );
  const nextProject = buildProjectMeta(project, state);

  return {
    project: nextProject,
    events: sorted,
    timelineSegments,
    audioSegments,
    currentTime: safeTime,
    state,
  };
};

const applyHistorySnapshotAsync = async (
  store: InternalStore,
  snapshot: TimelineSnapshot,
  history: History,
): Promise<Partial<InternalStore>> => {
  const timeline = await applyTimelineAsync(
    snapshot.events,
    store.currentTime,
    store.project,
    snapshot.audioSegments,
  );

  return {
    ...timeline,
    selectedEventId: ensureSelectedEventId(store.selectedEventId, timeline.events),
    selectedSegmentId: ensureSelectedSegmentId(
      store.selectedSegmentId,
      timeline.timelineSegments,
    ),
    recordingStatus: store.recordingStatus,
    lastTransaction: snapshot.transaction,
    history,
  };
};

const ensureSelectedEventId = (
  selectedEventId: string | undefined,
  events: TimelineEvent[],
): string | undefined => {
  if (!selectedEventId) {
    return undefined;
  }
  return events.some((event) => event.id === selectedEventId) ? selectedEventId : undefined;
};

const ensureSelectedSegmentId = (
  selectedSegmentId: string | undefined,
  segments: TimelineSegment[],
): string | undefined => {
  if (!selectedSegmentId) {
    return undefined;
  }
  return segments.some((segment) => segment.id === selectedSegmentId) ? selectedSegmentId : undefined;
};

const createTransaction = (
  kind: TimelineTransaction['kind'],
  params: TimelineTransaction['params'],
): TimelineTransaction => ({
  id: generateId('tx'),
  kind,
  createdAt: Date.now(),
  params,
});

const applyTimelineCommandWithTransaction = (
  store: InternalStore,
  command: TimelineCommand,
  transaction: TimelineTransaction,
  options?: {
    historyMode?: 'always' | 'auto' | 'never';
    setLastTransaction?: boolean;
  },
): Partial<InternalStore> | null => {
  const result = executeTimelineCommand(
    {
      currentTime: store.currentTime,
      currentPageId: store.state.currentPageId,
      events: store.events,
      audioSegments: store.audioSegments,
      timelineSegments: store.timelineSegments,
      createEvent: (event) => store.createTimelineEvent(event),
    },
    command,
  );

  if (!result.applied) {
    return null;
  }

  const timeline = applyTimeline(result.events, result.currentTime, store.project, result.audioSegments);
  const historyMode = options?.historyMode ?? 'always';
  const shouldPushHistory = historyMode === 'always'
    ? true
    : historyMode === 'auto'
      ? store.recordingStatus === 'idle'
      : false;
  const shouldSetLastTransaction = options?.setLastTransaction ?? true;
  return {
    ...timeline,
    selectedEventId: ensureSelectedEventId(store.selectedEventId, timeline.events),
    selectedSegmentId: ensureSelectedSegmentId(
      store.selectedSegmentId,
      timeline.timelineSegments,
    ),
    recordingStatus: store.recordingStatus,
    splitResult: undefined,
    lastTransaction: shouldSetLastTransaction ? transaction : store.lastTransaction,
    history: shouldPushHistory
      ? withHistoryPush(store.history, store.events, store.audioSegments, transaction)
      : store.history,
  };
};

const applyTimelineCommandWithTransactionAsync = async (
  store: InternalStore,
  command: TimelineCommand,
  transaction: TimelineTransaction,
  options?: {
    historyMode?: 'always' | 'auto' | 'never';
    setLastTransaction?: boolean;
  },
): Promise<Partial<InternalStore> | null> => {
  const result = await executeTimelineCommandAsync(
    {
      currentTime: store.currentTime,
      currentPageId: store.state.currentPageId,
      events: store.events,
      audioSegments: store.audioSegments,
      timelineSegments: store.timelineSegments,
      createEvent: (event) => store.createTimelineEvent(event),
    },
    command,
  );

  if (!result.applied) {
    return null;
  }

  const timeline = await applyTimelineAsync(
    result.events,
    result.currentTime,
    store.project,
    result.audioSegments,
  );
  const historyMode = options?.historyMode ?? 'always';
  const shouldPushHistory = historyMode === 'always'
    ? true
    : historyMode === 'auto'
      ? store.recordingStatus === 'idle'
      : false;
  const shouldSetLastTransaction = options?.setLastTransaction ?? true;
  return {
    ...timeline,
    selectedEventId: ensureSelectedEventId(store.selectedEventId, timeline.events),
    selectedSegmentId: ensureSelectedSegmentId(
      store.selectedSegmentId,
      timeline.timelineSegments,
    ),
    recordingStatus: store.recordingStatus,
    splitResult: undefined,
    lastTransaction: shouldSetLastTransaction ? transaction : store.lastTransaction,
    history: shouldPushHistory
      ? withHistoryPush(store.history, store.events, store.audioSegments, transaction)
      : store.history,
  };
};

let nativeMutationQueue: Promise<void> = Promise.resolve();
let nativeSeekToken = 0;
let nativeSplitToken = 0;

const enqueueNativeMutation = (task: () => Promise<void>): void => {
  nativeMutationQueue = nativeMutationQueue
    .then(task)
    .catch((error) => {
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error('[UniFlow] Native timeline mutation failed, state kept unchanged.', error);
      }
    });
};

const createPageSetEvent = (
  currentPageId: string,
  currentTime: number,
  targetPageId: string,
): TimelineEvent => ({
  id: generateId('evt'),
  projectId: DEFAULT_PROJECT_ID,
  pageId: currentPageId,
  actorId: 'local-actor',
  time: normalizeTimelineTime(currentTime),
  type: TimelineEventType.PAGE_SET,
  targetId: targetPageId,
  payload: { pageId: targetPageId },
});

const buildProjectWithPages = (
  store: InternalStore,
  pages: ProjectPage[],
  touchUpdatedAt: boolean,
): ProjectMeta => ({
  ...store.project,
  pages,
  updatedAt: touchUpdatedAt
    ? new Date().toISOString()
    : store.project.updatedAt,
});

const resolveSplitTarget = (
  timelineSegments: TimelineSegment[],
  splitTime: number,
  selectedSegmentId?: string,
): TimelineSegment | undefined => {
  const selectedSegment = selectedSegmentId
    ? timelineSegments.find((segment) => segment.id === selectedSegmentId)
    : undefined;
  const selectedContainsTime = selectedSegment
    ? splitTime > selectedSegment.startTime && splitTime < selectedSegment.endTime
    : false;
  if (selectedContainsTime) {
    return selectedSegment;
  }
  return timelineSegments.find(
    (segment) => splitTime > segment.startTime && splitTime < segment.endTime,
  );
};

const applyProjectPagesTimeline = (
  store: InternalStore,
  nextPages: ProjectPage[],
  options?: {
    switchToPageId?: string;
    touchUpdatedAt?: boolean;
  },
): Partial<InternalStore> => {
  const switchToPageId = options?.switchToPageId;
  const shouldSwitch = !!switchToPageId && switchToPageId !== store.state.currentPageId;
  const nextEvents = shouldSwitch
    ? insertEvent(store.events, createPageSetEvent(
      store.state.currentPageId,
      store.currentTime,
      switchToPageId,
    ))
    : store.events;

  const timeline = applyTimeline(
    nextEvents,
    store.currentTime,
    buildProjectWithPages(store, nextPages, options?.touchUpdatedAt !== false),
    store.audioSegments,
  );

  return {
    ...timeline,
    recordingStatus: store.recordingStatus,
  };
};

const applyProjectPagesTimelineAsync = async (
  store: InternalStore,
  nextPages: ProjectPage[],
  options?: {
    switchToPageId?: string;
    touchUpdatedAt?: boolean;
  },
): Promise<Partial<InternalStore>> => {
  const switchToPageId = options?.switchToPageId;
  const shouldSwitch = !!switchToPageId && switchToPageId !== store.state.currentPageId;
  const nextEvents = shouldSwitch
    ? await nativeTimelineAdapter.insertEvent(
      store.events,
      createPageSetEvent(store.state.currentPageId, store.currentTime, switchToPageId),
    )
    : store.events;

  const timeline = await applyTimelineAsync(
    nextEvents,
    store.currentTime,
    buildProjectWithPages(store, nextPages, options?.touchUpdatedAt !== false),
    store.audioSegments,
  );

  return {
    ...timeline,
    recordingStatus: store.recordingStatus,
  };
};

const hydrated = loadSnapshotFromStorage();
const hydratedEvents = hydrated?.events ?? [];
const hydratedAudio = hydrated?.audioSegments ?? [];
const hydratedTime = hydrated?.currentTime ?? 0;
const hydratedTimeline = applyTimeline(hydratedEvents, hydratedTime, INITIAL_PROJECT, hydratedAudio);

export const useWhiteboardStore = create<InternalStore>((set, get) => ({
  project: hydratedTimeline.project,
  state: hydratedTimeline.state,
  events: hydratedTimeline.events,
  timelineSegments: hydratedTimeline.timelineSegments,
  audioSegments: hydratedTimeline.audioSegments,
  recordingStatus: 'idle',
  currentTime: hydratedTimeline.currentTime,
  selectedEventId: undefined,
  selectedSegmentId: undefined,
  splitResult: undefined,
  lastTransaction: undefined,
  history: {
    past: [],
    future: [],
  },

  createTimelineEvent: (event) => {
    const store = get();
    const time = normalizeTimelineTime(event.time ?? store.currentTime);

    return {
      ...event,
      id: generateId('evt'),
      projectId: DEFAULT_PROJECT_ID,
      actorId: 'local-actor',
      time,
    } as TimelineEventOfType<typeof event.type>;
  },

  dispatchEvent: (event) => {
    if (hasNativeTimelineRuntime()) {
      enqueueNativeMutation(async () => {
        const store = get();
        const tx = createTransaction('insert_event', {
          eventId: event.id,
          eventType: event.type,
          time: normalizeTimelineTime(event.time),
        });
        const next = await applyTimelineCommandWithTransactionAsync(store, {
          kind: 'insert_event',
          event,
        }, tx, {
          historyMode: 'auto',
          setLastTransaction: false,
        });
        if (next) {
          set(next as Partial<InternalStore>);
        }
      });
      return;
    }
    set((store) => {
      const tx = createTransaction('insert_event', {
        eventId: event.id,
        eventType: event.type,
        time: normalizeTimelineTime(event.time),
      });
      return applyTimelineCommandWithTransaction(store, {
        kind: 'insert_event',
        event,
      }, tx, {
        historyMode: 'auto',
        setLastTransaction: false,
      }) ?? {};
    });
  },

  insertEventAtTime: (event, time) => {
    const currentPageId = get().state.currentPageId;
    const timelineEvent = {
      ...event,
      id: event.id ?? generateId('evt'),
      projectId: event.projectId ?? DEFAULT_PROJECT_ID,
      actorId: event.actorId ?? 'local-actor',
      pageId: event.pageId ?? currentPageId,
      time: normalizeTimelineTime(time),
    } as TimelineEvent;
    get().dispatchEvent(timelineEvent);
  },

  deleteEvent: (eventId) => {
    if (hasNativeTimelineRuntime()) {
      enqueueNativeMutation(async () => {
        const store = get();
        const tx = createTransaction('delete_event', { eventId });
        const next = await applyTimelineCommandWithTransactionAsync(store, {
          kind: 'delete_event',
          eventId,
        }, tx);
        if (!next) {
          return;
        }
        const nextEvents = next.events ?? store.events;
        set({
          ...next,
          selectedEventId: ensureSelectedEventId(
            store.selectedEventId === eventId ? undefined : store.selectedEventId,
            nextEvents,
          ),
        } as Partial<InternalStore>);
      });
      return;
    }
    set((store) => {
      const tx = createTransaction('delete_event', { eventId });
      const next = applyTimelineCommandWithTransaction(store, {
        kind: 'delete_event',
        eventId,
      }, tx);
      if (!next) {
        return {};
      }
      const nextEvents = next.events ?? store.events;

      return {
        ...next,
        selectedEventId: ensureSelectedEventId(
          store.selectedEventId === eventId ? undefined : store.selectedEventId,
          nextEvents,
        ),
      };
    });
  },

  deleteRange: (start, end) => {
    if (hasNativeTimelineRuntime()) {
      enqueueNativeMutation(async () => {
        const range = normalizeTimelineRange(start, end);
        const store = get();
        const tx = createTransaction('delete_range', {
          start: range.start,
          end: range.end,
        });
        const next = await applyTimelineCommandWithTransactionAsync(store, {
          kind: 'delete_range',
          start: range.start,
          end: range.end,
        }, tx);
        if (next) {
          set(next as Partial<InternalStore>);
        }
      });
      return;
    }
    set((store) => {
      const range = normalizeTimelineRange(start, end);
      const tx = createTransaction('delete_range', {
        start: range.start,
        end: range.end,
      });
      return applyTimelineCommandWithTransaction(store, {
        kind: 'delete_range',
        start: range.start,
        end: range.end,
      }, tx) ?? {};
    });
  },

  rippleDeleteRange: (start, end) => {
    if (hasNativeTimelineRuntime()) {
      enqueueNativeMutation(async () => {
        const range = normalizeTimelineRange(start, end);
        const store = get();
        const tx = createTransaction('ripple_delete_range', {
          start: range.start,
          end: range.end,
          duration: getTimelineDuration(range.start, range.end),
        });
        const next = await applyTimelineCommandWithTransactionAsync(store, {
          kind: 'ripple_delete_range',
          start: range.start,
          end: range.end,
        }, tx);
        if (next) {
          set(next as Partial<InternalStore>);
        }
      });
      return;
    }
    set((store) => {
      const range = normalizeTimelineRange(start, end);
      const tx = createTransaction('ripple_delete_range', {
        start: range.start,
        end: range.end,
        duration: getTimelineDuration(range.start, range.end),
      });
      return applyTimelineCommandWithTransaction(store, {
        kind: 'ripple_delete_range',
        start: range.start,
        end: range.end,
      }, tx) ?? {};
    });
  },

  deleteFuture: (time) => {
    if (hasNativeTimelineRuntime()) {
      enqueueNativeMutation(async () => {
        const at = normalizeTimelineTime(time);
        const store = get();
        const tx = createTransaction('delete_future', { time: at });
        const next = await applyTimelineCommandWithTransactionAsync(store, {
          kind: 'delete_future',
          time: at,
        }, tx);
        if (next) {
          set(next as Partial<InternalStore>);
        }
      });
      return;
    }
    set((store) => {
      const at = normalizeTimelineTime(time);
      const tx = createTransaction('delete_future', { time: at });
      return applyTimelineCommandWithTransaction(store, {
        kind: 'delete_future',
        time: at,
      }, tx) ?? {};
    });
  },

  splitAt: (time) => {
    if (hasNativeTimelineRuntime()) {
      const store = get();
      const splitTime = normalizeTimelineTime(time);
      const token = nativeSplitToken + 1;
      nativeSplitToken = token;
      void nativeTimelineAdapter.splitTimeline(store.events, splitTime)
        .then((splitResult) => {
          if (token !== nativeSplitToken) {
            return;
          }
          set({ splitResult });
        })
        .catch((error) => {
          if (typeof console !== 'undefined' && typeof console.error === 'function') {
            console.error('[UniFlow] Native timeline split preview failed, state kept unchanged.', error);
          }
        });
      return;
    }
    set((store) => ({
      splitResult: splitTimeline(store.events, time),
    }));
  },

  seek: (time) => {
    if (hasNativeTimelineRuntime()) {
      const store = get();
      const safeTime = clampCurrentTime(time, store.events, store.audioSegments);
      const token = nativeSeekToken + 1;
      nativeSeekToken = token;
      set({
        currentTime: safeTime,
      });
      void nativeTimelineAdapter.getStateAtTime(INITIAL_STATE, store.events, safeTime)
        .then((state) => {
          if (token !== nativeSeekToken) {
            return;
          }
          set({
            currentTime: safeTime,
            state,
          });
        })
        .catch((error) => {
          if (typeof console !== 'undefined' && typeof console.error === 'function') {
            console.error('[UniFlow] Native timeline seek failed, state kept unchanged.', error);
          }
        });
      return;
    }
    set((store) => {
      const t = normalizeTimelineTime(time);
      return {
        currentTime: t,
        state: deriveStateFastForSeek(store.events, t),
      };
    });
  },

  setRuntimeCurrentTime: (time) => {
    set({
      currentTime: normalizeTimelineTime(time),
    });
  },

  rebuild: () => {
    if (hasNativeTimelineRuntime()) {
      enqueueNativeMutation(async () => {
        const store = get();
        const timeline = await applyTimelineAsync(
          store.events,
          store.currentTime,
          store.project,
          store.audioSegments,
        );
        set({
          ...timeline,
          selectedEventId: ensureSelectedEventId(store.selectedEventId, timeline.events),
          selectedSegmentId: ensureSelectedSegmentId(
            store.selectedSegmentId,
            timeline.timelineSegments,
          ),
          recordingStatus: store.recordingStatus,
        } as Partial<InternalStore>);
      });
      return;
    }
    set((store) => {
      const timeline = applyTimeline(store.events, store.currentTime, store.project, store.audioSegments);
      return {
        ...timeline,
        selectedEventId: ensureSelectedEventId(store.selectedEventId, timeline.events),
        selectedSegmentId: ensureSelectedSegmentId(
          store.selectedSegmentId,
          timeline.timelineSegments,
        ),
        recordingStatus: store.recordingStatus,
      };
    });
  },

  undo: () => {
    if (hasNativeTimelineRuntime()) {
      enqueueNativeMutation(async () => {
        const store = get();
        if (store.history.past.length === 0) {
          return;
        }

        const previous = store.history.past[store.history.past.length - 1];
        const nextPast = store.history.past.slice(0, -1);
        const nextFuture = [
          ...store.history.future,
          {
            events: store.events,
            audioSegments: store.audioSegments,
            transaction: store.lastTransaction,
          },
        ];
        const next = await applyHistorySnapshotAsync(store, previous, {
          past: nextPast,
          future: nextFuture,
        });
        set(next as Partial<InternalStore>);
      });
      return;
    }
    set((store) => {
      if (store.history.past.length === 0) {
        return {};
      }

      const previous = store.history.past[store.history.past.length - 1];
      const nextPast = store.history.past.slice(0, -1);
      const nextFuture = [
        ...store.history.future,
        {
          events: store.events,
          audioSegments: store.audioSegments,
          transaction: store.lastTransaction,
        },
      ];
      const timeline = applyTimeline(
        previous.events,
        store.currentTime,
        store.project,
        previous.audioSegments,
      );

      return {
        ...timeline,
        selectedEventId: ensureSelectedEventId(store.selectedEventId, timeline.events),
        selectedSegmentId: ensureSelectedSegmentId(
          store.selectedSegmentId,
          timeline.timelineSegments,
        ),
        recordingStatus: store.recordingStatus,
        lastTransaction: previous.transaction,
        history: {
          past: nextPast,
          future: nextFuture,
        },
      };
    });
  },

  redo: () => {
    if (hasNativeTimelineRuntime()) {
      enqueueNativeMutation(async () => {
        const store = get();
        if (store.history.future.length === 0) {
          return;
        }

        const nextSnapshot = store.history.future[store.history.future.length - 1];
        const nextFuture = store.history.future.slice(0, -1);
        const nextPast = [
          ...store.history.past,
          {
            events: store.events,
            audioSegments: store.audioSegments,
            transaction: store.lastTransaction,
          },
        ];
        const next = await applyHistorySnapshotAsync(store, nextSnapshot, {
          past: nextPast,
          future: nextFuture,
        });
        set(next as Partial<InternalStore>);
      });
      return;
    }
    set((store) => {
      if (store.history.future.length === 0) {
        return {};
      }

      const next = store.history.future[store.history.future.length - 1];
      const nextFuture = store.history.future.slice(0, -1);
      const nextPast = [
        ...store.history.past,
        {
          events: store.events,
          audioSegments: store.audioSegments,
          transaction: store.lastTransaction,
        },
      ];
      const timeline = applyTimeline(
        next.events,
        store.currentTime,
        store.project,
        next.audioSegments,
      );

      return {
        ...timeline,
        selectedEventId: ensureSelectedEventId(store.selectedEventId, timeline.events),
        selectedSegmentId: ensureSelectedSegmentId(
          store.selectedSegmentId,
          timeline.timelineSegments,
        ),
        recordingStatus: store.recordingStatus,
        lastTransaction: next.transaction,
        history: {
          past: nextPast,
          future: nextFuture,
        },
      };
    });
  },

  moveEventTime: (eventId, newTime) => {
    if (hasNativeTimelineRuntime()) {
      enqueueNativeMutation(async () => {
        const normalizedTime = normalizeTimelineTime(newTime);
        const store = get();
        const tx = createTransaction('move_event_time', {
          eventId,
          newTime: normalizedTime,
        });
        const next = await applyTimelineCommandWithTransactionAsync(store, {
          kind: 'move_event_time',
          eventId,
          newTime: normalizedTime,
        }, tx);
        if (next) {
          set(next as Partial<InternalStore>);
        }
      });
      return;
    }
    set((store) => {
      const normalizedTime = normalizeTimelineTime(newTime);
      const tx = createTransaction('move_event_time', {
        eventId,
        newTime: normalizedTime,
      });
      return applyTimelineCommandWithTransaction(store, {
        kind: 'move_event_time',
        eventId,
        newTime: normalizedTime,
      }, tx) ?? {};
    });
  },

  setSelectedEvent: (eventId) => {
    set({ selectedEventId: eventId });
  },

  setSelectedSegment: (segmentId) => {
    set({ selectedSegmentId: segmentId });
  },

  splitSelectedSegmentAt: (time) => {
    const initialStore = get();
    const splitTime = normalizeTimelineTime(time);
    const targetSegment = resolveSplitTarget(
      initialStore.timelineSegments,
      splitTime,
      initialStore.selectedSegmentId,
    );
    if (!targetSegment) {
      return false;
    }
    if (hasNativeTimelineRuntime()) {
      enqueueNativeMutation(async () => {
        const store = get();
        const tx = createTransaction('split_at', {
          time: splitTime,
          selectedSegmentId: store.selectedSegmentId ?? null,
        });
        const next = await applyTimelineCommandWithTransactionAsync(store, {
          kind: 'split_at',
          time: splitTime,
          selectedSegmentId: store.selectedSegmentId,
        }, tx);
        if (!next) {
          return;
        }
        const selectedSegmentId = next.timelineSegments?.find((segment) => segment.startTime === splitTime)?.id;
        set({
          ...next,
          selectedSegmentId: selectedSegmentId ?? next.selectedSegmentId,
        } as Partial<InternalStore>);
      });
      return true;
    }
    const store = get();
    const tx = createTransaction('split_at', {
      time: splitTime,
      selectedSegmentId: store.selectedSegmentId ?? null,
    });
    const next = applyTimelineCommandWithTransaction(store, {
      kind: 'split_at',
      time: splitTime,
      selectedSegmentId: store.selectedSegmentId,
    }, tx);
    if (!next) {
      return false;
    }

    const selectedSegmentId = next.timelineSegments?.find((segment) => segment.startTime === splitTime)?.id;
    set({
      ...next,
      selectedSegmentId: selectedSegmentId ?? next.selectedSegmentId,
    });
    return true;
  },

  addAudioSegment: (segment) => {
    set((store) => {
      const normalized: AudioSegment = {
        ...segment,
        startTime: normalizeTimelineTime(segment.startTime),
        endTime: normalizeTimelineTime(segment.endTime),
        sourceOffsetMs: normalizeTimelineTime(segment.sourceOffsetMs ?? 0),
        sourceDurationMs: normalizeTimelineTime(
          segment.sourceDurationMs
            ?? Math.max(1, normalizeTimelineTime(segment.endTime) - normalizeTimelineTime(segment.startTime)),
        ),
        waveform: segment.waveform,
      };

      if (normalized.endTime <= normalized.startTime) {
        return {};
      }

      // Single-track audio: replace overlapping region to avoid doubled/offset-sounding playback.
      const trimmed = deleteRangeFromAudioSegments(
        store.audioSegments,
        normalized.startTime,
        normalized.endTime,
      );
      const nextAudio = [...trimmed, normalized].sort((a, b) => a.startTime - b.startTime);
      const timeline = applyTimeline(
        store.events,
        Math.max(store.currentTime, normalized.endTime),
        store.project,
        nextAudio,
      );

      return {
        ...timeline,
        selectedEventId: ensureSelectedEventId(store.selectedEventId, timeline.events),
        selectedSegmentId: ensureSelectedSegmentId(
          store.selectedSegmentId,
          timeline.timelineSegments,
        ),
        recordingStatus: store.recordingStatus,
        history: withHistoryPush(store.history, store.events, store.audioSegments),
      };
    });
  },

  insertGap: (start, duration, options) => {
    if (hasNativeTimelineRuntime()) {
      enqueueNativeMutation(async () => {
        const safeDuration = Math.max(0, Math.trunc(duration));
        if (safeDuration <= 0) {
          return;
        }
        const normalizedStart = normalizeTimelineTime(start);
        const store = get();
        const tx = createTransaction('insert_gap', {
          start: normalizedStart,
          duration: safeDuration,
          eventIdsCount: options?.eventIds?.length ?? 0,
          audioIdsCount: options?.audioIds?.length ?? 0,
        });
        const next = await applyTimelineCommandWithTransactionAsync(
          store,
          {
            kind: 'insert_gap',
            start: normalizedStart,
            duration: safeDuration,
            eventIds: options?.eventIds,
            audioIds: options?.audioIds,
          },
          tx,
          {
            historyMode: (options?.pushHistory ?? true) ? 'always' : 'never',
            setLastTransaction: options?.pushHistory ?? true,
          },
        );
        if (next) {
          set(next as Partial<InternalStore>);
        }
      });
      return;
    }
    set((store) => {
      const safeDuration = Math.max(0, Math.trunc(duration));
      if (safeDuration <= 0) {
        return {};
      }
      const normalizedStart = normalizeTimelineTime(start);
      const tx = createTransaction('insert_gap', {
        start: normalizedStart,
        duration: safeDuration,
        eventIdsCount: options?.eventIds?.length ?? 0,
        audioIdsCount: options?.audioIds?.length ?? 0,
      });
      return applyTimelineCommandWithTransaction(
        store,
        {
          kind: 'insert_gap',
          start: normalizedStart,
          duration: safeDuration,
          eventIds: options?.eventIds,
          audioIds: options?.audioIds,
        },
        tx,
        {
          historyMode: (options?.pushHistory ?? true) ? 'always' : 'never',
          setLastTransaction: options?.pushHistory ?? true,
        },
      ) ?? {};
    });
  },

  setRecordingStatus: (status) => {
    set((store) => {
      const next: Partial<InternalStore> = {
        recordingStatus: status,
      };

      if (status === 'recording' && store.recordingStatus === 'idle') {
        next.history = withHistoryPush(store.history, store.events, store.audioSegments);
      }

      return next;
    });
  },

  applyReplayFrame: (state, time) => {
    set({
      state,
      currentTime: normalizeTimelineTime(time),
    });
  },

  setProjectTitle: (title) => {
    set((store) => ({
      project: {
        ...store.project,
        title: title.trim() || 'UniFlow Project',
        updatedAt: new Date().toISOString(),
      },
    }));
  },

  setProjectPages: (pages, options) => {
    if (hasNativeTimelineRuntime()) {
      enqueueNativeMutation(async () => {
        const store = get();
        const basePages = options?.replace
          ? []
          : [...store.project.pages];
        const mergedById = new Map<string, ProjectPage>();
        for (const page of basePages) {
          mergedById.set(page.id, page);
        }
        for (const page of pages) {
          mergedById.set(page.id, page);
        }
        const nextPages = normalizeProjectPages([...mergedById.values()]);
        const next = await applyProjectPagesTimelineAsync(store, nextPages, options);
        set(next as Partial<InternalStore>);
      });
      return;
    }
    set((store) => {
      const basePages = options?.replace
        ? []
        : [...store.project.pages];
      const mergedById = new Map<string, ProjectPage>();
      for (const page of basePages) {
        mergedById.set(page.id, page);
      }
      for (const page of pages) {
        mergedById.set(page.id, page);
      }
      const nextPages = normalizeProjectPages([...mergedById.values()]);

      return applyProjectPagesTimeline(store, nextPages, options);
    });
  },

  renameProjectPage: (pageId, name) => {
    set((store) => {
      const nextName = name.trim();
      if (!nextName) {
        return {};
      }
      const nextPages = store.project.pages.map((page) => (
        page.id === pageId
          ? { ...page, name: nextName }
          : page
      ));
      return {
        project: {
          ...store.project,
          pages: normalizeProjectPages(nextPages),
          updatedAt: new Date().toISOString(),
        },
      };
    });
  },

  moveProjectPage: (pageId, toIndex) => {
    set((store) => {
      const pages = [...store.project.pages].sort((a, b) => a.order - b.order);
      const fromIndex = pages.findIndex((page) => page.id === pageId);
      if (fromIndex < 0) {
        return {};
      }
      const target = Math.max(0, Math.min(pages.length - 1, Math.trunc(toIndex)));
      if (target === fromIndex) {
        return {};
      }
      const [picked] = pages.splice(fromIndex, 1);
      pages.splice(target, 0, picked);
      return {
        project: {
          ...store.project,
          pages: normalizeProjectPages(pages),
          updatedAt: new Date().toISOString(),
        },
      };
    });
  },

  duplicateProjectPage: (pageId) => {
    const store = get();
    const pages = [...store.project.pages].sort((a, b) => a.order - b.order);
    const sourceIndex = pages.findIndex((page) => page.id === pageId);
    if (sourceIndex < 0) {
      return null;
    }
    const source = pages[sourceIndex];
    const duplicatedId = generateId('page');
    const duplicated: ProjectPage = {
      ...source,
      id: duplicatedId,
      name: `${source.name} Copy`,
      order: sourceIndex + 1,
    };
    pages.splice(sourceIndex + 1, 0, duplicated);
    get().setProjectPages(normalizeProjectPages(pages), {
      replace: true,
      switchToPageId: duplicatedId,
    });
    return duplicatedId;
  },

  deleteProjectPage: (pageId) => {
    if (hasNativeTimelineRuntime()) {
      enqueueNativeMutation(async () => {
        const store = get();
        if (store.project.pages.length <= 1) {
          return;
        }

        const currentSorted = [...store.project.pages].sort((a, b) => a.order - b.order);
        const currentIndex = currentSorted.findIndex((page) => page.id === pageId);
        if (currentIndex < 0) {
          return;
        }

        const nextPages = normalizeProjectPages(currentSorted.filter((page) => page.id !== pageId));
        const fallbackPageId = nextPages[Math.max(0, Math.min(currentIndex, nextPages.length - 1))]?.id;
        const next = await applyProjectPagesTimelineAsync(store, nextPages, {
          switchToPageId: fallbackPageId,
        });
        set(next as Partial<InternalStore>);
      });
      return;
    }
    set((store) => {
      if (store.project.pages.length <= 1) {
        return {};
      }

      const currentSorted = [...store.project.pages].sort((a, b) => a.order - b.order);
      const currentIndex = currentSorted.findIndex((page) => page.id === pageId);
      if (currentIndex < 0) {
        return {};
      }

      const nextPages = normalizeProjectPages(currentSorted.filter((page) => page.id !== pageId));
      const fallbackPageId = nextPages[Math.max(0, Math.min(currentIndex, nextPages.length - 1))]?.id;
      return applyProjectPagesTimeline(store, nextPages, {
        switchToPageId: fallbackPageId,
      });
    });
  },

  exportSnapshotJson: () => {
    const store = get();
    return snapshotToJson(createSnapshot(store.events, store.currentTime, store.audioSegments));
  },

  importSnapshotJson: (json) => {
    const snapshot = parseSnapshotJson(json);
    if (!snapshot) {
      return { ok: false, error: 'Invalid snapshot JSON' };
    }

    set((store) => {
      const timeline = applyTimeline(
        snapshot.events,
        snapshot.currentTime,
        store.project,
        snapshot.audioSegments,
      );
      return {
        ...timeline,
        recordingStatus: 'idle',
        selectedEventId: undefined,
        selectedSegmentId: undefined,
        splitResult: undefined,
        history: withHistoryPush(store.history, store.events, store.audioSegments),
      };
    });

    return { ok: true, value: undefined };
  },

  resetProject: () => {
    set((store) => {
      clearSnapshotStorage();
      const nextProject: ProjectMeta = {
        ...store.project,
        updatedAt: new Date().toISOString(),
        pages: [
          {
            id: DEFAULT_PAGE_ID,
            name: 'Page 1',
            assetType: 'blank',
            order: 0,
          },
        ],
      };
      return {
        ...applyTimeline([], 0, nextProject, []),
        recordingStatus: 'idle',
        selectedEventId: undefined,
        selectedSegmentId: undefined,
        splitResult: undefined,
        history: withHistoryPush(store.history, store.events, store.audioSegments),
      };
    });
  },
}));

export const useStore = useWhiteboardStore;
