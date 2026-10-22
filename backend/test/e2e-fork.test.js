// End-to-end check on a LOCAL anvil fork of Base mainnet (nothing is sent to the real chain):
// deploy LeaderboardV2 with the real deploy script, grant MINTER_ROLE on the forked AST by
// impersonating the owner wallet locally, then play a game and submit a backend-signed score.
// Run: anvil --fork-url https://mainnet.base.org &  then  RPC=http://127.0.0.1:8545 npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Contract, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";
import { signScore, RejectError } from "../lib/signer.js";

const RPC = process.env.RPC;
const OWNER = "0xACfCA8Bc6567E7DB35AD8C814756695dad1cfB30";
const AST = "0xcEFB2484932595ffFC809a27B8A5b106A8E1715A";
// anvil's well-known dev keys (public test keys, worthless)
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PLAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SIGNER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

test("deploy + signed score on a Base fork", { skip: !RPC }, async () => {
  const provider = new JsonRpcProvider(RPC, 8453, { staticNetwork: true });
  const signerWallet = new Wallet(SIGNER_KEY);
  const out = execFileSync(
    process.env.FORGE || "forge",
    ["script", "scripts/foundry/DeployLeaderboardV2.s.sol", "--rpc-url", RPC, "--private-key", DEPLOYER_KEY, "--broadcast"],
    { cwd: new URL("../..", import.meta.url).pathname, env: { ...process.env, SCORE_SIGNER: signerWallet.address }, encoding: "utf8" }
  );
  const addr = out.match(/LeaderboardV2 deployed at (0x[0-9a-fA-F]{40})/)[1];

  const lbAbi = [
    "function owner() view returns (address)",
    "function claimDailyLives()",
    "function startGame() returns (uint256)",
    "function gamesStarted(address) view returns (uint256)",
    "function submitScore(uint256,uint256,string,uint256,bytes)",
    "function getTopScores(uint256) view returns ((address player,uint256 score,string playerName)[])",
  ];
  const astAbi = ["function setupLeaderboardAsMinter(address)", "function balanceOf(address) view returns (uint256)"];
  assert.equal(await new Contract(addr, lbAbi, provider).owner(), OWNER);

  // local fork only: impersonate the owner to grant MINTER_ROLE to the new board
  await provider.send("anvil_impersonateAccount", [OWNER]);
  await provider.send("anvil_setBalance", [OWNER, "0xDE0B6B3A7640000"]);
  const ownerSigner = await provider.getSigner(OWNER);
  await (await new Contract(AST, astAbi, ownerSigner).setupLeaderboardAsMinter(addr)).wait();

  const player = new Wallet(PLAYER_KEY, provider);
  const lb = new Contract(addr, lbAbi, player);
  await (await lb.claimDailyLives()).wait();
  await (await lb.startGame()).wait();
  const gameId = await lb.gamesStarted(player.address);
  await provider.send("evm_increaseTime", [90]);
  await provider.send("evm_mine", []);

  const cfg = { provider, wallet: signerWallet, leaderboard: addr, chainId: 8453 };
  await assert.rejects(signScore({ player: player.address, gameId, score: 6000, name: "e2e" }, cfg), RejectError); // too fast
  await assert.rejects(signScore({ player: player.address, gameId, score: 601, name: "e2e" }, cfg), RejectError); // not x12

  const before = await new Contract(AST, astAbi, provider).balanceOf(player.address);
  const s = await signScore({ player: player.address, gameId, score: 600, name: "e2e" }, cfg);
  await (await lb.submitScore(gameId, s.score, s.name, s.deadline, s.signature)).wait();
  const after = await new Contract(AST, astAbi, provider).balanceOf(player.address);
  // 600/100 = 6, plus personal best 50, plus all-time high 100 (fresh board)
  assert.equal(after - before, 156n * 10n ** 18n);
  const top = await lb.getTopScores(5);
  assert.equal(top[0].player, player.address);
  assert.equal(top[0].score, 600n);

  await assert.rejects(signScore({ player: player.address, gameId, score: 600, name: "e2e" }, cfg), /already submitted/);
  assert.equal(keccak256(toUtf8Bytes("e2e")).length, 66);
});
