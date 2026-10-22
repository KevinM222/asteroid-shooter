# Game economy v2: LeaderboardV2

Status: **written and tested, not deployed.** Kevin deploys from his own wallet; nothing in this branch sends a transaction.

## What's in the contract (`contracts/LeaderboardV2.sol`)
- **Signed scores.** `startGame()` spends one life and opens game `id` (ids count up per player). When the game ends, the
  backend checks the result and signs the EIP-712 message
  `Score(player, gameId, score, keccak256(name), deadline)`. `submitScore(gameId, score, name, deadline, sig)` accepts it once.
  The signature only works for that player (msg.sender), that game, that score, that name and until the deadline, so
  replaying, front-running or editing it fails.
- **Contract-side checks** that hold even if the signer misbehaves: game ≥ `minGameSeconds` (5 s),
  `score ≤ elapsed × maxPointsPerSecond` (20 pts/s; the game gives 12 points per hit), `score ≤ maxScore`.
- **No public mint.** AST (`score/100`, +50 personal best, +100 all-time high, as in v1) is minted only on a valid
  signed score, capped at `maxAstPerGame` (500) and `dailyMintCap` (50,000 AST/day across all players). If the board loses
  MINTER_ROLE, scores are still recorded and `RewardMintFailed` is emitted.
- **Lives.** `buyLives(pack)` charges the pack price the UI shows (1=$0.10, 10=$0.90, 25=$2.25, 50=$4.50; owner can change).
  `claimDailyLives()` gives 1 free life per 24 h to any wallet. `claimLifeGrant(amount, grantId, deadline, sig)` redeems
  one-time signer-approved grants (tasks/promos, max 10). The owner can still `awardFreeLives`.
- **Owner.** `withdraw(token, to, amount)` (works while paused), `endSeason(astPrizes[20])` (pays 60% of the pot to the top 10
  by the v1 split 32/19/13/5/5/5/5/5/5/6, optional AST to the top 20, resets the board), `pause/unpause`,
  `setScoreSigner`, `setPackPrice`, `setLifeRules`, `setScoreRules`, `setRewardRules`, `setPrizeShareBps`.
  Ownership transfer is 2-step and `renounceOwnership` is disabled so the pot can't be orphaned.
- **Deploy safety.** USDC and AST addresses are immutable and must have code at deploy time (v1 was deployed with the
  Base *Sepolia* AST address and test USDC, which broke it).

## Honest limits of signed scores
Signing moves trust from "whatever the browser says" to "whatever the backend accepts". A determined cheater can still
script a client: start a real game on-chain, wait, and ask the backend to sign a believable score. The current checks
(time ceiling, multiple of 12, one submit per paid/claimed game, per-game and daily mint caps) limit how much that's
worth. Further mitigations, roughly by effort:
1. Shared rate limits per wallet/IP (Vercel KV/Upstash).
2. Farcaster Quick Auth so a score is tied to a Farcaster account, not just a fresh wallet.
3. Only paid games earn AST or prize eligibility. Free games just appear on the board.
4. Send a compact input/event log with the score. Make the game deterministic from a server-issued seed and re-simulate it on the server.
5. Manual review of the top 10 before `endSeason` (already owner-triggered for this reason).

## Tests
```
forge install        # first time only: pulls lib/openzeppelin-contracts v5.1.0 and lib/forge-std
forge test -vv       # 27 tests incl. fuzzed leaderboard ordering
# end-to-end on a LOCAL Base fork (deploy script + backend signer + real AST roles, nothing hits mainnet):
anvil --fork-url https://mainnet.base.org &
cd backend && npm install && cd .. && RPC=http://127.0.0.1:8545 node --test backend/test/
```

## Deployment (Kevin, from 0xacfc…fb30)
0. **Signer key.** On your own machine: `cast wallet new`. Keep the private key for Vercel (step 5). The address is
   `SCORE_SIGNER`. Use a fresh key that holds no funds, never your owner wallet.
