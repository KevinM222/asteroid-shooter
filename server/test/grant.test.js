// Unit tests for task verification (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { verifyAccumulator, verifyKeep, KEEP_STATUS_URL, signGrant, startClickTask, verifyClickTicket, TASKS, CLICK_WAIT_SECONDS } from "../grant.js";
import { RejectError } from "../signer.js";

const P = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const fake = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => body });
const cfg = (now) => ({ wallet: new Wallet("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"), leaderboard: "0xCcF3b3678f00f5AD8036897Cf17D0b5de67EfEca", chainId: 8453, now });

test("accumulator: bot wallet present -> ok", async () => {
  const r = await verifyAccumulator(P, { fetchImpl: fake({ botWalletExists: true, botAddress: "0x1111111111111111111111111111111111111111" }) });
  assert.equal(r.botAddress, "0x1111111111111111111111111111111111111111");
});
test("accumulator: no bot -> 403", async () => {
  await assert.rejects(verifyAccumulator(P, { fetchImpl: fake({ botWalletExists: false, botAddress: "" }) }), (e) => e instanceof RejectError && e.status === 403);
});
test("accumulator: upstream down -> 503", async () => {
  await assert.rejects(verifyAccumulator(P, { fetchImpl: fake({}, false) }), (e) => e.status === 503);
});
test("task ids: X=1, Accumulator=3, Keep=4; Base App (2) retired", () => {
  assert.equal(TASKS.x.grantId, 1n); assert.equal(TASKS.accumulator.grantId, 3n); assert.equal(TASKS.keep.grantId, 4n);
  assert.equal(TASKS.base, undefined);
  assert.equal(new Set(Object.values(TASKS).map((t) => t.grantId)).size, 3);
});
test("unknown / retired tasks are refused", async () => {
  for (const task of ["base", "", "nope"]) await assert.rejects(signGrant({ player: P, task }, {}), (e) => e.status === 400);
  for (const task of ["accumulator", "keep"]) assert.throws(() => startClickTask({ player: P, task }, cfg(1000)), (e) => e.status === 400);
});
for (const task of ["x"]) {
  test(`${task}: click-through ticket valid only after the wait, for that wallet+task`, () => {
    const { ticket, waitSeconds } = startClickTask({ player: P, task }, cfg(1000));
    assert.equal(waitSeconds, CLICK_WAIT_SECONDS);
    assert.throws(() => verifyClickTicket(P, task, ticket, cfg(1005)), (e) => e.status === 425);
    assert.deepEqual(verifyClickTicket(P, task, ticket, cfg(1000 + CLICK_WAIT_SECONDS)), { clickedAt: 1000 });
    assert.throws(() => verifyClickTicket(P, task, ticket, cfg(1000 + 3601)), (e) => e.status === 403);
    assert.throws(() => verifyClickTicket("0x1111111111111111111111111111111111111111", task, ticket, cfg(1020)), /invalid ticket/);
    assert.throws(() => verifyClickTicket(P, "keep", ticket, cfg(1020)), /invalid ticket/);
    assert.throws(() => verifyClickTicket(P, task, ticket.replace(/^1000/, "900"), cfg(1020)), /invalid ticket/);
    assert.throws(() => verifyClickTicket(P, task, undefined, cfg(1020)), /open the link first/);
  });
}

