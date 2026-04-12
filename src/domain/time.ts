export type TimelineTime = number;

export type TimelineRange = {
  start: TimelineTime;
  end: TimelineTime;
};

export const normalizeTimelineTime = (value: number): TimelineTime => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
};

export const compareTimelineTime = (a: number, b: number): number => {
  return normalizeTimelineTime(a) - normalizeTimelineTime(b);
};

export const normalizeTimelineRange = (start: number, end: number): TimelineRange => {
  const a = normalizeTimelineTime(start);
  const b = normalizeTimelineTime(end);
  if (a <= b) {
    return { start: a, end: b };
  }
  return { start: b, end: a };
};

export const getTimelineDuration = (start: number, end: number): TimelineTime => {
  const range = normalizeTimelineRange(start, end);
  return range.end - range.start;
};

export const shiftTimelineTime = (time: number, delta: number): TimelineTime => {
  return normalizeTimelineTime(normalizeTimelineTime(time) + Math.trunc(delta));
};

export const isTimelineTimeWithinInclusive = (
  time: number,
  start: number,
  end: number,
): boolean => {
  const t = normalizeTimelineTime(time);
  const range = normalizeTimelineRange(start, end);
  return t >= range.start && t <= range.end;
};
