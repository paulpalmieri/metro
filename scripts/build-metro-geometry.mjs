// Generates the small geographic layer used by the live-map prototype.
// It is deliberately separate from build-stations.mjs: station order and map
// geometry update on different cadences.

import { readFileSync, writeFileSync } from "node:fs";

const NAVITIA = "https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia";
const LINES = [
  ["1", "C01371"], ["2", "C01372"], ["3", "C01373"], ["3bis", "C01386"],
  ["4", "C01374"], ["5", "C01375"], ["6", "C01376"], ["7", "C01377"],
  ["7bis", "C01387"], ["8", "C01378"], ["9", "C01379"], ["10", "C01380"],
  ["11", "C01381"], ["12", "C01382"], ["13", "C01383"], ["14", "C01384"],
];
const STATIONS = JSON.parse(
  readFileSync(new URL("../src/data/stations.json", import.meta.url), "utf8"),
);

function apiKey() {
  if (process.env.PRIM_API_KEY) return process.env.PRIM_API_KEY;
  const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const match = env.match(/^PRIM_API_KEY=(.*)$/m);
  if (!match) throw new Error("PRIM_API_KEY not set");
  return match[1].trim();
}

async function get(path) {
  const response = await fetch(`${NAVITIA}/${path}`, { headers: { apikey: apiKey() } });
  if (!response.ok) throw new Error(`${response.status} on ${path}`);
  return response.json();
}

const output = {};
for (const [label, id] of LINES) {
  const lineId = `line:IDFM:${id}`;
  const points = await get(`lines/${lineId}/stop_points?count=200`);

  const byRef = Object.fromEntries((points.stop_points ?? []).flatMap((point) => {
    const ref = point.id?.replace("stop_point:IDFM:", "");
    const lon = Number(point.coord?.lon);
    const lat = Number(point.coord?.lat);
    return ref && Number.isFinite(lon) && Number.isFinite(lat) ? [[ref, [lon, lat]]] : [];
  }));

  output[label] = {
    // The current PRIM Navitia response exposes empty route GeoJSON arrays.
    // Ordered stop coordinates are still authoritative and form a clear,
    // schematic geographic polyline appropriate to this minimal map.
    paths: (STATIONS[label]?.directions ?? []).map((direction) =>
      direction.stops.map((stop) => byRef[stop.ref]).filter(Boolean),
    ).filter((path) => path.length > 1),
    points: byRef,
  };
  console.log(`${label.padEnd(5)} ${output[label].paths.length} paths · ${Object.keys(output[label].points).length} stops`);
}

writeFileSync(
  new URL("../src/data/metro-geometry.json", import.meta.url),
  `${JSON.stringify(output)}\n`,
);
