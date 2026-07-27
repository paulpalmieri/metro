import test from "node:test";
import assert from "node:assert/strict";
import { placeStationLabel } from "../src/lib/label-placement.js";

const viewport = { width: 300, height: 200 };
const horizontalLine = [[{ x: 10, y: 100 }, { x: 290, y: 100 }]];

test("places a station plaque clear of its route line", () => {
  const box = placeStationLabel({
    point: { x: 150, y: 100 },
    width: 80,
    height: 16,
    segments: horizontalLine,
    occupied: [],
    viewport,
  });
  assert.ok(box);
  assert.ok(box.y + box.height < 100);
});

test("tries another side when the preferred position is occupied", () => {
  const box = placeStationLabel({
    point: { x: 150, y: 100 },
    width: 80,
    height: 16,
    segments: horizontalLine,
    occupied: [{ x: 105, y: 60, width: 90, height: 28 }],
    viewport,
  });
  assert.ok(box);
  assert.ok(box.y > 100);
});

test("omits a plaque when every safe position is blocked", () => {
  const box = placeStationLabel({
    point: { x: 25, y: 25 },
    width: 120,
    height: 16,
    segments: [
      [{ x: 0, y: 25 }, { x: 60, y: 25 }],
      [{ x: 25, y: 0 }, { x: 25, y: 60 }],
      [{ x: 0, y: 0 }, { x: 60, y: 60 }],
      [{ x: 0, y: 60 }, { x: 60, y: 0 }],
    ],
    occupied: [],
    viewport,
  });
  assert.equal(box, null);
});

test("can use tighter route clearance for dense overview labels", () => {
  const nearbyLine = [[{ x: 10, y: 72 }, { x: 290, y: 72 }]];
  const strictBox = placeStationLabel({
    point: { x: 150, y: 100 },
    width: 80,
    height: 16,
    segments: nearbyLine,
    occupied: [],
    viewport,
  });
  const relaxedBox = placeStationLabel({
    point: { x: 150, y: 100 },
    width: 80,
    height: 16,
    segments: nearbyLine,
    occupied: [],
    viewport,
    segmentPadding: 1,
  });
  assert.ok(strictBox.y > 100);
  assert.ok(relaxedBox.y < 100);
});

test("can search farther from a station when the nearest positions are occupied", () => {
  const box = placeStationLabel({
    point: { x: 150, y: 100 },
    width: 80,
    height: 16,
    segments: [],
    occupied: [
      { x: 100, y: 68, width: 100, height: 28 },
      { x: 100, y: 104, width: 100, height: 28 },
      { x: 186, y: 74, width: 90, height: 52 },
      { x: 24, y: 74, width: 90, height: 52 },
    ],
    viewport,
    gaps: [10, 42],
  });
  assert.ok(box);
  assert.ok(Math.abs(box.y + box.height / 2 - 100) > 30);
});
