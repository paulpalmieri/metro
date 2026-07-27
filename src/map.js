import "@fontsource/fira-sans-condensed/latin-500.css";
import "@fontsource/fira-sans-condensed/latin-600.css";
import { inject } from "@vercel/analytics";
import STATIONS from "./data/stations.json";
import GEOMETRY from "./data/metro-geometry.json";
import MOVEMENT_CALIBRATION from "./data/movement-calibration.json";
import { placeStationLabel } from "./lib/label-placement.js";
import {
  buildRouteModels,
  buildSegmentDurations,
  buildTrainPlans,
  clamp,
  positionForTrain,
  project,
  projectedForRouteProgress,
  reconcileTrainPlans,
  reconcileRouteProgress,
  sampleRouteCurve,
  segmentDurationsFromCalibration,
} from "./lib/train-model.js";
import { loadRecentSnapshots, saveSnapshot } from "./lib/train-history.js";
import { onTraffic, startTraffic, statusFor } from "./lib/traffic.js";

inject();

const LINES = [
  ["1", "#FFCE00"], ["2", "#0064B0"], ["3", "#9F9825"], ["3bis", "#98D4E2"],
  ["4", "#C04191"], ["5", "#F28E42"], ["6", "#83C491"], ["7", "#F3A4BA"],
  ["7bis", "#83C491"], ["8", "#CEADD2"], ["9", "#D5C900"], ["10", "#E3B32A"],
  ["11", "#8D5E2A"], ["12", "#00814F"], ["13", "#98D4E2"], ["14", "#662483"],
].map(([label, color]) => ({
  label,
  color,
  pictogram: `/metro-pictograms/${label}.svg`,
}));

const PICTOGRAM_PRELOADS = LINES.map((line) => {
  const image = new Image();
  image.src = line.pictogram;
  return image;
});

const TRAFFIC_STATUS_TEXT = {
  ok: "Trafic normal",
  info: "Information trafic",
  delays: "Trafic perturbé",
  blocked: "Trafic interrompu",
};

const LINE_BY_CODE = new Map(LINES.map((line) => [line.label, line]));
const LINE_ORDER = new Map(LINES.map((line, index) => [line.label, index]));
const LINE_BUTTONS = new Map();
const ROUTES = buildRouteModels(STATIONS, GEOMETRY);
const CALIBRATED_SEGMENT_DURATIONS = segmentDurationsFromCalibration(MOVEMENT_CALIBRATION);
const MOVEMENT = {
  ...MOVEMENT_CALIBRATION.motion,
  lines: MOVEMENT_CALIBRATION.lines,
  displayStationZoneFraction: 0.1,
  displayStationTimeFraction: 0.22,
};
const CENTERLINES = Object.fromEntries(Object.entries(ROUTES).map(([code, routes]) => {
  const points = new Map();
  const paths = [];
  const signatures = new Set();
  for (const route of routes) {
    for (const stop of route.stops) points.set(stop.name, stop.projected);
    const names = route.stops.map((stop) => stop.name);
    const forward = names.join("\u0000");
    const reverse = [...names].reverse().join("\u0000");
    const signature = forward < reverse ? forward : reverse;
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    paths.push(sampleRouteCurve(route));
  }
  const segments = paths.flatMap((path) => path.slice(1).map((point, index) => [path[index], point]));
  return [code, { points: [...points.values()], paths, segments }];
}));
const OVERVIEW_STATIONS = (() => {
  const stations = new Map();
  for (const [code, routes] of Object.entries(ROUTES)) {
    const seenOnLine = new Set();
    for (const route of routes) {
      for (const [index, stop] of route.stops.entries()) {
        const isTerminal = index === 0 || index === route.stops.length - 1;
        if (seenOnLine.has(stop.name)) {
          const station = stations.get(stop.name);
          if (station && isTerminal) station.isTerminal = true;
          continue;
        }
        seenOnLine.add(stop.name);
        const station = stations.get(stop.name) ?? {
          name: stop.name,
          x: 0,
          y: 0,
          samples: 0,
          lines: new Set(),
          isTerminal: false,
        };
        station.x += stop.projected.x;
        station.y += stop.projected.y;
        station.samples += 1;
        station.lines.add(code);
        station.isTerminal ||= isTerminal;
        stations.set(stop.name, station);
      }
    }
  }
  return [...stations.values()]
    .map((station) => ({
      name: station.name,
      projected: {
        x: station.x / station.samples,
        y: station.y / station.samples,
      },
      lineCount: station.lines.size,
      lines: [...station.lines].sort((left, right) => (
        LINE_ORDER.get(left) - LINE_ORDER.get(right)
      )),
      isTerminal: station.isTerminal,
    }))
    .sort((left, right) => (
      right.lineCount - left.lineCount
      || Number(right.isTerminal) - Number(left.isTerminal)
      || left.name.localeCompare(right.name, "fr")
    ));
})();
const OVERVIEW_STATION_BY_NAME = new Map(
  OVERVIEW_STATIONS.map((station) => [station.name, station]),
);
const OVERVIEW_SEGMENTS = Object.values(CENTERLINES).flatMap((line) => line.segments);
const TILE_SIZE = 256;
const STATION_BLUE = getComputedStyle(document.documentElement)
  .getPropertyValue("--station-blue")
  .trim() || "#1556a0";
const STATION_LABEL_FONT_FAMILY = "\"Fira Sans Condensed\", \"Arial Narrow\", sans-serif";
const STATION_LABEL_FONT_LOAD = "500 15px \"Fira Sans Condensed\"";
const STATION_LABEL_LETTER_SPACING = ".2px";
const STATION_LABEL_FONT_READY = document.fonts
  ? document.fonts.load(STATION_LABEL_FONT_LOAD, "Métro").catch(() => [])
  : Promise.resolve([]);
const MIN_ZOOM = 10.75;
const MAX_ZOOM = 17.35;
const OVERVIEW_LABEL_ENTER_ZOOM = MIN_ZOOM + (MAX_ZOOM - MIN_ZOOM) * .55;
const OVERVIEW_LABEL_EXIT_ZOOM = OVERVIEW_LABEL_ENTER_ZOOM - .12;
const OVERVIEW_INTERCHANGE_ZOOM = MIN_ZOOM + (MAX_ZOOM - MIN_ZOOM) * .7;
const OVERVIEW_TERMINAL_ZOOM = MIN_ZOOM + (MAX_ZOOM - MIN_ZOOM) * .8;
const OVERVIEW_ALL_STATIONS_ZOOM = MIN_ZOOM + (MAX_ZOOM - MIN_ZOOM) * .9;
const OVERVIEW_FULL_DETAIL_ZOOM = MAX_ZOOM - .12;
const OVERVIEW_LABEL_FADE_DURATION = 180;
const TRAIN_FOLLOW_MIN_ZOOM = MAX_ZOOM - .35;
const OVERVIEW_ZOOM_BIAS = { mobile: 4, desktop: 2.7 };
const OVERVIEW_FOCUS_STATION = "Châtelet";
const TILE_CACHE_LIMIT = 180;
const ROUTE_WIDTH = 3.6;
const ROUTE_CASING_WIDTH = 5.8;
const LABEL_ENTER_DURATION = 160;
const LABEL_EXIT_DURATION = 160;
const LABEL_ZOOM_DURATION = 180;
const MIN_TRAIN_RETENTION_MS = 3 * 60_000;
const MAX_TRAIN_RETENTION_MS = 10 * 60_000;
const MAX_POSITION_HOLD_MS = 3 * 60_000;
const MAX_BACKWARD_HOLD_MS = 30_000;
const MAX_TRAIN_PROGRESS_RATE = 1 / 25_000;
const TRAIN_ENTRY_FADE_MS = 3_000;
const TRAIN_EXIT_FADE_MS = 4_000;
const TRAIN_RELOCATION_FADE_MS = 1_000;
const TRAIN_SCALE_START_ZOOM = 13;
const TRAIN_MAX_SCALE = 2;
const LABEL_TIER_RANK = { core: 0, medium: 1, detail: 2 };
const prefersReducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const map = document.querySelector("#map");
const baseCanvas = document.querySelector("#baseMap");
const liveCanvas = document.querySelector("#liveMap");
const focusCanvas = document.createElement("canvas");
const baseContext = baseCanvas.getContext("2d", { alpha: false });
const liveContext = liveCanvas.getContext("2d");
const focusContext = focusCanvas.getContext("2d");
const lines = document.querySelector("#lines");
const stationDetails = document.querySelector("#stationDetails");
const stationDetailsLines = document.querySelector("#stationDetailsLines");
const metroLoader = document.querySelector("#metroLoader");
const metroLoaderBadge = document.querySelector("#metroLoaderBadge");
const hideLinesOption = document.querySelector("#hideLinesOption");

