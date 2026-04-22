import { Point, Stroke, WhiteboardObject } from '../domain/types';

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

export const distancePointToSegment = (p: Point, a: Point, b: Point): number => {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const ab2 = abx * abx + aby * aby;

  if (ab2 === 0) {
    return distance(p, a);
  }

  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / ab2));
  const proj = {
    x: a.x + t * abx,
    y: a.y + t * aby,
  };

  return distance(p, proj);
};

export const hitStroke = (point: Point, stroke: Stroke, threshold = 8): boolean => {
  if (stroke.points.length === 0) {
    return false;
  }

  if (stroke.points.length === 1) {
    return distance(point, stroke.points[0]) <= threshold;
  }

  for (let i = 0; i < stroke.points.length - 1; i += 1) {
    if (distancePointToSegment(point, stroke.points[i], stroke.points[i + 1]) <= threshold) {
      return true;
    }
  }

  return false;
};

export const rotatePoint = (point: Point, center: Point, degrees: number): Point => {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + ((dx * cos) - (dy * sin)),
    y: center.y + ((dx * sin) + (dy * cos)),
  };
};

export const getRectCenter = (object: Pick<WhiteboardObject, 'x' | 'y' | 'width' | 'height'>): Point => ({
  x: object.x + (object.width / 2),
  y: object.y + (object.height / 2),
});

export const hitRectObject = (point: Point, object: WhiteboardObject): boolean => {
  const rotation = object.rotation ?? 0;
  const normalizedPoint = rotation === 0
    ? point
    : rotatePoint(point, getRectCenter(object), -rotation);
  const left = Math.min(object.x, object.x + object.width);
  const right = Math.max(object.x, object.x + object.width);
  const top = Math.min(object.y, object.y + object.height);
  const bottom = Math.max(object.y, object.y + object.height);
  return normalizedPoint.x >= left
    && normalizedPoint.x <= right
    && normalizedPoint.y >= top
    && normalizedPoint.y <= bottom;
};
