import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioSegment,
  TimelineEvent,
  TimelineEventType,
  TimelineSegment,
} from '../../domain/types';
import { normalizeTimelineTime } from '../../domain/time';
import { getEventEndTime } from '../../engine/timelineEngine';

type TimelineTrackProps = {
  events: TimelineEvent[];
  segments: TimelineSegment[];
  audioSegments: AudioSegment[];
  currentTime: number;
  maxTime: number;
  selectedEventId?: string;
  selectedSegmentId?: string;
  canSeek?: boolean;
  onSeek: (time: number) => void;
  onSelectEvent: (eventId: string) => void;
  onSelectSegment: (segmentId: string) => void;
  onOpenContextMenu?: (params: { clientX: number; clientY: number; time: number }) => void;
  snapEnabled?: boolean;
  fps?: number;
};

type ActionBlock = {
  id: string;
  type: TimelineEventType;
  startTime: number;
  endTime: number;
  targetId?: string;
  eventIds: string[];
  label: string;
};

type RulerTick = {
  key: string;
  left: number;
  major: boolean;
  label?: string;
};

type DragPreview = {
  rawTime: number;
  snappedTime: number;
};

type WaveShape = {
  id: string;
  startTime: number;
  endTime: number;
  path: string;
};

const eventColorMap: Record<TimelineEventType, string> = {
  [TimelineEventType.STROKE_CREATE]: '#0a84ff',
  [TimelineEventType.STROKE_ERASE]: '#ff3b30',
  [TimelineEventType.OBJECT_CREATE]: '#34c759',
  [TimelineEventType.OBJECT_UPDATE]: '#ff9f0a',
  [TimelineEventType.OBJECT_DELETE]: '#ff6b35',
  [TimelineEventType.VIEWPORT_SET]: '#5e5ce6',
  [TimelineEventType.PAGE_SET]: '#64d2ff',
};

const eventLabelMap: Record<TimelineEventType, string> = {
  [TimelineEventType.STROKE_CREATE]: 'Stroke',
  [TimelineEventType.STROKE_ERASE]: 'Erase Stroke',
  [TimelineEventType.OBJECT_CREATE]: 'Create Object',
  [TimelineEventType.OBJECT_UPDATE]: 'Edit Object',
  [TimelineEventType.OBJECT_DELETE]: 'Delete Object',
  [TimelineEventType.VIEWPORT_SET]: 'Viewport',
  [TimelineEventType.PAGE_SET]: 'Page',
};

const ACTION_MERGE_GAP_MS = 120;
const TIMELINE_PX_PER_MS = 0.12;
const TIMELINE_MIN_WIDTH_PX = 1200;
const TICK_RENDER_PADDING_PX = 220;
const MIN_MINOR_TICK_GAP_PX = 6;
const STRUCT_SNAP_THRESHOLD_PX = 14;
const WAVE_SVG_WIDTH = 1000;
const WAVE_POINT_MIN = 48;
const WAVE_POINT_MAX = 2400;

