import {
  createInitialProjectState,
  AudioSegment,
  DEFAULT_PROJECT_ID,
  DEFAULT_PAGE_ID,
  ProjectPage,
  TimelineEvent,
  TimelineEventDraft,
  TimelineEventOfType,
  TimelineEventType,
} from '../../domain/types';
import { useWhiteboardStore } from '../../store/useWhiteboardStore';
import {
  assertExportTimelineConsistency,
  getExportTimelineStats,
  normalizeExportTimeline,
} from '../export/exportTimelineConsistency';
import { runExportJob } from '../export/ExportJobService';
import {
  deleteEvent,
  deleteTimeRange,
  getTimelineMaxTime,
  getStateAtTime,
  insertEvent,
  insertTimeGap,
  moveEvent,
  rippleDeleteTimeRange,
  splitTimeline,
} from '../../engine/timelineEngine';
import { getVisibleObjects } from '../../domain/selectors';
import { MasterClock } from '../clock/MasterClock';
import { RecordingTimelineClock } from '../clock/RecordingTimelineClock';
import { normalizeTimelineTime } from '../../domain/time';
import {
  NativeTimelineAdapter,
  nativeTimelineAdapter,
} from '../../infrastructure/platform/nativeTimeline';
import { deriveTimelineSegments } from '../../domain/timelineSegments';
import {
  shouldRefreshPlaybackPreparation,
  shouldRestartActivePlayback,
} from '../../engine/audioPlaybackEngine';
import { finalizeStrokeSamples } from '../drawing/strokeSampling';
import {
  clampObjectPositionToBoard,
  clampViewportToBoard,
  getRectResizeHandles,
  getResizeHandleAnchor,
  getSelectionBounds,
  mapRectToResizedBounds,
  pruneObjectSelection,
  projectPanViewportFromScreenDelta,
  projectScreenPointToWorld,
  resizeRectFromHandle,
  RectResizeHandle,
  resolveWhiteboardViewportRect,
  shouldHandleCanvasDeleteKey,
  toggleObjectSelection,
} from '../drawing/whiteboardInteraction';
import {
  executeTimelineCommand,
  executeTimelineCommandAsync,
  TimelineCommand,
} from './transactions';
import { hitRectObject } from '../../utils/geometry';
import { buildPerfectStrokePath } from '../drawing/perfectStroke';

type RegressionCaseResult = {
  name: string;
  ok: boolean;
  message?: string;
};

const assert = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const eventTimes = (events: TimelineEvent[]): number[] => {
  return events.map((event) => event.time).sort((a, b) => a - b);
};

const hardResetStore = (): void => {
  const store = useWhiteboardStore.getState();
  store.resetProject();
  useWhiteboardStore.setState((state) => ({
    ...state,
    selectedEventId: undefined,
    selectedSegmentId: undefined,
    lastTransaction: undefined,
    history: {
      past: [],
      future: [],
    },
  }));
};

const insertViewportEvent = (time: number, x: number): void => {
  useWhiteboardStore.getState().insertEventAtTime(
    {
      type: TimelineEventType.VIEWPORT_SET,
      payload: {
        x,
        y: 0,
        zoom: 1,
      },
    },
    time,
  );
};

const createAudio = (id: string, startTime: number, endTime: number): AudioSegment => ({
  id,
  projectId: DEFAULT_PROJECT_ID,
  startTime,
  endTime,
  sourceOffsetMs: 0,
  sourceDurationMs: Math.max(1, endTime - startTime),
  waveform: [
    { t: startTime, amp: 0.25 },
    { t: endTime, amp: 0.25 },
  ],
});

const createProjectPage = (id: string, order: number, name: string): ProjectPage => ({
  id,
  name,
  assetType: 'blank',
  order,
  width: 1920,
  height: 1080,
});

const runDeleteEventTransactionCase = (): void => {
  hardResetStore();
  insertViewportEvent(300, 1);
  insertViewportEvent(700, 2);
  const before = useWhiteboardStore.getState().events;
  const target = before.find((event) => event.time === 300);
  assert(!!target, 'delete_event case: missing target event');

  useWhiteboardStore.getState().deleteEvent(target!.id);
  const afterDelete = useWhiteboardStore.getState();
  assert(afterDelete.events.length === 1, 'delete_event case: expected one event after delete');
  assert(afterDelete.events.every((event) => event.id !== target!.id), 'delete_event case: target still exists');
  assert(afterDelete.lastTransaction?.kind === 'delete_event', 'delete_event case: transaction kind mismatch');

  afterDelete.undo();
  const afterUndo = useWhiteboardStore.getState();
  assert(afterUndo.events.length === 2, 'delete_event case: undo did not restore event count');
  assert(afterUndo.events.some((event) => event.id === target!.id), 'delete_event case: undo did not restore target event');

  afterUndo.redo();
  const afterRedo = useWhiteboardStore.getState();
  assert(afterRedo.events.length === 1, 'delete_event case: redo did not re-delete event');
  assert(afterRedo.events.every((event) => event.id !== target!.id), 'delete_event case: redo restored deleted event unexpectedly');
};

const runMoveEventTransactionCase = (): void => {
  hardResetStore();
  insertViewportEvent(500, 1);
  const target = useWhiteboardStore.getState().events[0];
  assert(!!target, 'move_event_time case: missing event');

  useWhiteboardStore.getState().moveEventTime(target.id, 900);
  let events = useWhiteboardStore.getState().events;
  assert(events.length === 1 && events[0].time === 900, 'move_event_time case: event not moved to 900');
  assert(useWhiteboardStore.getState().lastTransaction?.kind === 'move_event_time', 'move_event_time case: transaction kind mismatch');

  useWhiteboardStore.getState().undo();
  events = useWhiteboardStore.getState().events;
  assert(events.length === 1 && events[0].time === 500, 'move_event_time case: undo did not restore 500');

  useWhiteboardStore.getState().redo();
  events = useWhiteboardStore.getState().events;
  assert(events.length === 1 && events[0].time === 900, 'move_event_time case: redo did not restore 900');
};

const runSplitSelectedSegmentTransactionCase = (): void => {
  hardResetStore();
  insertViewportEvent(1000, 1);

  let state = useWhiteboardStore.getState();
  const firstSegment = state.timelineSegments[0];
  assert(!!firstSegment, 'split_at case: missing initial segment');

  state.setSelectedSegment(firstSegment.id);
  const applied = state.splitSelectedSegmentAt(400);
  assert(applied, 'split_at case: split should apply inside segment');

  state = useWhiteboardStore.getState();
  assert(state.lastTransaction?.kind === 'split_at', 'split_at case: transaction kind mismatch');
  assert(
    state.events.some(
      (event) => event.type === TimelineEventType.PAGE_SET && event.time === 400,
    ),
    'split_at case: expected inserted PAGE_SET event at split time',
  );
  assert(
    state.timelineSegments.some((segment) => segment.startTime === 400),
    'split_at case: expected new segment boundary at split time',
  );

  state.undo();
  state = useWhiteboardStore.getState();
  assert(
    state.events.every((event) => !(event.type === TimelineEventType.PAGE_SET && event.time === 400)),
    'split_at case: undo should remove split PAGE_SET event',
  );

  state.redo();
  state = useWhiteboardStore.getState();
  assert(
    state.events.some((event) => event.type === TimelineEventType.PAGE_SET && event.time === 400),
    'split_at case: redo should restore split PAGE_SET event',
  );
};

const runInsertGapRippleUndoRedoCase = (): void => {
  hardResetStore();
  insertViewportEvent(1000, 1);
  insertViewportEvent(2000, 2);
  useWhiteboardStore.getState().addAudioSegment(createAudio('aud-case', 1500, 2500));

  useWhiteboardStore.getState().insertGap(1200, 500);
  let state = useWhiteboardStore.getState();
  assert(JSON.stringify(eventTimes(state.events)) === JSON.stringify([1000, 2500]), 'insert_gap case: event times mismatch after gap');
  assert(state.audioSegments.length === 1, 'insert_gap case: audio segment count mismatch');
  assert(state.audioSegments[0].startTime === 2000 && state.audioSegments[0].endTime === 3000, 'insert_gap case: audio shift mismatch');
  assert(state.lastTransaction?.kind === 'insert_gap', 'insert_gap case: transaction kind mismatch');

  state.rippleDeleteRange(1300, 1700);
  state = useWhiteboardStore.getState();
  assert(JSON.stringify(eventTimes(state.events)) === JSON.stringify([1000, 2100]), 'ripple case: event times mismatch');
  assert(state.audioSegments.length === 1, 'ripple case: audio segment count mismatch');
  assert(state.audioSegments[0].startTime === 1600 && state.audioSegments[0].endTime === 2600, 'ripple case: audio shift mismatch');
  assert(state.lastTransaction?.kind === 'ripple_delete_range', 'ripple case: transaction kind mismatch');

  state.undo();
  state = useWhiteboardStore.getState();
  assert(JSON.stringify(eventTimes(state.events)) === JSON.stringify([1000, 2500]), 'undo case: event times mismatch');
  assert(state.audioSegments[0].startTime === 2000 && state.audioSegments[0].endTime === 3000, 'undo case: audio mismatch');

  state.redo();
  state = useWhiteboardStore.getState();
  assert(JSON.stringify(eventTimes(state.events)) === JSON.stringify([1000, 2100]), 'redo case: event times mismatch');
  assert(state.audioSegments[0].startTime === 1600 && state.audioSegments[0].endTime === 2600, 'redo case: audio mismatch');
};

