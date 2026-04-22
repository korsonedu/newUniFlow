import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  IoAddOutline,
  IoArrowDownOutline,
  IoArrowRedoOutline,
  IoArrowUpOutline,
  IoArrowUndoOutline,
  IoChevronDownOutline,
  IoChevronBackOutline,
  IoChevronForwardOutline,
  IoChevronUpOutline,
  IoCopyOutline,
  IoImagesOutline,
  IoRemoveOutline,
  IoScanOutline,
  IoTrashOutline,
} from 'react-icons/io5';
import { Point } from '../../domain/types';
import {
  getStrokePointsAtTime,
  getVisibleObjects,
  getVisibleStrokes,
} from '../../domain/selectors';
import { useWhiteboardStore } from '../../store/useWhiteboardStore';
import { getRectCenter, hitRectObject, hitStroke, rotatePoint } from '../../utils/geometry';
import { useWhiteboardUseCases } from '../../domain/useCases';
import { normalizeTimelineTime } from '../../domain/time';
import { loadAssetObjectUrl } from '../../utils/assetStore';
import {
  INITIAL_TOOL_STATE,
  ToolId,
  transitionToolState,
} from '../../application/tools/toolStateMachine';
import {
  colorWithOpacity,
  DEFAULT_TOOL_PARAMETERS,
  patchToolParameters,
} from '../../application/tools/toolParameters';
import {
  buildPerfectStrokePath,
  PERFECT_STROKE_ENGINE_VERSION,
} from '../../application/drawing/perfectStroke';
import {
  clampObjectPositionToBoard,
  clampRectToBoard,
  clampViewportToBoard,
  getRectResizeHandles,
  getSelectionBounds,
  mapRectToResizedBounds,
  projectPanViewportFromScreenDelta,
  projectScreenPointToWorldInResolvedViewportRect,
  pruneObjectSelection,
  RectResizeHandle,
  resolveWhiteboardViewportRect,
  resizeRectFromHandle,
  shouldHandleCanvasDeleteKey,
  toggleObjectSelection,
} from '../../application/drawing/whiteboardInteraction';
import { ToolWorkbench } from './ToolWorkbench';
import { recordingTimelineRuntime } from '../../application/clock/recordingTimelineRuntime';
import {
  platformClearTimeout,
  platformSetTimeout,
  PlatformTimerHandle,
} from '../../infrastructure/platform/timer';
import {
  cancelPlatformFrame,
  platformNowMs,
  requestPlatformFrame,
} from '../../infrastructure/platform/frameScheduler';
import { revokeObjectUrl } from '../../infrastructure/platform/domFactory';
import {
  combineWindowEventDisposers,
  subscribeWindowKeyDown,
} from '../../infrastructure/platform/windowEvents';

type DraftStrokeSession = {
  samples: StrokeInputSample[];
  renderPoints: Point[];
  renderPointTimes: number[];
  renderPointPressures?: number[];
  strokeKind: 'pen' | 'highlight';
  startedWallClock: number;
  baseTime: number;
  worldWidth: number;
  strokeColor: string;
};

type CommittingStrokePreview = {
  id: string;
  path: string;
  color: string;
  createdWallClock: number;
};

type RenderedStrokePath = {
  id: string;
  d: string;
  color: string;
};

type StrokeInputSample = {
  point: Point;
  time: number;
  pressure?: number;
};

type StrokePathCacheEntry = {
  pointsRef: Point[];
  pointTimesRef?: number[];
  pointPressuresRef?: number[];
  kindRef?: 'pen' | 'highlight';
  engineVersion: string;
  width: number;
  fullPath: string;
  partialPath: string;
  partialCount: number;
  partialTime: number;
};

type DraftRectSession = {
  objectId: string;
  start: Point;
  current: Point;
  startedWallClock: number;
  baseTime: number;
  lastDispatchTime: number;
};

type DragSession = {
  objects: Array<{
    objectId: string;
    objectOrigin: Point;
    objectSize: { width: number; height: number };
  }>;
  pointerStart: Point;
  pointerCurrent: Point;
  startedWallClock: number;
  baseTime: number;
  lastDispatchTime: number;
};

type ResizeSession = {
  handle: RectResizeHandle;
  originBounds: { x: number; y: number; width: number; height: number };
  objects: Array<{
    objectId: string;
    originRect: { x: number; y: number; width: number; height: number };
  }>;
  current: Point;
  startedWallClock: number;
  baseTime: number;
  lastDispatchTime: number;
};

type PanSession = {
  pointerStart: Point;
  pointerStartScreen: ScreenPoint;
  viewportOrigin: { x: number; y: number; zoom: number };
  startedWallClock: number;
  baseTime: number;
  lastDispatchTime: number;
};

type EraseSession = {
  startedWallClock: number;
  baseTime: number;
  strokeHitAt: Map<string, number>;
  objectHitAt: Map<string, number>;
};

type ScreenPoint = {
  x: number;
  y: number;
};

type ViewportValue = {
  x: number;
  y: number;
  zoom: number;
};

type TwoFingerGestureSession = {
  startedWallClock: number;
  baseTime: number;
  lastDispatchTime: number;
  initialDistance: number;
  initialCenterScreen: ScreenPoint;
  initialCenterWorld: Point;
  viewportOrigin: ViewportValue;
  latestViewport: ViewportValue;
};

type WheelGestureSession = {
  startedWallClock: number;
  baseTime: number;
  lastDispatchTime: number;
};

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 680;
const INPUT_FRAME_INTERVAL_MS = 16;
const WHEEL_IDLE_COMMIT_DELAY_MS = 80;
const SNAP_GRID_STEP = 8;
const RESIZE_HANDLE_UI_SIZE = 12;
const MIN_OBJECT_SIZE = 12;
const COMMITTING_STROKE_PREVIEW_TTL_MS = 2_200;
const COMMITTING_STROKE_PREVIEW_MAX = 24;
const COMMITTING_STROKE_CLEANUP_INTERVAL_MS = 280;
const RECORDING_RENDER_TIME_BUCKET_MS = 160;

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const quantize = (value: number, step: number): number => {
  if (!Number.isFinite(value) || step <= 0) {
    return value;
  }
  return Math.round(value / step) * step;
};

const normalizePressure = (value?: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0.5;
  }
  return clamp(value, 0, 1);
};

const appendInputStrokeSample = (
  samples: StrokeInputSample[],
  sample: StrokeInputSample,
): StrokeInputSample[] => {
  if (samples.length === 0) {
    return [{
      point: sample.point,
      time: sample.time,
      pressure: normalizePressure(sample.pressure),
    }];
  }
  const last = samples[samples.length - 1];
  if (
    Math.abs(last.point.x - sample.point.x) <= 0.000001
    && Math.abs(last.point.y - sample.point.y) <= 0.000001
    && Math.abs(last.time - sample.time) <= 0.0001
    && Math.abs(normalizePressure(last.pressure) - normalizePressure(sample.pressure)) <= 0.0001
  ) {
    return samples;
  }
  return [
    ...samples,
    {
      point: sample.point,
      time: Math.max(last.time, sample.time),
      pressure: normalizePressure(sample.pressure),
    },
  ];
};

const mapInputStrokeSamples = (
  samples: StrokeInputSample[],
): { points: Point[]; pointTimes: number[]; pointPressures?: number[] } => {
  if (samples.length === 0) {
    return { points: [], pointTimes: [] };
  }

  const points: Point[] = [];
  const pointTimes: number[] = [];
  const pointPressures: number[] = [];
  for (const sample of samples) {
    points.push(sample.point);
    pointTimes.push(sample.time);
    pointPressures.push(normalizePressure(sample.pressure));
  }

  return {
    points,
    pointTimes,
    pointPressures,
  };
};

