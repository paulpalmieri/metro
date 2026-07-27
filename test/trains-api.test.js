import test from "node:test";
import assert from "node:assert/strict";
import handler, { normalize } from "../api/trains.js";

test("normalizes destination-first SIRI calls into chronological order", () => {
  const now = Date.parse("2026-07-25T10:00:00.000Z");
  const payload = {
    Siri: {
      ServiceDelivery: {
        EstimatedTimetableDelivery: [{
          EstimatedJourneyVersionFrame: [{
            EstimatedVehicleJourney: [{
              LineRef: { value: "STIF:Line::C01371:" },
              DatedVehicleJourneyRef: { value: "journey-1" },
              DestinationName: [{ value: "Château de Vincennes" }],
              EstimatedCalls: {
                EstimatedCall: [
                  {
                    StopPointRef: { value: "STIF:StopPoint:Q:next:" },
                    ExpectedArrivalTime: "2026-07-25T10:04:00.000Z",
                  },
                  {
                    StopPointRef: { value: "STIF:StopPoint:Q:previous:" },
                    ExpectedArrivalTime: "2026-07-25T09:59:00.000Z",
                    ExpectedDepartureTime: "2026-07-25T09:59:15.000Z",
                  },
                ],
              },
            }],
          }],
        }],
      },
    },
  };

  const [journey] = normalize(payload, now);
  assert.equal(journey.code, "1");
  assert.equal(journey.destination, "Château de Vincennes");
  assert.deepEqual(journey.calls.map((call) => call.ref), ["previous", "next"]);
  assert.equal(journey.calls[0].departure, "2026-07-25T09:59:15.000Z");
});

test("serves live Metro snapshots on a one-minute cache", async () => {
  const originalFetch = globalThis.fetch;
  const originalPrimary = process.env.PRIM_API_KEY;
  const originalSecondary = process.env.PRIM_API_KEY_SECONDARY;
  process.env.PRIM_API_KEY = "primary";
  process.env.PRIM_API_KEY_SECONDARY = "secondary";
  globalThis.fetch = async () => new Response(JSON.stringify({
    Siri: {
      ServiceDelivery: {
        ResponseTimestamp: "2026-07-25T10:00:00.000Z",
        EstimatedTimetableDelivery: [],
      },
    },
  }), { status: 200 });

  try {
    const response = await handler(new Request("https://example.test/api/trains"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.refreshAfterSeconds, 60);
    assert.match(response.headers.get("cache-control"), /s-maxage=60(?:,|$)/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPrimary === undefined) delete process.env.PRIM_API_KEY;
    else process.env.PRIM_API_KEY = originalPrimary;
    if (originalSecondary === undefined) delete process.env.PRIM_API_KEY_SECONDARY;
    else process.env.PRIM_API_KEY_SECONDARY = originalSecondary;
  }
});