const runInsertGapNoHistoryBoundaryCase = (): void => {
  hardResetStore();
  insertViewportEvent(100, 1);
  const before = useWhiteboardStore.getState();
  const pastLenBefore = before.history.past.length;
  assert(pastLenBefore >= 1, 'insert_gap no-history case: expected baseline history');

  before.insertGap(50, 100, { pushHistory: false });
  let state = useWhiteboardStore.getState();
  assert(JSON.stringify(eventTimes(state.events)) === JSON.stringify([200]), 'insert_gap no-history case: event shift mismatch');
  assert(state.history.past.length === pastLenBefore, 'insert_gap no-history case: history unexpectedly increased');

  state.undo();
  state = useWhiteboardStore.getState();
  assert(state.events.length === 0, 'insert_gap no-history case: undo boundary mismatch');

  state.redo();
  state = useWhiteboardStore.getState();
  assert(JSON.stringify(eventTimes(state.events)) === JSON.stringify([200]), 'insert_gap no-history case: redo boundary mismatch');
};

const runProjectPageSwitchEventCase = (): void => {
  hardResetStore();
  const pages: ProjectPage[] = [
    {
      id: DEFAULT_PAGE_ID,
      name: 'Page 1',
      assetType: 'blank',
      order: 0,
    },
    {
      id: 'page-2',
      name: 'Page 2',
      assetType: 'blank',
      order: 1,
    },
  ];

  useWhiteboardStore.getState().setProjectPages(pages, {
    replace: true,
    switchToPageId: 'page-2',
  });
  let state = useWhiteboardStore.getState();
  assert(state.state.currentPageId === 'page-2', 'project page case: expected switch to page-2');
  assert(
    state.events.some(
      (event) => event.type === TimelineEventType.PAGE_SET && event.targetId === 'page-2',
    ),
    'project page case: expected PAGE_SET event for page-2 switch',
  );

  useWhiteboardStore.getState().deleteProjectPage('page-2');
  state = useWhiteboardStore.getState();
  assert(state.state.currentPageId === DEFAULT_PAGE_ID, 'project page case: expected fallback to default page');
  assert(
    state.events.some(
      (event) => event.type === TimelineEventType.PAGE_SET && event.targetId === DEFAULT_PAGE_ID,
    ),
    'project page case: expected PAGE_SET event for fallback switch',
  );
  assert(state.project.pages.length === 1, 'project page case: expected page count to shrink after delete');
};

const runExportConsistencyAssertionCase = (): void => {
  const events: TimelineEvent[] = [
    {
      id: 'evt-1',
      projectId: DEFAULT_PROJECT_ID,
      pageId: DEFAULT_PAGE_ID,
      actorId: 'test',
      time: 100,
      type: TimelineEventType.VIEWPORT_SET,
      payload: { x: 1, y: 0, zoom: 1 },
    },
    {
      id: 'evt-2',
      projectId: DEFAULT_PROJECT_ID,
      pageId: DEFAULT_PAGE_ID,
      actorId: 'test',
      time: 420,
      type: TimelineEventType.VIEWPORT_SET,
      payload: { x: 2, y: 0, zoom: 1 },
    },
  ];
  const audio = [createAudio('aud-export', 200, 1300)];
  const stats = getExportTimelineStats(events, audio);
  assertExportTimelineConsistency(stats, {
    expectedDurationMs: stats.durationMs,
    expectedEventMaxMs: stats.eventMaxMs,
    expectedAudioMaxMs: stats.audioMaxMs,
    expectedFingerprint: stats.fingerprint,
  });

  let threw = false;
  try {
    assertExportTimelineConsistency(stats, {
      expectedDurationMs: stats.durationMs + 33,
      expectedFingerprint: stats.fingerprint,
    });
  } catch {
    threw = true;
  }
  assert(threw, 'export consistency case: expected mismatch assertion to throw');
};

const runRecordingModeHistoryBoundaryCase = (): void => {
  hardResetStore();
  const store = useWhiteboardStore.getState();
  store.setRecordingStatus('recording');
  const basePastLen = useWhiteboardStore.getState().history.past.length;

  insertViewportEvent(240, 1);
  let state = useWhiteboardStore.getState();
  assert(state.events.length === 1, 'recording history case: event not inserted');
  assert(state.history.past.length === basePastLen, 'recording history case: history should not grow during recording');

  state.setRecordingStatus('idle');
  state.undo();
  state = useWhiteboardStore.getState();
  assert(state.events.length === 0, 'recording history case: undo did not return to pre-recording snapshot');

  state.redo();
  state = useWhiteboardStore.getState();
  assert(state.events.length === 1, 'recording history case: redo did not restore recording event');
};

const runExportKeyframeParityCase = (): void => {
  const events: TimelineEvent[] = [
    {
      id: 'evt-page',
      projectId: DEFAULT_PROJECT_ID,
      pageId: DEFAULT_PAGE_ID,
      actorId: 'test',
      time: 80,
      type: TimelineEventType.PAGE_SET,
      targetId: 'page-2',
      payload: { pageId: 'page-2' },
    },
    {
      id: 'evt-vp-1',
      projectId: DEFAULT_PROJECT_ID,
      pageId: 'page-2',
      actorId: 'test',
      time: 120,
      type: TimelineEventType.VIEWPORT_SET,
      payload: { x: 10, y: 20, zoom: 1.2 },
    },
    {
      id: 'evt-vp-2',
      projectId: DEFAULT_PROJECT_ID,
      pageId: 'page-2',
      actorId: 'test',
      time: 560,
      type: TimelineEventType.VIEWPORT_SET,
      payload: { x: 18, y: 24, zoom: 1.4 },
    },
  ];
  const audio = [createAudio('aud-kf', 100, 900)];
  const normalized = normalizeExportTimeline(events, audio);
  const sampleTimes = [0, 80, 120, 340, 560, 900];

  const toSnapshot = (eventList: TimelineEvent[], time: number) => {
    const state = getStateAtTime(createInitialProjectState(DEFAULT_PROJECT_ID, DEFAULT_PAGE_ID), eventList, time);
    const page = state.pages[state.currentPageId];
    return {
      currentPageId: state.currentPageId,
      viewport: page?.viewport ?? { x: 0, y: 0, zoom: 1 },
      strokeCount: Object.keys(page?.strokes ?? {}).length,
      objectCount: Object.keys(page?.objects ?? {}).length,
    };
  };

  for (const time of sampleTimes) {
    const base = toSnapshot(events, time);
    const next = toSnapshot(normalized.events, time);
    assert(
      JSON.stringify(base) === JSON.stringify(next),
      `export keyframe parity case: state mismatch at t=${time}`,
    );
  }
};

