import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRouteModels,
  buildSegmentDurations,
  buildTrainPlans,
  matchJourney,
  movementProgress,
  positionForTrain,
  projectedForRouteProgress,
  reconcileTrainPlans,
  reconcileRouteProgress,
  sampleRouteCurve,
  segmentDurationsFromCalibration,
} from "../src/lib/train-model.js";

const stations = {
  "1": {
    directions: [
      {
        direction: "East",
        stops: [
          { ref: "a-east", name: "Alpha" },
          { ref: "b-east", name: "Bravo" },
          { ref: "c-east", name: "Charlie" },
        ],
      },
      {
        direction: "West",
        stops: [
          { ref: "c-west", name: "Charlie" },
          { ref: "b-west", name: "Bravo" },
          { ref: "a-west", name: "Alpha" },
        ],
      },
    ],
  },
};

const geometry = {
  "1": {
    points: {
      "a-east": [2.30, 48.85],
      "b-east": [2.31, 48.85],
      "c-east": [2.32, 48.85],
      "c-west": [2.3201, 48.8501],
      "b-west": [2.3101, 48.8501],
      "a-west": [2.3001, 48.8501],
    },
  },
};

const routes = buildRouteModels(stations, geometry);

test("collapses directional platforms onto one physical station centreline", () => {
  const eastBravo = routes["1"][0].byRef.get("b-east");
  const westBravo = routes["1"][1].byRef.get("b-west");
  assert.deepEqual(eastBravo.coordinates, westBravo.coordinates);
  assert.deepEqual(eastBravo.projected, westBravo.projected);
  assert.ok(eastBravo.coordinates[0] > 2.31 && eastBravo.coordinates[0] < 2.3101);
});

test("matches a journey to the platform-specific direction", () => {
  const journey = {
    code: "1",
    // PRIM frequently publishes EstimatedCalls destination-first.
    calls: [
      { ref: "b-west", arrival: "2026-07-25T10:02:00.000Z" },
      { ref: "c-west", arrival: "2026-07-25T10:00:00.000Z" },
    ],
  };
  const match = matchJourney(journey, routes);
  assert.equal(match.route.direction, "West");
  assert.deepEqual(match.calls.map((call) => call.routeIndex), [0, 1]);
});

test("discards out-of-order SIRI calls before interpolation", () => {
  const snapshot = {
    journeys: [{
      id: "train-with-ghost-call",
      code: "1",
      calls: [
        { ref: "a-east", arrival: "2026-07-25T10:00:00.000Z" },
        { ref: "b-east", arrival: "2026-07-25T10:01:00.000Z" },
        { ref: "a-east", arrival: "2026-07-25T10:01:40.000Z" },
        { ref: "c-east", arrival: "2026-07-25T10:02:00.000Z" },
      ],
    }],
  };
  const [plan] = buildTrainPlans(snapshot, routes);
  assert.deepEqual(plan.calls.map((call) => call.routeIndex), [0, 1, 2]);

  const position = positionForTrain(
    plan,
    Date.parse("2026-07-25T10:01:20.000Z"),
    new Map([["1:b-east:c-east", 60]]),
  );
  assert.ok(position);
  assert.ok(position.routeProgress >= 1);
  assert.ok(position.routeProgress < 2);
});

test("retains a train across a partial refresh without extending its expiry", () => {
  const initial = reconcileTrainPlans(
    [],
    [{ id: "train-1", code: "1" }],
    1_000,
    180_000,
  );
  const missing = reconcileTrainPlans(initial, [], 61_000, 180_000);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].missingSince, 61_000);
  assert.equal(missing[0].expiresAt, 181_000);

  const returned = reconcileTrainPlans(
    missing,
    [{ id: "train-1", code: "1" }],
    121_000,
    180_000,
  );
  assert.equal(returned.length, 1);
  assert.equal(returned[0].missingSince, null);
  assert.equal(returned[0].expiresAt, 301_000);

  const expired = reconcileTrainPlans(returned, [], 302_000, 180_000);
  assert.deepEqual(expired, []);
});

