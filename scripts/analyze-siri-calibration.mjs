import { readdir, readFile, writeFile } from "node:fs/promises";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import STATIONS from "../src/data/stations.json" with { type: "json" };
import GEOMETRY from "../src/data/metro-geometry.json" with { type: "json" };
import CURRENT_CALIBRATION from "../src/data/movement-calibration.json" with { type: "json" };
import { buildRouteModels, matchJourney } from "../src/lib/train-model.js";

const decompress = promisify(gunzip);
const DEFAULT_INPUT = new URL("../data/siri-calibration/", import.meta.url);

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.round((sorted.length - 1) * fraction)];
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function option(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

async function snapshotFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, root);
    if (entry.isDirectory()) return snapshotFiles(url);
    return entry.name.endsWith(".json.gz") ? [url] : [];
  }));
  return nested.flat().sort((left, right) => left.pathname.localeCompare(right.pathname));
}

async function loadSnapshots(root) {
  const files = await snapshotFiles(root);
  return Promise.all(files.map(async (file) => (
    JSON.parse((await decompress(await readFile(file))).toString("utf8"))
  )));
}

function distanceMetres(left, right) {
  const latitude = (left[1] + right[1]) * Math.PI / 360;
  const dx = (right[0] - left[0]) * 111_320 * Math.cos(latitude);
  const dy = (right[1] - left[1]) * 110_540;
  return Math.hypot(dx, dy);
}

function robustJourneyObservation(observations) {
  // SIRI revises a call as the train approaches it. The observation nearest
  // the segment's predicted arrival is the least speculative one, while still
  // retaining segments captured only before their train reached them.
  return observations.reduce((best, observation) => (
    Math.abs(observation.capturedAt - observation.end)
      < Math.abs(best.capturedAt - best.end)
      ? observation
      : best
  ));
}

function filterOutliers(values) {
  if (values.length < 4) return values;
  const centre = median(values);
  const mad = median(values.map((value) => Math.abs(value - centre)));
  const tolerance = Math.max(12, mad * 3);
  return values.filter((value) => Math.abs(value - centre) <= tolerance);
}

function runningSeconds(distance, acceleration, maximumSpeed) {
  const accelerationDistance = maximumSpeed ** 2 / acceleration;
  return distance <= accelerationDistance
    ? 2 * Math.sqrt(distance / acceleration)
    : distance / maximumSpeed + maximumSpeed / acceleration;
}

function fitMovement(rows) {
  let best = null;
  for (let dwell = 0; dwell <= 35; dwell += 1) {
    for (let acceleration = 0.6; acceleration <= 1.4; acceleration += 0.05) {
      for (let maximumSpeed = 12; maximumSpeed <= 25; maximumSpeed += 0.5) {
        const errors = rows.map((row) => Math.abs(
          row.seconds - dwell - runningSeconds(row.distance, acceleration, maximumSpeed)
        ));
        const score = median(errors);
        if (!best || score < best.score) {
          best = { dwell, acceleration, maximumSpeed, score };
        }
      }
    }
  }
  return best;
}

function summarize(values) {
  return {
    min: percentile(values, 0),
    p25: percentile(values, 0.25),
    median: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    max: percentile(values, 1),
  };
}

const input = new URL(option("input", DEFAULT_INPUT.href), import.meta.url);
const outputOption = option("output", null);
const movementMode = option("movement", "refit");
if (!["refit", "stable"].includes(movementMode)) {
  throw new Error("Invalid --movement; use refit or stable");
}
const snapshots = await loadSnapshots(input);
if (!snapshots.length) throw new Error(`No .json.gz snapshots found below ${input.pathname}`);

const routes = buildRouteModels(STATIONS, GEOMETRY);
const observationsByJourneySegment = new Map();
let matchedJourneys = 0;