const runExportPreviewParityAfterTimelineTransactionsCase = (): void => {
  hardResetStore();
  const store = useWhiteboardStore.getState();

  store.insertEventAtTime(
    {
      type: TimelineEventType.PAGE_SET,
      pageId: DEFAULT_PAGE_ID,
      targetId: 'page-2',
      payload: { pageId: 'page-2' },
    },
    120,
  );
  store.insertEventAtTime(
    {
      type: TimelineEventType.STROKE_CREATE,
      pageId: 'page-2',
      payload: {
        id: 'stroke-reg-1',
        points: [
          { x: 40, y: 60 },
          { x: 120, y: 120 },
          { x: 180, y: 90 },
        ],
        pointTimes: [0, 90, 180],
        color: '#111827',
        width: 2,
      },
    },
    260,
  );
  store.insertEventAtTime(
    {
      type: TimelineEventType.VIEWPORT_SET,
      pageId: 'page-2',
      payload: { x: 32, y: 20, zoom: 1.2 },
    },
    520,
  );
  store.insertEventAtTime(
    {
      type: TimelineEventType.OBJECT_CREATE,
      pageId: 'page-2',
      payload: {
        id: 'obj-reg-1',
        type: 'rect',
        x: 88,
        y: 66,
        width: 120,
        height: 70,
        style: { stroke: '#0ea5e9', strokeWidth: 2 },
      },
    },
    700,
  );
  store.insertEventAtTime(
    {
      type: TimelineEventType.OBJECT_UPDATE,
      pageId: 'page-2',
      targetId: 'obj-reg-1',
      payload: {
        id: 'obj-reg-1',
        transform: {
          x: 102,
          y: 84,
          width: 150,
          height: 88,
        },
      },
    },
    860,
  );

  store.addAudioSegment(createAudio('aud-parity-a', 140, 620));
  store.addAudioSegment(createAudio('aud-parity-b', 760, 1240));
  store.insertGap(460, 160);
  store.rippleDeleteRange(940, 1080);

  const viewportEvent = useWhiteboardStore.getState().events.find(
    (event) => event.type === TimelineEventType.VIEWPORT_SET && event.pageId === 'page-2',
  );
  assert(!!viewportEvent, 'export preview parity case: missing viewport event');
  useWhiteboardStore.getState().moveEventTime(viewportEvent!.id, viewportEvent!.time + 45);

  const finalEvents = useWhiteboardStore.getState().events;
  const finalAudio = useWhiteboardStore.getState().audioSegments;
  const baseStats = getExportTimelineStats(finalEvents, finalAudio);
  const normalized = normalizeExportTimeline(finalEvents, finalAudio);

  assertExportTimelineConsistency(normalized.stats, {
    expectedDurationMs: baseStats.durationMs,
    expectedEventMaxMs: baseStats.eventMaxMs,
    expectedAudioMaxMs: baseStats.audioMaxMs,
  });

  const stateFingerprintAt = (events: TimelineEvent[], time: number): string => {
    const state = getStateAtTime(
      createInitialProjectState(DEFAULT_PROJECT_ID, DEFAULT_PAGE_ID),
      events,
      time,
    );
    const page = state.pages[state.currentPageId];
    const strokes = Object.values(page?.strokes ?? {})
      .map((stroke) => ({
        id: stroke.id,
        createdAt: stroke.createdAt,
        deletedAt: stroke.deletedAt ?? null,
        points: stroke.points.length,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const objects = Object.values(page?.objects ?? {})
      .map((object) => ({
        id: object.id,
        createdAt: object.createdAt,
        deletedAt: object.deletedAt ?? null,
        x: object.x,
        y: object.y,
        width: object.width,
        height: object.height,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return JSON.stringify({
      currentPageId: state.currentPageId,
      viewport: page?.viewport ?? { x: 0, y: 0, zoom: 1 },
      strokes,
      objects,
    });
  };

  const audioFingerprintAt = (segments: AudioSegment[], time: number): string => {
    const active = segments
      .filter((segment) => segment.startTime <= time && segment.endTime > time)
      .map((segment) => (
        `${segment.id}:${segment.startTime}:${segment.endTime}:${segment.sourceOffsetMs ?? 0}:${segment.sourceDurationMs ?? 0}`
      ))
      .sort();
    return active.join('|');
  };

  const duration = Math.max(baseStats.durationMs, normalized.stats.durationMs);
  const sampleTimes = new Set<number>();
  for (let time = 0; time <= duration; time += 137) {
    sampleTimes.add(time);
  }
  sampleTimes.add(0);
  sampleTimes.add(120);
  sampleTimes.add(460);
  sampleTimes.add(620);
  sampleTimes.add(940);
  sampleTimes.add(1080);
  sampleTimes.add(duration);

  const sortedSampleTimes = [...sampleTimes]
    .map((time) => normalizeTimelineTime(time))
    .filter((time) => time >= 0 && time <= duration)
    .sort((a, b) => a - b);

  for (const time of sortedSampleTimes) {
    const previewState = stateFingerprintAt(finalEvents, time);
    const exportState = stateFingerprintAt(normalized.events, time);
    assert(
      previewState === exportState,
      `export preview parity case: state mismatch at t=${time}`,
    );

    const previewAudio = audioFingerprintAt(finalAudio, time);
    const exportAudio = audioFingerprintAt(normalized.audioSegments, time);
    assert(
      previewAudio === exportAudio,
      `export preview parity case: audio mismatch at t=${time}`,
    );
  }
};

const runExportLongSampleFingerprintReconciliationCase = async (): Promise<void> => {
  const pages: ProjectPage[] = [
    createProjectPage(DEFAULT_PAGE_ID, 0, 'Cover'),
    createProjectPage('page-2', 1, 'Body'),
  ];
  const events: TimelineEvent[] = [
    {
      id: 'long-vp-2',
      projectId: DEFAULT_PROJECT_ID,
      pageId: 'page-2',
      actorId: 'test',
      time: 91000,
      type: TimelineEventType.VIEWPORT_SET,
      payload: { x: 24, y: 18, zoom: 1.12 },
    },
    {
      id: 'long-page-1',
      projectId: DEFAULT_PROJECT_ID,
      pageId: DEFAULT_PAGE_ID,
      actorId: 'test',
      time: 0,
      type: TimelineEventType.PAGE_SET,
      targetId: DEFAULT_PAGE_ID,
      payload: { pageId: DEFAULT_PAGE_ID },
    },
    {
      id: 'long-stroke-1',
      projectId: DEFAULT_PROJECT_ID,
      pageId: DEFAULT_PAGE_ID,
      actorId: 'test',
      time: 1800,
      type: TimelineEventType.STROKE_CREATE,
      payload: {
        id: 'stroke-long-1',
        points: [
          { x: 44, y: 58 },
          { x: 120, y: 120 },
          { x: 188, y: 104 },
        ],
        pointTimes: [0, 80, 160],
        color: '#111827',
        width: 2,
      },
    },
    {
      id: 'long-page-2',
      projectId: DEFAULT_PROJECT_ID,
      pageId: DEFAULT_PAGE_ID,
      actorId: 'test',
      time: 60200,
      type: TimelineEventType.PAGE_SET,
      targetId: 'page-2',
      payload: { pageId: 'page-2' },
    },
    {
      id: 'long-object-create',
      projectId: DEFAULT_PROJECT_ID,
      pageId: 'page-2',
      actorId: 'test',
      time: 61800,
      type: TimelineEventType.OBJECT_CREATE,
      payload: {
        id: 'obj-long-1',
        type: 'rect',
        x: 88,
        y: 72,
        width: 180,
        height: 96,
        style: { stroke: '#0ea5e9', strokeWidth: 2 },
      },
    },
    {
      id: 'long-object-update',
      projectId: DEFAULT_PROJECT_ID,
      pageId: 'page-2',
      actorId: 'test',
      time: 122400,
      type: TimelineEventType.OBJECT_UPDATE,
      targetId: 'obj-long-1',
      payload: {
        id: 'obj-long-1',
        transform: {
          x: 120,
          y: 94,
          width: 220,
          height: 120,
        },
      },
    },
    {
      id: 'long-page-back',
      projectId: DEFAULT_PROJECT_ID,
      pageId: 'page-2',
      actorId: 'test',
      time: 144000,
      type: TimelineEventType.PAGE_SET,
      targetId: DEFAULT_PAGE_ID,
      payload: { pageId: DEFAULT_PAGE_ID },
    },
    {
      id: 'long-vp-final',
      projectId: DEFAULT_PROJECT_ID,
      pageId: DEFAULT_PAGE_ID,
      actorId: 'test',
      time: 181500,
      type: TimelineEventType.VIEWPORT_SET,
      payload: { x: 42, y: 26, zoom: 1.28 },
    },
  ];
  const audio: AudioSegment[] = [
    { ...createAudio('aud-long-c', 121000, 184250), sourceUrl: 'lesson-c.wav' },
    { ...createAudio('aud-long-a', 0, 41800), sourceUrl: 'lesson-a.wav' },
    { ...createAudio('aud-long-b', 60300, 118900), sourceUrl: 'lesson-b.wav' },
  ];
  const baselineStats = getExportTimelineStats(events, audio);
  const progressSamples: string[] = [];
  let capturedStats: ReturnType<typeof getExportTimelineStats> | null = null;
  let capturedEventTimes: number[] = [];
  let capturedAudioTimes: number[] = [];

  await runExportJob(
    'mp4',
    {
      projectId: DEFAULT_PROJECT_ID,
      fileBaseName: 'regression-long-export',
      pages,
      events,
      audioSegments: audio,
      fps: 60,
      expectedDurationMs: baselineStats.durationMs,
      expectedEventMaxMs: baselineStats.eventMaxMs,
      expectedAudioMaxMs: baselineStats.audioMaxMs,
      expectedFingerprint: baselineStats.fingerprint,
    },
    {
      onProgress: (progress, message) => {
        progressSamples.push(`${progress.toFixed(2)}:${message}`);
      },
      adapter: {
        exportMp4: async (request) => {
          request.onProgress?.(0.35, 'normalizing');
          capturedEventTimes = request.events.map((event) => event.time);
          capturedAudioTimes = request.audioSegments.map((segment) => segment.startTime);
          capturedStats = getExportTimelineStats(request.events, request.audioSegments);
          request.onProgress?.(1, 'done');
        },
        exportUfproj: async () => {
          throw new Error('export long sample case: unexpected ufproj export');
        },
      },
    },
  );

  assert(!!capturedStats, 'export long sample case: adapter did not receive normalized payload');
  assert(
    JSON.stringify(capturedEventTimes) === JSON.stringify([...capturedEventTimes].sort((a, b) => a - b)),
    'export long sample case: expected events to be sorted before adapter export',
  );
  assert(
    JSON.stringify(capturedAudioTimes) === JSON.stringify([...capturedAudioTimes].sort((a, b) => a - b)),
    'export long sample case: expected audio segments to be sorted before adapter export',
  );
  assert(
    capturedStats!.durationMs >= 180000,
    'export long sample case: expected minute-level export sample duration',
  );
  assert(
    capturedStats!.fingerprint === baselineStats.fingerprint,
    'export long sample case: fingerprint mismatch after normalization',
  );
  assert(
    progressSamples.includes('0.35:normalizing') && progressSamples.includes('1.00:done'),
    'export long sample case: expected progress samples from adapter bridge',
  );
};

const runMasterClockDriftCorrectionCase = async (): Promise<void> => {
  let replayPlaying = false;
  let currentTime = 1000;
  let audioClock = 5000;
  let wallNow = 100;
  let syncCount = 0;
  let lastSync: { time: number; shouldPlay: boolean } | null = null;

  const replay = {
    play: () => { replayPlaying = true; },
    pause: () => { replayPlaying = false; },
    seek: (time: number) => { currentTime = normalizeTimelineTime(time); },
    isPlaying: () => replayPlaying,
  };
  const audio = {
    unlock: async () => {},
    prepare: async () => {},
    play: () => {},
    sync: () => {},
    getClockNowMs: () => audioClock,
  };

  const clock = new MasterClock({
    nowMs: () => wallNow,
  });
  clock.configure({
    getReplay: () => replay,
    getAudio: () => audio,
    getCurrentTime: () => currentTime,
    getMaxTime: () => 3000,
    syncAt: (time, shouldPlay) => {
      syncCount += 1;
      lastSync = { time, shouldPlay };
    },
    setPlaying: () => {},
  });

  await clock.playPreview();
  assert(syncCount >= 1, 'master clock case: playPreview should sync at least once');

  audioClock = 5400; // +400ms
  currentTime = 1700; // expected would be around 1400, force > threshold drift
  wallNow += 350;
  clock.stabilizePlaybackDrift();

  assert(syncCount >= 2, 'master clock case: drift correction did not trigger sync');
  if (!lastSync) {
    throw new Error('master clock case: no sync payload captured');
  }
  const syncPayload = lastSync as { time: number; shouldPlay: boolean };
  assert(syncPayload.shouldPlay, 'master clock case: drift sync should keep playing');
  assert(syncPayload.time === currentTime, 'master clock case: drift sync should target current timeline');

  const syncCountAfterCorrection = syncCount;
  audioClock = 5700;
  currentTime = 1990; // anchor(1700,5400) => estimated 2000, drift 10ms, should not sync
  wallNow += 300;
  clock.stabilizePlaybackDrift();
  assert(
    syncCount === syncCountAfterCorrection,
    'master clock case: small drift should not trigger correction',
  );
};

const runMasterClockDriftMultiCycleCase = async (): Promise<void> => {
  let replayPlaying = false;
  let currentTime = 0;
  let audioClock = 1000;
  let wallNow = 0;
  let syncCount = 0;
  const syncEvents: Array<{ time: number; shouldPlay: boolean }> = [];

  const replay = {
    play: () => { replayPlaying = true; },
    pause: () => { replayPlaying = false; },
    seek: (time: number) => { currentTime = normalizeTimelineTime(time); },
    isPlaying: () => replayPlaying,
  };
  const audio = {
    unlock: async () => {},
    prepare: async () => {},
    play: () => {},
    sync: () => {},
    getClockNowMs: () => audioClock,
  };

  const clock = new MasterClock({
    nowMs: () => wallNow,
  });
  clock.configure({
    getReplay: () => replay,
    getAudio: () => audio,
    getCurrentTime: () => currentTime,
    getMaxTime: () => 5000,
    syncAt: (time, shouldPlay) => {
      syncCount += 1;
      syncEvents.push({ time, shouldPlay });
    },
    setPlaying: () => {},
  });

  await clock.playPreview();
  const baseSyncCount = syncCount;
  assert(baseSyncCount >= 1, 'master clock multi-cycle case: playPreview did not sync');

  wallNow = 320;
  audioClock = 1320;
  currentTime = 320;
  clock.stabilizePlaybackDrift();
  assert(syncCount === baseSyncCount, 'master clock multi-cycle case: stable playback should not sync');

  wallNow = 680;
  audioClock = 1680;
  currentTime = 900; // expected 680, drift 220
  clock.stabilizePlaybackDrift();
  assert(syncCount === baseSyncCount + 1, 'master clock multi-cycle case: first drift correction missing');

  wallNow = 760;
  audioClock = 1760;
  currentTime = 1200; // still large drift, but inside min interval window
  clock.stabilizePlaybackDrift();
  assert(
    syncCount === baseSyncCount + 1,
    'master clock multi-cycle case: correction should be throttled by min interval',
  );

  wallNow = 1080;
  audioClock = 2080;
  currentTime = 1450; // expected near 1300, drift 150
  clock.stabilizePlaybackDrift();
  assert(syncCount === baseSyncCount + 2, 'master clock multi-cycle case: second correction missing');
  const correctionSyncs = syncEvents.slice(baseSyncCount);
  assert(
    correctionSyncs.length === 2 && correctionSyncs.every((event) => event.shouldPlay),
    'master clock multi-cycle case: drift corrections should keep playback running',
  );

  clock.pausePreview();
  const pausedSyncCount = syncCount;
  wallNow = 1400;
  audioClock = 2400;
  currentTime = 1800;
  clock.stabilizePlaybackDrift();
  assert(syncCount === pausedSyncCount, 'master clock multi-cycle case: paused playback should not drift sync');
};

const runMasterClockSeekReanchorCase = async (): Promise<void> => {
  let replayPlaying = false;
  let currentTime = 1000;
  let audioClock = 4000;
  let wallNow = 0;
  let syncCount = 0;
  const syncEvents: Array<{ time: number; shouldPlay: boolean }> = [];

  const replay = {
    play: () => { replayPlaying = true; },
    pause: () => { replayPlaying = false; },
    seek: (time: number) => { currentTime = normalizeTimelineTime(time); },
    isPlaying: () => replayPlaying,
  };
  const audio = {
    unlock: async () => {},
    prepare: async () => {},
    play: () => {},
    sync: () => {},
    getClockNowMs: () => audioClock,
  };

  const clock = new MasterClock({
    nowMs: () => wallNow,
  });
  clock.configure({
    getReplay: () => replay,
    getAudio: () => audio,
    getCurrentTime: () => currentTime,
    getMaxTime: () => 6000,
    syncAt: (time, shouldPlay) => {
      syncCount += 1;
      syncEvents.push({ time, shouldPlay });
    },
    setPlaying: () => {},
  });

  await clock.playPreview();
  const baseSyncCount = syncCount;
  assert(baseSyncCount >= 1, 'master clock seek case: playPreview should sync at least once');

  clock.seek(1800);
  assert(syncCount === baseSyncCount + 1, 'master clock seek case: seek should emit sync');
  const seekSync = syncEvents[syncEvents.length - 1];
  assert(seekSync.time === 1800 && seekSync.shouldPlay, 'master clock seek case: seek sync payload mismatch');

  // After seek, anchor should rebind to current timeline and audio clock.
  wallNow += 260;
  audioClock = 4260;
  currentTime = 2060;
  clock.stabilizePlaybackDrift();
  assert(
    syncCount === baseSyncCount + 1,
    'master clock seek case: stable post-seek playback should not trigger drift correction',
  );
};

const runMasterClockSeekResetsDriftThrottleCase = async (): Promise<void> => {
  let replayPlaying = false;
  let currentTime = 1000;
  let audioClock = 4000;
  let wallNow = 0;
  let syncCount = 0;
  const syncEvents: Array<{ time: number; shouldPlay: boolean }> = [];

  const replay = {
    play: () => { replayPlaying = true; },
    pause: () => { replayPlaying = false; },
    seek: (time: number) => { currentTime = normalizeTimelineTime(time); },
    isPlaying: () => replayPlaying,
  };
  const audio = {
    unlock: async () => {},
    prepare: async () => {},
    play: () => {},
    sync: () => {},
    getClockNowMs: () => audioClock,
  };

  const clock = new MasterClock({
    nowMs: () => wallNow,
  });
  clock.configure({
    getReplay: () => replay,
    getAudio: () => audio,
    getCurrentTime: () => currentTime,
    getMaxTime: () => 10000,
    syncAt: (time, shouldPlay) => {
      syncCount += 1;
      syncEvents.push({ time, shouldPlay });
    },
    setPlaying: () => {},
  });

  await clock.playPreview();
  const baseSyncCount = syncCount;

  wallNow = 400;
  audioClock = 4400;
  currentTime = 1700; // expected around 1400, first correction should trigger
  clock.stabilizePlaybackDrift();
  assert(
    syncCount === baseSyncCount + 1,
    'master clock seek throttle case: first correction missing',
  );

  wallNow = 460;
  currentTime = 2200;
  clock.seek(2200);
  assert(
    syncCount === baseSyncCount + 2,
    'master clock seek throttle case: seek sync missing',
  );

  wallNow = 520; // only 120ms after last correction, but seek should reset throttle window
  audioClock = 4700;
  currentTime = 2600; // expected around 2440, force another correction
  clock.stabilizePlaybackDrift();
  assert(
    syncCount === baseSyncCount + 3,
    'master clock seek throttle case: seek should reset drift throttle window',
  );
  const lastSync = syncEvents[syncEvents.length - 1];
  assert(
    lastSync.time === 2600 && lastSync.shouldPlay,
    'master clock seek throttle case: drift correction should target current timeline and keep playing',
  );
};

const runMasterClockLongPlaybackPressureCase = async (): Promise<void> => {
  let replayPlaying = false;
  let currentTime = 0;
  let audioClock = 10_000;
  let wallNow = 0;
  const syncEvents: Array<{ time: number; shouldPlay: boolean }> = [];

  const replay = {
    play: () => { replayPlaying = true; },
    pause: () => { replayPlaying = false; },
    seek: (time: number) => { currentTime = normalizeTimelineTime(time); },
    isPlaying: () => replayPlaying,
  };
  const audio = {
    unlock: async () => {},
    prepare: async () => {},
    play: () => {},
    sync: () => {},
    getClockNowMs: () => audioClock,
  };

  const clock = new MasterClock({
    nowMs: () => wallNow,
  });
  clock.configure({
    getReplay: () => replay,
    getAudio: () => audio,
    getCurrentTime: () => currentTime,
    getMaxTime: () => 200_000,
    syncAt: (time, shouldPlay) => {
      syncEvents.push({ time, shouldPlay });
    },
    setPlaying: () => {},
  });

  await clock.playPreview();
  const baseSyncCount = syncEvents.length;
  assert(baseSyncCount >= 1, 'master clock long playback case: playPreview should sync');

  let expectedTimeline = 0;
  let correctionCount = 0;
  let timelineBias = 0;
  for (let second = 1; second <= 180; second += 1) {
    wallNow = second * 1_000;
    audioClock = 10_000 + second * 1_000;
    expectedTimeline = second * 1_000;

    const forcedDrift = second % 45 === 0
      ? 180
      : second % 30 === 0
        ? -140
        : 0;
    currentTime = normalizeTimelineTime(expectedTimeline + timelineBias + forcedDrift);

    const syncCountBefore = syncEvents.length;
    clock.stabilizePlaybackDrift();
    const syncCountAfter = syncEvents.length;
    if (forcedDrift === 0) {
      assert(
        syncCountAfter === syncCountBefore,
        `master clock long playback case: stable second ${second} should not trigger sync`,
      );
    } else if (syncCountAfter === syncCountBefore + 1) {
      correctionCount += 1;
      const syncPayload = syncEvents[syncEvents.length - 1];
      assert(
        syncPayload.time === currentTime && syncPayload.shouldPlay,
        `master clock long playback case: correction at second ${second} should target current timeline`,
      );
      timelineBias = currentTime - expectedTimeline;
    } else {
      throw new Error(
        `master clock long playback case: unexpected sync count change at second ${second}`,
      );
    }
  }

  assert(
    correctionCount === 8,
    `master clock long playback case: expected 8 corrections, got ${correctionCount}`,
  );
  const correctionEvents = syncEvents.slice(baseSyncCount);
  assert(
    correctionEvents.every((event) => event.shouldPlay),
    'master clock long playback case: every correction should keep playback running',
  );
};

const runAudioPlaybackRestartCooldownCase = (): void => {
  assert(
    !shouldRestartActivePlayback(1.0, 1.26, 0.05),
    'audio playback restart case: recent restart should suppress moderate drift restart',
  );
  assert(
    shouldRestartActivePlayback(1.0, 1.52, 0.05),
    'audio playback restart case: severe drift should still force restart during cooldown',
  );
  assert(
    shouldRestartActivePlayback(1.0, 1.26, 0.18),
    'audio playback restart case: moderate drift should restart after cooldown window',
  );
};

const runAudioPlaybackPreparationWindowCase = (): void => {
  assert(
    shouldRefreshPlaybackPreparation(2_000, null, null),
    'audio playback prepare case: empty window should request preload',
  );
  assert(
    !shouldRefreshPlaybackPreparation(4_000, 2_000, 14_000),
    'audio playback prepare case: mid-window playback should not refresh preload',
  );
  assert(
    shouldRefreshPlaybackPreparation(12_200, 2_000, 14_000),
    'audio playback prepare case: nearing window tail should refresh preload',
  );
  assert(
    shouldRefreshPlaybackPreparation(1_500, 2_000, 14_000),
    'audio playback prepare case: backward seek should refresh preload window',
  );
};

const runMasterClockSeekPreparesAudioWindowCase = async (): Promise<void> => {
  let replayPlaying = false;
  let currentTime = 600;
  let audioClock = 5_000;
  const prepareCalls: Array<{ time: number; windowMs?: number }> = [];

  const replay = {
    play: () => { replayPlaying = true; },
    pause: () => { replayPlaying = false; },
    seek: (time: number) => { currentTime = normalizeTimelineTime(time); },
    isPlaying: () => replayPlaying,
  };
  const audio = {
    unlock: async () => {},
    prepare: async (time: number, windowMs?: number) => {
      prepareCalls.push({ time, windowMs });
    },
    play: () => {},
    sync: () => {},
    getClockNowMs: () => audioClock,
  };

  const clock = new MasterClock();
  clock.configure({
    getReplay: () => replay,
    getAudio: () => audio,
    getCurrentTime: () => currentTime,
    getMaxTime: () => 20_000,
    syncAt: () => {},
    setPlaying: () => {},
  });

  await clock.playPreview();
  const basePrepareCount = prepareCalls.length;
  clock.seek(4_800);
  await Promise.resolve();

  assert(
    prepareCalls.length === basePrepareCount + 1,
    'master clock seek prepare case: seek should schedule one additional audio prepare',
  );
  const lastPrepare = prepareCalls[prepareCalls.length - 1];
  assert(
    lastPrepare.time === 4_800 && lastPrepare.windowMs === 12_000,
    'master clock seek prepare case: seek should prewarm target playback window',
  );
};

const runRecordingTimelineClockFallbackCase = (): void => {
  const clock = new RecordingTimelineClock();
  let wallNow = 1_000;
  let externalNow = 5_000;

  clock.start(320, wallNow);
  clock.attachExternalClock(() => externalNow, wallNow);

  wallNow = 1_450;
  const stalledExternalTime = clock.getTimelineNowMs(wallNow);
  assert(
    stalledExternalTime === 770,
    'recording timeline clock case: stalled external clock should fallback to wall time progression',
  );

  externalNow = 5_620;
  wallNow = 1_500;
  const resumedExternalTime = clock.getTimelineNowMs(wallNow);
  assert(
    resumedExternalTime === 940,
    'recording timeline clock case: resumed external clock should take over when faster',
  );

  clock.detachExternalClock(wallNow);
  wallNow = 1_760;
  const detachedTime = clock.getTimelineNowMs(wallNow);
  assert(
    detachedTime === 1_200,
    'recording timeline clock case: detach should preserve elapsed continuity',
  );
};

const runStrokeSamplingKeepsPointTimesAlignedCase = (): void => {
  const finalized = finalizeStrokeSamples([
    { point: { x: 0, y: 0 }, time: 100 },
    { point: { x: 6, y: 2 }, time: 140 },
    { point: { x: 14, y: 8 }, time: 190 },
    { point: { x: 24, y: 18 }, time: 260 },
  ]);

  assert(
    finalized.points.length === finalized.pointTimes.length,
    'stroke sampling case: finalized points and pointTimes should stay aligned',
  );
  assert(
    finalized.points.length >= 4,
    'stroke sampling case: finalized stroke should keep sufficient samples before freehand shaping',
  );
  assert(
    finalized.pointTimes[0] === 100
      && finalized.pointTimes[finalized.pointTimes.length - 1] === 260,
    'stroke sampling case: finalized timing should preserve endpoints',
  );
  for (let i = 1; i < finalized.pointTimes.length; i += 1) {
    assert(
      finalized.pointTimes[i] >= finalized.pointTimes[i - 1],
      'stroke sampling case: finalized pointTimes should remain monotonic',
    );
  }
};

const runStrokePathUsesCurvedSegmentsCase = (): void => {
  const path = buildPerfectStrokePath([
    { x: 0, y: 0 },
    { x: 10, y: 5 },
    { x: 22, y: 18 },
    { x: 36, y: 20 },
  ], 3.2, { complete: true, variant: 'pen' });
  assert(
    path.includes(' Q ') && path.endsWith(' Z'),
    'stroke path case: perfect-freehand output should be a closed quadratic outline',
  );
};

const runStrokeRealtimeSmoothingStableCase = (): void => {
  const source = [
    { point: { x: 0, y: 0 }, time: 100 },
    { point: { x: 4, y: 3 }, time: 126 },
    { point: { x: 10, y: 7 }, time: 154 },
    { point: { x: 18, y: 11 }, time: 189 },
    { point: { x: 28, y: 16 }, time: 236 },
  ];

  const base = finalizeStrokeSamples(source, { curveSmoothing: false, iterations: 0 });
  const iter2 = finalizeStrokeSamples(source, { curveSmoothing: true, iterations: 2 });
  const iter5 = finalizeStrokeSamples(source, { curveSmoothing: true, iterations: 5 });

  assert(
    iter2.points.length === iter2.pointTimes.length,
    'stroke sampling compatibility case: points and pointTimes should stay aligned',
  );
  assert(
    iter2.points.length >= base.points.length,
    'stroke sampling compatibility case: iterations should increase or preserve sample density',
  );
  assert(
    iter5.points.length >= iter2.points.length,
    'stroke sampling compatibility case: additional iterations should keep or increase sample density',
  );
  assert(
    iter2.pointTimes[0] === 100
      && iter2.pointTimes[iter2.pointTimes.length - 1] === 236,
    'stroke sampling compatibility case: timing endpoints should stay stable',
  );
  for (let i = 1; i < iter2.pointTimes.length; i += 1) {
    assert(
      iter2.pointTimes[i] >= iter2.pointTimes[i - 1],
      'stroke sampling compatibility case: pointTimes should remain monotonic',
    );
  }
};

const runStrokeSamplingMaxPointsCase = (): void => {
  const source = Array.from({ length: 2400 }, (_, index) => ({
    point: { x: index * 0.12, y: Math.sin(index / 20) * 12 },
    time: 100 + index,
  }));
  const finalized = finalizeStrokeSamples(source, {
    iterations: 1,
    maxPoints: 420,
  });

  assert(
    finalized.points.length <= 420,
    'stroke sampling max points case: finalized point count should respect maxPoints',
  );
  assert(
    finalized.points.length === finalized.pointTimes.length,
    'stroke sampling max points case: points and pointTimes should stay aligned',
  );
  assert(
    finalized.pointTimes[0] === 100
      && finalized.pointTimes[finalized.pointTimes.length - 1] === 2499,
    'stroke sampling max points case: decimation should keep timing endpoints',
  );
};

const runWhiteboardPanProjectionStaysStableCase = (): void => {
  const nextViewport = projectPanViewportFromScreenDelta(
    { x: 200, y: 120, zoom: 2 },
    180,
    -90,
    1200,
    680,
    1200,
    680,
  );
  assert(
    nextViewport.x === 110 && nextViewport.y === 165 && nextViewport.zoom === 2,
    'whiteboard pan case: pan projection should use screen delta and keep stable world movement',
  );

  const clampedViewport = clampViewportToBoard(
    { x: -200, y: 900, zoom: 2 },
    1200,
    680,
  );
  assert(
    clampedViewport.x === 0 && clampedViewport.y === 340,
    'whiteboard pan case: viewport should clamp to board bounds',
  );
};

const runWhiteboardObjectPositionClampsToBoardCase = (): void => {
  const clamped = clampObjectPositionToBoard(1180, -24, 80, 90, 1200, 680);
  assert(
    clamped.x === 1120 && clamped.y === 0,
    'whiteboard object clamp case: dragged object should stay inside board bounds',
  );
};

const runWhiteboardScreenPointProjectionCase = (): void => {
  const point = projectScreenPointToWorld(
    460,
    250,
    { left: 100, top: 50, width: 1200, height: 600 },
    { x: 240, y: 120, zoom: 2 },
    1200,
    680,
  );
  assert(!!point, 'whiteboard projection case: projection should resolve world point');
  assert(
    Math.abs(point!.x - 404) < 0.001 && Math.abs(point!.y - 233.3333333333) < 0.001,
    'whiteboard projection case: screen point should map into current viewport consistently',
  );
};

const runWhiteboardLetterboxProjectionCase = (): void => {
  const viewportRect = resolveWhiteboardViewportRect(
    { left: 100, top: 50, width: 1600, height: 600 },
    1200,
    680,
  );
  assert(!!viewportRect, 'whiteboard letterbox case: expected fitted viewport rect');
  assert(
    Math.abs(viewportRect!.left - 370.5882352941) < 0.001
    && Math.abs(viewportRect!.width - 1058.8235294118) < 0.001,
    'whiteboard letterbox case: expected horizontal inset fit rect',
  );

  const centeredPoint = projectScreenPointToWorld(
    viewportRect!.left + viewportRect!.width / 2,
    viewportRect!.top + viewportRect!.height / 2,
    { left: 100, top: 50, width: 1600, height: 600 },
    { x: 240, y: 120, zoom: 2 },
    1200,
    680,
  );
  assert(!!centeredPoint, 'whiteboard letterbox case: center point should project');
  assert(
    Math.abs(centeredPoint!.x - 540) < 0.001 && Math.abs(centeredPoint!.y - 290) < 0.001,
    'whiteboard letterbox case: visible center should project to viewport center',
  );

  const outsidePoint = projectScreenPointToWorld(
    120,
    80,
    { left: 100, top: 50, width: 1600, height: 600 },
    { x: 240, y: 120, zoom: 2 },
    1200,
    680,
  );
  assert(outsidePoint === null, 'whiteboard letterbox case: pointer outside board content should not project');
};

const runWhiteboardDeleteKeyGuardCase = (): void => {
  assert(
    shouldHandleCanvasDeleteKey('Delete', 'DIV', false),
    'whiteboard delete guard case: canvas host should accept delete key',
  );
  assert(
    shouldHandleCanvasDeleteKey('Backspace', 'SVG', false),
    'whiteboard delete guard case: canvas svg should accept backspace',
  );
  assert(
    !shouldHandleCanvasDeleteKey('Delete', 'INPUT', false),
    'whiteboard delete guard case: input should keep delete key',
  );
  assert(
    !shouldHandleCanvasDeleteKey('Backspace', 'TEXTAREA', false),
    'whiteboard delete guard case: textarea should keep backspace',
  );
  assert(
    !shouldHandleCanvasDeleteKey('Delete', 'DIV', true),
    'whiteboard delete guard case: contenteditable region should keep delete key',
  );
};

const runWhiteboardResizeProjectionCase = (): void => {
  const base = { x: 100, y: 120, width: 220, height: 160 };
  const handles = getRectResizeHandles(base);
  assert(handles.length === 8, 'whiteboard resize case: expected eight resize handles');
  assert(
    handles.some((handle) => handle.handle === 'n' && handle.point.x === 210 && handle.point.y === 120),
    'whiteboard resize case: expected top-middle resize handle',
  );

  const seAnchor = getResizeHandleAnchor(base, 'se' satisfies RectResizeHandle);
  assert(seAnchor.x === 100 && seAnchor.y === 120, 'whiteboard resize case: se anchor mismatch');
  const resized = resizeRectFromHandle(base, { x: 360, y: 340 }, 'se', 1200, 680, 12);
  assert(
    resized.x === 100 && resized.y === 120 && resized.width === 260 && resized.height === 220,
    'whiteboard resize case: southeast resize should preserve opposite corner as anchor',
  );

  const nwAnchor = getResizeHandleAnchor(base, 'nw' satisfies RectResizeHandle);
  assert(nwAnchor.x === 320 && nwAnchor.y === 280, 'whiteboard resize case: nw anchor mismatch');
  const clamped = resizeRectFromHandle(base, { x: -50, y: 20 }, 'nw', 1200, 680, 12);
  assert(
    clamped.x === 0 && clamped.y === 20 && clamped.width === 320 && clamped.height === 260,
    'whiteboard resize case: northwest resize should clamp back into board bounds',
  );

  const eastOnly = resizeRectFromHandle(base, { x: 390, y: 420 }, 'e', 1200, 680, 12);
  assert(
    eastOnly.x === 100 && eastOnly.y === 120 && eastOnly.width === 290 && eastOnly.height === 160,
    'whiteboard resize case: east handle should keep vertical bounds unchanged',
  );

  const groupBounds = { x: 100, y: 120, width: 300, height: 180 };
  const nextBounds = resizeRectFromHandle(groupBounds, { x: 460, y: 350 }, 'se', 1200, 680, 12);
  const mapped = mapRectToResizedBounds(
    { x: 160, y: 150, width: 90, height: 60 },
    groupBounds,
    nextBounds,
    12,
  );
  assert(
    Math.abs(mapped.x - 172) < 0.001
      && Math.abs(mapped.y - 158.3333333333) < 0.001
      && Math.abs(mapped.width - 108) < 0.001
      && Math.abs(mapped.height - 76.6666666667) < 0.001,
    'whiteboard resize case: mapped group rect should scale with resized selection bounds',
  );
};

const runWhiteboardMultiSelectionHelpersCase = (): void => {
  const single = toggleObjectSelection(['obj-a', 'obj-b'], 'obj-c', false);
  assert(
    JSON.stringify(single) === JSON.stringify(['obj-c']),
    'whiteboard multi-select case: single select should replace previous selection',
  );

  const added = toggleObjectSelection(['obj-a'], 'obj-b', true);
  assert(
    JSON.stringify(added) === JSON.stringify(['obj-a', 'obj-b']),
    'whiteboard multi-select case: multi-select should append new object',
  );

  const removed = toggleObjectSelection(['obj-a', 'obj-b'], 'obj-a', true);
  assert(
    JSON.stringify(removed) === JSON.stringify(['obj-b']),
    'whiteboard multi-select case: multi-select should toggle object off',
  );

  const pruned = pruneObjectSelection(['obj-a', 'obj-b', 'obj-c'], ['obj-b', 'obj-d']);
  assert(
    JSON.stringify(pruned) === JSON.stringify(['obj-b']),
    'whiteboard multi-select case: prune should drop invisible objects',
  );

  const bounds = getSelectionBounds([
    { x: 40, y: 60, width: 120, height: 80 },
    { x: 220, y: 110, width: 140, height: 90 },
  ]);
  assert(!!bounds, 'whiteboard multi-select case: expected bounds for selection');
  assert(
    bounds!.x === 40 && bounds!.y === 60 && bounds!.width === 320 && bounds!.height === 140,
    'whiteboard multi-select case: group bounds should wrap selected objects',
  );
};

const runWhiteboardRotatedRectHitCase = (): void => {
  const object = {
    id: 'obj-rot',
    type: 'rect' as const,
    x: 100,
    y: 120,
    width: 120,
    height: 80,
    rotation: 45,
    createdAt: 0,
  };
  assert(
    hitRectObject({ x: 160, y: 160 }, object),
    'whiteboard rotated hit case: center region should still hit rotated object',
  );
  assert(
    !hitRectObject({ x: 80, y: 80 }, object),
    'whiteboard rotated hit case: far outside point should not hit rotated object',
  );
};

const runWhiteboardObjectZIndexOrderingCase = (): void => {
  const state = createInitialProjectState(DEFAULT_PROJECT_ID, DEFAULT_PAGE_ID);
  const page = state.pages[state.currentPageId];
  page.objects['obj-low'] = {
    id: 'obj-low',
    type: 'rect',
    x: 40,
    y: 40,
    width: 100,
    height: 80,
    style: { zIndex: -1 },
    createdAt: 100,
  };
  page.objects['obj-mid'] = {
    id: 'obj-mid',
    type: 'rect',
    x: 50,
    y: 50,
    width: 100,
    height: 80,
    style: { zIndex: 0 },
    createdAt: 90,
  };
  page.objects['obj-high'] = {
    id: 'obj-high',
    type: 'rect',
    x: 60,
    y: 60,
    width: 100,
    height: 80,
    style: { zIndex: 3 },
    createdAt: 80,
  };

  const ordered = getVisibleObjects(state, 99999).map((object) => object.id);
  assert(
    JSON.stringify(ordered) === JSON.stringify(['obj-low', 'obj-mid', 'obj-high']),
    'whiteboard z-index case: visible object ordering should follow zIndex then createdAt',
  );
};

const runNativeTimelineAdapterParityCase = async (): Promise<void> => {
  const initialState = createInitialProjectState(DEFAULT_PROJECT_ID, DEFAULT_PAGE_ID);
  const events: TimelineEvent[] = [
    {
      id: 'native-page',
      projectId: DEFAULT_PROJECT_ID,
      pageId: DEFAULT_PAGE_ID,
      actorId: 'test',
      time: 0,
      type: TimelineEventType.PAGE_SET,
      targetId: 'page-2',
      payload: { pageId: 'page-2' },
    },
    {
      id: 'native-stroke',
      projectId: DEFAULT_PROJECT_ID,
      pageId: 'page-2',
      actorId: 'test',
      time: 120,
      type: TimelineEventType.STROKE_CREATE,
      targetId: 'stroke-native-1',
      payload: {
        id: 'stroke-native-1',
        points: [
          { x: 12, y: 20 },
          { x: 48, y: 76 },
        ],
        pointTimes: [120, 240],
        color: '#111111',
        width: 2,
      },
    },
    {
      id: 'native-erase',
      projectId: DEFAULT_PROJECT_ID,
      pageId: 'page-2',
      actorId: 'test',
      time: 360,
      type: TimelineEventType.STROKE_ERASE,
      targetId: 'stroke-native-1',
      payload: { strokeId: 'stroke-native-1' },
    },
    {
      id: 'native-vp',
      projectId: DEFAULT_PROJECT_ID,
      pageId: 'page-2',
      actorId: 'test',
      time: 520,
      type: TimelineEventType.VIEWPORT_SET,
      payload: { x: 18, y: 24, zoom: 1.2 },
    },
  ];

  const atTime = 300;
  const expectedState = getStateAtTime(initialState, events, atTime);
  const actualState = await nativeTimelineAdapter.getStateAtTime(initialState, events, atTime);
  assert(
    JSON.stringify(actualState) === JSON.stringify(expectedState),
    'native adapter parity case: getStateAtTime mismatch',
  );

  const insertEventDraft: TimelineEvent = {
    id: 'native-insert',
    projectId: DEFAULT_PROJECT_ID,
    pageId: 'page-2',
    actorId: 'test',
    time: 260,
    type: TimelineEventType.VIEWPORT_SET,
    payload: { x: 9, y: 6, zoom: 1.05 },
  };
  const expectedInserted = insertEvent(events, insertEventDraft);
  const actualInserted = await nativeTimelineAdapter.insertEvent(events, insertEventDraft);
  assert(
    JSON.stringify(actualInserted) === JSON.stringify(expectedInserted),
    'native adapter parity case: insertEvent mismatch',
  );

  const expectedDeleted = deleteEvent(events, 'native-vp');
  const actualDeleted = await nativeTimelineAdapter.deleteEvent(events, 'native-vp');
  assert(
    JSON.stringify(actualDeleted) === JSON.stringify(expectedDeleted),
    'native adapter parity case: deleteEvent mismatch',
  );

  const expectedDeletedRange = deleteTimeRange(events, 100, 400);
  const actualDeletedRange = await nativeTimelineAdapter.deleteTimeRange(events, 100, 400);
  assert(
    JSON.stringify(actualDeletedRange) === JSON.stringify(expectedDeletedRange),
    'native adapter parity case: deleteTimeRange mismatch',
  );

  const expectedRipple = rippleDeleteTimeRange(events, 200, 400);
  const actualRipple = await nativeTimelineAdapter.rippleDeleteTimeRange(events, 200, 400);
  assert(
    JSON.stringify(actualRipple) === JSON.stringify(expectedRipple),
    'native adapter parity case: rippleDeleteTimeRange mismatch',
  );

  const expectedSplit = splitTimeline(events, 240);
  const actualSplit = await nativeTimelineAdapter.splitTimeline(events, 240);
  assert(
    JSON.stringify(actualSplit) === JSON.stringify(expectedSplit),
    'native adapter parity case: splitTimeline mismatch',
  );

  const expectedMoved = moveEvent(events, 'native-vp', 840);
  const actualMoved = await nativeTimelineAdapter.moveEvent(events, 'native-vp', 840);
  assert(
    JSON.stringify(actualMoved) === JSON.stringify(expectedMoved),
    'native adapter parity case: moveEvent mismatch',
  );

  const expectedGap = insertTimeGap(events, 220, 120, ['native-vp']);
  const actualGap = await nativeTimelineAdapter.insertTimeGap(events, 220, 120, ['native-vp']);
  assert(
    JSON.stringify(actualGap) === JSON.stringify(expectedGap),
    'native adapter parity case: insertTimeGap mismatch',
  );

  const expectedMaxTime = Math.max(...events.map((event) => event.time));
  const actualMaxTime = await nativeTimelineAdapter.getTimelineMaxTime(events);
  assert(actualMaxTime === expectedMaxTime, 'native adapter parity case: getTimelineMaxTime mismatch');
};

const runTimelineCommandAsyncAdapterRoutingCase = async (): Promise<void> => {
  const events: TimelineEvent[] = [
    {
      id: 'route-1',
      projectId: DEFAULT_PROJECT_ID,
      pageId: DEFAULT_PAGE_ID,
      actorId: 'test',
      time: 100,
      type: TimelineEventType.VIEWPORT_SET,
      payload: { x: 1, y: 0, zoom: 1 },
    },
    {
      id: 'route-2',
      projectId: DEFAULT_PROJECT_ID,
      pageId: DEFAULT_PAGE_ID,
      actorId: 'test',
      time: 260,
      type: TimelineEventType.VIEWPORT_SET,
      payload: { x: 2, y: 0, zoom: 1 },
    },
    {
      id: 'route-3',
      projectId: DEFAULT_PROJECT_ID,
      pageId: DEFAULT_PAGE_ID,
      actorId: 'test',
      time: 480,
      type: TimelineEventType.VIEWPORT_SET,
      payload: { x: 3, y: 0, zoom: 1 },
    },
  ];
  const audio = [createAudio('route-audio', 150, 520)];
  const context = {
    currentTime: 500,
    currentPageId: DEFAULT_PAGE_ID,
    events,
    audioSegments: audio,
    timelineSegments: deriveTimelineSegments(
      DEFAULT_PROJECT_ID,
      DEFAULT_PAGE_ID,
      events,
      Math.max(...events.map((event) => event.time)),
    ),
    createEvent: <T extends TimelineEventType>(
      event: TimelineEventDraft<T> & { time?: number },
    ) => ({
      id: 'route-generated-event',
      projectId: DEFAULT_PROJECT_ID,
      actorId: 'test',
      pageId: event.pageId,
      time: event.time ?? 0,
      type: event.type,
      targetId: event.targetId,
      payload: event.payload,
    }) as TimelineEventOfType<T>,
  };

  const calls = {
    insertEvent: 0,
    deleteTimeRange: 0,
    rippleDeleteTimeRange: 0,
    splitTimeline: 0,
    moveEvent: 0,
    insertTimeGap: 0,
    getTimelineMaxTime: 0,
  };

  const adapter: NativeTimelineAdapter = {
    ...nativeTimelineAdapter,
    applyEvent: async (state, event) => nativeTimelineAdapter.applyEvent(state, event),
    applyEvents: async (initialState, rows) => nativeTimelineAdapter.applyEvents(initialState, rows),
    getStateAtTime: async (initialState, rows, time) => nativeTimelineAdapter.getStateAtTime(initialState, rows, time),
    insertEvent: async (rows, event) => {
      calls.insertEvent += 1;
      return insertEvent(rows, event);
    },
    deleteEvent: async (rows, eventId) => deleteEvent(rows, eventId),
    deleteTimeRange: async (rows, start, end) => {
      calls.deleteTimeRange += 1;
      return deleteTimeRange(rows, start, end);
    },
    rippleDeleteTimeRange: async (rows, start, end) => {
      calls.rippleDeleteTimeRange += 1;
      return rippleDeleteTimeRange(rows, start, end);
    },
    splitTimeline: async (rows, time) => {
      calls.splitTimeline += 1;
      return splitTimeline(rows, time);
    },
    moveEvent: async (rows, eventId, newTime) => {
      calls.moveEvent += 1;
      return moveEvent(rows, eventId, newTime);
    },
    insertTimeGap: async (rows, startTime, duration, eventIds) => {
      calls.insertTimeGap += 1;
      return insertTimeGap(rows, startTime, duration, eventIds);
    },
    getTimelineMaxTime: async (rows) => {
      calls.getTimelineMaxTime += 1;
      return getTimelineMaxTime(rows);
    },
    isAvailable: async () => true,
  };

  const beforeDeleteRange = { ...calls };
  await executeTimelineCommandAsync(context, { kind: 'delete_range', start: 120, end: 300 }, { adapter });
  assert(
    calls.deleteTimeRange > beforeDeleteRange.deleteTimeRange,
    'timeline command routing case: delete_range should call adapter.deleteTimeRange',
  );

  const beforeRipple = { ...calls };
  await executeTimelineCommandAsync(context, { kind: 'ripple_delete_range', start: 120, end: 300 }, { adapter });
  assert(
    calls.rippleDeleteTimeRange > beforeRipple.rippleDeleteTimeRange,
    'timeline command routing case: ripple_delete_range should call adapter.rippleDeleteTimeRange',
  );

  const beforeSplit = { ...calls };
  await executeTimelineCommandAsync(context, { kind: 'split_at', time: 320 }, { adapter });
  assert(
    calls.splitTimeline > beforeSplit.splitTimeline,
    'timeline command routing case: split_at should call adapter.splitTimeline',
  );
  assert(
    calls.insertEvent > beforeSplit.insertEvent,
    'timeline command routing case: split_at should call adapter.insertEvent',
  );

  const beforeMove = { ...calls };
  await executeTimelineCommandAsync(context, { kind: 'move_event_time', eventId: 'route-3', newTime: 640 }, { adapter });
  assert(
    calls.moveEvent > beforeMove.moveEvent,
    'timeline command routing case: move_event_time should call adapter.moveEvent',
  );

  const beforeInsertGap = { ...calls };
  await executeTimelineCommandAsync(
    context,
    {
      kind: 'insert_gap',
      start: 220,
      duration: 120,
      eventIds: ['route-3'],
      audioIds: ['route-audio'],
    },
    { adapter },
  );
  assert(
    calls.insertTimeGap > beforeInsertGap.insertTimeGap,
    'timeline command routing case: insert_gap should call adapter.insertTimeGap',
  );

  const beforeDeleteFuture = { ...calls };
  await executeTimelineCommandAsync(context, { kind: 'delete_future', time: 260 }, { adapter });
  assert(
    calls.getTimelineMaxTime > beforeDeleteFuture.getTimelineMaxTime,
    'timeline command routing case: delete_future should call adapter.getTimelineMaxTime',
  );
  assert(
    calls.deleteTimeRange > beforeDeleteFuture.deleteTimeRange,
    'timeline command routing case: delete_future should call adapter.deleteTimeRange',
  );
};

const runTimelineCommandAsyncParityCase = async (): Promise<void> => {
  const events: TimelineEvent[] = [
    {
      id: 'cmd-1',
      projectId: DEFAULT_PROJECT_ID,
      pageId: DEFAULT_PAGE_ID,
      actorId: 'test',
      time: 100,
      type: TimelineEventType.VIEWPORT_SET,
      payload: { x: 1, y: 0, zoom: 1 },
    },
    {
      id: 'cmd-2',
      projectId: DEFAULT_PROJECT_ID,
      pageId: DEFAULT_PAGE_ID,
      actorId: 'test',
      time: 260,
      type: TimelineEventType.VIEWPORT_SET,
      payload: { x: 2, y: 0, zoom: 1 },
    },
    {
      id: 'cmd-3',
      projectId: DEFAULT_PROJECT_ID,
      pageId: DEFAULT_PAGE_ID,
      actorId: 'test',
      time: 480,
      type: TimelineEventType.VIEWPORT_SET,
      payload: { x: 3, y: 0, zoom: 1 },
    },
  ];
  const audio = [createAudio('cmd-audio', 150, 520)];
  const context = {
    currentTime: 500,
    currentPageId: DEFAULT_PAGE_ID,
    events,
    audioSegments: audio,
    timelineSegments: deriveTimelineSegments(
      DEFAULT_PROJECT_ID,
      DEFAULT_PAGE_ID,
      events,
      Math.max(...events.map((event) => event.time)),
    ),
    createEvent: <T extends TimelineEventType>(
      event: TimelineEventDraft<T> & { time?: number },
    ) => ({
      id: 'generated-event',
      projectId: DEFAULT_PROJECT_ID,
      actorId: 'test',
      pageId: event.pageId,
      time: event.time ?? 0,
      type: event.type,
      targetId: event.targetId,
      payload: event.payload,
    }) as TimelineEventOfType<T>,
  };

  const commands: Array<{ name: string; value: TimelineCommand }> = [
    {
      name: 'insert_event',
      value: {
        kind: 'insert_event' as const,
        event: {
          id: 'cmd-insert',
          projectId: DEFAULT_PROJECT_ID,
          pageId: DEFAULT_PAGE_ID,
          actorId: 'test',
          time: 320,
          type: TimelineEventType.VIEWPORT_SET,
          payload: { x: 9, y: 0, zoom: 1 },
        } as TimelineEvent,
      },
    },
    { name: 'delete_event', value: { kind: 'delete_event' as const, eventId: 'cmd-2' } },
    { name: 'delete_range', value: { kind: 'delete_range' as const, start: 120, end: 300 } },
    {
      name: 'ripple_delete_range',
      value: { kind: 'ripple_delete_range' as const, start: 120, end: 300 },
    },
    {
      name: 'split_at',
      value: { kind: 'split_at' as const, time: 320 },
    },
    { name: 'delete_future', value: { kind: 'delete_future' as const, time: 260 } },
    {
      name: 'move_event_time',
      value: { kind: 'move_event_time' as const, eventId: 'cmd-3', newTime: 640 },
    },
    {
      name: 'insert_gap',
      value: {
        kind: 'insert_gap' as const,
        start: 220,
        duration: 120,
        eventIds: ['cmd-3'],
        audioIds: ['cmd-audio'],
      },
    },
  ];

  for (const command of commands) {
    const syncResult = executeTimelineCommand(context, command.value);
    const asyncResult = await executeTimelineCommandAsync(context, command.value);
    assert(
      JSON.stringify(asyncResult) === JSON.stringify(syncResult),
      `timeline command async parity case: ${command.name} mismatch`,
    );
  }
};

export const runTimelineRegressionSuite = async (): Promise<RegressionCaseResult[]> => {
  const cases: Array<{ name: string; run: () => void | Promise<void> }> = [
    { name: 'delete_event_transaction', run: runDeleteEventTransactionCase },
    { name: 'move_event_transaction', run: runMoveEventTransactionCase },
    { name: 'split_selected_segment_transaction', run: runSplitSelectedSegmentTransactionCase },
    { name: 'insert_gap_ripple_undo_redo', run: runInsertGapRippleUndoRedoCase },
    { name: 'insert_gap_no_history_boundary', run: runInsertGapNoHistoryBoundaryCase },
    { name: 'project_page_switch_event', run: runProjectPageSwitchEventCase },
    { name: 'export_consistency_assertion', run: runExportConsistencyAssertionCase },
    { name: 'recording_mode_history_boundary', run: runRecordingModeHistoryBoundaryCase },
    { name: 'export_keyframe_parity', run: runExportKeyframeParityCase },
    { name: 'export_preview_parity_after_timeline_transactions', run: runExportPreviewParityAfterTimelineTransactionsCase },
    { name: 'export_long_sample_fingerprint_reconciliation', run: runExportLongSampleFingerprintReconciliationCase },
    { name: 'master_clock_drift_correction', run: runMasterClockDriftCorrectionCase },
    { name: 'master_clock_drift_multi_cycle', run: runMasterClockDriftMultiCycleCase },
    { name: 'master_clock_seek_reanchor', run: runMasterClockSeekReanchorCase },
    { name: 'master_clock_seek_resets_drift_throttle', run: runMasterClockSeekResetsDriftThrottleCase },
    { name: 'master_clock_long_playback_pressure', run: runMasterClockLongPlaybackPressureCase },
    { name: 'audio_playback_restart_cooldown', run: runAudioPlaybackRestartCooldownCase },
    { name: 'audio_playback_prepare_window_rollover', run: runAudioPlaybackPreparationWindowCase },
    { name: 'master_clock_seek_prepares_audio_window', run: runMasterClockSeekPreparesAudioWindowCase },
    { name: 'recording_timeline_clock_external_fallback', run: runRecordingTimelineClockFallbackCase },
    { name: 'stroke_sampling_keeps_point_times_aligned', run: runStrokeSamplingKeepsPointTimesAlignedCase },
    { name: 'stroke_path_uses_curved_segments', run: runStrokePathUsesCurvedSegmentsCase },
    { name: 'stroke_realtime_smoothing_stable', run: runStrokeRealtimeSmoothingStableCase },
    { name: 'stroke_sampling_max_points', run: runStrokeSamplingMaxPointsCase },
    { name: 'whiteboard_pan_projection_stays_stable', run: runWhiteboardPanProjectionStaysStableCase },
    { name: 'whiteboard_object_position_clamps_to_board', run: runWhiteboardObjectPositionClampsToBoardCase },
    { name: 'whiteboard_screen_point_projection', run: runWhiteboardScreenPointProjectionCase },
    { name: 'whiteboard_letterbox_projection', run: runWhiteboardLetterboxProjectionCase },
    { name: 'whiteboard_delete_key_guard', run: runWhiteboardDeleteKeyGuardCase },
    { name: 'whiteboard_resize_projection', run: runWhiteboardResizeProjectionCase },
    { name: 'whiteboard_multi_selection_helpers', run: runWhiteboardMultiSelectionHelpersCase },
    { name: 'whiteboard_rotated_rect_hit', run: runWhiteboardRotatedRectHitCase },
    { name: 'whiteboard_object_zindex_ordering', run: runWhiteboardObjectZIndexOrderingCase },
    { name: 'native_timeline_adapter_parity', run: runNativeTimelineAdapterParityCase },
    { name: 'timeline_command_async_adapter_routing', run: runTimelineCommandAsyncAdapterRoutingCase },
    { name: 'timeline_command_async_parity', run: runTimelineCommandAsyncParityCase },
  ];

  const results: RegressionCaseResult[] = [];
  for (const test of cases) {
    try {
      await test.run();
      results.push({ name: test.name, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name: test.name, ok: false, message });
    }
  }
  return results;
};
