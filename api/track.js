// Anonymous usage counter for the rkuSOL dashboard (Vercel version).
// Counts page visits and wallet checks; for checks it stores only the
// SHA-256 hash of the address (computed in the browser) to count unique
// addresses — raw addresses are never stored here.
// Storage: Upstash Redis via REST when configured (env
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN, or KV_REST_API_*);
// otherwise falls back to the free Abacus counter API so counts work
// immediately with zero setup.

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

async function abacusHit(key) {
  const res = await fetch("https://abacus.jasoncameron.dev/hit/" + ABACUS_NS + "/" + key, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("abacus http " + res.status);
  const j = await res.json();
  return typeof j.value === "number" ? j.value : 0;
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
  const rate = await checkRate(req, "track", 30);
  if (!rate.ok) return deny(res, rate.retryAfter);
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const t = body && body.t;
  if (t !== "visit" && t !== "check") {
    res.status(400);
    res.end(JSON.stringify({ ok: false, error: "bad type" }));
    return;
  }
  const day = wibDate();
  const h = body && body.h;
  const validHash = typeof h === "string" && /^[0-9a-f]{64}$/.test(h) ? h : null;
  try {
    const env = redisEnv();
    if (env) {
      const cmds = t === "visit"
        ? [["INCR", "rkusol:visits"], ["INCR", "rkusol:visits:" + day], ["EXPIRE", "rkusol:visits:" + day, 7776000]]
        : [["INCR", "rkusol:checks"], ["INCR", "rkusol:checks:" + day], ["EXPIRE", "rkusol:checks:" + day, 7776000]];
      if (t === "check" && validHash) cmds.push(["SADD", "rkusol:addrs", validHash]);
      await pipeline(env, cmds);
    } else if (t === "visit") {
      await Promise.all([abacusHit("visits"), abacusHit("visits-" + day)]);
    } else {
      await Promise.all([abacusHit("checks"), abacusHit("checks-" + day)]);
      if (validHash) {
        const seen = await abacusHit("addr-" + validHash.slice(0, 32));
        if (seen === 1) await abacusHit("unique");
      }
    }
    res.status(200);
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.status(200);
    res.end(JSON.stringify({ ok: false, error: "store" }));
  }
};