for (const snapshot of snapshots) {
  const capturedAt = Date.parse(snapshot.capturedAt);
  for (const journey of snapshot.journeys ?? []) {
    const match = matchJourney(journey, routes);
    if (!match) continue;
    matchedJourneys += 1;
    for (let index = 1; index < match.calls.length; index += 1) {
      const from = match.calls[index - 1];
      const to = match.calls[index];
      if (to.routeIndex !== from.routeIndex + 1) continue;
      const start = from.departureMs ?? from.arrivalMs;
      const end = to.arrivalMs ?? to.departureMs;
      const seconds = start && end ? (end - start) / 1000 : NaN;
      if (seconds < 20 || seconds > 8 * 60) continue;
      const segment = `${journey.code}:${from.ref}:${to.ref}`;
      const key = `${segment}\u0000${journey.id}`;
      const group = observationsByJourneySegment.get(key) ?? {
        segment,
        code: journey.code,
        from,
        to,
        observations: [],
      };
      group.observations.push({ capturedAt, end, seconds });
      observationsByJourneySegment.set(key, group);
    }
  }
}

const samplesBySegment = new Map();
const journeySamples = [];
for (const group of observationsByJourneySegment.values()) {
  const observation = robustJourneyObservation(group.observations);
  journeySamples.push({
    key: group.segment,
    code: group.code,
    from: group.from,
    to: group.to,
    ...observation,
  });
  const sample = samplesBySegment.get(group.segment) ?? {
    code: group.code,
    from: group.from,
    to: group.to,
    values: [],
  };
  sample.values.push(observation.seconds);
  samplesBySegment.set(group.segment, sample);
}

const rows = [...samplesBySegment.entries()].flatMap(([key, sample]) => {
  const values = filterOutliers(sample.values);
  if (!values.length) return [];
  return [{
    key,
    code: sample.code,
    fromRef: sample.from.ref,
    toRef: sample.to.ref,
    fromName: sample.from.name,
    toName: sample.to.name,
    samples: values.length,
    seconds: median(values),
    p10: percentile(values, 0.1),
    p90: percentile(values, 0.9),
    distance: distanceMetres(sample.from.coordinates, sample.to.coordinates),
  }];
});

const trustedRows = rows.filter((row) => row.samples >= 2);
const globalFit = fitMovement(trustedRows);
const residualDwell = (lineRows, fit = globalFit) => Math.round(Math.max(12, Math.min(30, median(
  lineRows.map((row) => (
    row.seconds - runningSeconds(row.distance, fit.acceleration, fit.maximumSpeed)
  )),
))));
const capturedTimes = snapshots.map((snapshot) => Date.parse(snapshot.capturedAt));
const intervals = capturedTimes.slice(1).map((value, index) => (value - capturedTimes[index]) / 1000);
const validationCutoff = capturedTimes[0] + (capturedTimes.at(-1) - capturedTimes[0]) * 0.6;
const validationTraining = new Map();
for (const sample of journeySamples.filter((sample) => sample.capturedAt < validationCutoff)) {
  const values = validationTraining.get(sample.key) ?? [];
  values.push(sample.seconds);
  validationTraining.set(sample.key, values);
}
const validationSamples = journeySamples.filter((sample) => (
  sample.capturedAt >= validationCutoff
  && (validationTraining.get(sample.key)?.length ?? 0) >= 2
));
const sampleByKey = new Map(journeySamples.map((sample) => [sample.key, sample]));
const validationTrainingRows = [...validationTraining.entries()].flatMap(([key, rawValues]) => {
  const values = filterOutliers(rawValues);
  const sample = sampleByKey.get(key);
  if (!sample || !values.length) return [];
  return [{
    key,
    code: sample.code,
    samples: values.length,
    seconds: median(values),
    distance: distanceMetres(sample.from.coordinates, sample.to.coordinates),
  }];
});
const validationTrustedRows = validationTrainingRows.filter((row) => row.samples >= 2);
const validationFit = fitMovement(validationTrustedRows);
const validationDwellByLine = Object.fromEntries(Object.keys(STATIONS).map((code) => [
  code,
  residualDwell(
    validationTrustedRows.filter((row) => row.code === code),
    validationFit,
  ),
]));
const stableFit = {
  acceleration: CURRENT_CALIBRATION.motion.accelerationMetresPerSecondSquared,
  maximumSpeed: CURRENT_CALIBRATION.motion.maximumSpeedMetresPerSecond,
};
const stableDwellByLine = Object.fromEntries(Object.entries(CURRENT_CALIBRATION.lines)
  .map(([code, line]) => [code, line.dwellSeconds]));
