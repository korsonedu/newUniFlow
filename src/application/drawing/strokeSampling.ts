import { Point } from '../../domain/types';

export type StrokeTimedSample = {
  point: Point;
  time: number;
  pressure?: number;
};

const MIN_STROKE_SAMPLE_DISTANCE = 0.001;
const DEFAULT_MAX_RENDER_POINTS = 24000;
const DEDUPE_POINT_EPS = 0.000001;
const DEDUPE_TIME_EPS = 0.0001;
const DEDUPE_PRESSURE_EPS = 0.0001;
const MAX_CURVE_ITERATIONS = 2;

const lerp = (start: number, end: number, t: number): number => start + ((end - start) * t);

const lerpPoint = (start: Point, end: Point, t: number): Point => ({
  x: lerp(start.x, end.x, t),
  y: lerp(start.y, end.y, t),
});

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const normalizePressure = (value: number | undefined): number | undefined => (
  typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, 0, 1)
    : undefined
);

const dedupeStrokeSamples = (
  samples: StrokeTimedSample[],
  _minDistance = MIN_STROKE_SAMPLE_DISTANCE,
): StrokeTimedSample[] => {
  if (samples.length <= 1) {
    return samples;
  }
  const output: StrokeTimedSample[] = [samples[0]];
  for (let i = 1; i < samples.length; i += 1) {
    const current = samples[i];
    const last = output[output.length - 1];
    const moved = distance(current.point, last.point) > DEDUPE_POINT_EPS;
    const elapsed = Math.abs(current.time - last.time) > DEDUPE_TIME_EPS;
    const pressureChanged = Math.abs(
      (normalizePressure(current.pressure) ?? 0.5)
      - (normalizePressure(last.pressure) ?? 0.5),
    ) > DEDUPE_PRESSURE_EPS;
    if (moved || elapsed || pressureChanged) {
      output.push(current);
    }
  }
  if (output.length === 1 && samples.length > 1) {
    output.push(samples[samples.length - 1]);
  }
  return output;
};

const reduceStrokeSamples = (
  samples: StrokeTimedSample[],
  maxPoints: number,
): StrokeTimedSample[] => {
  const safeMax = Math.max(2, Math.floor(maxPoints));
  if (samples.length <= safeMax) {
    return samples;
  }
  const stride = Math.max(1, Math.ceil((samples.length - 1) / (safeMax - 1)));
  const output: StrokeTimedSample[] = [];
  for (let i = 0; i < samples.length; i += stride) {
    output.push(samples[i]);
  }
  const tail = samples[samples.length - 1];
  const last = output[output.length - 1];
  if (!last || last.time !== tail.time || last.point.x !== tail.point.x || last.point.y !== tail.point.y) {
    output.push(tail);
  }
  if (output.length > safeMax) {
    return output.slice(0, safeMax - 1).concat(output[output.length - 1]);
  }
  return output;
};

const chaikinSmoothStrokeSamples = (samples: StrokeTimedSample[]): StrokeTimedSample[] => {
  if (samples.length <= 2) {
    return samples;
  }
  const output: StrokeTimedSample[] = [samples[0]];
  for (let i = 0; i < samples.length - 1; i += 1) {
    const current = samples[i];
    const next = samples[i + 1];
    const currentPressure = normalizePressure(current.pressure) ?? 0.5;
    const nextPressure = normalizePressure(next.pressure) ?? currentPressure;
    output.push({
      point: lerpPoint(current.point, next.point, 0.25),
      time: lerp(current.time, next.time, 0.25),
      pressure: lerp(currentPressure, nextPressure, 0.25),
    });
    output.push({
      point: lerpPoint(current.point, next.point, 0.75),
      time: lerp(current.time, next.time, 0.75),
      pressure: lerp(currentPressure, nextPressure, 0.75),
    });
  }
  output.push(samples[samples.length - 1]);
  return output;
};

