# Deploying LeaderboardV2: runbook for Kevin

Every step below is run **by Kevin from his own wallet 0xACfCA8Bc6567E7DB35AD8C814756695dad1cfB30** (AST admin, owner of
both v1 boards). Nothing here has been run, and no keys were created for you. Design notes: [ECONOMY-V2.md](ECONOMY-V2.md).
Issue IDs (C3, S1, …) refer to [ISSUES.md](../ISSUES.md).

Addresses (Base mainnet, chain 8453):

| | |
|---|---|
| AST token | `0xcEFB2484932595ffFC809a27B8A5b106A8E1715A` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Leaderboard v1 "Leaderboard1" (front end, holds 5 USDC, has MINTER_ROLE) | `0xEFd9a0865306244d4F5227F0eBA2679Dd6d47E6A` |
| Leaderboard v1 "Leaderboard2" (test-USDC config, no role) | `0xbeDa8CDAE0f0829ea52B80cB6245a70F0010c35d` |

Checked on-chain (2026-10-22): the deployed AST bytecode has `setupLeaderboardAsMinter`, `grantRole`, and `revokeRole`,
and Kevin's wallet holds `DEFAULT_ADMIN_ROLE`.

## Checklist
- [ ] 0. Prerequisites: revoke the leaked keys, create a new Etherscan v2 key, generate the signer key and session secret
- [ ] 1. Deploy LeaderboardV2
- [ ] 2. Verify on Basescan
- [ ] 3. Grant MINTER_ROLE on AST to V2
- [ ] 4. Revoke MINTER_ROLE from Leaderboard1 (0xEFd9)
- [ ] 5. Retire both old boards (the 5 USDC can't be recovered)
- [ ] 6. Backend env vars and a preview deploy
- [ ] 7. Point the front end at V2 and deploy a preview, then production after the demo checklist

## 0. Prerequisites
1. **Revoke the leaked keys** (ISSUES.md K1-K3): the CDP API key, the Basescan key, and the Neynar key.
2. **Etherscan API v2 key.** Create it at etherscan.io → API Keys. One v2 key covers Basescan (chain 8453). Export it
   only in your shell: `export ETHERSCAN_API_KEY=…`. Don't commit it.
3. **Score signer key (new, hot, holds no funds).** On your own machine: `cast wallet new`.
   - The private key goes **only** into Vercel as `SCORE_SIGNER_PRIVATE_KEY` (step 6). Never into git, chat, or email.
   - Its public address is `SCORE_SIGNER`, a constructor argument in step 1.
   - Never use your owner wallet as the signer. The deploy script refuses that.
   - If it ever leaks: `setScoreSigner(<new address>)` from the owner wallet. The contract's per-game (500 AST) and
     per-day (50,000 AST) mint caps limit the damage in the meantime.
4. **Session secret** for the backend's game session tokens: `openssl rand -base64 48` → Vercel `SESSION_SECRET`.
5. Foundry installed (`foundryup`), repo checked out on the merged commit, `forge test` green.
6. Deployer signer: a Ledger (`--ledger`) or an encrypted keystore (`cast wallet import kevin --interactive`, then use
   `--account kevin` instead of `--ledger` below). Have a little ETH on Base for gas.

## 1. Deploy
```
export SCORE_SIGNER=0x…   # public address from step 0.3
forge script scripts/foundry/DeployLeaderboardV2.s.sol --rpc-url base \
  --ledger --sender 0xACfCA8Bc6567E7DB35AD8C814756695dad1cfB30 --broadcast --verify
```
The script hard-codes and checks the mainnet USDC/AST addresses, makes your wallet the owner, and sets the pack prices
(1 = $0.10, 10 = $0.90, 25 = $2.25, 50 = $4.50). It prints `LeaderboardV2 deployed at 0x…`. Save that as `V2`.

Remix alternative: `forge flatten contracts/LeaderboardV2.sol > LeaderboardV2.flat.sol` → Remix, compile with
**0.8.24, optimizer on, 200 runs, EVM cancun**, deploy with constructor args
`(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, 0xcEFB2484932595ffFC809a27B8A5b106A8E1715A, 0xACfCA8Bc6567E7DB35AD8C814756695dad1cfB30, <SCORE_SIGNER>)`.

Sanity check:
```
cast call $V2 "owner()(address)" --rpc-url base           # your wallet
cast call $V2 "scoreSigner()(address)" --rpc-url base     # SCORE_SIGNER
cast call $V2 "packPrice(uint256)(uint256)" 10 --rpc-url base   # 900000
```

## 2. Verify on Basescan (Etherscan v2 key)
If `--verify` in step 1 succeeded, you're done. Otherwise:
```
forge verify-contract $V2 contracts/LeaderboardV2.sol:LeaderboardV2 --chain base \
  --constructor-args $(cast abi-encode "constructor(address,address,address,address)" \
    0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 0xcEFB2484932595ffFC809a27B8A5b106A8E1715A \
    0xACfCA8Bc6567E7DB35AD8C814756695dad1cfB30 $SCORE_SIGNER) \
  --etherscan-api-key $ETHERSCAN_API_KEY --watch
```
Keyless fallback: `--verifier sourcify`. For Remix deploys, use the "Contract Verification" plugin with the same settings.
The basescan.org/address/$V2#code page should show a green check.

(The v1 boards and the AST token stay unverified because the repo sources don't reproduce their bytecode exactly. See C13.)

## 3. Grant MINTER_ROLE on AST to V2
```
cast send 0xcEFB2484932595ffFC809a27B8A5b106A8E1715A "grantRole(bytes32,address)" $(cast keccak MINTER_ROLE) $V2 --rpc-url base --ledger
cast call 0xcEFB2484932595ffFC809a27B8A5b106A8E1715A "hasRole(bytes32,address)(bool)" $(cast keccak MINTER_ROLE) $V2 --rpc-url base   # true
```
(`setupLeaderboardAsMinter(address)` does the same thing on this token.)

## 4. Revoke MINTER_ROLE from Leaderboard1 (0xEFd9)
```
cast send 0xcEFB2484932595ffFC809a27B8A5b106A8E1715A "revokeRole(bytes32,address)" $(cast keccak MINTER_ROLE) 0xEFd9a0865306244d4F5227F0eBA2679Dd6d47E6A --rpc-url base --ledger
cast call 0xcEFB2484932595ffFC809a27B8A5b106A8E1715A "hasRole(bytes32,address)(bool)" $(cast keccak MINTER_ROLE) 0xEFd9a0865306244d4F5227F0eBA2679Dd6d47E6A --rpc-url base   # false
```
Leaderboard2 (0xbeDa) never had the role (checked on-chain), so there's nothing to revoke there. This step is safe to do
right now, before V2 exists (C3/K4).

## 5. Retire both old boards
**The 5 USDC in Leaderboard1 can't be recovered.** The v1 contract has **no withdraw function**. The only path that moves
USDC is `performUpkeep` → `_distributePrizes`, which needs ≥20 recorded scores, and v1 can never record a score
(`token()` points at an address with no code on mainnet, so every `submitScore` reverts). There's also no setter for
`token`/`usdc`. Treat it as written off (C6).

- **Leaderboard1 (0xEFd9):** after step 4, stop new USDC going in. Optional:
  `cast send 0xEFd9a0865306244d4F5227F0eBA2679Dd6d47E6A "updateLifePrice(uint256)" 1000000000000 --rpc-url base --ledger`
  (makes `buyLives` effectively impossible). The front end's legacy mode already disables purchases.
- **Leaderboard2 (0xbeDa):** configured with Base Sepolia test USDC, so it's unusable on mainnet. It holds nothing and has
  no role. No transaction is needed.
- Ownership of both can stay with you. Without MINTER_ROLE they can't do anything harmful.
- In `deployments.json`: set `LeaderboardV2.address`, mark `0xEFd9`/`0xbeDa` as `"retired"`, and set `Leaderboard.inUseByFrontend` to V2.

## 6. Backend (score signing service) on Vercel
The functions live in `api/` (`/api/session`, `/api/score`, `/api/grant` (501 for now)) with shared code in `server/`.
They deploy with the same Vercel project as the game.

Environment variables (Vercel → Project → Settings → Environment Variables). Mark secrets **Sensitive**. Set them for
Preview first:

| Name | Required | Value |
|---|---|---|
| `SCORE_SIGNER_PRIVATE_KEY` | yes | private key from step 0.3 |
| `SESSION_SECRET` | yes | random, ≥32 chars (step 0.4) |
| `LEADERBOARD_V2_ADDRESS` | yes | `$V2` |
| `ALLOWED_ORIGIN` | yes for previews | the exact origin of the page calling the API (default `https://asteroid-shooter-alpha.vercel.app`) |
| `BASE_RPC_URL` | recommended | a dedicated Base RPC (Alchemy/QuickNode/CDP). The public RPC rate-limits |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | recommended | shared rate limits across instances (Vercel Marketplace → Upstash). Without them, limits are per-instance |
| `CHAIN_ID` | no | defaults to 8453 |

The backend refuses to sign if `scoreSigner()` on-chain doesn't match the key, if the board is paused, if the game wasn't
started on-chain or was already submitted, or if the score is too high for the time played on **both** the chain's clock
and the server's own session clock.

Test on a preview: `curl -X POST https://<preview>/api/score -H 'content-type: application/json' -d '{}'` should return
400 (not 503 "not configured").

## 7. Front end
In `index.html` set `ECONOMY.LEADERBOARD_V2 = "<V2>"` (one line). Deploy a **preview**, then run the demo checklist in
ISSUES.md: daily life, buy 1 and 10, play, submit, AST minted, leaderboard, plus the negative tests. Then promote to
production. Until that line is set, the site runs in "legacy" mode: v1 data is read-only, and purchases, free lives, and
score submits are disabled with an explanation.

## Owner operations later
`pause()` / `unpause()`, `withdraw(token,to,amount)` (works while paused), `setScoreSigner`, `setPackPrice`,
`setScoreRules`, `setRewardRules`, `setLifeRules`, and `endSeason(...)` (review the top 10 for cheaters first).
Ownership transfer is 2-step and renounce is disabled.