const ACTION_EVENT_TYPES = new Set<TimelineEventType>([
  TimelineEventType.STROKE_CREATE,
  TimelineEventType.STROKE_ERASE,
  TimelineEventType.OBJECT_CREATE,
  TimelineEventType.OBJECT_UPDATE,
  TimelineEventType.OBJECT_DELETE,
  TimelineEventType.VIEWPORT_SET,
]);

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const formatRulerLabel = (timeMs: number): string => {
  const seconds = Math.floor(Math.max(0, normalizeTimelineTime(timeMs)) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

const formatTimecodeLabel = (timeMs: number, fps: number): string => {
  const fpsSafe = Math.max(1, Math.round(fps));
  const totalFrames = Math.max(0, Math.round((normalizeTimelineTime(timeMs) * fpsSafe) / 1000));
  const totalSeconds = Math.floor(totalFrames / fpsSafe);
  const frame = totalFrames % fpsSafe;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(frame).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(frame).padStart(2, '0')}`;
};

const buildActionBlocks = (events: TimelineEvent[]): ActionBlock[] => {
  const sorted = [...events]
    .filter((event) => ACTION_EVENT_TYPES.has(event.type))
    .sort((a, b) => a.time - b.time);
  const blocks: ActionBlock[] = [];

  for (let i = 0; i < sorted.length; ) {
    const event = sorted[i];
    if (
      event.type === TimelineEventType.OBJECT_UPDATE
      || event.type === TimelineEventType.VIEWPORT_SET
    ) {
      const eventIds = [event.id];
      const startTime = normalizeTimelineTime(event.time);
      let endTime = startTime;
      const key = `${event.type}:${event.pageId}:${event.targetId ?? ''}`;
      i += 1;

      while (i < sorted.length) {
        const next = sorted[i];
        const nextKey = `${next.type}:${next.pageId}:${next.targetId ?? ''}`;
        const nextTime = normalizeTimelineTime(next.time);
        if (nextKey !== key || nextTime - endTime > ACTION_MERGE_GAP_MS) {
          break;
        }
        eventIds.push(next.id);
        endTime = nextTime;
        i += 1;
      }

      blocks.push({
        id: `act-${eventIds[0]}`,
        type: event.type,
        startTime,
        endTime,
        targetId: event.targetId,
        eventIds,
        label: eventLabelMap[event.type],
      });
      continue;
    }

    const startTime = normalizeTimelineTime(event.time);
    const endTime = normalizeTimelineTime(getEventEndTime(event));
    blocks.push({
      id: `act-${event.id}`,
      type: event.type,
      startTime,
      endTime,
      targetId: event.targetId,
      eventIds: [event.id],
      label: eventLabelMap[event.type],
    });
    i += 1;
  }

  return blocks;
};

const buildWavePath = (
  points: AudioSegment['waveform'],
  startTime: number,
  endTime: number,
  widthPx: number,
): string => {
  if (points.length === 0 || endTime <= startTime) {
    return '';
  }

  const duration = endTime - startTime;
  const targetPoints = Math.max(2, clamp(Math.round(widthPx * 1.4), WAVE_POINT_MIN, WAVE_POINT_MAX));

  const pointsWithPeaks = points.map((point) => ({
    t: normalizeTimelineTime(point.t),
    min: typeof point.minAmp === 'number'
      ? clamp(point.minAmp, -1, 0)
      : -clamp(point.amp, 0, 1),
    max: typeof point.maxAmp === 'number'
      ? clamp(point.maxAmp, 0, 1)
      : clamp(point.amp, 0, 1),
  }));

  const sampled = pointsWithPeaks.length <= targetPoints
    ? pointsWithPeaks
    : (() => {
      const result: Array<{ t: number; min: number; max: number }> = [];
      const chunk = pointsWithPeaks.length / targetPoints;
      for (let i = 0; i < targetPoints; i += 1) {
        const from = Math.floor(i * chunk);
        const to = Math.max(from + 1, Math.min(pointsWithPeaks.length, Math.floor((i + 1) * chunk)));
        let min = 0;
        let max = 0;
        for (let p = from; p < to; p += 1) {
          const point = pointsWithPeaks[p];
          if (point.min < min) {
            min = point.min;
          }
          if (point.max > max) {
            max = point.max;
          }
        }
        const t = startTime + Math.round((i / Math.max(1, targetPoints - 1)) * duration);
        result.push({ t, min, max });
      }
      return result;
    })();

  const top: Array<{ x: number; y: number }> = [];
  const bottom: Array<{ x: number; y: number }> = [];
  for (const point of sampled) {
    const ratio = clamp((point.t - startTime) / duration, 0, 1);
    const x = ratio * WAVE_SVG_WIDTH;
    top.push({ x, y: 50 - (point.max * 48) });
    bottom.push({ x, y: 50 - (point.min * 48) });
  }

  const topPath = top.map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  const bottomPath = [...bottom]
    .reverse()
    .map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');
  const startX = top[0]?.x ?? 0;
  const startY = top[0]?.y ?? 50;
  return `M ${startX.toFixed(2)} ${startY.toFixed(2)} ${topPath} ${bottomPath} Z`;
};

export const TimelineTrack: React.FC<TimelineTrackProps> = ({
  events,
  segments,
  audioSegments,
  currentTime,
  maxTime,
  selectedEventId,
  selectedSegmentId,
  canSeek = true,
  onSeek,
  onSelectEvent,
  onSelectSegment,
  onOpenContextMenu,
  snapEnabled = false,
  fps = 60,
}) => {
  const safeMaxTime = useMemo(() => Math.max(1200, maxTime, currentTime, 1), [maxTime, currentTime]);
  const [viewportWidth, setViewportWidth] = useState(TIMELINE_MIN_WIDTH_PX);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const draggingPlayheadRef = useRef(false);

  const timelineDurationMs = useMemo(
    () => Math.max(safeMaxTime, Math.floor(TIMELINE_MIN_WIDTH_PX / TIMELINE_PX_PER_MS)),
    [safeMaxTime],
  );

  const timelineWidth = useMemo(
    () => Math.max(viewportWidth, TIMELINE_MIN_WIDTH_PX, Math.round(timelineDurationMs * TIMELINE_PX_PER_MS)),
    [timelineDurationMs, viewportWidth],
  );

  const fpsSafe = useMemo(() => Math.max(1, Math.round(fps)), [fps]);
  const frameDurationMs = useMemo(() => 1000 / fpsSafe, [fpsSafe]);
  const actionBlocks = useMemo(() => buildActionBlocks(events), [events]);
  const snapThresholdTime = useMemo(
    () => Math.max(1, Math.round(STRUCT_SNAP_THRESHOLD_PX / TIMELINE_PX_PER_MS)),
    [],
  );

  const timeToPx = useCallback((time: number): number => {
    return Math.max(0, normalizeTimelineTime(time)) * TIMELINE_PX_PER_MS;
  }, []);

  const pxToTime = useCallback((x: number): number => {
    const clamped = Math.max(0, Math.min(timelineWidth, x));
    return normalizeTimelineTime(Math.min(timelineDurationMs, clamped / TIMELINE_PX_PER_MS));
  }, [timelineDurationMs, timelineWidth]);

  const lanePixelStyle = useCallback((start: number, end: number): React.CSSProperties => {
    const left = timeToPx(start);
    const width = Math.max(2, timeToPx(end) - left);
    return {
      left: `${left}px`,
      width: `${width}px`,
    };
  }, [timeToPx]);

  const structuralSnapAnchors = useMemo<number[]>(() => {
    const anchors = new Set<number>();
    for (const block of actionBlocks) {
      anchors.add(normalizeTimelineTime(block.startTime));
      anchors.add(normalizeTimelineTime(block.endTime));
    }
    for (const segment of segments) {
      anchors.add(normalizeTimelineTime(segment.startTime));
      anchors.add(normalizeTimelineTime(segment.endTime));
    }
    for (const segment of audioSegments) {
      anchors.add(normalizeTimelineTime(segment.startTime));
      anchors.add(normalizeTimelineTime(segment.endTime));
    }
    return [...anchors].sort((a, b) => a - b);
  }, [actionBlocks, audioSegments, segments]);

  const snapToStructureEdge = useCallback((time: number): number => {
    const safe = normalizeTimelineTime(time);
    if (!snapEnabled || structuralSnapAnchors.length === 0) {
      return safe;
    }

    let lo = 0;
    let hi = structuralSnapAnchors.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const value = structuralSnapAnchors[mid];
      if (value < safe) {
        lo = mid + 1;
      } else if (value > safe) {
        hi = mid - 1;
      } else {
        return value;
      }
    }

    const left = hi >= 0 ? structuralSnapAnchors[hi] : undefined;
    const right = lo < structuralSnapAnchors.length ? structuralSnapAnchors[lo] : undefined;

    const leftDist = left === undefined ? Number.POSITIVE_INFINITY : Math.abs(safe - left);
    const rightDist = right === undefined ? Number.POSITIVE_INFINITY : Math.abs(right - safe);
    const nearest = leftDist <= rightDist ? left : right;
    if (nearest === undefined) {
      return safe;
    }
    return Math.abs(safe - nearest) <= snapThresholdTime ? nearest : safe;
  }, [snapEnabled, snapThresholdTime, structuralSnapAnchors]);

  const resolveDragPreview = useCallback((surface: HTMLDivElement, clientX: number): DragPreview => {
    const rect = surface.getBoundingClientRect();
    const rawTime = pxToTime(clientX - rect.left);
    return {
      rawTime,
      snappedTime: snapToStructureEdge(rawTime),
    };
  }, [pxToTime, snapToStructureEdge]);

  const seekByClientX = useCallback((surface: HTMLDivElement, clientX: number) => {
    const preview = resolveDragPreview(surface, clientX);
    setDragPreview(preview);
    onSeek(preview.snappedTime);
  }, [onSeek, resolveDragPreview]);

  const resolveTimeByClientX = useCallback((surface: HTMLDivElement, clientX: number): number => {
    return resolveDragPreview(surface, clientX).snappedTime;
  }, [resolveDragPreview]);

  const rulerTicks = useMemo<RulerTick[]>(() => {
    const visibleStartPx = Math.max(0, scrollLeft - TICK_RENDER_PADDING_PX);
    const visibleEndPx = Math.min(
      timelineWidth,
      Math.max(visibleStartPx + 1, scrollLeft + viewportWidth + TICK_RENDER_PADDING_PX),
    );

    const startTime = pxToTime(visibleStartPx);
    const endTime = pxToTime(visibleEndPx);
    if (endTime <= startTime) {
      return [];
    }

    const toFrame = (time: number) => Math.round((Math.max(0, normalizeTimelineTime(time)) * fpsSafe) / 1000);
    const fromFrame = (frame: number) => normalizeTimelineTime((Math.max(0, frame) * 1000) / fpsSafe);

    const framePx = frameDurationMs * TIMELINE_PX_PER_MS;
    const minorFrameStep = Math.max(1, Math.ceil(MIN_MINOR_TICK_GAP_PX / Math.max(0.1, framePx)));
    const startFrame = Math.max(0, Math.floor(toFrame(startTime) / minorFrameStep) * minorFrameStep);
    const endFrame = Math.max(startFrame, Math.ceil(toFrame(endTime)));

    const ticks: RulerTick[] = [];
    let lastTime = -1;
    for (let frame = startFrame; frame <= endFrame; frame += minorFrameStep) {
      const time = fromFrame(frame);
      if (time > timelineDurationMs || time === lastTime) {
        continue;
      }

      lastTime = time;
      const major = frame % fpsSafe === 0;
      ticks.push({
        key: `tick-${frame}`,
        left: timeToPx(time),
        major,
        label: major ? formatRulerLabel(time) : undefined,
      });
    }

    if (ticks.length === 0) {
      ticks.push({
        key: 'tick-0',
        left: 0,
        major: true,
        label: formatRulerLabel(0),
      });
    }

    return ticks;
  }, [
    fpsSafe,
    frameDurationMs,
    pxToTime,
    scrollLeft,
    timelineDurationMs,
    timelineWidth,
    timeToPx,
    viewportWidth,
  ]);

  const waveShapes = useMemo<WaveShape[]>(() => {
    return audioSegments.map((segment) => {
      const startTime = normalizeTimelineTime(segment.startTime);
      const endTime = normalizeTimelineTime(segment.endTime);
      const widthPx = Math.max(2, timeToPx(endTime) - timeToPx(startTime));
      return {
        id: segment.id,
        startTime,
        endTime,
        path: buildWavePath(segment.waveform, startTime, endTime, widthPx),
      };
    });
  }, [audioSegments, timeToPx]);

  const actionLayer = useMemo(() => {
    return actionBlocks.map((block) => {
      const selected = block.eventIds.includes(selectedEventId ?? '');
      return (
        <button
          key={block.id}
          type="button"
          className={`action-block ${selected ? 'selected' : ''}`}
          style={{
            ...lanePixelStyle(block.startTime, block.endTime),
            borderColor: eventColorMap[block.type],
            background: `${eventColorMap[block.type]}22`,
          }}
          onClick={(event) => {
            event.stopPropagation();
            onSelectEvent(block.eventIds[0]);
            if (canSeek) {
              onSeek(snapToStructureEdge(block.startTime));
            }
          }}
          onContextMenu={(event) => {
            if (!onOpenContextMenu) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            onOpenContextMenu({
              clientX: event.clientX,
              clientY: event.clientY,
              time: snapToStructureEdge(block.startTime),
            });
          }}
          title={`${block.label} ${block.startTime}ms - ${block.endTime}ms`}
        >
          <span className="mono">{block.label}</span>
        </button>
      );
    });
  }, [actionBlocks, canSeek, lanePixelStyle, onOpenContextMenu, onSeek, onSelectEvent, selectedEventId, snapToStructureEdge]);

  const segmentLayer = useMemo(() => {
    return segments.map((segment) => (
      <button
        key={segment.id}
        type="button"
        className={`timeline-segment ${segment.id === selectedSegmentId ? 'selected' : ''}`}
        style={lanePixelStyle(segment.startTime, segment.endTime)}
        onClick={(event) => {
          event.stopPropagation();
          onSelectSegment(segment.id);
          if (canSeek) {
            onSeek(snapToStructureEdge(segment.startTime));
          }
        }}
        onContextMenu={(event) => {
          if (!onOpenContextMenu) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          onOpenContextMenu({
            clientX: event.clientX,
            clientY: event.clientY,
            time: snapToStructureEdge(segment.startTime),
          });
        }}
        title={`${segment.pageId} ${segment.startTime}ms - ${segment.endTime}ms`}
      >
        <div className="segment-thumb" />
        <span className="mono">{segment.pageId.slice(0, 8)}</span>
      </button>
    ));
  }, [canSeek, lanePixelStyle, onOpenContextMenu, onSeek, onSelectSegment, segments, selectedSegmentId, snapToStructureEdge]);

  const waveLayer = useMemo(() => {
    return waveShapes.map((shape) => (
      <div
        key={shape.id}
        className="audio-segment audio-overlay"
        style={lanePixelStyle(shape.startTime, shape.endTime)}
        title={`audio ${shape.startTime}ms - ${shape.endTime}ms`}
      >
        <svg className="wave-svg" viewBox={`0 0 ${WAVE_SVG_WIDTH} 100`} preserveAspectRatio="none">
          <path className="wave-fill" d={shape.path} />
        </svg>
      </div>
    ));
  }, [lanePixelStyle, waveShapes]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) {
      return;
    }

    const updateWidth = () => {
      setViewportWidth(Math.max(1, Math.floor(scroll.clientWidth)));
    };
    updateWidth();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => updateWidth());
      observer.observe(scroll);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) {
      return;
    }

    const onScroll = () => setScrollLeft(scroll.scrollLeft);
    onScroll();
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => scroll.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || draggingPlayheadRef.current) {
      return;
    }

    const cursorX = timeToPx(currentTime);
    const viewStart = scroll.scrollLeft;
    const viewEnd = viewStart + scroll.clientWidth;
    const margin = 72;
    if (cursorX < viewStart + margin || cursorX > viewEnd - margin) {
      const target = Math.max(0, cursorX - (scroll.clientWidth * 0.36));
      scroll.scrollLeft = target;
    }
  }, [currentTime, timeToPx]);

  const displayTime = dragPreview?.snappedTime ?? currentTime;
  const showSnapGuide = Boolean(
    dragPreview
    && snapEnabled
    && Math.abs(timeToPx(dragPreview.rawTime) - timeToPx(dragPreview.snappedTime)) >= 1,
  );
  const timeBubble = formatTimecodeLabel(displayTime, fpsSafe);

  return (
    <div className="panel timeline-track">
      <div className="track-scroll" ref={scrollRef}>
        <div
          className="track-surface"
          style={{ width: `${timelineWidth}px` }}
          onPointerDown={(event) => {
            if (!canSeek) {
              return;
            }
            draggingPlayheadRef.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            seekByClientX(event.currentTarget, event.clientX);
          }}
          onPointerMove={(event) => {
            if (!canSeek || !draggingPlayheadRef.current) {
              return;
            }
            seekByClientX(event.currentTarget, event.clientX);
          }}
          onPointerUp={(event) => {
            if (!draggingPlayheadRef.current) {
              return;
            }
            draggingPlayheadRef.current = false;
            setDragPreview(null);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={(event) => {
            if (!draggingPlayheadRef.current) {
              return;
            }
            draggingPlayheadRef.current = false;
            setDragPreview(null);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerLeave={(event) => {
            if (!draggingPlayheadRef.current) {
              return;
            }
            draggingPlayheadRef.current = false;
            setDragPreview(null);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onContextMenu={(event) => {
            if (!onOpenContextMenu) {
              return;
            }
            event.preventDefault();
            onOpenContextMenu({
              clientX: event.clientX,
              clientY: event.clientY,
              time: resolveTimeByClientX(event.currentTarget, event.clientX),
            });
          }}
        >
          <div className="track-ruler">
            {rulerTicks.map((tick) => (
              <div
                key={`ruler-${tick.key}`}
                className={`ruler-tick ${tick.major ? 'major' : 'minor'}`}
                style={{ left: `${tick.left}px` }}
              >
                {tick.label ? <span className="mono">{tick.label}</span> : null}
              </div>
            ))}
          </div>

          <div className="track-grid-layer">
            {rulerTicks.map((tick) => (
              <span
                key={`grid-${tick.key}`}
                className={`track-grid-line ${tick.major ? 'major' : 'minor'}`}
                style={{ left: `${tick.left}px` }}
              />
            ))}
          </div>

          <div className="track-lane-label mono actions">Actions</div>
          <div className="track-action-lane">{actionLayer}</div>

          <div className="track-lane-label mono timeline">Timeline</div>
          <div className="track-combined-lane">
            <div className="track-thumbs-layer">{segmentLayer}</div>
            <div className="track-wave-layer">{waveLayer}</div>
          </div>

          {dragPreview ? (
            <div
              className="track-pointer-guide"
              style={{ left: `${timeToPx(dragPreview.rawTime)}px` }}
            />
          ) : null}
          {dragPreview && showSnapGuide ? (
            <div
              className="track-snap-guide"
              style={{ left: `${timeToPx(dragPreview.snappedTime)}px` }}
            />
          ) : null}

          <div className={`track-cursor ${dragPreview ? 'dragging' : ''}`} style={{ left: `${timeToPx(displayTime)}px` }}>
            {dragPreview ? <div className="track-time-bubble mono">{timeBubble}</div> : null}
            <button
              type="button"
              className="cursor-handle"
              title="Drag Playhead"
              aria-label="Drag Playhead"
              onPointerDown={(event) => {
                event.stopPropagation();
                if (!canSeek) {
                  return;
                }
                const surface = event.currentTarget.closest('.track-surface') as HTMLDivElement | null;
                if (!surface) {
                  return;
                }
                draggingPlayheadRef.current = true;
                surface.setPointerCapture(event.pointerId);
                seekByClientX(surface, event.clientX);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
