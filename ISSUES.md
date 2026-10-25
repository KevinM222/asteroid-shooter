# Asteroid Shooter: running issues list

The single list we work through before the pre-launch demo. Update the status here in the same PR that fixes an item.

**Status:** `open` · `in PR` (fix written, not merged) · `needs Kevin` (only Kevin can do it) · `done` (merged or confirmed on-chain)
**Priority:** P0 = blocks launch or puts money/keys at risk · P1 = must fix before the demo · P2 = before public launch · P3 = later

Last updated: 2026-10-22 (branch `economy-v2` / PR #2, on top of PR #1 `frontend-security`).

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
| C3 | P0 | done | Old board 0xEFd9 still holds MINTER_ROLE on live AST (revoked by Kevin 2026-10-25, confirmed on-chain: `hasRole` = false) | Kevin: `revokeRole(MINTER_ROLE, 0xEFd9…)` on AST from his wallet. Harmless today, but it's pure risk with no use |
| C4 | P0 | in PR | Every v1 score submission reverts (token() points at the Sepolia AST address) | v2 takes token and USDC as immutables and refuses addresses without code. The deploy script hard-codes and checks the mainnet addresses |
| C5 | P1 | in PR | No withdraw, so the USDC pot can't be recovered | v2 `withdraw(token,to,amount)`, owner-only, works while paused. Ownership is 2-step and can't be renounced |
| C6 | P1 | open (can't fix) | 5 USDC stuck in 0xEFd9 | No on-chain path to recover it (see A). Write it off; stop sending USDC there (C8) |
| C7 | P1 | in PR | Free lives: `awardFreeLives` is owner-only, so the daily/task buttons fail for players | v2 `claimDailyLives()` (1 per 24h, any wallet) + `claimLifeGrant()` (signer-authorized, one-time grant ids, max 10) |
| C8 | P1 | in PR (v2 address set) | Front end still points at v1 and keeps selling lives into a board that can't record scores | Front end has a v1 "legacy mode" (default until `ECONOMY.LEADERBOARD_V2` is set): purchases, free lives and score submits are disabled with an explanation, so no more USDC goes into 0xEFd9 |
| C9 | P1 | in PR | UI advertises pack discounts (10 for $0.90 …) but v1 charges 10 × $0.10 | v2 per-pack prices: 1=$0.10, 10=$0.90, 25=$2.25, 50=$4.50 (owner-settable) |
| C10 | P1 | in PR | No pause / emergency stop | v2 Pausable (play, buy, claims, submit). Withdraw still works |
| C11 | P1 | done | Deploy v2 from Kevin's wallet, verify, grant it MINTER_ROLE | Deployed 2026-10-25 via CREATE2 at `0xCcF3b3678f00f5AD8036897Cf17D0b5de67EfEca`; MINTER_ROLE granted (confirmed on-chain). Source verified on Sourcify (exact_match, creation + runtime). Blockscout: pending, because the forge submission was blocked by Cloudflare; retry, or Blockscout imports it from Sourcify |
| C12 | P1 | needs Kevin | Retire 0xbeDa (test-USDC config, never usable) and 0xEFd9 | Nothing to withdraw from 0xbeDa. Mark both retired in deployments.json after v2 is live |
| C13 | P2 | open | AST token source in the repo isn't byte-identical to the deployed token, so the token can't be verified on Basescan (and has no "Write" tab) | Try to reproduce the exact compiler settings. Otherwise use cast or Remix for role changes |
| C14 | P2 | in PR | Prize payout: v1 relied on a Chainlink upkeep with "≥20 scores" and 30-day rules that never ran | v2 `endSeason()` is owner-triggered so the top 10 can be reviewed for cheaters before USDC moves. Pays 60% of the pot by the v1 split (32/19/13/5…/6) and optionally mints AST to the top 20 |
| C15 | P2 | open | Sybil farming: free daily lives + AST rewards can be farmed with many wallets | Per-game + daily mint caps limit the damage. Options: rewards only on paid games, Farcaster-verified identity for daily lives, lower AST amounts |
| C16 | P2 | open | Worst-case `submitScore` costs ~800k gas (a new #1 shifts 100 entries). On Base that's cents, but still worth watching | Accept, or store the top list as a heap/linked list later |
| C17 | P3 | open | Decide what AST is for (utility/value). Rewards are inflationary with no sink | Design decision |

## C. Score signing backend (`api/` + `server/`, not deployed)

| ID | Pri | Status | Issue | Fix / owner |
|---|---|---|---|---|
| S1 | P0 | needs Kevin | Choose the signer approach: (a) Vercel function holding a dedicated hot key in an env var (drafted), or (b) a managed key (e.g. CDP Server Wallet / KMS) | Recommendation: (a) for the demo, with a fresh key that holds no funds. The contract caps the damage if it leaks, and `setScoreSigner` rotates it |
| S2 | P1 | in PR | `api/score.js` checks: game exists on-chain and is not submitted, valid session token, chain + server elapsed time, score ≤ time × min(contract cap, real fire rate), multiple of 12, clean name. Signs with a 5-min deadline | Needs env vars (docs/DEPLOY_V2.md step 6) |
| S3 | P1 | in PR | Rate limiting is per-instance memory only | Per-IP and per-player limits (3/min, 10/min per IP, 50 signed scores/day per player). Shared across instances when `UPSTASH_REDIS_REST_*` is set; Kevin adds Upstash via Vercel Marketplace (needs Kevin), otherwise per-instance |
| S4 | P2 | in PR (partial) | Signed scores raise the bar but **a scripted client can still ask for signatures on fake-but-plausible scores** | Done: HMAC session token from `/api/session` after on-chain `startGame` (server measures game length with its own clock), stricter bound from the real fire rate (1 shot/280 ms × 12 pts), daily per-player cap, tests. Still open: server-side replay of an input log with a seeded game, Farcaster Quick Auth identity, manual review before `endSeason` |
| S5 | P2 | open | Life grants (`/api/grant`) are stubbed (501) | Decide which tasks count and how to prove them (e.g. Neynar cast check) |
| S6 | P2 | open | The backend becomes a new runtime surface on Vercel | Pin deps, no logs of keys, CORS restricted to the game origin (drafted) |

## D. Front end (index.html)

| ID | Pri | Status | Issue | Fix / owner |
|---|---|---|---|---|
| F1 | P1 | in PR | Wire v2: `startGame()` → game id; at game over POST `/api/score` → `submitScore(gameId, score, name, deadline, sig)`; `buyLives(pack)` with exact `packPrice(pack)` approval; `claimDailyLives()` + countdown from `nextDailyClaimAt()`; read `getTopScores` (new struct) | Wired behind `ECONOMY.LEADERBOARD_V2` in index.html: startGame → GameStarted id → `/api/session`; game over → `/api/score` → `submitScore(...)`; packs via `packPrice`; `claimDailyLives` + `nextDailyClaimAt`; `prizePot()`. Needs live V2 + backend to test end-to-end |
| F2 | P1 | in PR | `buyLives` has an `sdk.pay(...)` branch that would send USD straight to the leaderboard address without crediting lives (dead today because MiniKit isn't loaded) | Removed |
| F3 | P1 | in PR | No Farcaster/Base mini-app SDK loaded, so `sdk.actions.ready()` is never called and the splash may hang inside Farcaster clients | `@farcaster/miniapp-sdk@0.3.0` bundled and self-hosted at `/vendor/miniapp-sdk.js` (SRI, pinned in package-lock, `npm run build:sdk`). Calls `sdk.actions.ready()` always (in `finally`), uses the host wallet provider + user context inside Farcaster/Base. Needs a check inside a real client |
| F4 | P1 | in PR #1 | XSS via leaderboard names, unlimited USDC approval, unpinned CDN scripts, missing headers, misleading "saved" messages | Rev 4.64, PR #1, waiting for Kevin's review and merge |
| F5 | P2 | in PR #1 | CSP is report-only | Inline-script hash updated in PR #2 (a test now fails if it drifts). Switching to enforce still needs a manual wallet test in Farcaster/Base clients |
| F6 | P2 | in PR | Daily timer uses localStorage | Uses on-chain `nextDailyClaimAt()` |
| F7 | P2 | in PR | "Prize pot" display reads the old board | Uses `prizePot()` on v2 |

## E. Gameplay

| ID | Pri | Status | Issue |
|---|---|---|---|
| G1 | P1 | open | Port v2.12 fixes: laser crash, missed asteroids cost a life, hit scoring |
| G2 | P1 | in PR | Keep lives in sync with the on-chain count (v2: one life spent in `startGame`) → v2 path re-reads `playerLives` after `startGame` |
| G3 | P2 | open | Canvas sizing on mobile/fullscreen |
| G4 | P2 | in PR | Show the AST reward after submit (v2 emits it in `ScoreSubmitted`) → Results screen shows the AST minted (balance diff) after confirm |
| G5 | P2 | in PR | Keep scoring rules in sync with the backend (`POINTS_PER_HIT=12`) and on-chain `maxPointsPerSecond` (20) → Backend constants in `server/guards.js` (`GAME`) and `server/signer.js` (`POINTS_PER_HIT`). Keep in sync with index.html |

## F. Launch / manifest / ops

| ID | Pri | Status | Issue |
|---|---|---|---|
| L1 | P1 | needs Kevin | Sign the `accountAssociation` in `/.well-known/farcaster.json` (Base.dev or Farcaster) after PR #1 merges |
| L2 | P1 | needs Kevin | Register the app on Base.dev (the Base App reads metadata from there since April 2026) |
| L3 | P1 | in progress | Vercel preview deployments from GitHub are off, so there's no way to test a branch before production. Enable them or use CLI previews → CLI preview deployments of `economy-v2` work (see PR #2). Enabling Git previews is a project setting (needs Kevin) |
| L4 | P2 | open | Replace placeholder icon/splash/hero images |
| L6 | P3 | open | The self-hosted mini-app SDK bundle is ~760 KB (includes Solana/Ethereum provider code). Try a slimmer build or lazy-load it only inside mini-app hosts |
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
