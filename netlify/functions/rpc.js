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
const UPSTREAM_TIMEOUT_MS = 12000;

function jsonResponse(status, payload) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(payload)
  };
}

async function tryUpstream(url, body) {
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
  if (raw.length > MAX_BODY_BYTES) {
    return jsonResponse(413, { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Body too large" } });
  }
  let req;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    return jsonResponse(400, { jsonrpc: "2.0", id: 1, error: { code: -32700, message: "Invalid JSON" } });
  }
  if (!req || typeof req.method !== "string" || !ALLOWED_METHODS.has(req.method)) {
    return jsonResponse(400, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not allowed" } });
  }
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: req.method, params: req.params });
  for (const url of UPSTREAMS) {
    const data = await tryUpstream(url, body);
    if (data) return jsonResponse(200, data);
  }
  return jsonResponse(502, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "All upstreams unavailable" } });
};
