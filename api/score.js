// POST /api/score { player, gameId, score, name, session } -> { signature, deadline, ... }
// for LeaderboardV2.submitScore.
// Env vars (set in Vercel, never in git):
//   SCORE_SIGNER_PRIVATE_KEY  dedicated hot key, holds no funds, only signs
//   LEADERBOARD_V2_ADDRESS    deployed LeaderboardV2
//   SESSION_SECRET            random >= 32 chars, HMAC key for game session tokens
//   BASE_RPC_URL, ALLOWED_ORIGIN, UPSTASH_REDIS_REST_URL/_TOKEN  optional
import { getAddress, isAddress } from "ethers";
import { loadConfig, signScore, RejectError } from "../server/signer.js";
import { getStore, limit, LIMITS, clientIp, verifySession } from "../server/guards.js";
import { cors } from "../server/http.js";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    if (!isAddress(body.player)) throw new RejectError(400, "bad player");
    const player = getAddress(body.player);
    const store = getStore();
    await limit(store, `score:ip:${clientIp(req)}`, LIMITS.scorePerIpPerMin, 60);
    await limit(store, `score:p:${player}`, LIMITS.scorePerPlayerPerMin, 60);
    await limit(store, `score:pd:${player}`, LIMITS.scorePerPlayerPerDay, 86400);
    const { startedAtMs } = verifySession(body.session, { player, gameId: body.gameId }, process.env.SESSION_SECRET);
    const out = await signScore({ ...body, player }, { ...loadConfig(), serverStartedAtMs: startedAtMs });
    return res.status(200).json(out);
  } catch (e) {
    const status = e instanceof RejectError ? e.status : 500;
    if (status === 500) console.error("score sign error", e?.message);
    return res.status(status).json({ error: status === 500 ? "internal error" : e.message });
  }
}
