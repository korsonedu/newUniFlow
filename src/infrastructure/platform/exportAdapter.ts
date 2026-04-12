import { AudioSegment, ProjectPage, TimelineEvent } from '../../domain/types';
import { exportProjectMp4 } from '../../utils/mp4Exporter';
import type { UfprojProjectMeta } from '../../utils/ufprojArchive';
import { saveBlobWithDownload } from './fileSave';

export type ExportProgress = (progress: number, message: string) => void;

export type PlatformExportMp4Request = {
  projectId: string;
  fileBaseName: string;
  pages: ProjectPage[];
  events: TimelineEvent[];
  audioSegments: AudioSegment[];
  fps?: number;
  onProgress?: ExportProgress;
  signal?: AbortSignal;
};

export type PlatformExportUfprojRequest = {
  fileBaseName: string;
  project?: UfprojProjectMeta;
  snapshotJson: string;
  projectPages: ProjectPage[];
  onProgress?: ExportProgress;
  signal?: AbortSignal;
};

export type PlatformExportAdapter = {
  exportMp4: (request: PlatformExportMp4Request) => Promise<void>;
  exportUfproj: (request: PlatformExportUfprojRequest) => Promise<void>;
};

const defaultExportAdapter: PlatformExportAdapter = {
  exportMp4: async (request) => {
    const result = await exportProjectMp4(request);
    if (request.signal?.aborted) {
      throw new DOMException('Export canceled', 'AbortError');
    }
    saveBlobWithDownload(`${request.fileBaseName}.${result.ext}`, result.blob);
  },
  exportUfproj: async (request) => {
    const { encodeUfprojBlob } = await import('../../utils/ufprojArchive');
    const blob = await encodeUfprojBlob({
      project: request.project,
      snapshotJson: request.snapshotJson,
      projectPages: request.projectPages,
      onProgress: request.onProgress,
      signal: request.signal,
    });
    if (request.signal?.aborted) {
      throw new DOMException('Export canceled', 'AbortError');
    }
    saveBlobWithDownload(`${request.fileBaseName}.ufproj`, blob);
  },
};

let currentExportAdapter: PlatformExportAdapter = defaultExportAdapter;

export const getPlatformExportAdapter = (): PlatformExportAdapter => currentExportAdapter;

export const setPlatformExportAdapter = (adapter: PlatformExportAdapter): void => {
  currentExportAdapter = adapter;
};

export const resetPlatformExportAdapter = (): void => {
  currentExportAdapter = defaultExportAdapter;
};
