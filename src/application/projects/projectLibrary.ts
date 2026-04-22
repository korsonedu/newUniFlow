import { ProjectPage } from '../../domain/types';
import { parseSnapshotJson } from '../../store/snapshot';

export type ProjectRecord = {
  id: string;
  name: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
  snapshotJson: string;
  projectPages: ProjectPage[];
};

export type ProjectLibraryState = {
  projects: ProjectRecord[];
  activeProjectId: string | null;
};

type CreateProjectRecordInput = {
  id: string;
  name: string;
  author?: string;
  createdAt: string;
  updatedAt?: string;
  snapshotJson: string;
  projectPages: ProjectPage[];
};

export const normalizeProjectRecordPages = (pages: ProjectPage[]): ProjectPage[] => {
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

export const parseProjectRecordPages = (value: unknown): ProjectPage[] => {
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
  return normalizeProjectRecordPages(parsed);
};

export const parseProjectLibraryRecords = (value: unknown): ProjectRecord[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
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
      projectPages: parseProjectRecordPages((row as unknown as Record<string, unknown>).projectPages),
    }));
};

export const formatProjectTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString();
};

export const createProjectRecord = (input: CreateProjectRecordInput): ProjectRecord => {
  return {
    id: input.id,
    name: input.name,
    author: input.author?.trim() || undefined,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
    snapshotJson: input.snapshotJson,
    projectPages: normalizeProjectRecordPages(input.projectPages),
  };
};

export const upsertProjectRecord = (
  projects: ProjectRecord[],
  nextRecord: ProjectRecord,
): ProjectRecord[] => {
  const index = projects.findIndex((project) => project.id === nextRecord.id);
  if (index < 0) {
    return [nextRecord, ...projects];
  }
  const next = [...projects];
  next[index] = nextRecord;
  return next;
};

export const updateProjectRecordInLibrary = (
  projects: ProjectRecord[],
  projectId: string,
  updater: (project: ProjectRecord) => ProjectRecord,
): ProjectRecord[] => {
  return projects.map((project) => (
    project.id === projectId ? updater(project) : project
  ));
};

export const renameProjectLibraryRecord = (
  projects: ProjectRecord[],
  projectId: string,
  nextNameRaw: string,
): ProjectRecord[] => {
  const current = projects.find((project) => project.id === projectId);
  const nextName = nextNameRaw.trim();
  if (!current || !nextName || nextName === current.name) {
    return projects;
  }
  const updatedAt = new Date().toISOString();
  return projects.map((project) => (
    project.id === projectId
      ? { ...project, name: nextName, updatedAt }
      : project
  ));
};

export const duplicateProjectLibraryRecord = (
  projects: ProjectRecord[],
  projectId: string,
  nextId: string,
): ProjectRecord[] => {
  const current = projects.find((project) => project.id === projectId);
  if (!current) {
    return projects;
  }
  const now = new Date().toISOString();
  const duplicated: ProjectRecord = {
    ...current,
    id: nextId,
    name: `${current.name} Copy`,
    createdAt: now,
    updatedAt: now,
    projectPages: normalizeProjectRecordPages(current.projectPages ?? []),
  };
  return [duplicated, ...projects];
};

export const deleteProjectLibraryRecord = (
  projects: ProjectRecord[],
  activeProjectId: string | null,
  projectId: string,
): ProjectLibraryState => {
  if (projects.length <= 1) {
    return { projects, activeProjectId };
  }
  const nextProjects = projects.filter((project) => project.id !== projectId);
  const nextActiveProjectId = activeProjectId === projectId
    ? (nextProjects[0]?.id ?? null)
    : activeProjectId;
  return {
    projects: nextProjects,
    activeProjectId: nextActiveProjectId,
  };
};

export const updateProjectPagesInLibrary = (
  projects: ProjectRecord[],
  projectId: string,
  updater: (pages: ProjectPage[]) => ProjectPage[],
): ProjectRecord[] => {
  const updatedAt = new Date().toISOString();
  return projects.map((project) => {
    if (project.id !== projectId) {
      return project;
    }
    const nextPages = normalizeProjectRecordPages(
      updater(normalizeProjectRecordPages(project.projectPages ?? [])),
    );
    return {
      ...project,
      projectPages: nextPages,
      updatedAt,
    };
  });
};

export const addBlankProjectPage = (
  pages: ProjectPage[],
  nextPageId: string,
): ProjectPage[] => {
  return [
    ...pages,
    {
      id: nextPageId,
      name: `Page ${pages.length + 1}`,
      assetType: 'blank',
      order: pages.length,
    },
  ];
};

export const moveProjectPage = (
  pages: ProjectPage[],
  pageId: string,
  direction: -1 | 1,
): ProjectPage[] => {
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
};

export const duplicateProjectPage = (
  pages: ProjectPage[],
  pageId: string,
  nextPageId: string,
): ProjectPage[] => {
  const sorted = [...pages].sort((a, b) => a.order - b.order);
  const index = sorted.findIndex((page) => page.id === pageId);
  if (index < 0) {
    return pages;
  }
  const source = sorted[index];
  sorted.splice(index + 1, 0, {
    ...source,
    id: nextPageId,
    order: index + 1,
  });
  return sorted;
};

export const deleteProjectPage = (
  pages: ProjectPage[],
  pageId: string,
): ProjectPage[] => {
  if (pages.length <= 1) {
    return pages;
  }
  return pages.filter((page) => page.id !== pageId);
};

export const duplicateSelectedProjectPages = (
  pages: ProjectPage[],
  selectedPageIds: string[],
  createNextPageId: () => string,
): ProjectPage[] => {
  if (selectedPageIds.length <= 0) {
    return pages;
  }
  const selectedSet = new Set(selectedPageIds);
  const sorted = [...pages].sort((a, b) => a.order - b.order);
  const next: ProjectPage[] = [];
  for (const page of sorted) {
    next.push(page);
    if (selectedSet.has(page.id)) {
      next.push({
        ...page,
        id: createNextPageId(),
      });
    }
  }
  return next;
};

export const deleteSelectedProjectPages = (
  pages: ProjectPage[],
  selectedPageIds: string[],
): ProjectPage[] => {
  if (selectedPageIds.length <= 0) {
    return pages;
  }
  const selectedSet = new Set(selectedPageIds);
  const nextPages = pages.filter((page) => !selectedSet.has(page.id));
  return nextPages.length > 0 ? nextPages : pages;
};

export const filterValidPageSelection = (
  selectedPageIds: string[],
  pages: ProjectPage[],
): string[] => {
  const pageIdSet = new Set(pages.map((page) => page.id));
  return selectedPageIds.filter((id) => pageIdSet.has(id));
};