test("carries recent calls across a partial journey refresh", () => {
  const [initialPlan] = buildTrainPlans({
    journeys: [{
      id: "train-1",
      code: "1",
      calls: [
        { ref: "a-east", arrival: "2026-07-25T10:00:00.000Z" },
        { ref: "b-east", arrival: "2026-07-25T10:01:00.000Z" },
        { ref: "c-east", arrival: "2026-07-25T10:02:00.000Z" },
      ],
    }],
  }, routes);
  const initial = reconcileTrainPlans(
    [],
    [initialPlan],
    Date.parse("2026-07-25T10:00:30.000Z"),
    180_000,
  );
  const [partialPlan] = buildTrainPlans({
    journeys: [{
      id: "train-1",
      code: "1",
      calls: [
        { ref: "c-east", arrival: "2026-07-25T10:02:10.000Z" },
      ],
    }],
  }, routes);
  const [reconciled] = reconcileTrainPlans(
    initial,
    [partialPlan],
    Date.parse("2026-07-25T10:01:10.000Z"),
    180_000,
  );

  assert.deepEqual(reconciled.calls.map((call) => call.routeIndex), [0, 1, 2]);
  assert.equal(reconciled.calls[2].arrival, "2026-07-25T10:02:10.000Z");
  assert.ok(positionForTrain(
    reconciled,
    Date.parse("2026-07-25T10:01:20.000Z"),
    new Map([["1:b-east:c-east", 70]]),
  ));
});

test("builds the same smooth centreline in both travel directions", () => {
  const east = sampleRouteCurve(routes["1"][0], 6);
  const west = sampleRouteCurve(routes["1"][1], 6).reverse();
  assert.equal(east.length, west.length);
  east.forEach((point, index) => {
    assert.ok(Math.abs(point.x - west[index].x) < 1e-12);
    assert.ok(Math.abs(point.y - west[index].y) < 1e-12);
  });
});

test("learns a median duration for each directed interstation", () => {
  const snapshots = [100, 120, 140].map((duration, index) => ({
    journeys: [{
      id: `train-${index}`,
      code: "1",
      calls: [
        {
          ref: "a-east",
          arrival: "2026-07-25T10:00:00.000Z",
          departure: "2026-07-25T10:00:10.000Z",
        },
        {
          ref: "b-east",
          arrival: new Date(Date.parse("2026-07-25T10:00:10.000Z") + duration * 1000).toISOString(),
        },
      ],
    }],
  }));
  const durations = buildSegmentDurations(snapshots, routes);
  assert.equal(durations.get("1:a-east:b-east"), 120);
});

test("uses static calibration and does not overweight repeated journey revisions", () => {
  const calibration = segmentDurationsFromCalibration({
    segments: {
      "1:a-east:b-east": { seconds: 115 },
    },
  });
  const snapshots = [
    ...Array.from({ length: 8 }, (_, index) => ({
      updatedAt: `repeat-${index}`,
      journeys: [{
        id: "same-train",
        code: "1",
        calls: [
          { ref: "a-east", departure: "2026-07-25T10:00:00.000Z" },
          { ref: "b-east", arrival: "2026-07-25T10:03:00.000Z" },
        ],
      }],
    })),
    {
      updatedAt: "other",
      journeys: [{
        id: "other-train",
        code: "1",
        calls: [
          { ref: "b-east", departure: "2026-07-25T10:00:00.000Z" },
          { ref: "c-east", arrival: "2026-07-25T10:02:00.000Z" },
        ],
      }],
    },
  ];
  const durations = buildSegmentDurations(snapshots, routes, calibration);
  assert.equal(durations.get("1:a-east:b-east"), 115);
  assert.equal(durations.get("1:b-east:c-east"), 120);
});

test("adapts the baseline conservatively when several current journeys agree", () => {
  const calibration = new Map([["1:a-east:b-east", 100]]);
  const snapshots = [0, 1, 2, 3].map((index) => ({
    updatedAt: `current-${index}`,
    journeys: [{
      id: `train-${index}`,
      code: "1",
      calls: [
        { ref: "a-east", departure: "2026-07-25T10:00:00.000Z" },
        { ref: "b-east", arrival: "2026-07-25T10:02:20.000Z" },
      ],
    }],
  }));
  const durations = buildSegmentDurations(snapshots, routes, calibration);
  assert.equal(durations.get("1:a-east:b-east"), 110);
});

