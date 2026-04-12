import { detectRecordingSupport, RecordingSupportInfo } from '../../utils/audioRecorder';

export type AudioInputRequest = {
  channelCount?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
};

const DEFAULT_AUDIO_INPUT_REQUEST: Required<AudioInputRequest> = {
  channelCount: 1,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export const getRecordingSupportInfo = (): RecordingSupportInfo => {
  return detectRecordingSupport();
};

export const requestAudioInputStream = async (
  request: AudioInputRequest = {},
): Promise<MediaStream> => {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Audio input is not available in current runtime');
  }
  const merged: Required<AudioInputRequest> = {
    ...DEFAULT_AUDIO_INPUT_REQUEST,
    ...request,
  };
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: merged.channelCount,
      echoCancellation: merged.echoCancellation,
      noiseSuppression: merged.noiseSuppression,
      autoGainControl: merged.autoGainControl,
    },
  });
};

export const stopMediaStreamTracks = (stream: MediaStream | null | undefined): void => {
  if (!stream) {
    return;
  }
  stream.getTracks().forEach((track) => track.stop());
};

