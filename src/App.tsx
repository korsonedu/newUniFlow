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

const WhiteboardCanvas = lazy(() =>
  import('./components/canvas/WhiteboardCanvas').then((module) => ({ default: module.WhiteboardCanvas })));
const TimelineEditor = lazy(() =>
  import('./components/timeline/TimelineEditor').then((module) => ({ default: module.TimelineEditor })));

type AppLayer = 'project' | 'recording';
type CreateProjectMode = 'blank' | 'file';

type ProjectRecord = {
  id: string;
  name: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
  snapshotJson: string;
  projectPages: ProjectPage[];
};

const PROJECTS_STORAGE_KEY = 'uniflow.projects.v1';
const ACTIVE_PROJECT_STORAGE_KEY = 'uniflow.projects.active.v1';
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

const loadProjectsFromStorage = (): ProjectRecord[] => {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is ProjectRecord => {
        if (!item || typeof item !== 'object') {
          return false;
        }
        const row = item as Record<string, unknown>;
        return (
          typeof row.id === 'string'
          && typeof row.name === 'string'
          && typeof row.createdAt === 'string'
          && typeof row.updatedAt === 'string'
          && typeof row.snapshotJson === 'string'
        );
      })
      .filter((row) => !!parseSnapshotJson(row.snapshotJson))
      .map((row) => ({
        ...row,
        author: typeof (row as unknown as Record<string, unknown>).author === 'string'
          ? (row as unknown as Record<string, string>).author
          : undefined,
        projectPages: parseProjectPages((row as unknown as Record<string, unknown>).projectPages),
      }));
  } catch {
    return [];
  }
};

const loadActiveProjectId = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
};

const persistProjects = (projects: ProjectRecord[], activeProjectId: string | null): void => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
    if (activeProjectId) {
      window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, activeProjectId);
    } else {
      window.localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
    }
  } catch {
    // ignore quota/privacy errors
  }
};

const sanitizeFilename = (name: string): string => {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]+/g, '-');
  return cleaned.length > 0 ? cleaned : 'uniflow-project';
};

const normalizeRecordPages = (pages: ProjectPage[]): ProjectPage[] => {
  return pages
    .map((page, index) => ({
      ...page,
      name: `Page ${index + 1}`,
      order: index,
    }))
    .sort((a, b) => a.order - b.order)
    .map((page, index) => ({
      ...page,
      order: index,
    }));
};

const parseProjectPages = (value: unknown): ProjectPage[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const parsed = value
    .filter((item): item is ProjectPage => {
      if (!item || typeof item !== 'object') {
        return false;
      }
      const row = item as Record<string, unknown>;
      return (
        typeof row.id === 'string'
        && typeof row.name === 'string'
        && typeof row.assetType === 'string'
        && typeof row.order === 'number'
      );
    })
    .map((page) => ({
      ...page,
      width: typeof page.width === 'number' ? page.width : undefined,
      height: typeof page.height === 'number' ? page.height : undefined,
      sourceName: typeof page.sourceName === 'string' ? page.sourceName : undefined,
      sourcePageIndex: typeof page.sourcePageIndex === 'number' ? page.sourcePageIndex : undefined,
      backgroundUrl: typeof page.backgroundUrl === 'string' ? page.backgroundUrl : undefined,
      backgroundAssetKey: typeof page.backgroundAssetKey === 'string' ? page.backgroundAssetKey : undefined,
      thumbnailUrl: typeof page.thumbnailUrl === 'string' ? page.thumbnailUrl : undefined,
    }));
  return normalizeRecordPages(parsed);
};

const formatProjectTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString();
};

const isUfprojFile = (file: File): boolean => {
  return /\.ufproj$/i.test(file.name.trim());
};

