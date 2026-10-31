# Claim Life task verification

Lives for tasks are granted with `LeaderboardV2.claimLifeGrant(amount, grantId, deadline, signature)`
(0xCcF3b3678f00f5AD8036897Cf17D0b5de67EfEca on Base). The signature is an EIP-712 `LifeGrant` signed by the
contract's `scoreSigner`, i.e. the same `SCORE_SIGNER_PRIVATE_KEY` already used by `/api/score`. No contract
change and no new secret are needed for that path. `grantId` = task id (1 X, 3 Accumulator, 4 Keep; 2 was "Follow on Base App" and is retired — never signed again).
The contract takes any `uint256` grantId, so new tasks need no contract change.
`grantUsed[player][grantId]` makes every task **once per wallet**, enforced on-chain. Max 10 lives per grant.

`POST /api/grant { player, task, ticket? }` (api/grant.js, server/grant.js) checks the task server-side, refuses if
`grantUsed` is already set, and returns a 5-minute voucher that only `player` can redeem.

| Task | grantId | Status | How it is checked |
|---|---|---|---|
| Try Accumulator | 3 | **Live, verified** | Accumulator's public `GET https://accumulator-8.vercel.app/api/status?address=<player>` must return `botWalletExists: true` (a bot wallet exists only after the player signed "Start" with that wallet). |
| Follow on X | 1 | **Live, click-through** | A follow can't be checked without a paid X API tier + X OAuth. Opening the link calls `/api/grant { action: "start" }`, which returns a ticket (HMAC keyed from the signer key, bound to chain, contract, player and task, with a timestamp). The voucher is signed only when the ticket is ≥ 10 s and ≤ 1 h old. Honor system: it proves the link was opened, not the follow. |
| Try Keep | 4 | **Live, click-through** | Same click-through as X. Keep (keep-portfolios.vercel.app) keeps holdings on the device and has no public per-wallet endpoint (`/api/status`, `/api/portfolio`, `/api/wallet` all 404; its only server calls are internal TanStack server functions). |

### Making Keep verified later
Keep would need to add a public, read-only, CORS-free (server-to-server) endpoint such as
`GET https://keep-portfolios.vercel.app/api/status?address=<0x…>` → `{ "address": "0x…", "used": true, "firstSeenAt": 1730000000 }`
that returns `used: true` only after that wallet signed in to Keep (e.g. a SIWE / signed message, so nobody can mark someone
else's address). Then set `keep: { grantId: 4n, lives: 1n, verify: verifyKeep }` in server/grant.js (copy `verifyAccumulator`),
and drop `4` from `CLICK_TASKS` in index.html. No contract change.

### Wallets
Transactions use EIP-5792 `wallet_sendCalls` only when the wallet reports Base `atomic.status === "supported"` (Base app /
Coinbase Smart Wallet). Everything else (MetaMask, Coinbase Wallet extension, Rabby, other EOAs) uses `eth_sendTransaction`,
and any non-rejection `wallet_sendCalls` error falls back to it. Before sending, the wallet is switched to Base (adding the chain
on error 4902). Confirmation reads go to `https://mainnet.base.org`, not the wallet's RPC.

Tests: `npm test` (unit). Fork: `anvil --fork-url https://mainnet.base.org &` then `RPC=http://127.0.0.1:8545 npm test`
(server/test/grant-fork.test.js points the real contract's scoreSigner at a test key on the local fork only).