const keepFake = (status, body) => { const calls = []; const f = async (url, opts) => { calls.push(url); return { ok: status === 200, status, json: async () => body }; }; f.calls = calls; return f; };
test("keep: used:true -> ok, calls Keep's status endpoint with the player", async () => {
  const f = keepFake(200, { used: true, firstSeenAt: 1793446639000 });
  assert.deepEqual(await verifyKeep(P, { fetchImpl: f }), { keepFirstSeenAt: 1793446639000 });
  assert.equal(f.calls[0], `${KEEP_STATUS_URL}?address=${P}`);
});
test("keep: used:false -> 403 telling the player to open Keep, connect and sign", async () => {
  await assert.rejects(verifyKeep(P, { fetchImpl: keepFake(200, { used: false, firstSeenAt: null }) }),
    (e) => e instanceof RejectError && e.status === 403 && /open Keep, connect this same wallet and sign/.test(e.message));
});
for (const code of [429, 503, 400, 500]) {
  test(`keep: HTTP ${code} -> 503 try again later, no grant`, async () => {
    await assert.rejects(verifyKeep(P, { fetchImpl: keepFake(code, { error: "x" }) }), (e) => e.status === 503 && /try again later/.test(e.message));
  });
}
test("keep: network error or malformed body -> 503 try again later", async () => {
  await assert.rejects(verifyKeep(P, { fetchImpl: async () => { throw new Error("ECONNRESET"); } }), (e) => e.status === 503);
  await assert.rejects(verifyKeep(P, { fetchImpl: keepFake(200, { used: "yes" }) }), (e) => e.status === 503);
});

// per-endpoint mock: usdc / status are [status, body] or "down" (network error)
const both = (usdc, status) => async (url) => {
  const spec = url.includes("/api/usdc-bot?owner=") ? usdc : url.includes("/api/status?address=") ? status : null;
  if (!spec) throw new Error("unexpected url " + url);
  if (spec === "down") throw new Error("ECONNRESET");
  return { ok: spec[0] >= 200 && spec[0] < 300, status: spec[0], json: async () => spec[1] };
};
const BOT = "0x2222222222222222222222222222222222222222";
const usdcYes = [200, { enabled: true, exists: true, active: true, botAddress: BOT, totalUsd: 12 }];
const statusNo = [200, { botWalletExists: false, botAddress: "" }];
test("accumulator: USDC bot only -> ok (Kevin's case)", async () => {
  const r = await verifyAccumulator(P, { fetchImpl: both(usdcYes, statusNo) });
  assert.equal(r.bot, "usdc"); assert.equal(r.botAddress, BOT);
});
test("accumulator: legacy cbBTC bot only -> ok, even if usdc feature off (404) or usdc down", async () => {
  const legacy = [200, { botWalletExists: true, botAddress: BOT }];
  assert.equal((await verifyAccumulator(P, { fetchImpl: both([404, { enabled: false }], legacy) })).bot, "cbbtc");
  assert.equal((await verifyAccumulator(P, { fetchImpl: both("down", legacy) })).bot, "cbbtc");
});
test("accumulator: USDC ok while /api/status is down -> ok", async () => {
  assert.equal((await verifyAccumulator(P, { fetchImpl: both(usdcYes, [503, {}]) })).bot, "usdc");
});
test("accumulator: feature off (404 enabled:false) + no legacy bot -> 403", async () => {
  await assert.rejects(verifyAccumulator(P, { fetchImpl: both([404, { enabled: false }], statusNo) }), (e) => e.status === 403);
  await assert.rejects(verifyAccumulator(P, { fetchImpl: both([200, { enabled: true, exists: false }], statusNo) }), (e) => e.status === 403);
});
test("accumulator: one endpoint down, other says no -> 403; both down -> 503", async () => {
  await assert.rejects(verifyAccumulator(P, { fetchImpl: both("down", statusNo) }), (e) => e.status === 403);
  await assert.rejects(verifyAccumulator(P, { fetchImpl: both("down", [500, {}]) }), (e) => e.status === 503);
  await assert.rejects(verifyAccumulator(P, { fetchImpl: both([429, {}], "down") }), (e) => e.status === 503);
});
test("accumulator: queries both endpoints in parallel", async () => {
  let inflight = 0, max = 0;
  const f = async (url) => { inflight++; max = Math.max(max, inflight); await new Promise((r) => setTimeout(r, 20)); inflight--; return both(usdcYes, statusNo)(url); };
  await verifyAccumulator(P, { fetchImpl: f }); assert.equal(max, 2);
});
