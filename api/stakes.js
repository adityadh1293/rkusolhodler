// Latest rkuSOL stake activity (Vercel version; same logic as
// netlify/functions/stakes.js). Reads recent signatures on the rkuSOL
// mint account and classifies each transaction by its net rkuSOL token
// balance change: positive = stake (mint), negative = unstake (burn),
// zero-net with a gainer = transfer. Live on-chain data via public RPC.
// Response: { at, stakes: [{ sig, type, amount, wallet, blockTime }] }
const RKU_MINT = "rkubjTrZYioRSeXwDnhwGQzvW3qkcin72JSxUt3WMVp";
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
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const j = await res.json();
      if (j && j.result !== undefined) return j.result;
    } catch (e) { /* try next upstream */ }
  }
  return null;
}

function uiAmt(b) {
  const v = b && b.uiTokenAmount && b.uiTokenAmount.uiAmountString;
  const n = parseFloat(v || "0");
  return Number.isFinite(n) ? n : 0;
}

async function latestStakes() {
  const sigs = await rpcCall("getSignaturesForAddress", [RKU_MINT, { limit: 18 }]);
  if (!Array.isArray(sigs)) return null;
  const valid = sigs.filter((s) => s && s.err === null);
  const found = [];
  for (let i = 0; i < valid.length && found.length < 10; i++) {
    const item = valid[i];
    const tx = await rpcCall("getTransaction", [item.signature, {
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 1,
    }]);
    if (!tx || !tx.meta) continue;
    const pre = (tx.meta.preTokenBalances || []).filter((b) => b.mint === RKU_MINT);
    const post = (tx.meta.postTokenBalances || []).filter((b) => b.mint === RKU_MINT);
    const preMap = new Map();
    pre.forEach((b) => preMap.set(b.accountIndex, uiAmt(b)));
    let netDelta = 0, bestOwner = "", maxGain = 0;
    const indices = new Set([...pre.map((b) => b.accountIndex), ...post.map((b) => b.accountIndex)]);
    indices.forEach((idx) => {
      const pObj = post.find((b) => b.accountIndex === idx);
      const preVal = preMap.get(idx) || 0;
      const postVal = pObj ? uiAmt(pObj) : 0;
      const delta = postVal - preVal;
      netDelta += delta;
      if (delta > maxGain) { maxGain = delta; bestOwner = (pObj && pObj.owner) || ""; }
    });
    const amount = netDelta > 0.001 ? netDelta : (netDelta < -0.001 ? Math.abs(netDelta) : maxGain);
    if (amount > 0.001) {
      const type = netDelta > 0.001 ? "STAKE" : (netDelta < -0.001 ? "UNSTAKE" : "TRANSFER");
      const keys = tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys;
      const signer = (keys && keys[0] && (keys[0].pubkey || keys[0])) || bestOwner || "";
      found.push({
        sig: item.signature,
        type: type,
        amount: amount,
        wallet: bestOwner || signer,
        blockTime: item.blockTime || null,
      });
    }
  }
  return found;
}

export default async function handler(req, res) {
  let stakes = null;
  try { stakes = await latestStakes(); } catch (e) { stakes = null; }
  res.status(200);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(JSON.stringify(stakes ? { at: Date.now(), stakes: stakes } : { at: Date.now(), error: "unavailable", stakes: [] }));
}