const App: React.FC = () => {
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

  const [layer, setLayer] = useState<AppLayer>('project');
  const [projects, setProjects] = useState<ProjectRecord[]>(() => loadProjectsFromStorage());
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => loadActiveProjectId());
  const [showCreateProjectForm, setShowCreateProjectForm] = useState(false);
  const [createProjectMode, setCreateProjectMode] = useState<CreateProjectMode>('blank');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectAuthor, setNewProjectAuthor] = useState('');
  const [newProjectFile, setNewProjectFile] = useState<File | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [coursewareBusy, setCoursewareBusy] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingProjectName, setEditingProjectName] = useState('');
  const [pageManagerProjectId, setPageManagerProjectId] = useState<string | null>(null);
  const [pageManagerSelectedPageIds, setPageManagerSelectedPageIds] = useState<string[]>([]);

  const exportMenuRef = useRef<HTMLDivElement>(null);
  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );
  const pageManagerProject = useMemo(
    () => projects.find((project) => project.id === pageManagerProjectId) ?? null,
    [projects, pageManagerProjectId],
  );
  const pageManagerPages = useMemo(
    () => normalizeRecordPages(pageManagerProject?.projectPages ?? []),
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
  const runningExportCount = useMemo(
    () => exportJobs.filter((task) => task.status === 'running').length,
    [exportJobs],
  );
  const canSubmitCreateProject = useMemo(() => {
    const hasName = newProjectName.trim().length > 0;
    const hasRequiredFile = createProjectMode === 'blank' || !!newProjectFile;
    return hasName && hasRequiredFile && !creatingProject;
  }, [createProjectMode, creatingProject, newProjectFile, newProjectName]);
  const canDeleteSelectedPagesInManager = useMemo(
    () => (
      pageManagerSelectedPageIds.length > 0
      && pageManagerPages.length - pageManagerSelectedPageIds.length >= 1
    ),
    [pageManagerPages.length, pageManagerSelectedPageIds.length],
  );

  useEffect(() => {
    if (projects.length > 0) {
      return;
    }
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      id: generateId('proj'),
      name: 'UniFlow Project',
      author: CURRENT_USER_NAME,
      createdAt: now,
      updatedAt: now,
      snapshotJson: exportSnapshotJson(),
      projectPages: normalizeRecordPages(useWhiteboardStore.getState().project.pages),
    };
    setProjects([project]);
    setActiveProjectId(project.id);
  }, [projects.length, exportSnapshotJson]);

  useEffect(() => {
    persistProjects(projects, activeProjectId);
  }, [projects, activeProjectId]);

  useEffect(() => {
    if (layer !== 'recording' || !activeProjectId) {
      return;
    }

    let timer: number | null = null;
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
        const nextPages = normalizeRecordPages(useWhiteboardStore.getState().project.pages);
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

      if (timer !== null) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => {
        commit();
        timer = null;
      }, 220);
    });

    return () => {
      unsubscribe();
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [layer, activeProjectId, currentProjectTitle, exportSnapshotJson]);

  useEffect(() => {
    if (!exportMenuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.export-menu')) {
        return;
      }
      setExportMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setExportMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [exportMenuOpen]);

  useEffect(() => {
    if (!showCreateProjectForm) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeCreateProjectDialog();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [showCreateProjectForm, creatingProject]);

  useEffect(() => {
    if (!pageManagerProjectId) {
      return;
    }
    if (projects.some((project) => project.id === pageManagerProjectId)) {
      return;
    }
    setPageManagerProjectId(null);
  }, [projects, pageManagerProjectId]);

  useEffect(() => {
    if (layer !== 'project' && pageManagerProjectId) {
      setPageManagerProjectId(null);
    }
  }, [layer, pageManagerProjectId]);

  useEffect(() => {
    setPageManagerSelectedPageIds([]);
  }, [pageManagerProjectId]);

  useEffect(() => {
    if (!pageManagerProjectId) {
      return;
    }
    const pageIdSet = new Set(pageManagerPages.map((page) => page.id));
    setPageManagerSelectedPageIds((prev) => prev.filter((id) => pageIdSet.has(id)));
  }, [pageManagerProjectId, pageManagerPages]);

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
    const name = newProjectName.trim();
    if (!name) {
      return;
    }
    const sourceFile = createProjectMode === 'file' ? newProjectFile : null;
    if (createProjectMode === 'file' && !sourceFile) {
      return;
    }

    setCreatingProject(true);
    try {
      resetProject();
      setProjectTitle(name);

      let pages = normalizeRecordPages(useWhiteboardStore.getState().project.pages);
      if (sourceFile) {
        const { importCoursewareFile, toProjectPagesFromImport } = await import('./utils/coursewareImporter');
        const imported = await importCoursewareFile(sourceFile);
        const importedPages = toProjectPagesFromImport(imported, 0);
        pages = normalizeRecordPages(importedPages.length > 0 ? importedPages : pages);
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
      const project: ProjectRecord = {
        id: generateId('proj'),
        name,
        author: newProjectAuthor.trim() || undefined,
        createdAt: now,
        updatedAt: now,
        snapshotJson: exportSnapshotJson(),
        projectPages: pages,
      };

      setProjects((prev) => [project, ...prev]);
      setActiveProjectId(project.id);
      setLayer('recording');
      setShowCreateProjectForm(false);
      setCreateProjectMode('blank');
      setNewProjectName('');
      setNewProjectAuthor('');
      setNewProjectFile(null);
    } catch {
      // ignore invalid create payloads
    } finally {
      setCreatingProject(false);
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
    const record: ProjectRecord = {
      id: decoded.project?.id?.trim() || generateId('proj'),
      name: decoded.project?.name?.trim() || fallbackName,
      author: decoded.project?.author?.trim() || undefined,
      createdAt: decoded.project?.createdAt || now,
      updatedAt: decoded.project?.updatedAt || now,
      snapshotJson: decoded.snapshotJson,
      projectPages: normalizeRecordPages(decoded.projectPages),
    };
    const hydratedPages = record.projectPages;

    setProjectTitle(record.name);
    setProjectPages(hydratedPages, {
      replace: true,
      touchUpdatedAt: false,
    });
    setProjects((prev) => {
      const normalizedRecord: ProjectRecord = {
        ...record,
        projectPages: hydratedPages,
      };
      const index = prev.findIndex((item) => item.id === record.id);
      if (index < 0) {
        return [normalizedRecord, ...prev];
      }
      const next = [...prev];
      next[index] = normalizedRecord;
      return next;
    });
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
    const name = currentProjectTitle || activeProject?.name || 'UniFlow Project';
    const author = activeProject?.author?.trim() || undefined;
    const base: ProjectRecord = activeProject ?? {
      id: activeProjectId,
      name,
      createdAt: now,
      updatedAt: now,
      snapshotJson,
      projectPages: normalizeRecordPages(currentProjectPages),
    };

    const nextRecord: ProjectRecord = {
      ...base,
      name,
      author,
      updatedAt: now,
      snapshotJson,
      projectPages: normalizeRecordPages(currentProjectPages),
    };

    setProjects((prev) => {
      const index = prev.findIndex((item) => item.id === nextRecord.id);
      if (index < 0) {
        return [nextRecord, ...prev];
      }
      const next = [...prev];
      next[index] = nextRecord;
      return next;
    });
    setExportMenuOpen(false);
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
    const pages = normalizeRecordPages(useWhiteboardStore.getState().project.pages);
    setProjects((prev) => {
      const index = prev.findIndex((item) => item.id === activeProjectId);
      if (index < 0) {
        return prev;
      }
      const current = prev[index];
      const next = [...prev];
      next[index] = {
        ...current,
        name: currentProjectTitle,
        updatedAt: now,
        snapshotJson,
        projectPages: pages,
      };
      return next;
    });
  };

  const renameProjectRecord = (projectId: string, nextNameRaw: string) => {
    const current = projects.find((project) => project.id === projectId);
    if (!current) {
      return;
    }
    const nextName = nextNameRaw.trim();
    if (!nextName || nextName === current.name) {
      return;
    }
    setProjects((prev) => prev.map((project) => (
      project.id === projectId
        ? { ...project, name: nextName, updatedAt: new Date().toISOString() }
        : project
    )));
    if (activeProjectId === projectId) {
      setProjectTitle(nextName);
    }
  };

  const beginProjectTitleEdit = (project: ProjectRecord) => {
    setEditingProjectId(project.id);
    setEditingProjectName(project.name);
  };

  const commitProjectTitleEdit = () => {
    if (!editingProjectId) {
      return;
    }
    renameProjectRecord(editingProjectId, editingProjectName);
    setEditingProjectId(null);
    setEditingProjectName('');
  };

  const duplicateProjectRecord = (projectId: string) => {
    const current = projects.find((project) => project.id === projectId);
    if (!current) {
      return;
    }
    const now = new Date().toISOString();
    const duplicated: ProjectRecord = {
      ...current,
      id: generateId('proj'),
      name: `${current.name} Copy`,
      createdAt: now,
      updatedAt: now,
      projectPages: normalizeRecordPages(current.projectPages ?? []),
    };
    setProjects((prev) => [duplicated, ...prev]);
  };

  const deleteProjectRecord = (projectId: string) => {
    if (projects.length <= 1) {
      return;
    }
    const nextProjects = projects.filter((project) => project.id !== projectId);
    setProjects(nextProjects);
    if (activeProjectId === projectId) {
      const nextActive = nextProjects[0] ?? null;
      if (nextActive) {
        setActiveProjectId(nextActive.id);
      } else {
        setActiveProjectId(null);
      }
    }
    if (pageManagerProjectId === projectId) {
      setPageManagerProjectId(null);
    }
  };

  const updateProjectPagesRecord = (
    projectId: string,
    updater: (pages: ProjectPage[]) => ProjectPage[],
  ) => {
    setProjects((prev) => prev.map((project) => {
      if (project.id !== projectId) {
        return project;
      }
      const nextPages = normalizeRecordPages(updater(normalizeRecordPages(project.projectPages ?? [])));
      return {
        ...project,
        projectPages: nextPages,
        updatedAt: new Date().toISOString(),
      };
    }));
  };

  const addBlankPageToProject = (projectId: string) => {
    updateProjectPagesRecord(projectId, (pages) => ([
      ...pages,
      {
        id: generateId('page'),
        name: `Page ${pages.length + 1}`,
        assetType: 'blank',
        order: pages.length,
      },
    ]));
  };

  const moveProjectPageInManager = (projectId: string, pageId: string, direction: -1 | 1) => {
    updateProjectPagesRecord(projectId, (pages) => {
      const sorted = [...pages].sort((a, b) => a.order - b.order);
      const index = sorted.findIndex((page) => page.id === pageId);
      if (index < 0) {
        return pages;
      }
      const target = index + direction;
      if (target < 0 || target >= sorted.length) {
        return pages;
      }
      const [page] = sorted.splice(index, 1);
      sorted.splice(target, 0, page);
      return sorted;
    });
  };

  const duplicateProjectPageInManager = (projectId: string, pageId: string) => {
    updateProjectPagesRecord(projectId, (pages) => {
      const sorted = [...pages].sort((a, b) => a.order - b.order);
      const index = sorted.findIndex((page) => page.id === pageId);
      if (index < 0) {
        return pages;
      }
      const source = sorted[index];
      const duplicate: ProjectPage = {
        ...source,
        id: generateId('page'),
        order: index + 1,
      };
      sorted.splice(index + 1, 0, duplicate);
      return sorted;
    });
  };

  const deleteProjectPageInManager = (projectId: string, pageId: string) => {
    const target = projects.find((project) => project.id === projectId);
    if (!target) {
      return;
    }
    if ((target.projectPages?.length ?? 0) <= 1) {
      return;
    }
    updateProjectPagesRecord(projectId, (pages) => pages.filter((page) => page.id !== pageId));
  };

  const togglePageManagerSelection = (pageId: string) => {
    setPageManagerSelectedPageIds((prev) => (
      prev.includes(pageId)
        ? prev.filter((id) => id !== pageId)
        : [...prev, pageId]
    ));
  };

  const duplicateSelectedProjectPagesInManager = (projectId: string) => {
    if (pageManagerSelectedPageIds.length <= 0) {
      return;
    }
    const selectedSet = new Set(pageManagerSelectedPageIds);
    updateProjectPagesRecord(projectId, (pages) => {
      const sorted = [...pages].sort((a, b) => a.order - b.order);
      const next: ProjectPage[] = [];
      for (const page of sorted) {
        next.push(page);
        if (selectedSet.has(page.id)) {
          next.push({
            ...page,
            id: generateId('page'),
          });
        }
      }
      return next;
    });
  };

  const deleteSelectedProjectPagesInManager = (projectId: string) => {
    if (pageManagerSelectedPageIds.length <= 0) {
      return;
    }
    const selectedSet = new Set(pageManagerSelectedPageIds);
    const target = projects.find((project) => project.id === projectId);
    const total = target?.projectPages?.length ?? 0;
    const nextCount = total - pageManagerSelectedPageIds.length;
    if (nextCount <= 0) {
      return;
    }
    updateProjectPagesRecord(projectId, (pages) => pages.filter((page) => !selectedSet.has(page.id)));
    setPageManagerSelectedPageIds([]);
  };

  const importCourseware = async (file: File) => {
    if (!activeProjectId) {
      return;
    }
    setCoursewareBusy(true);
    try {
      const { importCoursewareFile, toProjectPagesFromImport } = await import('./utils/coursewareImporter');
      const imported = await importCoursewareFile(file);
      const currentPages = normalizeRecordPages(useWhiteboardStore.getState().project.pages);
      const appended = toProjectPagesFromImport(imported, currentPages.length);
      const nextPages = normalizeRecordPages([...currentPages, ...appended]);
      setProjectPages(nextPages, {
        replace: true,
        switchToPageId: appended[0]?.id,
      });
      const snapshotJson = exportSnapshotJson();
      const now = new Date().toISOString();
      setProjects((prev) => prev.map((project) => (
        project.id === activeProjectId
          ? {
            ...project,
            name: useWhiteboardStore.getState().project.title,
            snapshotJson,
            projectPages: nextPages,
            updatedAt: now,
          }
          : project
      )));
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
    setNewProjectFile(file ?? null);
  };

  const openCreateProjectDialog = (mode: CreateProjectMode) => {
    setCreateProjectMode(mode);
    setShowCreateProjectForm(true);
    setNewProjectName('');
    setNewProjectAuthor('');
    setNewProjectFile(null);
  };

  const closeCreateProjectDialog = () => {
    if (creatingProject) {
      return;
    }
    setShowCreateProjectForm(false);
    setCreateProjectMode('blank');
    setNewProjectName('');
    setNewProjectAuthor('');
    setNewProjectFile(null);
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
    setExportMenuOpen(false);
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
    <div className="app-shell">
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
                    className={`icon-btn card-action ${pageManagerProjectId === project.id ? 'selected' : ''}`}
                    title="Manage Pages"
                    onClick={(event) => {
                      event.stopPropagation();
                      setPageManagerProjectId((value) => (value === project.id ? null : project.id));
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
                  {editingProjectId === project.id ? (
                    <input
                      autoFocus
                      className="project-title-input"
                      value={editingProjectName}
                      onChange={(event) => setEditingProjectName(event.target.value)}
                      onBlur={commitProjectTitleEdit}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          commitProjectTitleEdit();
                        } else if (event.key === 'Escape') {
                          setEditingProjectId(null);
                          setEditingProjectName('');
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
                      setPageManagerSelectedPageIds(pageManagerPages.map((page) => page.id));
                    }}
                  >
                    <IoCheckmarkCircleOutline size={14} />
                    全选
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setPageManagerSelectedPageIds([])}
                  >
                    <IoRemoveCircleOutline size={14} />
                    清空
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={pageManagerSelectedPageIds.length <= 0}
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
                    onClick={() => setPageManagerProjectId(null)}
                  >
                    <IoCloseOutline size={14} />
                  </button>
                </div>
              </div>
              <div className="project-pages-list">
                {pageManagerPages.map((page, index, arr) => (
                  <div
                    key={page.id}
                    className={`project-page-item ${pageManagerSelectedPageIds.includes(page.id) ? 'selected' : ''}`}
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
          <RecordingOverlay
            recordingStatus={recordingStatus}
            coursewareBusy={coursewareBusy}
            currentProjectPageCount={currentProjectPages.length}
            runningExportCount={runningExportCount}
            exportMenuOpen={exportMenuOpen}
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
            onToggleExportMenu={() => setExportMenuOpen((value) => !value)}
            onExportMp4={() => {
              setExportMenuOpen(false);
              void exportCurrentProjectMp4();
            }}
            onExportUfproj={() => {
              setExportMenuOpen(false);
              void exportCurrentProject();
            }}
          />

          <main className="app-main">
            <Suspense fallback={<div className="recording-loading">Loading recording workspace…</div>}>
              <WhiteboardCanvas />
              <TimelineEditor />
            </Suspense>
          </main>
          {exportJobs.length > 0 ? (
            <div className="export-task-hud">
              <div className="export-task-hud-header">
                <strong>Export Queue</strong>
                <span>{runningExportCount} running</span>
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
                  disabled={exportJobs.every((task) => task.status === 'running' || task.status === 'queued')}
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
        </section>
      )}
      {showCreateProjectForm ? (
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
                disabled={creatingProject}
                onClick={() => closeCreateProjectDialog()}
              >
                <IoCloseOutline size={14} />
              </button>
            </div>
            <div className="create-project-mode-switch">
              <button
                type="button"
                className={`icon-btn ${createProjectMode === 'blank' ? 'selected' : ''}`}
                disabled={creatingProject}
                onClick={() => setCreateProjectMode('blank')}
              >
                <IoAddCircleOutline size={14} />
                空白项目
              </button>
              <button
                type="button"
                className={`icon-btn ${createProjectMode === 'file' ? 'selected' : ''}`}
                disabled={creatingProject}
                onClick={() => setCreateProjectMode('file')}
              >
                <IoDocumentAttachOutline size={14} />
                以文件创建
              </button>
            </div>
            <form
              className="create-project-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!canSubmitCreateProject) {
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
                  value={newProjectName}
                  placeholder="例如：高数第3讲"
                  onChange={(event) => setNewProjectName(event.target.value)}
                />
              </label>
              <label>
                作者（可选）
                <input
                  type="text"
                  value={newProjectAuthor}
                  placeholder="例如：张老师"
                  onChange={(event) => setNewProjectAuthor(event.target.value)}
                />
              </label>
              {createProjectMode === 'file' ? (
                <div className="create-project-file-row">
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={creatingProject}
                    onClick={() => {
                      void pickCreateProjectCourseware();
                    }}
                  >
                    <IoDocumentAttachOutline size={15} />
                    {newProjectFile ? '更换课件' : '选择课件'}
                  </button>
                  <span className="mono create-project-file-name">
                    {newProjectFile ? newProjectFile.name : '未选择文件'}
                  </span>
                </div>
              ) : (
                <div className="create-project-file-row hint">
                  <span className="mono create-project-file-name">
                    将创建一个不带课件的空白项目
                  </span>
                </div>
              )}
              <div className="create-project-submit-row">
                <button
                  type="button"
                  className="icon-btn"
                  disabled={creatingProject}
                  onClick={() => closeCreateProjectDialog()}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="icon-btn"
                  disabled={!canSubmitCreateProject}
                >
                  <IoAddCircleOutline size={15} />
                  {creatingProject ? '创建中…' : '确认创建'}
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
