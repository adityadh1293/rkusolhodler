// Read-only Solana JSON-RPC proxy for the rkusolhodler wallet check.
//
// Why this exists: the public Solana RPC (api.mainnet-beta.solana.com)
// rejects browser requests from unknown origins with HTTP 403
// "Access forbidden", and the other keyless endpoints are heavily
// rate-limited. Server-side requests carry no browser Origin, so this
// function forwards a fixed allowlist of read-only methods to public
// upstreams and returns the first successful answer.
//
// Nothing is stored. No keys are involved. The method allowlist keeps
// this from becoming an open proxy.

const UPSTREAMS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana.api.onfinality.io/public",
  "https://solana-rpc.publicnode.com",
  "https://solana-mainnet.g.alchemy.com/v2/demo"
];

const ALLOWED_METHODS = new Set([
  "getTokenAccountsByOwner",
  "getBalance",
  "getSignaturesForAddress",
  "getTransaction",
  "getProgramAccounts",
  "getTokenLargestAccounts",
  "getTokenSupply"
]);

const MAX_BODY_BYTES = 8192;
const MAX_BATCH_ITEMS = 25;
const MAX_BATCH_BODY_BYTES = 65536;
const UPSTREAM_TIMEOUT_MS = 12000;

function jsonResponse(status, payload) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(payload)
  };
}

async function tryUpstream(url, body, isBatch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: ctrl.signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (isBatch) {
      if (!Array.isArray(data) || !data.length) return null;
      if (!data.some((item) => item && typeof item.result !== "undefined")) return null;
      return data;
    }
    if (!data || data.error || typeof data.result === "undefined") return null;
    return data;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "POST only" } });
  }
  const raw = event.body || "";
  let req;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    return jsonResponse(400, { jsonrpc: "2.0", id: 1, error: { code: -32700, message: "Invalid JSON" } });
  }
  // Batch requests: an array of read-only calls, each validated
  // against the same allowlist. Used for wallet-history reads.
  if (Array.isArray(req)) {
    if (raw.length > MAX_BATCH_BODY_BYTES) {
      return jsonResponse(413, { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Body too large" } });
    }
    if (!req.length || req.length > MAX_BATCH_ITEMS ||
        !req.every((item) => item && typeof item.method === "string" && ALLOWED_METHODS.has(item.method))) {
      return jsonResponse(400, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not allowed" } });
    }
    const body = JSON.stringify(req.map((item, i) => ({
      jsonrpc: "2.0", id: typeof item.id === "number" ? item.id : i, method: item.method, params: item.params
    })));
    for (const url of UPSTREAMS) {
      const data = await tryUpstream(url, body, true);
      if (data) return jsonResponse(200, data);
    }
    return jsonResponse(502, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "All upstreams unavailable" } });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return jsonResponse(413, { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Body too large" } });
  }
  if (!req || typeof req.method !== "string" || !ALLOWED_METHODS.has(req.method)) {
    return jsonResponse(400, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not allowed" } });
  }
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: req.method, params: req.params });
  for (const url of UPSTREAMS) {
    const data = await tryUpstream(url, body, false);
    if (data) return jsonResponse(200, data);
  }
  return jsonResponse(502, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "All upstreams unavailable" } });
};
