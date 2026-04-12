import React from 'react';
import {
  IoAddCircleOutline,
  IoContractOutline,
  IoCutOutline,
  IoMagnetOutline,
  IoPauseOutline,
  IoPlayForwardOutline,
  IoPlayOutline,
  IoRadioButtonOnOutline,
  IoRemoveCircleOutline,
  IoStopCircleOutline,
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
  onToggleRecord,
  onTogglePlayback,
  onSetRecordMode,
  onCutAtPlayhead,
  onDeleteFuture,
  onDeleteAndStitch,
  onToggleSnap,
}) => {
  const isRecording = mode === 'recording';
  return (
    <div className="panel timeline-actionbar">
      <div className="timeline-action-controls">
        <ActionButton
          icon={isRecording ? <IoStopCircleOutline size={15} /> : <IoRadioButtonOnOutline size={15} />}
          title={isRecording ? 'Stop Recording' : 'Start Recording'}
          onClick={onToggleRecord}
          active={isRecording}
          danger
          disabled={!availability.canToggleRecord || isRecordingBusy}
        />
        <ActionButton
          icon={isPlaying ? <IoPauseOutline size={15} /> : <IoPlayOutline size={15} />}
          title={isPlaying ? 'Pause Preview' : 'Play Preview'}
          onClick={onTogglePlayback}
          disabled={!availability.canTogglePlay || isRecordingBusy}
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
      </div>
      <span className="action-meta mono">{timelineClock}</span>
    </div>
  );
};
