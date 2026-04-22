import { ExportJob } from '../export/ExportJobService';
import { ProjectPage } from '../../domain/types';
import { ProjectRecord } from './projectLibrary';
import { RecordingStatus } from '../../domain/types';

export type CreateProjectMode = 'blank' | 'file';

export type CreateProjectDraft = {
  mode: CreateProjectMode;
  name: string;
  author: string;
  file: File | null;
  creating: boolean;
};

export type ExportQueuePresentation = {
  runningCount: number;
  hasJobs: boolean;
  canClearFinished: boolean;
};

export type RecordingOverlayPresentation = {
  canBack: boolean;
  canImportCourseware: boolean;
  canDuplicatePage: boolean;
  canDeletePage: boolean;
  canToggleExportMenu: boolean;
  importButtonLabel: string;
  exportButtonLabel: string;
};

export type CreateProjectDialogPresentation = {
  canSubmit: boolean;
  fileButtonLabel: string;
  fileNameLabel: string;
  confirmLabel: string;
};

export const createInitialProjectDraft = (
  mode: CreateProjectMode = 'blank',
): CreateProjectDraft => ({
  mode,
  name: '',
  author: '',
  file: null,
  creating: false,
});

export const canSubmitCreateProjectDraft = (draft: CreateProjectDraft): boolean => {
  const hasName = draft.name.trim().length > 0;
  const hasRequiredFile = draft.mode === 'blank' || !!draft.file;
  return hasName && hasRequiredFile && !draft.creating;
};

export const deriveCreateProjectDialogPresentation = (
  draft: CreateProjectDraft,
): CreateProjectDialogPresentation => ({
  canSubmit: canSubmitCreateProjectDraft(draft),
  fileButtonLabel: draft.file ? '更换课件' : '选择课件',
  fileNameLabel: draft.file
    ? draft.file.name
    : (draft.mode === 'file' ? '未选择文件' : '将创建一个不带课件的空白项目'),
  confirmLabel: draft.creating ? '创建中…' : '确认创建',
});

export const resolvePageManagerProjectId = (
  currentId: string | null,
  projects: ProjectRecord[],
  layer: 'project' | 'recording',
): string | null => {
  if (layer !== 'project' || !currentId) {
    return null;
  }
  return projects.some((project) => project.id === currentId) ? currentId : null;
};

export const deriveCanDeleteSelectedPages = (
  pages: ProjectPage[],
  selectedPageIds: string[],
): boolean => {
  return selectedPageIds.length > 0 && pages.length - selectedPageIds.length >= 1;
};

export const deriveExportQueuePresentation = (
  jobs: ExportJob[],
): ExportQueuePresentation => {
  const runningCount = jobs.filter((task) => task.status === 'running').length;
  const canClearFinished = jobs.some(
    (task) => task.status !== 'running' && task.status !== 'queued',
  );
  return {
    runningCount,
    hasJobs: jobs.length > 0,
    canClearFinished,
  };
};

export const deriveRecordingOverlayPresentation = (params: {
  recordingStatus: RecordingStatus;
  coursewareBusy: boolean;
  currentProjectPageCount: number;
  runningExportCount: number;
}): RecordingOverlayPresentation => {
  const idle = params.recordingStatus === 'idle';
  return {
    canBack: idle,
    canImportCourseware: idle && !params.coursewareBusy,
    canDuplicatePage: idle,
    canDeletePage: idle && params.currentProjectPageCount > 1,
    canToggleExportMenu: idle,
    importButtonLabel: params.coursewareBusy ? '导入中…' : '导入课件',
    exportButtonLabel: params.runningExportCount > 0
      ? `导出 (${params.runningExportCount})`
      : '导出',
  };
};
