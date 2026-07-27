# Train movement and SIRI interpolation

## Purpose

SIRI EstimatedTimetable does not provide a continuous GPS position for each
Métro train. It provides a journey identity and estimated arrival/departure
times at stops. The map therefore combines live stop predictions with a
calibrated movement model to estimate where a train is between two stations.

The important distinction is:

- Live SIRI decides which journey is being shown, its direction, destination,
  next predicted stop, and the time anchor for that stop.
- Calibration supplies realistic station-to-station durations and dwell times
  when the live response is incomplete or internally inconsistent.
- Interpolation turns those discrete times into a new map position on every
  animation frame.

This is an estimated position, not a measured train location.

## Source precedence

| Source | What it controls | When it changes |
| --- | --- | --- |
| Current SIRI response | Journey ID, line, direction, destination, upcoming calls, and arrival/departure anchors | On each `/api/trains` refresh |
| Recent live SIRI history | A small adjustment to the calibrated duration when at least four distinct current journeys agree | As snapshots accumulate |
| `src/data/movement-calibration.json` | Baseline duration for every directed interstation, per-line dwell, acceleration, and maximum speed | When calibration is regenerated |
| Distance fallback | Last-resort segment duration if no calibrated or recent observation exists | Only for an unknown segment |
| Browser clock | Continuous progress between the chosen departure and arrival anchors | Every rendered frame |

In short, the live arrival time is the destination in time; interpolation
decides how the train moves toward it.

## Offline calibration

The calibration was produced from 279 compressed snapshots captured between
2026-07-25 11:17:01Z and 20:23:42Z. The source contained 178,329 journey rows
and 37,783 unique journey/segment observations.

The generator is
[`scripts/analyze-siri-calibration.mjs`](../scripts/analyze-siri-calibration.mjs).
It performs the following steps.

### 1. Match calls to a route

Each SIRI journey is matched against the known platform references in
`src/data/stations.json`. Candidate directions score:

- 10 points for each matched call;
- 4 points for each pair moving forward through the route;
- minus 12 points for each reversal.

The best-scoring direction becomes the train's route. Directional platforms
are collapsed onto one physical station coordinate so trains in both
directions follow the same geographic centreline.

### 2. Extract directed segment observations

Only consecutive route stops are accepted. For a segment `A -> B`, the sample
is:

```text
segment interval = arrival at B - departure/event time at A
```

Samples below 20 seconds or above 8 minutes are rejected.

The same journey appears in many consecutive snapshots. Counting every copy
would heavily bias the result toward long-lived journeys, so observations are
first grouped by journey and segment. The revision captured closest to the
predicted arrival is retained as that journey's representative sample.

### 3. Remove forecast outliers

For a segment with at least four journey samples, the generator computes the
median absolute deviation (MAD). Values farther from the median than the
larger of 12 seconds or `3 × MAD` are discarded.

This matters because the captured SIRI feed occasionally contains
out-of-sequence calls, impossible ten-second hops, or multi-minute reversals.

### 4. Fit dwell and physical movement

The observed station-to-station interval is modelled as:

```text
station interval = dwell + acceleration/cruise/braking run time
```

The generator grid-searches:

- dwell: 0–35 seconds;
- effective acceleration: 0.6–1.4 m/s²;
- maximum speed: 12–25 m/s.

It minimizes median absolute error over the observed directed segments. An
unconstrained refit on the expanded Saturday capture proposed a 34-second
default dwell, 1.2 m/s² acceleration, and 15 m/s maximum speed. Time-separated
validation did not improve meaningfully, however, and the fit collapsed most
per-line dwell estimates to 30 seconds. The generated calibration therefore
uses stable movement mode and retains:

- default dwell: 21 seconds;
- effective acceleration: 0.6 m/s²;
- maximum speed: 23 m/s;
- per-line dwell: 12–30 seconds.

These are effective display parameters fitted against station timing and
straight-line station distance. They should not be read as measurements of a
specific rolling stock model.

