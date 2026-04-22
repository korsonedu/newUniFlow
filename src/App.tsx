import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import {
  IoAddCircleOutline,
  IoCheckmarkCircleOutline,
  IoChevronDownOutline,
  IoChevronUpOutline,
  IoCloseOutline,
  IoCopyOutline,
  IoDocumentAttachOutline,
  IoFolderOpenOutline,
  IoLayersOutline,
  IoRefreshOutline,
  IoRemoveCircleOutline,
  IoPersonCircleOutline,
  IoPlayCircleOutline,
  IoStopCircleOutline,
  IoTrashOutline,
} from 'react-icons/io5';
import { useWhiteboardStore } from './store/useWhiteboardStore';
import { parseSnapshotJson, snapshotToJson } from './store/snapshot';
import { generateId } from './utils/id';
import { ProjectPage } from './domain/types';
import { useExportJobStore } from './store/useExportJobStore';
import { getExportTimelineStats } from './application/export/exportTimelineConsistency';
import { openFileDialog } from './infrastructure/platform/dialog';
import { RecordingOverlay } from './components/recording/RecordingOverlay';
import {
  addBlankProjectPage,
  createProjectRecord,
  deleteProjectLibraryRecord,
  deleteProjectPage as deleteProjectPageFromLibrary,
  deleteSelectedProjectPages,
  duplicateProjectPage as duplicateProjectPageInLibrary,
  duplicateProjectLibraryRecord,
  duplicateSelectedProjectPages,
  formatProjectTime,
  moveProjectPage,
  normalizeProjectRecordPages,
  ProjectRecord,
  renameProjectLibraryRecord,
  updateProjectRecordInLibrary,
  updateProjectPagesInLibrary,
  upsertProjectRecord,
} from './application/projects/projectLibrary';
import {
  deriveCreateProjectDialogPresentation,
  deriveCanDeleteSelectedPages,
  deriveExportQueuePresentation,
  deriveRecordingOverlayPresentation,
  resolvePageManagerProjectId,
} from './application/projects/projectWorkspacePresentation';
import type { CreateProjectMode } from './application/projects/projectWorkspacePresentation';
import {
  createInitialProjectShellState,
} from './application/projects/projectShellState';
import {
  beginProjectRenameCommand,
  cancelProjectRenameCommand,
  clearProjectPageSelectionCommand,
  closeCreateProjectDialogCommand,
  closeProjectPageManagerCommand,
  dismissExportMenuCommand,
  finishCreateProjectCommand,
  openCreateProjectDialogCommand,
  selectAllProjectPagesCommand,
  setCreateProjectAuthorCommand,
  setCreateProjectFileCommand,
  setCreateProjectModeCommand,
  setCreateProjectNameCommand,
  setCreateProjectPendingCommand,
  syncPageManagerProjectCommand,
  syncPageManagerSelectionCommand,
  toggleExportMenuCommand,
  toggleProjectPageManagerCommand,
  toggleProjectPageSelectionCommand,
  updateProjectRenameDraftCommand,
} from './application/projects/projectShellCommands';
import { loadProjectLibraryState, saveProjectLibraryState } from './infrastructure/platform/projectLibraryStorage';
import {
  combineWindowEventDisposers,
  subscribeWindowEscape,
  subscribeWindowPointerDown,
} from './infrastructure/platform/windowEvents';
import {
  platformClearTimeout,
  platformSetTimeout,
  PlatformTimerHandle,
} from './infrastructure/platform/timer';
import { isNativeMacDesktop } from './infrastructure/platform/runtime';

const WhiteboardCanvas = lazy(() =>
  import('./components/canvas/WhiteboardCanvas').then((module) => ({ default: module.WhiteboardCanvas })));
const TimelineEditor = lazy(() =>
  import('./components/timeline/TimelineEditor').then((module) => ({ default: module.TimelineEditor })));

type AppLayer = 'project' | 'recording';

const UFPROJ_ACCEPT = '.ufproj';
const COURSEWARE_ACCEPT = [
  '.pdf',
  '.ppt',
  '.pptx',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/webp',
].join(',');
const CURRENT_USER_NAME = 'Teacher Guest';
const CURRENT_USER_HANDLE = '@uniflow.local';
const CURRENT_LICENSE = 'DEV LICENSE';

const sanitizeFilename = (name: string): string => {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]+/g, '-');
  return cleaned.length > 0 ? cleaned : 'uniflow-project';
};

const isUfprojFile = (file: File): boolean => {
  return /\.ufproj$/i.test(file.name.trim());
};

