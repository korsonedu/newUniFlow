import { AudioSegment } from '../domain/types';
import { normalizeTimelineTime } from '../domain/time';
import { createAudioContext } from '../infrastructure/platform/audioContext';

type ActivePlayback = {
  source: AudioBufferSourceNode;
  startedAtContext: number;
  startedOffset: number;
};

const DRIFT_RESTART_THRESHOLD_SEC = 0.2;

export class AudioPlaybackEngine {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private segments: AudioSegment[] = [];
  private playing = false;
  private unlocked = false;

  // Cache by source URL so split/trim segments reuse one decoded buffer.
  private readonly bufferCache = new Map<string, AudioBuffer>();
  private readonly loadingCache = new Map<string, Promise<AudioBuffer | null>>();
  private readonly activePlaybacks = new Map<string, ActivePlayback>();

  setSegments(segments: AudioSegment[]): void {
    this.segments = segments
      .filter((segment) => !!segment.sourceUrl && !segment.muted)
      .map((segment) => ({ ...segment }));

    const validIds = new Set(this.segments.map((segment) => segment.id));
    for (const id of [...this.activePlaybacks.keys()]) {
      if (!validIds.has(id)) {
        this.stopSegment(id);
      }
    }

    for (const segment of this.segments) {
      void this.ensureBuffer(segment);
    }
  }

  async prepare(time: number, windowMs = 5000): Promise<void> {
    const safeTime = normalizeTimelineTime(time);
    const endTime = safeTime + Math.max(0, Math.trunc(windowMs));
    const candidates = this.segments.filter((segment) => {
      if (!segment.sourceUrl || segment.muted) {
        return false;
      }
      return segment.endTime >= safeTime && segment.startTime <= endTime;
    });
    if (candidates.length === 0) {
      return;
    }
    await Promise.allSettled(candidates.map((segment) => this.ensureBuffer(segment)));
  }

  async unlock(): Promise<void> {
    const context = this.ensureContext();
    if (!context) {
      return;
    }

    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch {
        // ignore
      }
    }

    if (this.unlocked) {
      return;
    }

    try {
      const source = context.createBufferSource();
      const gain = context.createGain();
      const buffer = context.createBuffer(1, 1, context.sampleRate);
      source.buffer = buffer;
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(this.masterGain ?? context.destination);
      source.start();
      source.stop(context.currentTime + 0.001);
    } catch {
      // ignore unlock errors
    }

