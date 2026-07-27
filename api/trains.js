export const config = { runtime: "edge" };

import { fetchPrim, primApiKeys } from "./_prim.js";

const SIRI_URL = "https://prim.iledefrance-mobilites.fr/marketplace/estimated-timetable";
const REFRESH_SECONDS = 60;
const LINE_IDS = {
  "1": "C01371", "2": "C01372", "3": "C01373", "3bis": "C01386",
  "4": "C01374", "5": "C01375", "6": "C01376", "7": "C01377",
  "7bis": "C01387", "8": "C01378", "9": "C01379", "10": "C01380",
  "11": "C01381", "12": "C01382", "13": "C01383", "14": "C01384",
};
const CODES_BY_ID = Object.fromEntries(Object.entries(LINE_IDS).map(([code, id]) => [id, code]));

function json(body, status, cacheControl) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cacheControl, "x-content-type-options": "nosniff" },
  });
}

export function normalize(payload, now) {
  const frames = payload?.Siri?.ServiceDelivery?.EstimatedTimetableDelivery?.[0]?.EstimatedJourneyVersionFrame ?? [];
  const source = frames.flatMap((frame) => frame.EstimatedVehicleJourney ?? []);
  const journeys = source.flatMap((journey, index) => {
    const lineRef = journey.LineRef?.value ?? "";
    const code = CODES_BY_ID[lineRef.match(/C\d+/)?.[0]];
    if (!code) return [];
    const calls = (journey.EstimatedCalls?.EstimatedCall ?? []).flatMap((call) => {
      const ref = call.StopPointRef?.value?.split(":")[3];
      const arrival = call.ExpectedArrivalTime ?? call.AimedArrivalTime ?? null;
      const departure = call.ExpectedDepartureTime ?? call.AimedDepartureTime ?? arrival;
      const timestamp = arrival ?? departure;
      if (!ref || !timestamp || !Number.isFinite(Date.parse(timestamp))) return [];
      const delta = Date.parse(timestamp) - now;
      // Retaining the recently passed call gives the client a real departure
      // anchor instead of forcing it to guess the current segment duration.
      return delta < -5 * 60_000 || delta > 3_600_000 ? [] : [{
        ref,
        arrival,
        departure,
        aimedArrival: call.AimedArrivalTime ?? null,
        aimedDeparture: call.AimedDepartureTime ?? null,
      }];
    }).sort((left, right) => (
      Date.parse(left.arrival ?? left.departure) - Date.parse(right.arrival ?? right.departure)
    ));
    return [{
      code,
      id: journey.DatedVehicleJourneyRef?.value ?? journey.VehicleRef?.value ?? `journey-${index}`,
      vehicleRef: journey.VehicleRef?.value ?? null,
      directionRef: journey.DirectionRef?.value ?? null,
      destination:
        journey.DestinationName?.[0]?.value
        ?? journey.DestinationShortName?.[0]?.value
        ?? journey.DirectionName?.[0]?.value
        ?? null,
      calls,
    }].filter((item) => item.calls.length);
  });
  return journeys;
}

export default async function handler(request) {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
  const apiKeys = primApiKeys();
  if (!apiKeys.length) return json({ error: "unconfigured" }, 500, "no-store");

  let upstream;
  try {
    upstream = await fetchPrim(SIRI_URL, {
      apiKeys,
      headers: { accept: "application/json" },
    });
  } catch { return json({ error: "upstream_unreachable" }, 502, "no-store"); }
  if (!upstream.ok) return json({ error: "upstream_error" }, 502, "no-store");

  const now = Date.now();
  const payload = await upstream.json();
  const cacheControl =
    `public, s-maxage=${REFRESH_SECONDS}, stale-while-revalidate=${REFRESH_SECONDS * 4}`;
  return json({
    schemaVersion: 2,
    updatedAt: new Date(now).toISOString(),
    refreshAfterSeconds: REFRESH_SECONDS,
    responseTimestamp:
      payload?.Siri?.ServiceDelivery?.ResponseTimestamp
      ?? payload?.Siri?.ServiceDelivery?.EstimatedTimetableDelivery?.[0]?.ResponseTimestamp
      ?? null,
    journeys: normalize(payload, now),
  }, 200, cacheControl);
}
