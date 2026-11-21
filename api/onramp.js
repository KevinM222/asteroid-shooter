// POST /api/onramp { address, bundle: "usdc5" | "usdc10" | "eth3" } -> { url }
// Mints a single-use Coinbase-hosted Onramp URL that delivers to `address` on Base. 503 until the CDP keys exist.
// Env: CDP_API_KEY_ID, CDP_API_KEY_SECRET (secret; never returned or logged), CDP_ONRAMP_SANDBOX (optional),
//      UPSTASH_REDIS_REST_URL/_TOKEN (optional shared rate limits).
import { RejectError } from "../server/signer.js";
import { getStore, limit, clientIp } from "../server/guards.js";
import { strictCors, previewOrigins } from "../server/http.js";
import { parseRequest, createOnrampUrl, onrampConfigured } from "../server/onramp.js";

export const ONRAMP_LIMITS = { perIpPerMin: 5, perIpPerDay: 40, perAddressPerHour: 10 };

// Where Coinbase sends the player after a purchase: the page they came from (production or this preview).
export function redirectFor(req, env = process.env) {
  const o = req.headers?.origin;
  const base = o && previewOrigins(env).includes(o) ? o : "https://asteroidsshooter.app";
  return `${base}/`; // exactly the redirect URL allowlisted in the CDP portal
}

export default async function handler(req, res, { env = process.env, fetchImpl = fetch, store = getStore() } = {}) {
  if (strictCors(req, res, { env })) return;
  try {
    if (!onrampConfigured(env)) throw new RejectError(503, "add funds is not set up yet");
    let parsed;
    try { parsed = parseRequest(req.body); } catch (e) { throw e instanceof RejectError ? e : new RejectError(400, "bad request"); }
    const ip = clientIp(req);
    await limit(store, `onr:ip:${ip}`, ONRAMP_LIMITS.perIpPerMin, 60);
    await limit(store, `onr:ipd:${ip}`, ONRAMP_LIMITS.perIpPerDay, 86400);
    await limit(store, `onr:a:${parsed.address}`, ONRAMP_LIMITS.perAddressPerHour, 3600);
    const url = await createOnrampUrl({ address: parsed.address, bundle: parsed.bundle, clientIp: ip, redirectUrl: redirectFor(req, env), env, fetchImpl });
    return res.status(200).json({ url });
  } catch (e) {
    const status = e instanceof RejectError ? e.status : 500;
    if (status === 500) console.error("onramp error", e?.name || "Error");
    return res.status(status).json({ error: status === 500 ? "internal error" : e.message });
  }
}