const constrainedErrors = (fit, dwellByLine) => validationSamples.map((sample) => {
  const observedSeconds = median(filterOutliers(validationTraining.get(sample.key)));
  const modelSeconds = dwellByLine[sample.code] + runningSeconds(
    distanceMetres(sample.from.coordinates, sample.to.coordinates),
    fit.acceleration,
    fit.maximumSpeed,
  );
  const predictedSeconds = Math.max(
    modelSeconds * 0.65,
    Math.min(modelSeconds * 1.75, observedSeconds),
  );
  return Math.abs(sample.seconds - predictedSeconds);
});
const calibratedErrors = validationSamples.map((sample) => Math.abs(
  sample.seconds - median(filterOutliers(validationTraining.get(sample.key))),
));
const refitConstrainedErrors = constrainedErrors(validationFit, validationDwellByLine);
const stableConstrainedErrors = constrainedErrors(stableFit, stableDwellByLine);
const genericErrors = validationSamples.map((sample) => Math.abs(
  sample.seconds - Math.max(55, Math.min(
    210,
    42 + distanceMetres(sample.from.coordinates, sample.to.coordinates) / 11.5,
  )),
));
const lines = Object.fromEntries(Object.keys(STATIONS).map((code) => {
  const lineRows = rows.filter((row) => row.code === code && row.samples >= 2);
  return [code, {
    segments: lineRows.length,
    journeySamples: lineRows.reduce((total, row) => total + row.samples, 0),
    intervalSeconds: summarize(lineRows.map((row) => row.seconds)),
    residualDwellSeconds: residualDwell(lineRows),
    fit: fitMovement(lineRows),
  }];
}));

const report = {
  capture: {
    snapshots: snapshots.length,
    from: snapshots[0].capturedAt,
    to: snapshots.at(-1).capturedAt,
    intervalSeconds: summarize(intervals),
    journeyRows: snapshots.reduce((total, snapshot) => total + snapshot.journeys.length, 0),
    matchedJourneyRows: matchedJourneys,
    uniqueJourneySegments: observationsByJourneySegment.size,
  },
  calibration: {
    directedSegments: rows.length,
    directedSegmentsWithMultipleJourneys: rows.filter((row) => row.samples >= 2).length,
    globalFit,
    validation: {
      cutoff: new Date(validationCutoff).toISOString(),
      heldOutJourneySegments: validationSamples.length,
      calibratedMedianAbsoluteErrorSeconds: Math.round(median(calibratedErrors) * 10) / 10,
      calibratedP90AbsoluteErrorSeconds: Math.round(percentile(calibratedErrors, 0.9) * 10) / 10,
      genericMedianAbsoluteErrorSeconds: Math.round(median(genericErrors) * 10) / 10,
      genericP90AbsoluteErrorSeconds: Math.round(percentile(genericErrors, 0.9) * 10) / 10,
      refitConstrainedMedianAbsoluteErrorSeconds:
        Math.round(median(refitConstrainedErrors) * 10) / 10,
      refitConstrainedP90AbsoluteErrorSeconds:
        Math.round(percentile(refitConstrainedErrors, 0.9) * 10) / 10,
      stableConstrainedMedianAbsoluteErrorSeconds:
        Math.round(median(stableConstrainedErrors) * 10) / 10,
      stableConstrainedP90AbsoluteErrorSeconds:
        Math.round(percentile(stableConstrainedErrors, 0.9) * 10) / 10,
    },
    lines,
  },
};

