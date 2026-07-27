import test from "node:test";
import assert from "node:assert/strict";
import { fetchPrim, primApiKeys } from "../api/_prim.js";

test("uses the primary PRIM token while it is available", async () => {
  const usedKeys = [];
  const response = await fetchPrim("https://example.test", {
    apiKeys: ["primary", "secondary"],
    fetcher: async (_url, init) => {
      usedKeys.push(init.headers.get("apikey"));
      return new Response("ok");
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(usedKeys, ["primary"]);
});

test("retries once with the secondary PRIM token after a rate limit", async () => {
  const usedKeys = [];
  const response = await fetchPrim("https://example.test", {
    apiKeys: ["primary", "secondary"],
    fetcher: async (_url, init) => {
      const apiKey = init.headers.get("apikey");
      usedKeys.push(apiKey);
      return apiKey === "primary"
        ? new Response("rate limited", { status: 429 })
        : new Response("ok");
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(usedKeys, ["primary", "secondary"]);
});

test("does not fail over for non-rate-limit failures", async () => {
  const usedKeys = [];
  const response = await fetchPrim("https://example.test", {
    apiKeys: ["primary", "secondary"],
    fetcher: async (_url, init) => {
      usedKeys.push(init.headers.get("apikey"));
      return new Response("forbidden", { status: 403 });
    },
  });

  assert.equal(response.status, 403);
  assert.deepEqual(usedKeys, ["primary"]);
});

test("omits missing and duplicate PRIM tokens", () => {
  assert.deepEqual(primApiKeys({
    PRIM_API_KEY: "same",
    PRIM_API_KEY_SECONDARY: "same",
  }), ["same"]);
  assert.deepEqual(primApiKeys({}), []);
});
