import { create } from 'zustand';
import {
  ExportJob,
  ExportJobKind,
  ExportJobPayload,
  runExportJob,
} from '../application/export/ExportJobService';
import { generateId } from '../utils/id';

type ExportStore = {
  jobs: ExportJob[];
  collapsed: boolean;
  runningJobId?: string;

  enqueueJob: (kind: ExportJobKind, payload: ExportJobPayload) => string;
  cancelJob: (jobId: string) => void;
  retryJob: (jobId: string) => string | null;
  clearFinished: () => void;
  removeJob: (jobId: string) => void;
  setCollapsed: (collapsed: boolean) => void;
};

const controllers = new Map<string, AbortController>();

const startNext = async (
  get: () => ExportStore,
  set: (
    partial: ExportStore | Partial<ExportStore> | ((state: ExportStore) => ExportStore | Partial<ExportStore>),
  ) => void,
) => {
  const state = get();
  if (state.runningJobId) {
    return;
  }
  const job = state.jobs.find((item) => item.status === 'queued');
  if (!job) {
    return;
  }

  const controller = new AbortController();
  controllers.set(job.id, controller);
  set((prev) => ({
    runningJobId: job.id,
    jobs: prev.jobs.map((item) => (
      item.id === job.id
        ? {
          ...item,
          status: 'running',
          startedAt: Date.now(),
          message: 'Starting export',
          progress: Math.max(0, item.progress),
          error: undefined,
        }
        : item
    )),
  }));

  try {
    await runExportJob(job.kind, job.payload, {
      signal: controller.signal,
      onProgress: (progress, message) => {
        set((prev) => ({
          jobs: prev.jobs.map((item) => (
            item.id === job.id
              ? {
                ...item,
                progress,
                message,
              }
              : item
          )),
        }));
      },
    });

    set((prev) => ({
      runningJobId: undefined,
      jobs: prev.jobs.map((item) => (
        item.id === job.id
          ? {
            ...item,
            status: 'done',
            progress: 1,
            finishedAt: Date.now(),
            message: item.message || 'Export completed',
          }
          : item
      )),
    }));
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === 'AbortError';
    const message = error instanceof Error ? error.message : 'Export failed';
    set((prev) => ({
      runningJobId: undefined,
      jobs: prev.jobs.map((item) => (
        item.id === job.id
          ? {
            ...item,
            status: isAbort ? 'canceled' : 'error',
            finishedAt: Date.now(),
            message: isAbort ? 'Export canceled' : 'Export failed',
            error: isAbort ? undefined : message,
          }
          : item
      )),
    }));
  } finally {
    controllers.delete(job.id);
    void startNext(get, set);
  }
};

export const useExportJobStore = create<ExportStore>((set, get) => ({
  jobs: [],
  collapsed: false,
  runningJobId: undefined,

  enqueueJob: (kind, payload) => {
    const id = generateId('job');
    const now = Date.now();
    const job: ExportJob = {
      id,
      kind,
      payload,
      status: 'queued',
      progress: 0,
      message: 'Queued',
      createdAt: now,
    };
    set((prev) => ({
      collapsed: false,
      jobs: [job, ...prev.jobs].slice(0, 50),
    }));
    void startNext(get, set);
    return id;
  },

  cancelJob: (jobId) => {
    const state = get();
    const controller = controllers.get(jobId);
    if (controller) {
      controller.abort();
      return;
    }
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job || job.status !== 'queued') {
      return;
    }
    set((prev) => ({
      jobs: prev.jobs.map((item) => (
        item.id === jobId
          ? {
            ...item,
            status: 'canceled',
            message: 'Export canceled',
            finishedAt: Date.now(),
          }
          : item
      )),
    }));
  },

  retryJob: (jobId) => {
    const state = get();
    const source = state.jobs.find((item) => item.id === jobId);
    if (!source || source.status === 'running') {
      return null;
    }
    const id = generateId('job');
    const now = Date.now();
    const retry: ExportJob = {
      id,
      kind: source.kind,
      payload: source.payload,
      status: 'queued',
      progress: 0,
      message: 'Queued (retry)',
      createdAt: now,
    };
    set((prev) => ({
      collapsed: false,
      jobs: [retry, ...prev.jobs].slice(0, 50),
    }));
    void startNext(get, set);
    return id;
  },

  clearFinished: () => {
    set((prev) => ({
      jobs: prev.jobs.filter((job) => job.status === 'running' || job.status === 'queued'),
    }));
  },

  removeJob: (jobId) => {
    const isRunning = get().runningJobId === jobId;
    if (isRunning) {
      return;
    }
    set((prev) => ({
      jobs: prev.jobs.filter((job) => job.id !== jobId),
    }));
  },

  setCollapsed: (collapsed) => {
    set({ collapsed });
  },
}));

