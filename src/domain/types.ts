export enum TimelineEventType {
  STROKE_CREATE = 'STROKE_CREATE',
  STROKE_ERASE = 'STROKE_ERASE',
  OBJECT_CREATE = 'OBJECT_CREATE',
  OBJECT_UPDATE = 'OBJECT_UPDATE',
  OBJECT_DELETE = 'OBJECT_DELETE',
  VIEWPORT_SET = 'VIEWPORT_SET',
  PAGE_SET = 'PAGE_SET',
}

export type AppErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'unsupported_runtime'
  | 'permission_denied'
  | 'io_error'
  | 'state_corruption'
  | 'unknown_error';

export type AppError = {
  code: AppErrorCode;
  message: string;
  details?: unknown;
};

export type Result<T, E = AppError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type Point = {
  x: number;
  y: number;
};

export type Stroke = {
  id: string;
  points: Point[];
  pointTimes?: number[];
  color: string;
  width: number;
  createdAt: number;
  deletedAt?: number;
};

export type WhiteboardObjectType = 'rect';

export type WhiteboardObject = {
  id: string;
  type: WhiteboardObjectType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  style?: Record<string, unknown>;
  createdAt: number;
  deletedAt?: number;
};

export type ViewportState = {
  x: number;
  y: number;
  zoom: number;
};

export type PageState = {
  id: string;
  strokes: Record<string, Stroke>;
  objects: Record<string, WhiteboardObject>;
  viewport: ViewportState;
};

export type ProjectState = {
  id: string;
  pages: Record<string, PageState>;
  currentPageId: string;
};

export type ProjectAssetType = 'pdf' | 'ppt' | 'pptx' | 'image' | 'blank';

export type ProjectPage = {
  id: string;
  name: string;
  assetType: ProjectAssetType;
  backgroundUrl?: string;
  backgroundAssetKey?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  sourceName?: string;
  sourcePageIndex?: number;
  order: number;
};

export type TimelineSegment = {
  id: string;
  projectId: string;
  pageId: string;
  startTime: number;
  endTime: number;
  actionIds: string[];
};

export type WaveformPoint = {
  t: number;
  amp: number;
  minAmp?: number;
  maxAmp?: number;
};

export type AudioSegment = {
  id: string;
  projectId: string;
  startTime: number;
  endTime: number;
  waveform: WaveformPoint[];
  sourceOffsetMs?: number;
  sourceDurationMs?: number;
  sourceUrl?: string;
  muted?: boolean;
};

export type RecordingStatus = 'idle' | 'recording' | 'paused';

export type ProjectMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pages: ProjectPage[];
};

export type TimelineSplit = {
  left: TimelineEvent[];
  right: TimelineEvent[];
};

export type StrokeCreatePayload = {
  id?: string;
  points: Point[];
  pointTimes?: number[];
  color?: string;
  width?: number;
};

export type StrokeErasePayload = {
  strokeId?: string;
  strokeIds?: string[];
};

export type ObjectCreatePayload = {
  id?: string;
  type?: WhiteboardObjectType;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  style?: Record<string, unknown>;
};

export type ObjectUpdatePayload = {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  style?: Record<string, unknown>;
  transform?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    rotation?: number;
  };
};

export type ObjectDeletePayload = {
  objectId?: string;
  objectIds?: string[];
};

export type ViewportSetPayload = Partial<ViewportState>;

export type PageSetPayload = {
  pageId: string;
};

export type TimelineEventPayloadByType = {
  [TimelineEventType.STROKE_CREATE]: StrokeCreatePayload;
  [TimelineEventType.STROKE_ERASE]: StrokeErasePayload;
  [TimelineEventType.OBJECT_CREATE]: ObjectCreatePayload;
  [TimelineEventType.OBJECT_UPDATE]: ObjectUpdatePayload;
  [TimelineEventType.OBJECT_DELETE]: ObjectDeletePayload;
  [TimelineEventType.VIEWPORT_SET]: ViewportSetPayload;
  [TimelineEventType.PAGE_SET]: PageSetPayload;
};

type TimelineEventBase = {
  id: string;
  projectId: string;
  pageId: string;
  actorId: string;
  time: number;
  targetId?: string;
};

export type TimelineEventOfType<T extends TimelineEventType> = TimelineEventBase & {
  type: T;
  payload?: TimelineEventPayloadByType[T];
};

export type TimelineEvent = {
  [K in TimelineEventType]: TimelineEventOfType<K>
}[TimelineEventType];

export type TimelineEventDraft<T extends TimelineEventType = TimelineEventType> = {
  pageId: string;
  type: T;
  targetId?: string;
  payload?: TimelineEventPayloadByType[T];
};

export type TimelineEventInsertDraft<T extends TimelineEventType = TimelineEventType> =
  Omit<TimelineEventDraft<T>, 'pageId'> & {
    pageId?: string;
    id?: string;
    projectId?: string;
    actorId?: string;
  };

export type Action = TimelineEvent;

export const DEFAULT_PROJECT_ID = 'project-1';
export const DEFAULT_PAGE_ID = 'page-1';

export const createEmptyPageState = (id: string): PageState => ({
  id,
  strokes: {},
  objects: {},
  viewport: {
    x: 0,
    y: 0,
    zoom: 1,
  },
});

export const createInitialProjectState = (
  projectId: string = DEFAULT_PROJECT_ID,
  pageId: string = DEFAULT_PAGE_ID,
): ProjectState => ({
  id: projectId,
  pages: {
    [pageId]: createEmptyPageState(pageId),
  },
  currentPageId: pageId,
});
