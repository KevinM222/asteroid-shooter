import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, limit, issueSession, verifySession, checkPlausible, SESSION_MAX_AGE_MS } from "../guards.js";
import { cleanName } from "../signer.js";

const SECRET = "x".repeat(40);
const P = "0x1111111111111111111111111111111111111111";

test("rate limit allows up to max then rejects with 429", async () => {
  const s = new MemoryStore();
  for (let i = 0; i < 3; i++) await limit(s, "k", 3, 60);
  await assert.rejects(limit(s, "k", 3, 60), (e) => e.status === 429);
  await limit(s, "other", 3, 60);
});

test("rate limit window expires", async () => {
  const s = new MemoryStore();
  assert.equal(await s.incr("k", 1, 0), 1);
  assert.equal(await s.incr("k", 1, 500), 2);
  assert.equal(await s.incr("k", 1, 1500), 1);
});

test("session round-trip and binding", () => {
  const tok = issueSession({ player: P, gameId: 7n, now: 1000 }, SECRET);
  assert.equal(verifySession(tok, { player: P.toUpperCase().replace("0X", "0x"), gameId: "7", now: 2000 }, SECRET).startedAtMs, 1000);
  assert.throws(() => verifySession(tok, { player: P, gameId: 8, now: 2000 }, SECRET), (e) => e.status === 401);
  assert.throws(() => verifySession(tok, { player: "0x2222222222222222222222222222222222222222", gameId: 7, now: 2000 }, SECRET), (e) => e.status === 401);
  assert.throws(() => verifySession(tok, { player: P, gameId: 7, now: 1000 + SESSION_MAX_AGE_MS + 1 }, SECRET), /expired/);
  assert.throws(() => verifySession(tok, { player: P, gameId: 7, now: 2000 }, "y".repeat(40)), /bad session/);
  const [pl, mac] = tok.split(".");
  const forged = Buffer.from(JSON.stringify({ p: P.toLowerCase(), g: "7", t: 0 })).toString("base64url");
  assert.throws(() => verifySession(`${forged}.${mac}`, { player: P, gameId: 7, now: 2000 }, SECRET), /bad session/);
  assert.throws(() => verifySession(undefined, { player: P, gameId: 7 }, SECRET), /missing session/);
  assert.throws(() => issueSession({ player: P, gameId: 1 }, "short"), (e) => e.status === 503);
});

test("plausibility uses the stricter clock and real fire rate", () => {
  // 60 s on both clocks: play = 56.2 s, max ~42.86 pts/s capped by contract 20 pts/s -> 1124
  checkPlausible({ score: 1116, chainElapsedSec: 60, serverElapsedMs: 60_000, maxPointsPerSecond: 20 });
  assert.throws(() => checkPlausible({ score: 1200, chainElapsedSec: 60, serverElapsedMs: 60_000, maxPointsPerSecond: 20 }), /too high/);
  // chain says long game but server session only 10 s old -> limited by server clock
  assert.throws(() => checkPlausible({ score: 600, chainElapsedSec: 600, serverElapsedMs: 10_000, maxPointsPerSecond: 20 }), /too high/);
  assert.throws(() => checkPlausible({ score: 12, chainElapsedSec: 3, serverElapsedMs: 3000, maxPointsPerSecond: 20 }), /too short/);
});

test("names are cleaned and bounded", () => {
  assert.equal(cleanName("  kev<b>  "), "kevb");
  assert.throws(() => cleanName("a".repeat(33)), /bad name/);
  assert.throws(() => cleanName(""), /bad name/);
});
