import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  IoAddOutline,
  IoArrowRedoOutline,
  IoArrowUndoOutline,
  IoChevronBackOutline,
  IoChevronForwardOutline,
  IoImagesOutline,
  IoRemoveOutline,
  IoScanOutline,
} from 'react-icons/io5';
import { Point } from '../../domain/types';
import {
  getStrokePointsAtTime,
  getVisibleObjects,
  getVisibleStrokes,
} from '../../domain/selectors';
import { useWhiteboardStore } from '../../store/useWhiteboardStore';
import { hitRectObject, hitStroke, pointsToSvgPath } from '../../utils/geometry';
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
import { ToolWorkbench } from './ToolWorkbench';
import { recordingTimelineRuntime } from '../../application/clock/recordingTimelineRuntime';

type DraftStrokeSession = {
  points: Point[];
  pointTimes: number[];
  startedWallClock: number;
  baseTime: number;
  worldWidth: number;
  strokeColor: string;
  smoothing: number;
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
  objectId: string;
  pointerStart: Point;
  objectOrigin: Point;
  pointerCurrent: Point;
  startedWallClock: number;
  baseTime: number;
  lastDispatchTime: number;
};

type PanSession = {
  pointerStart: Point;
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
const STROKE_SAMPLE_STEP = 1.6;
const STROKE_MIN_DISTANCE = 0.1;
const SNAP_GRID_STEP = 8;

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const quantize = (value: number, step: number): number => {
  if (!Number.isFinite(value) || step <= 0) {
    return value;
  }
  return Math.round(value / step) * step;
};

const smoothStrokePoints = (points: Point[], smoothing: number): Point[] => {
  if (points.length <= 2) {
    return points;
  }
  const factor = clamp(smoothing, 0, 1);
  if (factor <= 0.01) {
    return points;
  }
  const alpha = clamp(1 - factor * 0.88, 0.08, 0.92);
  const output: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = output[i - 1];
    const next = points[i];
    output.push({
      x: prev.x + (next.x - prev.x) * alpha,
      y: prev.y + (next.y - prev.y) * alpha,
    });
  }
  output.push(points[points.length - 1]);
  return output;
};

