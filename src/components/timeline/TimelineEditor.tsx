import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioSegment,
  createInitialProjectState,
  DEFAULT_PAGE_ID,
  DEFAULT_PROJECT_ID,
  TimelineEvent,
  WaveformPoint,
} from '../../domain/types';
import { ReplayEngine } from '../../engine/replayEngine';
import { getEventEndTime, getTimelineMaxTime } from '../../engine/timelineEngine';
import { useWhiteboardStore } from '../../store/useWhiteboardStore';
import { TimelineTrack } from './TimelineTrack';
import { normalizeTimelineTime } from '../../domain/time';
import { createMockWaveform } from '../../domain/timelineSegments';
import { generateId } from '../../utils/id';
import { MasterClock } from '../../application/clock/MasterClock';
import { recordingTimelineRuntime } from '../../application/clock/recordingTimelineRuntime';
import {
  createRecorderAdapter,
  RecorderAdapter,
} from '../../utils/audioRecorder';
import { buildWaveformFromAudioBlob } from '../../utils/waveform';
import { AudioPlaybackEngine } from '../../engine/audioPlaybackEngine';
import {
  deriveOperationAvailability,
  resolveOperationMode,
} from '../../application/operations/operationStateMachine';
import { useExportJobStore } from '../../store/useExportJobStore';
import { OperationBar } from './OperationBar';
import {
  getRecordingSupportInfo,
  requestAudioInputStream,
  stopMediaStreamTracks,
} from '../../infrastructure/platform/audioIO';
import {
  createStreamAnalyser,
  StreamAnalyserHandle,
} from '../../infrastructure/platform/audioContext';
import {
  cancelPlatformFrame,
  platformNowMs,
  requestPlatformFrame,
} from '../../infrastructure/platform/frameScheduler';

const getEditorMaxTime = (events: TimelineEvent[], audioSegments: { endTime: number }[], currentTime: number): number => {
  const eventMax = getTimelineMaxTime(events);
  const audioMax = audioSegments.length > 0 ? Math.max(...audioSegments.map((seg) => seg.endTime)) : 0;
  return Math.max(eventMax, audioMax, currentTime);
};
const INSERT_SYNC_STEP_MS = 60;
const TIMELINE_FPS = 60;

type ContextMenuState = {
  clientX: number;
  clientY: number;
  time: number;
};

