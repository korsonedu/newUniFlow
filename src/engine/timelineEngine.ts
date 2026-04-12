import {
  createEmptyPageState,
  ObjectCreatePayload,
  ObjectDeletePayload,
  ObjectUpdatePayload,
  PageSetPayload,
  PageState,
  ProjectState,
  Stroke,
  StrokeCreatePayload,
  StrokeErasePayload,
  TimelineEvent,
  TimelineEventType,
  TimelineSplit,
  ViewportSetPayload,
  WhiteboardObject,
} from '../domain/types';
import {
  compareTimelineTime,
  getTimelineDuration,
  normalizeTimelineRange,
  normalizeTimelineTime as toTimelineTime,
  shiftTimelineTime,
} from '../domain/time';

type PageEventHandler = (page: PageState, event: TimelineEvent) => PageState;
type ProjectEventHandler = (state: ProjectState, event: TimelineEvent) => ProjectState;

const EVENT_PRIORITY: Record<TimelineEventType, number> = {
  [TimelineEventType.PAGE_SET]: 0,
  [TimelineEventType.STROKE_CREATE]: 10,
  [TimelineEventType.OBJECT_CREATE]: 10,
  [TimelineEventType.OBJECT_UPDATE]: 20,
  [TimelineEventType.VIEWPORT_SET]: 20,
  [TimelineEventType.STROKE_ERASE]: 30,
  [TimelineEventType.OBJECT_DELETE]: 30,
};

const asObject = (payload: unknown): Record<string, unknown> => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  return payload as Record<string, unknown>;
};