export const WhiteboardCanvas: React.FC = () => {
  const projectState = useWhiteboardStore((s) => s.state);
  const projectPagesMeta = useWhiteboardStore((s) => s.project.pages);
  const currentTime = useWhiteboardStore((s) => s.currentTime);
  const recordingStatus = useWhiteboardStore((s) => s.recordingStatus);
  const undo = useWhiteboardStore((s) => s.undo);
  const redo = useWhiteboardStore((s) => s.redo);

  const {
    createStroke,
    eraseStroke,
    createRect,
    updateObjectTransform,
    deleteObject,
    setViewport,
    switchPage,
  } = useWhiteboardUseCases();

  const [toolState, setToolState] = useState(INITIAL_TOOL_STATE);
  const [toolParameters, setToolParameters] = useState(DEFAULT_TOOL_PARAMETERS);
  const [draftStroke, setDraftStroke] = useState<DraftStrokeSession | null>(null);
  const [draftRect, setDraftRect] = useState<DraftRectSession | null>(null);
  const [dragSession, setDragSession] = useState<DragSession | null>(null);
  const [panSession, setPanSession] = useState<PanSession | null>(null);
  const [erasing, setErasing] = useState(false);
  const [viewportPreview, setViewportPreview] = useState<ViewportValue | null>(null);
  const [pageBackgroundUrl, setPageBackgroundUrl] = useState<string | null>(null);
  const [pagePreviewOpen, setPagePreviewOpen] = useState(false);
  const [pagePreviewUrls, setPagePreviewUrls] = useState<Record<string, string>>({});

  const eraseSessionRef = useRef<EraseSession | null>(null);
  const twoFingerGestureRef = useRef<TwoFingerGestureSession | null>(null);
  const wheelGestureRef = useRef<WheelGestureSession | null>(null);
  const wheelViewportRef = useRef<ViewportValue | null>(null);
  const wheelCommitTimerRef = useRef<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const activePointerToolRef = useRef<ToolId | null>(null);
  const lastPointerWorldRef = useRef<Point | null>(null);
  const tool = toolState.tool;

  const visibleStrokes = useMemo(
    () => getVisibleStrokes(projectState, currentTime),
    [projectState, currentTime],
  );

  const visibleObjects = useMemo(
    () => getVisibleObjects(projectState, currentTime),
    [projectState, currentTime],
  );

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
          URL.revokeObjectURL(url);
        }
        return;
      }
      objectUrl = url;
      setPageBackgroundUrl(url);
    });

    return () => {
      disposed = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
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
          URL.revokeObjectURL(url);
        }
        return;
      }
      setPagePreviewUrls(next);
    };
    void run();

    return () => {
      disposed = true;
      for (const url of revokes) {
        URL.revokeObjectURL(url);
      }
    };
  }, [orderedProjectPages]);

  const toLocalPoint = (event: { clientX: number; clientY: number }): Point | null => {
    const svg = svgRef.current;
    if (!svg) {
      return null;
    }

    const ctm = svg.getScreenCTM();
    if (!ctm) {
      return null;
    }
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(ctm.inverse());
    const x = local.x;
    const y = local.y;

    return { x, y };
  };

  const now = (): number => performance.now();

  const getInputBaseTime = (): number => {
    if (recordingStatus === 'recording' && recordingTimelineRuntime.isStarted()) {
      return recordingTimelineRuntime.getTimelineNowMs(currentTime);
    }
    return normalizeTimelineTime(currentTime);
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

  const appendStrokeSamples = (
    points: Point[],
    pointTimes: number[],
    nextPoint: Point,
    nextTime: number,
  ): { points: Point[]; pointTimes: number[] } => {
    if (points.length === 0 || pointTimes.length === 0) {
      return {
        points: [nextPoint],
        pointTimes: [nextTime],
      };
    }

    const lastPoint = points[points.length - 1];
    const lastTime = pointTimes[pointTimes.length - 1];
    const distance = Math.hypot(nextPoint.x - lastPoint.x, nextPoint.y - lastPoint.y);
    if (distance < STROKE_MIN_DISTANCE) {
      return { points, pointTimes };
    }

    const segmentCount = Math.max(1, Math.ceil(distance / STROKE_SAMPLE_STEP));
    const nextPoints = [...points];
    const nextTimes = [...pointTimes];
    for (let i = 1; i <= segmentCount; i += 1) {
      const t = i / segmentCount;
      nextPoints.push({
        x: lastPoint.x + (nextPoint.x - lastPoint.x) * t,
        y: lastPoint.y + (nextPoint.y - lastPoint.y) * t,
      });
      nextTimes.push(lastTime + (nextTime - lastTime) * t);
    }
    return { points: nextPoints, pointTimes: nextTimes };
  };

  const getWorldStrokeWidth = (uiWidth: number): number => {
    const safeZoom = Math.max(0.2, renderViewport.zoom);
    return Math.max(0.2, uiWidth / safeZoom);
  };

  const getWorldEraserRadius = (uiRadius: number): number => {
    const safeZoom = Math.max(0.2, renderViewport.zoom);
    return Math.max(1.5, uiRadius / safeZoom);
  };

  const getEffectiveStrokeStyle = (toolId: ToolId): { color: string; width: number; smoothing: number } => {
    if (toolId === 'highlight') {
      return {
        color: highlighterStrokeColor,
        width: toolParameters.highlighterWidth,
        smoothing: Math.max(0.2, toolParameters.smoothing),
      };
    }
    return {
      color: penStrokeColor,
      width: toolParameters.width,
      smoothing: toolParameters.smoothing,
    };
  };

  const applyZoom = (nextZoom: number, anchor?: Point, time?: number) => {
    flushWheelGesture(false);
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

    setViewportPreview(null);
    setViewport(
      {
        x: nextX,
        y: nextY,
        zoom: safeZoom,
      },
      time ?? getInputBaseTime(),
    );
  };

  const resetViewport = (time?: number) => {
    flushWheelGesture(false);
    setViewportPreview(null);
    wheelViewportRef.current = null;
    setViewport(
      {
        x: 0,
        y: 0,
        zoom: 1,
      },
      time ?? getInputBaseTime(),
    );
  };

  const normalizeRect = (start: Point, current: Point) => {
    const x = Math.min(start.x, current.x);
    const y = Math.min(start.y, current.y);
    const width = Math.abs(start.x - current.x);
    const height = Math.abs(start.y - current.y);
    if (!toolParameters.snap) {
      return { x, y, width, height };
    }
    return {
      x: quantize(x, SNAP_GRID_STEP),
      y: quantize(y, SNAP_GRID_STEP),
      width: Math.max(SNAP_GRID_STEP, quantize(width, SNAP_GRID_STEP)),
      height: Math.max(SNAP_GRID_STEP, quantize(height, SNAP_GRID_STEP)),
    };
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
    return {
      x: anchor.x - clampedRatioX * nextWidth,
      y: anchor.y - clampedRatioY * nextHeight,
      zoom: safeZoom,
    };
  };

  const computeViewportFromScreenAnchor = (
    anchorWorld: Point,
    centerScreen: ScreenPoint,
    nextZoom: number,
  ): ViewportValue => {
    const svg = svgRef.current;
    const rect = svg?.getBoundingClientRect();
    const safeZoom = Math.max(0.2, Math.min(4, nextZoom));
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return {
        x: anchorWorld.x,
        y: anchorWorld.y,
        zoom: safeZoom,
      };
    }

    const unitsPerScreenX = (boardWidth / safeZoom) / rect.width;
    const unitsPerScreenY = (boardHeight / safeZoom) / rect.height;
    return {
      x: anchorWorld.x - ((centerScreen.x - rect.left) * unitsPerScreenX),
      y: anchorWorld.y - ((centerScreen.y - rect.top) * unitsPerScreenY),
      zoom: safeZoom,
    };
  };

  const getBaseViewport = (): ViewportValue => {
    return wheelViewportRef.current ?? viewportPreview ?? viewport;
  };

  const clearWheelCommitTimer = () => {
    if (wheelCommitTimerRef.current !== null) {
      window.clearTimeout(wheelCommitTimerRef.current);
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
      setViewport(latest, nextTime);
    }
    clearWheelCommitTimer();
    wheelGestureRef.current = null;
    wheelViewportRef.current = null;
    setViewportPreview(null);
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
    flushWheelGesture(false);

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
    setViewport(gesture.latestViewport, finalTime);
    twoFingerGestureRef.current = null;
    setViewportPreview(null);
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
        const points = getStrokePointsAtTime(stroke, currentTime);
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

    eraseSessionRef.current = null;
  };

  const clearTransientSessions = () => {
    setDraftStroke(null);
    setDragSession(null);
    setPanSession(null);
    setErasing(false);
    eraseSessionRef.current = null;
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
    twoFingerGestureRef.current = null;
    flushWheelGesture(false);
    setViewportPreview(null);
    setPagePreviewOpen(false);
    clearTransientSessions();
    cancelToolInteraction();
  }, [recordingStatus]);

  useEffect(() => {
    return () => {
      clearWheelCommitTimer();
    };
  }, []);

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
    flushWheelGesture(false);
    svgRef.current.setPointerCapture(event.pointerId);
    activePointerToolRef.current = tool;

    if (tool === 'pen' || tool === 'highlight') {
      const baseTime = getInputBaseTime();
      const startedWallClock = now();
      const style = getEffectiveStrokeStyle(tool);
      setToolState((prev) => transitionToolState(prev, { type: 'beginInteraction' }));
      setDraftStroke({
        points: [point],
        pointTimes: [baseTime],
        baseTime,
        startedWallClock,
        worldWidth: getWorldStrokeWidth(style.width),
        strokeColor: style.color,
        smoothing: style.smoothing,
      });
      return;
    }

    if (tool === 'rect') {
      const baseTime = getInputBaseTime();
      const startedWallClock = now();
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
      setToolState((prev) => transitionToolState(prev, { type: 'beginInteraction' }));
      const targetObject = [...visibleObjects]
        .reverse()
        .find((object) => object.type === 'rect' && hitRectObject(point, object));

      if (targetObject) {
        const baseTime = getInputBaseTime();
        setDragSession({
          objectId: targetObject.id,
          pointerStart: point,
          pointerCurrent: point,
          objectOrigin: { x: targetObject.x, y: targetObject.y },
          baseTime,
          startedWallClock: now(),
          lastDispatchTime: baseTime,
        });
      } else {
        const baseTime = getInputBaseTime();
        const baseViewport = getBaseViewport();
        setPanSession({
          pointerStart: point,
          viewportOrigin: { ...baseViewport },
          startedWallClock: now(),
          baseTime,
          lastDispatchTime: baseTime,
        });
      }
    }
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const point = toLocalPoint(event);
    if (!point) {
      return;
    }
    lastPointerWorldRef.current = point;
    if (event.pointerType === 'touch') {
      return;
    }

    const activeTool = activePointerToolRef.current ?? tool;
    const allowContinuousTimelineEvents = recordingStatus === 'recording';

    if ((activeTool === 'pen' || activeTool === 'highlight') && draftStroke) {
      const nextTime = sampleSessionTime(draftStroke);
      setDraftStroke((prev) => {
        if (!prev) {
          return prev;
        }
        const sampled = appendStrokeSamples(prev.points, prev.pointTimes, point, nextTime);
        return {
          ...prev,
          points: sampled.points,
          pointTimes: sampled.pointTimes,
        };
      });
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

    if (activeTool === 'drag' && dragSession) {
      const nextTime = sampleSessionTime(dragSession);
      const dx = point.x - dragSession.pointerStart.x;
      const dy = point.y - dragSession.pointerStart.y;
      const nextXRaw = dragSession.objectOrigin.x + dx;
      const nextYRaw = dragSession.objectOrigin.y + dy;
      const nextX = toolParameters.snap ? quantize(nextXRaw, SNAP_GRID_STEP) : nextXRaw;
      const nextY = toolParameters.snap ? quantize(nextYRaw, SNAP_GRID_STEP) : nextYRaw;

      if (allowContinuousTimelineEvents && shouldDispatchAt(dragSession.lastDispatchTime, nextTime)) {
        updateObjectTransform(
          dragSession.objectId,
          {
            x: nextX,
            y: nextY,
          },
          nextTime,
        );
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
      const dx = point.x - panSession.pointerStart.x;
      const dy = point.y - panSession.pointerStart.y;
      const nextViewport = {
        x: panSession.viewportOrigin.x - dx,
        y: panSession.viewportOrigin.y - dy,
        zoom: panSession.viewportOrigin.zoom,
      };

      if (allowContinuousTimelineEvents && shouldDispatchAt(panSession.lastDispatchTime, nextTime)) {
        setViewport(nextViewport, nextTime);
      }

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
    const point = toLocalPoint(event);
    if (point) {
      lastPointerWorldRef.current = point;
    }

    if ((activeTool === 'pen' || activeTool === 'highlight') && draftStroke && draftStroke.points.length > 0) {
      const smoothedPoints = smoothStrokePoints(draftStroke.points, draftStroke.smoothing);
      createStroke({
        points: smoothedPoints,
        pointTimes: draftStroke.pointTimes,
        style: {
          color: draftStroke.strokeColor,
          width: draftStroke.worldWidth,
        },
        startTime: draftStroke.pointTimes[0],
      });
      setDraftStroke(null);
      settleToolAfterCommit();
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
      return;
    }

    if (activeTool === 'drag' && dragSession) {
      const finalTime = sampleSessionTime(dragSession);
      const dx = dragSession.pointerCurrent.x - dragSession.pointerStart.x;
      const dy = dragSession.pointerCurrent.y - dragSession.pointerStart.y;
      const nextXRaw = dragSession.objectOrigin.x + dx;
      const nextYRaw = dragSession.objectOrigin.y + dy;
      const nextX = toolParameters.snap ? quantize(nextXRaw, SNAP_GRID_STEP) : nextXRaw;
      const nextY = toolParameters.snap ? quantize(nextYRaw, SNAP_GRID_STEP) : nextYRaw;

      updateObjectTransform(
        dragSession.objectId,
        {
          x: nextX,
          y: nextY,
        },
        finalTime,
      );

      setDragSession(null);
      settleToolAfterCommit();
      return;
    }

    if (activeTool === 'drag' && panSession) {
      const finalTime = sampleSessionTime(panSession);
      const point = toLocalPoint(event);
      if (point) {
        const dx = point.x - panSession.pointerStart.x;
        const dy = point.y - panSession.pointerStart.y;
        setViewport(
          {
            x: panSession.viewportOrigin.x - dx,
            y: panSession.viewportOrigin.y - dy,
            zoom: panSession.viewportOrigin.zoom,
          },
          finalTime,
        );
      }
      setPanSession(null);
      settleToolAfterCommit();
      return;
    }

    if (activeTool === 'erase') {
      setErasing(false);
      flushEraseSession();
      settleToolAfterCommit();
      return;
    }

    cancelToolInteraction();
  };

  const handlePointerLeave = (event: React.PointerEvent<SVGSVGElement>) => {
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
        setViewport(nextViewport, nextTime);
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
      const rect = svgRef.current?.getBoundingClientRect();
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

    wheelViewportRef.current = nextViewport;
    setViewportPreview(nextViewport);

    if (recordingStatus === 'recording') {
      const nextTime = sampleSessionTime(session);
      if (shouldDispatchAt(session.lastDispatchTime, nextTime)) {
        setViewport(nextViewport, nextTime);
        session.lastDispatchTime = nextTime;
      }
      return;
    }

    clearWheelCommitTimer();
    wheelCommitTimerRef.current = window.setTimeout(() => {
      flushWheelGesture(true);
    }, WHEEL_IDLE_COMMIT_DELAY_MS);
  };

  return (
    <section className="canvas-section">
      <div className="canvas-surface">
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
          onSmoothingChange={(value) => {
            setToolParameters((prev) => patchToolParameters(prev, { smoothing: value }));
          }}
          onSnapChange={(value) => {
            setToolParameters((prev) => patchToolParameters(prev, { snap: value }));
          }}
          onEraserRadiusChange={(value) => {
            setToolParameters((prev) => patchToolParameters(prev, { eraserRadius: value }));
          }}
        />
        <div className="floating-controls floating-top-right">
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
                <span className="mono">{index + 1}</span>
              </button>
            ))}
          </div>
        ) : null}
        <svg
          ref={svgRef}
          viewBox={`${renderViewport.x} ${renderViewport.y} ${boardWidth / renderViewport.zoom} ${boardHeight / renderViewport.zoom}`}
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
              <path d="M 80 0 L 0 0 0 80" fill="none" stroke="rgba(100,116,139,0.16)" strokeWidth="1" />
            </pattern>
          </defs>
          <rect x={-12000} y={-12000} width={24000} height={24000} fill="#fffdf8" />
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

          {visibleStrokes.map((stroke) => {
            const points = getStrokePointsAtTime(stroke, currentTime);
            if (points.length === 0) {
              return null;
            }
            return (
              <path
                key={stroke.id}
                d={pointsToSvgPath(points)}
                fill="none"
              stroke={stroke.color}
              strokeWidth={stroke.width}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}

          {visibleObjects.map((object) => {
            if (object.type !== 'rect') {
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
              />
            );
          })}

          {draftStroke && draftStroke.points.length > 0 ? (
            <path
              d={pointsToSvgPath(draftStroke.points)}
              fill="none"
              stroke={draftStroke.strokeColor}
              strokeWidth={draftStroke.worldWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.7}
            />
          ) : null}

          {draftRect ? (
            <rect
              x={Math.min(draftRect.start.x, draftRect.current.x)}
              y={Math.min(draftRect.start.y, draftRect.current.y)}
              width={Math.abs(draftRect.start.x - draftRect.current.x)}
              height={Math.abs(draftRect.start.y - draftRect.current.y)}
              fill="rgba(14, 165, 233, 0.1)"
              stroke="#0284c7"
              strokeDasharray="8 6"
              strokeWidth={1.5}
            />
          ) : null}
        </svg>

        <div className="floating-controls floating-left">
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

        <div className="floating-controls floating-right">
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
