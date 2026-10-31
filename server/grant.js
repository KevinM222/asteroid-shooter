// Task life grants for LeaderboardV2.claimLifeGrant (signed by the same key as scores: the contract's scoreSigner).
// Once per wallet per task is enforced ON-CHAIN by grantUsed[player][grantId]; the backend also checks it first.
// Pure node (no Vercel specifics) so it can be unit/fork-tested.
import { Contract, getAddress, isAddress } from "ethers";
import { GRANT_TYPES, domain, RejectError } from "./signer.js";

export const GRANT_ABI = [
  "function grantUsed(address,uint256) view returns (bool)",
  "function scoreSigner() view returns (address)",
  "function paused() view returns (bool)",
];
export const GRANT_TTL_SECONDS = 300;
export const ACCUMULATOR_STATUS_URL = "https://accumulator-8.vercel.app/api/status";

// grantId == the task id used in index.html (1 = X follow, 2 = Base App follow, 3 = Accumulator).
// Only tasks with a real, server-side check are listed. X / Base App follows are not verifiable without
// a paid X API tier or a Farcaster/Neynar API key (see docs/TASK-VERIFICATION.md).
export const TASKS = {
  accumulator: { grantId: 3n, lives: 1n, verify: verifyAccumulator },
};

/** Accumulator creates a player's bot wallet only after the player signs "Start" in the app with this wallet. */
export async function verifyAccumulator(player, { fetchImpl = fetch } = {}) {
  let j;
  try {
    const r = await fetchImpl(`${ACCUMULATOR_STATUS_URL}?address=${player}`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    j = await r.json();
  } catch (e) {
    throw new RejectError(503, "could not reach Accumulator, try again later");
  }
  if (j?.botWalletExists !== true || !isAddress(j?.botAddress)) {
    throw new RejectError(403, "no Accumulator bot found for this wallet yet – start a bot in Accumulator with this same wallet first");
  }
  return { botAddress: getAddress(j.botAddress) };
}

export async function signGrant({ player, task }, cfg, deps = {}) {
  const { provider, wallet, leaderboard, chainId } = cfg;
  if (!isAddress(player)) throw new RejectError(400, "bad player");
  player = getAddress(player);
  const t = TASKS[task];
  if (!t) throw new RejectError(400, "this task cannot be verified automatically yet");
  const lb = new Contract(leaderboard, GRANT_ABI, provider);
  const [used, onchainSigner, paused, block] = await Promise.all([
    lb.grantUsed(player, t.grantId), lb.scoreSigner(), lb.paused(), provider.getBlock("latest"),
  ]);
  if (paused) throw new RejectError(503, "leaderboard paused");
  if (getAddress(onchainSigner) !== wallet.address) throw new RejectError(500, "signer key does not match contract");
  if (used) throw new RejectError(409, "already claimed for this wallet");
  const proof = await (deps.verify || t.verify)(player, deps);
  const deadline = BigInt(cfg.now ?? block.timestamp) + BigInt(GRANT_TTL_SECONDS);
  const value = { player, amount: t.lives, grantId: t.grantId, deadline };
  const signature = await wallet.signTypedData(domain(chainId, leaderboard), GRANT_TYPES, value);
  return { player, task, amount: t.lives.toString(), grantId: t.grantId.toString(), deadline: deadline.toString(), signature, proof };
}
