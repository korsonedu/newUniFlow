import { CreateProjectDraft, CreateProjectMode, createInitialProjectDraft } from './projectWorkspacePresentation';

export type ProjectShellState = {
  showCreateProjectForm: boolean;
  createProjectDraft: CreateProjectDraft;
  exportMenuOpen: boolean;
  editingProjectId: string | null;
  editingProjectName: string;
  pageManagerProjectId: string | null;
  pageManagerSelectedPageIds: string[];
};

export const createInitialProjectShellState = (): ProjectShellState => ({
  showCreateProjectForm: false,
  createProjectDraft: createInitialProjectDraft(),
  exportMenuOpen: false,
  editingProjectId: null,
  editingProjectName: '',
  pageManagerProjectId: null,
  pageManagerSelectedPageIds: [],
});

export const openCreateProjectDialogState = (
  state: ProjectShellState,
  mode: CreateProjectMode,
): ProjectShellState => ({
  ...state,
  showCreateProjectForm: true,
  createProjectDraft: createInitialProjectDraft(mode),
});

export const closeCreateProjectDialogState = (
  state: ProjectShellState,
): ProjectShellState => {
  if (state.createProjectDraft.creating) {
    return state;
  }
  return {
    ...state,
    showCreateProjectForm: false,
    createProjectDraft: createInitialProjectDraft(),
  };
};

export const patchCreateProjectDraftState = (
  state: ProjectShellState,
  patch: Partial<CreateProjectDraft>,
): ProjectShellState => ({
  ...state,
  createProjectDraft: {
    ...state.createProjectDraft,
    ...patch,
  },
});

export const openExportMenuState = (state: ProjectShellState): ProjectShellState => ({
  ...state,
  exportMenuOpen: true,
});

export const closeExportMenuState = (state: ProjectShellState): ProjectShellState => ({
  ...state,
  exportMenuOpen: false,
});

export const toggleExportMenuState = (state: ProjectShellState): ProjectShellState => ({
  ...state,
  exportMenuOpen: !state.exportMenuOpen,
});

export const beginProjectTitleEditState = (
  state: ProjectShellState,
  projectId: string,
  projectName: string,
): ProjectShellState => ({
  ...state,
  editingProjectId: projectId,
  editingProjectName: projectName,
});

export const patchProjectTitleEditState = (
  state: ProjectShellState,
  name: string,
): ProjectShellState => ({
  ...state,
  editingProjectName: name,
});

export const clearProjectTitleEditState = (
  state: ProjectShellState,
): ProjectShellState => ({
  ...state,
  editingProjectId: null,
  editingProjectName: '',
});

export const setPageManagerProjectState = (
  state: ProjectShellState,
  projectId: string | null,
): ProjectShellState => ({
  ...state,
  pageManagerProjectId: projectId,
  pageManagerSelectedPageIds: projectId === state.pageManagerProjectId
    ? state.pageManagerSelectedPageIds
    : [],
});

export const togglePageManagerProjectState = (
  state: ProjectShellState,
  projectId: string,
): ProjectShellState => {
  const nextProjectId = state.pageManagerProjectId === projectId ? null : projectId;
  return {
    ...state,
    pageManagerProjectId: nextProjectId,
    pageManagerSelectedPageIds: nextProjectId === state.pageManagerProjectId
      ? state.pageManagerSelectedPageIds
      : [],
  };
};

export const setPageManagerSelectionState = (
  state: ProjectShellState,
  pageIds: string[],
): ProjectShellState => ({
  ...state,
  pageManagerSelectedPageIds: pageIds,
});

export const togglePageManagerSelectionState = (
  state: ProjectShellState,
  pageId: string,
): ProjectShellState => ({
  ...state,
  pageManagerSelectedPageIds: state.pageManagerSelectedPageIds.includes(pageId)
    ? state.pageManagerSelectedPageIds.filter((id) => id !== pageId)
    : [...state.pageManagerSelectedPageIds, pageId],
});
