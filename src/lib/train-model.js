const MIN_SEGMENT_SECONDS = 20;
const MAX_SEGMENT_SECONDS = 8 * 60;
const RECENT_CALL_RETENTION_MS = 2 * 60_000;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function project([longitude, latitude]) {
  const sin = Math.sin(latitude * Math.PI / 180);
  return {
    x: (longitude + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI),
  };
}

function time(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function distanceMetres(a, b) {
  const latitude = (a[1] + b[1]) * Math.PI / 360;
  const dx = (b[0] - a[0]) * 111_320 * Math.cos(latitude);
  const dy = (b[1] - a[1]) * 110_540;
  return Math.hypot(dx, dy);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function longestForwardSequence(calls) {
  const sequenceLengths = calls.map(() => 1);
  const predecessors = calls.map(() => -1);
  let sequenceEnd = 0;

  for (let index = 0; index < calls.length; index += 1) {
    for (let previous = 0; previous < index; previous += 1) {
      if (
        calls[previous].routeIndex < calls[index].routeIndex
        && sequenceLengths[previous] + 1 > sequenceLengths[index]
      ) {
        sequenceLengths[index] = sequenceLengths[previous] + 1;
        predecessors[index] = previous;
      }
    }
    if (sequenceLengths[index] > sequenceLengths[sequenceEnd]) sequenceEnd = index;
  }

  const sequence = [];
  for (
    let index = calls.length ? sequenceEnd : -1;
    index >= 0;
    index = predecessors[index]
  ) {
    sequence.push(calls[index]);
  }
  return sequence.reverse();
}

export function buildRouteModels(stations, geometry) {
  return Object.fromEntries(Object.entries(stations).map(([code, line]) => {
    const points = geometry[code]?.points ?? {};
    const coordinatesByName = new Map();
    for (const direction of line.directions ?? []) {
      for (const stop of direction.stops) {
        const coordinates = points[stop.ref];
        if (!coordinates) continue;
        const samples = coordinatesByName.get(stop.name) ?? [];
        samples.push(coordinates);
        coordinatesByName.set(stop.name, samples);
      }
    }
    const physicalCoordinates = new Map([...coordinatesByName].map(([name, samples]) => [
      name,
      [
        samples.reduce((sum, coordinates) => sum + coordinates[0], 0) / samples.length,
        samples.reduce((sum, coordinates) => sum + coordinates[1], 0) / samples.length,
      ],
    ]));
    const directions = (line.directions ?? []).map((direction, directionIndex) => {
      const stops = direction.stops.flatMap((stop, routeIndex) => {
        // SIRI stop refs identify a directional platform. Both platforms are
        // collapsed onto their physical station centre so the rendered route
        // and every train share exactly one geographic line.
        const coordinates = physicalCoordinates.get(stop.name);
        return coordinates ? [{ ...stop, coordinates, projected: project(coordinates), routeIndex }] : [];
      });
      return {
        code,
        direction: direction.direction,
        directionIndex,
        stops,
        byRef: new Map(stops.map((stop) => [stop.ref, stop])),
      };
    });
    return [code, directions];
  }));
}

export function matchJourney(journey, routeModels) {
  const candidates = routeModels[journey.code] ?? [];
  const sourceCalls = [...(journey.calls ?? [])].sort((left, right) => (
    (time(left.arrival ?? left.departure ?? left.time) ?? Infinity)
    - (time(right.arrival ?? right.departure ?? right.time) ?? Infinity)
  ));
  let best = null;

  for (const route of candidates) {
    const matchedCalls = sourceCalls.flatMap((call, callIndex) => {
      const stop = route.byRef.get(call.ref);
      return stop ? [{
        ...call,
        callIndex,
        routeIndex: stop.routeIndex,
        name: stop.name,
        coordinates: stop.coordinates,
        projected: stop.projected,
        arrivalMs: time(call.arrival ?? call.time),
        departureMs: time(call.departure ?? call.arrival ?? call.time),
      }] : [];
    });
    // SIRI occasionally mixes stray calls from behind the vehicle into an
    // otherwise valid journey. Keep the longest chronologically ordered,
    // forward-only route sequence so one bad call cannot make interpolation
    // jump backward or temporarily become unplaceable.
    const calls = longestForwardSequence(matchedCalls);
    if (!calls.length) continue;

    const discardedCalls = matchedCalls.length - calls.length;
    const score = calls.length * 14 - discardedCalls * 12;
    if (!best || score > best.score) best = { route, calls, score };
  }

  return best;
}

function segmentKey(code, fromRef, toRef) {
  return `${code}:${fromRef}:${toRef}`;
}

export function segmentDurationsFromCalibration(calibration) {
  return new Map(Object.entries(calibration?.segments ?? {}).flatMap(([key, value]) => {
    const seconds = Number(typeof value === "number" ? value : value?.seconds);
    return Number.isFinite(seconds) && seconds >= MIN_SEGMENT_SECONDS
      ? [[key, seconds]]
      : [];
  }));
}

export function buildSegmentDurations(snapshots, routeModels, baseline = new Map()) {
  const samples = new Map();

  for (const snapshot of snapshots) {
    for (const journey of snapshot?.journeys ?? []) {
      const match = matchJourney(journey, routeModels);
      if (!match) continue;
      const { calls } = match;
      for (let index = 1; index < calls.length; index += 1) {
        const from = calls[index - 1];
        const to = calls[index];
        if (to.routeIndex !== from.routeIndex + 1) continue;
        const start = from.departureMs ?? from.arrivalMs;
        const end = to.arrivalMs ?? to.departureMs;
        const seconds = start && end ? (end - start) / 1000 : NaN;
        if (seconds < MIN_SEGMENT_SECONDS || seconds > MAX_SEGMENT_SECONDS) continue;
        const key = segmentKey(journey.code, from.ref, to.ref);
        const journeys = samples.get(key) ?? new Map();
        const journeyKey = journey.id ?? `${snapshot.updatedAt ?? "snapshot"}:${index}`;
        const values = journeys.get(journeyKey) ?? [];
        if (values.length < 24) values.push(seconds);
        journeys.set(journeyKey, values);
        samples.set(key, journeys);
      }
    }
  }

  const durations = new Map(baseline);
  for (const [key, journeys] of samples) {
    // A journey can remain in dozens of snapshots. Collapse those revisions
    // first so one long-lived train cannot dominate the segment estimate.
    const learned = median([...journeys.values()].map((values) => median(values)));
    const calibrated = durations.get(key);
    if (calibrated === undefined) durations.set(key, learned);
    else if (journeys.size >= 4) {
      // Let current conditions move the Saturday baseline modestly, while
      // preventing a burst of corrupt ETAs from redefining line speed.
      const bounded = clamp(learned, calibrated * 0.65, calibrated * 1.75);
      durations.set(key, calibrated * 0.75 + bounded * 0.25);
    }
  }
  return durations;
}

export function buildTrainPlans(snapshot, routeModels) {
  return (snapshot?.journeys ?? []).flatMap((journey) => {
    const match = matchJourney(journey, routeModels);
    if (!match) return [];
    return [{
      id: `${journey.code}:${journey.id}`,
      code: journey.code,
      destination: journey.destination || match.route.direction,
      route: match.route,
      calls: match.calls,
    }];
  });
}

export function reconcileTrainPlans(
  currentPlans,
  nextPlans,
  observedAt,
  retentionMilliseconds,
) {
  const expiresAt = observedAt + Math.max(0, retentionMilliseconds);
  const currentById = new Map(currentPlans.map((plan) => [plan.id, plan]));
  const nextIds = new Set(nextPlans.map((plan) => plan.id));
  const freshPlans = nextPlans.map((plan) => {
    const current = currentById.get(plan.id);
    let reconciled = plan;
    if (
      current?.route
      && plan.route
      && current.code === plan.code
      && current.route.directionIndex === plan.route.directionIndex
    ) {
      const callsByRouteIndex = new Map(
        current.calls
          .filter((call) => (
            (call.departureMs ?? call.arrivalMs ?? -Infinity)
            >= observedAt - RECENT_CALL_RETENTION_MS
          ))
          .map((call) => [call.routeIndex, call]),
      );
      for (const call of plan.calls) callsByRouteIndex.set(call.routeIndex, call);
      const mergedCalls = [...callsByRouteIndex.values()].sort((left, right) => (
        (left.arrivalMs ?? left.departureMs ?? Infinity)
        - (right.arrivalMs ?? right.departureMs ?? Infinity)
      ));
      reconciled = {
        ...plan,
        calls: longestForwardSequence(mergedCalls),
      };
    }
    return {
      ...reconciled,
      lastSeenAt: observedAt,
      expiresAt,
      missingSince: null,
    };
  });
  const retainedPlans = currentPlans.flatMap((plan) => (
    !nextIds.has(plan.id)
      && Number.isFinite(plan.expiresAt)
      && observedAt <= plan.expiresAt
      ? [{ ...plan, missingSince: plan.missingSince ?? observedAt }]
      : []
  ));
  return [...freshPlans, ...retainedPlans];
}

export function projectedForProgress(route, progress) {
  const maximum = Math.max(0, route.stops.length - 1);
  const bounded = clamp(progress, 0, maximum);
  const fromIndex = Math.min(maximum, Math.floor(bounded));
  const toIndex = Math.min(maximum, fromIndex + 1);
  const t = bounded - fromIndex;
  const p0 = route.stops[Math.max(0, fromIndex - 1)]?.projected;
  const p1 = route.stops[fromIndex]?.projected;
  const p2 = route.stops[toIndex]?.projected ?? p1;
  const p3 = route.stops[Math.min(maximum, toIndex + 1)]?.projected ?? p2;
  if (!p0 || !p1 || !p2 || !p3) return null;

  // A restrained cubic Hermite/Catmull-Rom curve passes through every station
  // while rounding the sharp angles made by station-to-station chords. The
  // lower tangent factor avoids loops or large geographic overshoot.
  const tangent = .35;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return {
    x: h00 * p1.x + h10 * (p2.x - p0.x) * tangent
      + h01 * p2.x + h11 * (p3.x - p1.x) * tangent,
    y: h00 * p1.y + h10 * (p2.y - p0.y) * tangent
      + h01 * p2.y + h11 * (p3.y - p1.y) * tangent,
  };
}

export function projectedForRouteProgress(plan, progress) {
  return projectedForProgress(plan.route, progress);
}

export function sampleRouteCurve(route, stepsPerSegment = 8) {
  if (!route.stops.length) return [];
  const points = [];
  for (let segment = 0; segment < route.stops.length - 1; segment += 1) {
    for (let step = segment === 0 ? 0 : 1; step <= stepsPerSegment; step += 1) {
      const point = projectedForProgress(route, segment + step / stepsPerSegment);
      if (point) points.push(point);
    }
  }
  if (route.stops.length === 1) points.push(route.stops[0].projected);
  return points;
}

export function reconcileRouteProgress(
  current,
  target,
  elapsedMilliseconds,
  {
    maxRate = 1 / 45_000,
    relocationThreshold = 1.25,
    backwardHoldMilliseconds = Infinity,
    backwardHeldMilliseconds = 0,
  } = {},
) {
  const correction = target - current;
  if (Math.abs(correction) > relocationThreshold) {
    return { progress: target, relocated: true };
  }
  if (correction <= 0) {
    if (Math.max(0, backwardHeldMilliseconds) >= backwardHoldMilliseconds) {
      return { progress: target, relocated: true };
    }
    // A delayed ETA must not make a train visibly reverse. Holding position
    // lets the revised timetable catch up naturally, up to the caller's
    // bounded hold duration.
    return { progress: current, relocated: false };
  }
  return {
    progress: current + Math.min(correction, Math.max(0, elapsedMilliseconds) * maxRate),
    relocated: false,
  };
}

function fallbackDuration(from, to, calls) {
  const nearby = [];
  for (let index = 1; index < calls.length; index += 1) {
    const start = calls[index - 1].departureMs ?? calls[index - 1].arrivalMs;
    const end = calls[index].arrivalMs ?? calls[index].departureMs;
    const seconds = start && end ? (end - start) / 1000 : NaN;
    if (seconds >= MIN_SEGMENT_SECONDS && seconds <= MAX_SEGMENT_SECONDS) nearby.push(seconds);
  }
  const localMedian = median(nearby);
  if (localMedian) return localMedian;

  // Paris Métro interstations are typically a short acceleration/braking
  // phase plus the distance at line speed. This is only a last-resort prior;
  // observed SIRI segment timings replace it as soon as they are available.
  return clamp(42 + distanceMetres(from.coordinates, to.coordinates) / 11.5, 55, 210);
}

function dwellSecondsFor(code, movement) {
  const seconds = Number(
    movement?.lines?.[code]?.dwellSeconds
      ?? movement?.defaultDwellSeconds
      ?? 12,
  );
  return clamp(Number.isFinite(seconds) ? seconds : 12, 0, 60);
}

export function movementProgress(
  progress,
  durationSeconds,
  distance,
  movement = {},
) {
  const timeProgress = clamp(progress, 0, 1);
  if (timeProgress === 0 || timeProgress === 1) return timeProgress;

  const duration = Math.max(1, durationSeconds);
  const acceleration = Math.max(
    0.1,
    Number(movement.accelerationMetresPerSecondSquared) || 0.6,
  );
  const maximumSpeed = Math.max(
    1,
    Number(movement.maximumSpeedMetresPerSecond) || 23,
  );
  const discriminant = duration ** 2 - 4 * Math.max(0, distance) / acceleration;
  const physicalAccelerationTime = discriminant > 0
    ? (duration - Math.sqrt(discriminant)) / 2
    : duration / 2;
  const accelerationTime = Math.min(
    duration / 2,
    maximumSpeed / acceleration,
    Math.max(duration * 0.05, physicalAccelerationTime),
  );
  const physicalAccelerationFraction = accelerationTime / duration;
  const physicalNormalizedSpeed = 1 / (1 - physicalAccelerationFraction);
  const configuredStationTime = Number(movement.displayStationTimeFraction);
  if (Number.isFinite(configuredStationTime) && configuredStationTime > 0) {
    const stationZoneFraction = clamp(
      Number(movement.displayStationZoneFraction) || 0.1,
      0.02,
      0.2,
    );
    const stationTime = clamp(
      configuredStationTime,
      stationZoneFraction + 0.01,
      0.45,
    );
    const middleDistance = 1 - stationZoneFraction * 2;
    const middleTime = 1 - stationTime * 2;
    const middleSpeed = middleDistance / middleTime;
    const stationExponent = middleSpeed * stationTime / stationZoneFraction;

    if (timeProgress < stationTime) {
      return stationZoneFraction
        * (timeProgress / stationTime) ** stationExponent;
    }
    if (timeProgress > 1 - stationTime) {
      return 1 - stationZoneFraction
        * ((1 - timeProgress) / stationTime) ** stationExponent;
    }
    return stationZoneFraction
      + (timeProgress - stationTime) * middleSpeed;
  }

  const displayPeakSpeedMultiplier = Math.max(
    1,
    Number(movement.displayPeakSpeedMultiplier) || 1,
  );
  // A symmetric acceleration/cruise/braking profile can reach at most twice
  // its average speed without adding another hold.
  const normalizedSpeed = Math.min(
    2,
    physicalNormalizedSpeed * displayPeakSpeedMultiplier,
  );
  const accelerationFraction = 1 - 1 / normalizedSpeed;

  if (timeProgress < accelerationFraction) {
    return normalizedSpeed * timeProgress ** 2 / (2 * accelerationFraction);
  }
  if (timeProgress > 1 - accelerationFraction) {
    return 1 - normalizedSpeed * (1 - timeProgress) ** 2 / (2 * accelerationFraction);
  }
  return normalizedSpeed * (timeProgress - accelerationFraction / 2);
}

export function positionForTrain(plan, now, segmentDurations, movement = {}) {
  const dwellSeconds = dwellSecondsFor(plan.code, movement);
  const calls = plan.calls.filter((call) => (
    Number.isFinite(call.arrivalMs) || Number.isFinite(call.departureMs)
  ));
  const dwelling = calls.find((call) => {
    if (!call.arrivalMs) return false;
    const departure = call.departureMs && call.departureMs > call.arrivalMs
      ? call.departureMs
      : call.arrivalMs + dwellSeconds * 1000;
    return call.arrivalMs <= now && departure >= now;
  });

  if (dwelling) {
    return {
      projected: dwelling.projected,
      fromName: dwelling.name,
      nextName: dwelling.name,
      nextRef: dwelling.ref,
      etaSeconds: 0,
      progress: 1,
      routeProgress: dwelling.routeIndex,
      phase: "station",
    };
  }

  const target = calls.find((call) => (
    (call.arrivalMs ?? call.departureMs ?? Infinity) > now
  ));
  if (!target) return null;

  const previous = plan.route.stops[target.routeIndex - 1];
  const arrival = target.arrivalMs ?? target.departureMs;
  if (!previous || !arrival) {
    // Do not render a future terminal departure for its entire feed horizon.
    // It becomes a visible train only when its calibrated platform dwell starts.
    if (arrival && now < arrival - dwellSeconds * 1000) return null;
    return {
      projected: target.projected,
      fromName: null,
      nextName: target.name,
      nextRef: target.ref,
      etaSeconds: 0,
      progress: 1,
      routeProgress: target.routeIndex,
      phase: "station",
    };
  }

  const scheduledPrevious = plan.calls.find((call) => call.routeIndex === target.routeIndex - 1);
  const observedDuration = segmentDurations.get(segmentKey(plan.code, previous.ref, target.ref));
  const intervalDuration = observedDuration
    ?? fallbackDuration(previous, target, plan.calls);
  const previousArrival = scheduledPrevious?.arrivalMs;
  const previousDeparture = scheduledPrevious?.departureMs;
  const departureOnly = !previousArrival && previousDeparture;
  const explicitDeparture = previousArrival
    && previousDeparture
    && previousDeparture > previousArrival;
  const reportedEvent = previousArrival ?? previousDeparture;
  const reportedInterval = reportedEvent
    ? (arrival - reportedEvent) / 1000 + (departureOnly ? dwellSeconds : 0)
    : null;
  const credibleReportedInterval = reportedInterval !== null
    && reportedInterval >= Math.max(MIN_SEGMENT_SECONDS, intervalDuration * 0.65)
    && reportedInterval <= Math.min(MAX_SEGMENT_SECONDS, intervalDuration * 1.75);
  const eventStart = credibleReportedInterval
    ? reportedEvent
    : arrival - intervalDuration * 1000;
  const movementStart = credibleReportedInterval && (departureOnly || explicitDeparture)
    ? previousDeparture
    : eventStart + dwellSeconds * 1000;

  // With only one upcoming call, the calibrated interval may not have begun
  // yet. Hiding the marker is more truthful than parking a future train at the
  // previous station for up to an hour.
  if (now < eventStart) return null;

  const movementDuration = Math.max(1, (arrival - movementStart) / 1000);
  const linearProgress = clamp((now - movementStart) / (movementDuration * 1000), 0, 1);
  const easedProgress = movementProgress(
    linearProgress,
    movementDuration,
    distanceMetres(previous.coordinates, target.coordinates),
    movement,
  );
  const routeProgress = previous.routeIndex + easedProgress;

  return {
    projected: projectedForProgress(plan.route, routeProgress),
    fromName: previous.name,
    nextName: target.name,
    nextRef: target.ref,
    etaSeconds: Math.max(0, (arrival - now) / 1000),
    progress: linearProgress,
    routeProgress,
    phase: "between",
  };
}
