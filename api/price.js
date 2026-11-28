// Live price proxy for the rkuSOL dashboard (Vercel version; same-origin,
// avoids CSP/CORS limits). Same logic as netlify/functions/price.js.
// SOL/USD: Jupiter Price API v3, CoinGecko, DefiLlama coins — raced in parallel,
// first success wins. Stake pool: DefiLlama protocol API (TVL series + staked SOL,
// read on-chain by their adapter).
// Response: { at, solUSD, solSource, stakedSOL, tvlUSD, series: [[isoDate, usd], ...], validator: { stakeSOL, leaderSlots, epoch, slotsInEpoch } }
import rl from "./_ratelimit.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

async function fetchJson(url, ms) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms || 6000) });
  if (!res.ok) throw new Error("http " + res.status);
  return res.json();
}

async function solPrice() {
  const attempts = [
    fetchJson("https://lite-api.jup.ag/price/v3?ids=" + SOL_MINT).then((j) => {
      const v = j && j[SOL_MINT] && j[SOL_MINT].usdPrice;
      if (typeof v !== "number" || !(v > 0)) throw new Error("bad jupiter");
      return { price: v, source: "Jupiter" };
    }),
    fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd").then((j) => {
      const v = j && j.solana && j.solana.usd;
      if (typeof v !== "number" || !(v > 0)) throw new Error("bad coingecko");
      return { price: v, source: "CoinGecko" };
    }),
    fetchJson("https://coins.llama.fi/prices/current/coingecko:solana").then((j) => {
      const v = j && j.coins && j.coins["coingecko:solana"] && j.coins["coingecko:solana"].price;
      if (typeof v !== "number" || !(v > 0)) throw new Error("bad llama coins");
      return { price: v, source: "DefiLlama" };
    }),
  ];
  try {
    return await Promise.any(attempts);
  } catch (e) {
    return null;
  }
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }
// Raiku validator (mainnet) — live on-chain stats behind the Blackline
// Power estimate: activated stake + leader slots in the current epoch.
const VALIDATOR_IDENTITY = "9xcXe4WRAfbVoVgQmFD5xgFHioL9dD7c74pQZ7PeczT";
const VALIDATOR_VOTE = "AVD61fbwxDGuLGCanPWQPxRjdqYk3icssz5u7JH8kbta";
const RPC_UPSTREAMS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana.api.onfinality.io/public",
  "https://solana-rpc.publicnode.com",
  "https://solana-mainnet.g.alchemy.com/v2/demo"
];

async function rpcCall(method, params) {
  for (const url of RPC_UPSTREAMS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const j = await res.json();
      if (j && j.result !== undefined) return j.result;
    } catch (e) { /* try next upstream */ }
  }
  return null;
}

async function validatorStats() {
  const [va, ls, ei] = await Promise.all([
    rpcCall("getVoteAccounts", [{ votePubkey: VALIDATOR_VOTE }]),
    rpcCall("getLeaderSchedule", [null, { identity: VALIDATOR_IDENTITY }]),
    rpcCall("getEpochInfo", []),
  ]);
  const out = {};
  const cur = va && Array.isArray(va.current) ? va.current[0] : null;
  if (cur && typeof cur.activatedStake === "number") out.stakeSOL = cur.activatedStake / 1e9;
  const slots = ls && Array.isArray(ls[VALIDATOR_IDENTITY]) ? ls[VALIDATOR_IDENTITY].length : null;
  if (typeof slots === "number") out.leaderSlots = slots;
  if (ei && typeof ei.epoch === "number") out.epoch = ei.epoch;
  if (ei && typeof ei.slotsInEpoch === "number") out.slotsInEpoch = ei.slotsInEpoch;
  return Object.keys(out).length ? out : null;
}


export default async function handler(req, res) {
  const rate = await rl.checkRate(req, "price", 120);
  if (!rate.ok) return rl.deny(res, rate.retryAfter);
  const out = { at: Date.now() };
  const [sol, proto, val] = await Promise.all([
    solPrice(),
    fetchJson("https://api.llama.fi/protocol/raiku-staked-sol", 9000).catch(() => null),
    validatorStats().catch(() => null),
  ]);
  if (val) out.validator = val;
  if (sol) { out.solUSD = sol.price; out.solSource = sol.source; }
  const solChain = proto && proto.chainTvls && proto.chainTvls.Solana;
  if (solChain && Array.isArray(solChain.tvl) && solChain.tvl.length) {
    out.series = solChain.tvl.map((p) => {
      const dt = new Date(p.date * 1000);
      const iso = dt.getUTCFullYear() + "-" + pad2(dt.getUTCMonth() + 1) + "-" + pad2(dt.getUTCDate());
      return [iso, p.totalLiquidityUSD];
    });
    out.tvlUSD = out.series[out.series.length - 1][1];
    const toks = solChain.tokens;
    if (Array.isArray(toks) && toks.length) {
      const lastTok = toks[toks.length - 1].tokens;
      if (lastTok && typeof lastTok.SOL === "number") out.stakedSOL = lastTok.SOL;
    }
  }
  res.status(200);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(JSON.stringify(out));
}
