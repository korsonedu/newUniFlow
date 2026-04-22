import React from 'react';
import {
  IoAddCircleOutline,
  IoContractOutline,
  IoCutOutline,
  IoMagnetOutline,
  IoMicOutline,
  IoPauseOutline,
  IoPlayForwardOutline,
  IoPlayOutline,
  IoPlaySkipBackOutline,
  IoPlaySkipForwardOutline,
  IoRadioButtonOnOutline,
  IoRemoveCircleOutline,
  IoStopCircleOutline,
  IoVideocamOutline,
} from 'react-icons/io5';
import { OperationAvailability, OperationMode, RecordInsertMode } from '../../application/operations/operationStateMachine';

type ActionButtonProps = {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
  selected?: boolean;
};

const ActionButton: React.FC<ActionButtonProps> = ({
  icon,
  title,
  onClick,
  disabled,
  danger,
  active,
  selected,
}) => (
  <button
    type="button"
    className={`icon-btn ${danger ? 'danger' : ''} ${active ? 'active' : ''} ${selected ? 'selected' : ''}`}
    title={title}
    aria-label={title}
    onClick={onClick}
    disabled={disabled}
  >
    {icon}
  </button>
);

type OperationBarProps = {
  mode: OperationMode;
  isPlaying: boolean;
  isRecordingBusy: boolean;
  recordMode: RecordInsertMode;
  snapEnabled: boolean;
  timelineClock: string;
  availability: OperationAvailability;
  hideToolbar?: boolean;
  compactRecording?: boolean;
  onToggleRecord: () => void;
  onTogglePlayback: () => void;
  onSetRecordMode: (mode: RecordInsertMode) => void;
  onCutAtPlayhead: () => void;
  onDeleteFuture: () => void;
  onDeleteAndStitch: () => void;
  onToggleSnap: () => void;
};

export const OperationBar: React.FC<OperationBarProps> = ({
  mode,
  isPlaying,
  isRecordingBusy,
  recordMode,
  snapEnabled,
  timelineClock,
  availability,
  hideToolbar = false,
  compactRecording = false,
  onToggleRecord,
  onTogglePlayback,
  onSetRecordMode,
  onCutAtPlayhead,
  onDeleteFuture,
  onDeleteAndStitch,
  onToggleSnap,
}) => {
  const isRecording = mode === 'recording';
  const modeLabel = isRecording ? 'REC' : isPlaying ? 'PLAY' : 'READY';
  const shouldShowToolbar = !hideToolbar && !compactRecording;
  return (
    <div className="timeline-actionbar">
      {shouldShowToolbar ? (
        <div className="panel timeline-toolbar-strip">
          <div className={`timeline-mode-status ${isRecording ? 'recording' : isPlaying ? 'playing' : 'ready'}`}>
            <span className="timeline-mode-dot" />
            <strong>{modeLabel}</strong>
          </div>
          <div className="timeline-action-controls">
            <ActionButton
              icon={<IoCutOutline size={15} />}
              title="Cut At Playhead"
              onClick={onCutAtPlayhead}
              disabled={!availability.canCutAtPlayhead}
            />
            <ActionButton
              icon={<IoPlayForwardOutline size={15} />}
              title="Delete Future"
              onClick={onDeleteFuture}
              disabled={!availability.canDeleteFuture}
            />
            <ActionButton
              icon={<IoRemoveCircleOutline size={15} />}
              title="Delete And Stitch"
              onClick={onDeleteAndStitch}
              disabled={!availability.canDeleteAndStitch}
              danger
            />
            <ActionButton
              icon={<IoMagnetOutline size={15} />}
              title={snapEnabled ? 'Structure Snap: On' : 'Structure Snap: Off'}
              onClick={onToggleSnap}
              selected={snapEnabled}
              disabled={!availability.canToggleSnap}
            />
            <ActionButton
              icon={<IoAddCircleOutline size={15} />}
              title="New Recording"
              onClick={() => onSetRecordMode('append')}
              selected={recordMode === 'append'}
              disabled={!availability.canSwitchRecordMode || isRecordingBusy}
            />
            <ActionButton
              icon={<IoContractOutline size={15} />}
              title="Insert Recording"
              onClick={() => onSetRecordMode('insert')}
              selected={recordMode === 'insert'}
              disabled={!availability.canSwitchRecordMode || isRecordingBusy}
            />
          </div>
          <div className="timeline-toolbar-meta">
            <span className={`timeline-meta-chip ${snapEnabled ? 'selected' : ''}`}>SNAP</span>
            <span className="action-meta mono">{timelineClock}</span>
          </div>
        </div>
      ) : null}
      <div className={`panel timeline-transport-pill ${compactRecording ? 'recording-compact' : ''}`}>
        <div className="timeline-transport-group transport-playback">
          <ActionButton
            icon={<IoPlaySkipBackOutline size={16} />}
            title="Previous Marker"
            onClick={() => {}}
            disabled
          />
          <ActionButton
            icon={isPlaying ? <IoPauseOutline size={16} /> : <IoPlayOutline size={16} />}
            title={isPlaying ? 'Pause Preview' : 'Play Preview'}
            onClick={onTogglePlayback}
            disabled={!availability.canTogglePlay || isRecordingBusy}
          />
          <ActionButton
            icon={<IoPlaySkipForwardOutline size={16} />}
            title="Next Marker"
            onClick={() => {}}
            disabled
          />
        </div>
        {!compactRecording ? (
          <div className="timeline-record-mode">
            <button
              type="button"
              className={`timeline-mode-chip ${recordMode === 'append' ? 'selected' : ''}`}
              disabled={!availability.canSwitchRecordMode || isRecordingBusy}
              onClick={() => onSetRecordMode('append')}
            >
              NEW
            </button>
            <button
              type="button"
              className={`timeline-mode-chip ${recordMode === 'insert' ? 'selected' : ''}`}
              disabled={!availability.canSwitchRecordMode || isRecordingBusy}
              onClick={() => onSetRecordMode('insert')}
            >
              MIX
            </button>
          </div>
        ) : (
          <div className="timeline-record-live">
            <span className="timeline-live-dot" />
            <span className="mono">REC</span>
          </div>
        )}
        <ActionButton
          icon={<IoVideocamOutline size={16} />}
          title="Camera"
          onClick={() => {}}
          disabled
        />
        <button
          type="button"
          className={`timeline-record-button ${isRecording ? 'active' : ''}`}
          title={isRecording ? 'Stop Recording' : 'Start Recording'}
          aria-label={isRecording ? 'Stop Recording' : 'Start Recording'}
          onClick={onToggleRecord}
          disabled={!availability.canToggleRecord || isRecordingBusy}
        >
          {isRecording ? <IoStopCircleOutline size={22} /> : <IoRadioButtonOnOutline size={22} />}
        </button>
        <div className={`timeline-transport-status ${compactRecording ? 'compact' : ''}`}>
          <span className="mono">{timelineClock}</span>
        </div>
        <ActionButton
          icon={<IoMicOutline size={16} />}
          title="Microphone"
          onClick={() => {}}
          disabled
        />
      </div>
    </div>
  );
};
