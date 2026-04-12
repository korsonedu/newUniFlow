import { PageState, Point, ProjectState, Stroke, WhiteboardObject } from './types';
import { normalizeTimelineTime } from './time';

const sortedStrokeCache = new WeakMap<PageState, Stroke[]>();
const sortedObjectCache = new WeakMap<PageState, WhiteboardObject[]>();

const getSortedStrokes = (page: PageState): Stroke[] => {
  const cached = sortedStrokeCache.get(page);
  if (cached) {
    return cached;
  }

  const sorted = Object.values(page.strokes).sort((a, b) => a.createdAt - b.createdAt);
  sortedStrokeCache.set(page, sorted);
  return sorted;
};

const getSortedObjects = (page: PageState): WhiteboardObject[] => {
  const cached = sortedObjectCache.get(page);
  if (cached) {
    return cached;
  }

  const sorted = Object.values(page.objects).sort((a, b) => a.createdAt - b.createdAt);
  sortedObjectCache.set(page, sorted);
  return sorted;
};

export const getCurrentPage = (state: ProjectState): PageState | undefined => {
  return state.pages[state.currentPageId];
};

export const isVisibleInTimeline = (createdAt: number, deletedAt: number | undefined, time: number): boolean => {
  const created = normalizeTimelineTime(createdAt);
  const t = normalizeTimelineTime(time);
  const deleted = deletedAt === undefined ? undefined : normalizeTimelineTime(deletedAt);
  return created <= t && (deleted === undefined || deleted > t);
};

export const getVisibleStrokes = (state: ProjectState, time: number): Stroke[] => {
  const page = getCurrentPage(state);
  if (!page) {
    return [];
  }

  return getSortedStrokes(page).filter((stroke) => (
    isVisibleInTimeline(stroke.createdAt, stroke.deletedAt, time)
  ));
};

export const getVisibleObjects = (state: ProjectState, time: number): WhiteboardObject[] => {
  const page = getCurrentPage(state);
  if (!page) {
    return [];
  }

  return getSortedObjects(page).filter((object) => (
    isVisibleInTimeline(object.createdAt, object.deletedAt, time)
  ));
};

export const getStrokePointsAtTime = (stroke: Stroke, time: number): Point[] => {
  if (stroke.points.length === 0) {
    return [];
  }

  const t = normalizeTimelineTime(time);
  const pointTimes = stroke.pointTimes;

  if (!pointTimes || pointTimes.length !== stroke.points.length) {
    return stroke.points;
  }

  let lo = 0;
  let hi = pointTimes.length - 1;
  let lastVisible = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const pointTime = normalizeTimelineTime(pointTimes[mid]);
    if (pointTime <= t) {
      lastVisible = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const visibleCount = lastVisible + 1;

  if (visibleCount <= 0) {
    return [];
  }

  return stroke.points.slice(0, visibleCount);
};

export const findNearestPoint = (target: Point, points: Point[]): Point | undefined => {
  if (points.length === 0) {
    return undefined;
  }

  let nearest = points[0];
  let bestDist = Number.POSITIVE_INFINITY;

  for (const p of points) {
    const dx = p.x - target.x;
    const dy = p.y - target.y;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      nearest = p;
    }
  }

  return nearest;
};
