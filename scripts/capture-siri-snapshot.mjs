// Records either the untouched SIRI response or a compact Metro-only series
// for interpolation analysis.
//
// Examples:
//   npm run snapshot:siri
//   npm run snapshot:calibrate
//   npm run snapshot:siri -- --mode=metro --count=4 --interval=20

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { normalize } from "../api/trains.js";

const compress = promisify(gzip);
const SIRI_URL = "https://prim.iledefrance-mobilites.fr/marketplace/estimated-timetable";

function option(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  const value = argument ? Number(argument.slice(prefix.length)) : fallback;
  if (!Number.isFinite(value) || value < 1) throw new Error(`Invalid --${name}`);
  return value;
}

function textOption(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

async function apiKey() {
  if (process.env.PRIM_API_KEY) return process.env.PRIM_API_KEY;
  const contents = await readFile(new URL("../.env", import.meta.url), "utf8");
  const match = contents.match(/^PRIM_API_KEY=(.*)$/m);
  if (!match?.[1]) throw new Error("PRIM_API_KEY is not set");
  return match[1].trim();
}

function quota(response) {
  return {
    remaining:
      response.headers.get("x-ratelimit-remaining-day")
      ?? response.headers.get("ratelimit-remaining"),
    reset: response.headers.get("ratelimit-reset"),
  };
}

async function capture(key, mode) {
  const response = await fetch(SIRI_URL, {
    headers: { apikey: key, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`SIRI returned ${response.status}`);

  const capturedAt = new Date();
  const iso = capturedAt.toISOString();
  const root = new URL(
    mode === "metro" ? "../data/siri-calibration/" : "../data/siri-snapshots/",
    import.meta.url,
  );
  const directory = new URL(`${iso.slice(0, 10)}/`, root);
  const filename = `${iso.replaceAll(":", "-")}.json.gz`;
  const payload = await response.json();
  const metadata = {
    capturedAt: iso,
    quota: quota(response),
  };
  const record = mode === "metro"
    ? {
      ...metadata,
      schemaVersion: 2,
      responseTimestamp:
        payload?.Siri?.ServiceDelivery?.ResponseTimestamp
        ?? payload?.Siri?.ServiceDelivery?.EstimatedTimetableDelivery?.[0]?.ResponseTimestamp
        ?? null,
      journeys: normalize(payload, capturedAt.getTime()),
    }
    : { ...metadata, payload };
  await mkdir(directory, { recursive: true });
  await writeFile(new URL(filename, directory), await compress(JSON.stringify(record), { level: 9 }));
  const detail = mode === "metro" ? `${record.journeys.length} Metro journeys` : "full feed";
  console.log(`${iso}  ${filename}  ${detail}  quota remaining: ${record.quota.remaining ?? "unknown"}`);
}

const count = Math.floor(option("count", 1));
const intervalSeconds = option("interval", 180);
const mode = textOption("mode", "raw");
if (!["raw", "metro"].includes(mode)) throw new Error("Invalid --mode; use raw or metro");
if (count > 240) throw new Error("Refusing more than 240 calls in one capture run.");
if (count > 1 && intervalSeconds < 15) throw new Error("Refusing an interval below 15 seconds.");

const key = await apiKey();
for (let index = 0; index < count; index += 1) {
  await capture(key, mode);
  if (index < count - 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
}
