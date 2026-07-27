export function primApiKeys(environment = process.env) {
  return [...new Set([
    environment.PRIM_API_KEY,
    environment.PRIM_API_KEY_SECONDARY,
  ].filter(Boolean))];
}

export async function fetchPrim(
  url,
  {
    apiKeys = primApiKeys(),
    fetcher = fetch,
    timeoutMilliseconds = 8000,
    ...init
  } = {},
) {
  if (!apiKeys.length) throw new Error("PRIM_API_KEY is not configured");

  let response;
  for (const [index, apiKey] of apiKeys.entries()) {
    const headers = new Headers(init.headers);
    headers.set("apikey", apiKey);
    response = await fetcher(url, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(timeoutMilliseconds),
    });
    if (response.status !== 429 || index === apiKeys.length - 1) return response;
    await response.body?.cancel().catch(() => {});
  }
  return response;
}
