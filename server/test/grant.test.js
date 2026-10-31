// Unit tests for task verification (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyAccumulator, signGrant } from "../grant.js";
import { RejectError } from "../signer.js";

const P = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const fake = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => body });

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
test("unverifiable tasks are refused", async () => {
  for (const task of ["x", "base", ""]) await assert.rejects(signGrant({ player: P, task }, {}), (e) => e.status === 400);
});
