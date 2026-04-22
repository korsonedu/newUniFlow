import {
  TimelineEvent,
  TimelineEventDraft,
  TimelineEventOfType,
  TimelineEventType,
  TimelineSegment,
} from '../../domain/types';
import {
  getEventEndTime,
  deleteEvent as deleteEventById,
  deleteTimeRange,
  getTimelineMaxTime,
  insertEvent,
  insertTimeGap,
  moveEvent,
  rippleDeleteTimeRange,
} from '../../engine/timelineEngine';
import {
  getTimelineDuration,
  isTimelineTimeWithinInclusive,
  normalizeTimelineRange,
  normalizeTimelineTime,
} from '../../domain/time';
import {
  deleteRangeFromAudioSegments,
  insertGapIntoAudioSegments,
  rippleDeleteAudioSegments,
  splitTimelineSegment,
} from '../../domain/timelineSegments';
import { AudioSegment } from '../../domain/types';
import {
  NativeTimelineAdapter,
  nativeTimelineAdapter,
} from '../../infrastructure/platform/nativeTimeline';

export type TimelineTransactionKind =
  | 'insert_event'
  | 'delete_event'
  | 'delete_range'
  | 'ripple_delete_range'
  | 'split_at'
  | 'delete_future'
  | 'move_event_time'
  | 'insert_gap';

export type TimelineTransaction = {
  id: string;
  kind: TimelineTransactionKind;
  createdAt: number;
  params: Record<string, number | string | boolean | null | undefined>;
};

export type TimelineCommand =
  | { kind: 'insert_event'; event: TimelineEvent }
  | { kind: 'delete_event'; eventId: string }
  | { kind: 'delete_range'; start: number; end: number }
  | { kind: 'ripple_delete_range'; start: number; end: number }
  | { kind: 'split_at'; time: number; selectedSegmentId?: string }
  | { kind: 'delete_future'; time: number }
  | { kind: 'move_event_time'; eventId: string; newTime: number }
  | { kind: 'insert_gap'; start: number; duration: number; eventIds?: string[]; audioIds?: string[] };

type TimelineCommandContext = {
  currentTime: number;
  currentPageId: string;
  events: TimelineEvent[];
  audioSegments: AudioSegment[];
  timelineSegments: TimelineSegment[];
  createEvent: <T extends TimelineEventType>(
    event: TimelineEventDraft<T> & { time?: number },
  ) => TimelineEventOfType<T>;
};

export type TimelineCommandResult = {
  applied: boolean;
  events: TimelineEvent[];
  audioSegments: AudioSegment[];
  currentTime: number;
};

type TimelineCommandAsyncDeps = {
  adapter?: NativeTimelineAdapter;
};

const getAudioMaxTime = (audioSegments: AudioSegment[]): number => {
  if (audioSegments.length === 0) {
    return 0;
  }
  return Math.max(...audioSegments.map((segment) => normalizeTimelineTime(segment.endTime)));
};

const hasArrayIdentityChange = <T>(a: T[], b: T[]): boolean => {
  if (a.length !== b.length) {
    return true;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return true;
    }
  }
  return false;
};

const unchangedResult = (
  events: TimelineEvent[],
  audioSegments: AudioSegment[],
  currentTime: number,
): TimelineCommandResult => ({
  applied: false,
  events,
  audioSegments,
  currentTime: normalizeTimelineTime(currentTime),
});

