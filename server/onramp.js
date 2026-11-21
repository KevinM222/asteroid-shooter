// Coinbase-hosted Onramp: mint a single-use onramp URL for the player's own address (S5).
// Pure node (node:crypto + fetch), unit-tested with a mocked CDP. Secrets come only from env and are
// never returned, logged, or put in error messages.
//
// Env (Vercel, never in git):
//   CDP_API_KEY_ID       CDP Secret API Key id (the "name"/id shown in the portal)
//   CDP_API_KEY_SECRET   its private key: Ed25519 (base64, 64 bytes, the default) or legacy ECDSA PEM
//   CDP_PROJECT_ID       public CDP project id (embedded-wallet email/SMS sign-in); optional, defaults to the
//                        game's project below; "off" hides email/SMS sign-in
//   CDP_ONRAMP_SANDBOX   "1" = sandbox mode (partnerUserRef "sandbox-…": no real money moves); optional
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { getAddress, isAddress } from "ethers";
import { RejectError } from "./signer.js";

export const CDP_HOST = "api.cdp.coinbase.com";
export const SESSION_PATH = "/platform/v2/onramp/sessions";

// The only purchases the game offers. Anything else is rejected (no free-form amounts or assets).
export const BUNDLES = {
  usdc5: { purchaseCurrency: "USDC", paymentAmount: "5.00" },
  usdc10: { purchaseCurrency: "USDC", paymentAmount: "10.00" },
  eth3: { purchaseCurrency: "ETH", paymentAmount: "3.00" }, // a little gas money for brand-new wallets
};

export function onrampConfigured(env = process.env) {
  return !!(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET);
}

// Public config for the page: what to show. No secrets.
// Public (not a secret): the CDP project for asteroidsshooter.app. Used by the browser for email/SMS sign-in.
export const DEFAULT_CDP_PROJECT_ID = "2b9579c1-2d80-43b0-9c24-3b7ae2a9f524";
export function publicConfig(env = process.env) {
  const raw = env.CDP_PROJECT_ID === undefined || env.CDP_PROJECT_ID === "" ? DEFAULT_CDP_PROJECT_ID : env.CDP_PROJECT_ID;
  const projectId = /^[0-9a-f-]{16,64}$/i.test(raw) ? raw : null;
  return { onramp: onrampConfigured(env), cdpProjectId: projectId, bundles: Object.keys(BUNDLES) };
}

const b64u = (b) => Buffer.from(b).toString("base64url");

function loadKey(secret) {
  const s = String(secret || "").trim().replace(/\\n/g, "\n");
  if (s.includes("BEGIN")) return { alg: "ES256", key: createPrivateKey(s) };
  const raw = Buffer.from(s, "base64");
  if (raw.length !== 64) throw new Error("CDP key secret has an unexpected format");
  const key = createPrivateKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", d: b64u(raw.subarray(0, 32)), x: b64u(raw.subarray(32)) } });
  return { alg: "EdDSA", key };
}

// CDP JWT (https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication): 2 min, bound to one request.
export function cdpJwt({ keyId, keySecret, method, host, path, now = Math.floor(Date.now() / 1000) }) {
  const { alg, key } = loadKey(keySecret);
  const header = { alg, kid: keyId, typ: "JWT", nonce: randomBytes(16).toString("hex") };
  // same claims as @coinbase/cdp-sdk generateJwt
  const claims = { sub: keyId, iss: "cdp", uris: [`${method} ${host}${path}`], iat: now, nbf: now, exp: now + 120 };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const sig = alg === "EdDSA" ? sign(null, Buffer.from(input), key) : sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64u(sig)}`;
}

export function parseRequest(body) {
  const b = typeof body === "string" ? JSON.parse(body || "{}") : body || {};
  if (typeof b.address !== "string" || !isAddress(b.address) || /^0x0{40}$/i.test(b.address)) throw new RejectError(400, "bad address");
  const bundle = BUNDLES[b.bundle];
  if (!bundle || !Object.prototype.hasOwnProperty.call(BUNDLES, b.bundle)) throw new RejectError(400, "bad bundle");
  return { address: getAddress(b.address), bundleId: b.bundle, bundle };
}

// Anonymous, stable per-player reference (< 50 chars) so transactions can be looked up later.
export function partnerUserRef(address, sandbox) {
  const h = createHash("sha256").update(address.toLowerCase()).digest("hex").slice(0, 32);
  return (sandbox ? "sandbox-" : "") + "ast-" + h;
}

export async function createOnrampUrl({ address, bundle, clientIp, redirectUrl, env = process.env, fetchImpl = fetch }) {
  if (!onrampConfigured(env)) throw new RejectError(503, "add funds is not set up yet");
  const sandbox = env.CDP_ONRAMP_SANDBOX === "1";
  const body = {
    destinationAddress: address,
    destinationNetwork: "base",
    purchaseCurrency: bundle.purchaseCurrency,
    paymentAmount: bundle.paymentAmount,
    paymentCurrency: "USD",
    clientIp,
    partnerUserRef: partnerUserRef(address, sandbox),
    ...(redirectUrl ? { redirectUrl } : {}),
  };
  let jwt;
  try { jwt = cdpJwt({ keyId: env.CDP_API_KEY_ID, keySecret: env.CDP_API_KEY_SECRET, method: "POST", host: CDP_HOST, path: SESSION_PATH }); }
  catch { throw new RejectError(503, "add funds is misconfigured"); }
  const r = await fetchImpl(`https://${CDP_HOST}${SESSION_PATH}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) {
    // log only status + CDP's error type; never the JWT, key, or full request
    console.error("onramp session failed", r.status, j?.errorType || "");
    throw new RejectError(r.status === 429 ? 429 : 502, r.status === 429 ? "Coinbase is busy, try again in a minute" : "Coinbase could not start the purchase");
  }
  const url = j?.session?.onrampUrl;
  if (typeof url !== "string" || !/^https:\/\/pay\.coinbase\.com\//.test(url)) throw new RejectError(502, "Coinbase returned no purchase link");
  return url;
}
