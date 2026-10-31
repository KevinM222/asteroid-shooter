// Unit tests for task verification (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { verifyAccumulator, signGrant, startClickTask, verifyClickTicket, TASKS, CLICK_WAIT_SECONDS } from "../grant.js";
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
  assert.throws(() => startClickTask({ player: P, task: "accumulator" }, cfg(1000)), (e) => e.status === 400);
});
for (const task of ["x", "keep"]) {
  test(`${task}: click-through ticket valid only after the wait, for that wallet+task`, () => {
    const { ticket, waitSeconds } = startClickTask({ player: P, task }, cfg(1000));
    assert.equal(waitSeconds, CLICK_WAIT_SECONDS);
    assert.throws(() => verifyClickTicket(P, task, ticket, cfg(1005)), (e) => e.status === 425);
    assert.deepEqual(verifyClickTicket(P, task, ticket, cfg(1000 + CLICK_WAIT_SECONDS)), { clickedAt: 1000 });
    assert.throws(() => verifyClickTicket(P, task, ticket, cfg(1000 + 3601)), (e) => e.status === 403);
    assert.throws(() => verifyClickTicket("0x1111111111111111111111111111111111111111", task, ticket, cfg(1020)), /invalid ticket/);
    assert.throws(() => verifyClickTicket(P, task === "x" ? "keep" : "x", ticket, cfg(1020)), /invalid ticket/);
    assert.throws(() => verifyClickTicket(P, task, ticket.replace(/^1000/, "900"), cfg(1020)), /invalid ticket/);
    assert.throws(() => verifyClickTicket(P, task, undefined, cfg(1020)), /open the link first/);
  });
}