export const appendInterpolatedStrokeSamples = (
  samples: StrokeTimedSample[],
  nextPoint: Point,
  nextTime: number,
  sampleStep: number,
  nextPressure?: number,
): StrokeTimedSample[] => {
  const normalizedNextPressure = normalizePressure(nextPressure);
  if (samples.length === 0) {
    return [{ point: nextPoint, time: nextTime, pressure: normalizedNextPressure }];
  }

  const last = samples[samples.length - 1];
  const segmentDistance = distance(last.point, nextPoint);
  if (segmentDistance < MIN_STROKE_SAMPLE_DISTANCE) {
    const nextSampleTime = Math.max(last.time, nextTime);
    const nextSamplePressure = normalizedNextPressure ?? normalizePressure(last.pressure);
    const moved = distance(nextPoint, last.point) > DEDUPE_POINT_EPS;
    const timeChanged = Math.abs(nextSampleTime - last.time) > DEDUPE_TIME_EPS;
    const pressureChanged = Math.abs(
      (nextSamplePressure ?? 0.5) - (normalizePressure(last.pressure) ?? 0.5),
    ) > DEDUPE_PRESSURE_EPS;
    if (!moved && !timeChanged && !pressureChanged) {
      return samples;
    }
    return [
      ...samples,
      {
      point: nextPoint,
      time: nextSampleTime,
      pressure: nextSamplePressure,
      },
    ];
  }

  const baseStep = Math.max(MIN_STROKE_SAMPLE_DISTANCE, sampleStep);
  const adaptiveStep = segmentDistance > (baseStep * 4.5)
    ? Math.max(MIN_STROKE_SAMPLE_DISTANCE, baseStep * 0.42)
    : baseStep;
  const segmentCount = Math.max(1, Math.ceil(segmentDistance / adaptiveStep));
  const nextSamples = [...samples];
  const startPressure = normalizePressure(last.pressure) ?? 0.5;
  const targetPressure = normalizedNextPressure ?? startPressure;
  for (let i = 1; i <= segmentCount; i += 1) {
    const t = i / segmentCount;
    nextSamples.push({
      point: lerpPoint(last.point, nextPoint, t),
      time: lerp(last.time, nextTime, t),
      pressure: lerp(startPressure, targetPressure, t),
    });
  }
  return nextSamples;
};

export const finalizeStrokeSamples = (
  samples: StrokeTimedSample[],
  options?: {
    iterations?: number;
    curveSmoothing?: boolean;
    minDistance?: number;
    maxPoints?: number;
  },
): { points: Point[]; pointTimes: number[]; pointPressures?: number[] } => {
  const minDistance = Math.max(MIN_STROKE_SAMPLE_DISTANCE / 3, options?.minDistance ?? MIN_STROKE_SAMPLE_DISTANCE);
  const maxPoints = Math.max(2, Math.floor(options?.maxPoints ?? DEFAULT_MAX_RENDER_POINTS));
  let working = dedupeStrokeSamples(samples, minDistance);
  if (working.length <= 2) {
    const hasPressure = working.some((sample) => normalizePressure(sample.pressure) !== undefined);
    let previousPressure = 0.5;
    const pointPressures = hasPressure
      ? working.map((sample) => {
          const pressure = normalizePressure(sample.pressure) ?? previousPressure;
          previousPressure = pressure;
          return pressure;
        })
      : undefined;
    return {
      points: working.map((sample) => sample.point),
      pointTimes: working.map((sample) => sample.time),
      pointPressures,
    };
  }

  const useCurveSmoothing = options?.curveSmoothing ?? false;
  if (useCurveSmoothing) {
    const iterations = Math.max(1, Math.min(MAX_CURVE_ITERATIONS, Math.floor(options?.iterations ?? 2)));
    for (let i = 0; i < iterations; i += 1) {
      working = dedupeStrokeSamples(
        chaikinSmoothStrokeSamples(working),
        MIN_STROKE_SAMPLE_DISTANCE,
      );
    }
  }

  const monotonic = working.map((sample, index) => {
    if (index === 0) {
      return sample;
    }
    const prev = working[index - 1];
    return {
      point: sample.point,
      time: Math.max(prev.time, sample.time),
      pressure: sample.pressure,
    };
  });
  const reduced = reduceStrokeSamples(monotonic, maxPoints);
  const hasPressure = reduced.some((sample) => normalizePressure(sample.pressure) !== undefined);
  let previousPressure = 0.5;
  const pointPressures = hasPressure
    ? reduced.map((sample) => {
        const pressure = normalizePressure(sample.pressure) ?? previousPressure;
        previousPressure = pressure;
        return pressure;
      })
    : undefined;

  return {
    points: reduced.map((sample) => sample.point),
    pointTimes: reduced.map((sample) => sample.time),
    pointPressures,
  };
};
