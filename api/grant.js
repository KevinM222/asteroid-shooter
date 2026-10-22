// DRAFT Vercel function: POST /api/grant — signer-authorised free lives (tasks/promos).
// Disabled until we decide how a task is proven (e.g. Neynar check that the player cast/followed).
// Daily free lives do NOT need this endpoint: players call LeaderboardV2.claimDailyLives() directly.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(501).json({ error: "life grants are not enabled yet" });
}
