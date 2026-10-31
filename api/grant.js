// POST /api/grant { player, task, ticket? } (or { player, task, action: "start" } for click-through tasks) -> { amount, grantId, deadline, signature } for LeaderboardV2.claimLifeGrant.
// Uses the existing SCORE_SIGNER_PRIVATE_KEY / LEADERBOARD_V2_ADDRESS env vars (the contract checks grants
// against scoreSigner). No new secrets. Once per wallet per task is enforced on-chain (grantUsed).
import { getAddress, isAddress } from "ethers";
import { loadConfig, RejectError } from "../server/signer.js";
import { signGrant, startClickTask } from "../server/grant.js";
import { getStore, limit, clientIp } from "../server/guards.js";
import { cors } from "../server/http.js";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    const cfg = loadConfig();
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    if (!isAddress(body.player)) throw new RejectError(400, "bad player");
    const player = getAddress(body.player);
    const store = getStore();
    await limit(store, `grant:ip:${clientIp(req)}`, 10, 60);
    await limit(store, `grant:p:${player}`, 5, 60);
    const task = String(body.task || "");
    if (body.action === "start") return res.status(200).json(startClickTask({ player, task }, cfg));
    const out = await signGrant({ player, task, ticket: body.ticket ? String(body.ticket) : undefined }, cfg);
    return res.status(200).json(out);
  } catch (e) {
    const status = e instanceof RejectError ? e.status : 500;
    if (status === 500) console.error("grant error", e?.message);
    return res.status(status).json({ error: status === 500 ? "internal error" : e.message });
  }
}
