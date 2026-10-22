# Asteroid Shooter: running issues list

The single list we work through before the pre-launch demo. Update the status here in the same PR that fixes an item.

**Status:** `open` · `in PR` (fix written, not merged) · `needs Kevin` (only Kevin can do it) · `done` (merged or confirmed on-chain)
**Priority:** P0 = blocks launch or puts money/keys at risk · P1 = must fix before the demo · P2 = before public launch · P3 = later

Last updated: 2026-10-22 (branch `economy-v2`, on top of PR #1 `frontend-security`).

## A. On-chain findings (read-only checks, Base mainnet, block ~52.94M, 2026-10-22)

These are verified facts, not guesses. Method: `eth_call` / `eth_getCode` against https://mainnet.base.org.

| | 0xEFd9a086…47E6A (used by the front end) | 0xbeDa8CDA…0c35d |
|---|---|---|
| owner() | 0xacfc…fb30 (Kevin) | 0xacfc…fb30 (Kevin) |
| token() | **0x05BF…bfDf: no code on Base mainnet** (it is the AST address on Base *Sepolia*) | same 0x05BF… |
| usdcAddress() | 0x8335…2913 (real Base USDC) | **0x036C…CF7e (Base Sepolia test USDC)** |
| USDC balance | **5.000000 USDC** | 0 |
| MINTER_ROLE on live AST 0xcEFB… | **yes** | no |
| lifePrice() | 100000 ($0.10) | 100000 |
| scores recorded / allTimeHigh | 0 / 0 | 0 / 0 |
| withdraw function | **none** | none |

- Both boards run identical bytecode, and its function list matches `contracts/Leaderboard.sol` exactly (23 selectors). Not a byte-identical compile, so still unverifiable on Basescan.
- `mintReward(address,uint256)` **has no access control in the deployed code**. A simulation with a stub token placed at `token()` succeeds from a random address. It is **not exploitable today**, because `token()` is an empty address. That address is what the leaked deployer 0x274a…51F1 would create at nonce 141, and that nonce is already used on mainnet (the wallet is at nonce 173), so no code can ever be placed there. The real AST (0xcEFB…) cannot be minted through either board. AST total supply is still exactly 1,000,000.
- Side effect of the same bug: **every `submitScore` call reverts** (the first score always tries to mint the 50 AST personal-best bonus to the empty token). No score has ever been recorded on mainnet.
- **The 5 USDC in 0xEFd9 looks permanently stuck.** The only path that moves USDC out is `performUpkeep` → `_distributePrizes`, which needs ≥20 recorded scores (simulated as the owner: reverts "Not enough scores"). Scores can never be recorded, and there's no withdraw or setter for token/USDC.
- `buyLives` on 0xEFd9 still works (it takes real USDC), so any further purchase adds to the stuck pot. 0xbeDa's `buyLives` would pull *test* USDC, which doesn't exist on mainnet, so it always fails.
- `awardFreeLives` is owner-only (confirmed: random caller reverts `OwnableUnauthorizedAccount`).

## B. Contracts / game economy

| ID | Pri | Status | Issue | Fix / owner |
|---|---|---|---|---|
| C1 | P0 | in PR | Scores come from the browser unchecked; anyone can submit any score and farm AST | LeaderboardV2: EIP-712 server-signed scores bound to player + on-chain game id + name + deadline, one submit per game, plus an on-chain time-based ceiling |
| C2 | P0 | in PR | v1 `mintReward` has no access control (dead today only because `token()` is an empty address) | v2 has no public mint. AST is minted only for a valid signed score, capped per game (500) and per day (50,000) |
| C3 | P0 | needs Kevin | Old board 0xEFd9 still holds MINTER_ROLE on live AST | Kevin: `revokeRole(MINTER_ROLE, 0xEFd9…)` on AST from his wallet. Harmless today, but it's pure risk with no use |
| C4 | P0 | in PR | Every v1 score submission reverts (token() points at the Sepolia AST address) | v2 takes token and USDC as immutables and refuses addresses without code. The deploy script hard-codes and checks the mainnet addresses |
| C5 | P1 | in PR | No withdraw, so the USDC pot can't be recovered | v2 `withdraw(token,to,amount)`, owner-only, works while paused. Ownership is 2-step and can't be renounced |
| C6 | P1 | open (can't fix) | 5 USDC stuck in 0xEFd9 | No on-chain path to recover it (see A). Write it off; stop sending USDC there (C8) |
| C7 | P1 | in PR | Free lives: `awardFreeLives` is owner-only, so the daily/task buttons fail for players | v2 `claimDailyLives()` (1 per 24h, any wallet) + `claimLifeGrant()` (signer-authorized, one-time grant ids, max 10) |
| C8 | P1 | open | Front end still points at v1 and keeps selling lives into a board that can't record scores | Front-end wiring to v2 (F1). Until then, consider hiding the buy buttons |
| C9 | P1 | in PR | UI advertises pack discounts (10 for $0.90 …) but v1 charges 10 × $0.10 | v2 per-pack prices: 1=$0.10, 10=$0.90, 25=$2.25, 50=$4.50 (owner-settable) |
| C10 | P1 | in PR | No pause / emergency stop | v2 Pausable (play, buy, claims, submit). Withdraw still works |
| C11 | P1 | needs Kevin | Deploy v2 from Kevin's wallet, verify on Basescan, grant it MINTER_ROLE | docs/ECONOMY-V2.md steps 1-4 |
| C12 | P1 | needs Kevin | Retire 0xbeDa (test-USDC config, never usable) and 0xEFd9 | Nothing to withdraw from 0xbeDa. Mark both retired in deployments.json after v2 is live |
| C13 | P2 | open | AST token source in the repo isn't byte-identical to the deployed token, so the token can't be verified on Basescan (and has no "Write" tab) | Try to reproduce the exact compiler settings. Otherwise use cast or Remix for role changes |
| C14 | P2 | in PR | Prize payout: v1 relied on a Chainlink upkeep with "≥20 scores" and 30-day rules that never ran | v2 `endSeason()` is owner-triggered so the top 10 can be reviewed for cheaters before USDC moves. Pays 60% of the pot by the v1 split (32/19/13/5…/6) and optionally mints AST to the top 20 |
| C15 | P2 | open | Sybil farming: free daily lives + AST rewards can be farmed with many wallets | Per-game + daily mint caps limit the damage. Options: rewards only on paid games, Farcaster-verified identity for daily lives, lower AST amounts |
| C16 | P2 | open | Worst-case `submitScore` costs ~800k gas (a new #1 shifts 100 entries). On Base that's cents, but still worth watching | Accept, or store the top list as a heap/linked list later |
| C17 | P3 | open | Decide what AST is for (utility/value). Rewards are inflationary with no sink | Design decision |

## C. Score signing backend (drafted in `backend/`, not deployed)

| ID | Pri | Status | Issue | Fix / owner |
|---|---|---|---|---|
| S1 | P0 | needs Kevin | Choose the signer approach: (a) Vercel function holding a dedicated hot key in an env var (drafted), or (b) a managed key (e.g. CDP Server Wallet / KMS) | Recommendation: (a) for the demo, with a fresh key that holds no funds. The contract caps the damage if it leaks, and `setScoreSigner` rotates it |
| S2 | P1 | in PR (draft) | `backend/api/score.js` checks: game exists on-chain and isn't submitted, elapsed time ≥ min, score ≤ elapsed × maxPointsPerSecond, score is a multiple of 12, name clean. Signs with a 5-minute deadline | Needs env vars + deploy (Kevin OK) |
| S3 | P1 | open | Rate limiting is per-instance memory only | Vercel KV / Upstash shared limit |
| S4 | P2 | open | Signed scores raise the bar but **a scripted client can still ask for signatures on fake-but-plausible scores** | Next steps: send a compact input/event log and re-simulate it server-side with a seeded deterministic game; per-wallet daily score limits; Farcaster Quick Auth identity; manual review before `endSeason` |
| S5 | P2 | open | Life grants (`/api/grant`) are stubbed (501) | Decide which tasks count and how to prove them (e.g. Neynar cast check) |
| S6 | P2 | open | The backend becomes a new runtime surface on Vercel | Pin deps, no logs of keys, CORS restricted to the game origin (drafted) |

## D. Front end (index.html)

| ID | Pri | Status | Issue | Fix / owner |
|---|---|---|---|---|
| F1 | P1 | open | Wire v2: `startGame()` → game id; at game over POST `/api/score` → `submitScore(gameId, score, name, deadline, sig)`; `buyLives(pack)` with exact `packPrice(pack)` approval; `claimDailyLives()` + countdown from `nextDailyClaimAt()`; read `getTopScores` (new struct) | Next PR after v2 is deployed |
| F2 | P1 | open | `buyLives` has an `sdk.pay(...)` branch that would send USD straight to the leaderboard address without crediting lives (dead today because MiniKit isn't loaded) | Remove the branch |
| F3 | P1 | open | No Farcaster/Base mini-app SDK loaded, so `sdk.actions.ready()` is never called and the splash may hang inside Farcaster clients | Load `@farcaster/miniapp-sdk` (pinned + SRI) and call `ready()` |
| F4 | P1 | in PR #1 | XSS via leaderboard names, unlimited USDC approval, unpinned CDN scripts, missing headers, misleading "saved" messages | Rev 4.64, PR #1, waiting for Kevin's review and merge |
| F5 | P2 | in PR #1 | CSP is report-only | Switch to enforcing after testing wallets in Farcaster/Base |
| F6 | P2 | open | Daily timer uses localStorage | Read `nextDailyClaimAt()` from v2 |
| F7 | P2 | open | "Prize pot" display reads the old board | Point at v2 `prizePot()` |

## E. Gameplay

| ID | Pri | Status | Issue |
|---|---|---|---|
| G1 | P1 | open | Port v2.12 fixes: laser crash, missed asteroids cost a life, hit scoring |
| G2 | P1 | open | Keep lives in sync with the on-chain count (v2: one life spent in `startGame`) |
| G3 | P2 | open | Canvas sizing on mobile/fullscreen |
| G4 | P2 | open | Show the AST reward after submit (v2 emits it in `ScoreSubmitted`) |
| G5 | P2 | open | Keep scoring rules in sync with the backend (`POINTS_PER_HIT=12`) and on-chain `maxPointsPerSecond` (20) |

## F. Launch / manifest / ops

| ID | Pri | Status | Issue |
|---|---|---|---|
| L1 | P1 | needs Kevin | Sign the `accountAssociation` in `/.well-known/farcaster.json` (Base.dev or Farcaster) after PR #1 merges |
| L2 | P1 | needs Kevin | Register the app on Base.dev (the Base App reads metadata from there since April 2026) |
| L3 | P1 | open | Vercel preview deployments from GitHub are off, so there's no way to test a branch before production. Enable them or use CLI previews |
| L4 | P2 | open | Replace placeholder icon/splash/hero images |
| L5 | P3 | open | Paymaster for gasless play; split index.html into modules |

## G. Kevin-only security chores

| ID | Pri | Status | Item |
|---|---|---|---|
| K1 | P0 | needs Kevin | Revoke the leaked Coinbase Developer Platform (CDP) API key |
| K2 | P0 | needs Kevin | Revoke the leaked Basescan key and create a new Etherscan v2 key (needed to verify v2) |
| K3 | P0 | needs Kevin | Revoke the leaked Neynar API key |
| K4 | P1 | needs Kevin | Revoke MINTER_ROLE from 0xEFd9 on AST (C3) |
| K5 | P2 | needs Kevin | Delete the old wallet key 0x274a… (empty, no roles). Optionally ask GitHub Support to purge cached commits |

## Demo checklist (when everything above is P1-clean)
1. v2 deployed + verified, MINTER_ROLE granted, old board's role revoked.
2. Backend signer live on a preview URL, front end on v2 (preview).
3. Wallet flows on MetaMask + Coinbase/Base app + Farcaster: daily life, buy 1 and 10, play, submit, see AST, see leaderboard.
4. Negative tests: replay a signature, tampered score, too-fast score. All should fail.
5. Owner flows: pause/unpause, withdraw, endSeason dry run on a small pot.
