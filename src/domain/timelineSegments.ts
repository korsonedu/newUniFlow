import {
  AudioSegment,
  PageSetPayload,
  TimelineEvent,
  TimelineEventType,
  TimelineSegment,
  WaveformPoint,
} from './types';
import {
  getTimelineDuration,
  normalizeTimelineRange,
  normalizeTimelineTime,
  shiftTimelineTime,
} from './time';

const getPageIdFromPageSet = (event: TimelineEvent, fallbackPageId: string): string => {
  const payload = (event.payload ?? {}) as Partial<PageSetPayload>;
  return event.targetId ?? payload.pageId ?? event.pageId ?? fallbackPageId;
};

const uniqueSortedTimes = (times: number[]): number[] => {
  const set = new Set(times.map((value) => normalizeTimelineTime(value)));
  return [...set].sort((a, b) => a - b);
};

const cloneWaveform = (points: WaveformPoint[]): WaveformPoint[] => {
  return points.map((point) => ({
    t: normalizeTimelineTime(point.t),
    amp: Math.max(0, Math.min(1, point.amp)),
    minAmp:
      typeof point.minAmp === 'number'
        ? Math.max(-1, Math.min(1, point.minAmp))
        : undefined,
    maxAmp:
      typeof point.maxAmp === 'number'
        ? Math.max(-1, Math.min(1, point.maxAmp))
        : undefined,
  }));
};

const getSourceOffset = (segment: AudioSegment): number => {
  return normalizeTimelineTime(segment.sourceOffsetMs ?? 0);
};

const getTimelineDurationMs = (segment: AudioSegment): number => {
  return Math.max(1, normalizeTimelineTime(segment.endTime) - normalizeTimelineTime(segment.startTime));
};

const getSourceDuration = (segment: AudioSegment): number => {
  const fallback = getTimelineDurationMs(segment);
  return Math.max(1, normalizeTimelineTime(segment.sourceDurationMs ?? fallback));
};

const clampTimelineDeltaToSource = (segment: AudioSegment, timelineDeltaMs: number): number => {
  const safeTimeline = Math.max(0, normalizeTimelineTime(timelineDeltaMs));
  return Math.min(getSourceDuration(segment), safeTimeline);
};

export const deriveTimelineSegments = (
  projectId: string,
  initialPageId: string,
  events: TimelineEvent[],
  maxTime: number,
): TimelineSegment[] => {
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const pageEvents = sorted.filter((event) => event.type === TimelineEventType.PAGE_SET);

  const end = Math.max(1, normalizeTimelineTime(maxTime));
  const boundaries = uniqueSortedTimes([0, end, ...pageEvents.map((event) => event.time)]);
  if (boundaries.length < 2) {
    boundaries.push(end);
  }

  let activePage = initialPageId;
  let pageCursor = 0;
  const segments: TimelineSegment[] = [];

  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const startTime = boundaries[i];
    const endTime = boundaries[i + 1];
    if (endTime <= startTime) {
      continue;
    }

    while (pageCursor < pageEvents.length && normalizeTimelineTime(pageEvents[pageCursor].time) <= startTime) {
      activePage = getPageIdFromPageSet(pageEvents[pageCursor], activePage);
      pageCursor += 1;
    }

    const actionIds = sorted
      .filter((event) => {
        const t = normalizeTimelineTime(event.time);
        return t >= startTime && t < endTime && event.pageId === activePage;
      })
      .map((event) => event.id);

    segments.push({
      id: `seg-${startTime}-${endTime}-${activePage}-${i}`,
      projectId,
      pageId: activePage,
      startTime,
      endTime,
      actionIds,
    });
  }

  return segments;
};

export const canSplitSegmentAt = (segment: TimelineSegment, time: number): boolean => {
  const t = normalizeTimelineTime(time);
  return t > normalizeTimelineTime(segment.startTime) && t < normalizeTimelineTime(segment.endTime);
};

