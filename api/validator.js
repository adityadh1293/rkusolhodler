// Raiku validator block analyzer (Vercel version; same logic as
// netlify/functions/validator.js). Live on-chain data via public Solana
// RPC: epoch info, block production for the Raiku validator identity,
// its leader schedule, and a scan of its most recently produced blocks
// (transaction count + fee reward per block).
// Response: { at, epoch, leaderSlotsAssigned, leaderSlotsDone,
//   blocksProduced, skipped, skipRate, avgFeeSOL, avgTxs,
//   recentBlocks: [{ slot, blockTime, txCount, feeSOL }] }
import rl from "./_ratelimit.js";

const VALIDATOR_IDENTITY = "9xcXe4WRAfbVoVgQmFD5xgFHioL9dD7c74pQZ7PeczT";
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

async function validatorData() {
  const [epochInfo, blockProd, leaderSched] = await Promise.all([
    rpcCall("getEpochInfo", []),
    rpcCall("getBlockProduction", [{ identity: VALIDATOR_IDENTITY }]),
    rpcCall("getLeaderSchedule", [null, { identity: VALIDATOR_IDENTITY }]),
  ]);
  if (!epochInfo) return null;
  const out = { at: Date.now(), epoch: epochInfo.epoch };
  const tuple = (blockProd && blockProd.value && blockProd.value.byIdentity &&
    blockProd.value.byIdentity[VALIDATOR_IDENTITY]) || [0, 0];
  out.leaderSlotsDone = tuple[0] || 0;
  out.blocksProduced = tuple[1] || 0;
  out.skipped = Math.max(0, out.leaderSlotsDone - out.blocksProduced);
  out.skipRate = out.leaderSlotsDone > 0 ? (out.skipped / out.leaderSlotsDone) * 100 : 0;
  const offsets = (leaderSched && leaderSched[VALIDATOR_IDENTITY]) || [];
  out.leaderSlotsAssigned = offsets.length;
  const epochStart = epochInfo.absoluteSlot - epochInfo.slotIndex;
  const pastSlots = offsets
    .map((o) => epochStart + o)
    .filter((s) => s < epochInfo.absoluteSlot - 20)
    .sort((a, b) => b - a)
    .slice(0, 6);
  const blocks = await Promise.all(pastSlots.map(async (slot) => {
    const block = await rpcCall("getBlock", [slot, {
      encoding: "json",
      transactionDetails: "signatures",
      rewards: true,
      maxSupportedTransactionVersion: 1,
    }]);
    if (!block) return null;
    const feeObj = (block.rewards || []).find((r) => r.rewardType === "Fee");
    return {
      slot: slot,
      blockTime: block.blockTime || null,
      txCount: Array.isArray(block.signatures) ? block.signatures.length : 0,
      feeSOL: feeObj ? feeObj.lamports / 1e9 : 0,
    };
  }));
  out.recentBlocks = blocks.filter(Boolean);
  if (out.recentBlocks.length) {
    out.avgFeeSOL = out.recentBlocks.reduce((a, b) => a + b.feeSOL, 0) / out.recentBlocks.length;
    out.avgTxs = Math.round(out.recentBlocks.reduce((a, b) => a + b.txCount, 0) / out.recentBlocks.length);
  }
  return out;
}

export default async function handler(req, res) {
  const rate = await rl.checkRate(req, "validator", 120);
  if (!rate.ok) return rl.deny(res, rate.retryAfter);
  let out = null;
  try { out = await validatorData(); } catch (e) { out = null; }
  res.status(200);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(JSON.stringify(out || { at: Date.now(), error: "unavailable" }));
}
