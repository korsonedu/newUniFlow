import { AudioSegment, ProjectPage, TimelineEvent } from '../../domain/types';
import type { UfprojProjectMeta } from '../../utils/ufprojArchive';
import {
  getPlatformExportAdapter,
} from '../../infrastructure/platform/exportAdapter';
import type { PlatformExportAdapter } from '../../infrastructure/platform/exportAdapter';
import {
  assertExportTimelineConsistency,
  normalizeExportTimeline,
} from './exportTimelineConsistency';

export type ExportJobKind = 'mp4' | 'ufproj';
export type ExportJobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled';

export type ExportMp4Payload = {
  projectId: string;
  fileBaseName: string;
  pages: ProjectPage[];
  events: TimelineEvent[];
  audioSegments: AudioSegment[];
  fps?: number;
  expectedDurationMs?: number;
  expectedEventMaxMs?: number;
  expectedAudioMaxMs?: number;
  expectedFingerprint?: string;
};

export type ExportUfprojPayload = {
  fileBaseName: string;
  project?: UfprojProjectMeta;
  snapshotJson: string;
  projectPages: ProjectPage[];
};

export type ExportJobPayload = ExportMp4Payload | ExportUfprojPayload;

export type ExportJob = {
  id: string;
  kind: ExportJobKind;
  status: ExportJobStatus;
  progress: number;
  message: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  payload: ExportJobPayload;
};

type RunExportJobOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: number, message: string) => void;
  adapter?: PlatformExportAdapter;
};

const toAbortError = (): DOMException => new DOMException('Export canceled', 'AbortError');

export const runExportJob = async (
  kind: ExportJobKind,
  payload: ExportJobPayload,
  options: RunExportJobOptions = {},
): Promise<void> => {
  if (options.signal?.aborted) {
    throw toAbortError();
  }

  const adapter = options.adapter ?? getPlatformExportAdapter();

  if (kind === 'mp4') {
    const mp4 = payload as ExportMp4Payload;
    const normalized = normalizeExportTimeline(mp4.events, mp4.audioSegments);
    assertExportTimelineConsistency(normalized.stats, {
      expectedDurationMs: mp4.expectedDurationMs,
      expectedEventMaxMs: mp4.expectedEventMaxMs,
      expectedAudioMaxMs: mp4.expectedAudioMaxMs,
      expectedFingerprint: mp4.expectedFingerprint,
    });
    await adapter.exportMp4({
      ...mp4,
      events: normalized.events,
      audioSegments: normalized.audioSegments,
      onProgress: (progress, message) => {
        options.onProgress?.(progress, message);
      },
      signal: options.signal,
    });
    return;
  }

  const ufproj = payload as ExportUfprojPayload;
  await adapter.exportUfproj({
    fileBaseName: ufproj.fileBaseName,
    project: ufproj.project,
    snapshotJson: ufproj.snapshotJson,
    projectPages: ufproj.projectPages,
    onProgress: options.onProgress,
    signal: options.signal,
  });
};
