const DIRECTIONS = [
  [0, -1],
  [0, 1],
  [1, 0],
  [-1, 0],
  [1, -1],
  [-1, -1],
  [1, 1],
  [-1, 1],
];

function boxesOverlap(left, right, padding = 0) {
  return (
    left.x - padding < right.x + right.width
    && left.x + left.width + padding > right.x
    && left.y - padding < right.y + right.height
    && left.y + left.height + padding > right.y
  );
}

function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function between(a, b, value) {
  return value >= Math.min(a, b) - 1e-6 && value <= Math.max(a, b) + 1e-6;
}

function segmentsIntersect(a, b, c, d) {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0))
    && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
  if (Math.abs(abC) < 1e-6 && between(a.x, b.x, c.x) && between(a.y, b.y, c.y)) return true;
  if (Math.abs(abD) < 1e-6 && between(a.x, b.x, d.x) && between(a.y, b.y, d.y)) return true;
  if (Math.abs(cdA) < 1e-6 && between(c.x, d.x, a.x) && between(c.y, d.y, a.y)) return true;
  if (Math.abs(cdB) < 1e-6 && between(c.x, d.x, b.x) && between(c.y, d.y, b.y)) return true;
  return false;
}

function segmentTouchesBox(segment, box, padding) {
  const rectangle = {
    x: box.x - padding,
    y: box.y - padding,
    width: box.width + padding * 2,
    height: box.height + padding * 2,
  };
  const [from, to] = segment;
  const inside = (point) => (
    point.x >= rectangle.x && point.x <= rectangle.x + rectangle.width
    && point.y >= rectangle.y && point.y <= rectangle.y + rectangle.height
  );
  if (inside(from) || inside(to)) return true;
  const topLeft = { x: rectangle.x, y: rectangle.y };
  const topRight = { x: rectangle.x + rectangle.width, y: rectangle.y };
  const bottomRight = { x: rectangle.x + rectangle.width, y: rectangle.y + rectangle.height };
  const bottomLeft = { x: rectangle.x, y: rectangle.y + rectangle.height };
  return [
    [topLeft, topRight],
    [topRight, bottomRight],
    [bottomRight, bottomLeft],
    [bottomLeft, topLeft],
  ].some(([start, end]) => segmentsIntersect(from, to, start, end));
}

function candidateBox(point, width, height, [horizontal, vertical], gap) {
  const centreX = point.x + horizontal * (gap + (horizontal ? width / 2 : 0));
  const centreY = point.y + vertical * (gap + (vertical ? height / 2 : 0));
  return {
    x: centreX - width / 2,
    y: centreY - height / 2,
    width,
    height,
  };
}

export function placeStationLabel({
  point,
  width,
  height,
  segments,
  occupied,
  viewport,
  gap = 10,
  gaps = [gap],
  overlapPadding = 4,
  segmentPadding = 3,
  viewportPadding = 8,
}) {
  for (const candidateGap of gaps) {
    for (const direction of DIRECTIONS) {
      const box = candidateBox(point, width, height, direction, candidateGap);
      const withinViewport = (
        box.x >= viewportPadding
        && box.y >= viewportPadding
        && box.x + box.width <= viewport.width - viewportPadding
        && box.y + box.height <= viewport.height - viewportPadding
      );
      if (!withinViewport) continue;
      if (occupied.some((other) => boxesOverlap(box, other, overlapPadding))) continue;
      if (segments.some((segment) => segmentTouchesBox(segment, box, segmentPadding))) continue;
      return box;
    }
  }
  return null;
}
