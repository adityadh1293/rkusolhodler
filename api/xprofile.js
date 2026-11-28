// Public X (Twitter) profile lookup for the optional holder-card identity
// (Vercel version). Given only a username, returns the public display name
// and avatar URL via public mirror APIs (fxtwitter, fallback vxtwitter) —
// no X account or API key needed. Cosmetic only: a typed username is
// self-declared and does not prove wallet ownership.
// Response: { ok, username, name, avatar } or { ok: false }
import rl from "./_ratelimit.js";

const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;

function upgradeAvatar(url) {
  if (typeof url !== "string") return null;
  // pbs.twimg.com size variants: _normal (48px) -> _400x400 for a sharper card.
  return url.replace(/_normal(\.(jpg|jpeg|png|webp))$/i, "_400x400$1");
}

async function fromFx(username) {
  const res = await fetch("https://api.fxtwitter.com/" + username, {
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) throw new Error("fx http " + res.status);
  const j = await res.json();
  const u = j && j.user;
  if (!u || !u.screen_name) throw new Error("fx no user");
  return { username: u.screen_name, name: u.name || u.screen_name, avatar: upgradeAvatar(u.avatar_url) };
}

async function fromVx(username) {
  const res = await fetch("https://api.vxtwitter.com/" + username, {
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) throw new Error("vx http " + res.status);
  const j = await res.json();
  if (!j || !j.screen_name) throw new Error("vx no user");
  return { username: j.screen_name, name: j.name || j.screen_name, avatar: upgradeAvatar(j.profile_image_url) };
}

export default async function handler(req, res) {
  const rate = await rl.checkRate(req, "xprofile", 60);
  if (!rate.ok) return rl.deny(res, rate.retryAfter);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  const u = (req.query && req.query.u) || "";
  const username = String(u).trim().replace(/^@/, "");
  if (!USERNAME_RE.test(username)) {
    res.status(400);
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ ok: false, error: "bad username" }));
    return;
  }
  let profile = null;
  try { profile = await fromFx(username); } catch (e) { profile = null; }
  if (!profile) {
    try { profile = await fromVx(username); } catch (e) { profile = null; }
  }
  if (!profile) {
    res.status(404);
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ ok: false, error: "not found" }));
    return;
  }
  res.status(200);
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
  res.end(JSON.stringify({ ok: true, username: profile.username, name: profile.name, avatar: profile.avatar }));
}
