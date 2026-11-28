// Public usage statistics for the rkuSOL dashboard (Vercel version).
// Returns aggregate counts only — no addresses, no personal data.
// Storage: Upstash Redis via REST when configured (see api/track.js);
// otherwise reads the free Abacus counter API fallback.

const { checkRate, deny } = require("./_ratelimit.js");

const ABACUS_NS = "rkusolhodler-stats-v1";

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

async function abacusGet(key) {
  try {
    const res = await fetch("https://abacus.jasoncameron.dev/get/" + ABACUS_NS + "/" + key, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return 0;
    const j = await res.json();
    return typeof j.value === "number" && j.value > 0 ? j.value : 0;
  } catch (e) {
    return 0;
  }
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
  const rate = await checkRate(req, "stats", 120);
  if (!rate.ok) return deny(res, rate.retryAfter);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
  const day = wibDate();
  try {
    const env = redisEnv();
    if (env) {
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
        configured: true, backend: "upstash",
        visits: num(val(0)), checks: num(val(1)), uniqueAddresses: num(val(2)),
        today: { visits: num(val(3)), checks: num(val(4)) }, day: day, at: Date.now(),
      }));
      return;
    }
    const [visits, checks, unique, tVisits, tChecks] = await Promise.all([
      abacusGet("visits"), abacusGet("checks"), abacusGet("unique"),
      abacusGet("visits-" + day), abacusGet("checks-" + day),
    ]);
    res.status(200);
    res.end(JSON.stringify({
      configured: true, backend: "abacus",
      visits: visits, checks: checks, uniqueAddresses: unique,
      today: { visits: tVisits, checks: tChecks }, day: day, at: Date.now(),
    }));
  } catch (e) {
    res.status(200);
    res.end(JSON.stringify({ configured: false, error: "store", visits: 0, checks: 0, uniqueAddresses: 0, today: { visits: 0, checks: 0 }, day: day, at: Date.now() }));
  }
};