    this.unlocked = true;
  }

  play(): void {
    this.playing = true;
    const context = this.ensureContext();
    if (context && context.state === 'suspended') {
      void context.resume();
    }
  }

  getClockNowMs(): number {
    if (!this.context) {
      return performance.now();
    }
    return this.context.currentTime * 1000;
  }

  pause(): void {
    this.playing = false;
    this.stopAll();
  }

  sync(time: number, shouldPlay: boolean): void {
    if (!shouldPlay) {
      if (this.playing || this.activePlaybacks.size > 0) {
        this.pause();
      }
      return;
    }

    const context = this.ensureContext();
    if (!context) {
      return;
    }
    if (context.state === 'suspended') {
      void context.resume();
    }

    if (!this.playing) {
      this.play();
    }

    const safeTime = normalizeTimelineTime(time);
    const compensatedTimeSec = safeTime / 1000;
    const shouldBeActive = new Set<string>();

    for (const segment of this.segments) {
      if (safeTime < segment.startTime || safeTime >= segment.endTime) {
        continue;
      }
      if (!segment.sourceUrl || segment.muted) {
        continue;
      }

      shouldBeActive.add(segment.id);
      const buffer = this.getBufferForSegment(segment);
      if (!buffer) {
        void this.ensureBuffer(segment);
        this.stopSegment(segment.id);
        continue;
      }

      const sourceOffsetSec = normalizeTimelineTime(segment.sourceOffsetMs ?? 0) / 1000;
      const sourceDurationSec = this.getSourceDurationSec(segment, buffer, sourceOffsetSec);
      const desiredOffsetSec = Math.max(
        0,
        sourceOffsetSec + (compensatedTimeSec - (segment.startTime / 1000)),
      );
      const sourceSliceEndSec = sourceOffsetSec + sourceDurationSec;
      if (desiredOffsetSec >= Math.max(0.001, sourceSliceEndSec - 0.002)) {
        this.stopSegment(segment.id);
        continue;
      }

      const active = this.activePlaybacks.get(segment.id);
      if (!active) {
        this.startSegment(
          segment.id,
          buffer,
          desiredOffsetSec,
          sourceSliceEndSec,
        );
        continue;
      }

      const elapsedSec = Math.max(0, context.currentTime - active.startedAtContext);
      const estimatedOffset = active.startedOffset + elapsedSec;
      if (Math.abs(estimatedOffset - desiredOffsetSec) > DRIFT_RESTART_THRESHOLD_SEC) {
        this.startSegment(
          segment.id,
          buffer,
          desiredOffsetSec,
          sourceSliceEndSec,
        );
      }
    }

    for (const id of [...this.activePlaybacks.keys()]) {
      if (!shouldBeActive.has(id)) {
        this.stopSegment(id);
      }
    }
  }

  async dispose(): Promise<void> {
    this.pause();
    this.bufferCache.clear();
    this.loadingCache.clear();
    this.segments = [];

    const context = this.context;
    this.context = null;
    this.masterGain = null;
    this.unlocked = false;
    if (!context) {
      return;
    }

    try {
      await context.close();
    } catch {
      // ignore close errors
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.context) {
      return this.context;
    }
    const context = createAudioContext();
    if (!context) {
      return null;
    }
    const gain = context.createGain();
    gain.gain.value = 1;
    gain.connect(context.destination);

    this.context = context;
    this.masterGain = gain;
    return context;
  }

  private stopAll(): void {
    for (const id of [...this.activePlaybacks.keys()]) {
      this.stopSegment(id);
    }
  }

  private stopSegment(segmentId: string): void {
    const active = this.activePlaybacks.get(segmentId);
    if (!active) {
      return;
    }
    try {
      active.source.onended = null;
      active.source.stop();
    } catch {
      // ignore stop races
    }
    try {
      active.source.disconnect();
    } catch {
      // ignore disconnect races
    }
    this.activePlaybacks.delete(segmentId);
  }

  private startSegment(
    segmentId: string,
    buffer: AudioBuffer,
    offsetSec: number,
    sourceSliceEndSec: number,
  ): void {
    const context = this.ensureContext();
    if (!context || !this.masterGain) {
      return;
    }

    this.stopSegment(segmentId);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.masterGain);
    source.onended = () => {
      const latest = this.activePlaybacks.get(segmentId);
      if (latest?.source === source) {
        this.activePlaybacks.delete(segmentId);
      }
    };

    try {
      const when = context.currentTime;
      const startOffset = Math.max(0, offsetSec);
      const remainingSourceSec = Math.max(0.001, sourceSliceEndSec - startOffset);
      source.start(when, startOffset, remainingSourceSec);
      this.activePlaybacks.set(segmentId, {
        source,
        startedAtContext: when,
        startedOffset: startOffset,
      });
    } catch {
      try {
        source.disconnect();
      } catch {
        // ignore
      }
    }
  }

  private async ensureBuffer(segment: AudioSegment): Promise<AudioBuffer | null> {
    const sourceUrl = segment.sourceUrl;
    if (!sourceUrl) {
      return null;
    }

    if (this.bufferCache.has(sourceUrl)) {
      return this.bufferCache.get(sourceUrl) ?? null;
    }
    const existing = this.loadingCache.get(sourceUrl);
    if (existing) {
      return existing;
    }

    const task = (async () => {
      const context = this.ensureContext();
      if (!context) {
        return null;
      }

      try {
        const response = await fetch(sourceUrl);
        const data = await response.arrayBuffer();
        const decoded = await context.decodeAudioData(data.slice(0));
        this.bufferCache.set(sourceUrl, decoded);
        return decoded;
      } catch {
        return null;
      } finally {
        this.loadingCache.delete(sourceUrl);
      }
    })();

    this.loadingCache.set(sourceUrl, task);
    return task;
  }

  private getBufferForSegment(segment: AudioSegment): AudioBuffer | null {
    const sourceUrl = segment.sourceUrl;
    if (!sourceUrl) {
      return null;
    }
    return this.bufferCache.get(sourceUrl) ?? null;
  }

  private getSourceDurationSec(
    segment: AudioSegment,
    buffer: AudioBuffer,
    sourceOffsetSec: number,
  ): number {
    const timelineDurationSec = Math.max(0.001, (segment.endTime - segment.startTime) / 1000);
    const sourceDurationMs = normalizeTimelineTime(segment.sourceDurationMs ?? 0);
    const maxFromBuffer = Math.max(0.001, buffer.duration - sourceOffsetSec);
    if (sourceDurationMs > 0) {
      return Math.max(0.001, Math.min(sourceDurationMs / 1000, maxFromBuffer));
    }

    // Legacy segments before sourceDurationMs existed:
    // use decoded source duration for original whole-clips, keep timeline duration for edited shards.
    const isDerivedShard = segment.id.includes('-head') || segment.id.includes('-tail');
    if (!isDerivedShard && sourceOffsetSec <= 0.001) {
      return maxFromBuffer;
    }

    return Math.max(0.001, Math.min(timelineDurationSec, maxFromBuffer));
  }
}
