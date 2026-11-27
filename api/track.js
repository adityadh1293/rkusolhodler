// Anonymous usage counter for the rkuSOL dashboard (Vercel version).
// Counts page visits and wallet checks; for checks it stores only the
// SHA-256 hash of the address (computed in the browser) to count unique
// addresses — raw addresses are never stored here.
// Storage: Upstash Redis via REST (env UPSTASH_REDIS_REST_URL /
// UPSTASH_REDIS_REST_TOKEN, or the legacy KV_REST_API_* names).
// Without those env vars this endpoint is a harmless no-op.

function redisEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function pipeline(env, commands) {
  const res = await fetch(env.url + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.token, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error("redis http " + res.status);
  return res.json();
}

function wibDate() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method !== "POST") {
    res.status(405);
    res.end(JSON.stringify({ ok: false, error: "method" }));
    return;
  }
  const env = redisEnv();
  if (!env) {
    res.status(200);
    res.end(JSON.stringify({ ok: false, configured: false }));
    return;
  }
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const t = body && body.t;
  const day = wibDate();
  const cmds = [];
  if (t === "visit") {
    cmds.push(["INCR", "rkusol:visits"], ["INCR", "rkusol:visits:" + day], ["EXPIRE", "rkusol:visits:" + day, 7776000]);
  } else if (t === "check") {
    cmds.push(["INCR", "rkusol:checks"], ["INCR", "rkusol:checks:" + day], ["EXPIRE", "rkusol:checks:" + day, 7776000]);
    const h = body && body.h;
    if (typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) cmds.push(["SADD", "rkusol:addrs", h]);
  } else {
    res.status(400);
    res.end(JSON.stringify({ ok: false, error: "bad type" }));
    return;
  }
  try {
    await pipeline(env, cmds);
    res.status(200);
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.status(200);
    res.end(JSON.stringify({ ok: false, error: "store" }));
  }
};
