export const config = { runtime: "edge" };

import { cacheFor, NAVITIA_BUDGET } from "./_quota.js";
import { fetchPrim, primApiKeys } from "./_prim.js";

const PRIM_URL =
  "https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/line_reports" +
  "/physical_modes/physical_mode:Metro/line_reports?count=50";

// Navitia severity effects, collapsed onto the three states the UI cares about.
// Anything unrecognised but present still counts as "info" rather than "ok".
const RANK = { NO_SERVICE: 3, REDUCED_SERVICE: 2, SIGNIFICANT_DELAYS: 2 };
const STATE = { 0: "ok", 1: "info", 2: "delays", 3: "blocked" };

// PRIM writes the bis lines as 3B/7B; the app labels them 3bis/7bis.
const CODE_ALIASES = { "3B": "3bis", "7B": "7bis" };

function stripHtml(s) {
  return (s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function message(disruption, channel) {
  const m = disruption.messages?.find((x) => x.channel?.name === channel);
  return m ? stripHtml(m.text) : null;
}

// PRIM titles are prefixed with the line name ("Métro 12 : Travaux…"), which
// is redundant next to the numeral the detail view already shows.
function dropLinePrefix(text, code) {
  if (!text) return text;
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`^m[ée]tro\\s*${escaped}\\s*[:\\-–]\\s*`, "i"), "");
}

function normalize(payload) {
  const byId = new Map(payload.disruptions?.map((d) => [d.id, d]) ?? []);

  return (payload.line_reports ?? []).map((report) => {
    const line = report.line;

    // A line_report bundles disruptions for the line itself *and* for every
    // stop on it. Stop-level entries are overwhelmingly lift/escalator
    // outages, which shouldn't colour a whole line, so only line-level
    // pt_objects are considered here.
    const active = [];
    for (const obj of report.pt_objects ?? []) {
      if (obj.embedded_type !== "line") continue;
      for (const link of obj.line?.links ?? []) {
        const d = byId.get(link.id);
        if (d?.status === "active") active.push(d);
      }
    }

    const severityOf = (d) => RANK[d.severity?.effect] ?? 1;
    const worst = active.reduce((max, d) => Math.max(max, severityOf(d)), 0);
    const top = active.find((d) => severityOf(d) === worst) ?? null;

    const code = CODE_ALIASES[line.code] ?? line.code;
    return {
      code,
      status: STATE[worst],
      title: top ? dropLinePrefix(message(top, "titre"), line.code) : null,
      detail: top ? message(top, "moteur") : null,
      cause: top?.cause || null,
    };
  });
}

export default async function handler(request) {
  if (request.method !== "GET") {
    return new Response(null, { status: 405, headers: { allow: "GET" } });
  }

  const apiKeys = primApiKeys();
  if (!apiKeys.length) {
    return json({ error: "unconfigured" }, 500, "no-store");
  }

  let upstream;
  try {
    upstream = await fetchPrim(PRIM_URL, {
      apiKeys,
      headers: { accept: "application/json" },
    });
  } catch {
    return json({ error: "upstream_unreachable" }, 502, "no-store");
  }

  if (!upstream.ok) {
    // Deliberately opaque: upstream bodies can echo request details, and a
    // 401 here means our key is bad, which is not the client's business.
    return json({ error: "upstream_error" }, 502, "no-store");
  }

  const lines = normalize(await upstream.json());

  return json(
    { updatedAt: new Date().toISOString(), lines },
    200,
    // Served from Vercel's edge cache, so PRIM sees one request per interval
    // no matter how many visitors are polling, and the interval itself is
    // sized against the quota PRIM reports as remaining.
    cacheFor(upstream, NAVITIA_BUDGET),
  );
}

function json(body, status, cacheControl) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
    },
  });
}
