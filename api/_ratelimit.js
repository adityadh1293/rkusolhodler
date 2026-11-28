// Per-IP fixed-window rate limiter for the rkuSOL checker API (Vercel).
// Protects the function endpoints from request floods (DoS / quota burn).
// Storage: Upstash Redis via REST when configured (same env vars as
// api/track.js and api/stats.js); otherwise an in-memory per-instance
// fallback. Fail-open: any storage error lets the request through so a
// Redis outage can never take the checker down.
const WINDOW_MS = 60000;
const mem = new Map();

function clientIp(req) {
  const xff = req.headers && req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function redisEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function redisCount(env, key) {
  const res = await fetch(env.url + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.token, "Content-Type": "application/json" },
    body: JSON.stringify([["INCR", key], ["EXPIRE", key, 70]]),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error("redis http " + res.status);
  const j = await res.json();
  const n = j && j[0] && typeof j[0].result === "number" ? j[0].result : 0;
  return n;
}

function memCount(key) {
  const now = Date.now();
  let e = mem.get(key);
  if (!e || now - e.start >= WINDOW_MS) {
    e = { start: now, count: 0 };
    mem.set(key, e);
  }
  e.count++;
  if (mem.size > 5000) {
    for (const [k, v] of mem) if (now - v.start >= WINDOW_MS) mem.delete(k);
  }
  return { count: e.count, retryAfter: Math.ceil((e.start + WINDOW_MS - now) / 1000) };
}

// Returns { ok, retryAfter }. bucket = endpoint name, limit = max requests
// per IP per minute.
async function checkRate(req, bucket, limit) {
  const ip = clientIp(req);
  const env = redisEnv();
  if (env) {
    try {
      const key = "rl:" + bucket + ":" + ip + ":" + Math.floor(Date.now() / WINDOW_MS);
      const count = await redisCount(env, key);
      const retryAfter = 60 - Math.floor((Date.now() % WINDOW_MS) / 1000);
      return { ok: count <= limit, retryAfter };
    } catch (e) {
      /* fall through to the in-memory fallback */
    }
  }
  const r = memCount(bucket + ":" + ip);
  return { ok: r.count <= limit, retryAfter: r.retryAfter };
}

// Origin check: browser requests carrying an Origin (or Referer) from a
// foreign site are rejected, so other websites cannot use these endpoints
// as a free proxy from their visitors' browsers. Requests with neither
// header (curl, health checks) pass through — the rate limiter still
// applies to them. This raises the bar against casual abuse; it is not a
// substitute for the rate limit.
const ALLOWED_ORIGINS = new Set(["https://rkusolhodler.vercel.app"]);

function originOk(req) {
  const origin = req.headers && req.headers.origin;
  if (typeof origin === "string" && origin) return ALLOWED_ORIGINS.has(origin);
  const referer = req.headers && req.headers.referer;
  if (typeof referer === "string" && referer) {
    try { return ALLOWED_ORIGINS.has(new URL(referer).origin); } catch (e) { return false; }
  }
  return true;
}

function denyOrigin(res) {
  res.status(403);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ error: "origin_not_allowed" }));
}

function deny(res, retryAfter) {
  res.status(429);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Retry-After", String(Math.max(1, retryAfter || 60)));
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ error: "rate_limited" }));
}

module.exports = { checkRate, deny, originOk, denyOrigin };