const paris = project([2.3488, 48.8566]);
const camera = {
  x: paris.x,
  y: paris.y,
  zoom: 12.5,
  targetX: paris.x,
  targetY: paris.y,
  targetZoom: 12.5,
  velocityX: 0,
  velocityY: 0,
};

let viewport = {
  width: 1,
  height: 1,
  ratio: 1,
  scaleX: 1,
  scaleY: 1,
  pixelWidth: 1,
  pixelHeight: 1,
};
let baseDirty = true;
let selectedCode = null;
let snapshot = null;
let snapshots = [];
let plans = [];
let segmentDurations = new Map(CALIBRATED_SEGMENT_DURATIONS);
let liveRecords = [];
let activeTrainId = null;
let trainRetentionMs = MIN_TRAIN_RETENTION_MS;
let requestInFlight = false;
let lastFrame = performance.now();
let lastLiveDraw = 0;
let refreshTimer = null;
let viewportResizeFrame = null;
let labelTransition = null;
let overviewLabelsActive = false;
let overviewLabelLayout = null;
let stationLabelHitRecords = [];
let activeStationName = null;
let stationDetailsHideTimer = null;
let stationDetailsWidth = 0;
let stationDetailsHeight = 0;
let networkHidden = false;
const labelZoomStates = {
  core: { opacity: 0, from: 0, target: 0, startedAt: 0 },
  medium: { opacity: 0, from: 0, target: 0, startedAt: 0 },
  detail: { opacity: 0, from: 0, target: 0, startedAt: 0 },
};

const tileCache = new Map();
const renderStates = new Map();
const pointers = new Map();
let gesture = null;
let pressedTrain = null;
let loaderStep = 0;
let loaderDataReady = false;
let loaderFontReady = false;
let loaderFinished = false;
let loaderTimer = null;

const LOADER_STEP_MS = 170;

function applyLinePictogram(pictogram, line) {
  let image = pictogram.querySelector(".metro-picto__image");
  if (!image) {
    image = document.createElement("img");
    image.className = "metro-picto__image";
    image.alt = "";
    pictogram.prepend(image);
  }
  image.src = line.pictogram;
  pictogram.dataset.line = line.label;
}

function createLinePictogram(line, className, ariaLabel) {
  const pictogram = document.createElement("button");
  pictogram.type = "button";
  pictogram.className = `metro-picto ${className}`;
  pictogram.setAttribute("aria-label", ariaLabel);
  applyLinePictogram(pictogram, line);
  return pictogram;
}

function renderLoaderStep(index) {
  const line = LINES[index];
  const progress = Math.round(index / (LINES.length - 1) * 100);
  applyLinePictogram(metroLoaderBadge, line);
  metroLoader.setAttribute("aria-valuenow", String(progress));
  metroLoader.setAttribute("aria-valuetext", `Ligne ${line.label}, ${progress} %`);
}

function finishLoader() {
  if (loaderFinished) return;
  loaderFinished = true;
  clearInterval(loaderTimer);
  loaderStep = LINES.length - 1;
  renderLoaderStep(loaderStep);
  setTimeout(() => {
    metroLoader.classList.add("is-hidden");
    metroLoader.setAttribute("aria-busy", "false");
    document.body.classList.remove("is-loading");
  }, LOADER_STEP_MS * 1.5);
}

function markLoaderDataReady() {
  loaderDataReady = true;
  if (loaderFontReady && loaderStep >= LINES.length - 2) finishLoader();
}

function markLoaderFontReady() {
  loaderFontReady = true;
  overviewLabelLayout = null;
  markBaseDirty();
  if (loaderDataReady && loaderStep >= LINES.length - 2) finishLoader();
}

function advanceLoader() {
  if (loaderStep < LINES.length - 2) {
    loaderStep += 1;
    renderLoaderStep(loaderStep);
  } else if (loaderDataReady && loaderFontReady) {
    finishLoader();
  }
}

metroLoader.setAttribute("aria-busy", "true");
renderLoaderStep(loaderStep);
loaderTimer = setInterval(advanceLoader, LOADER_STEP_MS);
STATION_LABEL_FONT_READY.then(markLoaderFontReady);

function worldSize(zoom = camera.zoom) {
  return TILE_SIZE * 2 ** zoom;
}

function screenPoint(point) {
  const scale = worldSize();
  return {
    x: (point.x - camera.x) * scale + viewport.width / 2,
    y: (point.y - camera.y) * scale + viewport.height / 2,
  };
}

function worldPoint(x, y) {
  const scale = worldSize();
  return {
    x: camera.x + (x - viewport.width / 2) / scale,
    y: camera.y + (y - viewport.height / 2) / scale,
  };
}

function markBaseDirty() {
  baseDirty = true;
}

function sizeCanvas(canvas, context) {
  if (canvas.width !== viewport.pixelWidth || canvas.height !== viewport.pixelHeight) {
    canvas.width = viewport.pixelWidth;
    canvas.height = viewport.pixelHeight;
  }
  context.setTransform(viewport.scaleX, 0, 0, viewport.scaleY, 0, 0);
}

function resize() {
  const rect = map.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const ratio = Math.min(2, devicePixelRatio || 1);
  const pixelWidth = Math.max(1, Math.round(width * ratio));
  const pixelHeight = Math.max(1, Math.round(height * ratio));
  if (
    viewport.width === width
    && viewport.height === height
    && viewport.pixelWidth === pixelWidth
    && viewport.pixelHeight === pixelHeight
  ) return false;
  viewport = {
    width,
    height,
    ratio,
    scaleX: pixelWidth / width,
    scaleY: pixelHeight / height,
    pixelWidth,
    pixelHeight,
  };
  sizeCanvas(baseCanvas, baseContext);
  sizeCanvas(liveCanvas, liveContext);
  sizeCanvas(focusCanvas, focusContext);
  overviewLabelLayout = null;
  markBaseDirty();
  return true;
}

function scheduleViewportResize() {
  if (viewportResizeFrame !== null) return;
  viewportResizeFrame = requestAnimationFrame(() => {
    viewportResizeFrame = null;
    resize();
    if (activeStationName && !stationDetails.hidden) {
      stationDetailsWidth = stationDetails.offsetWidth;
      stationDetailsHeight = stationDetails.offsetHeight;
    }
  });
}

function tileCacheKey(zoom, x, y) {
  const limit = 2 ** zoom;
  if (y < 0 || y >= limit) return null;
  const wrappedX = (x % limit + limit) % limit;
  const density = viewport.ratio > 1 ? "@2x" : "";
  return `${zoom}/${wrappedX}/${y}/${density}`;
}

function tileEntry(zoom, x, y) {
  const limit = 2 ** zoom;
  if (y < 0 || y >= limit) return null;
  const wrappedX = (x % limit + limit) % limit;
  const density = viewport.ratio > 1 ? "@2x" : "";
  const key = tileCacheKey(zoom, x, y);
  const cached = tileCache.get(key);
  if (cached) {
    cached.usedAt = performance.now();
    return cached;
  }

  const image = new Image();
  const entry = { image, ready: false, loadedAt: 0, usedAt: performance.now() };
  image.decoding = "async";
  image.crossOrigin = "anonymous";
  image.onload = () => {
    entry.ready = true;
    entry.loadedAt = performance.now();
    markBaseDirty();
  };
  image.src = `https://a.basemaps.cartocdn.com/light_all/${zoom}/${wrappedX}/${y}${density}.png`;
  tileCache.set(key, entry);
  return entry;
}

function cachedTile(zoom, x, y) {
  const key = tileCacheKey(zoom, x, y);
  if (!key) return null;
  const entry = tileCache.get(key);
  if (!entry?.ready) return null;
  entry.usedAt = performance.now();
  return entry;
}

function pruneTileCache() {
  if (tileCache.size <= TILE_CACHE_LIMIT) return;
  const oldest = [...tileCache.entries()]
    .sort((left, right) => left[1].usedAt - right[1].usedAt)
    .slice(0, tileCache.size - TILE_CACHE_LIMIT);
  oldest.forEach(([key]) => tileCache.delete(key));
}

