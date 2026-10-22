// Anti-abuse helpers for the score backend (S4). Pure node, no Vercel specifics, unit-tested.
import { createHmac, timingSafeEqual } from "node:crypto";
import { RejectError } from "./signer.js";

// ---------------------------------------------------------------- rate limiting
// Fixed-window counters. In-memory by default (per serverless instance, best effort).
// If UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set, counters are shared across instances.
export class MemoryStore {
  constructor() { this.m = new Map(); }
  async incr(key, ttlSec, now = Date.now()) {
    const e = this.m.get(key);
    if (!e || e.exp <= now) { this.m.set(key, { n: 1, exp: now + ttlSec * 1000 }); return 1; }
    e.n += 1;
    if (this.m.size > 50_000) for (const [k, v] of this.m) if (v.exp <= now) this.m.delete(k);
    return e.n;
  }
}

export class UpstashStore {
  constructor(url, token) { this.url = url.replace(/\/$/, ""); this.token = token; }
  async incr(key, ttlSec) {
    const r = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify([["INCR", key], ["EXPIRE", key, String(ttlSec), "NX"]]),
    });
    if (!r.ok) throw new Error(`rate store ${r.status}`);
    const [first] = await r.json();
    return Number(first.result);
  }
}

let _store;
export function getStore(env = process.env) {
  if (!_store) {
    _store = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
      ? new UpstashStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN)
      : new MemoryStore();
  }
  return _store;
}

// Default limits. Tunable, conservative for a demo.
export const LIMITS = {
  scorePerPlayerPerMin: 3,
  scorePerIpPerMin: 10,
  scorePerPlayerPerDay: 50,
  sessionPerPlayerPerMin: 6,
  sessionPerIpPerMin: 20,
};

export async function limit(store, key, max, ttlSec) {
  const n = await store.incr(`rl:${key}`, ttlSec);
  if (n > max) throw new RejectError(429, "rate limit, slow down");
}

export function clientIp(req) {
  const xf = req.headers?.["x-forwarded-for"];
  return String((Array.isArray(xf) ? xf[0] : xf) || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
}

// ---------------------------------------------------------------- session (game) tokens
// Issued by /api/session right after the on-chain startGame confirms. Binds player + on-chain gameId
// + the server's own start time, so the backend measures game length with its own clock as well as
// the chain's. HMAC-SHA256 with SESSION_SECRET (random, set in Vercel; never in git).
const b64u = (b) => Buffer.from(b).toString("base64url");

export function issueSession({ player, gameId, now = Date.now() }, secret) {
  if (!secret || secret.length < 32) throw new RejectError(503, "session secret not configured");
  const payload = b64u(JSON.stringify({ p: player.toLowerCase(), g: String(gameId), t: now }));
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function verifySession(token, { player, gameId, now = Date.now() }, secret) {
  if (!secret || secret.length < 32) throw new RejectError(503, "session secret not configured");
  if (typeof token !== "string" || !token.includes(".")) throw new RejectError(401, "missing session");
  const [payload, mac] = token.split(".");
  const want = createHmac("sha256", secret).update(payload).digest();
  let got;
  try { got = Buffer.from(mac, "base64url"); } catch { throw new RejectError(401, "bad session"); }
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new RejectError(401, "bad session");
  const s = JSON.parse(Buffer.from(payload, "base64url").toString());
  if (s.p !== String(player).toLowerCase() || s.g !== String(gameId)) throw new RejectError(401, "session does not match game");
  if (now - s.t > SESSION_MAX_AGE_MS) throw new RejectError(401, "session expired");
  if (s.t > now + 5_000) throw new RejectError(401, "bad session time");
  return { startedAtMs: s.t };
}

// ---------------------------------------------------------------- plausibility
// Game facts (index.html): one laser per 280 ms, asteroids spawn every 1200 ms (speeding up),
// 12 points per hit, 3-2-1-GO countdown of ~3.8 s before play starts.
export const GAME = { pointsPerHit: 12, countdownMs: 3800, maxHitsPerSecond: 1000 / 280 };

/** Returns the stricter of chain-measured and server-measured play time, then checks the score fits. */
export function checkPlausible({ score, chainElapsedSec, serverElapsedMs, maxPointsPerSecond }) {
  const s = Number(score);
  const playMs = Math.min(chainElapsedSec * 1000, serverElapsedMs) - GAME.countdownMs;
  if (playMs <= 0) throw new RejectError(422, "game too short");
  const perSec = Math.min(Number(maxPointsPerSecond), GAME.maxHitsPerSecond * GAME.pointsPerHit);
  if (s > (playMs / 1000) * perSec) throw new RejectError(422, "score too high for game length");
}