1. **Deploy.** Pick one:
   - Foundry with a hardware wallet: `SCORE_SIGNER=0x… forge script scripts/foundry/DeployLeaderboardV2.s.sol --rpc-url base --ledger --sender 0xACfCA8Bc6567E7DB35AD8C814756695dad1cfB30 --broadcast`
   - Foundry with an encrypted keystore (`cast wallet import kevin --interactive`): same command with `--account kevin`.
   - Remix + browser wallet (MetaMask / Coinbase Wallet on Base): `forge flatten contracts/LeaderboardV2.sol > LeaderboardV2.flat.sol`, paste it into Remix,
     compile with **0.8.24, optimizer on, 200 runs, EVM cancun**, deploy with constructor args
     `(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, 0xcEFB2484932595ffFC809a27B8A5b106A8E1715A, 0xACfCA8Bc6567E7DB35AD8C814756695dad1cfB30, <SCORE_SIGNER>)`.
2. **Verify on Basescan.** Create a new Etherscan API v2 key (the old Basescan key leaked; revoke it), then
   ```
   forge verify-contract <V2_ADDRESS> contracts/LeaderboardV2.sol:LeaderboardV2 --chain base \
     --constructor-args $(cast abi-encode "constructor(address,address,address,address)" \
       0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 0xcEFB2484932595ffFC809a27B8A5b106A8E1715A \
       0xACfCA8Bc6567E7DB35AD8C814756695dad1cfB30 <SCORE_SIGNER>) \
     --etherscan-api-key $ETHERSCAN_API_KEY --watch
   ```
   (or add `--verify` to the deploy command with `ETHERSCAN_API_KEY` set). Keyless fallback: `--verifier sourcify`.
   For Remix deploys use the Remix "Contract Verification" plugin with the same settings.
3. **Grant mint rights to v2** (AST is unverified, so use cast or Remix "At Address" with the AsteroidToken ABI):
   `cast send 0xcEFB2484932595ffFC809a27B8A5b106A8E1715A "setupLeaderboardAsMinter(address)" <V2_ADDRESS> --rpc-url base --ledger`
4. **Revoke the old board's mint rights:**
   `cast send 0xcEFB2484932595ffFC809a27B8A5b106A8E1715A "revokeRole(bytes32,address)" $(cast keccak MINTER_ROLE) 0xEFd9a0865306244d4F5227F0eBA2679Dd6d47E6A --rpc-url base --ledger`
   Check: `cast call 0xcEFB… "hasRole(bytes32,address)(bool)" $(cast keccak MINTER_ROLE) 0xEFd9… --rpc-url base` → false.
5. **Backend.** In the Vercel project set `SCORE_SIGNER_PRIVATE_KEY` (sensitive), `LEADERBOARD_V2_ADDRESS`, optionally
   `BASE_RPC_URL` / `ALLOWED_ORIGIN`. Move `backend/api/*` + `backend/lib` into the deployed tree (or a separate Vercel
   project), deploy to a preview first.
6. **Front end** (separate PR, issue F1), then the demo checklist in ISSUES.md.

## Migration / retirement of v1
- **0xEFd9a086…47E6A (front-end board):** the 5 USDC inside cannot be withdrawn. There's no withdraw, and the only payout path
  needs 20 recorded scores, which can never be recorded because `token()` is an address with no code. Revoke its MINTER_ROLE
  (step 4) and point the front end at v2. Optionally `updateLifePrice` to a huge value so stray `buyLives` calls fail
  instead of adding to the stuck pot. Ownership can stay with Kevin (it can't do anything harmful once MINTER_ROLE is gone).
- **0xbeDa8CDA…0c35d:** configured with Base Sepolia test USDC, never usable on mainnet, holds nothing, has no MINTER_ROLE.
  Nothing to do except mark it retired in `deployments.json`.
- After v2 is live, update `deployments.json` (`Leaderboard.inUseByFrontend` = v2, `verified: true`).
