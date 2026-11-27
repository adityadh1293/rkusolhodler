// Public usage statistics for the rkuSOL dashboard (Vercel version).
// Returns aggregate counts only — no addresses, no personal data.
// Storage: Upstash Redis via REST (see api/track.js).

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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
  const env = redisEnv();
  if (!env) {
    res.status(200);
    res.end(JSON.stringify({ configured: false, visits: 0, checks: 0, uniqueAddresses: 0, today: { visits: 0, checks: 0 }, at: Date.now() }));
    return;
  }
  const day = wibDate();
  try {
    const r = await pipeline(env, [
      ["GET", "rkusol:visits"],
      ["GET", "rkusol:checks"],
      ["SCARD", "rkusol:addrs"],
      ["GET", "rkusol:visits:" + day],
      ["GET", "rkusol:checks:" + day],
    ]);
    const val = (i) => (r && r[i] ? r[i].result : null);
    res.status(200);
    res.end(JSON.stringify({
      configured: true,
      visits: num(val(0)),
      checks: num(val(1)),
      uniqueAddresses: num(val(2)),
      today: { visits: num(val(3)), checks: num(val(4)) },
      day: day,
      at: Date.now(),
    }));
  } catch (e) {
    res.status(200);
    res.end(JSON.stringify({ configured: false, error: "store", visits: 0, checks: 0, uniqueAddresses: 0, today: { visits: 0, checks: 0 }, at: Date.now() }));
  }
};
