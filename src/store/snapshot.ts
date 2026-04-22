import { AudioSegment, TimelineEvent, WaveformPoint } from '../domain/types';
import { sortEvents } from '../engine/timelineEngine';
import { normalizeTimelineTime } from '../domain/time';
import {
  readBrowserStorageItem,
  removeBrowserStorageItem,
  writeBrowserStorageItem,
} from '../infrastructure/platform/browserStorage';

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_STORAGE_KEY = 'uniflow.timeline.snapshot.v1';

export type WhiteboardSnapshot = {
  version: number;
  exportedAt: string;
  currentTime: number;
  events: TimelineEvent[];
  audioSegments: AudioSegment[];
};

const isTimelineEvent = (value: unknown): value is TimelineEvent => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.projectId === 'string' &&
    typeof item.pageId === 'string' &&
    typeof item.actorId === 'string' &&
    typeof item.time === 'number' &&
    typeof item.type === 'string'
  );
};

const normalizeSnapshot = (input: unknown): WhiteboardSnapshot | null => {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const data = input as Record<string, unknown>;

  const currentTime = normalizeTimelineTime(
    typeof data.currentTime === 'number' ? data.currentTime : 0,
  );
  const events = Array.isArray(data.events) ? data.events.filter(isTimelineEvent) : [];
  const audioSegments = Array.isArray(data.audioSegments)
    ? data.audioSegments
        .filter((item): item is AudioSegment => {
          if (!item || typeof item !== 'object') {
            return false;
          }
          const segment = item as Record<string, unknown>;
          return (
            typeof segment.id === 'string' &&
            typeof segment.projectId === 'string' &&
            typeof segment.startTime === 'number' &&
            typeof segment.endTime === 'number' &&
            Array.isArray(segment.waveform)
          );
        })
        .map((segment) => ({
          ...segment,
          startTime: normalizeTimelineTime(segment.startTime),
          endTime: normalizeTimelineTime(segment.endTime),
          sourceOffsetMs:
            typeof segment.sourceOffsetMs === 'number'
              ? normalizeTimelineTime(segment.sourceOffsetMs)
              : undefined,
          sourceDurationMs:
            typeof segment.sourceDurationMs === 'number'
              ? normalizeTimelineTime(segment.sourceDurationMs)
              : Math.max(
                1,
                normalizeTimelineTime(segment.endTime) - normalizeTimelineTime(segment.startTime),
              ),
          waveform: (segment.waveform as WaveformPoint[])
            .filter((point) => point && typeof point.t === 'number' && typeof point.amp === 'number')
            .map((point) => ({
              t: normalizeTimelineTime(point.t),
              amp: Math.max(0, Math.min(1, point.amp)),
              minAmp:
                typeof point.minAmp === 'number'
                  ? Math.max(-1, Math.min(1, point.minAmp))
                  : undefined,
              maxAmp:
                typeof point.maxAmp === 'number'
                  ? Math.max(-1, Math.min(1, point.maxAmp))
                  : undefined,
            })),
        }))
    : [];

  return {
    version: typeof data.version === 'number' ? data.version : SNAPSHOT_VERSION,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : new Date().toISOString(),
    currentTime,
    events: sortEvents(events),
    audioSegments,
  };
};

export const createSnapshot = (
  events: TimelineEvent[],
  currentTime: number,
  audioSegments: AudioSegment[],
): WhiteboardSnapshot => ({
  version: SNAPSHOT_VERSION,
  exportedAt: new Date().toISOString(),
  currentTime: normalizeTimelineTime(currentTime),
  events: sortEvents(events),
  audioSegments,
});

export const snapshotToJson = (snapshot: WhiteboardSnapshot): string => {
  return JSON.stringify(snapshot, null, 2);
};

export const parseSnapshotJson = (json: string): WhiteboardSnapshot | null => {
  try {
    const parsed = JSON.parse(json) as unknown;
    return normalizeSnapshot(parsed);
  } catch {
    return null;
  }
};

export const loadSnapshotFromStorage = (): WhiteboardSnapshot | null => {
  const raw = readBrowserStorageItem(SNAPSHOT_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  return parseSnapshotJson(raw);
};

export const saveSnapshotToStorage = (snapshot: WhiteboardSnapshot): void => {
  writeBrowserStorageItem(SNAPSHOT_STORAGE_KEY, snapshotToJson(snapshot));
};

export const clearSnapshotStorage = (): void => {
  removeBrowserStorageItem(SNAPSHOT_STORAGE_KEY);
};
