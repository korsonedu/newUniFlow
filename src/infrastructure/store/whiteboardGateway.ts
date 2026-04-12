import { TimelineEvent, TimelineEventDraft, TimelineEventOfType, TimelineEventType } from '../../domain/types';
import { useWhiteboardStore } from '../../store/useWhiteboardStore';

export const whiteboardGateway = {
  getCurrentPageId(): string {
    return useWhiteboardStore.getState().state.currentPageId;
  },
  getCurrentTime(): number {
    return useWhiteboardStore.getState().currentTime;
  },
  createTimelineEvent<T extends TimelineEventType>(
    event: TimelineEventDraft<T> & { time?: number },
  ): TimelineEventOfType<T> {
    return useWhiteboardStore.getState().createTimelineEvent(event);
  },
  dispatchEvent(event: TimelineEvent): void {
    useWhiteboardStore.getState().dispatchEvent(event);
  },
};

