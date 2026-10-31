// Fork test against the REAL deployed LeaderboardV2 on a LOCAL anvil fork (nothing hits mainnet):
// impersonate the owner locally to point scoreSigner at a test key, then claim a signed task grant.
// Run: anvil --fork-url https://mainnet.base.org &  then  RPC=http://127.0.0.1:8545 npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { signGrant } from "../grant.js";

const RPC = process.env.RPC;
const LB = "0xCcF3b3678f00f5AD8036897Cf17D0b5de67EfEca";
const PLAYER_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // anvil dev key #3
const SIGNER_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"; // anvil dev key #4

test("accumulator task grant on a Base fork: +1 life, once per wallet", { skip: !RPC }, async () => {
  const provider = new JsonRpcProvider(RPC, 8453, { staticNetwork: true });
  const abi = ["function owner() view returns (address)", "function setScoreSigner(address)", "function playerLives(address) view returns (uint256)",
    "function claimLifeGrant(uint256,uint256,uint256,bytes)", "function grantUsed(address,uint256) view returns (bool)"];
  const owner = await new Contract(LB, abi, provider).owner();
  await provider.send("anvil_impersonateAccount", [owner]);
  await provider.send("anvil_setBalance", [owner, "0xDE0B6B3A7640000"]);
  const signerWallet = new Wallet(SIGNER_KEY);
  await (await new Contract(LB, abi, await provider.getSigner(owner)).setScoreSigner(signerWallet.address)).wait();

  const player = new Wallet(PLAYER_KEY, provider);
  await provider.send("anvil_setBalance", [player.address, "0xDE0B6B3A7640000"]);
  const lb = new Contract(LB, abi, player);
  const cfg = { provider, wallet: signerWallet, leaderboard: LB, chainId: 8453 };
  const verify = async () => ({ botAddress: "0x1111111111111111111111111111111111111111" });

  await assert.rejects(signGrant({ player: player.address, task: "accumulator" }, cfg, { verify: async () => { const e = new Error("no bot"); e.status = 403; throw e; } }), /no bot/);
  const before = await lb.playerLives(player.address);
  const g = await signGrant({ player: player.address, task: "accumulator" }, cfg, { verify });
  await (await lb.claimLifeGrant(g.amount, g.grantId, g.deadline, g.signature)).wait();
  assert.equal(await lb.playerLives(player.address), before + 1n);
  assert.equal(await lb.grantUsed(player.address, 3n), true);
  await assert.rejects(signGrant({ player: player.address, task: "accumulator" }, cfg, { verify }), /already claimed/);
  await assert.rejects(lb.claimLifeGrant(g.amount, g.grantId, g.deadline, g.signature)); // contract: GrantUsed
  // a signature for one player can't be used by another
  const other = new Wallet(SIGNER_KEY, provider);
  await provider.send("anvil_setBalance", [other.address, "0xDE0B6B3A7640000"]);
  await assert.rejects(new Contract(LB, abi, other).claimLifeGrant(g.amount, g.grantId, g.deadline, g.signature));
});

test("X (1) and Keep (4) click-through grants on a Base fork: contract accepts any grantId, once per wallet per task", { skip: !RPC }, async () => {
  const { startClickTask } = await import("../grant.js");
  const provider = new JsonRpcProvider(RPC, 8453, { staticNetwork: true });
  const abi = ["function owner() view returns (address)", "function setScoreSigner(address)", "function playerLives(address) view returns (uint256)",
    "function claimLifeGrant(uint256,uint256,uint256,bytes)", "function grantUsed(address,uint256) view returns (bool)"];
  const owner = await new Contract(LB, abi, provider).owner();
  await provider.send("anvil_impersonateAccount", [owner]);
  await provider.send("anvil_setBalance", [owner, "0xDE0B6B3A7640000"]);
  const signerWallet = new Wallet(SIGNER_KEY);
  await (await new Contract(LB, abi, await provider.getSigner(owner)).setScoreSigner(signerWallet.address)).wait();
  const player = Wallet.createRandom(provider);
  await provider.send("anvil_setBalance", [player.address, "0xDE0B6B3A7640000"]);
  const lb = new Contract(LB, abi, player);
  const t0 = (await provider.getBlock("latest")).timestamp;
  const cfg = (now) => ({ provider, wallet: signerWallet, leaderboard: LB, chainId: 8453, now });
  for (const [task, id] of [["x", 1n], ["keep", 4n]]) {
    assert.equal(await lb.grantUsed(player.address, id), false);
    await assert.rejects(signGrant({ player: player.address, task }, cfg(t0)), /open the link first/);
    const { ticket } = startClickTask({ player: player.address, task }, cfg(t0));
    await assert.rejects(signGrant({ player: player.address, task, ticket }, cfg(t0 + 3)), /try again in/);
    const before = await lb.playerLives(player.address);
    const g = await signGrant({ player: player.address, task, ticket }, cfg(t0 + 11));
    assert.equal(g.grantId, id.toString());
    const nonce = id === 1n ? 0 : 1; // fresh wallet; explicit nonces avoid ethers caching a stale count on anvil
    await (await lb.claimLifeGrant(g.amount, g.grantId, g.deadline, g.signature, { nonce })).wait();
    assert.equal(await lb.playerLives(player.address), before + 1n);
    assert.equal(await lb.grantUsed(player.address, id), true);
    await assert.rejects(signGrant({ player: player.address, task, ticket }, cfg(t0 + 12)), /already claimed/);
    await assert.rejects(lb.claimLifeGrant(g.amount, g.grantId, g.deadline, g.signature)); // GrantUsed on-chain
  }
  // Keep (4) is independent of the retired Base App id (2) and of Accumulator (3)
  assert.equal(await lb.grantUsed(player.address, 2n), false);
  assert.equal(await lb.grantUsed(player.address, 3n), false);
});