const App: React.FC = () => {
  const initialLibraryState = useMemo(() => loadProjectLibraryState(), []);
  const initialShellState = useMemo(() => createInitialProjectShellState(), []);
  const exportSnapshotJson = useWhiteboardStore((s) => s.exportSnapshotJson);
  const importSnapshotJson = useWhiteboardStore((s) => s.importSnapshotJson);
  const resetProject = useWhiteboardStore((s) => s.resetProject);
  const setProjectTitle = useWhiteboardStore((s) => s.setProjectTitle);
  const setProjectPages = useWhiteboardStore((s) => s.setProjectPages);
  const duplicateProjectPage = useWhiteboardStore((s) => s.duplicateProjectPage);
  const deleteProjectPage = useWhiteboardStore((s) => s.deleteProjectPage);
  const recordingStatus = useWhiteboardStore((s) => s.recordingStatus);
  const currentProjectTitle = useWhiteboardStore((s) => s.project.title);
  const currentProjectPages = useWhiteboardStore((s) => s.project.pages);
  const currentPageId = useWhiteboardStore((s) => s.state.currentPageId);

  const [layer, setLayer] = useState<AppLayer>('project');
  const [projects, setProjects] = useState<ProjectRecord[]>(initialLibraryState.projects);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(initialLibraryState.activeProjectId);
  const [coursewareBusy, setCoursewareBusy] = useState(false);
  const [shellState, setShellState] = useState(initialShellState);
  const nativeMacDesktop = useMemo(() => isNativeMacDesktop(), []);

  const exportMenuRef = useRef<HTMLDivElement>(null);
  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );
  const pageManagerProject = useMemo(
    () => projects.find((project) => project.id === shellState.pageManagerProjectId) ?? null,
    [projects, shellState.pageManagerProjectId],
  );
  const activeProjectPage = useMemo(
    () => currentProjectPages.find((page) => page.id === currentPageId) ?? currentProjectPages[0] ?? null,
    [currentPageId, currentProjectPages],
  );
  const pageManagerPages = useMemo(
    () => normalizeProjectRecordPages(pageManagerProject?.projectPages ?? []),
    [pageManagerProject?.projectPages],
  );
  const exportJobs = useExportJobStore((s) => s.jobs);
  const exportHudCollapsed = useExportJobStore((s) => s.collapsed);
  const runningExportJobId = useExportJobStore((s) => s.runningJobId);
  const enqueueExportJob = useExportJobStore((s) => s.enqueueJob);
  const cancelExportJob = useExportJobStore((s) => s.cancelJob);
  const retryExportJob = useExportJobStore((s) => s.retryJob);
  const clearFinishedExportJobs = useExportJobStore((s) => s.clearFinished);
  const removeExportJob = useExportJobStore((s) => s.removeJob);
  const setExportHudCollapsed = useExportJobStore((s) => s.setCollapsed);
  const exportQueuePresentation = useMemo(
    () => deriveExportQueuePresentation(exportJobs),
    [exportJobs],
  );
  const canDeleteSelectedPagesInManager = useMemo(
    () => deriveCanDeleteSelectedPages(pageManagerPages, shellState.pageManagerSelectedPageIds),
    [pageManagerPages, shellState.pageManagerSelectedPageIds],
  );
  const createProjectDialogPresentation = useMemo(() => deriveCreateProjectDialogPresentation({
    ...shellState.createProjectDraft,
  }), [shellState.createProjectDraft]);
  const recordingOverlayPresentation = useMemo(() => deriveRecordingOverlayPresentation({
    recordingStatus,
    coursewareBusy,
    currentProjectPageCount: currentProjectPages.length,
    runningExportCount: exportQueuePresentation.runningCount,
  }), [coursewareBusy, currentProjectPages.length, exportQueuePresentation.runningCount, recordingStatus]);

  useEffect(() => {
    if (projects.length > 0) {
      return;
    }
    const now = new Date().toISOString();
    const project = createProjectRecord({
      id: generateId('proj'),
      name: 'UniFlow Project',
      author: CURRENT_USER_NAME,
      createdAt: now,
      snapshotJson: exportSnapshotJson(),
      projectPages: useWhiteboardStore.getState().project.pages,
    });
    setProjects([project]);
    setActiveProjectId(project.id);
  }, [projects.length, exportSnapshotJson]);

  useEffect(() => {
    saveProjectLibraryState(projects, activeProjectId);
  }, [projects, activeProjectId]);

  useEffect(() => {
    if (layer !== 'recording' || !activeProjectId) {
      return;
    }

    let timer: PlatformTimerHandle | null = null;
    let lastEventsRef = useWhiteboardStore.getState().events;
    let lastAudioRef = useWhiteboardStore.getState().audioSegments;
    let lastTitleRef = useWhiteboardStore.getState().project.title;
    let lastPagesRef = useWhiteboardStore.getState().project.pages;

    const commit = () => {
      const snapshotJson = exportSnapshotJson();
      const now = new Date().toISOString();
      setProjects((prev) => {
        const index = prev.findIndex((item) => item.id === activeProjectId);
        if (index < 0) {
          return prev;
        }

        const current = prev[index];
        const nextPages = normalizeProjectRecordPages(useWhiteboardStore.getState().project.pages);
        if (
          current.snapshotJson === snapshotJson
          && current.name === currentProjectTitle
          && JSON.stringify(current.projectPages) === JSON.stringify(nextPages)
        ) {
          return prev;
        }

        const next = [...prev];
        next[index] = {
          ...current,
          name: currentProjectTitle,
          updatedAt: now,
          snapshotJson,
          projectPages: nextPages,
        };
        return next;
      });
    };

    const unsubscribe = useWhiteboardStore.subscribe((state) => {
      const eventsChanged = state.events !== lastEventsRef;
      const audioChanged = state.audioSegments !== lastAudioRef;
      const titleChanged = state.project.title !== lastTitleRef;
      const pagesChanged = state.project.pages !== lastPagesRef;
      if (!eventsChanged && !audioChanged && !titleChanged && !pagesChanged) {
        return;
      }

      lastEventsRef = state.events;
      lastAudioRef = state.audioSegments;
      lastTitleRef = state.project.title;
      lastPagesRef = state.project.pages;

      platformClearTimeout(timer);
      timer = platformSetTimeout(() => {
        commit();
        timer = null;
      }, 220);
    });

    return () => {
      unsubscribe();
      platformClearTimeout(timer);
    };
  }, [layer, activeProjectId, currentProjectTitle, exportSnapshotJson]);

  useEffect(() => {
    if (!shellState.exportMenuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.overlay-right')) {
        return;
      }
      setShellState((prev) => dismissExportMenuCommand(prev));
    };
    return combineWindowEventDisposers(
      subscribeWindowPointerDown(onPointerDown),
      subscribeWindowEscape(() => {
        setShellState((prev) => dismissExportMenuCommand(prev));
      }),
    );
  }, [shellState.exportMenuOpen]);

  useEffect(() => {
    if (!shellState.showCreateProjectForm) {
      return;
    }
    return subscribeWindowEscape(() => {
      closeCreateProjectDialog();
    });
  }, [shellState.showCreateProjectForm, shellState.createProjectDraft.creating]);

  useEffect(() => {
    const nextProjectId = resolvePageManagerProjectId(shellState.pageManagerProjectId, projects, layer);
    if (nextProjectId === shellState.pageManagerProjectId) {
      return;
    }
    setShellState((prev) => syncPageManagerProjectCommand(prev, nextProjectId));
  }, [layer, projects, shellState.pageManagerProjectId]);

  useEffect(() => {
    if (!shellState.pageManagerProjectId) {
      return;
    }
    setShellState((prev) => syncPageManagerSelectionCommand(prev, pageManagerPages));
  }, [pageManagerPages, shellState.pageManagerProjectId]);

  const openProject = (project: ProjectRecord) => {
    const result = importSnapshotJson(project.snapshotJson);
    if (!result.ok) {
      return;
    }

    setProjectTitle(project.name);
    setProjectPages(project.projectPages ?? [], {
      replace: true,
      touchUpdatedAt: false,
    });
    setActiveProjectId(project.id);
    setLayer('recording');
  };

  const createProject = async () => {
    const name = shellState.createProjectDraft.name.trim();
    if (!name) {
      return;
    }
    const sourceFile = shellState.createProjectDraft.mode === 'file'
      ? shellState.createProjectDraft.file
      : null;
    if (shellState.createProjectDraft.mode === 'file' && !sourceFile) {
      return;
    }

    setShellState((prev) => setCreateProjectPendingCommand(prev, true));
    try {
      resetProject();
      setProjectTitle(name);

      let pages = normalizeProjectRecordPages(useWhiteboardStore.getState().project.pages);
      if (sourceFile) {
        const { importCoursewareFile, toProjectPagesFromImport } = await import('./utils/coursewareImporter');
        const imported = await importCoursewareFile(sourceFile);
        const importedPages = toProjectPagesFromImport(imported, 0);
        pages = normalizeProjectRecordPages(importedPages.length > 0 ? importedPages : pages);
        setProjectPages(pages, {
          replace: true,
          switchToPageId: pages[0]?.id,
          touchUpdatedAt: false,
        });
      } else {
        setProjectPages(pages, {
          replace: true,
          touchUpdatedAt: false,
        });
      }

      const now = new Date().toISOString();
      const project = createProjectRecord({
        id: generateId('proj'),
        name,
        author: shellState.createProjectDraft.author.trim() || undefined,
        createdAt: now,
        snapshotJson: exportSnapshotJson(),
        projectPages: pages,
      });

      setProjects((prev) => upsertProjectRecord(prev, project));
      setActiveProjectId(project.id);
      setLayer('recording');
      setShellState((prev) => finishCreateProjectCommand(prev));
    } catch {
      // ignore invalid create payloads
    } finally {
      setShellState((prev) => setCreateProjectPendingCommand(prev, false));
    }
  };

  const importUfprojFile = async (file: File) => {
    if (!isUfprojFile(file)) {
      return;
    }
    const { decodeUfprojFile } = await import('./utils/ufprojArchive');
    const decoded = await decodeUfprojFile(file);
    if (!decoded) {
      return;
    }

    const importResult = importSnapshotJson(decoded.snapshotJson);
    if (!importResult.ok) {
      return;
    }

    const fallbackName = file.name.replace(/\.ufproj$/i, '').trim() || 'Imported Project';
    const now = new Date().toISOString();
    const record = createProjectRecord({
      id: decoded.project?.id?.trim() || generateId('proj'),
      name: decoded.project?.name?.trim() || fallbackName,
      author: decoded.project?.author?.trim() || undefined,
      createdAt: decoded.project?.createdAt || now,
      updatedAt: decoded.project?.updatedAt || now,
      snapshotJson: decoded.snapshotJson,
      projectPages: decoded.projectPages,
    });
    const hydratedPages = record.projectPages;

    setProjectTitle(record.name);
    setProjectPages(hydratedPages, {
      replace: true,
      touchUpdatedAt: false,
    });
    setProjects((prev) => upsertProjectRecord(prev, {
      ...record,
      projectPages: hydratedPages,
    }));
    setActiveProjectId(record.id);
    setLayer('recording');
  };

  const exportCurrentProject = () => {
    if (!activeProjectId) {
      return;
    }

    const snapshotJson = exportSnapshotJson();
    const snapshot = parseSnapshotJson(snapshotJson);
    if (!snapshot) {
      return;
    }

    const now = new Date().toISOString();
    const nextRecord = createProjectRecord({
      id: activeProject?.id ?? activeProjectId,
      name: currentProjectTitle || activeProject?.name || 'UniFlow Project',
      author: activeProject?.author?.trim() || undefined,
      createdAt: activeProject?.createdAt ?? now,
      updatedAt: now,
      snapshotJson,
      projectPages: currentProjectPages,
    });

    setProjects((prev) => upsertProjectRecord(prev, nextRecord));
    setShellState((prev) => dismissExportMenuCommand(prev));
    const snapshotJsonForExport = snapshotToJson(snapshot);
    enqueueExportJob('ufproj', {
      fileBaseName: sanitizeFilename(nextRecord.name),
      project: {
        id: nextRecord.id,
        name: nextRecord.name,
        author: nextRecord.author,
        createdAt: nextRecord.createdAt,
        updatedAt: nextRecord.updatedAt,
      },
      snapshotJson: snapshotJsonForExport,
      projectPages: currentProjectPages,
    });
  };

  const saveActiveProjectNow = () => {
    if (!activeProjectId) {
      return;
    }
    const snapshotJson = exportSnapshotJson();
    const now = new Date().toISOString();
    const pages = normalizeProjectRecordPages(useWhiteboardStore.getState().project.pages);
    setProjects((prev) => updateProjectRecordInLibrary(prev, activeProjectId, (current) => ({
      ...current,
      name: currentProjectTitle,
      updatedAt: now,
      snapshotJson,
      projectPages: pages,
    })));
  };

  const renameProjectRecord = (projectId: string, nextNameRaw: string) => {
    setProjects((prev) => renameProjectLibraryRecord(prev, projectId, nextNameRaw));
    if (activeProjectId === projectId) {
      const nextName = nextNameRaw.trim();
      if (nextName) {
        setProjectTitle(nextName);
      }
    }
  };

  const beginProjectTitleEdit = (project: ProjectRecord) => {
    setShellState((prev) => beginProjectRenameCommand(prev, project.id, project.name));
  };

  const commitProjectTitleEdit = () => {
    if (!shellState.editingProjectId) {
      return;
    }
    renameProjectRecord(shellState.editingProjectId, shellState.editingProjectName);
    setShellState((prev) => cancelProjectRenameCommand(prev));
  };

  const duplicateProjectRecord = (projectId: string) => {
    setProjects((prev) => duplicateProjectLibraryRecord(prev, projectId, generateId('proj')));
  };

  const deleteProjectRecord = (projectId: string) => {
    const nextLibrary = deleteProjectLibraryRecord(projects, activeProjectId, projectId);
    setProjects(nextLibrary.projects);
    setActiveProjectId(nextLibrary.activeProjectId);
    if (shellState.pageManagerProjectId === projectId) {
      setShellState((prev) => closeProjectPageManagerCommand(prev));
    }
  };

  const updateProjectPagesRecord = (
    projectId: string,
    updater: (pages: ProjectPage[]) => ProjectPage[],
  ) => {
    setProjects((prev) => updateProjectPagesInLibrary(prev, projectId, updater));
  };

  const addBlankPageToProject = (projectId: string) => {
    updateProjectPagesRecord(projectId, (pages) => addBlankProjectPage(pages, generateId('page')));
  };

  const moveProjectPageInManager = (projectId: string, pageId: string, direction: -1 | 1) => {
    updateProjectPagesRecord(projectId, (pages) => moveProjectPage(pages, pageId, direction));
  };

  const duplicateProjectPageInManager = (projectId: string, pageId: string) => {
    updateProjectPagesRecord(projectId, (pages) => (
      duplicateProjectPageInLibrary(pages, pageId, generateId('page'))
    ));
  };

  const deleteProjectPageInManager = (projectId: string, pageId: string) => {
    updateProjectPagesRecord(projectId, (pages) => deleteProjectPageFromLibrary(pages, pageId));
  };

  const togglePageManagerSelection = (pageId: string) => {
    setShellState((prev) => toggleProjectPageSelectionCommand(prev, pageId));
  };

  const duplicateSelectedProjectPagesInManager = (projectId: string) => {
    updateProjectPagesRecord(projectId, (pages) => (
      duplicateSelectedProjectPages(pages, shellState.pageManagerSelectedPageIds, () => generateId('page'))
    ));
  };

  const deleteSelectedProjectPagesInManager = (projectId: string) => {
    if (shellState.pageManagerSelectedPageIds.length <= 0) {
      return;
    }
    updateProjectPagesRecord(projectId, (pages) => (
      deleteSelectedProjectPages(pages, shellState.pageManagerSelectedPageIds)
    ));
    setShellState((prev) => clearProjectPageSelectionCommand(prev));
  };

  const importCourseware = async (file: File) => {
    if (!activeProjectId) {
      return;
    }
    setCoursewareBusy(true);
    try {
      const { importCoursewareFile, toProjectPagesFromImport } = await import('./utils/coursewareImporter');
      const imported = await importCoursewareFile(file);
      const currentPages = normalizeProjectRecordPages(useWhiteboardStore.getState().project.pages);
      const appended = toProjectPagesFromImport(imported, currentPages.length);
      const nextPages = normalizeProjectRecordPages([...currentPages, ...appended]);
      setProjectPages(nextPages, {
        replace: true,
        switchToPageId: appended[0]?.id,
      });
      const snapshotJson = exportSnapshotJson();
      const now = new Date().toISOString();
      setProjects((prev) => updateProjectRecordInLibrary(prev, activeProjectId, (project) => ({
        ...project,
        name: useWhiteboardStore.getState().project.title,
        snapshotJson,
        projectPages: nextPages,
        updatedAt: now,
      })));
    } catch {
      // ignore invalid courseware payloads
    } finally {
      setCoursewareBusy(false);
    }
  };

  const openUfprojFromDialog = async () => {
    const [file] = await openFileDialog({
      accept: UFPROJ_ACCEPT,
      multiple: false,
    });
    if (!file) {
      return;
    }
    if (!isUfprojFile(file)) {
      return;
    }
    await importUfprojFile(file);
  };

  const pickCreateProjectCourseware = async () => {
    const [file] = await openFileDialog({
      accept: COURSEWARE_ACCEPT,
      multiple: false,
    });
    setShellState((prev) => setCreateProjectFileCommand(prev, file ?? null));
  };

  const openCreateProjectDialog = (mode: CreateProjectMode) => {
    setShellState((prev) => openCreateProjectDialogCommand(prev, mode));
  };

  const closeCreateProjectDialog = () => {
    setShellState((prev) => closeCreateProjectDialogCommand(prev));
  };

  const importCoursewareFromDialog = async () => {
    if (recordingStatus !== 'idle' || coursewareBusy) {
      return;
    }
    const [file] = await openFileDialog({
      accept: COURSEWARE_ACCEPT,
      multiple: false,
    });
    if (!file) {
      return;
    }
    await importCourseware(file);
  };

  const exportCurrentProjectMp4 = () => {
    setShellState((prev) => dismissExportMenuCommand(prev));
    const store = useWhiteboardStore.getState();
    const timelineStats = getExportTimelineStats(store.events, store.audioSegments);
    enqueueExportJob('mp4', {
      projectId: store.project.id,
      fileBaseName: sanitizeFilename(store.project.title || 'UniFlow'),
      pages: store.project.pages,
      events: store.events,
      audioSegments: store.audioSegments,
      fps: 60,
      expectedDurationMs: timelineStats.durationMs,
      expectedEventMaxMs: timelineStats.eventMaxMs,
      expectedAudioMaxMs: timelineStats.audioMaxMs,
      expectedFingerprint: timelineStats.fingerprint,
    });
  };

  return (
    <div className={`app-shell ${layer === 'recording' ? 'recording-shell' : ''} ${nativeMacDesktop ? 'native-macos' : ''}`}>
      {layer === 'project' ? (
        <section className="panel project-layer">
          <div className="project-header">
            <div className="project-title-wrap">
              <h2>UniFlow Projects</h2>
              <p>登录/注册层已在开发模式下跳过，直接进入项目管理。</p>
            </div>
            <div className="project-actions">
              <button
                type="button"
                className="icon-btn"
                onClick={() => {
                  openCreateProjectDialog('blank');
                }}
              >
                <IoAddCircleOutline size={15} />
                New Project
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => {
                  void openUfprojFromDialog();
                }}
              >
                <IoFolderOpenOutline size={15} />
                Open .ufproj
              </button>
            </div>
            <div className="user-chip project-user-chip">
              <IoPersonCircleOutline size={20} />
              <div className="user-chip-meta">
                <strong>{CURRENT_USER_NAME}</strong>
                <span>{CURRENT_USER_HANDLE}</span>
              </div>
              <span className="license-badge">{CURRENT_LICENSE}</span>
            </div>
          </div>

          <div className="project-grid">
            {projects.map((project) => (
              <div
                key={project.id}
                className={`project-card ${project.id === activeProjectId ? 'active' : ''}`}
              >
                <div className="project-card-actions">
                  <button
                    type="button"
                    className={`icon-btn card-action ${shellState.pageManagerProjectId === project.id ? 'selected' : ''}`}
                    title="Manage Pages"
                    onClick={(event) => {
                      event.stopPropagation();
                      setShellState((prev) => toggleProjectPageManagerCommand(prev, project.id));
                    }}
                  >
                    <IoLayersOutline size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn card-action"
                    title="Duplicate Project"
                    onClick={(event) => {
                      event.stopPropagation();
                      duplicateProjectRecord(project.id);
                    }}
                  >
                    <IoCopyOutline size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn card-action danger"
                    title="Delete Project"
                    disabled={projects.length <= 1}
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteProjectRecord(project.id);
                    }}
                  >
                    <IoTrashOutline size={14} />
                  </button>
                </div>
                <div className="project-card-title" onClick={() => beginProjectTitleEdit(project)}>
                  {shellState.editingProjectId === project.id ? (
                    <input
                      autoFocus
                      className="project-title-input"
                      value={shellState.editingProjectName}
                      onChange={(event) => {
                        setShellState((prev) => updateProjectRenameDraftCommand(prev, event.target.value));
                      }}
                      onBlur={commitProjectTitleEdit}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          commitProjectTitleEdit();
                        } else if (event.key === 'Escape') {
                          setShellState((prev) => cancelProjectRenameCommand(prev));
                        }
                      }}
                    />
                  ) : (
                    project.name
                  )}
                </div>
                <div className="project-card-meta">Updated: {formatProjectTime(project.updatedAt)}</div>
                <div className="project-card-meta">Pages: {(project.projectPages ?? []).length}</div>
                {project.author ? (
                  <div className="project-card-meta">Author: {project.author}</div>
                ) : null}
                <button
                  type="button"
                  className="project-card-open"
                  onClick={() => openProject(project)}
                >
                  <IoPlayCircleOutline size={15} />
                  Open
                </button>
              </div>
            ))}
          </div>

          {pageManagerProject ? (
            <div className="panel project-pages-panel">
              <div className="project-pages-panel-header">
                <strong>{pageManagerProject.name} · 页面管理</strong>
                <div className="project-pages-panel-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => {
                      setShellState((prev) => selectAllProjectPagesCommand(prev, pageManagerPages));
                    }}
                  >
                    <IoCheckmarkCircleOutline size={14} />
                    全选
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => {
                      setShellState((prev) => clearProjectPageSelectionCommand(prev));
                    }}
                  >
                    <IoRemoveCircleOutline size={14} />
                    清空
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={shellState.pageManagerSelectedPageIds.length <= 0}
                    onClick={() => duplicateSelectedProjectPagesInManager(pageManagerProject.id)}
                  >
                    <IoCopyOutline size={14} />
                    复制选中
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    disabled={!canDeleteSelectedPagesInManager}
                    onClick={() => deleteSelectedProjectPagesInManager(pageManagerProject.id)}
                  >
                    <IoTrashOutline size={14} />
                    删除选中
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => addBlankPageToProject(pageManagerProject.id)}
                  >
                    <IoAddCircleOutline size={14} />
                    添加空白页
                  </button>
                  <button
                    type="button"
                    className="icon-btn card-action"
                    onClick={() => {
                      setShellState((prev) => closeProjectPageManagerCommand(prev));
                    }}
                  >
                    <IoCloseOutline size={14} />
                  </button>
                </div>
              </div>
              <div className="project-pages-list">
                {pageManagerPages.map((page, index, arr) => (
                  <div
                    key={page.id}
                    className={`project-page-item ${shellState.pageManagerSelectedPageIds.includes(page.id) ? 'selected' : ''}`}
                    onClick={() => togglePageManagerSelection(page.id)}
                  >
                    <div className="project-page-item-meta">
                      <strong>{page.name}</strong>
                      <span>{page.assetType.toUpperCase()}</span>
                    </div>
                    <div className="project-page-item-actions">
                      <button
                        type="button"
                        className="icon-btn card-action"
                        disabled={index === 0}
                        onClick={(event) => {
                          event.stopPropagation();
                          moveProjectPageInManager(pageManagerProject.id, page.id, -1);
                        }}
                      >
                        <IoChevronUpOutline size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn card-action"
                        disabled={index >= arr.length - 1}
                        onClick={(event) => {
                          event.stopPropagation();
                          moveProjectPageInManager(pageManagerProject.id, page.id, 1);
                        }}
                      >
                        <IoChevronDownOutline size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn card-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          duplicateProjectPageInManager(pageManagerProject.id, page.id);
                        }}
                      >
                        <IoCopyOutline size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn card-action danger"
                        disabled={pageManagerPages.length <= 1}
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteProjectPageInManager(pageManagerProject.id, page.id);
                        }}
                      >
                        <IoTrashOutline size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : (
        <section className="recording-layer">
          <div className="recording-stage">
            {nativeMacDesktop ? <div className="native-title-drag-region" aria-hidden="true" /> : null}
            <RecordingOverlay
              presentation={recordingOverlayPresentation}
              projectTitle={currentProjectTitle || activeProject?.name || 'Blackboard'}
              currentPageLabel={activeProjectPage?.name || 'Blackboard'}
              exportMenuOpen={shellState.exportMenuOpen}
              exportMenuRef={exportMenuRef}
              onBack={() => {
                if (recordingStatus !== 'idle') {
                  return;
                }
                saveActiveProjectNow();
                setLayer('project');
              }}
              onImportCourseware={() => {
                void importCoursewareFromDialog();
              }}
              onDuplicatePage={() => {
                duplicateProjectPage(useWhiteboardStore.getState().state.currentPageId);
              }}
              onDeletePage={() => {
                deleteProjectPage(useWhiteboardStore.getState().state.currentPageId);
              }}
              onToggleExportMenu={() => {
                setShellState((prev) => toggleExportMenuCommand(prev));
              }}
              onExportMp4={() => {
                void exportCurrentProjectMp4();
              }}
              onExportUfproj={() => {
                void exportCurrentProject();
              }}
            />

            <main className="app-main recording-workspace">
              <Suspense fallback={<div className="recording-loading">Loading recording workspace…</div>}>
                <WhiteboardCanvas />
                <TimelineEditor />
              </Suspense>
            </main>
            {exportQueuePresentation.hasJobs ? (
              <div className="export-task-hud">
                <div className="export-task-hud-header">
                  <strong>Export Queue</strong>
                  <span>{exportQueuePresentation.runningCount} running</span>
                  <button
                    type="button"
                    className="icon-btn export-task-hud-toggle"
                    onClick={() => setExportHudCollapsed(!exportHudCollapsed)}
                  >
                    {exportHudCollapsed ? <IoChevronUpOutline size={14} /> : <IoChevronDownOutline size={14} />}
                  </button>
                  <button
                    type="button"
                    className="icon-btn export-task-hud-clear"
                    disabled={!exportQueuePresentation.canClearFinished}
                    onClick={clearFinishedExportJobs}
                  >
                    Clear Done
                  </button>
                </div>
                {!exportHudCollapsed ? (
                  <div className="export-task-list">
                    {exportJobs.map((task) => (
                      <div key={task.id} className={`export-task-item ${task.status}`}>
                        <div className="export-task-head">
                          <strong>{task.kind === 'mp4' ? 'MP4 Export' : 'Project Export'}</strong>
                          <span>{Math.round(task.progress * 100)}%</span>
                        </div>
                        <div className="export-task-message">{task.error ?? task.message}</div>
                        <div className="export-task-progress">
                          <div
                            className="export-task-progress-bar"
                            style={{ width: `${Math.round(task.progress * 100)}%` }}
                          />
                        </div>
                        <div className="export-task-actions">
                        {(task.status === 'running' || task.status === 'queued') ? (
                          <button
                            type="button"
                            className="icon-btn export-task-action"
                            onClick={() => cancelExportJob(task.id)}
                          >
                            <IoStopCircleOutline size={14} />
                            Cancel
                          </button>
                        ) : null}
                        {(task.status === 'error' || task.status === 'canceled') ? (
                          <button
                            type="button"
                            className="icon-btn export-task-action"
                            onClick={() => retryExportJob(task.id)}
                          >
                            <IoRefreshOutline size={14} />
                            Retry
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="icon-btn export-task-close"
                          disabled={task.id === runningExportJobId}
                          onClick={() => removeExportJob(task.id)}
                        >
                          <IoCloseOutline size={14} />
                        </button>
                      </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      )}
      {shellState.showCreateProjectForm ? (
        <div className="confirm-backdrop" onClick={() => closeCreateProjectDialog()}>
          <div
            className="panel create-project-dialog"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="create-project-dialog-header">
              <h4>新建项目</h4>
              <button
                type="button"
                className="icon-btn card-action"
                disabled={shellState.createProjectDraft.creating}
                onClick={() => closeCreateProjectDialog()}
              >
                <IoCloseOutline size={14} />
              </button>
            </div>
            <div className="create-project-mode-switch">
              <button
                type="button"
                className={`icon-btn ${shellState.createProjectDraft.mode === 'blank' ? 'selected' : ''}`}
                disabled={shellState.createProjectDraft.creating}
                onClick={() => {
                  setShellState((prev) => setCreateProjectModeCommand(prev, 'blank'));
                }}
              >
                <IoAddCircleOutline size={14} />
                空白项目
              </button>
              <button
                type="button"
                className={`icon-btn ${shellState.createProjectDraft.mode === 'file' ? 'selected' : ''}`}
                disabled={shellState.createProjectDraft.creating}
                onClick={() => {
                  setShellState((prev) => setCreateProjectModeCommand(prev, 'file'));
                }}
              >
                <IoDocumentAttachOutline size={14} />
                以文件创建
              </button>
            </div>
            <form
              className="create-project-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!createProjectDialogPresentation.canSubmit) {
                  return;
                }
                void createProject();
              }}
            >
              <label>
                项目名（必填）
                <input
                  autoFocus
                  type="text"
                  value={shellState.createProjectDraft.name}
                  placeholder="例如：高数第3讲"
                  onChange={(event) => {
                    setShellState((prev) => setCreateProjectNameCommand(prev, event.target.value));
                  }}
                />
              </label>
              <label>
                作者（可选）
                <input
                  type="text"
                  value={shellState.createProjectDraft.author}
                  placeholder="例如：张老师"
                  onChange={(event) => {
                    setShellState((prev) => setCreateProjectAuthorCommand(prev, event.target.value));
                  }}
                />
              </label>
              {shellState.createProjectDraft.mode === 'file' ? (
                <div className="create-project-file-row">
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={shellState.createProjectDraft.creating}
                    onClick={() => {
                      void pickCreateProjectCourseware();
                    }}
                  >
                    <IoDocumentAttachOutline size={15} />
                    {createProjectDialogPresentation.fileButtonLabel}
                  </button>
                  <span className="mono create-project-file-name">
                    {createProjectDialogPresentation.fileNameLabel}
                  </span>
                </div>
              ) : (
                <div className="create-project-file-row hint">
                  <span className="mono create-project-file-name">
                    {createProjectDialogPresentation.fileNameLabel}
                  </span>
                </div>
              )}
              <div className="create-project-submit-row">
                <button
                  type="button"
                  className="icon-btn"
                  disabled={shellState.createProjectDraft.creating}
                  onClick={() => closeCreateProjectDialog()}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="icon-btn"
                  disabled={!createProjectDialogPresentation.canSubmit}
                >
                  <IoAddCircleOutline size={15} />
                  {createProjectDialogPresentation.confirmLabel}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default App;
