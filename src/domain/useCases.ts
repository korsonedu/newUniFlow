import { useMemo } from 'react';
import {
  ObjectCreatePayload,
  ObjectUpdatePayload,
  Point,
  TimelineEvent,
  TimelineEventDraft,
  TimelineEventOfType,
  TimelineEventPayloadByType,
  TimelineEventType,
  ViewportSetPayload,
} from './types';
import { whiteboardGateway } from '../infrastructure/store/whiteboardGateway';
import { generateId } from '../utils/id';

export type StrokeStyle = {
  color: string;
  width: number;
};

export type StrokeCreateInput = {
  points: Point[];
  pointTimes?: number[];
  pointPressures?: number[];
  kind?: 'pen' | 'highlight';
  style: StrokeStyle;
  startTime?: number;
};

export type RectInput = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  style?: Record<string, unknown>;
};

type DispatchOptions = {
  pageId?: string;
  targetId?: string;
  payload?: TimelineEventPayloadByType[TimelineEventType];
  time?: number;
};

export type WhiteboardUseCaseDeps = {
  getCurrentPageId: () => string;
  getCurrentTime: () => number;
  createTimelineEvent: <T extends TimelineEventType>(
    event: TimelineEventDraft<T> & { time?: number },
  ) => TimelineEventOfType<T>;
  dispatchEvent: (event: TimelineEvent) => void;
};

export type WhiteboardUseCases = ReturnType<typeof createWhiteboardUseCases>;

export const createWhiteboardUseCases = (deps: WhiteboardUseCaseDeps) => {
  const dispatchAt = <T extends TimelineEventType>(type: T, options: DispatchOptions = {}) => {
    const event = deps.createTimelineEvent({
      pageId: options.pageId ?? deps.getCurrentPageId(),
      type,
      targetId: options.targetId,
      payload: options.payload as TimelineEventPayloadByType[T],
      time: options.time ?? deps.getCurrentTime(),
    });

    deps.dispatchEvent(event as TimelineEvent);
    return event;
  };

  const createStroke = (input: StrokeCreateInput): string | null => {
    const {
      points,
      pointTimes,
      pointPressures,
      kind,
      style,
      startTime,
    } = input;
    if (points.length === 0) {
      return null;
    }

    const strokeId = generateId('stroke');
    dispatchAt(TimelineEventType.STROKE_CREATE, {
      targetId: strokeId,
      payload: {
        id: strokeId,
        points,
        pointTimes,
        pointPressures,
        kind,
        color: style.color,
        width: style.width,
      },
      time: startTime,
    });

    return strokeId;
  };

  const eraseStroke = (strokeId: string, time?: number) => {
    dispatchAt(TimelineEventType.STROKE_ERASE, {
      targetId: strokeId,
      time,
    });
  };

  const eraseStrokes = (strokeIds: string[], time?: number) => {
    if (strokeIds.length === 0) {
      return;
    }

    dispatchAt(TimelineEventType.STROKE_ERASE, {
      payload: { strokeIds },
      time,
    });
  };

  const createRect = (rect: RectInput, time?: number): string => {
    const objectId = generateId('obj');

    const payload: ObjectCreatePayload = {
      id: objectId,
      type: 'rect',
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      rotation: rect.rotation,
      style: rect.style,
    };

    dispatchAt(TimelineEventType.OBJECT_CREATE, {
      targetId: objectId,
      payload,
      time,
    });

    return objectId;
  };

  const updateObjectTransform = (
    objectId: string,
    transform: ObjectUpdatePayload['transform'],
    time?: number,
  ) => {
    const payload: ObjectUpdatePayload = {
      transform,
    };

    dispatchAt(TimelineEventType.OBJECT_UPDATE, {
      targetId: objectId,
      payload,
      time,
    });
  };

  const updateObjectStyle = (
    objectId: string,
    style: Record<string, unknown>,
    time?: number,
  ) => {
    const payload: ObjectUpdatePayload = {
      style,
    };

    dispatchAt(TimelineEventType.OBJECT_UPDATE, {
      targetId: objectId,
      payload,
      time,
    });
  };

  const deleteObject = (objectId: string, time?: number) => {
    dispatchAt(TimelineEventType.OBJECT_DELETE, {
      targetId: objectId,
      time,
    });
  };

  const deleteObjects = (objectIds: string[], time?: number) => {
    if (objectIds.length === 0) {
      return;
    }

    dispatchAt(TimelineEventType.OBJECT_DELETE, {
      payload: { objectIds },
      time,
    });
  };

  const setViewport = (viewport: ViewportSetPayload, time?: number) => {
    dispatchAt(TimelineEventType.VIEWPORT_SET, {
      payload: viewport,
      time,
    });
  };

  const switchPage = (pageId: string, time?: number) => {
    dispatchAt(TimelineEventType.PAGE_SET, {
      targetId: pageId,
      payload: { pageId },
      time,
    });
  };

  const createPageAndSwitch = (time?: number) => {
    const pageId = generateId('page');
    switchPage(pageId, time);
    return pageId;
  };

  return {
    createStroke,
    eraseStroke,
    eraseStrokes,
    createRect,
    updateObjectTransform,
    updateObjectStyle,
    deleteObject,
    deleteObjects,
    setViewport,
    switchPage,
    createPageAndSwitch,
  };
};

export const useWhiteboardUseCases = (): WhiteboardUseCases => {
  return useMemo(
    () =>
      createWhiteboardUseCases({
        getCurrentPageId: () => whiteboardGateway.getCurrentPageId(),
        getCurrentTime: () => whiteboardGateway.getCurrentTime(),
        createTimelineEvent: (event) => whiteboardGateway.createTimelineEvent(event),
        dispatchEvent: (event) => whiteboardGateway.dispatchEvent(event),
      }),
    [],
  );
};
