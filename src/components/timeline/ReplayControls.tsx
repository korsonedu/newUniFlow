import React from 'react';
import {
  IoPauseOutline,
  IoPlayOutline,
  IoPlaySkipForwardOutline,
} from 'react-icons/io5';
import { normalizeTimelineTime } from '../../domain/time';

type ReplayControlsProps = {
  currentTime: number;
  maxTime: number;
  isPlaying: boolean;
  disabled?: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStep: () => void;
  onSeek: (time: number) => void;
};

export const ReplayControls: React.FC<ReplayControlsProps> = ({
  currentTime,
  maxTime,
  isPlaying,
  disabled,
  onPlay,
  onPause,
  onStep,
  onSeek,
}) => {
  const safeMax = Math.max(1, maxTime);

  return (
    <div className="panel replay-controls">
      <button
        type="button"
        className="icon-btn"
        title="Play"
        aria-label="Play"
        onClick={onPlay}
        disabled={isPlaying || disabled}
      >
        <IoPlayOutline size={15} />
      </button>
      <button
        type="button"
        className="icon-btn"
        title="Pause"
        aria-label="Pause"
        onClick={onPause}
        disabled={!isPlaying || disabled}
      >
        <IoPauseOutline size={15} />
      </button>
      <button
        type="button"
        className="icon-btn"
        title="Step"
        aria-label="Step"
        onClick={onStep}
        disabled={disabled}
      >
        <IoPlaySkipForwardOutline size={15} />
      </button>

      <input
        className="range"
        type="range"
        min={0}
        max={safeMax}
        value={Math.min(normalizeTimelineTime(currentTime), safeMax)}
        onChange={(e) => onSeek(normalizeTimelineTime(Number(e.target.value)))}
        disabled={disabled}
      />
      <span className="mono">{currentTime.toFixed(0)} ms</span>
    </div>
  );
};
