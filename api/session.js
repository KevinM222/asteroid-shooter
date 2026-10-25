// POST /api/session { player, gameId } -> { session }
// Call right after LeaderboardV2.startGame() confirms. Checks the game exists on-chain and is open.
import { Contract, getAddress, isAddress } from "ethers";
import { loadConfig, LEADERBOARD_ABI, RejectError } from "../server/signer.js";
import { getStore, limit, LIMITS, clientIp, issueSession } from "../server/guards.js";
import { cors } from "../server/http.js";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    const cfg = loadConfig(); // clear 503 first if not configured
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    if (!isAddress(body.player)) throw new RejectError(400, "bad player");
    const player = getAddress(body.player);
    const gameId = BigInt(body.gameId ?? 0);
    if (gameId <= 0n) throw new RejectError(400, "bad gameId");
    const store = getStore();
    await limit(store, `sess:ip:${clientIp(req)}`, LIMITS.sessionPerIpPerMin, 60);
    await limit(store, `sess:p:${player}`, LIMITS.sessionPerPlayerPerMin, 60);
    const g = await new Contract(cfg.leaderboard, LEADERBOARD_ABI, cfg.provider).games(player, gameId);
    if (g.startedAt === 0n) throw new RejectError(404, "game not started on-chain");
    if (g.submitted) throw new RejectError(409, "game already submitted");
    return res.status(200).json({ session: issueSession({ player, gameId }, process.env.SESSION_SECRET) });
  } catch (e) {
    const status = e instanceof RejectError ? e.status : 500;
    if (status === 500) console.error("session error", e?.message);
    return res.status(status).json({ error: status === 500 ? "internal error" : e.message });
  }
}
