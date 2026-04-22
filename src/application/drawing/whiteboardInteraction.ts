import { Point } from '../../domain/types';

export type WhiteboardViewport = {
  x: number;
  y: number;
  zoom: number;
};

export type WhiteboardScreenRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type RectResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const shouldHandleCanvasDeleteKey = (
  key: string,
  targetTagName?: string | null,
  targetIsContentEditable?: boolean,
): boolean => {
  if (key !== 'Backspace' && key !== 'Delete') {
    return false;
  }
  if (targetIsContentEditable) {
    return false;
  }
  const tag = (targetTagName ?? '').toUpperCase();
  return tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT';
};

export const toggleObjectSelection = (
  selectedIds: string[],
  targetId: string,
  multiSelect: boolean,
): string[] => {
  if (!multiSelect) {
    return [targetId];
  }
  if (selectedIds.includes(targetId)) {
    return selectedIds.filter((id) => id !== targetId);
  }
  return [...selectedIds, targetId];
};

export const pruneObjectSelection = (
  selectedIds: string[],
  visibleIds: string[],
): string[] => {
  const visible = new Set(visibleIds);
  return selectedIds.filter((id) => visible.has(id));
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

export const resolveWhiteboardViewportRect = (
  rect: WhiteboardScreenRect,
  boardWidth: number,
  boardHeight: number,
): WhiteboardScreenRect | null => {
  if (rect.width <= 0 || rect.height <= 0 || boardWidth <= 0 || boardHeight <= 0) {
    return null;
  }

  const boardAspect = boardWidth / boardHeight;
  const rectAspect = rect.width / rect.height;

  if (!Number.isFinite(boardAspect) || !Number.isFinite(rectAspect)) {
    return null;
  }

  if (Math.abs(boardAspect - rectAspect) < 0.0001) {
    return rect;
  }

  if (rectAspect > boardAspect) {
    const fittedWidth = rect.height * boardAspect;
    const insetX = (rect.width - fittedWidth) / 2;
    return {
      left: rect.left + insetX,
      top: rect.top,
      width: fittedWidth,
      height: rect.height,
    };
  }

  const fittedHeight = rect.width / boardAspect;
  const insetY = (rect.height - fittedHeight) / 2;
  return {
    left: rect.left,
    top: rect.top + insetY,
    width: rect.width,
    height: fittedHeight,
  };
};

export const clampViewportToBoard = (
  viewport: WhiteboardViewport,
  boardWidth: number,
  boardHeight: number,
): WhiteboardViewport => {
  const safeZoom = Math.max(0.2, Math.min(4, viewport.zoom));
  const visibleWidth = boardWidth / safeZoom;
  const visibleHeight = boardHeight / safeZoom;

  const x = visibleWidth >= boardWidth
    ? (boardWidth - visibleWidth) / 2
    : clamp(viewport.x, 0, boardWidth - visibleWidth);
  const y = visibleHeight >= boardHeight
    ? (boardHeight - visibleHeight) / 2
    : clamp(viewport.y, 0, boardHeight - visibleHeight);

  return {
    x,
    y,
    zoom: safeZoom,
  };
};

export const projectPanViewportFromScreenDelta = (
  origin: WhiteboardViewport,
  deltaScreenX: number,
  deltaScreenY: number,
  boardWidth: number,
  boardHeight: number,
  viewportPxWidth: number,
  viewportPxHeight: number,
): WhiteboardViewport => {
  if (viewportPxWidth <= 0 || viewportPxHeight <= 0) {
    return clampViewportToBoard(origin, boardWidth, boardHeight);
  }

  const unitsPerScreenX = (boardWidth / origin.zoom) / viewportPxWidth;
  const unitsPerScreenY = (boardHeight / origin.zoom) / viewportPxHeight;

  return clampViewportToBoard(
    {
      x: origin.x - (deltaScreenX * unitsPerScreenX),
      y: origin.y - (deltaScreenY * unitsPerScreenY),
      zoom: origin.zoom,
    },
    boardWidth,
    boardHeight,
  );
};

export const projectScreenPointToWorld = (
  clientX: number,
  clientY: number,
  rect: WhiteboardScreenRect,
  viewport: WhiteboardViewport,
  boardWidth: number,
  boardHeight: number,
): Point | null => {
  const viewportRect = resolveWhiteboardViewportRect(rect, boardWidth, boardHeight);
  if (!viewportRect || viewportRect.width <= 0 || viewportRect.height <= 0) {
    return null;
  }

  const localRatioX = (clientX - viewportRect.left) / viewportRect.width;
  const localRatioY = (clientY - viewportRect.top) / viewportRect.height;
  if (localRatioX < 0 || localRatioX > 1 || localRatioY < 0 || localRatioY > 1) {
    return null;
  }
  const visibleWidth = boardWidth / viewport.zoom;
  const visibleHeight = boardHeight / viewport.zoom;

  return {
    x: viewport.x + (localRatioX * visibleWidth),
    y: viewport.y + (localRatioY * visibleHeight),
  };
};

export const projectScreenPointToWorldInResolvedViewportRect = (
  clientX: number,
  clientY: number,
  viewportRect: WhiteboardScreenRect,
  viewport: WhiteboardViewport,
  boardWidth: number,
  boardHeight: number,
  options?: {
    allowOutsideViewport?: boolean;
  },
): Point | null => {
  if (viewportRect.width <= 0 || viewportRect.height <= 0 || boardWidth <= 0 || boardHeight <= 0) {
    return null;
  }

  const localRatioX = (clientX - viewportRect.left) / viewportRect.width;
  const localRatioY = (clientY - viewportRect.top) / viewportRect.height;
  const allowOutsideViewport = options?.allowOutsideViewport ?? false;
  if (
    !allowOutsideViewport
    && (localRatioX < 0 || localRatioX > 1 || localRatioY < 0 || localRatioY > 1)
  ) {
    return null;
  }

  const visibleWidth = boardWidth / viewport.zoom;
  const visibleHeight = boardHeight / viewport.zoom;
  return {
    x: viewport.x + (localRatioX * visibleWidth),
    y: viewport.y + (localRatioY * visibleHeight),
  };
};

export const clampRectToBoard = (
  start: Point,
  current: Point,
  boardWidth: number,
  boardHeight: number,
): { x: number; y: number; width: number; height: number } => {
  const minX = clamp(Math.min(start.x, current.x), 0, boardWidth);
  const minY = clamp(Math.min(start.y, current.y), 0, boardHeight);
  const maxX = clamp(Math.max(start.x, current.x), 0, boardWidth);
  const maxY = clamp(Math.max(start.y, current.y), 0, boardHeight);

  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
};

export const getResizeHandleAnchor = (
  rect: { x: number; y: number; width: number; height: number },
  handle: RectResizeHandle,
): Point => {
  switch (handle) {
    case 'nw':
      return { x: rect.x + rect.width, y: rect.y + rect.height };
    case 'n':
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
    case 'ne':
      return { x: rect.x, y: rect.y + rect.height };
    case 'e':
      return { x: rect.x, y: rect.y + rect.height / 2 };
    case 'se':
      return { x: rect.x, y: rect.y };
    case 's':
      return { x: rect.x + rect.width / 2, y: rect.y };
    case 'sw':
      return { x: rect.x + rect.width, y: rect.y };
    case 'w':
      return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
  }
};

export const getRectResizeHandles = (
  rect: { x: number; y: number; width: number; height: number },
): Array<{ handle: RectResizeHandle; point: Point }> => [
  { handle: 'nw', point: { x: rect.x, y: rect.y } },
  { handle: 'n', point: { x: rect.x + rect.width / 2, y: rect.y } },
  { handle: 'ne', point: { x: rect.x + rect.width, y: rect.y } },
  { handle: 'e', point: { x: rect.x + rect.width, y: rect.y + rect.height / 2 } },
  { handle: 'se', point: { x: rect.x + rect.width, y: rect.y + rect.height } },
  { handle: 's', point: { x: rect.x + rect.width / 2, y: rect.y + rect.height } },
  { handle: 'sw', point: { x: rect.x, y: rect.y + rect.height } },
  { handle: 'w', point: { x: rect.x, y: rect.y + rect.height / 2 } },
];

export const getSelectionBounds = (
  rects: Array<{ x: number; y: number; width: number; height: number }>,
): { x: number; y: number; width: number; height: number } | null => {
  if (rects.length <= 0) {
    return null;
  }
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
};

export const resizeRectFromHandle = (
  origin: { x: number; y: number; width: number; height: number },
  current: Point,
  handle: RectResizeHandle,
  boardWidth: number,
  boardHeight: number,
  minSize: number,
): { x: number; y: number; width: number; height: number } => {
  const maxRight = boardWidth;
  const maxBottom = boardHeight;

  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.width;
  let bottom = origin.y + origin.height;

  if (handle.includes('w')) {
    left = clamp(current.x, 0, right - minSize);
  }
  if (handle.includes('e')) {
    right = clamp(current.x, left + minSize, maxRight);
  }
  if (handle.includes('n')) {
    top = clamp(current.y, 0, bottom - minSize);
  }
  if (handle.includes('s')) {
    bottom = clamp(current.y, top + minSize, maxBottom);
  }

  if (handle === 'n' || handle === 's') {
    left = clamp(origin.x, 0, maxRight - origin.width);
    right = clamp(left + origin.width, minSize, maxRight);
  }

  if (handle === 'e' || handle === 'w') {
    top = clamp(origin.y, 0, maxBottom - origin.height);
    bottom = clamp(top + origin.height, minSize, maxBottom);
  }

  return {
    x: left,
    y: top,
    width: Math.max(minSize, right - left),
    height: Math.max(minSize, bottom - top),
  };
};

export const mapRectToResizedBounds = (
  rect: { x: number; y: number; width: number; height: number },
  originBounds: { x: number; y: number; width: number; height: number },
  nextBounds: { x: number; y: number; width: number; height: number },
  minSize: number,
): { x: number; y: number; width: number; height: number } => {
  const originWidth = Math.max(1, originBounds.width);
  const originHeight = Math.max(1, originBounds.height);
  const nextLeftRatio = (rect.x - originBounds.x) / originWidth;
  const nextTopRatio = (rect.y - originBounds.y) / originHeight;
  const nextRightRatio = (rect.x + rect.width - originBounds.x) / originWidth;
  const nextBottomRatio = (rect.y + rect.height - originBounds.y) / originHeight;

  const nextLeft = nextBounds.x + (nextBounds.width * nextLeftRatio);
  const nextTop = nextBounds.y + (nextBounds.height * nextTopRatio);
  const nextRight = nextBounds.x + (nextBounds.width * nextRightRatio);
  const nextBottom = nextBounds.y + (nextBounds.height * nextBottomRatio);

  return {
    x: nextLeft,
    y: nextTop,
    width: Math.max(minSize, nextRight - nextLeft),
    height: Math.max(minSize, nextBottom - nextTop),
  };
};

export const clampObjectPositionToBoard = (
  x: number,
  y: number,
  width: number,
  height: number,
  boardWidth: number,
  boardHeight: number,
): Point => {
  return {
    x: clamp(x, 0, Math.max(0, boardWidth - width)),
    y: clamp(y, 0, Math.max(0, boardHeight - height)),
  };
};