test("interpolates on the learned segment clock and holds during dwell", () => {
  const snapshot = {
    journeys: [{
      id: "train-1",
      code: "1",
      destination: "East",
      calls: [
        {
          ref: "b-east",
          arrival: "2026-07-25T10:02:00.000Z",
          departure: "2026-07-25T10:02:20.000Z",
        },
        {
          ref: "c-east",
          arrival: "2026-07-25T10:04:00.000Z",
        },
      ],
    }],
  };
  const [plan] = buildTrainPlans(snapshot, routes);
  const durations = new Map([["1:a-east:b-east", 120]]);

  // The calibrated interval includes a 12-second station dwell, leaving
  // 108 seconds of actual motion. Halfway through motion is therefore 10:01:06.
  const halfway = positionForTrain(plan, Date.parse("2026-07-25T10:01:06.000Z"), durations);
  assert.equal(halfway.phase, "between");
  assert.equal(halfway.progress, .5);
  assert.ok(Math.abs(halfway.routeProgress - .5) < 1e-12);
  const curvedPosition = projectedForRouteProgress(plan, halfway.routeProgress);
  assert.ok(Math.abs(curvedPosition.x - halfway.projected.x) < 1e-12);
  assert.ok(Math.abs(curvedPosition.y - halfway.projected.y) < 1e-12);

  const dwelling = positionForTrain(plan, Date.parse("2026-07-25T10:02:10.000Z"), durations);
  assert.equal(dwelling.phase, "station");
  assert.equal(dwelling.nextName, "Bravo");
  assert.equal(dwelling.etaSeconds, 0);
});

test("holds through inferred dwell and rejects implausible reported intervals", () => {
  const snapshot = {
    journeys: [{
      id: "train-1",
      code: "1",
      calls: [
        {
          ref: "a-east",
          arrival: "2026-07-25T09:50:00.000Z",
          departure: "2026-07-25T09:50:00.000Z",
        },
        { ref: "b-east", arrival: "2026-07-25T10:02:00.000Z" },
      ],
    }],
  };
  const [plan] = buildTrainPlans(snapshot, routes);
  const durations = new Map([["1:a-east:b-east", 120]]);
  const movement = {
    defaultDwellSeconds: 20,
    accelerationMetresPerSecondSquared: 0.6,
    maximumSpeedMetresPerSecond: 23,
  };

  const beforeInterval = positionForTrain(
    plan,
    Date.parse("2026-07-25T09:59:59.000Z"),
    durations,
    movement,
  );
  assert.equal(beforeInterval, null);

  const holding = positionForTrain(
    plan,
    Date.parse("2026-07-25T10:00:10.000Z"),
    durations,
    movement,
  );
  assert.equal(holding.routeProgress, 0);

  const halfway = positionForTrain(
    plan,
    Date.parse("2026-07-25T10:01:10.000Z"),
    durations,
    movement,
  );
  assert.equal(halfway.progress, .5);
  assert.ok(Math.abs(halfway.routeProgress - .5) < 1e-12);
});

test("uses an acceleration, cruise, and braking profile", () => {
  const movement = {
    accelerationMetresPerSecondSquared: 0.6,
    maximumSpeedMetresPerSecond: 23,
  };
  assert.equal(movementProgress(0, 80, 500, movement), 0);
  assert.ok(movementProgress(.25, 80, 500, movement) < .25);
  assert.equal(movementProgress(.5, 80, 500, movement), .5);
  assert.ok(movementProgress(.75, 80, 500, movement) > .75);
  assert.equal(movementProgress(1, 80, 500, movement), 1);
});

