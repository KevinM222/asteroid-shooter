// GET /api/config -> { onramp: bool, cdpProjectId: string|null, bundles: [...] }
// Tells the page which optional sign-in / Add funds features are set up. Public values only (no secrets).
import { strictCors } from "../server/http.js";
import { publicConfig } from "../server/onramp.js";

export default function handler(req, res, { env = process.env } = {}) {
  if (strictCors(req, res, { methods: "GET", env })) return;
  res.setHeader("Cache-Control", "public, max-age=60");
  return res.status(200).json(publicConfig(env));
}