const formatDurationClock = (timeMs: number): string => {
  const totalFrames = Math.max(0, Math.round((normalizeTimelineTime(timeMs) * TIMELINE_FPS) / 1000));
  const totalSeconds = Math.floor(totalFrames / TIMELINE_FPS);
  const frame = totalFrames % TIMELINE_FPS;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(frame).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(frame).padStart(2, '0')}`;
};

export const TimelineEditor: React.FC = () => {
  const events = useWhiteboardStore((s) => s.events);
  const timelineSegments = useWhiteboardStore((s) => s.timelineSegments);
  const audioSegments = useWhiteboardStore((s) => s.audioSegments);
  const currentTime = useWhiteboardStore((s) => s.currentTime);
  const selectedEventId = useWhiteboardStore((s) => s.selectedEventId);
  const selectedSegmentId = useWhiteboardStore((s) => s.selectedSegmentId);
  const recordingStatus = useWhiteboardStore((s) => s.recordingStatus);
  const runningExportJobId = useExportJobStore((s) => s.runningJobId);

  const seek = useWhiteboardStore((s) => s.seek);
  const setSelectedEvent = useWhiteboardStore((s) => s.setSelectedEvent);
  const setSelectedSegment = useWhiteboardStore((s) => s.setSelectedSegment);
  const deleteRange = useWhiteboardStore((s) => s.deleteRange);
  const rippleDeleteRange = useWhiteboardStore((s) => s.rippleDeleteRange);
  const deleteFuture = useWhiteboardStore((s) => s.deleteFuture);
  const splitSelectedSegmentAt = useWhiteboardStore((s) => s.splitSelectedSegmentAt);
  const applyReplayFrame = useWhiteboardStore((s) => s.applyReplayFrame);
  const addAudioSegment = useWhiteboardStore((s) => s.addAudioSegment);
  const insertGap = useWhiteboardStore((s) => s.insertGap);
  const setRecordingStatus = useWhiteboardStore((s) => s.setRecordingStatus);

  const replayRef = useRef<ReplayEngine | null>(null);
  const masterClockRef = useRef<MasterClock | null>(null);
  const recorderRef = useRef<RecorderAdapter | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingOriginTimelineRef = useRef(0);
  const recordingBaseEventIdsRef = useRef<string[]>([]);
  const recordingBaseAudioIdsRef = useRef<string[]>([]);
  const insertedGapDurationRef = useRef(0);
  const audioEngineRef = useRef<AudioPlaybackEngine | null>(null);
  const audioSegmentsRef = useRef(audioSegments);
  const liveAnalyserHandleRef = useRef<StreamAnalyserHandle | null>(null);
  const liveAnalyserRef = useRef<AnalyserNode | null>(null);
  const liveMonitorRafRef = useRef<number | null>(null);
  const liveWaveformRef = useRef<WaveformPoint[]>([]);
  const liveLastSampleRef = useRef(0);
  const liveLastUiRef = useRef(0);
  const liveRecordingIdRef = useRef<string>('aud-live');

  const [playing, setPlaying] = useState(false);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  const [recordMode, setRecordMode] = useState<'append' | 'insert'>('append');
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [liveRecordingSegment, setLiveRecordingSegment] = useState<AudioSegment | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const maxTime = useMemo(
    () => getEditorMaxTime(events, audioSegments, currentTime),
    [events, audioSegments, currentTime],
  );
  const selectedSegment = useMemo(
    () => timelineSegments.find((segment) => segment.id === selectedSegmentId),
    [timelineSegments, selectedSegmentId],
  );
  const syncAudioAtTime = useCallback((time: number, shouldPlay: boolean) => {
    audioEngineRef.current?.sync(time, shouldPlay);
  }, []);

  useEffect(() => {
    audioSegmentsRef.current = audioSegments;
    audioEngineRef.current?.setSegments(audioSegments);
  }, [audioSegments]);

  useEffect(() => {
    audioEngineRef.current = new AudioPlaybackEngine();
    audioEngineRef.current.setSegments(audioSegmentsRef.current);
    masterClockRef.current = new MasterClock();

    replayRef.current = new ReplayEngine({
      initialState: createInitialProjectState(DEFAULT_PROJECT_ID, DEFAULT_PAGE_ID),
      getEvents: () => useWhiteboardStore.getState().events,
      fps: 60,
      clock: {
        now: () => masterClockRef.current?.nowMs() ?? platformNowMs(),
        requestFrame: (callback) => requestPlatformFrame(callback),
        cancelFrame: (id) => cancelPlatformFrame(id),
      },
      getMaxTime: () => {
        const store = useWhiteboardStore.getState();
        return getEditorMaxTime(store.events, store.audioSegments, store.currentTime);
      },
      onFrame: (state, time) => {
        applyReplayFrame(state, time);
        const isPlaying = replayRef.current?.isPlaying() ?? false;
        masterClockRef.current?.stabilizePlaybackDrift();
        syncAudioAtTime(time, isPlaying);
        setPlaying((prev) => (prev === isPlaying ? prev : isPlaying));
      },
    });

    masterClockRef.current.configure({
      getReplay: () => replayRef.current,
      getAudio: () => audioEngineRef.current,
      getCurrentTime: () => useWhiteboardStore.getState().currentTime,
      getMaxTime: () => {
        const store = useWhiteboardStore.getState();
        return getEditorMaxTime(store.events, store.audioSegments, store.currentTime);
      },
      syncAt: (time, shouldPlay) => syncAudioAtTime(time, shouldPlay),
      setPlaying,
    });

    return () => {
      masterClockRef.current?.pausePreview();
      replayRef.current = null;
      masterClockRef.current = null;
      recorderRef.current?.dispose();
      stopMediaStreamTracks(streamRef.current);
      recorderRef.current = null;
      streamRef.current = null;
      recordingTimelineRuntime.reset();
      void stopLiveWaveMonitor();
      void audioEngineRef.current?.dispose();
      audioEngineRef.current = null;
    };
  }, [applyReplayFrame, syncAudioAtTime]);

  useEffect(() => {
    if (!selectedSegment) {
      return;
    }
    setRangeStart(selectedSegment.startTime);
    setRangeEnd(selectedSegment.endTime);
  }, [selectedSegment]);

  useEffect(() => {
    if (recordingStatus === 'idle') {
      return;
    }
    setContextMenu(null);
    masterClockRef.current?.pausePreview();
  }, [recordingStatus]);

  const applyInsertGapUntil = (timelineTime: number) => {
    if (recordMode !== 'insert') {
      return;
    }

    const desiredGap = Math.max(0, timelineTime - recordingOriginTimelineRef.current);
    const delta = desiredGap - insertedGapDurationRef.current;
    if (delta <= 0) {
      return;
    }

    insertGap(recordingOriginTimelineRef.current, delta, {
      eventIds: recordingBaseEventIdsRef.current,
      audioIds: recordingBaseAudioIdsRef.current,
      pushHistory: false,
    });
    insertedGapDurationRef.current = desiredGap;
  };

  useEffect(() => {
    if (recordingStatus !== 'recording') {
      return;
    }

    let rafId = 0;
    const tick = () => {
      const nextTime = recordingTimelineRuntime.getTimelineNowMs(useWhiteboardStore.getState().currentTime);
      seek(nextTime);

      if (recordMode === 'insert') {
        const pending = nextTime - (recordingOriginTimelineRef.current + insertedGapDurationRef.current);
        if (pending >= INSERT_SYNC_STEP_MS) {
          applyInsertGapUntil(nextTime);
        }
      }

      rafId = requestPlatformFrame(tick);
    };

    rafId = requestPlatformFrame(tick);
    return () => cancelPlatformFrame(rafId);
  }, [recordMode, recordingStatus, seek]);

  const seekWithReplay = useCallback((time: number) => {
    const t = normalizeTimelineTime(time);
    masterClockRef.current?.seek(t);
  }, []);

  const stopLiveWaveMonitor = async () => {
    if (liveMonitorRafRef.current !== null) {
      cancelPlatformFrame(liveMonitorRafRef.current);
      liveMonitorRafRef.current = null;
    }
    liveAnalyserRef.current = null;
    const analyserHandle = liveAnalyserHandleRef.current;
    liveAnalyserHandleRef.current = null;
    if (analyserHandle) {
      await analyserHandle.close();
    }
    recordingTimelineRuntime.detachExternalClock();
  };

  const startLiveWaveMonitor = (stream: MediaStream, startTime: number) => {
    void stopLiveWaveMonitor();

    const analyserHandle = createStreamAnalyser(stream, 2048);
    if (!analyserHandle) {
      return;
    }
    const { context, analyser } = analyserHandle;
    liveAnalyserHandleRef.current = analyserHandle;
    recordingTimelineRuntime.attachExternalClock(() => context.currentTime * 1000);
    liveAnalyserRef.current = analyser;
    liveWaveformRef.current = [];
    liveLastSampleRef.current = startTime;
    liveLastUiRef.current = startTime;
    liveRecordingIdRef.current = generateId('audlive');

    const buffer = new Uint8Array(analyser.fftSize);
    const loop = () => {
      const state = useWhiteboardStore.getState();
      const timelineTime = state.recordingStatus === 'recording'
        ? recordingTimelineRuntime.getTimelineNowMs(state.currentTime)
        : normalizeTimelineTime(state.currentTime);
      if (state.recordingStatus === 'recording') {
        analyser.getByteTimeDomainData(buffer);
        let min = 1;
        let max = -1;
        for (let i = 0; i < buffer.length; i += 1) {
          const sample = (buffer[i] - 128) / 128;
          if (sample < min) {
            min = sample;
          }
          if (sample > max) {
            max = sample;
          }
        }
        const minAmp = Math.max(-1, Math.min(0, min));
        const maxAmp = Math.min(1, Math.max(0, max));
        const combined = Math.max(Math.abs(minAmp), Math.abs(maxAmp));

        if (timelineTime - liveLastSampleRef.current >= 8) {
          liveWaveformRef.current.push({
            t: timelineTime,
            amp: combined,
            minAmp,
            maxAmp,
          });
          if (liveWaveformRef.current.length > 5000) {
            liveWaveformRef.current = liveWaveformRef.current.slice(-5000);
          }
          liveLastSampleRef.current = timelineTime;
        }
      }

      if (timelineTime - liveLastUiRef.current >= 50) {
        setLiveRecordingSegment({
          id: liveRecordingIdRef.current,
          projectId: DEFAULT_PROJECT_ID,
          startTime,
          endTime: Math.max(startTime, timelineTime),
          waveform: [...liveWaveformRef.current],
          sourceOffsetMs: 0,
        });
        liveLastUiRef.current = timelineTime;
      }

      if (state.recordingStatus === 'idle') {
        return;
      }
      liveMonitorRafRef.current = requestPlatformFrame(loop);
    };

    liveMonitorRafRef.current = requestPlatformFrame(loop);
  };

  const buildRecordedWaveform = (startTime: number, endTime: number): WaveformPoint[] => {
    const start = normalizeTimelineTime(startTime);
    const end = normalizeTimelineTime(endTime);
    if (end <= start) {
      return [];
    }

    const points = liveWaveformRef.current
      .filter((point) => point.t >= start && point.t <= end)
      .map((point) => ({
        t: normalizeTimelineTime(point.t),
        amp: Math.max(0, Math.min(1, point.amp)),
        minAmp:
          typeof point.minAmp === 'number'
            ? Math.max(-1, Math.min(0, point.minAmp))
            : undefined,
        maxAmp:
          typeof point.maxAmp === 'number'
            ? Math.min(1, Math.max(0, point.maxAmp))
            : undefined,
      }))
      .sort((a, b) => a.t - b.t);

    if (points.length === 0) {
      return [];
    }

    const normalized: WaveformPoint[] = [];
    if (points[0].t > start) {
        normalized.push({
          t: start,
          amp: points[0].amp,
          minAmp: points[0].minAmp,
          maxAmp: points[0].maxAmp,
        });
    }

    let lastTime = start;
    for (const point of points) {
      const t = Math.max(lastTime, point.t);
      if (normalized.length > 0 && normalized[normalized.length - 1].t === t) {
        normalized[normalized.length - 1] = {
          t,
          amp: point.amp,
          minAmp: point.minAmp,
          maxAmp: point.maxAmp,
        };
      } else {
        normalized.push({
          t,
          amp: point.amp,
          minAmp: point.minAmp,
          maxAmp: point.maxAmp,
        });
      }
      lastTime = t;
    }

    const tailAmp = normalized[normalized.length - 1]?.amp ?? points[points.length - 1].amp;
    if (normalized[normalized.length - 1]?.t < end) {
      normalized.push({
        t: end,
        amp: tailAmp,
        minAmp: normalized[normalized.length - 1]?.minAmp,
        maxAmp: normalized[normalized.length - 1]?.maxAmp,
      });
    }

    return normalized;
  };

  const startRecording = useCallback(async () => {
    if (recordingBusy || recordingStatus !== 'idle') {
      return;
    }

    const support = getRecordingSupportInfo();
    if (!support.canRecord) {
      return;
    }

    try {
      const storeTime = normalizeTimelineTime(useWhiteboardStore.getState().currentTime);
      const startAt = storeTime;
      masterClockRef.current?.seek(startAt);
      seek(startAt);
      masterClockRef.current?.pausePreview();

      const stream = await requestAudioInputStream({
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      });
      const recorder = createRecorderAdapter(stream);
      if (!recorder) {
        stopMediaStreamTracks(stream);
        return;
      }

      recordingOriginTimelineRef.current = startAt;
      recordingTimelineRuntime.start(startAt);
      insertedGapDurationRef.current = 0;

      const stateAtStart = useWhiteboardStore.getState();
      if (recordMode === 'append') {
        const maxAtStart = getEditorMaxTime(
          stateAtStart.events,
          stateAtStart.audioSegments,
          startAt,
        );
        if (maxAtStart > startAt) {
          deleteRange(startAt, maxAtStart);
        }
      }

      if (recordMode === 'insert') {
        recordingBaseEventIdsRef.current = stateAtStart.events
          .filter((event) => getEventEndTime(event) > startAt)
          .map((event) => event.id);
        recordingBaseAudioIdsRef.current = stateAtStart.audioSegments
          .filter((segment) => segment.endTime > startAt)
          .map((segment) => segment.id);
      } else {
        recordingBaseEventIdsRef.current = [];
        recordingBaseAudioIdsRef.current = [];
      }

      recorder.start(200);
      recorderRef.current = recorder;
      streamRef.current = stream;
      setRecordingStatus('recording');
      startLiveWaveMonitor(stream, startAt);
    } catch {
      // permission denied or unavailable device
    }
  }, [deleteRange, recordMode, recordingBusy, recordingStatus, setRecordingStatus, startLiveWaveMonitor]);

  const stopRecording = useCallback(async () => {
    if (recordingBusy || recordingStatus === 'idle') {
      return;
    }
    setRecordingBusy(true);

    try {
      if (recordingStatus === 'recording') {
        setRecordingStatus('paused');
      }

      const recorder = recorderRef.current;
      let blob: Blob | null = null;
      const finalTimeFromClock = recordingTimelineRuntime.getTimelineNowMs(useWhiteboardStore.getState().currentTime);

      if (recorder && recorder.state !== 'inactive') {
        try {
          blob = await recorder.stop();
        } catch {
          blob = null;
        }
      }

      const startTime = recordingOriginTimelineRef.current;
      let endTime = finalTimeFromClock;
      seek(endTime);
      applyInsertGapUntil(endTime);

      if (blob && blob.size > 0 && endTime > startTime) {
        const sourceUrl = URL.createObjectURL(blob);
        const built = await buildWaveformFromAudioBlob(blob, startTime, endTime);
        const sourceDurationMs = built.sourceDurationMs > 0
          ? built.sourceDurationMs
          : Math.max(1, endTime - startTime);
        endTime = normalizeTimelineTime(startTime + sourceDurationMs);
        seek(endTime);
        applyInsertGapUntil(endTime);
        let waveform = built.waveform;
        if (waveform.length === 0) {
          waveform = buildRecordedWaveform(startTime, endTime);
        }
        addAudioSegment({
          id: generateId('aud'),
          projectId: DEFAULT_PROJECT_ID,
          startTime,
          endTime,
          waveform: waveform.length > 0 ? waveform : createMockWaveform(startTime, endTime),
          sourceOffsetMs: 0,
          sourceDurationMs,
          sourceUrl,
        });
      }

      await stopLiveWaveMonitor();
      setLiveRecordingSegment(null);
      liveWaveformRef.current = [];

      recorderRef.current?.dispose();
      stopMediaStreamTracks(streamRef.current);
      streamRef.current = null;
      recorderRef.current = null;
      recordingTimelineRuntime.reset();
      insertedGapDurationRef.current = 0;
      recordingBaseEventIdsRef.current = [];
      recordingBaseAudioIdsRef.current = [];
      setRecordingStatus('idle');
    } finally {
      setRecordingBusy(false);
    }
  }, [addAudioSegment, applyInsertGapUntil, recordingBusy, recordingStatus, seek, setRecordingStatus]);

  const toggleRecording = () => {
    if (recordingStatus === 'idle') {
      void startRecording();
      return;
    }
    void stopRecording();
  };

  const startPreviewPlayback = useCallback(async () => {
    if (recordingStatus !== 'idle' || recordingBusy) {
      return;
    }
    await masterClockRef.current?.playPreview();
  }, [recordingBusy, recordingStatus]);

  const togglePreviewPlayback = () => {
    if (recordingStatus !== 'idle') {
      return;
    }
    if (playing) {
      masterClockRef.current?.pausePreview();
      return;
    }
    void startPreviewPlayback();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space') {
        return;
      }

      const target = event.target as HTMLElement | null;
      const isEditable = !!target
        && (
          target.tagName === 'INPUT'
          || target.tagName === 'TEXTAREA'
          || target.isContentEditable
        );
      if (isEditable) {
        return;
      }

      event.preventDefault();
      if (recordingStatus !== 'idle' || recordingBusy) {
        return;
      }

      const isPlaying = masterClockRef.current?.isPlaying() ?? false;
      if (isPlaying) {
        masterClockRef.current?.pausePreview();
        return;
      }

      void startPreviewPlayback();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [recordingBusy, recordingStatus, startPreviewPlayback]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.timeline-context-menu')) {
        return;
      }
      setContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
      }
    };
    const close = () => setContextMenu(null);

    window.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [contextMenu]);

  const start = Math.min(rangeStart, rangeEnd);
  const end = Math.max(rangeStart, rangeEnd);
  const hasRange = !!selectedSegment && end > start;
  const operationMode = resolveOperationMode({
    recordingStatus,
    isPlaying: playing,
    isExporting: !!runningExportJobId,
    hasTimelineSelection: !!selectedSegmentId,
  });
  const operationAvailability = deriveOperationAvailability({
    mode: operationMode,
    hasRange,
    canCutAtPlayhead: timelineSegments.some(
      (segment) => currentTime > segment.startTime && currentTime < segment.endTime,
    ),
  });
  const canEditTimeline = operationMode === 'idle' || operationMode === 'editing';
  const canSeekTimeline = canEditTimeline;
  const displayAudioSegments = liveRecordingSegment
    ? [...audioSegments, liveRecordingSegment]
    : audioSegments;
  const trackMaxTime = Math.max(
    maxTime,
    liveRecordingSegment?.endTime ?? 0,
  );
  const canCutAtTime = (time: number): boolean => (
    canEditTimeline
    && timelineSegments.some((segment) => time > segment.startTime && time < segment.endTime)
  );
  const canCutAtPlayhead = canCutAtTime(currentTime);
  const cutAtTime = useCallback((time: number) => {
    if (!canCutAtTime(time)) {
      return;
    }
    splitSelectedSegmentAt(time);
  }, [canCutAtTime, splitSelectedSegmentAt]);
  const handleCutAtPlayhead = useCallback(() => {
    cutAtTime(currentTime);
  }, [currentTime, cutAtTime]);
  const timelineClock = `${formatDurationClock(currentTime)} / ${formatDurationClock(trackMaxTime)}`;
  const canDeleteFutureAtContext = !!contextMenu && canEditTimeline && contextMenu.time < trackMaxTime;
  const canCutAtContext = !!contextMenu && canCutAtTime(contextMenu.time);
  const contextMenuLeft = contextMenu
    ? Math.max(8, Math.min(contextMenu.clientX, (typeof window !== 'undefined' ? window.innerWidth : contextMenu.clientX) - 196))
    : 0;
  const contextMenuTop = contextMenu
    ? Math.max(8, Math.min(contextMenu.clientY, (typeof window !== 'undefined' ? window.innerHeight : contextMenu.clientY) - 180))
    : 0;
  const handleSelectEvent = useCallback((id: string) => {
    setSelectedEvent(id);
  }, [setSelectedEvent]);
  const handleSelectSegment = useCallback((id: string) => {
    setSelectedSegment(id);
  }, [setSelectedSegment]);
  const handleOpenContextMenu = useCallback((params: { clientX: number; clientY: number; time: number }) => {
    if (!canEditTimeline) {
      return;
    }
    setContextMenu({
      clientX: params.clientX,
      clientY: params.clientY,
      time: normalizeTimelineTime(params.time),
    });
  }, [canEditTimeline]);

  return (
    <section className="timeline-editor">
      <OperationBar
        mode={operationMode}
        isPlaying={playing}
        isRecordingBusy={recordingBusy}
        recordMode={recordMode}
        snapEnabled={snapEnabled}
        timelineClock={timelineClock}
        availability={operationAvailability}
        onToggleRecord={toggleRecording}
        onTogglePlayback={togglePreviewPlayback}
        onSetRecordMode={setRecordMode}
        onCutAtPlayhead={handleCutAtPlayhead}
        onDeleteFuture={() => deleteFuture(currentTime)}
        onDeleteAndStitch={() => rippleDeleteRange(start, end)}
        onToggleSnap={() => setSnapEnabled((value) => !value)}
      />

      <TimelineTrack
        events={events}
        segments={timelineSegments}
        audioSegments={displayAudioSegments}
        currentTime={currentTime}
        maxTime={trackMaxTime}
        selectedEventId={selectedEventId}
        selectedSegmentId={selectedSegmentId}
        canSeek={canSeekTimeline}
        snapEnabled={snapEnabled}
        fps={TIMELINE_FPS}
        onSeek={seekWithReplay}
        onSelectEvent={handleSelectEvent}
        onSelectSegment={handleSelectSegment}
        onOpenContextMenu={handleOpenContextMenu}
      />
      {contextMenu && (
        <div
          className="timeline-context-menu panel"
          style={{
            left: `${contextMenuLeft}px`,
            top: `${contextMenuTop}px`,
          }}
          onContextMenu={(event) => {
            event.preventDefault();
          }}
        >
          <div className="context-title">
            <span>Timeline</span>
            <span className="context-time mono">{formatDurationClock(contextMenu.time)}</span>
          </div>
          <button
            type="button"
            className="context-item"
            onClick={() => {
              seekWithReplay(contextMenu.time);
              setContextMenu(null);
            }}
          >
            Jump To Here
          </button>
          <button
            type="button"
            className="context-item"
            disabled={!canCutAtContext}
            onClick={() => {
              cutAtTime(contextMenu.time);
              setContextMenu(null);
            }}
          >
            Cut Here
          </button>
          <button
            type="button"
            className="context-item"
            disabled={!canDeleteFutureAtContext}
            onClick={() => {
              deleteFuture(contextMenu.time);
              setContextMenu(null);
            }}
          >
            Delete Future
          </button>
          <button
            type="button"
            className="context-item danger"
            disabled={!hasRange}
            onClick={() => {
              rippleDeleteRange(start, end);
              setContextMenu(null);
            }}
          >
            Delete And Stitch
          </button>
        </div>
      )}
    </section>
  );
};
