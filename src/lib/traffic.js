const ENDPOINT = "/api/traffic";
const REFRESH_MS = 60_000;

const state = new Map(); // label -> { status, title, detail, cause }
const listeners = new Set();

export function onTraffic(fn) {
  listeners.add(fn);
  if (state.size) fn(state);
  return () => listeners.delete(fn);
}

export function statusFor(label) {
  return state.get(label) ?? null;
}

async function refresh() {
  try {
    const res = await fetch(ENDPOINT, { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const { lines } = await res.json();
    if (!Array.isArray(lines)) return;

    state.clear();
    for (const line of lines) state.set(line.code, line);
    listeners.forEach((fn) => fn(state));
  } catch {
    // Offline or the endpoint is unavailable: keep whatever we last had and
    // let the next tick try again. The picker stays fully usable without it.
  }
}

export function startTraffic() {
  refresh();
  setInterval(refresh, REFRESH_MS);

  // A backgrounded tab's timers are throttled, so whatever is on screen when
  // the user comes back can be arbitrarily stale. Re-fetch on return.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
}