### 5. Build complete segment coverage

`src/data/movement-calibration.json` contains all 750 directed route segments:

- 593 use direct measurements from at least two journeys;
- 56 use the measured reverse-direction physical segment;
- 101 use the retained distance model because the capture had no reliable
  observation.

Even measured values are constrained to 65–175% of the retained physical model.
This preserves real segment differences without accepting extreme SIRI
errors.

### 6. Validate chronologically

The first 60% of the capture is used to predict journey/segment observations
from the remaining 40%. On 14,880 held-out observations:

- stable expanded candidate median absolute error: 17.8 seconds;
- stable expanded candidate 90th-percentile error: 57.9 seconds;
- unconstrained measured-segment median / 90th-percentile error:
  17.7 seconds / 56.2 seconds;
- generic distance fallback median / 90th-percentile error:
  21.3 seconds / 58.3 seconds.

The expanded recording primarily improves coverage and sample support rather
than the headline median. It slightly improves the long tail while keeping the
established motion feel. This validation measures stop-interval prediction,
not exact tunnel position.

## Runtime algorithm

The runtime is implemented primarily in
[`train-model.js`](../src/lib/train-model.js), with orchestration and rendering in
[`map.js`](../src/map.js).

### 1. Normalize the live response

[`api/trains.js`](../api/trains.js) converts the SIRI response into compact journeys containing:

- line code and journey ID;
- direction and destination;
- platform reference;
- expected arrival and departure.

It keeps calls from five minutes in the past through one hour in the future.
The recent past call is useful because it can provide a real start anchor for
the current segment.

### 2. Start from the static baseline

On startup, the application loads all segment durations from
`src/data/movement-calibration.json`.

The browser also loads up to 24 recent snapshots from IndexedDB. For each
segment, repeated revisions from the same journey are collapsed to one median
before journeys are combined.

If at least four distinct recent journeys agree on a different duration:

1. the recent median is limited to 65–175% of the static value;
2. the effective duration becomes 75% static calibration and 25% recent live
   conditions.

This allows modest adaptation to current traffic without letting one corrupt
response redefine train speed.

### 3. Decide whether the train is at a station

For each frame, the model first checks whether the current time lies between a
call's arrival and departure.

- If SIRI gives a later departure, that explicit dwell is used.
- If arrival and departure are equal, the calibrated per-line dwell is used.

During this interval the marker remains exactly on the station.

A future terminal journey is hidden until its dwell window begins. This
prevents trains scheduled far into the feed horizon from appearing parked at
a terminus for an hour.

### 4. Select the current interstation

The first live call whose arrival/departure is still in the future is the
target station. The preceding station in the matched route is the segment
origin.

Let:

```text
C = calibrated station-to-station duration
R = station-to-station interval reported by the current SIRI journey
```

The reported interval is trusted only when:

```text
max(20 seconds, 0.65 × C) <= R <= min(8 minutes, 1.75 × C)
```

If `R` is credible, the live previous call anchors the start and the live next
arrival anchors the end.

If the previous call is missing or `R` is implausible, the model works
backward from the live next arrival:

```text
inferred station event = live next arrival - C
movement start = inferred station event + calibrated dwell
```

Therefore a bad previous timestamp does not make the train crawl for several
minutes or jump across multiple stations, while a changing live next-arrival
prediction still moves the target timeline.

If the inferred segment has not started yet, the marker is not rendered.

### 5. Interpolate within the segment

The browser computes linear time progress:

```text
time progress = (now - movement start) / (arrival - movement start)
```

The value is clamped to `[0, 1]`, then converted to distance progress with a
three-phase kinematic profile:

1. quadratic acceleration;
2. constant-speed cruise when the segment is long enough;
3. quadratic braking.

The acceleration-phase duration is derived from segment distance, available
movement time, fitted acceleration, and fitted maximum speed. Very short
segments become triangular profiles with acceleration followed immediately
by braking.

