// Read-only Solana JSON-RPC proxy for the rkusolhodler wallet check (Vercel version).
// Same logic as netlify/functions/rpc.js: fixed allowlist of read-only methods,
// 8 KB body cap, sequential fallback across public upstreams. Nothing is stored.

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

export const config = { api: { bodyParser: false } };

function send(res, status, payload) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BATCH_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return send(res, 405, { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "POST only" } });
  }
  const raw = await readBody(req);
  if (raw === null) {
    return send(res, 413, { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Body too large" } });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return send(res, 400, { jsonrpc: "2.0", id: 1, error: { code: -32700, message: "Invalid JSON" } });
  }
  // Batch requests: an array of read-only calls, each validated
  // against the same allowlist. Used for wallet-history reads.
  if (Array.isArray(parsed)) {
    if (!parsed.length || parsed.length > MAX_BATCH_ITEMS ||
        !parsed.every((item) => item && typeof item.method === "string" && ALLOWED_METHODS.has(item.method))) {
      return send(res, 400, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not allowed" } });
    }
    const body = JSON.stringify(parsed.map((item, i) => ({
      jsonrpc: "2.0", id: typeof item.id === "number" ? item.id : i, method: item.method, params: item.params
    })));
    for (const url of UPSTREAMS) {
      const data = await tryUpstream(url, body, true);
      if (data) return send(res, 200, data);
    }
    return send(res, 502, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "All upstreams unavailable" } });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return send(res, 413, { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Body too large" } });
  }
  if (!parsed || typeof parsed.method !== "string" || !ALLOWED_METHODS.has(parsed.method)) {
    return send(res, 400, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not allowed" } });
  }
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: parsed.method, params: parsed.params });
  for (const url of UPSTREAMS) {
    const data = await tryUpstream(url, body, false);
    if (data) return send(res, 200, data);
  }
  return send(res, 502, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "All upstreams unavailable" } });
}
