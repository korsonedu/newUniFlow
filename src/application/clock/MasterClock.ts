import { normalizeTimelineTime } from '../../domain/time';
import { platformNowMs } from '../../infrastructure/platform/frameScheduler';

export type ReplayDriver = {
  play: () => void;
  pause: () => void;
  seek: (time: number) => void;
  isPlaying: () => boolean;
};

export type AudioDriver = {
  unlock: () => Promise<void>;
  prepare: (time: number, windowMs?: number) => Promise<void>;
  play: () => void;
  sync: (time: number, shouldPlay: boolean) => void;
  getClockNowMs: () => number;
};

export type MasterClockDeps = {
  getReplay: () => ReplayDriver | null;
  getAudio: () => AudioDriver | null;
  getCurrentTime: () => number;
  getMaxTime: () => number;
  syncAt: (time: number, shouldPlay: boolean) => void;
  setPlaying: (playing: boolean) => void;
};

type MasterClockOptions = {
  nowMs?: () => number;
};

const PLAYBACK_PREPARE_WINDOW_MS = 12_000;

export class MasterClock {
  private deps: MasterClockDeps | null = null;
  private readonly getWallNowMs: () => number;
  private playAnchorTimelineMs: number | null = null;
  private playAnchorAudioClockMs: number | null = null;
  private lastDriftCorrectionWallMs = 0;

  private static readonly DRIFT_CORRECTION_THRESHOLD_MS = 70;
  private static readonly DRIFT_CORRECTION_MIN_INTERVAL_MS = 250;

  constructor(options?: MasterClockOptions) {
    this.getWallNowMs = options?.nowMs ?? platformNowMs;
  }

  configure(deps: MasterClockDeps): void {
    this.deps = deps;
  }

  nowMs(): number {
    const audio = this.deps?.getAudio();
    if (!audio) {
      return this.getWallNowMs();
    }
    return audio.getClockNowMs();
  }

  isPlaying(): boolean {
    const replay = this.deps?.getReplay();
    return replay?.isPlaying() ?? false;
  }

  async playPreview(): Promise<void> {
    const deps = this.deps;
    if (!deps) {
      return;
    }
    const replay = deps.getReplay();
    if (!replay) {
      return;
    }
    const audio = deps.getAudio();
    const currentTime = normalizeTimelineTime(deps.getCurrentTime());
    const maxTime = normalizeTimelineTime(deps.getMaxTime());

    if (audio) {
      await audio.unlock();
      await audio.prepare(currentTime, PLAYBACK_PREPARE_WINDOW_MS);
    }

    if (currentTime >= Math.max(0, maxTime - 1)) {
      replay.seek(0);
      deps.syncAt(0, false);
      if (audio) {
        await audio.prepare(0, PLAYBACK_PREPARE_WINDOW_MS);
      }
    }

    audio?.play();
    replay.play();
    const syncedTime = normalizeTimelineTime(deps.getCurrentTime());
    deps.syncAt(syncedTime, true);
    this.resetDriftCorrectionWindow();
    this.resetPlayAnchor(syncedTime);
    deps.setPlaying(true);
  }

  pausePreview(): void {
    const deps = this.deps;
    if (!deps) {
      return;
    }
    const replay = deps.getReplay();
    replay?.pause();
    deps.syncAt(normalizeTimelineTime(deps.getCurrentTime()), false);
    this.clearPlayAnchor();
    this.resetDriftCorrectionWindow();
    deps.setPlaying(false);
  }

  seek(time: number): void {
    const deps = this.deps;
    if (!deps) {
      return;
    }
    const t = normalizeTimelineTime(time);
    const replay = deps.getReplay();
    if (!replay) {
      return;
    }
    replay.seek(t);
    void this.deps?.getAudio()?.prepare(t, PLAYBACK_PREPARE_WINDOW_MS);
    deps.syncAt(t, replay.isPlaying());
    if (replay.isPlaying()) {
      this.resetDriftCorrectionWindow();
      this.resetPlayAnchor(t);
    } else {
      this.clearPlayAnchor();
      this.resetDriftCorrectionWindow();
    }
    if (!replay.isPlaying()) {
      deps.setPlaying(false);
    }
  }

  stabilizePlaybackDrift(): void {
    const deps = this.deps;
    if (!deps) {
      return;
    }
    const replay = deps.getReplay();
    const audio = deps.getAudio();
    if (!replay?.isPlaying() || !audio) {
      return;
    }
    if (this.playAnchorTimelineMs === null || this.playAnchorAudioClockMs === null) {
      this.resetPlayAnchor(normalizeTimelineTime(deps.getCurrentTime()));
      return;
    }

    const nowWall = this.getWallNowMs();
    if (nowWall - this.lastDriftCorrectionWallMs < MasterClock.DRIFT_CORRECTION_MIN_INTERVAL_MS) {
      return;
    }

    const audioNow = audio.getClockNowMs();
    const estimatedTimeline = normalizeTimelineTime(
      this.playAnchorTimelineMs + (audioNow - this.playAnchorAudioClockMs),
    );
    const currentTimeline = normalizeTimelineTime(deps.getCurrentTime());
    const drift = Math.abs(currentTimeline - estimatedTimeline);
    if (drift < MasterClock.DRIFT_CORRECTION_THRESHOLD_MS) {
      return;
    }

    void audio.prepare(currentTimeline, PLAYBACK_PREPARE_WINDOW_MS);
    deps.syncAt(currentTimeline, true);
    this.lastDriftCorrectionWallMs = nowWall;
    this.resetPlayAnchor(currentTimeline);
  }

  private resetPlayAnchor(timelineMs: number): void {
    const audio = this.deps?.getAudio();
    if (!audio) {
      this.clearPlayAnchor();
      return;
    }
    this.playAnchorTimelineMs = normalizeTimelineTime(timelineMs);
    this.playAnchorAudioClockMs = audio.getClockNowMs();
  }

  private clearPlayAnchor(): void {
    this.playAnchorTimelineMs = null;
    this.playAnchorAudioClockMs = null;
  }

  private resetDriftCorrectionWindow(): void {
    this.lastDriftCorrectionWallMs = 0;
  }
}
