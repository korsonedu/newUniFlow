import { getStroke } from 'perfect-freehand';
import { Point } from '../../domain/types';

export type PerfectStrokeVariant = 'pen' | 'highlight' | 'auto';
export const PERFECT_STROKE_ENGINE_VERSION = 'perfect-freehand-v7-readme-pipeline';

type PerfectStrokeTuning = {
  thinning: number;
  smoothing: number;
  streamline: number;
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const buildDotPath = (point: Point, size: number): string => {
  const r = Math.max(0.35, size / 2);
  const x = point.x;
  const y = point.y;
  return `M ${x - r} ${y} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0`;
};

const buildSvgPathFromOutline = (outline: Array<[number, number]>): string => {
  if (outline.length === 0) {
    return '';
  }
  if (outline.length === 1) {
    const [x, y] = outline[0];
    return `M ${x} ${y}`;
  }
  const d = outline.reduce<(string | number)[]>(
    (acc, [x0, y0], index, points) => {
      const [x1, y1] = points[(index + 1) % points.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ['M', outline[0][0], outline[0][1], 'Q'],
  );
  return `${d.join(' ')} Z`;
};

const resolvePenTuningBySize = (size: number): PerfectStrokeTuning => {
  if (size <= 2.2) {
    return {
      thinning: 0.52,
      smoothing: 0.62,
      streamline: 0.55,
    };
  }
  if (size <= 4.8) {
    return {
      thinning: 0.48,
      smoothing: 0.6,
      streamline: 0.52,
    };
  }
  return {
    thinning: 0.42,
    smoothing: 0.58,
    streamline: 0.48,
  };
};

const resolveHighlightTuningBySize = (size: number): PerfectStrokeTuning => {
  if (size <= 14) {
    return {
      thinning: 0.08,
      smoothing: 0.56,
      streamline: 0.5,
    };
  }
  return {
    thinning: 0,
    smoothing: 0.52,
    streamline: 0.46,
  };
};

const resolveTuning = (size: number, variant: PerfectStrokeVariant): PerfectStrokeTuning => {
  if (variant === 'highlight') {
    return resolveHighlightTuningBySize(size);
  }
  if (variant === 'pen') {
    return resolvePenTuningBySize(size);
  }
  return size >= 10 ? resolveHighlightTuningBySize(size) : resolvePenTuningBySize(size);
};

export const buildPerfectStrokePath = (
  points: Point[],
  width: number,
  options?: { complete?: boolean; pressures?: number[]; variant?: PerfectStrokeVariant },
): string => {
  if (points.length === 0) {
    return '';
  }

  const size = clamp(width, 0.2, 256);
  if (points.length === 1) {
    return buildDotPath(points[0], size);
  }

  const complete = options?.complete ?? true;
  const variant = options?.variant ?? 'auto';
  const tuning = resolveTuning(size, variant);
  const rawPressures = options?.pressures;
  const hasPressureSeries = !!rawPressures && rawPressures.length === points.length;
  const useRealPressure = hasPressureSeries
    && rawPressures.every((pressure) => typeof pressure === 'number' && Number.isFinite(pressure));
  const inputPoints = useRealPressure
    ? points.map((point, index) => (
      [
        point.x,
        point.y,
        clamp(rawPressures![index], 0, 1),
      ] as [number, number, number]
    ))
    : points.map((point) => [point.x, point.y] as [number, number]);

  const stroke = getStroke(
    inputPoints,
    {
      size,
      thinning: tuning.thinning,
      smoothing: tuning.smoothing,
      streamline: tuning.streamline,
      simulatePressure: !useRealPressure,
      last: complete,
      start: {
        taper: 0,
        cap: true,
      },
      end: {
        taper: 0,
        cap: true,
      },
    },
  );

  if (stroke.length <= 0) {
    return buildDotPath(points[points.length - 1], size);
  }
  return buildSvgPathFromOutline(stroke as Array<[number, number]>);
};