test("can exaggerate peak speed without changing segment time anchors", () => {
  const physical = {
    accelerationMetresPerSecondSquared: 0.6,
    maximumSpeedMetresPerSecond: 23,
  };
  const lively = {
    ...physical,
    displayPeakSpeedMultiplier: 1.4,
  };

  assert.equal(movementProgress(0, 80, 500, lively), 0);
  assert.equal(movementProgress(.5, 80, 500, lively), .5);
  assert.equal(movementProgress(1, 80, 500, lively), 1);
  assert.ok(
    movementProgress(.25, 80, 500, lively)
    < movementProgress(.25, 80, 500, physical),
  );
  assert.ok(
    movementProgress(.75, 80, 500, lively)
    > movementProgress(.75, 80, 500, physical),
  );

  const physicalMiddleStep = movementProgress(.6, 80, 500, physical)
    - movementProgress(.5, 80, 500, physical);
  const livelyMiddleStep = movementProgress(.6, 80, 500, lively)
    - movementProgress(.5, 80, 500, lively);
  assert.ok(livelyMiddleStep >= physicalMiddleStep * 1.39);

  const samples = Array.from(
    { length: 21 },
    (_, index) => movementProgress(index / 20, 80, 500, lively),
  );
  samples.forEach((progress, index) => {
    assert.ok(progress >= 0 && progress <= 1);
    if (index) assert.ok(progress >= samples[index - 1]);
    assert.ok(Math.abs(progress + samples[20 - index] - 1) < 1e-12);
  });
});

test("balances station zones with a sustained faster middle crossing", () => {
  const movement = {
    accelerationMetresPerSecondSquared: 0.6,
    maximumSpeedMetresPerSecond: 23,
    displayStationZoneFraction: 0.1,
    displayStationTimeFraction: 0.22,
  };
  const samples = Array.from(
    { length: 101 },
    (_, index) => movementProgress(index / 100, 80, 500, movement),
  );

  assert.equal(samples[0], 0);
  assert.equal(samples[50], .5);
  assert.equal(samples[100], 1);
  assert.ok(Math.abs(movementProgress(.22, 80, 500, movement) - .1) < 1e-12);
  assert.ok(Math.abs(movementProgress(.78, 80, 500, movement) - .9) < 1e-12);
  assert.ok(Math.abs((samples[51] - samples[49]) / .02 - 10 / 7) < 1e-12);
  samples.forEach((progress, index) => {
    assert.ok(progress >= 0 && progress <= 1);
    if (index) assert.ok(progress >= samples[index - 1]);
    assert.ok(Math.abs(progress + samples[100 - index] - 1) < 1e-12);
  });
});

test("does not show a future terminal train for the full feed horizon", () => {
  const snapshot = {
    journeys: [{
      id: "future-train",
      code: "1",
      calls: [{ ref: "a-east", departure: "2026-07-25T10:10:00.000Z" }],
    }],
  };
  const [plan] = buildTrainPlans(snapshot, routes);
  assert.equal(
    positionForTrain(plan, Date.parse("2026-07-25T10:05:00.000Z"), new Map()),
    null,
  );
  assert.equal(
    positionForTrain(plan, Date.parse("2026-07-25T10:09:55.000Z"), new Map())?.phase,
    "station",
  );
});

test("reconciles API revisions along the rail without flying or reversing", () => {
  const forward = reconcileRouteProgress(4.2, 4.7, 1000);
  assert.ok(forward.progress > 4.2);
  assert.ok(forward.progress < 4.23);
  assert.equal(forward.relocated, false);

  const delayed = reconcileRouteProgress(4.2, 4.0, 1000);
  assert.equal(delayed.progress, 4.2);
  assert.equal(delayed.relocated, false);

  const boundedDelay = reconcileRouteProgress(4.2, 4.0, 1000, {
    backwardHoldMilliseconds: 30_000,
    backwardHeldMilliseconds: 30_000,
  });
  assert.equal(boundedDelay.progress, 4.0);
  assert.equal(boundedDelay.relocated, true);

  const discontinuity = reconcileRouteProgress(4.2, 7.0, 1000);
  assert.equal(discontinuity.progress, 7.0);
  assert.equal(discontinuity.relocated, true);
});
