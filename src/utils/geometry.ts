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

export const hitRectObject = (point: Point, object: WhiteboardObject): boolean => {
  const left = Math.min(object.x, object.x + object.width);
  const right = Math.max(object.x, object.x + object.width);
  const top = Math.min(object.y, object.y + object.height);
  const bottom = Math.max(object.y, object.y + object.height);
  return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
};

export const pointsToSvgPath = (points: Point[]): string => {
  if (points.length === 0) {
    return '';
  }
  if (points.length === 1) {
    const p = points[0];
    return `M ${p.x} ${p.y} L ${p.x + 0.1} ${p.y + 0.1}`;
  }
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const current = points[i];
    const next = points[i + 1];
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    path += ` Q ${current.x} ${current.y} ${midX} ${midY}`;
  }
  const last = points[points.length - 1];
  path += ` L ${last.x} ${last.y}`;
  return path;
};