if (outputOption) {
  const outputFit = movementMode === "stable" ? stableFit : globalFit;
  const outputDwellByLine = movementMode === "stable"
    ? stableDwellByLine
    : Object.fromEntries(Object.entries(lines)
      .map(([code, line]) => [code, line.residualDwellSeconds]));
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  const physicalRows = new Map();
  for (const row of trustedRows) {
    const names = [row.fromName, row.toName].sort().join("\u0000");
    const key = `${row.code}:${names}`;
    const group = physicalRows.get(key) ?? [];
    group.push(row);
    physicalRows.set(key, group);
  }

  const segments = {};
  for (const [code, directions] of Object.entries(routes)) {
    for (const route of directions) {
      for (let index = 1; index < route.stops.length; index += 1) {
        const from = route.stops[index - 1];
        const to = route.stops[index];
        const key = `${code}:${from.ref}:${to.ref}`;
        if (segments[key]) continue;
        const direct = rowsByKey.get(key);
        const names = [from.name, to.name].sort().join("\u0000");
        const physical = physicalRows.get(`${code}:${names}`) ?? [];
        const physicalValues = physical.flatMap((row) => (
          Array.from({ length: row.samples }, () => row.seconds)
        ));
        const modelSeconds = outputDwellByLine[code]
          + runningSeconds(
            distanceMetres(from.coordinates, to.coordinates),
            outputFit.acceleration,
            outputFit.maximumSpeed,
          );
        const observedSeconds = direct?.samples >= 2
          ? direct.seconds
          : median(physicalValues);
        // Erratic feeds occasionally publish impossible 10-second hops or
        // multi-minute reversals. Keep the measured timing when physically
        // credible, and otherwise constrain it around the fitted line model.
        const seconds = observedSeconds === null
          ? modelSeconds
          : Math.max(modelSeconds * 0.65, Math.min(modelSeconds * 1.75, observedSeconds));
        segments[key] = {
          seconds: Math.round(seconds * 10) / 10,
          samples: direct?.samples ?? physical.reduce((total, row) => total + row.samples, 0),
          source: direct?.samples >= 2 ? "direct" : physical.length ? "reverse" : "model",
        };
      }
    }
  }

  const calibration = {
    schemaVersion: 1,
    generatedAt: snapshots.at(-1).capturedAt,
    source: {
      description: "SIRI EstimatedTimetable, Saturday daytime and evening",
      snapshots: snapshots.length,
      from: snapshots[0].capturedAt,
      to: snapshots.at(-1).capturedAt,
      journeyRows: report.capture.journeyRows,
      matchedJourneyRows: report.capture.matchedJourneyRows,
      uniqueJourneySegments: observationsByJourneySegment.size,
      movementModel: movementMode === "stable"
        ? "Retained stable parameters; expanded capture updates segment timings"
        : "Refitted from expanded capture",
      validation: report.calibration.validation,
    },
    motion: movementMode === "stable"
      ? CURRENT_CALIBRATION.motion
      : {
        accelerationMetresPerSecondSquared: Math.round(globalFit.acceleration * 100) / 100,
        maximumSpeedMetresPerSecond: Math.round(globalFit.maximumSpeed * 10) / 10,
        defaultDwellSeconds: Math.round(globalFit.dwell),
      },
    lines: Object.fromEntries(Object.entries(outputDwellByLine).map(([code, dwellSeconds]) => [
      code,
      { dwellSeconds },
    ])),
    segments,
  };
  await writeFile(new URL(outputOption, import.meta.url), `${JSON.stringify(calibration, null, 2)}\n`);
  const sourceCounts = {};
  for (const segment of Object.values(segments)) {
    sourceCounts[segment.source] = (sourceCounts[segment.source] ?? 0) + 1;
  }
  report.output = {
    file: new URL(outputOption, import.meta.url).pathname,
    movementMode,
    segments: Object.keys(segments).length,
    sources: sourceCounts,
  };
}

console.log(JSON.stringify(report, null, 2));