function drawTileFallback(context, zoom, x, y, screenX, screenY, size) {
  for (let depth = 1; depth <= 3 && zoom - depth >= 0; depth += 1) {
    const factor = 2 ** depth;
    const parentX = Math.floor(x / factor);
    const parentY = Math.floor(y / factor);
    const parent = cachedTile(zoom - depth, parentX, parentY);
    if (!parent) continue;
    const sourceWidth = parent.image.naturalWidth / factor;
    const sourceHeight = parent.image.naturalHeight / factor;
    const column = (x % factor + factor) % factor;
    const row = y - parentY * factor;
    context.drawImage(
      parent.image,
      column * sourceWidth,
      row * sourceHeight,
      sourceWidth,
      sourceHeight,
      screenX,
      screenY,
      size + .5,
      size + .5,
    );
    return true;
  }

  // When zooming out, the previous layer consists of four cached child tiles.
  // Recompose any that are available while the lower-resolution tile loads.
  let drawn = false;
  const childSize = size / 2;
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 2; column += 1) {
      const child = cachedTile(zoom + 1, x * 2 + column, y * 2 + row);
      if (!child) continue;
      context.drawImage(
        child.image,
        screenX + column * childSize,
        screenY + row * childSize,
        childSize + .5,
        childSize + .5,
      );
      drawn = true;
    }
  }
  return drawn;
}

function prefetchTiles(zoom, centre = { x: camera.targetX, y: camera.targetY }) {
  const tileZoom = clamp(Math.floor(zoom), 0, 20);
  const count = 2 ** tileZoom;
  const scaledTile = TILE_SIZE * 2 ** (zoom - tileZoom);
  const centreX = centre.x * count;
  const centreY = centre.y * count;
  const minX = Math.floor(centreX - viewport.width / (2 * scaledTile)) - 1;
  const maxX = Math.ceil(centreX + viewport.width / (2 * scaledTile)) + 1;
  const minY = Math.floor(centreY - viewport.height / (2 * scaledTile)) - 1;
  const maxY = Math.ceil(centreY + viewport.height / (2 * scaledTile)) + 1;
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) tileEntry(tileZoom, x, y);
  }
}

function drawTiles(context) {
  const tileZoom = clamp(Math.floor(camera.zoom), 0, 20);
  const count = 2 ** tileZoom;
  const scaledTile = TILE_SIZE * 2 ** (camera.zoom - tileZoom);
  const centreX = camera.x * count;
  const centreY = camera.y * count;
  const minX = Math.floor(centreX - viewport.width / (2 * scaledTile)) - 1;
  const maxX = Math.ceil(centreX + viewport.width / (2 * scaledTile)) + 1;
  const minY = Math.floor(centreY - viewport.height / (2 * scaledTile)) - 1;
  const maxY = Math.ceil(centreY + viewport.height / (2 * scaledTile)) + 1;

  context.save();
  let fading = false;
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      const entry = tileEntry(tileZoom, x, y);
      const screenX = (x - centreX) * scaledTile + viewport.width / 2;
      const screenY = (y - centreY) * scaledTile + viewport.height / 2;
      if (!entry?.ready) {
        context.globalAlpha = .9;
        drawTileFallback(context, tileZoom, x, y, screenX, screenY, scaledTile);
        continue;
      }

      const blend = clamp((performance.now() - entry.loadedAt) / 180, 0, 1);
      let hasFallback = false;
      if (blend < 1) {
        context.globalAlpha = .9;
        hasFallback = drawTileFallback(context, tileZoom, x, y, screenX, screenY, scaledTile);
      }
      context.globalAlpha = .9 * (hasFallback ? blend : 1);
      context.drawImage(entry.image, screenX, screenY, scaledTile + .5, scaledTile + .5);
      if (hasFallback && blend < 1) fading = true;
    }
  }
  context.restore();
  pruneTileCache();
  return fading;
}