export const splitTimelineSegment = (
  segments: TimelineSegment[],
  segmentId: string,
  splitTime: number,
): TimelineSegment[] | null => {
  const target = segments.find((item) => item.id === segmentId);
  if (!target || !canSplitSegmentAt(target, splitTime)) {
    return null;
  }

  const pivot = normalizeTimelineTime(splitTime);
  return segments.flatMap((segment) => {
    if (segment.id !== segmentId) {
      return [segment];
    }
    return [
      {
        ...segment,
        id: `${segment.id}-L`,
        endTime: pivot,
      },
      {
        ...segment,
        id: `${segment.id}-R`,
        startTime: pivot,
      },
    ];
  });
};

export const deleteRangeFromTimelineSegments = (
  segments: TimelineSegment[],
  start: number,
  end: number,
): TimelineSegment[] => {
  const range = normalizeTimelineRange(start, end);
  const next: TimelineSegment[] = [];

  for (const segment of segments) {
    const s = normalizeTimelineTime(segment.startTime);
    const e = normalizeTimelineTime(segment.endTime);

    if (e <= range.start || s >= range.end) {
      next.push(segment);
      continue;
    }

    if (s < range.start) {
      next.push({
        ...segment,
        id: `${segment.id}-head`,
        startTime: s,
        endTime: range.start,
      });
    }

    if (e > range.end) {
      next.push({
        ...segment,
        id: `${segment.id}-tail`,
        startTime: range.end,
        endTime: e,
      });
    }
  }

  return next
    .filter((segment) => segment.endTime > segment.startTime)
    .sort((a, b) => a.startTime - b.startTime);
};

export const rippleDeleteTimelineSegments = (
  segments: TimelineSegment[],
  start: number,
  end: number,
): TimelineSegment[] => {
  const range = normalizeTimelineRange(start, end);
  const duration = getTimelineDuration(range.start, range.end);
  if (duration <= 0) {
    return segments;
  }

  const deleted = deleteRangeFromTimelineSegments(segments, range.start, range.end);

  return deleted
    .map((segment) => {
      if (segment.startTime >= range.end) {
        return {
          ...segment,
          startTime: shiftTimelineTime(segment.startTime, -duration),
          endTime: shiftTimelineTime(segment.endTime, -duration),
        };
      }
      return segment;
    })
    .sort((a, b) => a.startTime - b.startTime);
};

const trimWaveformByRange = (
  waveform: WaveformPoint[],
  rangeStart: number,
  rangeEnd: number,
): WaveformPoint[] => {
  return cloneWaveform(waveform).filter((point) => point.t < rangeStart || point.t > rangeEnd);
};

export const deleteRangeFromAudioSegments = (
  segments: AudioSegment[],
  start: number,
  end: number,
): AudioSegment[] => {
  const range = normalizeTimelineRange(start, end);

  return segments
    .flatMap((segment) => {
      const s = normalizeTimelineTime(segment.startTime);
      const e = normalizeTimelineTime(segment.endTime);

      if (e <= range.start || s >= range.end) {
        return [segment];
      }

      const baseWaveform = trimWaveformByRange(segment.waveform, range.start, range.end);
      const next: AudioSegment[] = [];

      if (s < range.start) {
        const headTimelineDuration = Math.max(0, range.start - s);
        next.push({
          ...segment,
          id: `${segment.id}-head`,
          startTime: s,
          endTime: range.start,
          waveform: baseWaveform.filter((point) => point.t < range.start),
          sourceOffsetMs: getSourceOffset(segment),
          sourceDurationMs: clampTimelineDeltaToSource(segment, headTimelineDuration),
        });
      }

      if (e > range.end) {
        const cutFromSegmentStart = Math.max(0, range.end - s);
        const tailTimelineDuration = Math.max(0, e - range.end);
        const consumedSource = clampTimelineDeltaToSource(segment, cutFromSegmentStart);
        const sourceRemainder = Math.max(1, getSourceDuration(segment) - consumedSource);
        next.push({
          ...segment,
          id: `${segment.id}-tail`,
          startTime: range.end,
          endTime: e,
          waveform: baseWaveform.filter((point) => point.t > range.end),
          sourceOffsetMs: shiftTimelineTime(getSourceOffset(segment), consumedSource),
          sourceDurationMs: Math.min(sourceRemainder, clampTimelineDeltaToSource(segment, tailTimelineDuration)),
        });
      }

      return next;
    })
    .filter((segment) => segment.endTime > segment.startTime)
    .sort((a, b) => a.startTime - b.startTime);
};

