// Live price proxy for the rkuSOL dashboard (Vercel version; same-origin,
// avoids CSP/CORS limits). Same logic as netlify/functions/price.js.
// SOL/USD: Jupiter Price API v3, CoinGecko, DefiLlama coins — raced in parallel,
// first success wins. Stake pool: DefiLlama protocol API (TVL series + staked SOL,
// read on-chain by their adapter).
// Response: { at, solUSD, solSource, stakedSOL, tvlUSD, series: [[isoDate, usd], ...] }
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

export default async function handler(req, res) {
  const out = { at: Date.now() };
  const [sol, proto] = await Promise.all([
    solPrice(),
    fetchJson("https://api.llama.fi/protocol/raiku-staked-sol", 9000).catch(() => null),
  ]);
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
