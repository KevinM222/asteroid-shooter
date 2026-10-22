// DRAFT Vercel function: POST /api/score  { player, gameId, score, name }
// Returns { signature, deadline, ... } for LeaderboardV2.submitScore. Not deployed.
//
// Env vars (set in Vercel, never in git):
//   SCORE_SIGNER_PRIVATE_KEY  dedicated hot key, holds no funds, only signs
//   LEADERBOARD_V2_ADDRESS    deployed LeaderboardV2
//   BASE_RPC_URL              optional, defaults to https://mainnet.base.org
//   ALLOWED_ORIGIN            optional, defaults to https://asteroid-shooter-alpha.vercel.app
import { loadConfig, signScore, RejectError } from "../lib/signer.js";

// Best-effort per-instance throttle. Use Vercel KV / Upstash for a real shared rate limit.
const recent = new Map();
const MIN_INTERVAL_MS = 5_000;

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "https://asteroid-shooter-alpha.vercel.app";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    return res.status(204).end();
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const key = String(body.player || "").toLowerCase();
    const last = recent.get(key) || 0;
    if (Date.now() - last < MIN_INTERVAL_MS) throw new RejectError(429, "slow down");
    recent.set(key, Date.now());

    const out = await signScore(body, loadConfig());
    return res.status(200).json(out);
  } catch (e) {
    const status = e instanceof RejectError ? e.status : 500;
    if (status === 500) console.error("score sign error", e);
    return res.status(status).json({ error: status === 500 ? "internal error" : e.message });
  }
}