export const executeTimelineCommand = (
  context: TimelineCommandContext,
  command: TimelineCommand,
): TimelineCommandResult => {
  switch (command.kind) {
    case 'insert_event': {
      const nextEvents = insertEvent(context.events, command.event);
      const nextTime = Math.max(
        normalizeTimelineTime(context.currentTime),
        normalizeTimelineTime(getEventEndTime(command.event)),
      );
      const applied = hasArrayIdentityChange(context.events, nextEvents)
        || nextTime !== normalizeTimelineTime(context.currentTime);
      if (!applied) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }
      return {
        applied: true,
        events: nextEvents,
        audioSegments: context.audioSegments,
        currentTime: nextTime,
      };
    }

    case 'delete_event': {
      const nextEvents = deleteEventById(context.events, command.eventId);
      const applied = hasArrayIdentityChange(context.events, nextEvents);
      if (!applied) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }
      return {
        applied: true,
        events: nextEvents,
        audioSegments: context.audioSegments,
        currentTime: normalizeTimelineTime(context.currentTime),
      };
    }

    case 'delete_range': {
      const range = normalizeTimelineRange(command.start, command.end);
      const nextTime = isTimelineTimeWithinInclusive(context.currentTime, range.start, range.end)
        ? range.start
        : context.currentTime;
      const nextEvents = deleteTimeRange(context.events, range.start, range.end);
      const nextAudio = deleteRangeFromAudioSegments(context.audioSegments, range.start, range.end);
      const applied = hasArrayIdentityChange(context.events, nextEvents)
        || hasArrayIdentityChange(context.audioSegments, nextAudio)
        || normalizeTimelineTime(nextTime) !== normalizeTimelineTime(context.currentTime);
      return {
        applied,
        events: nextEvents,
        audioSegments: nextAudio,
        currentTime: normalizeTimelineTime(nextTime),
      };
    }

    case 'ripple_delete_range': {
      const range = normalizeTimelineRange(command.start, command.end);
      const duration = getTimelineDuration(range.start, range.end);
      if (duration <= 0) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }

      let nextTime = context.currentTime;
      if (nextTime > range.end) {
        nextTime = Math.max(0, nextTime - duration);
      } else if (isTimelineTimeWithinInclusive(nextTime, range.start, range.end)) {
        nextTime = range.start;
      }

      const nextEvents = rippleDeleteTimeRange(context.events, range.start, range.end);
      const nextAudio = rippleDeleteAudioSegments(context.audioSegments, range.start, range.end);
      const applied = hasArrayIdentityChange(context.events, nextEvents)
        || hasArrayIdentityChange(context.audioSegments, nextAudio)
        || normalizeTimelineTime(nextTime) !== normalizeTimelineTime(context.currentTime);
      return {
        applied,
        events: nextEvents,
        audioSegments: nextAudio,
        currentTime: normalizeTimelineTime(nextTime),
      };
    }

    case 'split_at': {
      const splitTime = normalizeTimelineTime(command.time);
      const selectedSegment = command.selectedSegmentId
        ? context.timelineSegments.find((segment) => segment.id === command.selectedSegmentId)
        : undefined;
      const selectedContainsTime = selectedSegment
        ? splitTime > selectedSegment.startTime && splitTime < selectedSegment.endTime
        : false;
      const targetSegment = selectedContainsTime
        ? selectedSegment
        : context.timelineSegments.find(
          (segment) => splitTime > segment.startTime && splitTime < segment.endTime,
        );
      if (!targetSegment) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }
      if (!splitTimelineSegment(context.timelineSegments, targetSegment.id, splitTime)) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }

      const splitEvent = context.createEvent({
        pageId: targetSegment.pageId ?? context.currentPageId,
        type: TimelineEventType.PAGE_SET,
        targetId: targetSegment.pageId,
        payload: { pageId: targetSegment.pageId },
        time: splitTime,
      });
      return {
        applied: true,
        events: insertEvent(context.events, splitEvent),
        audioSegments: context.audioSegments,
        currentTime: Math.max(normalizeTimelineTime(context.currentTime), splitTime),
      };
    }

    case 'delete_future': {
      const at = normalizeTimelineTime(command.time);
      const maxTime = Math.max(getTimelineMaxTime(context.events), getAudioMaxTime(context.audioSegments));
      if (at >= maxTime) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }
      const nextEvents = deleteTimeRange(context.events, at, maxTime);
      const nextAudio = deleteRangeFromAudioSegments(context.audioSegments, at, maxTime);
      return {
        applied: true,
        events: nextEvents,
        audioSegments: nextAudio,
        currentTime: Math.min(normalizeTimelineTime(context.currentTime), at),
      };
    }

    case 'move_event_time': {
      const nextEvents = moveEvent(context.events, command.eventId, command.newTime);
      const applied = hasArrayIdentityChange(context.events, nextEvents);
      if (!applied) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }
      return {
        applied: true,
        events: nextEvents,
        audioSegments: context.audioSegments,
        currentTime: normalizeTimelineTime(context.currentTime),
      };
    }

    case 'insert_gap': {
      const safeDuration = Math.max(0, Math.trunc(command.duration));
      if (safeDuration <= 0) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }

      const nextEvents = insertTimeGap(
        context.events,
        command.start,
        safeDuration,
        command.eventIds,
      );
      const nextAudio = insertGapIntoAudioSegments(
        context.audioSegments,
        command.start,
        safeDuration,
        command.audioIds,
      );
      const applied = hasArrayIdentityChange(context.events, nextEvents)
        || hasArrayIdentityChange(context.audioSegments, nextAudio);
      if (!applied) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }
      return {
        applied: true,
        events: nextEvents,
        audioSegments: nextAudio,
        currentTime: normalizeTimelineTime(context.currentTime),
      };
    }

    default:
      return unchangedResult(context.events, context.audioSegments, context.currentTime);
  }
};

