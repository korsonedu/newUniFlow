import { RecordingStatus } from '../../domain/types';

export type OperationMode = 'idle' | 'recording' | 'playing' | 'editing' | 'exporting';
export type RecordInsertMode = 'append' | 'insert';

export type ResolveOperationModeInput = {
  recordingStatus: RecordingStatus;
  isPlaying: boolean;
  isExporting: boolean;
  hasTimelineSelection: boolean;
};

export const resolveOperationMode = (input: ResolveOperationModeInput): OperationMode => {
  if (input.isExporting) {
    return 'exporting';
  }
  if (input.recordingStatus === 'recording') {
    return 'recording';
  }
  if (input.isPlaying) {
    return 'playing';
  }
  if (input.recordingStatus === 'paused' || input.hasTimelineSelection) {
    return 'editing';
  }
  return 'idle';
};

export type OperationAvailability = {
  canToggleRecord: boolean;
  canTogglePlay: boolean;
  canSwitchRecordMode: boolean;
  canCutAtPlayhead: boolean;
  canDeleteFuture: boolean;
  canDeleteAndStitch: boolean;
  canToggleSnap: boolean;
};

export const deriveOperationAvailability = (params: {
  mode: OperationMode;
  hasRange: boolean;
  canCutAtPlayhead: boolean;
}): OperationAvailability => {
  const editable = params.mode === 'idle' || params.mode === 'editing';
  return {
    canToggleRecord: params.mode !== 'exporting',
    canTogglePlay: params.mode === 'idle' || params.mode === 'playing' || params.mode === 'editing',
    canSwitchRecordMode: editable,
    canCutAtPlayhead: editable && params.canCutAtPlayhead,
    canDeleteFuture: editable,
    canDeleteAndStitch: editable && params.hasRange,
    canToggleSnap: editable,
  };
};