const asNumber = (value: unknown): number | undefined => {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const asNumberList = (value: unknown): number[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
};

const getStrokeCreateEventEndTime = (event: TimelineEvent): number => {
  const startTime = toTimelineTime(event.time);
  const payload = asObject(event.payload) as StrokeCreatePayload;
  const pointTimes = asNumberList(payload.pointTimes);
  if (pointTimes.length === 0) {
    return startTime;
  }
  return Math.max(...pointTimes.map((value) => toTimelineTime(value)));
};

const shiftStrokeCreatePointTimes = (event: TimelineEvent, shiftDelta: number): TimelineEvent => {
  if (event.type !== TimelineEventType.STROKE_CREATE || shiftDelta === 0) {
    return event;
  }

  const payload = asObject(event.payload);
  const pointTimes = asNumberList(payload.pointTimes);
  if (pointTimes.length === 0) {
    return event;
  }

  return {
    ...event,
    payload: {
      ...payload,
      pointTimes: pointTimes.map((value) => shiftTimelineTime(value, shiftDelta)),
    } as StrokeCreatePayload,
  };
};

const shiftStrokeCreatePointTimesFrom = (
  event: TimelineEvent,
  fromTimeInclusive: number,
  shiftDelta: number,
): TimelineEvent => {
  if (event.type !== TimelineEventType.STROKE_CREATE || shiftDelta === 0) {
    return event;
  }

  const payload = asObject(event.payload);
  const pointTimes = asNumberList(payload.pointTimes);
  if (pointTimes.length === 0) {
    return event;
  }

  const from = toTimelineTime(fromTimeInclusive);
  let changed = false;
  const nextPointTimes = pointTimes.map((value) => {
    const normalized = toTimelineTime(value);
    if (normalized >= from) {
      changed = true;
      return shiftTimelineTime(normalized, shiftDelta);
    }
    return normalized;
  });

  if (!changed) {
    return event;
  }

  return {
    ...event,
    payload: {
      ...payload,
      pointTimes: nextPointTimes,
    } as StrokeCreatePayload,
  };
};

const retimeEventKeepingRelativeTime = (event: TimelineEvent, nextTime: number): TimelineEvent => {
  const currentTime = toTimelineTime(event.time);
  const targetTime = toTimelineTime(nextTime);
  if (currentTime === targetTime) {
    return event;
  }

  return shiftStrokeCreatePointTimes(
    {
      ...event,
      time: targetTime,
    },
    targetTime - currentTime,
  );
};

const ensurePage = (state: ProjectState, pageId: string): PageState => {
  return state.pages[pageId] ?? createEmptyPageState(pageId);
};

const patchPage = (
  state: ProjectState,
  pageId: string,
  updater: (page: PageState) => PageState,
): ProjectState => {
  const page = ensurePage(state, pageId);
  const nextPage = updater(page);

  if (nextPage === page) {
    return state;
  }

  return {
    ...state,
    pages: {
      ...state.pages,
      [pageId]: nextPage,
    },
  };
};

const byTimeAndPriority = (a: TimelineEvent, b: TimelineEvent): number => {
  const timeDiff = compareTimelineTime(a.time, b.time);
  if (timeDiff !== 0) {
    return timeDiff;
  }

  const priorityDiff = (EVENT_PRIORITY[a.type] ?? 999) - (EVENT_PRIORITY[b.type] ?? 999);
  return priorityDiff;
};

export const sortEvents = (events: TimelineEvent[]): TimelineEvent[] => {
  return [...events]
    .map((event, index) => ({
      ...event,
      time: toTimelineTime(event.time),
      __index: index,
    }))
    .sort((a, b) => {
      const diff = byTimeAndPriority(a, b);
      if (diff !== 0) {
        return diff;
      }
      return a.__index - b.__index;
    })
    .map(({ __index: _index, ...event }) => event);
};

const sanitizeStrokePointTimes = (
  points: Stroke['points'],
  rawTimes: unknown,
  createdAt: number,
): number[] | undefined => {
  if (points.length === 0) {
    return undefined;
  }

  const source = asNumberList(rawTimes);
  if (source.length !== points.length) {
    return undefined;
  }

  let last = createdAt;
  const normalized = source.map((value) => {
    const t = Math.max(toTimelineTime(value), last, createdAt);
    last = t;
    return t;
  });

  return normalized;
};

const applyStrokeCreate: PageEventHandler = (page, event) => {
  const payload = asObject(event.payload) as StrokeCreatePayload;
  const strokeId = event.targetId ?? payload.id ?? event.id;
  const createdAt = toTimelineTime(event.time);
  const points = Array.isArray(payload.points) ? payload.points : [];
  const pointTimes = sanitizeStrokePointTimes(points, payload.pointTimes, createdAt);

  const stroke: Stroke = {
    id: strokeId,
    points,
    pointTimes,
    color: typeof payload.color === 'string' ? payload.color : '#111111',
    width: typeof payload.width === 'number' ? payload.width : 2,
    createdAt,
  };

  return {
    ...page,
    strokes: {
      ...page.strokes,
      [stroke.id]: stroke,
    },
  };
};

const resolveStrokeIds = (page: PageState, event: TimelineEvent): string[] => {
  const payload = asObject(event.payload) as StrokeErasePayload;

  const ids = [
    event.targetId,
    payload.strokeId,
    ...(Array.isArray(payload.strokeIds) ? payload.strokeIds : []),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);

  return [...new Set(ids)].filter((id) => Boolean(page.strokes[id]));
};

const applyStrokeErase: PageEventHandler = (page, event) => {
  const targetIds = resolveStrokeIds(page, event);
  if (targetIds.length === 0) {
    return page;
  }

  const eraseTime = toTimelineTime(event.time);
  const nextStrokes = { ...page.strokes };
  let changed = false;

  for (const strokeId of targetIds) {
    const current = nextStrokes[strokeId];
    if (!current) {
      continue;
    }

    const effectiveEraseTime = Math.max(eraseTime, current.createdAt);
    const nextDeletedAt =
      current.deletedAt === undefined
        ? effectiveEraseTime
        : Math.min(current.deletedAt, effectiveEraseTime);

    if (current.deletedAt !== nextDeletedAt) {
      nextStrokes[strokeId] = {
        ...current,
        deletedAt: nextDeletedAt,
      };
      changed = true;
    }
  }

  if (!changed) {
    return page;
  }

  return {
    ...page,
    strokes: nextStrokes,
  };
};

const applyObjectCreate: PageEventHandler = (page, event) => {
  const payload = asObject(event.payload) as ObjectCreatePayload;
  const objectId = event.targetId ?? payload.id ?? event.id;

  const object: WhiteboardObject = {
    id: objectId,
    type: payload.type ?? 'rect',
    x: asNumber(payload.x) ?? 0,
    y: asNumber(payload.y) ?? 0,
    width: asNumber(payload.width) ?? 100,
    height: asNumber(payload.height) ?? 70,
    rotation: asNumber(payload.rotation),
    style: payload.style ?? {},
    createdAt: toTimelineTime(event.time),
  };

  return {
    ...page,
    objects: {
      ...page.objects,
      [object.id]: object,
    },
  };
};

const applyObjectUpdate: PageEventHandler = (page, event) => {
  const payload = asObject(event.payload) as ObjectUpdatePayload;
  const targetId = event.targetId ?? payload.id;

  if (!targetId || !page.objects[targetId]) {
    return page;
  }

  const current = page.objects[targetId];
  const transform = payload.transform ?? {};

  const next: WhiteboardObject = {
    ...current,
    x: asNumber(transform.x) ?? asNumber(payload.x) ?? current.x,
    y: asNumber(transform.y) ?? asNumber(payload.y) ?? current.y,
    width: asNumber(transform.width) ?? asNumber(payload.width) ?? current.width,
    height: asNumber(transform.height) ?? asNumber(payload.height) ?? current.height,
    rotation: asNumber(transform.rotation) ?? asNumber(payload.rotation) ?? current.rotation,
    style: {
      ...(current.style ?? {}),
      ...(payload.style ?? {}),
    },
  };

  return {
    ...page,
    objects: {
      ...page.objects,
      [targetId]: next,
    },
  };
};

const applyObjectDelete: PageEventHandler = (page, event) => {
  const payload = asObject(event.payload) as ObjectDeletePayload;
  const candidateIds = [
    event.targetId,
    payload.objectId,
    ...(Array.isArray(payload.objectIds) ? payload.objectIds : []),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);

  const targetIds = [...new Set(candidateIds)].filter((id) => Boolean(page.objects[id]));
  if (targetIds.length === 0) {
    return page;
  }

  const deleteTime = toTimelineTime(event.time);
  const nextObjects = { ...page.objects };
  let changed = false;

  for (const objectId of targetIds) {
    const current = nextObjects[objectId];
    if (!current) {
      continue;
    }

    const effectiveDeleteTime = Math.max(deleteTime, current.createdAt);
    const nextDeletedAt =
      current.deletedAt === undefined
        ? effectiveDeleteTime
        : Math.min(current.deletedAt, effectiveDeleteTime);

    if (current.deletedAt !== nextDeletedAt) {
      nextObjects[objectId] = {
        ...current,
        deletedAt: nextDeletedAt,
      };
      changed = true;
    }
  }

  if (!changed) {
    return page;
  }

  return {
    ...page,
    objects: nextObjects,
  };
};

const applyViewportSet: PageEventHandler = (page, event) => {
  const payload = asObject(event.payload) as ViewportSetPayload;

  return {
    ...page,
    viewport: {
      x: asNumber(payload.x) ?? page.viewport.x,
      y: asNumber(payload.y) ?? page.viewport.y,
      zoom: asNumber(payload.zoom) ?? page.viewport.zoom,
    },
  };
};

const applyPageSet: ProjectEventHandler = (state, event) => {
  const payload = asObject(event.payload) as Partial<PageSetPayload>;
  const pageId = event.targetId ?? payload.pageId ?? event.pageId ?? state.currentPageId;

  if (!pageId) {
    return state;
  }

  const nextState = state.pages[pageId]
    ? state
    : {
        ...state,
        pages: {
          ...state.pages,
          [pageId]: createEmptyPageState(pageId),
        },
      };

  if (nextState.currentPageId === pageId) {
    return nextState;
  }

  return {
    ...nextState,
    currentPageId: pageId,
  };
};

const pageHandlers: Partial<Record<TimelineEventType, PageEventHandler>> = {
  [TimelineEventType.STROKE_CREATE]: applyStrokeCreate,
  [TimelineEventType.STROKE_ERASE]: applyStrokeErase,
  [TimelineEventType.OBJECT_CREATE]: applyObjectCreate,
  [TimelineEventType.OBJECT_UPDATE]: applyObjectUpdate,
  [TimelineEventType.OBJECT_DELETE]: applyObjectDelete,
  [TimelineEventType.VIEWPORT_SET]: applyViewportSet,
};

const projectHandlers: Partial<Record<TimelineEventType, ProjectEventHandler>> = {
  [TimelineEventType.PAGE_SET]: applyPageSet,
};

export const applyEvent = (state: ProjectState, event: TimelineEvent): ProjectState => {
  const projectHandler = projectHandlers[event.type];
  if (projectHandler) {
    return projectHandler(state, event);
  }

  const pageHandler = pageHandlers[event.type];
  if (!pageHandler) {
    return state;
  }

  const pageId = event.pageId || state.currentPageId;
  return patchPage(state, pageId, (page) => pageHandler(page, event));
};

export const applyEvents = (initialState: ProjectState, events: TimelineEvent[]): ProjectState => {
  return sortEvents(events).reduce((acc, event) => applyEvent(acc, event), initialState);
};

export const getStateAtTime = (
  initialState: ProjectState,
  events: TimelineEvent[],
  time: number,
): ProjectState => {
  const t = toTimelineTime(time);
  const visibleEvents = sortEvents(events).filter((event) => event.time <= t);
  return applyEvents(initialState, visibleEvents);
};

export const insertEvent = (events: TimelineEvent[], event: TimelineEvent): TimelineEvent[] => {
  const normalized: TimelineEvent = {
    ...event,
    time: toTimelineTime(event.time),
  };

  const list = events.filter((item) => item.id !== normalized.id);
  return sortEvents([...list, normalized]);
};

export const deleteEvent = (events: TimelineEvent[], eventId: string): TimelineEvent[] => {
  return sortEvents(events.filter((event) => event.id !== eventId));
};

export const deleteTimeRange = (events: TimelineEvent[], start: number, end: number): TimelineEvent[] => {
  const range = normalizeTimelineRange(start, end);
  return sortEvents(events.filter((event) => event.time < range.start || event.time > range.end));
};

const shiftEventsFrom = (events: TimelineEvent[], from: number, delta: number): TimelineEvent[] => {
  if (delta === 0) {
    return [...events];
  }

  return events.map((event) => {
    if (event.time < from) {
      return event;
    }

    return retimeEventKeepingRelativeTime(event, shiftTimelineTime(event.time, delta));
  });
};

export const rippleDeleteTimeRange = (
  events: TimelineEvent[],
  start: number,
  end: number,
): TimelineEvent[] => {
  const range = normalizeTimelineRange(start, end);
  // Use [start, end) semantics for ripple delete so boundary events at end
  // can shift to start and preserve adjacent segment boundaries after stitching.
  const kept = events.filter((event) => event.time < range.start || event.time >= range.end);
  const duration = getTimelineDuration(range.start, range.end);

  if (duration <= 0) {
    return sortEvents(kept);
  }

  return sortEvents(shiftEventsFrom(kept, range.end, -duration));
};

export const splitTimeline = (events: TimelineEvent[], time: number): TimelineSplit => {
  const pivot = toTimelineTime(time);
  const sorted = sortEvents(events);

  const left = sorted.filter((event) => event.time <= pivot);
  const right = sorted
    .filter((event) => event.time > pivot)
    .map((event) => retimeEventKeepingRelativeTime(event, shiftTimelineTime(event.time, -pivot)));

  return { left, right };
};

export const moveEvent = (events: TimelineEvent[], eventId: string, newTime: number): TimelineEvent[] => {
  const t = toTimelineTime(newTime);
  return sortEvents(
    events.map((event) => (event.id === eventId ? retimeEventKeepingRelativeTime(event, t) : event)),
  );
};

export const insertTimeGap = (
  events: TimelineEvent[],
  startTime: number,
  duration: number,
  eventIds?: string[],
): TimelineEvent[] => {
  const from = toTimelineTime(startTime);
  const delta = Math.max(0, Math.trunc(duration));
  if (delta <= 0) {
    return sortEvents(events);
  }

  const selectedIds = eventIds ? new Set(eventIds) : null;

  return sortEvents(
    events.map((event) => {
      if (selectedIds && !selectedIds.has(event.id)) {
        return event;
      }

      if (event.time >= from) {
        return retimeEventKeepingRelativeTime(event, shiftTimelineTime(event.time, delta));
      }

      return shiftStrokeCreatePointTimesFrom(event, from, delta);
    }),
  );
};

export const getTimelineMaxTime = (events: TimelineEvent[]): number => {
  if (events.length === 0) {
    return 0;
  }

  return Math.max(...events.map((event) => getEventEndTime(event)));
};

export const normalizeTimelineTime = toTimelineTime;

export const getEventEndTime = (event: TimelineEvent): number => {
  if (event.type === TimelineEventType.STROKE_CREATE) {
    return getStrokeCreateEventEndTime(event);
  }
  return toTimelineTime(event.time);
};