The map divides each interstation into two 10% station zones and an 80% middle
crossing. Each station zone receives 22% of the movement clock; the middle
receives 56%. The train therefore accelerates through the first zone, crosses
the middle at a sustained 1.43 times average speed, and brakes through the
final zone. Velocity remains continuous and the departure, midpoint, and
arrival anchors stay unchanged.

This differs from the previous smoothstep interpolation, which accelerated
for roughly half of every segment and decelerated for the other half. The
current profile concentrates more visible motion in the middle while retaining
soft departures and arrivals.

### 6. Place the marker on the route

Distance progress is added to the origin station's route index:

```text
route progress = origin index + distance progress
```

The coordinate is sampled from a restrained cubic Hermite/Catmull–Rom curve
through the station centres. This keeps the marker on the rendered line and
rounds sharp station-to-station chords.

### 7. Reconcile a new live refresh

Between API responses, `Date.now()` advances the same timeline every frame, so
movement remains continuous without new network data.

When new SIRI times arrive, a persistent render state reconciles the newly
computed route progress with the currently displayed progress:

- out-of-order calls are reduced to the longest forward-only station sequence
  before they reach interpolation;
- recent calls omitted from a partial revision are carried across the refresh,
  while revised calls for the same station still replace the old prediction;
- a journey missing from one incomplete response keeps its last plan for a
  bounded grace window, and can hold its last rendered position if the new
  plan is temporarily unplaceable;
- a delayed prediction never moves a train backward; the train holds for up
  to 30 seconds, then fades out and reappears on the corrected timeline if it
  still has not caught up;
- a forward correction is limited to one interstation per 45 seconds;
- a discontinuity larger than 1.25 interstations is treated as a relocation
  and cross-fades to the corrected position instead of flying across the map;
- new markers fade in gently, while expired or temporarily unplaceable
  markers fade out at the end of their bounded retention window.

The new snapshot remains authoritative for every call it reports.
Reconciliation only fills temporary omissions from recent history and expires
that fallback on a bounded clock.

## Live versus interpolated example

Suppose the live response says:

```text
previous station event: 14:03:00
next-station arrival:    14:04:30
calibrated dwell:        20 seconds
```

The station interval is 90 seconds. The marker:

- stays at the previous station from 14:03:00 to 14:03:20;
- accelerates after 14:03:20;
- cruises through the middle of the route;
- brakes toward the next station;
- reaches the next station at 14:04:30.

If the next refresh changes the arrival to 14:04:45, the marker does not
reverse. It holds or advances more slowly until the revised timeline catches
up. If that correction still has not resolved after 30 seconds, the marker
fades to the corrected position.

If the previous event were missing, the same 90-second calibrated interval
would be counted backward from the live 14:04:30 arrival, preserving the live
arrival target while estimating the absent departure.

## Regenerating the calibration

Capture a new two-hour series:

```bash
npm run snapshot:calibrate
```

Generate the report and overwrite `src/data/movement-calibration.json`:

```bash
npm run analyze:calibration
```

The package command keeps the established movement and dwell parameters while
refreshing segment timings. To deliberately test a complete motion refit, run:

```bash
node scripts/analyze-siri-calibration.mjs \
  --output=../src/data/movement-calibration.json \
  --movement=refit
```

Then verify:

```bash
npm test
npm run build
```

The analyzer recursively reads `data/siri-calibration/**/*.json.gz`, so move
old captures elsewhere first if the intention is to fit only one specific
period.

## Known limitations

- EstimatedTimetable supplies stop predictions, not train GPS or odometry.
- Exact position inside a tunnel cannot be independently validated from this
  dataset.
- The route must already exist in `src/data/stations.json` and
  `src/data/metro-geometry.json`; an unknown branch cannot be placed accurately.
- Station intervals can reflect operational delay as well as pure run time.
- A Saturday-afternoon calibration may not fully represent weekday peak dwell
  behavior, although recent live journeys can adjust the baseline by 25%.
- The holdout statistics describe timing accuracy, not metre-level position
  accuracy.
