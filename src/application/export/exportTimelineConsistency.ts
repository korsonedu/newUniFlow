import { normalizeTimelineTime } from '../../domain/time';
import { AudioSegment, TimelineEvent } from '../../domain/types';
import { getEventEndTime, sortEvents } from '../../engine/timelineEngine';

export type ExportTimelineStats = {
  eventMaxMs: number;
  audioMaxMs: number;
  durationMs: number;
  eventCount: number;
  audioCount: number;
  fingerprint: string;
};

export type ExportTimelineExpected = {
  expectedDurationMs?: number;
  expectedEventMaxMs?: number;
  expectedAudioMaxMs?: number;
  expectedFingerprint?: string;
};

const TIME_ASSERT_TOLERANCE_MS = 1;

const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const normalizeAudio = (segment: AudioSegment): AudioSegment => {
  const startTime = normalizeTimelineTime(segment.startTime);
  const endTime = normalizeTimelineTime(segment.endTime);
  const sourceOffsetMs = normalizeTimelineTime(segment.sourceOffsetMs ?? 0);
  const sourceDurationMs = normalizeTimelineTime(
    segment.sourceDurationMs ?? Math.max(1, endTime - startTime),
  );
  return {
    ...segment,
    startTime,
    endTime,
    sourceOffsetMs,
    sourceDurationMs,
  };
};

const assertFiniteTime = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Export timeline invalid: ${label}=${value}`);
  }
};

export const getExportTimelineStats = (
  events: TimelineEvent[],
  audioSegments: AudioSegment[],
): ExportTimelineStats => {
  const sortedEvents = sortEvents(events);
  const normalizedAudio = audioSegments.map(normalizeAudio).sort((a, b) => a.startTime - b.startTime);
  const eventMaxMs = sortedEvents.length > 0
    ? Math.max(...sortedEvents.map((event) => normalizeTimelineTime(getEventEndTime(event))))
    : 0;
  const audioMaxMs = normalizedAudio.length > 0
    ? Math.max(...normalizedAudio.map((segment) => normalizeTimelineTime(segment.endTime)))
    : 0;
  const durationMs = Math.max(1, eventMaxMs, audioMaxMs);

  const eventSig = sortedEvents
    .map((event) => `${event.id}:${event.type}:${normalizeTimelineTime(event.time)}:${normalizeTimelineTime(getEventEndTime(event))}`)
    .join('|');
  const audioSig = normalizedAudio
    .map((segment) => `${segment.id}:${segment.startTime}:${segment.endTime}:${segment.sourceOffsetMs ?? 0}:${segment.sourceDurationMs ?? 0}:${segment.sourceUrl ?? ''}`)
    .join('|');
  const fingerprint = fnv1a(`${eventSig}#${audioSig}`);

  return {
    eventMaxMs,
    audioMaxMs,
    durationMs,
    eventCount: sortedEvents.length,
    audioCount: normalizedAudio.length,
    fingerprint,
  };
};

export const assertExportTimelineConsistency = (
  stats: ExportTimelineStats,
  expected: ExportTimelineExpected,
): void => {
  if (typeof expected.expectedDurationMs === 'number') {
    const delta = Math.abs(stats.durationMs - normalizeTimelineTime(expected.expectedDurationMs));
    if (delta > TIME_ASSERT_TOLERANCE_MS) {
      throw new Error(`Export timeline drift: duration mismatch (${stats.durationMs} vs ${expected.expectedDurationMs})`);
    }
  }
  if (typeof expected.expectedEventMaxMs === 'number') {
    const delta = Math.abs(stats.eventMaxMs - normalizeTimelineTime(expected.expectedEventMaxMs));
    if (delta > TIME_ASSERT_TOLERANCE_MS) {
      throw new Error(`Export timeline drift: event max mismatch (${stats.eventMaxMs} vs ${expected.expectedEventMaxMs})`);
    }
  }
  if (typeof expected.expectedAudioMaxMs === 'number') {
    const delta = Math.abs(stats.audioMaxMs - normalizeTimelineTime(expected.expectedAudioMaxMs));
    if (delta > TIME_ASSERT_TOLERANCE_MS) {
      throw new Error(`Export timeline drift: audio max mismatch (${stats.audioMaxMs} vs ${expected.expectedAudioMaxMs})`);
    }
  }
  if (expected.expectedFingerprint && expected.expectedFingerprint !== stats.fingerprint) {
    throw new Error('Export timeline drift: fingerprint mismatch');
  }
};

export const normalizeExportTimeline = (
  events: TimelineEvent[],
  audioSegments: AudioSegment[],
): { events: TimelineEvent[]; audioSegments: AudioSegment[]; stats: ExportTimelineStats } => {
  const sortedEvents = sortEvents(events).map((event) => {
    const normalizedTime = normalizeTimelineTime(event.time);
    assertFiniteTime(normalizedTime, `event:${event.id}.time`);
    return {
      ...event,
      time: normalizedTime,
    };
  });

  const normalizedAudio = audioSegments
    .map(normalizeAudio)
    .map((segment) => {
      assertFiniteTime(segment.startTime, `audio:${segment.id}.startTime`);
      assertFiniteTime(segment.endTime, `audio:${segment.id}.endTime`);
      if (segment.endTime <= segment.startTime) {
        throw new Error(`Export timeline invalid: audio:${segment.id} has non-positive duration`);
      }
      return segment;
    })
    .sort((a, b) => a.startTime - b.startTime);

  const stats = getExportTimelineStats(sortedEvents, normalizedAudio);
  return {
    events: sortedEvents,
    audioSegments: normalizedAudio,
    stats,
  };
};

