// Shared CORS / method handling. Returns true if the request was fully handled.
// The game calls /api/* same-origin, so CORS only matters for cross-origin callers.
// Both the custom domain and the original vercel.app domain are allowed during the transition.
// ALLOWED_ORIGIN (optional) adds more origins, comma-separated (e.g. a preview URL).
export const DEFAULT_ALLOWED_ORIGINS = [
  "https://asteroidsshooter.app",
  "https://www.asteroidsshooter.app",
  "https://asteroid-shooter-alpha.vercel.app",
];

export function allowedOrigins() {
  const extra = (process.env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra])];
}

export function pickOrigin(reqOrigin) {
  const list = allowedOrigins();
  return reqOrigin && list.includes(reqOrigin) ? reqOrigin : list[0];
}

export function cors(req, res) {
  const origin = pickOrigin(req.headers?.origin);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.status(204).end();
    return true;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return true; }
  return false;
}