export const executeTimelineCommandAsync = async (
  context: TimelineCommandContext,
  command: TimelineCommand,
  deps: TimelineCommandAsyncDeps = {},
): Promise<TimelineCommandResult> => {
  const adapter = deps.adapter ?? nativeTimelineAdapter;
  switch (command.kind) {
    case 'insert_event': {
      const nextEvents = await adapter.insertEvent(context.events, command.event);
      const nextTime = Math.max(
        normalizeTimelineTime(context.currentTime),
        normalizeTimelineTime(getEventEndTime(command.event)),
      );
      const applied = hasArrayIdentityChange(context.events, nextEvents)
        || nextTime !== normalizeTimelineTime(context.currentTime);
      if (!applied) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }
      return {
        applied: true,
        events: nextEvents,
        audioSegments: context.audioSegments,
        currentTime: nextTime,
      };
    }

    case 'delete_event': {
      const nextEvents = await adapter.deleteEvent(context.events, command.eventId);
      const applied = hasArrayIdentityChange(context.events, nextEvents);
      if (!applied) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }
      return {
        applied: true,
        events: nextEvents,
        audioSegments: context.audioSegments,
        currentTime: normalizeTimelineTime(context.currentTime),
      };
    }

    case 'delete_range': {
      const range = normalizeTimelineRange(command.start, command.end);
      const nextTime = isTimelineTimeWithinInclusive(context.currentTime, range.start, range.end)
        ? range.start
        : context.currentTime;
      const nextEvents = await adapter.deleteTimeRange(
        context.events,
        range.start,
        range.end,
      );
      const nextAudio = deleteRangeFromAudioSegments(context.audioSegments, range.start, range.end);
      const applied = hasArrayIdentityChange(context.events, nextEvents)
        || hasArrayIdentityChange(context.audioSegments, nextAudio)
        || normalizeTimelineTime(nextTime) !== normalizeTimelineTime(context.currentTime);
      return {
        applied,
        events: nextEvents,
        audioSegments: nextAudio,
        currentTime: normalizeTimelineTime(nextTime),
      };
    }

    case 'ripple_delete_range': {
      const range = normalizeTimelineRange(command.start, command.end);
      const duration = getTimelineDuration(range.start, range.end);
      if (duration <= 0) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }

      let nextTime = context.currentTime;
      if (nextTime > range.end) {
        nextTime = Math.max(0, nextTime - duration);
      } else if (isTimelineTimeWithinInclusive(nextTime, range.start, range.end)) {
        nextTime = range.start;
      }

      const nextEvents = await adapter.rippleDeleteTimeRange(
        context.events,
        range.start,
        range.end,
      );
      const nextAudio = rippleDeleteAudioSegments(context.audioSegments, range.start, range.end);
      const applied = hasArrayIdentityChange(context.events, nextEvents)
        || hasArrayIdentityChange(context.audioSegments, nextAudio)
        || normalizeTimelineTime(nextTime) !== normalizeTimelineTime(context.currentTime);
      return {
        applied,
        events: nextEvents,
        audioSegments: nextAudio,
        currentTime: normalizeTimelineTime(nextTime),
      };
    }

    case 'split_at': {
      const splitTime = normalizeTimelineTime(command.time);
      const selectedSegment = command.selectedSegmentId
        ? context.timelineSegments.find((segment) => segment.id === command.selectedSegmentId)
        : undefined;
      const selectedContainsTime = selectedSegment
        ? splitTime > selectedSegment.startTime && splitTime < selectedSegment.endTime
        : false;
      const targetSegment = selectedContainsTime
        ? selectedSegment
        : context.timelineSegments.find(
          (segment) => splitTime > segment.startTime && splitTime < segment.endTime,
        );
      if (!targetSegment) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }
      if (!splitTimelineSegment(context.timelineSegments, targetSegment.id, splitTime)) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }

      // Keep transaction split validation on native adapter path to ensure
      // timeline structural command routing stays aligned with native core.
      await adapter.splitTimeline(context.events, splitTime);
      const splitEvent = context.createEvent({
        pageId: targetSegment.pageId ?? context.currentPageId,
        type: TimelineEventType.PAGE_SET,
        targetId: targetSegment.pageId,
        payload: { pageId: targetSegment.pageId },
        time: splitTime,
      });
      const nextEvents = await adapter.insertEvent(context.events, splitEvent);
      return {
        applied: hasArrayIdentityChange(context.events, nextEvents),
        events: nextEvents,
        audioSegments: context.audioSegments,
        currentTime: Math.max(normalizeTimelineTime(context.currentTime), splitTime),
      };
    }

    case 'delete_future': {
      const at = normalizeTimelineTime(command.time);
      const maxTime = Math.max(
        await adapter.getTimelineMaxTime(context.events),
        getAudioMaxTime(context.audioSegments),
      );
      if (at >= maxTime) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }
      const nextEvents = await adapter.deleteTimeRange(context.events, at, maxTime);
      const nextAudio = deleteRangeFromAudioSegments(context.audioSegments, at, maxTime);
      return {
        applied: true,
        events: nextEvents,
        audioSegments: nextAudio,
        currentTime: Math.min(normalizeTimelineTime(context.currentTime), at),
      };
    }

    case 'move_event_time': {
      const nextEvents = await adapter.moveEvent(
        context.events,
        command.eventId,
        command.newTime,
      );
      const applied = hasArrayIdentityChange(context.events, nextEvents);
      if (!applied) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }
      return {
        applied: true,
        events: nextEvents,
        audioSegments: context.audioSegments,
        currentTime: normalizeTimelineTime(context.currentTime),
      };
    }

    case 'insert_gap': {
      const safeDuration = Math.max(0, Math.trunc(command.duration));
      if (safeDuration <= 0) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }

      const nextEvents = await adapter.insertTimeGap(
        context.events,
        command.start,
        safeDuration,
        command.eventIds,
      );
      const nextAudio = insertGapIntoAudioSegments(
        context.audioSegments,
        command.start,
        safeDuration,
        command.audioIds,
      );
      const applied = hasArrayIdentityChange(context.events, nextEvents)
        || hasArrayIdentityChange(context.audioSegments, nextAudio);
      if (!applied) {
        return unchangedResult(context.events, context.audioSegments, context.currentTime);
      }
      return {
        applied: true,
        events: nextEvents,
        audioSegments: nextAudio,
        currentTime: normalizeTimelineTime(context.currentTime),
      };
    }

    default:
      return executeTimelineCommand(context, command);
  }
};