export const WhiteboardCanvas: React.FC = () => {
  const projectState = useWhiteboardStore((s) => s.state);
  const projectPagesMeta = useWhiteboardStore((s) => s.project.pages);
  const passiveCurrentTime = useWhiteboardStore(
    (s) => (
      s.recordingStatus === 'recording'
        ? Math.floor(normalizeTimelineTime(s.currentTime) / RECORDING_RENDER_TIME_BUCKET_MS) * RECORDING_RENDER_TIME_BUCKET_MS
        : normalizeTimelineTime(s.currentTime)
    ),
  );
  const deferredCurrentTime = useDeferredValue(passiveCurrentTime);
  const recordingStatus = useWhiteboardStore((s) => s.recordingStatus);
  const undo = useWhiteboardStore((s) => s.undo);
  const redo = useWhiteboardStore((s) => s.redo);
  const setRuntimeCurrentTime = useWhiteboardStore((s) => s.setRuntimeCurrentTime);

  const {
    createStroke,
    eraseStroke,
    createRect,
    updateObjectTransform,
    updateObjectStyle,
    deleteObject,
    deleteObjects,
    setViewport,
    switchPage,
  } = useWhiteboardUseCases();

  const [toolState, setToolState] = useState(INITIAL_TOOL_STATE);
  const [toolParameters, setToolParameters] = useState(DEFAULT_TOOL_PARAMETERS);
  const [draftStroke, setDraftStroke] = useState<DraftStrokeSession | null>(null);
  const [committingStrokePreviews, setCommittingStrokePreviews] = useState<CommittingStrokePreview[]>([]);
  const [draftRect, setDraftRect] = useState<DraftRectSession | null>(null);
  const [dragSession, setDragSession] = useState<DragSession | null>(null);
  const [resizeSession, setResizeSession] = useState<ResizeSession | null>(null);
  const [panSession, setPanSession] = useState<PanSession | null>(null);
  const [erasing, setErasing] = useState(false);
  const [viewportPreview, setViewportPreview] = useState<ViewportValue | null>(null);
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([]);
  const [pageBackgroundUrl, setPageBackgroundUrl] = useState<string | null>(null);
  const [pagePreviewOpen, setPagePreviewOpen] = useState(false);
  const [pagePreviewUrls, setPagePreviewUrls] = useState<Record<string, string>>({});
  const [hoverPoint, setHoverPoint] = useState<Point | null>(null);
  const [interactionRenderTime, setInteractionRenderTime] = useState<number | null>(null);

  const eraseSessionRef = useRef<EraseSession | null>(null);
  const twoFingerGestureRef = useRef<TwoFingerGestureSession | null>(null);
  const wheelGestureRef = useRef<WheelGestureSession | null>(null);
  const wheelViewportRef = useRef<ViewportValue | null>(null);
  const wheelCommitTimerRef = useRef<PlatformTimerHandle | null>(null);
  const strokeFrameRef = useRef<number | null>(null);
  const pendingStrokeSamplesRef = useRef<StrokeInputSample[]>([]);
  const draftStrokeRef = useRef<DraftStrokeSession | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const pointerRawEnabledRef = useRef(false);
  const visibleStrokeIdsRef = useRef<Set<string>>(new Set());
  const renderedStrokeIdsRef = useRef<Set<string>>(new Set());
  const strokePathCacheRef = useRef<Map<string, StrokePathCacheEntry>>(new Map());
  const svgRef = useRef<SVGSVGElement | null>(null);
  const activePointerToolRef = useRef<ToolId | null>(null);
  const lastPointerWorldRef = useRef<Point | null>(null);
  const tool = toolState.tool;
  const interactionBusy = !!(draftStroke || draftRect || dragSession || resizeSession || panSession || erasing);
  const renderTime = interactionRenderTime ?? (interactionBusy ? deferredCurrentTime : passiveCurrentTime);

  const resolveVisibleStrokePointCount = (pointTimes: number[], time: number): number => {
    const normalizedTime = normalizeTimelineTime(time);
    let lo = 0;
    let hi = pointTimes.length - 1;
    let lastVisible = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const pointTime = pointTimes[mid];
      if (pointTime <= normalizedTime) {
        lastVisible = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return lastVisible + 1;
  };

  const resolveStrokePathAtTime = (
    stroke: {
      id: string;
      points: Point[];
      pointTimes?: number[];
      pointPressures?: number[];
      kind?: 'pen' | 'highlight';
      width: number;
    },
    time: number,
  ): string => {
    const pointTimes = stroke.pointTimes;
    const pointPressures = stroke.pointPressures;
    const strokeKind = stroke.kind ?? 'auto';
    const width = stroke.width;
    const hasPointTimes = !!pointTimes && pointTimes.length === stroke.points.length;
    const cache = strokePathCacheRef.current;
    const cached = cache.get(stroke.id);
    const entry = cached
      && cached.pointsRef === stroke.points
      && cached.pointTimesRef === pointTimes
      && cached.pointPressuresRef === pointPressures
      && cached.kindRef === stroke.kind
      && cached.engineVersion === PERFECT_STROKE_ENGINE_VERSION
      && Math.abs(cached.width - width) <= 0.0001
      ? cached
      : {
          pointsRef: stroke.points,
          pointTimesRef: pointTimes,
          pointPressuresRef: pointPressures,
          kindRef: stroke.kind,
          engineVersion: PERFECT_STROKE_ENGINE_VERSION,
          width,
          fullPath: '',
          partialPath: '',
          partialCount: 0,
          partialTime: Number.NaN,
        };

    if (!hasPointTimes) {
      if (!entry.fullPath) {
        entry.fullPath = buildPerfectStrokePath(stroke.points, width, {
          complete: true,
          pressures: pointPressures,
          variant: strokeKind,
        });
      }
      cache.set(stroke.id, entry);
      return entry.fullPath;
    }

    const lastPointTime = normalizeTimelineTime(pointTimes[pointTimes.length - 1]);
    if (lastPointTime <= time) {
      if (!entry.fullPath) {
        entry.fullPath = buildPerfectStrokePath(stroke.points, width, {
          complete: true,
          pressures: pointPressures,
          variant: strokeKind,
        });
      }
      cache.set(stroke.id, entry);
      return entry.fullPath;
    }

    const visibleCount = resolveVisibleStrokePointCount(pointTimes, time);
    if (visibleCount <= 0) {
      entry.partialPath = '';
      entry.partialCount = 0;
      entry.partialTime = time;
      cache.set(stroke.id, entry);
      return '';
    }

    if (visibleCount >= stroke.points.length) {
      if (!entry.fullPath) {
        entry.fullPath = buildPerfectStrokePath(stroke.points, width, {
          complete: true,
          pressures: pointPressures,
          variant: strokeKind,
        });
      }
      cache.set(stroke.id, entry);
      return entry.fullPath;
    }

    if (entry.partialCount === visibleCount && entry.partialTime === time && entry.partialPath) {
      cache.set(stroke.id, entry);
      return entry.partialPath;
    }

    entry.partialPath = buildPerfectStrokePath(
      stroke.points.slice(0, visibleCount),
      width,
      {
        complete: false,
        pressures: pointPressures?.slice(0, visibleCount),
        variant: strokeKind,
      },
    );
    entry.partialCount = visibleCount;
    entry.partialTime = time;
    cache.set(stroke.id, entry);
    return entry.partialPath;
  };

  const visibleStrokes = useMemo(
    () => getVisibleStrokes(projectState, renderTime),
    [projectState, renderTime],
  );
  const renderedVisibleStrokes = useMemo<RenderedStrokePath[]>(() => (
    visibleStrokes.map((stroke) => {
      const path = resolveStrokePathAtTime(stroke, renderTime);
      if (!path) {
        return null;
      }
      return {
        id: stroke.id,
        d: path,
        color: stroke.color,
      };
    }).filter((stroke): stroke is RenderedStrokePath => !!stroke)
  ), [visibleStrokes, renderTime]);

  const visibleObjects = useMemo(
    () => getVisibleObjects(projectState, renderTime),
    [projectState, renderTime],
  );
  const visibleStrokeIds = useMemo(
    () => new Set(visibleStrokes.map((stroke) => stroke.id)),
    [visibleStrokes],
  );
  const renderedStrokeIds = useMemo(
    () => new Set(renderedVisibleStrokes.map((stroke) => stroke.id)),
    [renderedVisibleStrokes],
  );
  const renderedVisibleStrokeNodes = useMemo(() => (
    renderedVisibleStrokes.map((stroke) => (
      <path
        key={stroke.id}
        d={stroke.d}
        fill={stroke.color}
        stroke="none"
      />
    ))
  ), [renderedVisibleStrokes]);

  const orderedProjectPages = useMemo(
    () => [...projectPagesMeta].sort((a, b) => a.order - b.order),
    [projectPagesMeta],
  );
  const pageIds = useMemo(() => (
    orderedProjectPages.length > 0
      ? orderedProjectPages.map((page) => page.id)
      : Object.keys(projectState.pages).sort()
  ), [orderedProjectPages, projectState.pages]);
  const currentPageIndex = useMemo(
    () => Math.max(0, pageIds.findIndex((pageId) => pageId === projectState.currentPageId)),
    [pageIds, projectState.currentPageId],
  );
  const inputLocked = false;
  const currentPageMeta = useMemo(
    () => orderedProjectPages.find((page) => page.id === projectState.currentPageId),
    [orderedProjectPages, projectState.currentPageId],
  );
  const boardWidth = currentPageMeta?.width ?? CANVAS_WIDTH;
  const boardHeight = currentPageMeta?.height ?? CANVAS_HEIGHT;
  const currentPage = projectState.pages[projectState.currentPageId];
  const viewport = currentPage?.viewport ?? { x: 0, y: 0, zoom: 1 };
  const renderViewport = viewportPreview ?? viewport;
  const penStrokeColor = colorWithOpacity(toolParameters.color, toolParameters.opacity);
  const highlighterStrokeColor = colorWithOpacity(
    toolParameters.highlighterColor,
    toolParameters.highlighterOpacity,
  );
  const previewStrokePoints = useMemo(
    () => (draftStroke ? draftStroke.renderPoints : null),
    [draftStroke],
  );
  const previewStrokePath = useMemo(
    () => (
      previewStrokePoints
      && previewStrokePoints.length > 0
      && draftStroke
        ? buildPerfectStrokePath(previewStrokePoints, draftStroke.worldWidth, {
          complete: false,
          pressures: draftStroke.renderPointPressures,
          variant: draftStroke.strokeKind,
        })
        : ''
    ),
    [previewStrokePoints, draftStroke],
  );
  const committingStrokePreviewNodes = useMemo(() => (
    committingStrokePreviews
      .filter((stroke) => !renderedStrokeIds.has(stroke.id))
      .map((stroke) => (
        <path
          key={`committing-${stroke.id}`}
          d={stroke.path}
          fill={stroke.color}
          stroke="none"
          opacity={0.98}
        />
      ))
  ), [committingStrokePreviews, renderedStrokeIds]);
  const dragPreviewObject = useMemo(() => {
    if (!dragSession) {
      return [];
    }
    const dx = dragSession.pointerCurrent.x - dragSession.pointerStart.x;
    const dy = dragSession.pointerCurrent.y - dragSession.pointerStart.y;
    return dragSession.objects.map((item) => {
      const nextXRaw = item.objectOrigin.x + dx;
      const nextYRaw = item.objectOrigin.y + dy;
      const snappedX = toolParameters.snap ? quantize(nextXRaw, SNAP_GRID_STEP) : nextXRaw;
      const snappedY = toolParameters.snap ? quantize(nextYRaw, SNAP_GRID_STEP) : nextYRaw;
      const clamped = clampObjectPositionToBoard(
        snappedX,
        snappedY,
        item.objectSize.width,
        item.objectSize.height,
        boardWidth,
        boardHeight,
      );
      const target = visibleObjects.find((object) => object.id === item.objectId);
      if (!target || target.type !== 'rect') {
        return null;
      }
      return {
        ...target,
        x: clamped.x,
        y: clamped.y,
      };
    }).filter((object): object is NonNullable<typeof object> => !!object);
  }, [dragSession, toolParameters.snap, visibleObjects, boardWidth, boardHeight]);
  const resizePreviewObjects = useMemo(() => {
    if (!resizeSession) {
      return [];
    }
    const rawBounds = resizeRectFromHandle(
      resizeSession.originBounds,
      resizeSession.current,
      resizeSession.handle,
      boardWidth,
      boardHeight,
      MIN_OBJECT_SIZE,
    );
    const nextBounds = !toolParameters.snap
      ? rawBounds
      : {
          x: quantize(rawBounds.x, SNAP_GRID_STEP),
          y: quantize(rawBounds.y, SNAP_GRID_STEP),
          width: Math.max(SNAP_GRID_STEP, quantize(rawBounds.width, SNAP_GRID_STEP)),
          height: Math.max(SNAP_GRID_STEP, quantize(rawBounds.height, SNAP_GRID_STEP)),
        };
    return resizeSession.objects.map((item) => {
      const base = visibleObjects.find((object) => object.id === item.objectId);
      if (!base || base.type !== 'rect') {
        return null;
      }
      const rect = mapRectToResizedBounds(
        item.originRect,
        resizeSession.originBounds,
        nextBounds,
        MIN_OBJECT_SIZE,
      );
      return {
        ...base,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    }).filter((object): object is NonNullable<typeof object> => !!object);
  }, [resizeSession, visibleObjects, boardWidth, boardHeight, toolParameters.snap]);
  const dragPreviewObjectIdSet = useMemo(
    () => new Set(dragPreviewObject.map((object) => object.id)),
    [dragPreviewObject],
  );
  const resizePreviewObjectIdSet = useMemo(
    () => new Set(resizePreviewObjects.map((object) => object.id)),
    [resizePreviewObjects],
  );
  const selectedVisibleObjects = useMemo(() => {
    const previewMap = new Map<string, typeof visibleObjects[number]>();
    for (const object of dragPreviewObject) {
      previewMap.set(object.id, object);
    }
    for (const object of resizePreviewObjects) {
      previewMap.set(object.id, object);
    }
    return selectedObjectIds
      .map((id) => previewMap.get(id) ?? visibleObjects.find((object) => object.id === id))
      .filter((object): object is NonNullable<typeof object> => !!object && object.type === 'rect');
  }, [selectedObjectIds, visibleObjects, dragPreviewObject, resizePreviewObjects]);
  const selectedVisibleObject = selectedVisibleObjects.length === 1 ? selectedVisibleObjects[0] : null;
  const selectionBounds = useMemo(
    () => getSelectionBounds(selectedVisibleObjects),
    [selectedVisibleObjects],
  );
  const resizeHandles = useMemo(
    () => ((selectedVisibleObject ?? selectionBounds) ? getRectResizeHandles(selectedVisibleObject ?? selectionBounds!) : []),
    [selectedVisibleObject, selectionBounds],
  );

  useEffect(() => {
    const visibleIds = visibleObjects.map((object) => object.id);
    setSelectedObjectIds((prev) => {
      const next = pruneObjectSelection(prev, visibleIds);
      return next.length === prev.length ? prev : next;
    });
  }, [visibleObjects]);

  useEffect(() => {
    visibleStrokeIdsRef.current = visibleStrokeIds;
    renderedStrokeIdsRef.current = renderedStrokeIds;
    const pathCache = strokePathCacheRef.current;
    for (const strokeId of pathCache.keys()) {
      if (!visibleStrokeIds.has(strokeId)) {
        pathCache.delete(strokeId);
      }
    }
  }, [visibleStrokeIds, renderedStrokeIds]);

  useEffect(() => {
    if (committingStrokePreviews.length <= 0) {
      return;
    }
    let disposed = false;
    let timer: PlatformTimerHandle | null = null;
    const sweep = () => {
      if (disposed) {
        return;
      }
      const nowMs = platformNowMs();
      setCommittingStrokePreviews((prev) => {
        const next = prev.filter((stroke) => (
          !renderedStrokeIdsRef.current.has(stroke.id)
          && (nowMs - stroke.createdWallClock) <= COMMITTING_STROKE_PREVIEW_TTL_MS
        ));
        return next.length === prev.length ? prev : next;
      });
      timer = platformSetTimeout(sweep, COMMITTING_STROKE_CLEANUP_INTERVAL_MS);
    };
    timer = platformSetTimeout(sweep, COMMITTING_STROKE_CLEANUP_INTERVAL_MS);
    return () => {
      disposed = true;
      if (timer !== null) {
        platformClearTimeout(timer);
      }
    };
  }, [committingStrokePreviews.length]);

  useEffect(() => {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn(`[UniFlow] stroke-engine=${PERFECT_STROKE_ENGINE_VERSION}`);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    const meta = currentPageMeta;
    if (!meta) {
      setPageBackgroundUrl(null);
      return undefined;
    }
    if (meta.backgroundUrl) {
      setPageBackgroundUrl(meta.backgroundUrl);
      return undefined;
    }
    if (!meta.backgroundAssetKey) {
      setPageBackgroundUrl(null);
      return undefined;
    }

    void loadAssetObjectUrl(meta.backgroundAssetKey).then((url) => {
      if (disposed) {
        if (url) {
          revokeObjectUrl(url);
        }
        return;
      }
      objectUrl = url;
      setPageBackgroundUrl(url);
    });

    return () => {
      disposed = true;
      if (objectUrl) {
        revokeObjectUrl(objectUrl);
      }
    };
  }, [currentPageMeta]);

  useEffect(() => {
    let disposed = false;
    const revokes: string[] = [];
    const next: Record<string, string> = {};

    const run = async () => {
      for (const page of orderedProjectPages) {
        if (page.backgroundUrl) {
          next[page.id] = page.backgroundUrl;
          continue;
        }
        if (!page.backgroundAssetKey) {
          continue;
        }
        const url = await loadAssetObjectUrl(page.backgroundAssetKey);
        if (!url) {
          continue;
        }
        next[page.id] = url;
        revokes.push(url);
      }
      if (disposed) {
        for (const url of revokes) {
          revokeObjectUrl(url);
        }
        return;
      }
      setPagePreviewUrls(next);
    };
    void run();

    return () => {
      disposed = true;
      for (const url of revokes) {
        revokeObjectUrl(url);
      }
    };
  }, [orderedProjectPages]);

  const resolvePointerViewportRect = () => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  };

  const toLocalPoint = (
    event: { clientX: number; clientY: number },
    viewportRectOverride?: { left: number; top: number; width: number; height: number } | null,
  ): Point | null => {
    const viewportRect = viewportRectOverride ?? resolvePointerViewportRect();
    if (!viewportRect) {
      return null;
    }
    return projectScreenPointToWorldInResolvedViewportRect(
      event.clientX,
      event.clientY,
      viewportRect,
      renderViewport,
      boardWidth,
      boardHeight,
      { allowOutsideViewport: true },
    );
  };

  const resolvePointerPressure = (
    event: { pressure?: number; pointerType?: string },
  ): number => {
    const pressure = event.pressure;
    if (typeof pressure === 'number' && Number.isFinite(pressure)) {
      if (event.pointerType === 'pen' && pressure > 0) {
        return clamp(pressure, 0, 1);
      }
      if (pressure > 0) {
        return clamp(pressure, 0, 1);
      }
    }
    return 0.5;
  };

  const getViewportContentRect = () => {
    return resolvePointerViewportRect();
  };

  const now = (): number => platformNowMs();
  const beginInteractionRenderFreeze = (baseTime: number) => {
    setInteractionRenderTime(normalizeTimelineTime(baseTime));
  };
  const clearInteractionRenderFreeze = () => {
    setInteractionRenderTime(null);
  };

  const getInputBaseTime = (): number => {
    const storeCurrentTime = normalizeTimelineTime(useWhiteboardStore.getState().currentTime);
    if (recordingStatus === 'recording' && recordingTimelineRuntime.isStarted()) {
      return recordingTimelineRuntime.getTimelineNowMs(storeCurrentTime);
    }
    return storeCurrentTime;
  };

  const sampleSessionTime = (session: { startedWallClock: number; baseTime: number }): number => {
    if (recordingStatus !== 'recording') {
      return normalizeTimelineTime(session.baseTime);
    }
    if (recordingTimelineRuntime.isStarted()) {
      return recordingTimelineRuntime.getTimelineNowMs(session.baseTime);
    }
    return normalizeTimelineTime(session.baseTime + (now() - session.startedWallClock));
  };

  const shouldDispatchAt = (lastDispatchTime: number, nextTime: number): boolean => {
    return nextTime - lastDispatchTime >= INPUT_FRAME_INTERVAL_MS;
  };

  const getWorldStrokeWidth = (uiWidth: number): number => {
    const safeZoom = Math.max(0.2, renderViewport.zoom);
    return Math.max(0.2, uiWidth / safeZoom);
  };

  const getWorldEraserRadius = (uiRadius: number): number => {
    const safeZoom = Math.max(0.2, renderViewport.zoom);
    return Math.max(1.5, uiRadius / safeZoom);
  };

  const getWorldHandleRadius = (): number => {
    const safeZoom = Math.max(0.2, renderViewport.zoom);
    return Math.max(4, RESIZE_HANDLE_UI_SIZE / safeZoom);
  };

  const hoverCursorRadius = useMemo(() => {
    if (tool === 'erase') {
      return getWorldEraserRadius(toolParameters.eraserRadius);
    }
    if (tool === 'highlight') {
      return Math.max(3, getWorldStrokeWidth(toolParameters.highlighterWidth) / 2);
    }
    if (tool === 'pen') {
      return Math.max(2.5, getWorldStrokeWidth(toolParameters.width) / 2);
    }
    return null;
  }, [tool, toolParameters.eraserRadius, toolParameters.highlighterWidth, toolParameters.width, renderViewport.zoom]);

  const selectionToolbarPosition = useMemo(() => {
    if (!selectionBounds) {
      return null;
    }
    const rect = getViewportContentRect();
    if (!rect) {
      return null;
    }
    const visibleWidth = boardWidth / renderViewport.zoom;
    const visibleHeight = boardHeight / renderViewport.zoom;
    const anchorX = ((selectionBounds.x + (selectionBounds.width / 2)) - renderViewport.x) / visibleWidth;
    const anchorY = (selectionBounds.y - renderViewport.y) / visibleHeight;
    return {
      left: rect.left + (rect.width * anchorX),
      top: rect.top + (rect.height * anchorY),
    };
  }, [selectionBounds, boardWidth, boardHeight, renderViewport]);

  const clearPendingStrokeFrame = () => {
    if (strokeFrameRef.current !== null) {
      cancelPlatformFrame(strokeFrameRef.current);
      strokeFrameRef.current = null;
    }
    pendingStrokeSamplesRef.current = [];
  };

  useEffect(() => {
    draftStrokeRef.current = draftStroke;
  }, [draftStroke]);

  const flushPendingStrokeSample = () => {
    const pending = pendingStrokeSamplesRef.current;
    if (pending.length === 0) {
      clearPendingStrokeFrame();
      return;
    }
    pendingStrokeSamplesRef.current = [];
    clearPendingStrokeFrame();
    setDraftStroke((prev) => {
      if (!prev) {
        return prev;
      }
      let sampled = prev.samples;
      for (const sample of pending) {
        sampled = appendInputStrokeSample(sampled, sample);
      }
      if (sampled === prev.samples) {
        return prev;
      }
      const rendered = mapInputStrokeSamples(sampled);
      return {
        ...prev,
        samples: sampled,
        renderPoints: rendered.points,
        renderPointTimes: rendered.pointTimes,
        renderPointPressures: rendered.pointPressures,
      };
    });
  };

  const schedulePendingStrokeSample = () => {
    if (strokeFrameRef.current !== null) {
      return;
    }
    strokeFrameRef.current = requestPlatformFrame(() => {
      strokeFrameRef.current = null;
      const pending = pendingStrokeSamplesRef.current;
      pendingStrokeSamplesRef.current = [];
      if (pending.length === 0) {
        return;
      }
      setDraftStroke((prev) => {
        if (!prev) {
          return prev;
        }
        let sampled = prev.samples;
        for (const sample of pending) {
          sampled = appendInputStrokeSample(sampled, sample);
        }
        if (sampled === prev.samples) {
          return prev;
        }
        const rendered = mapInputStrokeSamples(sampled);
        return {
          ...prev,
          samples: sampled,
          renderPoints: rendered.points,
          renderPointTimes: rendered.pointTimes,
          renderPointPressures: rendered.pointPressures,
        };
      });
      if (pendingStrokeSamplesRef.current.length > 0) {
        schedulePendingStrokeSample();
      }
    });
  };

  const getEffectiveStrokeStyle = (toolId: ToolId): { color: string; width: number } => {
    if (toolId === 'highlight') {
      return {
        color: highlighterStrokeColor,
        width: toolParameters.highlighterWidth,
      };
    }
    return {
      color: penStrokeColor,
      width: toolParameters.width,
    };
  };

  const getObjectSvgTransform = (object: { x: number; y: number; width: number; height: number; rotation?: number }) => {
    const rotation = object.rotation ?? 0;
    if (rotation === 0) {
      return undefined;
    }
    const center = getRectCenter(object);
    return `rotate(${rotation} ${center.x} ${center.y})`;
  };

  const applyObjectRotation = (delta: number) => {
    if (selectedVisibleObjects.length <= 0) {
      return;
    }
    const time = getInputBaseTime();
    if (selectedVisibleObjects.length > 1 && selectionBounds) {
      const groupCenter = {
        x: selectionBounds.x + (selectionBounds.width / 2),
        y: selectionBounds.y + (selectionBounds.height / 2),
      };
      selectedVisibleObjects.forEach((object) => {
        const center = getRectCenter(object);
        const rotatedCenter = rotatePoint(center, groupCenter, delta);
        updateObjectTransform(
          object.id,
          {
            x: rotatedCenter.x - (object.width / 2),
            y: rotatedCenter.y - (object.height / 2),
            rotation: (object.rotation ?? 0) + delta,
          },
          time,
        );
      });
      return;
    }
    selectedVisibleObjects.forEach((object) => {
      updateObjectTransform(object.id, { rotation: (object.rotation ?? 0) + delta }, time);
    });
  };

  const getObjectZIndex = (object: { style?: Record<string, unknown> }): number => {
    const raw = object.style?.zIndex;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  };

  const shiftSelectionLayer = (delta: 1 | -1) => {
    if (selectedVisibleObjects.length <= 0) {
      return;
    }
    const time = getInputBaseTime();
    selectedVisibleObjects.forEach((object) => {
      updateObjectStyle(object.id, {
        ...(object.style ?? {}),
        zIndex: getObjectZIndex(object) + delta,
      }, time);
    });
  };

  const reorderSelectionLayer = (mode: 'front' | 'back') => {
    if (selectedVisibleObjects.length <= 0) {
      return;
    }
    const time = getInputBaseTime();
    const layerValues = visibleObjects.map((object) => getObjectZIndex(object));
    const maxLayer = layerValues.length > 0 ? Math.max(...layerValues) : 0;
    const minLayer = layerValues.length > 0 ? Math.min(...layerValues) : 0;
    const sortedSelection = [...selectedVisibleObjects].sort((a, b) => {
      const layerA = getObjectZIndex(a);
      const layerB = getObjectZIndex(b);
      if (layerA !== layerB) {
        return layerA - layerB;
      }
      return a.createdAt - b.createdAt;
    });

    const nextLayers = mode === 'front'
      ? sortedSelection.map((_, index) => (maxLayer + 1) + index)
      : sortedSelection.map((_, index) => (minLayer - sortedSelection.length) + index);

    sortedSelection.forEach((object, index) => {
      updateObjectStyle(object.id, {
        ...(object.style ?? {}),
        zIndex: nextLayers[index],
      }, time);
    });
  };

  const duplicateSelectedRects = () => {
    if (selectedVisibleObjects.length <= 0) {
      return;
    }
    const time = getInputBaseTime();
    const nextIds = selectedVisibleObjects.map((object) => createRect({
      x: object.x + 24,
      y: object.y + 24,
      width: object.width,
      height: object.height,
      rotation: object.rotation,
      style: object.style,
    }, time));
    setSelectedObjectIds(nextIds);
  };

  const viewportMatchesPreview = (preview: ViewportValue, current: ViewportValue): boolean => {
    return (
      Math.abs(preview.x - current.x) < 0.001
      && Math.abs(preview.y - current.y) < 0.001
      && Math.abs(preview.zoom - current.zoom) < 0.001
    );
  };

  const commitViewport = (nextViewport: ViewportValue, time: number) => {
    const clampedViewport = clampViewportToBoard(nextViewport, boardWidth, boardHeight);
    setViewportPreview(clampedViewport);
    setViewport(clampedViewport, time);
  };

  const applyZoom = (nextZoom: number, anchor?: Point, time?: number) => {
    flushWheelGesture(true);
    const baseViewport = wheelViewportRef.current ?? renderViewport;
    const safeZoom = Math.max(0.2, Math.min(4, nextZoom));
    const width = boardWidth / baseViewport.zoom;
    const height = boardHeight / baseViewport.zoom;
    const nextWidth = boardWidth / safeZoom;
    const nextHeight = boardHeight / safeZoom;

    const defaultAnchor = {
      x: baseViewport.x + width / 2,
      y: baseViewport.y + height / 2,
    };
    const target = anchor ?? lastPointerWorldRef.current ?? defaultAnchor;

    const ratioX = width <= 0 ? 0.5 : (target.x - baseViewport.x) / width;
    const ratioY = height <= 0 ? 0.5 : (target.y - baseViewport.y) / height;
    const clampedRatioX = Math.max(0, Math.min(1, ratioX));
    const clampedRatioY = Math.max(0, Math.min(1, ratioY));

    const nextX = target.x - clampedRatioX * nextWidth;
    const nextY = target.y - clampedRatioY * nextHeight;
    commitViewport({ x: nextX, y: nextY, zoom: safeZoom }, time ?? getInputBaseTime());
  };

  const resetViewport = (time?: number) => {
    flushWheelGesture(true);
    wheelViewportRef.current = null;
    commitViewport({ x: 0, y: 0, zoom: 1 }, time ?? getInputBaseTime());
  };

  const normalizeRect = (
    startOrRect: Point | { x: number; y: number; width: number; height: number },
    current?: Point,
  ) => {
    const rawRect = current
      ? clampRectToBoard(startOrRect as Point, current, boardWidth, boardHeight)
      : startOrRect as { x: number; y: number; width: number; height: number };
    const { x, y, width, height } = rawRect;
    if (!toolParameters.snap) {
      return { x, y, width: Math.max(MIN_OBJECT_SIZE, width), height: Math.max(MIN_OBJECT_SIZE, height) };
    }
    return {
      x: quantize(x, SNAP_GRID_STEP),
      y: quantize(y, SNAP_GRID_STEP),
      width: Math.max(Math.max(MIN_OBJECT_SIZE, SNAP_GRID_STEP), quantize(width, SNAP_GRID_STEP)),
      height: Math.max(Math.max(MIN_OBJECT_SIZE, SNAP_GRID_STEP), quantize(height, SNAP_GRID_STEP)),
    };
  };

  const resolveResizeHandleAtPoint = (point: Point): RectResizeHandle | null => {
    if (resizeHandles.length <= 0) {
      return null;
    }
    const hitRadius = getWorldHandleRadius();
    const hitRadiusSq = hitRadius * hitRadius;
    for (const handle of resizeHandles) {
      const dx = point.x - handle.point.x;
      const dy = point.y - handle.point.y;
      if ((dx * dx) + (dy * dy) <= hitRadiusSq) {
        return handle.handle;
      }
    }
    return null;
  };

  const getTwoTouchSnapshot = (touches: React.TouchList): [ScreenPoint, ScreenPoint] | null => {
    if (touches.length < 2) {
      return null;
    }
    return [
      { x: touches[0].clientX, y: touches[0].clientY },
      { x: touches[1].clientX, y: touches[1].clientY },
    ];
  };

  const getGestureCenter = (a: ScreenPoint, b: ScreenPoint): ScreenPoint => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });

  const getGestureDistance = (a: ScreenPoint, b: ScreenPoint): number => {
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const computeViewportForZoom = (
    origin: { x: number; y: number; zoom: number },
    nextZoom: number,
    anchor: Point,
  ) => {
    const safeZoom = Math.max(0.2, Math.min(4, nextZoom));
    const width = boardWidth / origin.zoom;
    const height = boardHeight / origin.zoom;
    const nextWidth = boardWidth / safeZoom;
    const nextHeight = boardHeight / safeZoom;
    const ratioX = width <= 0 ? 0.5 : (anchor.x - origin.x) / width;
    const ratioY = height <= 0 ? 0.5 : (anchor.y - origin.y) / height;
    const clampedRatioX = Math.max(0, Math.min(1, ratioX));
    const clampedRatioY = Math.max(0, Math.min(1, ratioY));
    return clampViewportToBoard({
      x: anchor.x - clampedRatioX * nextWidth,
      y: anchor.y - clampedRatioY * nextHeight,
      zoom: safeZoom,
    }, boardWidth, boardHeight);
  };

  const computeViewportFromScreenAnchor = (
    anchorWorld: Point,
    centerScreen: ScreenPoint,
    nextZoom: number,
  ): ViewportValue => {
    const rect = getViewportContentRect();
    const safeZoom = Math.max(0.2, Math.min(4, nextZoom));
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return clampViewportToBoard({
        x: anchorWorld.x,
        y: anchorWorld.y,
        zoom: safeZoom,
      }, boardWidth, boardHeight);
    }

    const unitsPerScreenX = (boardWidth / safeZoom) / rect.width;
    const unitsPerScreenY = (boardHeight / safeZoom) / rect.height;
    return clampViewportToBoard({
      x: anchorWorld.x - ((centerScreen.x - rect.left) * unitsPerScreenX),
      y: anchorWorld.y - ((centerScreen.y - rect.top) * unitsPerScreenY),
      zoom: safeZoom,
    }, boardWidth, boardHeight);
  };

  const getBaseViewport = (): ViewportValue => {
    return wheelViewportRef.current ?? viewportPreview ?? viewport;
  };

  const clearWheelCommitTimer = () => {
    if (wheelCommitTimerRef.current !== null) {
      platformClearTimeout(wheelCommitTimerRef.current);
      wheelCommitTimerRef.current = null;
    }
  };

  const flushWheelGesture = (commit: boolean) => {
    const session = wheelGestureRef.current;
    const latest = wheelViewportRef.current;
    if (commit && session && latest) {
      const nextTime = recordingStatus === 'recording'
        ? sampleSessionTime(session)
        : session.baseTime;
      commitViewport(latest, nextTime);
    }
    clearWheelCommitTimer();
    wheelGestureRef.current = null;
    wheelViewportRef.current = null;
    if (!commit) {
      setViewportPreview(null);
    }
  };

  const beginTwoFingerGesture = (snapshot: [ScreenPoint, ScreenPoint]): TwoFingerGestureSession | null => {
    const [a, b] = snapshot;
    const centerScreen = getGestureCenter(a, b);
    const distance = Math.max(1, getGestureDistance(a, b));
    const centerWorld = toLocalPoint({
      clientX: centerScreen.x,
      clientY: centerScreen.y,
    });
    if (!centerWorld) {
      return null;
    }

    cancelActiveInputForGesture();
    flushWheelGesture(true);

    const baseTime = getInputBaseTime();
    const baseViewport = getBaseViewport();
    const gesture: TwoFingerGestureSession = {
      startedWallClock: now(),
      baseTime,
      lastDispatchTime: baseTime,
      initialCenterScreen: centerScreen,
      initialCenterWorld: centerWorld,
      initialDistance: distance,
      viewportOrigin: { ...baseViewport },
      latestViewport: { ...baseViewport },
    };
    twoFingerGestureRef.current = gesture;
    setViewportPreview({ ...baseViewport });
    return gesture;
  };

  const commitTwoFingerGesture = (gesture: TwoFingerGestureSession) => {
    const finalTime = recordingStatus === 'recording'
      ? sampleSessionTime(gesture)
      : gesture.baseTime;
    commitViewport(gesture.latestViewport, finalTime);
    twoFingerGestureRef.current = null;
  };

  const collectEraseTarget = (point: Point) => {
    const session = eraseSessionRef.current;
    if (!session) {
      return;
    }

    const hitTime = sampleSessionTime(session);

    const topObject = [...visibleObjects]
      .reverse()
      .find((object) => object.type === 'rect' && hitRectObject(point, object));
    if (topObject && !session.objectHitAt.has(topObject.id)) {
      session.objectHitAt.set(topObject.id, hitTime);
      return;
    }

    const topStroke = [...visibleStrokes]
      .reverse()
      .find((stroke) => {
        const points = getStrokePointsAtTime(stroke, renderTime);
        if (points.length === 0) {
          return false;
        }
        return hitStroke(point, { ...stroke, points }, getWorldEraserRadius(toolParameters.eraserRadius));
      });

    if (topStroke && !session.strokeHitAt.has(topStroke.id)) {
      session.strokeHitAt.set(topStroke.id, hitTime);
    }
  };

  const flushEraseSession = () => {
    const session = eraseSessionRef.current;
    if (!session) {
      return;
    }

    const strokeEntries = [...session.strokeHitAt.entries()].sort((a, b) => a[1] - b[1]);
    const objectEntries = [...session.objectHitAt.entries()].sort((a, b) => a[1] - b[1]);

    strokeEntries.forEach(([strokeId, time]) => eraseStroke(strokeId, time));
    objectEntries.forEach(([objectId, time]) => deleteObject(objectId, time));
    if (objectEntries.length > 0) {
      const deletedIds = new Set(objectEntries.map(([objectId]) => objectId));
      setSelectedObjectIds((prev) => prev.filter((id) => !deletedIds.has(id)));
    }

    eraseSessionRef.current = null;
  };

  const clearTransientSessions = () => {
    clearPendingStrokeFrame();
    setDraftStroke(null);
    setDragSession(null);
    setResizeSession(null);
    setPanSession(null);
    setErasing(false);
    eraseSessionRef.current = null;
    activePointerIdRef.current = null;
    clearInteractionRenderFreeze();
  };

  const settleToolAfterCommit = () => {
    setToolState((prev) => {
      const committing = transitionToolState(prev, { type: 'commitInteraction' });
      return transitionToolState(committing, { type: 'settle' });
    });
  };

  const cancelToolInteraction = () => {
    setToolState((prev) => transitionToolState(prev, { type: 'cancel' }));
  };

  const cancelActiveInputForGesture = () => {
    if (draftRect) {
      deleteObject(draftRect.objectId, getInputBaseTime());
      setDraftRect(null);
    }
    clearTransientSessions();
    activePointerToolRef.current = null;
    cancelToolInteraction();
  };

  useEffect(() => {
    if (activePointerToolRef.current) {
      return;
    }

    if (draftRect) {
      deleteObject(draftRect.objectId, getInputBaseTime());
      setDraftRect(null);
    }

    clearTransientSessions();
  }, [tool]);

  useEffect(() => {
    if (recordingStatus === 'idle') {
      return;
    }
    activePointerToolRef.current = null;
    activePointerIdRef.current = null;
    twoFingerGestureRef.current = null;
    flushWheelGesture(false);
    setViewportPreview(null);
    setSelectedObjectIds([]);
    setPagePreviewOpen(false);
    clearTransientSessions();
    cancelToolInteraction();
  }, [recordingStatus]);

  useEffect(() => {
    const svg = svgRef.current;
    const session = draftStrokeRef.current;
    const activeTool = activePointerToolRef.current ?? tool;
    if (!svg || !session || (activeTool !== 'pen' && activeTool !== 'highlight')) {
      pointerRawEnabledRef.current = false;
      return;
    }
    if (typeof window === 'undefined' || !('onpointerrawupdate' in window)) {
      pointerRawEnabledRef.current = false;
      return;
    }

    const onPointerRawUpdate = (rawEvent: Event) => {
      const event = rawEvent as PointerEvent;
      const pointerId = activePointerIdRef.current;
      if (pointerId !== null && event.pointerId !== pointerId) {
        return;
      }
      const currentSession = draftStrokeRef.current;
      if (!currentSession) {
        return;
      }
      const projectionRect = resolvePointerViewportRect();
      const samplePoint = toLocalPoint(event, projectionRect);
      if (!samplePoint) {
        return;
      }
      pendingStrokeSamplesRef.current.push({
        point: samplePoint,
        time: sampleSessionTime(currentSession),
        pressure: resolvePointerPressure(event),
      });
      schedulePendingStrokeSample();
    };

    pointerRawEnabledRef.current = true;
    svg.addEventListener('pointerrawupdate', onPointerRawUpdate as EventListener);
    return () => {
      pointerRawEnabledRef.current = false;
      svg.removeEventListener('pointerrawupdate', onPointerRawUpdate as EventListener);
    };
  }, [draftStroke, tool, renderViewport.x, renderViewport.y, renderViewport.zoom, boardWidth, boardHeight, recordingStatus]);

  useEffect(() => {
    return combineWindowEventDisposers(
      subscribeWindowKeyDown((event) => {
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName?.toUpperCase() ?? '';
        if (target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          return;
        }

        if (recordingStatus === 'idle' && !draftStroke && !draftRect && !dragSession && !resizeSession && !panSession && !erasing) {
          const key = event.key.toLowerCase();
          if (key === 'p' || key === 'h' || key === 'r' || key === 'v' || key === 'e') {
            const nextTool = key === 'p'
              ? 'pen'
              : key === 'h'
                ? 'highlight'
                : key === 'r'
                  ? 'rect'
                  : key === 'v'
                    ? 'drag'
                    : 'erase';
            setToolState((prev) => transitionToolState(prev, { type: 'selectTool', tool: nextTool }));
            event.preventDefault();
            return;
          }

          if (selectedObjectIds.length > 0) {
            if (key === 'q') {
              applyObjectRotation(-15);
              event.preventDefault();
              return;
            }
            if (key === 'w') {
              applyObjectRotation(15);
              event.preventDefault();
              return;
            }
            if (key === 'd') {
              duplicateSelectedRects();
              event.preventDefault();
              return;
            }
            if (event.key === '[' || event.key === '{') {
              if (event.shiftKey) {
                reorderSelectionLayer('back');
              } else {
                shiftSelectionLayer(-1);
              }
              event.preventDefault();
              return;
            }
            if (event.key === ']' || event.key === '}') {
              if (event.shiftKey) {
                reorderSelectionLayer('front');
              } else {
                shiftSelectionLayer(1);
              }
              event.preventDefault();
              return;
            }
          }
        }

        if (selectedObjectIds.length === 0 || recordingStatus !== 'idle') {
          return;
        }
        if (draftStroke || draftRect || dragSession || resizeSession || panSession || erasing) {
          return;
        }
        if (!shouldHandleCanvasDeleteKey(event.key, target?.tagName, target?.isContentEditable)) {
          return;
        }
        deleteObjects(selectedObjectIds, getInputBaseTime());
        setSelectedObjectIds([]);
        event.preventDefault();
      }),
    );
  }, [
    deleteObjects,
    draftRect,
    draftStroke,
    dragSession,
    erasing,
    panSession,
    recordingStatus,
    resizeSession,
    selectedObjectIds,
    applyObjectRotation,
    duplicateSelectedRects,
    reorderSelectionLayer,
    shiftSelectionLayer,
  ]);

  useEffect(() => {
    return () => {
      clearWheelCommitTimer();
      clearPendingStrokeFrame();
    };
  }, []);

  useEffect(() => {
    if (!viewportPreview) {
      return;
    }
    if (!viewportMatchesPreview(viewportPreview, viewport)) {
      return;
    }
    if (twoFingerGestureRef.current || wheelGestureRef.current || panSession) {
      return;
    }
    setViewportPreview(null);
  }, [viewportPreview, viewport, panSession]);

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (inputLocked) {
      return;
    }
    if (event.pointerType === 'touch') {
      return;
    }

    const point = toLocalPoint(event);
    if (!point || !svgRef.current) {
      return;
    }
    flushWheelGesture(true);
    svgRef.current.setPointerCapture(event.pointerId);
    activePointerToolRef.current = tool;
    activePointerIdRef.current = event.pointerId;
    setHoverPoint(null);
    if (tool !== 'drag') {
      setSelectedObjectIds([]);
    }

    if (tool === 'pen' || tool === 'highlight') {
      const baseTime = getInputBaseTime();
      const startedWallClock = now();
      const pressure = resolvePointerPressure(event.nativeEvent as PointerEvent);
      const style = getEffectiveStrokeStyle(tool);
      const worldWidth = getWorldStrokeWidth(style.width);
      beginInteractionRenderFreeze(baseTime);
      setToolState((prev) => transitionToolState(prev, { type: 'beginInteraction' }));
      setDraftStroke({
        samples: [{ point, time: baseTime, pressure }],
        renderPoints: [point],
        renderPointTimes: [baseTime],
        renderPointPressures: [pressure],
        strokeKind: tool === 'highlight' ? 'highlight' : 'pen',
        baseTime,
        startedWallClock,
        worldWidth,
        strokeColor: style.color,
      });
      return;
    }

    if (tool === 'rect') {
      const baseTime = getInputBaseTime();
      const startedWallClock = now();
      beginInteractionRenderFreeze(baseTime);
      setToolState((prev) => transitionToolState(prev, { type: 'beginInteraction' }));
      const rectId = createRect(
        {
          x: point.x,
          y: point.y,
          width: 1,
          height: 1,
          style: {
            stroke: colorWithOpacity(toolParameters.color, Math.max(0.35, toolParameters.opacity)),
            fill: colorWithOpacity(toolParameters.color, Math.min(0.2, toolParameters.opacity * 0.25)),
            strokeWidth: toolParameters.width,
          },
        },
        baseTime,
      );
      setSelectedObjectIds([rectId]);
      setDraftRect({
        objectId: rectId,
        start: point,
        current: point,
        baseTime,
        startedWallClock,
        lastDispatchTime: baseTime,
      });
      return;
    }

    if (tool === 'erase') {
      const baseTime = getInputBaseTime();
      const startedWallClock = now();
      beginInteractionRenderFreeze(baseTime);
      setToolState((prev) => transitionToolState(prev, { type: 'beginInteraction' }));
      setErasing(true);
      eraseSessionRef.current = {
        baseTime,
        startedWallClock,
        strokeHitAt: new Map<string, number>(),
        objectHitAt: new Map<string, number>(),
      };
      collectEraseTarget(point);
      return;
    }

    if (tool === 'drag') {
      const multiSelect = event.shiftKey || event.metaKey;
      setToolState((prev) => transitionToolState(prev, { type: 'beginInteraction' }));
      const resizeHandle = resolveResizeHandleAtPoint(point);
      if (resizeHandle && (selectedVisibleObject || selectionBounds)) {
        const baseTime = getInputBaseTime();
        beginInteractionRenderFreeze(baseTime);
        const resizeTargets = selectedVisibleObjects.length > 0
          ? selectedVisibleObjects
          : (selectedVisibleObject ? [selectedVisibleObject] : []);
        if (selectedVisibleObject) {
          setSelectedObjectIds([selectedVisibleObject.id]);
        }
        setResizeSession({
          handle: resizeHandle,
          originBounds: selectedVisibleObject ?? selectionBounds!,
          objects: resizeTargets.map((object) => ({
            objectId: object.id,
            originRect: {
              x: object.x,
              y: object.y,
              width: object.width,
              height: object.height,
            },
          })),
          current: point,
          baseTime,
          startedWallClock: now(),
          lastDispatchTime: baseTime,
        });
        return;
      }
      const targetObject = [...visibleObjects]
        .reverse()
        .find((object) => object.type === 'rect' && hitRectObject(point, object));

      if (targetObject) {
        if (multiSelect) {
          setSelectedObjectIds((prev) => toggleObjectSelection(prev, targetObject.id, true));
          activePointerToolRef.current = null;
          activePointerIdRef.current = null;
          svgRef.current.releasePointerCapture(event.pointerId);
          cancelToolInteraction();
          return;
        }
        const baseTime = getInputBaseTime();
        beginInteractionRenderFreeze(baseTime);
        const dragTargets = selectedObjectIds.includes(targetObject.id)
          ? visibleObjects.filter((object) => selectedObjectIds.includes(object.id) && object.type === 'rect')
          : [targetObject];
        setSelectedObjectIds(dragTargets.map((object) => object.id));
        setDragSession({
          objects: dragTargets.map((object) => ({
            objectId: object.id,
            objectOrigin: { x: object.x, y: object.y },
            objectSize: { width: object.width, height: object.height },
          })),
          pointerStart: point,
          pointerCurrent: point,
          baseTime,
          startedWallClock: now(),
          lastDispatchTime: baseTime,
        });
      } else {
        setSelectedObjectIds([]);
        const baseTime = getInputBaseTime();
        const baseViewport = getBaseViewport();
        beginInteractionRenderFreeze(baseTime);
        setPanSession({
          pointerStart: point,
          pointerStartScreen: { x: event.clientX, y: event.clientY },
          viewportOrigin: { ...baseViewport },
          startedWallClock: now(),
          baseTime,
          lastDispatchTime: baseTime,
        });
      }
    }
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const projectionRect = resolvePointerViewportRect();
    const point = toLocalPoint(event, projectionRect);
    if (!point) {
      setHoverPoint(null);
      return;
    }
    lastPointerWorldRef.current = point;
    const activeTool = activePointerToolRef.current ?? tool;
    const inputInProgress = !!(draftStroke || draftRect || dragSession || resizeSession || panSession || erasing);
    if (!inputInProgress) {
      setHoverPoint(point);
    }
    if (event.pointerType === 'touch') {
      return;
    }
    const allowContinuousTimelineEvents = recordingStatus === 'recording';

    if ((activeTool === 'pen' || activeTool === 'highlight') && draftStroke) {
      const nextTime = sampleSessionTime(draftStroke);
      const nativeEvent = event.nativeEvent as PointerEvent & {
        getCoalescedEvents?: () => PointerEvent[];
      };
      const coalesced = typeof nativeEvent.getCoalescedEvents === 'function'
        ? nativeEvent.getCoalescedEvents()
        : [];
      if (coalesced.length > 0) {
        let pushed = false;
        const coalescedStep = coalesced.length > 0 ? 0.45 / coalesced.length : 0;
        for (let index = 0; index < coalesced.length; index += 1) {
          const sampleEvent = coalesced[index];
          const samplePoint = toLocalPoint(sampleEvent, projectionRect);
          if (!samplePoint) {
            continue;
          }
          pushed = true;
          const sampleTime = nextTime + ((index + 1) * coalescedStep);
          pendingStrokeSamplesRef.current.push({
            point: samplePoint,
            time: sampleTime,
            pressure: resolvePointerPressure(sampleEvent),
          });
        }
        if (!pushed) {
          pendingStrokeSamplesRef.current.push({
            point,
            time: nextTime,
            pressure: resolvePointerPressure(nativeEvent),
          });
        } else {
          const last = pendingStrokeSamplesRef.current[pendingStrokeSamplesRef.current.length - 1];
          if (!last || Math.abs(last.point.x - point.x) > 0.0001 || Math.abs(last.point.y - point.y) > 0.0001) {
            pendingStrokeSamplesRef.current.push({
              point,
              time: nextTime,
              pressure: resolvePointerPressure(nativeEvent),
            });
          }
        }
      } else {
        pendingStrokeSamplesRef.current.push({
          point,
          time: nextTime,
          pressure: resolvePointerPressure(nativeEvent),
        });
      }
      schedulePendingStrokeSample();
      return;
    }

    if (activeTool === 'rect' && draftRect) {
      const nextTime = sampleSessionTime(draftRect);
      const rect = normalizeRect(draftRect.start, point);

      if (allowContinuousTimelineEvents && shouldDispatchAt(draftRect.lastDispatchTime, nextTime)) {
        updateObjectTransform(
          draftRect.objectId,
          {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          nextTime,
        );
      }

      setDraftRect((prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          current: point,
          lastDispatchTime: shouldDispatchAt(prev.lastDispatchTime, nextTime)
            ? nextTime
            : prev.lastDispatchTime,
        };
      });
      return;
    }

    if (activeTool === 'drag' && resizeSession) {
      const nextTime = sampleSessionTime(resizeSession);
      const nextBounds = normalizeRect(
        resizeRectFromHandle(
          resizeSession.originBounds,
          point,
          resizeSession.handle,
          boardWidth,
          boardHeight,
          MIN_OBJECT_SIZE,
        ),
      );

      if (allowContinuousTimelineEvents && shouldDispatchAt(resizeSession.lastDispatchTime, nextTime)) {
        resizeSession.objects.forEach((item) => {
          const rect = mapRectToResizedBounds(
            item.originRect,
            resizeSession.originBounds,
            nextBounds,
            MIN_OBJECT_SIZE,
          );
          updateObjectTransform(
            item.objectId,
            {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
            nextTime,
          );
        });
      }

      setResizeSession((prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          current: point,
          lastDispatchTime: shouldDispatchAt(prev.lastDispatchTime, nextTime)
            ? nextTime
            : prev.lastDispatchTime,
        };
      });
      return;
    }

    if (activeTool === 'drag' && dragSession) {
      const nextTime = sampleSessionTime(dragSession);
      const dx = point.x - dragSession.pointerStart.x;
      const dy = point.y - dragSession.pointerStart.y;
      if (allowContinuousTimelineEvents && shouldDispatchAt(dragSession.lastDispatchTime, nextTime)) {
        dragSession.objects.forEach((item) => {
          const nextXRaw = item.objectOrigin.x + dx;
          const nextYRaw = item.objectOrigin.y + dy;
          const snappedX = toolParameters.snap ? quantize(nextXRaw, SNAP_GRID_STEP) : nextXRaw;
          const snappedY = toolParameters.snap ? quantize(nextYRaw, SNAP_GRID_STEP) : nextYRaw;
          const clamped = clampObjectPositionToBoard(
            snappedX,
            snappedY,
            item.objectSize.width,
            item.objectSize.height,
            boardWidth,
            boardHeight,
          );
          updateObjectTransform(
            item.objectId,
            {
              x: clamped.x,
              y: clamped.y,
            },
            nextTime,
          );
        });
      }

      setDragSession((prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          pointerCurrent: point,
          lastDispatchTime: shouldDispatchAt(prev.lastDispatchTime, nextTime)
            ? nextTime
            : prev.lastDispatchTime,
        };
      });
      return;
    }

    if (activeTool === 'drag' && panSession) {
      const nextTime = sampleSessionTime(panSession);
      const rect = getViewportContentRect();
      const nextViewport = projectPanViewportFromScreenDelta(
        panSession.viewportOrigin,
        event.clientX - panSession.pointerStartScreen.x,
        event.clientY - panSession.pointerStartScreen.y,
        boardWidth,
        boardHeight,
        rect?.width ?? 0,
        rect?.height ?? 0,
      );

      if (allowContinuousTimelineEvents && shouldDispatchAt(panSession.lastDispatchTime, nextTime)) {
        commitViewport(nextViewport, nextTime);
      }

      setViewportPreview(nextViewport);

      setPanSession((prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          lastDispatchTime: shouldDispatchAt(prev.lastDispatchTime, nextTime)
            ? nextTime
            : prev.lastDispatchTime,
        };
      });
      return;
    }

    if (activeTool === 'erase' && erasing) {
      collectEraseTarget(point);
    }
  };

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.pointerType === 'touch') {
      return;
    }
    if (svgRef.current?.hasPointerCapture(event.pointerId)) {
      svgRef.current.releasePointerCapture(event.pointerId);
    }

    const activeTool = activePointerToolRef.current ?? tool;
    activePointerToolRef.current = null;
    activePointerIdRef.current = null;
    const point = toLocalPoint(event);
    if (point) {
      lastPointerWorldRef.current = point;
      setHoverPoint(point);
    } else {
      setHoverPoint(null);
    }
    if ((activeTool === 'pen' || activeTool === 'highlight') && draftStroke && draftStroke.samples.length > 0) {
      let strokeSamples = draftStroke.samples;
      let finalRenderPoints = draftStroke.renderPoints;
      let finalRenderPointTimes = draftStroke.renderPointTimes;
      let finalRenderPointPressures = draftStroke.renderPointPressures;
      const pendingSamples = pendingStrokeSamplesRef.current;
      if (pendingSamples.length > 0) {
        for (const sample of pendingSamples) {
          strokeSamples = appendInputStrokeSample(strokeSamples, sample);
        }
        const rendered = mapInputStrokeSamples(strokeSamples);
        finalRenderPoints = rendered.points;
        finalRenderPointTimes = rendered.pointTimes;
        finalRenderPointPressures = rendered.pointPressures;
      }
      clearPendingStrokeFrame();
      if (finalRenderPoints.length === 0 || finalRenderPointTimes.length === 0) {
        const fallback = mapInputStrokeSamples(strokeSamples);
        finalRenderPoints = fallback.points;
        finalRenderPointTimes = fallback.pointTimes;
        finalRenderPointPressures = fallback.pointPressures;
      }
      const finalStrokeTime = finalRenderPointTimes[finalRenderPointTimes.length - 1] ?? draftStroke.baseTime;
      if (recordingStatus === 'recording') {
        setRuntimeCurrentTime(finalStrokeTime);
      }
      const strokeId = createStroke({
        points: finalRenderPoints,
        pointTimes: finalRenderPointTimes,
        pointPressures: finalRenderPointPressures,
        kind: draftStroke.strokeKind,
        style: {
          color: draftStroke.strokeColor,
          width: draftStroke.worldWidth,
        },
        startTime: finalRenderPointTimes[0],
      });
      if (strokeId) {
        setCommittingStrokePreviews((prev) => {
          const nowMs = now();
          const retained = prev.filter((stroke) => (
            !renderedStrokeIdsRef.current.has(stroke.id)
            && (nowMs - stroke.createdWallClock) <= COMMITTING_STROKE_PREVIEW_TTL_MS
          ));
          const next = [
            ...retained,
            {
              id: strokeId,
              path: buildPerfectStrokePath(finalRenderPoints, draftStroke.worldWidth, {
                complete: true,
                pressures: finalRenderPointPressures,
                variant: draftStroke.strokeKind,
              }),
              color: draftStroke.strokeColor,
              createdWallClock: nowMs,
            },
          ];
          if (next.length <= COMMITTING_STROKE_PREVIEW_MAX) {
            return next;
          }
          return next.slice(next.length - COMMITTING_STROKE_PREVIEW_MAX);
        });
      }
      setDraftStroke(null);
      settleToolAfterCommit();
      clearInteractionRenderFreeze();
      return;
    }

    if (activeTool === 'rect' && draftRect) {
      const finalTime = sampleSessionTime(draftRect);
      const rect = normalizeRect(draftRect.start, draftRect.current);

      if (rect.width <= 3 || rect.height <= 3) {
        deleteObject(draftRect.objectId, finalTime);
      } else {
        updateObjectTransform(
          draftRect.objectId,
          {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          finalTime,
        );
      }

      setDraftRect(null);
      settleToolAfterCommit();
      clearInteractionRenderFreeze();
      return;
    }

    if (activeTool === 'drag' && resizeSession) {
      const finalTime = sampleSessionTime(resizeSession);
      const nextBounds = normalizeRect(
        resizeRectFromHandle(
          resizeSession.originBounds,
          resizeSession.current,
          resizeSession.handle,
          boardWidth,
          boardHeight,
          MIN_OBJECT_SIZE,
        ),
      );
      resizeSession.objects.forEach((item) => {
        const rect = mapRectToResizedBounds(
          item.originRect,
          resizeSession.originBounds,
          nextBounds,
          MIN_OBJECT_SIZE,
        );
        updateObjectTransform(
          item.objectId,
          {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          finalTime,
        );
      });

      setResizeSession(null);
      settleToolAfterCommit();
      clearInteractionRenderFreeze();
      return;
    }

    if (activeTool === 'drag' && dragSession) {
      const finalTime = sampleSessionTime(dragSession);
      const dx = dragSession.pointerCurrent.x - dragSession.pointerStart.x;
      const dy = dragSession.pointerCurrent.y - dragSession.pointerStart.y;
      dragSession.objects.forEach((item) => {
        const nextXRaw = item.objectOrigin.x + dx;
        const nextYRaw = item.objectOrigin.y + dy;
        const snappedX = toolParameters.snap ? quantize(nextXRaw, SNAP_GRID_STEP) : nextXRaw;
        const snappedY = toolParameters.snap ? quantize(nextYRaw, SNAP_GRID_STEP) : nextYRaw;
        const clamped = clampObjectPositionToBoard(
          snappedX,
          snappedY,
          item.objectSize.width,
          item.objectSize.height,
          boardWidth,
          boardHeight,
        );
        updateObjectTransform(
          item.objectId,
          {
            x: clamped.x,
            y: clamped.y,
          },
          finalTime,
        );
      });

      setDragSession(null);
      settleToolAfterCommit();
      clearInteractionRenderFreeze();
      return;
    }

    if (activeTool === 'drag' && panSession) {
      const finalTime = sampleSessionTime(panSession);
      const finalViewport = viewportPreview ?? renderViewport;
      commitViewport(finalViewport, finalTime);
      setPanSession(null);
      settleToolAfterCommit();
      clearInteractionRenderFreeze();
      return;
    }

    if (activeTool === 'erase') {
      setErasing(false);
      flushEraseSession();
      settleToolAfterCommit();
      clearInteractionRenderFreeze();
      return;
    }

    clearInteractionRenderFreeze();
    cancelToolInteraction();
  };

  const handlePointerLeave = (event: React.PointerEvent<SVGSVGElement>) => {
    setHoverPoint(null);
    if (event.pointerType !== 'mouse') {
      return;
    }
    handlePointerUp(event);
  };

  const handleTouchStart = (event: React.TouchEvent<SVGSVGElement>) => {
    if (inputLocked || event.touches.length < 2) {
      return;
    }
    const snapshot = getTwoTouchSnapshot(event.touches);
    if (!snapshot) {
      return;
    }
    if (!twoFingerGestureRef.current) {
      beginTwoFingerGesture(snapshot);
    }
    event.preventDefault();
  };

  const handleTouchMove = (event: React.TouchEvent<SVGSVGElement>) => {
    const gesture = twoFingerGestureRef.current;
    if (!gesture) {
      return;
    }
    const snapshot = getTwoTouchSnapshot(event.touches);
    if (!snapshot) {
      return;
    }
    const [a, b] = snapshot;
    const centerScreen = getGestureCenter(a, b);
    const distance = Math.max(1, getGestureDistance(a, b));
    const scaleRatio = distance / Math.max(1, gesture.initialDistance);
    const nextZoom = Math.max(0.2, Math.min(4, gesture.viewportOrigin.zoom * scaleRatio));
    const nextViewport = computeViewportFromScreenAnchor(
      gesture.initialCenterWorld,
      centerScreen,
      nextZoom,
    );

    gesture.latestViewport = nextViewport;
    setViewportPreview(nextViewport);

    if (recordingStatus === 'recording') {
      const nextTime = sampleSessionTime(gesture);
      if (shouldDispatchAt(gesture.lastDispatchTime, nextTime)) {
        commitViewport(nextViewport, nextTime);
        gesture.lastDispatchTime = nextTime;
      }
    }

    event.preventDefault();
  };

  const handleTouchEnd = (event: React.TouchEvent<SVGSVGElement>) => {
    const gesture = twoFingerGestureRef.current;
    if (!gesture) {
      return;
    }
    if (event.touches.length >= 2) {
      const snapshot = getTwoTouchSnapshot(event.touches);
      if (snapshot) {
        const [a, b] = snapshot;
        const centerScreen = getGestureCenter(a, b);
        const centerWorld = toLocalPoint({ clientX: centerScreen.x, clientY: centerScreen.y });
        if (centerWorld) {
          gesture.initialCenterScreen = centerScreen;
          gesture.initialCenterWorld = centerWorld;
          gesture.initialDistance = Math.max(1, getGestureDistance(a, b));
          gesture.viewportOrigin = { ...gesture.latestViewport };
        }
      }
      event.preventDefault();
      return;
    }

    commitTwoFingerGesture(gesture);
    event.preventDefault();
  };

  const handleWheel = (event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    if (inputLocked) {
      return;
    }

    if (twoFingerGestureRef.current) {
      return;
    }

    const nowTime = now();
    const session = wheelGestureRef.current ?? {
      startedWallClock: nowTime,
      baseTime: getInputBaseTime(),
      lastDispatchTime: getInputBaseTime(),
    };
    wheelGestureRef.current = session;

    const baseViewport = getBaseViewport();
    let nextViewport: ViewportValue = { ...baseViewport };

    if (event.ctrlKey || event.metaKey) {
      const anchor = toLocalPoint(event) ?? {
        x: baseViewport.x + (boardWidth / baseViewport.zoom) / 2,
        y: baseViewport.y + (boardHeight / baseViewport.zoom) / 2,
      };
      const zoomFactor = Math.exp(-event.deltaY * 0.0032);
      const nextZoom = Math.max(0.2, Math.min(4, baseViewport.zoom * zoomFactor));
      nextViewport = computeViewportForZoom(baseViewport, nextZoom, anchor);
    } else {
      const rect = getViewportContentRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        const unitsPerPxX = (boardWidth / baseViewport.zoom) / rect.width;
        const unitsPerPxY = (boardHeight / baseViewport.zoom) / rect.height;
        nextViewport = {
          x: baseViewport.x + (event.deltaX * unitsPerPxX),
          y: baseViewport.y + (event.deltaY * unitsPerPxY),
          zoom: baseViewport.zoom,
        };
      }
    }

    const clampedViewport = clampViewportToBoard(nextViewport, boardWidth, boardHeight);
    wheelViewportRef.current = clampedViewport;
    setViewportPreview(clampedViewport);

    if (recordingStatus === 'recording') {
      const nextTime = sampleSessionTime(session);
      if (shouldDispatchAt(session.lastDispatchTime, nextTime)) {
        commitViewport(clampedViewport, nextTime);
        session.lastDispatchTime = nextTime;
      }
      return;
    }

    clearWheelCommitTimer();
    wheelCommitTimerRef.current = platformSetTimeout(() => {
      flushWheelGesture(true);
    }, WHEEL_IDLE_COMMIT_DELAY_MS);
  };

  return (
    <section className="canvas-section">
      <div className="canvas-surface">
        {selectionToolbarPosition && selectedObjectIds.length > 0 && recordingStatus === 'idle' ? (
          <div
            className="object-context-toolbar panel"
            style={{
              left: selectionToolbarPosition.left,
              top: Math.max(18, selectionToolbarPosition.top - 18),
            }}
          >
            <button
              type="button"
              className="icon-btn"
              title="Rotate Left 15°"
              aria-label="Rotate Left 15°"
              onClick={() => applyObjectRotation(-15)}
            >
              <IoArrowUndoOutline size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Rotate Right 15°"
              aria-label="Rotate Right 15°"
              onClick={() => applyObjectRotation(15)}
            >
              <IoArrowRedoOutline size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Duplicate Selection"
              aria-label="Duplicate Selection"
              onClick={duplicateSelectedRects}
            >
              <IoCopyOutline size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Bring Forward"
              aria-label="Bring Forward"
              onClick={() => shiftSelectionLayer(1)}
            >
              <IoChevronUpOutline size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Send Backward"
              aria-label="Send Backward"
              onClick={() => shiftSelectionLayer(-1)}
            >
              <IoChevronDownOutline size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Bring To Front"
              aria-label="Bring To Front"
              onClick={() => reorderSelectionLayer('front')}
            >
              <IoArrowUpOutline size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Send To Back"
              aria-label="Send To Back"
              onClick={() => reorderSelectionLayer('back')}
            >
              <IoArrowDownOutline size={15} />
            </button>
            <button
              type="button"
              className="icon-btn danger"
              title="Delete Selection"
              aria-label="Delete Selection"
              onClick={() => {
                deleteObjects(selectedObjectIds, getInputBaseTime());
                setSelectedObjectIds([]);
              }}
            >
              <IoTrashOutline size={15} />
            </button>
            <span className="object-context-meta mono">
              {selectedObjectIds.length > 1
                ? `${selectedObjectIds.length} objs`
                : `${Math.round(selectedVisibleObject?.rotation ?? 0)}°`}
            </span>
          </div>
        ) : null}
        <ToolWorkbench
          tool={tool}
          phase={toolState.phase}
          parameters={toolParameters}
          disabled={inputLocked}
          onSelectTool={(nextTool) => {
            setToolState((prev) => transitionToolState(prev, { type: 'selectTool', tool: nextTool }));
          }}
          onStrokeColorChange={(value) => {
            setToolParameters((prev) => patchToolParameters(prev, { color: value }));
          }}
          onStrokeWidthChange={(value) => {
            setToolParameters((prev) => patchToolParameters(prev, { width: value }));
          }}
          onStrokeOpacityChange={(value) => {
            setToolParameters((prev) => patchToolParameters(prev, { opacity: value }));
          }}
          onHighlighterColorChange={(value) => {
            setToolParameters((prev) => patchToolParameters(prev, { highlighterColor: value }));
          }}
          onHighlighterWidthChange={(value) => {
            setToolParameters((prev) => patchToolParameters(prev, { highlighterWidth: value }));
          }}
          onHighlighterOpacityChange={(value) => {
            setToolParameters((prev) => patchToolParameters(prev, { highlighterOpacity: value }));
          }}
          onSnapChange={(value) => {
            setToolParameters((prev) => patchToolParameters(prev, { snap: value }));
          }}
          onEraserRadiusChange={(value) => {
            setToolParameters((prev) => patchToolParameters(prev, { eraserRadius: value }));
          }}
        />
        <div className="floating-controls floating-page-dock">
          <button
            type="button"
            className="icon-btn"
            title="Previous Page"
            aria-label="Previous Page"
            disabled={inputLocked || currentPageIndex <= 0}
            onClick={() => {
              if (currentPageIndex <= 0) {
                return;
              }
              switchPage(pageIds[currentPageIndex - 1]);
            }}
          >
            <IoChevronBackOutline size={15} />
          </button>
          <span className="mono page-indicator">
            {currentPageIndex + 1}/{Math.max(1, pageIds.length)}
          </span>
          <button
            type="button"
            className="icon-btn"
            title="Next Page"
            aria-label="Next Page"
            disabled={inputLocked || currentPageIndex >= pageIds.length - 1}
            onClick={() => {
              if (currentPageIndex >= pageIds.length - 1) {
                return;
              }
              switchPage(pageIds[currentPageIndex + 1]);
            }}
          >
            <IoChevronForwardOutline size={15} />
          </button>
          <button
            type="button"
            className={`icon-btn ${pagePreviewOpen ? 'selected' : ''}`}
            title="Page Preview"
            aria-label="Page Preview"
            onClick={() => setPagePreviewOpen((value) => !value)}
          >
            <IoImagesOutline size={15} />
          </button>
        </div>
        {pagePreviewOpen ? (
          <div className="page-preview-strip panel">
            <div className="page-preview-header">
              <strong>Pages</strong>
              <span className="mono">{currentPageIndex + 1}/{Math.max(1, pageIds.length)}</span>
            </div>
            {pageIds.map((pageId, index) => (
              <button
                key={pageId}
                type="button"
                className={`page-preview-item ${pageId === projectState.currentPageId ? 'active' : ''}`}
                onClick={() => {
                  switchPage(pageId);
                  setPagePreviewOpen(false);
                }}
              >
                <div className="page-preview-thumb">
                  {pagePreviewUrls[pageId] ? (
                    <img src={pagePreviewUrls[pageId]} alt={`Page ${index + 1}`} />
                  ) : (
                    <span>{index + 1}</span>
                  )}
                </div>
                <span className="page-preview-label">{orderedProjectPages[index]?.name ?? `Page ${index + 1}`}</span>
              </button>
            ))}
          </div>
        ) : null}
        <svg
          ref={svgRef}
          viewBox={`${renderViewport.x} ${renderViewport.y} ${boardWidth / renderViewport.zoom} ${boardHeight / renderViewport.zoom}`}
          preserveAspectRatio="none"
          className="whiteboard"
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
        >
          <defs>
            <pattern id="grid" width={80} height={80} patternUnits="userSpaceOnUse">
              <path d="M 80 0 L 0 0 0 80" fill="none" stroke="rgba(30,41,59,0.06)" strokeWidth="1" />
            </pattern>
          </defs>
          <rect x={-12000} y={-12000} width={24000} height={24000} fill="#f3f4f6" />
          <rect x={-12000} y={-12000} width={24000} height={24000} fill="url(#grid)" />
          {pageBackgroundUrl ? (
            <image
              href={pageBackgroundUrl}
              x={0}
              y={0}
              width={boardWidth}
              height={boardHeight}
              preserveAspectRatio="xMidYMid meet"
              opacity={0.95}
            />
          ) : null}

          {renderedVisibleStrokeNodes}

          {visibleObjects.map((object) => {
            if (object.type !== 'rect') {
              return null;
            }
            if (dragPreviewObjectIdSet.has(object.id)) {
              return null;
            }
            if (resizePreviewObjectIdSet.has(object.id)) {
              return null;
            }
            if (draftRect && object.id === draftRect.objectId) {
              return null;
            }

            return (
              <rect
                key={object.id}
                x={object.x}
                y={object.y}
                width={object.width}
                height={object.height}
                fill={(object.style?.fill as string) ?? 'rgba(14, 165, 233, 0.15)'}
                stroke={(object.style?.stroke as string) ?? '#0ea5e9'}
                strokeWidth={Number(object.style?.strokeWidth ?? 2)}
                transform={getObjectSvgTransform(object)}
              />
            );
          })}

          {dragPreviewObject.map((object) => (
            <rect
              key={object.id}
              x={object.x}
              y={object.y}
              width={object.width}
              height={object.height}
              fill={(object.style?.fill as string) ?? 'rgba(14, 165, 233, 0.15)'}
              stroke={(object.style?.stroke as string) ?? '#0ea5e9'}
              strokeWidth={Number(object.style?.strokeWidth ?? 2)}
              opacity={0.85}
              transform={getObjectSvgTransform(object)}
            />
          ))}

          {resizePreviewObjects.map((object) => (
            <rect
              key={`resize-preview-${object.id}`}
              x={object.x}
              y={object.y}
              width={object.width}
              height={object.height}
              fill={(object.style?.fill as string) ?? 'rgba(14, 165, 233, 0.15)'}
              stroke={(object.style?.stroke as string) ?? '#0ea5e9'}
              strokeWidth={Number(object.style?.strokeWidth ?? 2)}
              opacity={0.9}
              transform={getObjectSvgTransform(object)}
            />
          ))}

          {selectedVisibleObjects.map((object) => (
            <rect
              key={`selection-${object.id}`}
              x={object.x - 4}
              y={object.y - 4}
              width={object.width + 8}
              height={object.height + 8}
              fill="none"
              stroke="#0f766e"
              strokeWidth={1.5}
              strokeDasharray="6 4"
              pointerEvents="none"
              transform={getObjectSvgTransform(object)}
            />
          ))}

          {selectionBounds && selectedVisibleObjects.length > 1 ? (
            <rect
              x={selectionBounds.x - 10}
              y={selectionBounds.y - 10}
              width={selectionBounds.width + 20}
              height={selectionBounds.height + 20}
              fill="none"
              stroke="rgba(223, 201, 126, 0.96)"
              strokeWidth={2}
              strokeDasharray="10 8"
              rx={8}
              ry={8}
              pointerEvents="none"
            />
          ) : null}

          {resizeHandles.length > 0 ? resizeHandles.map((handle) => (
            <rect
              key={handle.handle}
              x={handle.point.x - ((handle.handle.length === 1 ? getWorldHandleRadius() * 1.15 : getWorldHandleRadius()) / 2)}
              y={handle.point.y - ((handle.handle.length === 1 ? getWorldHandleRadius() * 0.7 : getWorldHandleRadius()) / 2)}
              width={handle.handle.length === 1 ? getWorldHandleRadius() * 1.15 : getWorldHandleRadius()}
              height={handle.handle.length === 1 ? getWorldHandleRadius() * 0.7 : getWorldHandleRadius()}
              fill="#ffffff"
              stroke={handle.handle.length === 1 ? "rgba(223, 201, 126, 0.96)" : "#0f766e"}
              strokeWidth={1}
              rx={handle.handle.length === 1 ? 999 : 1.5}
              ry={handle.handle.length === 1 ? 999 : 1.5}
              pointerEvents="none"
            />
          )) : null}

        {previewStrokePath ? (
          <path
            d={previewStrokePath}
            fill={draftStroke!.strokeColor}
            stroke="none"
            opacity={0.98}
          />
          ) : null}

          {committingStrokePreviewNodes}

          {draftRect ? (
            (() => {
              const rect = normalizeRect(draftRect.start, draftRect.current);
              return (
                <rect
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  fill="rgba(14, 165, 233, 0.1)"
                  stroke="#0284c7"
                  strokeDasharray="8 6"
                  strokeWidth={1.5}
                />
              );
            })()
          ) : null}

          {hoverPoint && tool === 'rect' ? (
            <rect
              x={hoverPoint.x - 10 / renderViewport.zoom}
              y={hoverPoint.y - 10 / renderViewport.zoom}
              width={20 / renderViewport.zoom}
              height={20 / renderViewport.zoom}
              fill="none"
              stroke="rgba(255,255,255,0.82)"
              strokeWidth={1 / renderViewport.zoom}
              strokeDasharray={`${4 / renderViewport.zoom} ${4 / renderViewport.zoom}`}
              pointerEvents="none"
            />
          ) : null}

          {hoverPoint && hoverCursorRadius && (tool === 'pen' || tool === 'highlight' || tool === 'erase') ? (
            <circle
              cx={hoverPoint.x}
              cy={hoverPoint.y}
              r={hoverCursorRadius}
              fill={tool === 'erase' ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)'}
              stroke={tool === 'erase' ? 'rgba(255,187,187,0.92)' : 'rgba(255,255,255,0.88)'}
              strokeWidth={Math.max(0.75 / renderViewport.zoom, 0.4)}
              pointerEvents="none"
            />
          ) : null}
        </svg>

        <div className="floating-controls floating-history-dock">
          <button
            type="button"
            className="icon-btn"
            title="Undo"
            aria-label="Undo"
            onClick={undo}
            disabled={recordingStatus !== 'idle'}
          >
            <IoArrowUndoOutline size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Redo"
            aria-label="Redo"
            onClick={redo}
            disabled={recordingStatus !== 'idle'}
          >
            <IoArrowRedoOutline size={15} />
          </button>
        </div>

        <div className="floating-controls floating-zoom-dock">
          <button
            type="button"
            className="icon-btn"
            title="Zoom In"
            aria-label="Zoom In"
            onClick={() => applyZoom(renderViewport.zoom + 0.15)}
            disabled={inputLocked}
          >
            <IoAddOutline size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Reset Zoom"
            aria-label="Reset Zoom"
            onClick={() => resetViewport()}
            disabled={inputLocked}
          >
            <IoScanOutline size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Zoom Out"
            aria-label="Zoom Out"
            onClick={() => applyZoom(renderViewport.zoom - 0.15)}
            disabled={inputLocked}
          >
            <IoRemoveOutline size={15} />
          </button>
        </div>
      </div>
    </section>
  );
};
