import { ProjectPage } from '../../domain/types';
import { filterValidPageSelection } from './projectLibrary';
import { CreateProjectMode } from './projectWorkspacePresentation';
import {
  beginProjectTitleEditState,
  clearProjectTitleEditState,
  closeCreateProjectDialogState,
  closeExportMenuState,
  openCreateProjectDialogState,
  patchCreateProjectDraftState,
  patchProjectTitleEditState,
  ProjectShellState,
  setPageManagerProjectState,
  setPageManagerSelectionState,
  toggleExportMenuState,
  togglePageManagerProjectState,
  togglePageManagerSelectionState,
} from './projectShellState';

export const dismissExportMenuCommand = (
  state: ProjectShellState,
): ProjectShellState => closeExportMenuState(state);

export const toggleExportMenuCommand = (
  state: ProjectShellState,
): ProjectShellState => toggleExportMenuState(state);

export const syncPageManagerProjectCommand = (
  state: ProjectShellState,
  projectId: string | null,
): ProjectShellState => setPageManagerProjectState(state, projectId);

export const syncPageManagerSelectionCommand = (
  state: ProjectShellState,
  pages: ProjectPage[],
): ProjectShellState => setPageManagerSelectionState(
  state,
  filterValidPageSelection(state.pageManagerSelectedPageIds, pages),
);

export const openCreateProjectDialogCommand = (
  state: ProjectShellState,
  mode: CreateProjectMode,
): ProjectShellState => openCreateProjectDialogState(state, mode);

export const closeCreateProjectDialogCommand = (
  state: ProjectShellState,
): ProjectShellState => closeCreateProjectDialogState(state);

export const setCreateProjectPendingCommand = (
  state: ProjectShellState,
  creating: boolean,
): ProjectShellState => patchCreateProjectDraftState(state, { creating });

export const finishCreateProjectCommand = (
  state: ProjectShellState,
): ProjectShellState => closeCreateProjectDialogState(
  patchCreateProjectDraftState(state, { creating: false }),
);

export const setCreateProjectModeCommand = (
  state: ProjectShellState,
  mode: CreateProjectMode,
): ProjectShellState => patchCreateProjectDraftState(state, {
  mode,
  file: mode === 'blank' ? null : state.createProjectDraft.file,
});

export const setCreateProjectNameCommand = (
  state: ProjectShellState,
  name: string,
): ProjectShellState => patchCreateProjectDraftState(state, { name });

export const setCreateProjectAuthorCommand = (
  state: ProjectShellState,
  author: string,
): ProjectShellState => patchCreateProjectDraftState(state, { author });

export const setCreateProjectFileCommand = (
  state: ProjectShellState,
  file: File | null,
): ProjectShellState => patchCreateProjectDraftState(state, { file });

export const beginProjectRenameCommand = (
  state: ProjectShellState,
  projectId: string,
  projectName: string,
): ProjectShellState => beginProjectTitleEditState(state, projectId, projectName);

export const updateProjectRenameDraftCommand = (
  state: ProjectShellState,
  name: string,
): ProjectShellState => patchProjectTitleEditState(state, name);

export const cancelProjectRenameCommand = (
  state: ProjectShellState,
): ProjectShellState => clearProjectTitleEditState(state);

export const toggleProjectPageManagerCommand = (
  state: ProjectShellState,
  projectId: string,
): ProjectShellState => togglePageManagerProjectState(state, projectId);

export const closeProjectPageManagerCommand = (
  state: ProjectShellState,
): ProjectShellState => setPageManagerProjectState(state, null);

export const selectAllProjectPagesCommand = (
  state: ProjectShellState,
  pages: ProjectPage[],
): ProjectShellState => setPageManagerSelectionState(
  state,
  pages.map((page) => page.id),
);

export const clearProjectPageSelectionCommand = (
  state: ProjectShellState,
): ProjectShellState => setPageManagerSelectionState(state, []);

export const toggleProjectPageSelectionCommand = (
  state: ProjectShellState,
  pageId: string,
): ProjectShellState => togglePageManagerSelectionState(state, pageId);
