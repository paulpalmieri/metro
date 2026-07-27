// Underscore-prefixed so Vercel treats this as a private module and never
// exposes it as a route.
//
// Rather than pick a fixed interval and hope, the traffic response's cache
// lifetime is derived from the Navitia quota PRIM says is actually left.

export const NAVITIA_BUDGET = { limit: 4000, floor: 60 };

// Never spend more than this share of what's left before the quota resets.
// The rest absorbs traffic spikes and any other client sharing the key.
const SPEND_RATIO = 0.5;

const DAY = 86_400;

export function readQuota(response) {
  const num = (name) => {
    const raw = response.headers.get(name);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    remaining: num("x-ratelimit-remaining-day") ?? num("ratelimit-remaining"),
    resetIn: num("ratelimit-reset"),
  };
}

/**
 * Cache-Control that provably cannot exhaust the quota.
 *
 * Spending `remaining * SPEND_RATIO` calls evenly across the time left before
 * reset gives the shortest interval that's still safe. When PRIM stops
 * sending quota headers we fall back to spreading the whole daily limit over
 * a day, which is the same arithmetic with pessimistic inputs.
 */
export function cacheFor(response, budget) {
  const { remaining, resetIn } = readQuota(response);

  const window = resetIn && resetIn > 0 ? Math.min(resetIn, DAY) : DAY;
  const spendable =
    remaining === null ? budget.limit * SPEND_RATIO : remaining * SPEND_RATIO;

  // Quota all but gone: hold whatever we have until the reset rather than
  // spending the last calls on a page nobody may be looking at.
  if (spendable < 1) {
    return `public, s-maxage=${Math.ceil(window)}, stale-while-revalidate=${DAY}`;
  }

  const safe = Math.ceil(window / spendable);
  const maxAge = Math.max(budget.floor, safe);

  return `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 4}`;
}
