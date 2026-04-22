import { useWhiteboardStore } from './useWhiteboardStore';
import { createSnapshot, saveSnapshotToStorage } from './snapshot';
import { subscribeAppLifecycle } from '../infrastructure/platform/appLifecycle';
import {
  platformClearTimeout,
  platformSetTimeout,
  PlatformTimerHandle,
} from '../infrastructure/platform/timer';

let initialized = false;

export const installStorePersistence = (): void => {
  if (initialized) {
    return;
  }
  initialized = true;

  let timer: PlatformTimerHandle | null = null;
  let latestState = useWhiteboardStore.getState();
  let lastEventsRef = useWhiteboardStore.getState().events;
  let lastAudioRef = useWhiteboardStore.getState().audioSegments;
  let lastRecordingStatus = useWhiteboardStore.getState().recordingStatus;

  const flushSnapshot = () => {
    const snapshot = createSnapshot(
      latestState.events,
      latestState.currentTime,
      latestState.audioSegments,
    );
    saveSnapshotToStorage(snapshot);
  };

  useWhiteboardStore.subscribe((state) => {
    latestState = state;
    const eventsChanged = state.events !== lastEventsRef;
    const audioChanged = state.audioSegments !== lastAudioRef;
    const statusChanged = state.recordingStatus !== lastRecordingStatus;
    if (!eventsChanged && !audioChanged && !statusChanged) {
      return;
    }

    lastEventsRef = state.events;
    lastAudioRef = state.audioSegments;
    lastRecordingStatus = state.recordingStatus;

    platformClearTimeout(timer);

    timer = platformSetTimeout(() => {
      flushSnapshot();
      timer = null;
    }, 180);
  });

  subscribeAppLifecycle((event) => {
    if (
      event === 'background'
      || event === 'blur'
      || event === 'pagehide'
      || event === 'beforeunload'
    ) {
      platformClearTimeout(timer);
      timer = null;
      flushSnapshot();
    }
  });
};
