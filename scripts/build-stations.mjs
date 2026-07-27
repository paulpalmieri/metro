// Generates stations.json: the ordered station list for each metro line, with
// the SIRI stop refs the live feed keys on.
//
// This is static data — the network doesn't change between deploys — so it is
// baked in at build time rather than fetched at runtime. Re-run it if a line
// is extended:  node scripts/build-stations.mjs
//
// Needs PRIM_API_KEY in the environment (or .env).

import { readFileSync, writeFileSync } from "node:fs";

const NAVITIA = "https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia";

const LINES = [
  ["1", "C01371"], ["2", "C01372"], ["3", "C01373"], ["3bis", "C01386"],
  ["4", "C01374"], ["5", "C01375"], ["6", "C01376"], ["7", "C01377"],
  ["7bis", "C01387"], ["8", "C01378"], ["9", "C01379"], ["10", "C01380"],
  ["11", "C01381"], ["12", "C01382"], ["13", "C01383"], ["14", "C01384"],
];

function apiKey() {
  if (process.env.PRIM_API_KEY) return process.env.PRIM_API_KEY;
  try {
    const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
    const hit = env.match(/^PRIM_API_KEY=(.*)$/m);
    if (hit) return hit[1].trim();
  } catch {}
  throw new Error("PRIM_API_KEY not set (env or .env)");
}

const KEY = apiKey();

async function get(path) {
  const res = await fetch(`${NAVITIA}/${path}`, { headers: { apikey: KEY } });
  if (!res.ok) throw new Error(`${res.status} on ${path}`);
  return res.json();
}

// Navitia's /stop_points returns alphabetically; route_schedules table rows are
// the only listing that comes back in running order, which is what a line
// diagram needs.
async function stationsFor(lineId) {
  // Grouping by direction *name* isn't enough: branches and short-turn
  // services give several distinct termini per way. direction_type
  // (inbound/outbound) is what reliably yields one route each way.
  const routes = await get(`lines/${lineId}/routes?count=40`);
  const directionType = new Map(
    (routes.routes ?? []).map((r) => [r.id, r.direction_type]),
  );

  const data = await get(
    `lines/${lineId}/route_schedules?disable_geojson=true&duration=600&count=40`,
  );

  const best = new Map(); // direction_type -> entry
  for (const entry of data.route_schedules ?? []) {
    const rows = entry.table?.rows ?? [];
    if (!rows.length) continue;

    const routeId = entry.links?.find((l) => l.type === "route")?.id;
    const type = directionType.get(routeId) ?? "unknown";

    // Longest variant wins: that's the full end-to-end run rather than a
    // short turn.
    const existing = best.get(type);
    if (!existing || rows.length > existing.table.rows.length) best.set(type, entry);
  }

  return [...best.values()].map((entry) => ({
    direction: entry.display_informations.direction,
    stops: entry.table.rows.map((r) => ({
      name: r.stop_point.name,
      ref: r.stop_point.id.replace("stop_point:IDFM:", ""),
    })),
  }));
}

const out = {};
for (const [label, id] of LINES) {
  const directions = await stationsFor(`line:IDFM:${id}`);
  out[label] = { id, directions };
  const shape = directions.map((d) => d.stops.length).join("+");
  console.log(`${label.padEnd(5)} ${directions.length} directions  ${shape} stops`);
}

writeFileSync(
  new URL("../src/data/stations.json", import.meta.url),
  JSON.stringify(out) + "\n",
);
console.log("\nwrote stations.json");
