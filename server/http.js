// Shared CORS / method handling. Returns true if the request was fully handled.
export function cors(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "https://asteroid-shooter-alpha.vercel.app";
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
