import React from 'react';
import {
  IoArrowBackOutline,
  IoCaretDownOutline,
  IoCloudDownloadOutline,
  IoCopyOutline,
  IoDocumentAttachOutline,
  IoEllipsisHorizontalOutline,
  IoTrashOutline,
} from 'react-icons/io5';
import { RecordingOverlayPresentation } from '../../application/projects/projectWorkspacePresentation';

type RecordingOverlayProps = {
  presentation: RecordingOverlayPresentation;
  projectTitle: string;
  currentPageLabel: string;
  exportMenuOpen: boolean;
  exportMenuRef: React.RefObject<HTMLDivElement>;
  onBack: () => void;
  onImportCourseware: () => void;
  onDuplicatePage: () => void;
  onDeletePage: () => void;
  onToggleExportMenu: () => void;
  onExportMp4: () => void;
  onExportUfproj: () => void;
};

export const RecordingOverlay: React.FC<RecordingOverlayProps> = ({
  presentation,
  projectTitle,
  currentPageLabel,
  exportMenuOpen,
  exportMenuRef,
  onBack,
  onImportCourseware,
  onDuplicatePage,
  onDeletePage,
  onToggleExportMenu,
  onExportMp4,
  onExportUfproj,
}) => {
  const runMenuAction = (action: () => void) => {
    if (exportMenuOpen) {
      onToggleExportMenu();
    }
    action();
  };

  return (
    <div className="recording-overlay">
      <div className="overlay-left">
        <div className="overlay-project-pill">
          <button
            type="button"
            className="overlay-nav-btn"
            onClick={onBack}
            disabled={!presentation.canBack}
            title="Back to Projects"
            aria-label="Back to Projects"
          >
            <IoArrowBackOutline size={18} />
          </button>
          <div className="overlay-project-meta">
            <span className="overlay-project-badge">项目</span>
            <div className="overlay-project-line">
              <button
                type="button"
                className="overlay-project-selector"
                disabled
                title={projectTitle}
                aria-label={projectTitle}
              >
                <strong>{projectTitle || 'Blackboard'}</strong>
                <IoCaretDownOutline size={16} />
              </button>
              <span className="overlay-page-caption">{currentPageLabel}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="overlay-right" ref={exportMenuRef}>
        <button
          type="button"
          className="overlay-btn overlay-btn-pill overlay-btn-primary"
          disabled={!presentation.canImportCourseware}
          onClick={onImportCourseware}
        >
          <IoDocumentAttachOutline size={16} />
          邀请
        </button>
        <button
          type="button"
          className="overlay-btn overlay-btn-circle"
          disabled={!presentation.canToggleExportMenu}
          onClick={onToggleExportMenu}
          title="导出与分享"
          aria-label="导出与分享"
        >
          <IoCloudDownloadOutline size={18} />
        </button>
        <button
          type="button"
          className="overlay-btn overlay-btn-circle"
          disabled={!presentation.canToggleExportMenu}
          onClick={onToggleExportMenu}
          title="更多操作"
          aria-label="更多操作"
        >
          <IoEllipsisHorizontalOutline size={18} />
        </button>
        <div className={`overlay-command-menu ${exportMenuOpen ? 'open' : ''}`}>
          <button
            type="button"
            className="overlay-command-item"
            disabled={!presentation.canImportCourseware}
            onClick={() => runMenuAction(onImportCourseware)}
          >
            <IoDocumentAttachOutline size={15} />
            {presentation.importButtonLabel}
          </button>
          <button
            type="button"
            className="overlay-command-item"
            disabled={!presentation.canDuplicatePage}
            onClick={() => runMenuAction(onDuplicatePage)}
          >
            <IoCopyOutline size={15} />
            复制页
          </button>
          <button
            type="button"
            className="overlay-command-item danger"
            disabled={!presentation.canDeletePage}
            onClick={() => runMenuAction(onDeletePage)}
          >
            <IoTrashOutline size={15} />
            删除页
          </button>
          <button
            type="button"
            className="overlay-command-item"
            onClick={() => runMenuAction(onExportMp4)}
          >
            <IoCloudDownloadOutline size={15} />
            Export MP4
          </button>
          <button
            type="button"
            className="overlay-command-item"
            onClick={() => runMenuAction(onExportUfproj)}
          >
            <IoCaretDownOutline size={15} />
            Export .ufproj
          </button>
        </div>
      </div>
    </div>
  );
};
