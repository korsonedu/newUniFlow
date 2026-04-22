import {
  parseProjectLibraryRecords,
  ProjectLibraryState,
  ProjectRecord,
} from '../../application/projects/projectLibrary';
import {
  readBrowserStorageItem,
  removeBrowserStorageItem,
  writeBrowserStorageItem,
} from './browserStorage';

export const PROJECTS_STORAGE_KEY = 'uniflow.projects.v1';
export const ACTIVE_PROJECT_STORAGE_KEY = 'uniflow.projects.active.v1';

export const loadProjectLibraryState = (): ProjectLibraryState => {
  const rawProjects = readBrowserStorageItem(PROJECTS_STORAGE_KEY);
  let projects: ProjectRecord[] = [];
  if (rawProjects) {
    try {
      projects = parseProjectLibraryRecords(JSON.parse(rawProjects) as unknown);
    } catch {
      projects = [];
    }
  }
  const activeProjectId = readBrowserStorageItem(ACTIVE_PROJECT_STORAGE_KEY);
  return {
    projects,
    activeProjectId,
  };
};

export const saveProjectLibraryState = (
  projects: ProjectRecord[],
  activeProjectId: string | null,
): void => {
  writeBrowserStorageItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  if (activeProjectId) {
    writeBrowserStorageItem(ACTIVE_PROJECT_STORAGE_KEY, activeProjectId);
    return;
  }
  removeBrowserStorageItem(ACTIVE_PROJECT_STORAGE_KEY);
};
