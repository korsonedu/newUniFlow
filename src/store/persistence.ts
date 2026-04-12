import { useWhiteboardStore } from './useWhiteboardStore';
import { createSnapshot, saveSnapshotToStorage } from './snapshot';

let initialized = false;

export const installStorePersistence = (): void => {
  if (initialized) {
    return;
  }
  initialized = true;

  let timer: number | null = null;
  let lastEventsRef = useWhiteboardStore.getState().events;
  let lastAudioRef = useWhiteboardStore.getState().audioSegments;
  let lastRecordingStatus = useWhiteboardStore.getState().recordingStatus;

  useWhiteboardStore.subscribe((state) => {
    const eventsChanged = state.events !== lastEventsRef;
    const audioChanged = state.audioSegments !== lastAudioRef;
    const statusChanged = state.recordingStatus !== lastRecordingStatus;
    if (!eventsChanged && !audioChanged && !statusChanged) {
      return;
    }

    lastEventsRef = state.events;
    lastAudioRef = state.audioSegments;
    lastRecordingStatus = state.recordingStatus;

    if (timer !== null) {
      window.clearTimeout(timer);
    }

    timer = window.setTimeout(() => {
      const snapshot = createSnapshot(state.events, state.currentTime, state.audioSegments);
      saveSnapshotToStorage(snapshot);
      timer = null;
    }, 180);
  });
};
