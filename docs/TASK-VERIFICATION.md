# Claim Life task verification

Lives for tasks are granted with `LeaderboardV2.claimLifeGrant(amount, grantId, deadline, signature)`
(0xCcF3b3678f00f5AD8036897Cf17D0b5de67EfEca on Base). The signature is an EIP-712 `LifeGrant` signed by the
contract's `scoreSigner`, i.e. the same `SCORE_SIGNER_PRIVATE_KEY` already used by `/api/score`. No contract
change and no new secret are needed for that path. `grantId` = task id (1 X, 2 Base App, 3 Accumulator);
`grantUsed[player][grantId]` makes every task **once per wallet**, enforced on-chain. Max 10 lives per grant.

`POST /api/grant { player, task }` (api/grant.js, server/grant.js) checks the task server-side, refuses if
`grantUsed` is already set, and returns a 5-minute voucher that only `player` can redeem.

| Task | Status | How it is verified / why not |
|---|---|---|
| 3 Try Accumulator | **Live** | Accumulator's public read-only `GET https://accumulator-8.vercel.app/api/status?address=<player>` returns `botWalletExists: true` only after the player signed "Start" in Accumulator with that wallet (bot wallets are created only at a signed Start). Accumulator itself is not modified. |
| 1 Follow on X | Blocked | Checking a follow needs the X API follows/relationship lookup, which is not in the free tier (paid tier required), plus an X OAuth login so the player proves which X account is theirs. Needs a paid plan and new secrets (X client id/secret). |
| 2 Follow on Base App | Blocked | Base App profiles use the Farcaster social graph. A follow check needs a Farcaster data API (e.g. Neynar, which needs an API key = a new secret) and the creator's FID. The player's FID would be found from their wallet's verified address (or Sign In with Farcaster). The public api.farcaster.xyz endpoints for this require auth. |

To enable task 2 later: create a Neynar API key, set `NEYNAR_API_KEY` and `CREATOR_FID` in Vercel env
(never in git), and add a `base` entry to `TASKS` in server/grant.js that resolves the player's FID from
`/v2/farcaster/user/bulk-by-address` and checks the follow with `/v2/farcaster/user/bulk?viewer_fid=`.

Tests: `npm test` (unit). Fork: `anvil --fork-url https://mainnet.base.org &` then `RPC=http://127.0.0.1:8545 npm test`
(server/test/grant-fork.test.js points the real contract's scoreSigner at a test key on the local fork only).
