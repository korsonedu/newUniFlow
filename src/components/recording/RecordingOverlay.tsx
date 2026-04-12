import React from 'react';
import {
  IoArrowBackOutline,
  IoCaretDownOutline,
  IoCloudDownloadOutline,
  IoCopyOutline,
  IoDocumentAttachOutline,
  IoTrashOutline,
} from 'react-icons/io5';
import { RecordingStatus } from '../../domain/types';

type RecordingOverlayProps = {
  recordingStatus: RecordingStatus;
  coursewareBusy: boolean;
  currentProjectPageCount: number;
  runningExportCount: number;
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
  recordingStatus,
  coursewareBusy,
  currentProjectPageCount,
  runningExportCount,
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
  const idle = recordingStatus === 'idle';

  return (
    <div className="recording-overlay">
      <div className="overlay-left">
        <button
          type="button"
          className="overlay-btn"
          onClick={onBack}
          disabled={!idle}
          title="Back to Projects"
          aria-label="Back to Projects"
        >
          <IoArrowBackOutline size={16} />
        </button>
      </div>
      <div className="overlay-right">
        <button
          type="button"
          className="overlay-btn"
          disabled={!idle || coursewareBusy}
          onClick={onImportCourseware}
        >
          <IoDocumentAttachOutline size={16} />
          {coursewareBusy ? 'Importing…' : 'Import PDF/PPT/Image'}
        </button>
        <button
          type="button"
          className="overlay-btn"
          disabled={!idle}
          onClick={onDuplicatePage}
        >
          <IoCopyOutline size={16} />
          Duplicate Page
        </button>
        <button
          type="button"
          className="overlay-btn"
          disabled={!idle || currentProjectPageCount <= 1}
          onClick={onDeletePage}
        >
          <IoTrashOutline size={16} />
          Delete Page
        </button>
        <div className="export-menu" ref={exportMenuRef}>
          <button
            type="button"
            className="overlay-btn"
            disabled={!idle}
            onClick={onToggleExportMenu}
          >
            <IoCloudDownloadOutline size={16} />
            {runningExportCount > 0 ? `Export (${runningExportCount})` : 'Export'}
            <IoCaretDownOutline size={14} />
          </button>
          <div className={`export-menu-list ${exportMenuOpen ? 'open' : ''}`}>
            <button
              type="button"
              className="export-menu-item"
              onClick={onExportMp4}
            >
              Export MP4
            </button>
            <button
              type="button"
              className="export-menu-item"
              onClick={onExportUfproj}
            >
              Export .ufproj
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