export const rippleDeleteAudioSegments = (
  segments: AudioSegment[],
  start: number,
  end: number,
): AudioSegment[] => {
  const range = normalizeTimelineRange(start, end);
  const duration = getTimelineDuration(range.start, range.end);
  if (duration <= 0) {
    return segments;
  }

  return deleteRangeFromAudioSegments(segments, range.start, range.end).map((segment) => {
    const shouldShift = segment.startTime >= range.end;
    if (!shouldShift) {
      return segment;
    }

    return {
      ...segment,
      startTime: shiftTimelineTime(segment.startTime, -duration),
      endTime: shiftTimelineTime(segment.endTime, -duration),
      waveform: segment.waveform.map((point) => ({
        ...point,
        t: shiftTimelineTime(point.t, -duration),
      })),
    };
  });
};

export const insertGapIntoAudioSegments = (
  segments: AudioSegment[],
  startTime: number,
  duration: number,
  audioIds?: string[],
): AudioSegment[] => {
  const from = normalizeTimelineTime(startTime);
  const delta = Math.max(0, Math.trunc(duration));
  if (delta <= 0) {
    return segments;
  }

  const selectedIds = audioIds ? new Set(audioIds) : null;
  const next: AudioSegment[] = [];

  for (const segment of segments) {
    if (selectedIds && !selectedIds.has(segment.id)) {
      next.push(segment);
      continue;
    }

    const s = normalizeTimelineTime(segment.startTime);
    const e = normalizeTimelineTime(segment.endTime);

    if (e <= from) {
      next.push(segment);
      continue;
    }

    if (s >= from) {
      next.push({
        ...segment,
        startTime: shiftTimelineTime(s, delta),
        endTime: shiftTimelineTime(e, delta),
        waveform: segment.waveform.map((point) => ({
          ...point,
          t: shiftTimelineTime(point.t, delta),
        })),
        sourceOffsetMs: getSourceOffset(segment),
        sourceDurationMs: getSourceDuration(segment),
      });
      continue;
    }

    const headTimelineDuration = Math.max(0, from - s);
    const tailTimelineDuration = Math.max(0, e - from);
    const headSourceDuration = clampTimelineDeltaToSource(segment, headTimelineDuration);
    const tailSourceOffset = shiftTimelineTime(getSourceOffset(segment), headSourceDuration);
    const tailSourceDuration = Math.max(1, getSourceDuration(segment) - headSourceDuration);
    const headWave = cloneWaveform(segment.waveform).filter((point) => point.t < from);
    const tailWave = cloneWaveform(segment.waveform)
      .filter((point) => point.t >= from)
      .map((point) => ({
        ...point,
        t: shiftTimelineTime(point.t, delta),
      }));

    next.push({
      ...segment,
      id: `${segment.id}-head-${from}`,
      startTime: s,
      endTime: from,
      waveform: headWave,
      sourceOffsetMs: getSourceOffset(segment),
      sourceDurationMs: headSourceDuration,
    });
    next.push({
      ...segment,
      id: segment.id,
      startTime: shiftTimelineTime(from, delta),
      endTime: shiftTimelineTime(e, delta),
      waveform: tailWave,
      sourceOffsetMs: tailSourceOffset,
      sourceDurationMs: Math.min(tailSourceDuration, clampTimelineDeltaToSource(segment, tailTimelineDuration)),
    });
  }

  return next
    .filter((segment) => segment.endTime > segment.startTime)
    .sort((a, b) => a.startTime - b.startTime);
};

export const createMockWaveform = (startTime: number, endTime: number): WaveformPoint[] => {
  const s = normalizeTimelineTime(startTime);
  const e = normalizeTimelineTime(endTime);
  const duration = Math.max(1, e - s);
  const points: WaveformPoint[] = [];
  const step = Math.max(16, Math.floor(duration / 80));

  for (let t = s; t <= e; t += step) {
    const x = (t - s) / duration;
    const amp = 0.12 + 0.62 * Math.abs(Math.sin(x * 18.4) * Math.cos(x * 5.7));
    points.push({ t, amp, minAmp: -amp, maxAmp: amp });
  }

  return points;
};
