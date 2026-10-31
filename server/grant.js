// Task life grants for LeaderboardV2.claimLifeGrant (signed by the same key as scores: the contract's scoreSigner).
// Once per wallet per task is enforced ON-CHAIN by grantUsed[player][grantId]; the backend also checks it first.
// Pure node (no Vercel specifics) so it can be unit/fork-tested.
import { createHmac, timingSafeEqual } from "node:crypto";
import { Contract, getAddress, isAddress, keccak256, toUtf8Bytes } from "ethers";
import { GRANT_TYPES, domain, RejectError } from "./signer.js";

export const GRANT_ABI = [
  "function grantUsed(address,uint256) view returns (bool)",
  "function scoreSigner() view returns (address)",
  "function paused() view returns (bool)",
];
export const GRANT_TTL_SECONDS = 300;
export const ACCUMULATOR_STATUS_URL = "https://accumulator-8.vercel.app/api/status";

export const CLICK_WAIT_SECONDS = 10;      // a click-through ticket becomes valid 10 s after the link was opened
export const CLICK_TICKET_TTL_SECONDS = 3600;

// grantId == the task id used in index.html: 1 = Follow on X, 3 = Try Accumulator, 4 = Try Keep.
// grantId 2 (old "Follow on Base App") is retired and never signed again.
// Accumulator is really verified. X follows can't be checked without a paid X API tier, and Keep has no public
// per-wallet endpoint yet, so those two are click-through tasks: /api/grant { action: "start" } returns a ticket
// (HMAC by the signer key) when the player opens the link; the voucher is signed only once the ticket is >= 10 s old.
// Once per wallet per task is still enforced on-chain (grantUsed). See docs/TASK-VERIFICATION.md.
export const TASKS = {
  x: { grantId: 1n, lives: 1n, clickThrough: true },
  accumulator: { grantId: 3n, lives: 1n, verify: verifyAccumulator },
  keep: { grantId: 4n, lives: 1n, clickThrough: true },
};

function ticketMac(cfg, player, task, ts) {
  const key = keccak256(toUtf8Bytes("asteroid-click-ticket:" + cfg.wallet.privateKey));
  return createHmac("sha256", key).update(`${cfg.chainId}|${cfg.leaderboard}|${getAddress(player)}|${task}|${ts}`).digest("base64url");
}
const nowSec = (cfg) => Math.floor(Number(cfg.now ?? Date.now() / 1000));

/** Called when the player opens the X / Keep link. Returns a ticket that becomes redeemable after CLICK_WAIT_SECONDS. */
export function startClickTask({ player, task }, cfg) {
  if (!isAddress(player)) throw new RejectError(400, "bad player");
  if (!TASKS[task]?.clickThrough) throw new RejectError(400, "not a click-through task");
  const ts = nowSec(cfg);
  return { task, ticket: `${ts}.${ticketMac(cfg, player, task, ts)}`, waitSeconds: CLICK_WAIT_SECONDS };
}

export function verifyClickTicket(player, task, ticket, cfg) {
  const [tsStr, mac] = String(ticket || "").split(".");
  const ts = Number(tsStr);
  if (!Number.isInteger(ts) || !mac) throw new RejectError(403, "open the link first, then claim");
  const want = Buffer.from(ticketMac(cfg, player, task, ts)), got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new RejectError(403, "invalid ticket – open the link again");
  const age = nowSec(cfg) - ts;
  if (age < CLICK_WAIT_SECONDS) throw new RejectError(425, `almost there – try again in ${CLICK_WAIT_SECONDS - Math.max(age, 0)} s`);
  if (age > CLICK_TICKET_TTL_SECONDS) throw new RejectError(403, "ticket expired – open the link again");
  return { clickedAt: ts };
}

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

export async function signGrant({ player, task, ticket }, cfg, deps = {}) {
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
  const proof = t.clickThrough ? verifyClickTicket(player, task, ticket, cfg) : await (deps.verify || t.verify)(player, deps);
  const deadline = BigInt(cfg.now ?? block.timestamp) + BigInt(GRANT_TTL_SECONDS);
  const value = { player, amount: t.lives, grantId: t.grantId, deadline };
  const signature = await wallet.signTypedData(domain(chainId, leaderboard), GRANT_TYPES, value);
  return { player, task, amount: t.lives.toString(), grantId: t.grantId.toString(), deadline: deadline.toString(), signature, proof };
}
