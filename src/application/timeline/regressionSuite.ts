import {
  createInitialProjectState,
  AudioSegment,
  DEFAULT_PROJECT_ID,
  DEFAULT_PAGE_ID,
  TimelineEvent,
  TimelineEventType,
} from '../../domain/types';
import { useWhiteboardStore } from '../../store/useWhiteboardStore';
import {
  assertExportTimelineConsistency,
  getExportTimelineStats,
  normalizeExportTimeline,
} from '../export/exportTimelineConsistency';
import {
  getStateAtTime,
  insertEvent,
  moveEvent,
  rippleDeleteTimeRange,
  splitTimeline,
} from '../../engine/timelineEngine';
import { MasterClock } from '../clock/MasterClock';
import { normalizeTimelineTime } from '../../domain/time';
import { nativeTimelineAdapter } from '../../infrastructure/platform/nativeTimeline';

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
};

export const runTimelineRegressionSuite = async (): Promise<RegressionCaseResult[]> => {
  const cases: Array<{ name: string; run: () => void | Promise<void> }> = [
    { name: 'delete_event_transaction', run: runDeleteEventTransactionCase },
    { name: 'move_event_transaction', run: runMoveEventTransactionCase },
    { name: 'insert_gap_ripple_undo_redo', run: runInsertGapRippleUndoRedoCase },
    { name: 'insert_gap_no_history_boundary', run: runInsertGapNoHistoryBoundaryCase },
    { name: 'export_consistency_assertion', run: runExportConsistencyAssertionCase },
    { name: 'recording_mode_history_boundary', run: runRecordingModeHistoryBoundaryCase },
    { name: 'export_keyframe_parity', run: runExportKeyframeParityCase },
    { name: 'export_preview_parity_after_timeline_transactions', run: runExportPreviewParityAfterTimelineTransactionsCase },
    { name: 'master_clock_drift_correction', run: runMasterClockDriftCorrectionCase },
    { name: 'master_clock_drift_multi_cycle', run: runMasterClockDriftMultiCycleCase },
    { name: 'master_clock_seek_reanchor', run: runMasterClockSeekReanchorCase },
    { name: 'native_timeline_adapter_parity', run: runNativeTimelineAdapterParityCase },
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
