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
npm install && RPC=http://127.0.0.1:8545 npm test   
```

## Deployment and v1 retirement
See [DEPLOY_V2.md](DEPLOY_V2.md), the single runbook (deploy, verify, roles, retiring v1, backend env vars, front end).