function tracePath(context, path) {
  let visible = false;
  context.beginPath();
  path.forEach((projected, index) => {
    const point = screenPoint(projected);
    if (
      point.x >= -120 && point.x <= viewport.width + 120
      && point.y >= -120 && point.y <= viewport.height + 120
    ) visible = true;
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  return visible;
}

function drawRoute(context, line, width, alpha) {
  for (const path of CENTERLINES[line.label]?.paths ?? []) {
    if (!tracePath(context, path)) continue;
    context.globalAlpha = alpha;
    context.strokeStyle = line.color;
    context.lineWidth = width;
    context.stroke();
  }
}

function registerStationLabel(name, box, opacity) {
  const station = OVERVIEW_STATION_BY_NAME.get(name);
  if (!station || opacity < .5) return;
  stationLabelHitRecords.push({ station, box });
}

function setStationLabelFont(context, fontSize) {
  context.font = `500 ${fontSize}px ${STATION_LABEL_FONT_FAMILY}`;
  context.letterSpacing = STATION_LABEL_LETTER_SPACING;
}

function drawStationLabels(context, line, opacity = 1, offsetY = 0) {
  const baseOpacity = opacity * labelZoomStates.core.opacity;
  if (baseOpacity <= .01) return;
  const routeSegments = (CENTERLINES[line.label]?.segments ?? [])
    .map((segment) => segment.map(screenPoint));
  const candidates = [];
  const seenNames = new Set();
  const terminalNames = new Set();
  for (const route of ROUTES[line.label] ?? []) {
    if (route.stops[0]) terminalNames.add(route.stops[0].name);
    const lastStop = route.stops[route.stops.length - 1];
    if (lastStop) terminalNames.add(lastStop.name);
    for (const stop of route.stops) {
      if (seenNames.has(stop.name)) continue;
      seenNames.add(stop.name);
      candidates.push(stop);
    }
  }

  const occupied = [];
  const fontSize = clamp(12 + (camera.zoom - 13.25) * 1.6, 12, 15);
  const labelHeight = Math.ceil(fontSize + 7);
  setStationLabelFont(context, fontSize);
  context.textBaseline = "middle";
  const orderedCandidates = candidates
    .map((stop, index) => ({
      stop,
      index,
      tier: terminalNames.has(stop.name) || index % 4 === 0
        ? "core"
        : index % 2 === 0 ? "medium" : "detail",
    }))
    .sort((left, right) => (
      Number(right.stop.name === activeStationName)
      - Number(left.stop.name === activeStationName)
      || LABEL_TIER_RANK[left.tier] - LABEL_TIER_RANK[right.tier]
    ));
  for (const { stop, tier } of orderedCandidates) {
    const tierOpacity = tier === "core" ? 1 : labelZoomStates[tier].opacity;
    const itemOpacity = baseOpacity * tierOpacity;
    if (itemOpacity <= .01) continue;
    const point = screenPoint(stop.projected);
    if (point.x < 20 || point.x > viewport.width - 20 || point.y < 20 || point.y > viewport.height - 20) continue;
    const width = context.measureText(stop.name).width + 12;
    const box = placeStationLabel({
      point,
      width,
      height: labelHeight,
      segments: routeSegments,
      occupied,
      viewport,
      gap: 10,
    });
    if (!box) continue;
    occupied.push(box);
    const y = box.y + offsetY;
    context.globalAlpha = itemOpacity;
    context.fillStyle = STATION_BLUE;
    context.fillRect(box.x, y, box.width, box.height);
    context.globalAlpha = itemOpacity;
    context.fillStyle = "#fff";
    context.fillText(stop.name, box.x + 6, y + box.height / 2 + .5);
    registerStationLabel(stop.name, { ...box, y }, itemOpacity);
  }
  context.globalAlpha = 1;
}

function updateOpacityTransition(state, target, timestamp) {
  if (state.target !== target) {
    state.from = state.opacity;
    state.target = target;
    state.startedAt = timestamp;
  }
  if (prefersReducedMotion) {
    state.opacity = target;
    state.from = target;
    return false;
  }
  const progress = clamp((timestamp - state.startedAt) / LABEL_ZOOM_DURATION, 0, 1);
  const eased = progress * progress * (3 - 2 * progress);
  state.opacity = state.from + (state.target - state.from) * eased;
  if (progress >= 1) {
    state.opacity = state.target;
    state.from = state.target;
  }
  return progress < 1 && state.opacity !== state.target;
}

function updateLabelZoomStates(timestamp) {
  const labelsActive = !networkHidden
    && Boolean(selectedCode || labelTransition?.from || labelTransition?.to);
  const mediumThreshold = labelZoomStates.medium.target ? 12.65 : 12.75;
  const detailThreshold = labelZoomStates.detail.target ? 13.9 : 14;
  const coreTarget = labelsActive ? 1 : 0;
  const mediumTarget = labelsActive && camera.zoom >= mediumThreshold ? 1 : 0;
  const detailTarget = labelsActive && camera.zoom >= detailThreshold ? 1 : 0;
  const coreAnimating = updateOpacityTransition(labelZoomStates.core, coreTarget, timestamp);
  const mediumAnimating = updateOpacityTransition(labelZoomStates.medium, mediumTarget, timestamp);
  const detailAnimating = updateOpacityTransition(labelZoomStates.detail, detailTarget, timestamp);
  return coreAnimating || mediumAnimating || detailAnimating;
}

function labelLayers(timestamp) {
  if (!labelTransition) {
    return selectedCode ? [{ code: selectedCode, opacity: 1, offsetY: 0 }] : [];
  }

  const elapsed = timestamp - labelTransition.startedAt;
  const outgoingProgress = clamp(elapsed / LABEL_EXIT_DURATION, 0, 1);
  const incomingProgress = labelTransition.incomingStartedAt === null
    ? 0
    : clamp((timestamp - labelTransition.incomingStartedAt) / LABEL_ENTER_DURATION, 0, 1);
  const outgoingOpacity = (1 - outgoingProgress) ** 2;
  const incomingOpacity = 1 - (1 - incomingProgress) ** 3;
  const outgoingComplete = outgoingProgress >= 1;
  const incomingComplete = !labelTransition.to || incomingProgress >= 1;

  if (outgoingComplete && incomingComplete) {
    labelTransition = null;
    return selectedCode ? [{ code: selectedCode, opacity: 1, offsetY: 0 }] : [];
  }

  const layers = [];
  if (labelTransition.from && labelTransition.from !== labelTransition.to) {
    layers.push({ code: labelTransition.from, opacity: outgoingOpacity, offsetY: -2 * outgoingProgress });
  }
  if (labelTransition.to) {
    layers.push({
      code: labelTransition.to,
      opacity: incomingOpacity,
      offsetY: 4 * (1 - incomingOpacity),
    });
  }
  return layers;
}

function viewIsVisuallySettled() {
  if (pointers.size) return false;
  const scale = worldSize();
  const remainingPanPixels = Math.hypot(
    camera.targetX - camera.x,
    camera.targetY - camera.y,
  ) * scale;
  const inertiaPixelsPerFrame = Math.hypot(
    camera.velocityX,
    camera.velocityY,
  ) * scale * 16.67;
  return remainingPanPixels < 1
    && Math.abs(camera.targetZoom - camera.zoom) < .01
    && inertiaPixelsPerFrame < .5;
}

function updateLabelTransitionForView(timestamp) {
  if (!labelTransition?.to || labelTransition.incomingStartedAt !== null) return;
  if (!viewIsVisuallySettled()) return;
  labelTransition.incomingStartedAt = timestamp;
}

function drawStationDots(context, visibleLines) {
  for (const line of visibleLines) {
    const points = CENTERLINES[line.label]?.points ?? [];
    context.globalAlpha = 1;
    for (const projected of points) {
      const point = screenPoint(projected);
      if (point.x < -8 || point.x > viewport.width + 8 || point.y < -8 || point.y > viewport.height + 8) continue;
      context.beginPath();
      context.arc(point.x, point.y, 2.7, 0, Math.PI * 2);
      context.fillStyle = "#fff";
      context.fill();
      context.strokeStyle = "#292a27";
      context.lineWidth = 1.15;
      context.stroke();
    }
  }
}

function drawStationLabelsLayer(context, timestamp) {
  for (const layer of labelLayers(timestamp)) {
    const line = LINE_BY_CODE.get(layer.code);
    if (line) drawStationLabels(context, line, layer.opacity, layer.offsetY);
  }
}

function overviewStationLabelsVisible() {
  if (networkHidden) {
    overviewLabelsActive = false;
    overviewLabelLayout = null;
    return false;
  }
  if (selectedCode || labelTransition) {
    overviewLabelsActive = false;
    overviewLabelLayout = null;
    return false;
  }
  if (overviewLabelsActive) {
    overviewLabelsActive = camera.zoom >= OVERVIEW_LABEL_EXIT_ZOOM;
  } else {
    overviewLabelsActive = camera.zoom >= OVERVIEW_LABEL_ENTER_ZOOM;
  }
  if (!overviewLabelsActive) overviewLabelLayout = null;
  return overviewLabelsActive;
}

function overviewLayoutMatchesView(layout) {
  const scale = worldSize();
  const panDistance = Math.hypot(
    camera.x - layout.cameraX,
    camera.y - layout.cameraY,
  ) * scale;
  return panDistance < .5
    && Math.abs(camera.zoom - layout.zoom) < .002
    && viewport.width === layout.viewportWidth
    && viewport.height === layout.viewportHeight;
}

function overviewStationEligible(station) {
  if (camera.zoom >= OVERVIEW_ALL_STATIONS_ZOOM) return true;
  if (camera.zoom >= OVERVIEW_TERMINAL_ZOOM) {
    return station.lineCount >= 2 || station.isTerminal;
  }
  if (camera.zoom >= OVERVIEW_INTERCHANGE_ZOOM) return station.lineCount >= 2;
  return station.lineCount >= 3;
}

function buildOverviewStationLabelLayout(context, timestamp, previousLayout) {
  const routeSegments = OVERVIEW_SEGMENTS
    .map((segment) => segment.map(screenPoint))
    .filter(([first, second]) => (
      Math.max(first.x, second.x) >= -30
      && Math.min(first.x, second.x) <= viewport.width + 30
      && Math.max(first.y, second.y) >= -30
      && Math.min(first.y, second.y) <= viewport.height + 30
    ));
  const occupied = [];
  const fontSize = 15;
  const labelHeight = fontSize + 7;
  setStationLabelFont(context, fontSize);
  context.textBaseline = "middle";

  const fullDetail = camera.zoom >= OVERVIEW_FULL_DETAIL_ZOOM;
  const edgeMargin = fullDetail ? 0 : 20;
  const visibleStations = OVERVIEW_STATIONS
    .filter(overviewStationEligible)
    .map((station) => ({ ...station, point: screenPoint(station.projected) }))
    .filter(({ point }) => (
      point.x >= edgeMargin && point.x <= viewport.width - edgeMargin
      && point.y >= edgeMargin && point.y <= viewport.height - edgeMargin
    ))
    .sort((left, right) => (
      Number(right.name === activeStationName) - Number(left.name === activeStationName)
    ));

  const previousLabels = new Map(
    (previousLayout?.labels ?? []).map((label) => [label.station.name, label]),
  );
  const labels = [];
  for (const station of visibleStations) {
    const width = context.measureText(station.name).width + 12;
    const priorityGaps = station.lineCount >= 3
      ? [10, 18, 26]
      : station.lineCount === 2 ? [10, 18] : [10];
    const placement = {
      point: station.point,
      width,
      height: labelHeight,
      segments: routeSegments,
      occupied,
      viewport,
      gap: 10,
      gaps: fullDetail ? [10, 18, 28, 40] : priorityGaps,
      overlapPadding: fullDetail ? 2 : 4,
      segmentPadding: fullDetail ? 0 : 1,
      viewportPadding: fullDetail ? 4 : 8,
    };
    let box = placeStationLabel(placement);
    if (!box && fullDetail) {
      box = placeStationLabel({ ...placement, segments: [] });
    }
    if (!box && fullDetail) {
      box = placeStationLabel({ ...placement, segments: [], occupied: [] });
    }
    if (!box) continue;
    occupied.push(box);
    const previous = previousLabels.get(station.name);
    labels.push({
      station,
      offsetX: box.x - station.point.x,
      offsetY: box.y - station.point.y,
      width: box.width,
      height: box.height,
      enteredAt: previous?.enteredAt ?? timestamp,
    });
  }
  return {
    labels,
    cameraX: camera.x,
    cameraY: camera.y,
    zoom: camera.zoom,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  };
}

function drawOverviewStationLabels(context, timestamp) {
  setStationLabelFont(context, 15);
  context.textBaseline = "middle";
  const shouldRefresh = !overviewLabelLayout
    || (viewIsVisuallySettled() && !overviewLayoutMatchesView(overviewLabelLayout));
  if (shouldRefresh) {
    overviewLabelLayout = buildOverviewStationLabelLayout(
      context,
      timestamp,
      overviewLabelLayout,
    );
  }

  let animating = false;
  for (const label of overviewLabelLayout.labels) {
    const point = screenPoint(label.station.projected);
    const box = {
      x: point.x + label.offsetX,
      y: point.y + label.offsetY,
      width: label.width,
      height: label.height,
    };
    if (
      box.x + box.width < 0
      || box.y + box.height < 0
      || box.x > viewport.width
      || box.y > viewport.height
    ) continue;
    const opacity = prefersReducedMotion
      ? 1
      : clamp((timestamp - label.enteredAt) / OVERVIEW_LABEL_FADE_DURATION, 0, 1);
    if (opacity < 1) animating = true;
    context.globalAlpha = opacity;
    context.fillStyle = STATION_BLUE;
    context.fillRect(box.x, box.y, box.width, box.height);
    context.fillStyle = "#fff";
    context.fillText(label.station.name, box.x + 6, box.y + box.height / 2 + .5);
    registerStationLabel(label.station.name, box, opacity);
  }
  context.globalAlpha = 1;
  return animating;
}

function drawBackgroundNetwork(context) {
  if (networkHidden) return;
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";

  if (selectedCode) {
    for (const line of LINES) {
      if (line.label !== selectedCode) drawRoute(context, line, 3, .14);
    }
  } else {
    for (const line of LINES) {
      for (const path of CENTERLINES[line.label]?.paths ?? []) {
        if (!tracePath(context, path)) continue;
        context.globalAlpha = .5;
        context.strokeStyle = "rgba(255,255,255,.92)";
        context.lineWidth = ROUTE_CASING_WIDTH;
        context.stroke();
      }
      drawRoute(context, line, ROUTE_WIDTH, 1);
    }
    if (camera.zoom >= 13) drawStationDots(context, LINES);
  }
  context.restore();
}

function drawFocusLayer(timestamp) {
  let labelsAnimating = false;
  stationLabelHitRecords = [];
  focusContext.save();
  focusContext.setTransform(1, 0, 0, 1, 0, 0);
  focusContext.clearRect(0, 0, focusCanvas.width, focusCanvas.height);
  focusContext.setTransform(viewport.scaleX, 0, 0, viewport.scaleY, 0, 0);
  focusContext.lineCap = "round";
  focusContext.lineJoin = "round";

  if (!networkHidden) {
    if (selectedCode) {
      const selected = LINE_BY_CODE.get(selectedCode);
      for (const path of CENTERLINES[selectedCode]?.paths ?? []) {
        if (!tracePath(focusContext, path)) continue;
        focusContext.globalAlpha = .9;
        focusContext.strokeStyle = "rgba(255,255,255,.95)";
        focusContext.lineWidth = ROUTE_CASING_WIDTH;
        focusContext.stroke();
      }
      drawRoute(focusContext, selected, ROUTE_WIDTH, 1);
      drawStationDots(focusContext, [selected]);
    }
    drawStationLabelsLayer(focusContext, timestamp);
    if (overviewStationLabelsVisible()) {
      labelsAnimating = drawOverviewStationLabels(focusContext, timestamp);
    }
  }
  focusContext.restore();
  syncStationDetails();
  return labelsAnimating;
}

function drawBase(timestamp) {
  baseContext.save();
  baseContext.setTransform(viewport.scaleX, 0, 0, viewport.scaleY, 0, 0);
  baseContext.fillStyle = "#e8e9e4";
  baseContext.fillRect(0, 0, viewport.width, viewport.height);
  const tilesFading = drawTiles(baseContext);
  drawBackgroundNetwork(baseContext);
  baseContext.restore();
  const labelsAnimating = drawFocusLayer(timestamp);
  baseDirty = tilesFading || labelsAnimating;
}

function updatePlans(nextSnapshot, observedAt = Date.now()) {
  const nextDurations = buildSegmentDurations(
    [nextSnapshot, ...snapshots],
    ROUTES,
    CALIBRATED_SEGMENT_DURATIONS,
  );
  const nextPlans = buildTrainPlans(nextSnapshot, ROUTES);
  const refreshMilliseconds = clamp(
    Number(nextSnapshot.refreshAfterSeconds) || 120,
    30,
    3_600,
  ) * 1000;
  trainRetentionMs = clamp(
    refreshMilliseconds * 2.5,
    MIN_TRAIN_RETENTION_MS,
    MAX_TRAIN_RETENTION_MS,
  );

  plans = reconcileTrainPlans(
    plans,
    nextPlans,
    observedAt,
    trainRetentionMs,
  );
  segmentDurations = nextDurations;
  for (const id of renderStates.keys()) {
    if (!plans.some((plan) => plan.id === id)) renderStates.delete(id);
  }
}

function easedFade(progress) {
  const bounded = clamp(progress, 0, 1);
  return bounded * bounded * (3 - 2 * bounded);
}

function entryOpacity(render, timestamp) {
  return prefersReducedMotion
    ? 1
    : easedFade((timestamp - render.fadeStarted) / TRAIN_ENTRY_FADE_MS);
}

function retainedOpacity(plan, render, wallTime) {
  if (prefersReducedMotion) return 1;
  let opacity = 1;
  if (plan.missingSince && Number.isFinite(plan.expiresAt)) {
    opacity = Math.min(
      opacity,
      easedFade((plan.expiresAt - wallTime) / TRAIN_EXIT_FADE_MS),
    );
  }
  if (render.unplaceableSince) {
    const holdRemaining =
      MAX_POSITION_HOLD_MS - (wallTime - render.unplaceableSince);
    opacity = Math.min(
      opacity,
      easedFade(holdRemaining / TRAIN_EXIT_FADE_MS),
    );
  }
  return opacity;
}

function beginTrainRelocation(render, base, routeKey, timestamp) {
  render.relocation = {
    startedAt: timestamp,
    switched: false,
    targetProgress: base.routeProgress,
    targetRouteKey: routeKey,
    outgoingPosition: render.lastPosition,
  };
}

function relocatingTrainPosition(plan, render, base, timestamp, wallTime) {
  const relocation = render.relocation;
  const progress = clamp(
    (timestamp - relocation.startedAt) / TRAIN_RELOCATION_FADE_MS,
    0,
    1,
  );
  const retained = retainedOpacity(plan, render, wallTime);

  if (progress < .5 && relocation.outgoingPosition) {
    return {
      ...relocation.outgoingPosition,
      opacity: retained * (1 - progress * 2),
    };
  }

  if (!relocation.switched) {
    relocation.switched = true;
    render.routeKey = relocation.targetRouteKey;
    render.progress = relocation.targetProgress;
  }
  const projected = projectedForRouteProgress(plan, render.progress);
  if (!projected) return null;
  const opacity = retained * clamp((progress - .5) * 2, 0, 1);
  const position = {
    ...base,
    routeProgress: render.progress,
    projected,
    opacity,
  };
  render.lastPosition = position;

  if (progress >= 1) {
    render.relocation = null;
    render.fadeStarted = timestamp - TRAIN_ENTRY_FADE_MS;
  }
  return position;
}

function trainPosition(plan, timestamp, wallTime) {
  const routeKey = `${plan.code}:${plan.route.directionIndex}`;
  let render = renderStates.get(plan.id);
  const base = positionForTrain(plan, wallTime, segmentDurations, MOVEMENT);
  if (!base) {
    if (
      !render?.lastPosition
      || render.routeKey !== routeKey
      || !Number.isFinite(plan.expiresAt)
      || wallTime > plan.expiresAt
    ) return null;
    render.unplaceableSince ??= wallTime;
    if (wallTime - render.unplaceableSince > MAX_POSITION_HOLD_MS) return null;
    render.lastFrame = timestamp;
    const opacity = Math.min(
      entryOpacity(render, timestamp),
      retainedOpacity(plan, render, wallTime),
    );
    return { ...render.lastPosition, opacity };
  }
  if (!render) {
    render = {
      routeKey,
      progress: base.routeProgress,
      lastFrame: timestamp,
      // The loader already masks the initial cohort. Only trains first seen
      // after the map is ready need the slow lifecycle fade.
      fadeStarted: loaderFinished
        ? timestamp
        : timestamp - TRAIN_ENTRY_FADE_MS,
    };
    renderStates.set(plan.id, render);
  }
  render.unplaceableSince = null;
  const elapsed = Math.min(100, timestamp - render.lastFrame);
  render.lastFrame = timestamp;
  if (render.relocation) {
    return relocatingTrainPosition(plan, render, base, timestamp, wallTime);
  }

  const correction = base.routeProgress - render.progress;
  if (correction < -1e-4) render.backwardHoldStartedAt ??= wallTime;
  else render.backwardHoldStartedAt = null;
  const backwardHeldMilliseconds = render.backwardHoldStartedAt
    ? wallTime - render.backwardHoldStartedAt
    : 0;
  const reconciliation = reconcileRouteProgress(
    render.progress,
    base.routeProgress,
    elapsed,
    {
      maxRate: MAX_TRAIN_PROGRESS_RATE,
      backwardHoldMilliseconds: MAX_BACKWARD_HOLD_MS,
      backwardHeldMilliseconds,
    },
  );

  if (render.routeKey !== routeKey || reconciliation.relocated) {
    // A reused identifier, branch correction, expired backward hold, or very
    // stale snapshot should never send a marker flying across Paris. Fade the
    // old position out before revealing the corrected one.
    render.backwardHoldStartedAt = null;
    if (prefersReducedMotion || !render.lastPosition) {
      render.routeKey = routeKey;
      render.progress = base.routeProgress;
      render.fadeStarted = timestamp - TRAIN_ENTRY_FADE_MS;
    } else {
      beginTrainRelocation(render, base, routeKey, timestamp);
      return relocatingTrainPosition(plan, render, base, timestamp, wallTime);
    }
  } else {
    // Timetable revisions only catch up along the rail, capped below 2.5
    // interstations per minute. A delay pauses the marker temporarily; if the
    // revised timeline does not catch up, the bounded hold becomes a fade.
    render.progress = reconciliation.progress;
  }

  const projected = projectedForRouteProgress(plan, render.progress);
  if (!projected) return null;
  const opacity = Math.min(
    entryOpacity(render, timestamp),
    retainedOpacity(plan, render, wallTime),
  );
  const position = { ...base, routeProgress: render.progress, projected, opacity };
  render.lastPosition = position;
  return position;
}

function trainAngle(plan, routeProgress) {
  const end = Math.max(0, plan.route.stops.length - 1);
  const before = projectedForRouteProgress(plan, clamp(routeProgress - .025, 0, end));
  const after = projectedForRouteProgress(plan, clamp(routeProgress + .025, 0, end));
  if (!before || !after) return 0;
  return Math.atan2(after.y - before.y, after.x - before.x);
}

function traceTrainShape(context, length, width) {
  const halfLength = length / 2;
  const halfWidth = width / 2;
  const shoulderX = halfLength - Math.max(3, length * .28);
  context.beginPath();
  context.moveTo(halfLength, 0);
  context.lineTo(shoulderX, halfWidth);
  context.lineTo(-halfLength, halfWidth);
  context.lineTo(-halfLength, -halfWidth);
  context.lineTo(shoulderX, -halfWidth);
  context.closePath();
}

function trainMarkerScale(zoom = camera.zoom) {
  const progress = clamp(
    (zoom - TRAIN_SCALE_START_ZOOM) / (MAX_ZOOM - TRAIN_SCALE_START_ZOOM),
    0,
    1,
  );
  const eased = progress * progress * (3 - 2 * progress);
  return 1 + eased * (TRAIN_MAX_SCALE - 1);
}

function drawTrainMarker(context, record) {
  const line = LINE_BY_CODE.get(record.plan.code);
  const selected = !selectedCode || selectedCode === record.plan.code;
  const emphasized = selectedCode === record.plan.code;
  const active = record.plan.id === activeTrainId;
  const scale = trainMarkerScale();
  const length = (emphasized ? 15 : 12) * scale;
  const width = (emphasized ? 8.5 : 7.5) * scale;
  const surround = 4 + (scale - 1) * 2;
  const angle = trainAngle(record.plan, record.position.routeProgress);
  context.save();
  context.globalAlpha = record.position.opacity * (selected ? 1 : .2);
  context.translate(record.x, record.y);
  context.rotate(angle);
  traceTrainShape(context, length + surround, width + surround);
  context.fillStyle = "rgba(255,255,255,.96)";
  context.fill();
  traceTrainShape(context, length, width);
  context.fillStyle = line.color;
  context.fill();
  context.strokeStyle = active ? "#171815" : "rgba(20,20,18,.28)";
  context.lineWidth = (active ? 1.8 : .8) * (1 + (scale - 1) * .35);
  context.stroke();
  context.restore();
}

function drawLive(timestamp) {
  liveContext.clearRect(0, 0, viewport.width, viewport.height);
  liveContext.save();
  liveContext.lineCap = "round";
  liveContext.lineJoin = "round";
  const records = [];
  const wallTime = Date.now();
  for (const plan of plans) {
    const position = trainPosition(plan, timestamp, wallTime);
    if (!position) continue;
    const point = screenPoint(position.projected);
    const outsideViewport = (
      point.x < -20
      || point.x > viewport.width + 20
      || point.y < -20
      || point.y > viewport.height + 20
    );
    if (outsideViewport && plan.id !== activeTrainId) continue;
    const record = { plan, position, x: point.x, y: point.y };
    records.push(record);
  }
  if (!networkHidden && (selectedCode || labelTransition || overviewStationLabelsVisible())) {
    for (const record of records) {
      if (record.plan.code !== selectedCode) drawTrainMarker(liveContext, record);
    }
    liveContext.drawImage(focusCanvas, 0, 0, viewport.width, viewport.height);
    if (selectedCode) {
      for (const record of records) {
        if (record.plan.code === selectedCode) drawTrainMarker(liveContext, record);
      }
    }
  } else {
    for (const record of records) drawTrainMarker(liveContext, record);
  }
  liveContext.restore();
  liveRecords = records;

  if (activeTrainId && !records.some((record) => record.plan.id === activeTrainId)) {
    stopFollowingTrain();
  }
}

function findTrain(x, y) {
  let nearest = null;
  let nearestDistance = 15 * Math.sqrt(trainMarkerScale());
  for (const record of liveRecords) {
    if (selectedCode && selectedCode !== record.plan.code) continue;
    const distance = Math.hypot(record.x - x, record.y - y);
    if (distance < nearestDistance) {
      nearest = record;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function findStationLabel(x, y) {
  return [...stationLabelHitRecords].reverse().find(({ box }) => (
    x >= box.x
    && x <= box.x + box.width
    && y >= box.y
    && y <= box.y + box.height
  )) ?? null;
}

function pointNearSelectedLine(x, y, tolerance = 14) {
  if (!selectedCode) return false;
  const toleranceSquared = tolerance ** 2;

  for (const [projectedStart, projectedEnd] of CENTERLINES[selectedCode]?.segments ?? []) {
    const start = screenPoint(projectedStart);
    const end = screenPoint(projectedEnd);
    const segmentX = end.x - start.x;
    const segmentY = end.y - start.y;
    const lengthSquared = segmentX ** 2 + segmentY ** 2;
    const progress = lengthSquared
      ? clamp(((x - start.x) * segmentX + (y - start.y) * segmentY) / lengthSquared, 0, 1)
      : 0;
    const nearestX = start.x + segmentX * progress;
    const nearestY = start.y + segmentY * progress;
    if ((x - nearestX) ** 2 + (y - nearestY) ** 2 <= toleranceSquared) return true;
  }

  return false;
}

function positionStationDetails(record) {
  const halfWidth = stationDetailsWidth / 2;
  const centreX = clamp(
    record.box.x + record.box.width / 2,
    halfWidth + 8,
    viewport.width - halfWidth - 8,
  );
  const belowY = record.box.y + record.box.height + 4;
  const fitsBelow = belowY + stationDetailsHeight <= viewport.height - 8;
  const safeY = fitsBelow
    ? belowY
    : record.box.y - stationDetailsHeight - 4;
  stationDetails.classList.toggle("is-above", !fitsBelow);
  stationDetails.style.setProperty("--station-x", `${centreX}px`);
  stationDetails.style.setProperty("--station-y", `${Math.max(8, safeY)}px`);
}

function syncStationDetails() {
  if (!activeStationName || stationDetails.hidden) return;
  const record = [...stationLabelHitRecords]
    .reverse()
    .find(({ station }) => station.name === activeStationName);
  if (!record) {
    stationDetails.style.visibility = "hidden";
    return;
  }
  stationDetails.style.visibility = "visible";
  positionStationDetails(record);
}

function stationLineBadge(code) {
  const line = LINE_BY_CODE.get(code);
  const badge = createLinePictogram(
    line,
    "station-details__line",
    `Afficher la ligne ${code}`,
  );
  badge.addEventListener("click", (event) => {
    event.stopPropagation();
    selectLine(line);
  });
  return badge;
}

function closeStationDetails(immediate = false) {
  if (!activeStationName && stationDetails.hidden) return;
  activeStationName = null;
  clearTimeout(stationDetailsHideTimer);
  stationDetails.classList.remove("is-open");
  if (immediate || prefersReducedMotion) {
    stationDetails.hidden = true;
  } else {
    stationDetailsHideTimer = setTimeout(() => {
      stationDetails.hidden = true;
      stationDetailsHideTimer = null;
    }, 220);
  }
}

function setNetworkHidden(hidden) {
  networkHidden = hidden;
  hideLinesOption.setAttribute("aria-checked", String(hidden));
  labelTransition = null;
  overviewLabelsActive = false;
  overviewLabelLayout = null;
  stationLabelHitRecords = [];
  map.classList.remove("over-station");
  closeStationDetails(true);
  markBaseDirty();
}

function showStationDetails(record) {
  if (!record) return;
  if (activeStationName === record.station.name) {
    closeStationDetails();
    return;
  }
  stopFollowingTrain();
  clearTimeout(stationDetailsHideTimer);
  activeStationName = record.station.name;
  stationDetailsLines.replaceChildren(...record.station.lines.map(stationLineBadge));
  stationDetails.setAttribute(
    "aria-label",
    `${record.station.name}, lignes ${record.station.lines.join(", ")}`,
  );
  stationDetails.classList.remove("is-open");
  stationDetails.hidden = false;
  stationDetails.style.visibility = "visible";
  stationDetailsWidth = stationDetails.offsetWidth;
  stationDetailsHeight = stationDetails.offsetHeight;
  positionStationDetails(record);
  requestAnimationFrame(() => {
    if (activeStationName === record.station.name) {
      stationDetails.classList.add("is-open");
    }
  });
}

function followTrain(record) {
  if (!record) return;
  closeStationDetails(true);
  activeTrainId = record.plan.id;
  camera.targetX = record.position.projected.x;
  camera.targetY = record.position.projected.y;
  camera.targetZoom = clamp(
    Math.max(camera.zoom, camera.targetZoom, TRAIN_FOLLOW_MIN_ZOOM),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  camera.velocityX = 0;
  camera.velocityY = 0;
  prefetchTiles(camera.targetZoom, {
    x: record.position.projected.x,
    y: record.position.projected.y,
  });
  markBaseDirty();
}

function stopFollowingTrain() {
  activeTrainId = null;
}

function scheduleRefresh(delay) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(fetchTrains, delay);
}

async function ingest(nextSnapshot) {
  if (!nextSnapshot?.updatedAt || !Array.isArray(nextSnapshot.journeys)) throw new Error("invalid_snapshot");
  if (snapshot?.updatedAt === nextSnapshot.updatedAt) return;

  updatePlans(nextSnapshot);
  snapshot = nextSnapshot;
  if (plans.length) {
    // Create the initial cohort at full opacity before the loader can finish.
    // Later snapshots retain the gradual entry fade for genuinely new trains.
    if (!loaderDataReady) drawLive(performance.now());
    markLoaderDataReady();
  }
  snapshots = [
    nextSnapshot,
    ...snapshots.filter((item) => item.updatedAt !== nextSnapshot.updatedAt),
  ].slice(0, 24);
  saveSnapshot(nextSnapshot);
}

async function fetchTrains() {
  if (requestInFlight) return;
  requestInFlight = true;
  let nextDelay = snapshot ? 60_000 : 20_000;
  try {
    const response = await fetch("/api/trains", {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    await ingest(data);
    const snapshotAge = Math.max(0, Date.now() - Date.parse(data.updatedAt));
    const cacheWindow = clamp(Number(data.refreshAfterSeconds) || 120, 30, 3_600) * 1000;
    // Small jitter prevents many open tabs from reaching the edge at the same
    // instant when a shared cached snapshot expires.
    nextDelay = Math.max(30_000, cacheWindow - snapshotAge + Math.random() * 5_000);
  } catch {
  } finally {
    requestInFlight = false;
    scheduleRefresh(nextDelay);
  }
}

function setZoom(nextZoom, anchorX = viewport.width / 2, anchorY = viewport.height / 2) {
  const targetZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const anchor = worldPoint(anchorX, anchorY);
  const targetScale = worldSize(targetZoom);
  camera.targetZoom = targetZoom;
  camera.targetX = anchor.x - (anchorX - viewport.width / 2) / targetScale;
  camera.targetY = anchor.y - (anchorY - viewport.height / 2) / targetScale;
  camera.velocityX = 0;
  camera.velocityY = 0;
  if (prefersReducedMotion) {
    camera.zoom = camera.targetZoom;
    camera.x = camera.targetX;
    camera.y = camera.targetY;
  }
  prefetchTiles(camera.targetZoom, { x: camera.targetX, y: camera.targetY });
  markBaseDirty();
}

function networkBounds(code = null) {
  const projected = (code ? [code] : LINES.map((line) => line.label))
    .flatMap((lineCode) => (CENTERLINES[lineCode]?.paths ?? []).flat());
  return projected.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function fitNetwork(code = null, animate = true) {
  const bounds = networkBounds(code);
  const mobile = viewport.width < 760;
  const horizontalPadding = mobile ? 42 : 90;
  const verticalPadding = mobile ? 150 : 100;
  const width = Math.max(100, viewport.width - horizontalPadding * 2);
  const height = Math.max(100, viewport.height - verticalPadding * 2);
  const fittedZoom = Math.min(
    Math.log2(width / (TILE_SIZE * (bounds.maxX - bounds.minX))),
    Math.log2(height / (TILE_SIZE * (bounds.maxY - bounds.minY))),
  );
  const overviewZoomBias = mobile
    ? OVERVIEW_ZOOM_BIAS.mobile
    : OVERVIEW_ZOOM_BIAS.desktop;
  const zoom = clamp(
    fittedZoom + (code ? 0 : overviewZoomBias),
    MIN_ZOOM,
    MAX_ZOOM - .5,
  );
  const boundsCenter = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
  const overviewCenter = OVERVIEW_STATION_BY_NAME.get(OVERVIEW_FOCUS_STATION)?.projected;
  const center = code ? boundsCenter : overviewCenter ?? boundsCenter;
  camera.targetX = center.x;
  camera.targetY = center.y;
  camera.targetZoom = zoom;
  camera.velocityX = 0;
  camera.velocityY = 0;
  if (!animate || prefersReducedMotion) {
    camera.x = camera.targetX;
    camera.y = camera.targetY;
    camera.zoom = camera.targetZoom;
  }
  prefetchTiles(camera.targetZoom, { x: camera.targetX, y: camera.targetY });
  markBaseDirty();
  stopFollowingTrain();
}

function selectLine(line) {
  const nextCode = selectedCode === line.label ? null : line.label;
  if (!prefersReducedMotion) {
    labelTransition = {
      from: selectedCode,
      to: nextCode,
      startedAt: performance.now(),
      incomingStartedAt: nextCode ? null : 0,
    };
  }
  selectedCode = nextCode;
  overviewLabelsActive = false;
  overviewLabelLayout = null;
  for (const button of lines.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(selectedCode === button.dataset.line));
  }
  if (selectedCode) fitNetwork(selectedCode);
  markBaseDirty();
  stopFollowingTrain();
  closeStationDetails(true);
}

function localPoint(event) {
  const rect = map.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function startGesture() {
  if (pointers.size >= 2) {
    const [first, second] = [...pointers.values()];
    gesture = {
      mode: "pinch",
      distance: Math.hypot(second.x - first.x, second.y - first.y),
      midpoint: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
      moved: true,
    };
    pressedTrain = null;
  } else if (pointers.size === 1) {
    const point = [...pointers.values()][0];
    gesture = { mode: "pan", ...point, time: performance.now(), movement: 0, moved: false };
  }
}

map.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  const point = localPoint(event);
  pointers.set(event.pointerId, point);
  map.setPointerCapture(event.pointerId);
  camera.velocityX = 0;
  camera.velocityY = 0;
  pressedTrain = pointers.size === 1 ? findTrain(point.x, point.y) : null;
  startGesture();
  map.classList.add("dragging");
});

map.addEventListener("pointermove", (event) => {
  const point = localPoint(event);
  if (!pointers.has(event.pointerId)) {
    const overTrain = Boolean(findTrain(point.x, point.y));
    map.classList.toggle("over-train", overTrain);
    map.classList.toggle(
      "over-station",
      !overTrain && Boolean(findStationLabel(point.x, point.y)),
    );
    return;
  }
  pointers.set(event.pointerId, point);

  if (pointers.size >= 2) {
    const [first, second] = [...pointers.values()];
    const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
    const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    if (gesture?.mode === "pinch") {
      const anchor = worldPoint(gesture.midpoint.x, gesture.midpoint.y);
      camera.zoom = clamp(camera.zoom + Math.log2(distance / Math.max(1, gesture.distance)), MIN_ZOOM, MAX_ZOOM);
      const scale = worldSize();
      camera.x = anchor.x - (midpoint.x - viewport.width / 2) / scale;
      camera.y = anchor.y - (midpoint.y - viewport.height / 2) / scale;
      camera.targetX = camera.x;
      camera.targetY = camera.y;
      camera.targetZoom = camera.zoom;
      gesture.distance = distance;
      gesture.midpoint = midpoint;
      markBaseDirty();
    } else {
      startGesture();
    }
    return;
  }

  if (gesture?.mode !== "pan") startGesture();
  if (!gesture) return;
  const now = performance.now();
  const deltaX = point.x - gesture.x;
  const deltaY = point.y - gesture.y;
  const elapsed = Math.max(1, now - gesture.time);
  gesture.movement += Math.hypot(deltaX, deltaY);
  if (gesture.movement > 4) {
    gesture.moved = true;
    pressedTrain = null;
    stopFollowingTrain();
  }
  const scale = worldSize();
  camera.x -= deltaX / scale;
  camera.y -= deltaY / scale;
  camera.targetX = camera.x;
  camera.targetY = camera.y;
  camera.velocityX = -deltaX / scale / elapsed;
  camera.velocityY = -deltaY / scale / elapsed;
  gesture.x = point.x;
  gesture.y = point.y;
  gesture.time = now;
  markBaseDirty();
});

function finishPointer(event) {
  const wasTap = gesture?.mode === "pan" && !gesture.moved;
  const point = localPoint(event);
  pointers.delete(event.pointerId);
  if (wasTap && pressedTrain) followTrain(pressedTrain);
  else if (wasTap) {
    const station = findStationLabel(point.x, point.y);
    if (station) showStationDetails(station);
    else if (selectedCode && !pointNearSelectedLine(point.x, point.y)) {
      selectLine(LINE_BY_CODE.get(selectedCode));
    }
    else {
      stopFollowingTrain();
      closeStationDetails();
    }
  }
  pressedTrain = null;
  if (pointers.size) startGesture();
  else {
    gesture = null;
    map.classList.remove("dragging");
    if (prefersReducedMotion) {
      camera.velocityX = 0;
      camera.velocityY = 0;
    }
  }
}

map.addEventListener("pointerup", finishPointer);
map.addEventListener("pointercancel", finishPointer);
map.addEventListener("pointerleave", () => {
  map.classList.remove("over-train", "over-station");
});
map.addEventListener("wheel", (event) => {
  event.preventDefault();
  const point = localPoint(event);
  const delta = clamp(-event.deltaY * (event.deltaMode === 1 ? .035 : .002), -.45, .45);
  setZoom(camera.targetZoom + delta, point.x, point.y);
}, { passive: false });
map.addEventListener("dblclick", (event) => {
  const point = localPoint(event);
  setZoom(camera.targetZoom + 1, point.x, point.y);
});
map.addEventListener("keydown", (event) => {
  const step = 90 / worldSize(camera.targetZoom);
  if (event.key === "ArrowLeft") camera.targetX -= step;
  else if (event.key === "ArrowRight") camera.targetX += step;
  else if (event.key === "ArrowUp") camera.targetY -= step;
  else if (event.key === "ArrowDown") camera.targetY += step;
  else if (event.key === "+" || event.key === "=") setZoom(camera.targetZoom + .75);
  else if (event.key === "-" || event.key === "_") setZoom(camera.targetZoom - .75);
  else if (event.key === "Enter") {
    const nearest = [...liveRecords]
      .filter((record) => !selectedCode || record.plan.code === selectedCode)
      .sort((left, right) => (
        Math.hypot(left.x - viewport.width / 2, left.y - viewport.height / 2)
        - Math.hypot(right.x - viewport.width / 2, right.y - viewport.height / 2)
      ))[0];
    followTrain(nearest);
  }
  else return;
  event.preventDefault();
  markBaseDirty();
});

window.addEventListener("resize", scheduleViewportResize, { passive: true });
window.visualViewport?.addEventListener("resize", scheduleViewportResize, { passive: true });
new ResizeObserver(scheduleViewportResize).observe(map);
hideLinesOption.addEventListener("click", () => {
  setNetworkHidden(!networkHidden);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (selectedCode) selectLine(LINE_BY_CODE.get(selectedCode));
  else if (activeTrainId) stopFollowingTrain();
  else if (activeStationName) closeStationDetails();
  else return;
  event.preventDefault();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    clearTimeout(refreshTimer);
    fetchTrains();
  }
});

for (const line of LINES) {
  const button = createLinePictogram(
    line,
    "line",
    `Afficher la ligne ${line.label}`,
  );
  button.dataset.line = line.label;
  button.setAttribute("aria-pressed", "false");

  const statusDot = document.createElement("span");
  statusDot.className = "line__status";
  statusDot.setAttribute("aria-hidden", "true");
  button.append(statusDot);

  button.addEventListener("click", () => selectLine(line));
  lines.append(button);
  LINE_BUTTONS.set(line.label, button);
}

onTraffic(() => {
  for (const line of LINES) {
    const traffic = statusFor(line.label);
    const status = traffic?.status ?? "ok";
    const button = LINE_BUTTONS.get(line.label);
    button.dataset.status = status;
    button.setAttribute(
      "aria-label",
      `Afficher la ligne ${line.label} — ${traffic?.title || TRAFFIC_STATUS_TEXT[status]}`,
    );
  }
});

startTraffic();

function animate(timestamp) {
  const elapsed = Math.min(50, timestamp - lastFrame);
  lastFrame = timestamp;
  let moving = false;
  const trackedTrain = activeTrainId && !pointers.size
    ? liveRecords.find((record) => record.plan.id === activeTrainId)
    : null;

  if (trackedTrain) {
    camera.targetX = trackedTrain.position.projected.x;
    camera.targetY = trackedTrain.position.projected.y;
    camera.velocityX = 0;
    camera.velocityY = 0;
  }

  if (!trackedTrain && !pointers.size
    && (Math.abs(camera.velocityX) > 1e-9 || Math.abs(camera.velocityY) > 1e-9)) {
    camera.x += camera.velocityX * elapsed;
    camera.y += camera.velocityY * elapsed;
    camera.targetX = camera.x;
    camera.targetY = camera.y;
    const friction = Math.pow(.9, elapsed / 16.67);
    camera.velocityX *= friction;
    camera.velocityY *= friction;
    if (Math.abs(camera.velocityX) < 1e-9) camera.velocityX = 0;
    if (Math.abs(camera.velocityY) < 1e-9) camera.velocityY = 0;
    moving = true;
  }

  const easing = prefersReducedMotion ? 1 : 1 - Math.exp(-elapsed / 85);
  const deltaX = camera.targetX - camera.x;
  const deltaY = camera.targetY - camera.y;
  const deltaZoom = camera.targetZoom - camera.zoom;
  if (Math.abs(deltaX) > 1e-10 || Math.abs(deltaY) > 1e-10 || Math.abs(deltaZoom) > .0001) {
    camera.x += deltaX * easing;
    camera.y += deltaY * easing;
    camera.zoom += deltaZoom * easing;
    moving = true;
  }

  if (moving) markBaseDirty();
  updateLabelTransitionForView(timestamp);
  const zoomLabelsAnimating = updateLabelZoomStates(timestamp);
  if (labelTransition) markBaseDirty();
  if (zoomLabelsAnimating) markBaseDirty();
  const viewChanged = baseDirty;
  if (viewChanged) drawBase(timestamp);
  if (viewChanged || moving || timestamp - lastLiveDraw >= 1000 / 30) {
    drawLive(timestamp);
    lastLiveDraw = timestamp;
  }
  requestAnimationFrame(animate);
}

async function start() {
  resize();
  fitNetwork(null, false);
  snapshots = await loadRecentSnapshots();
  if (snapshots.length) {
    segmentDurations = buildSegmentDurations(
      snapshots,
      ROUTES,
      CALIBRATED_SEGMENT_DURATIONS,
    );
  }
  await fetchTrains();
}

requestAnimationFrame(animate);
start();
