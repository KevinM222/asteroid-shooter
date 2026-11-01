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
| Try Keep | 4 | **Live, verified** | Keep's public `GET https://keep-portfolios.vercel.app/api/status?address=<player>` (server-side; no CORS, `no-store`) must return `200 {"used": true}`. `used` turns true only after the wallet signs Keep's confirm message. `used: false` → 403 "open Keep, connect this same wallet and sign the confirm message there". 429 / 503 / any other error or malformed body → 503 "try again later", no voucher. |

### Follow on X: leaving and coming back
The X link is `https://x.com/intent/follow?screen_name=kevinmm8222`. It is never opened by navigating the game window:
mini-app hosts use `sdk.actions.openUrl`, other browsers `window.open(url, "_blank")` (opener cleared); if a wallet webview
refuses a new window, the game shows the link instead of navigating away. The ticket is stored in `localStorage`
(`ast:ticket:<wallet>:<task>`, with `issuedAt`, dropped after 1 h or once claimed), and on load the game silently restores an
already-authorised wallet with `eth_accounts` (no prompt), so after a reload / app switch the button shows
"Claim life (ready in Ns)" → "Claim Life" with the hint "Back from X? Tap Claim Life."

### Wallets
Transactions use EIP-5792 `wallet_sendCalls` only when the wallet reports Base `atomic.status === "supported"` (Base app /
Coinbase Smart Wallet). Everything else (MetaMask, Coinbase Wallet extension, Rabby, other EOAs) uses `eth_sendTransaction`,
and any non-rejection `wallet_sendCalls` error falls back to it. Before sending, the wallet is switched to Base (adding the chain
on error 4902). Confirmation reads go to `https://mainnet.base.org`, not the wallet's RPC.

Tests: `npm test` (unit). Fork: `anvil --fork-url https://mainnet.base.org &` then `RPC=http://127.0.0.1:8545 npm test`
(server/test/grant-fork.test.js points the real contract's scoreSigner at a test key on the local fork only).

### iPhone / wallet browser: straight to the X app

Inside the Coinbase Wallet (or other wallet) in-app browser on iPhone, `window.open` and
`https://x.com` universal links get handed to Safari, so the X app's top-left back link
said "◀ Safari". The game now does this instead when the device is iOS, or a mobile wallet browser
(UA contains Coinbase/BaseApp or `window.ethereum.isCoinbaseWallet` on a mobile UA):

1. Starts the click-through ticket and saves it to localStorage **before** leaving.
2. Sets the game window's `location.href = 'twitter://user?screen_name=kevinmm8222'`.
   The X app still registers the legacy `twitter://` scheme; `x://` is not documented and
   is only tried second.
3. If the page hasn't been hidden or blurred within 1.5 s (the app isn't installed), it tries the next scheme, then
   opens the https follow page in a **new** window. The game window itself is never sent to https.

iOS then shows "◀ Coinbase Wallet" (the app that opened X). Coming back resumes the
countdown/Claim Life from the saved ticket. Exceptions:
- Base app mini-app: unchanged and still uses `sdk.actions.openUrl`.
- Desktop: unchanged and still uses `window.open`, including with the Coinbase extension.
- The scheme opens the profile, not the follow intent, so the player taps Follow there.

## Outbound links: always a way back to Asteroids (v5.15)

Every outbound link goes through `openLink()`. That covers the Accumulator/Keep tasks, the More apps strip, the Farcaster/X share buttons, and the X task fallback when the X app isn't installed.

| Context | Behavior |
|---|---|
| Base / Farcaster mini-app | `sdk.actions.openMiniApp` for our mini apps, `openUrl` otherwise (unchanged) |
| Wallet in-app browser on a phone (Coinbase Wallet, MetaMask, …) | Navigate the **same webview**; the wallet's back button returns to the game |
| Desktop, plain mobile Safari/Chrome | New tab |

Links to Keep and Accumulator get `?ref=asteroids`.

Before leaving, the game saves its state. On return (bfcache or reload) it restores everything:
- `ast:return` holds the destination and scroll position, and the scroll position is restored on return.
- X claim tickets stay in localStorage and the countdown resumes.
- The wallet reconnects silently via `eth_accounts`.

Coinbase Wallet iOS has no documented in-app tabs. `window.open` / `_blank` were seen handing off to Safari, which
loses the wallet. Opening the game once with `?linkmode=tab` switches wallet browsers to a real `target=_blank`
anchor so a device test can check whether that stays in-app. `?linkmode=same` switches back. The choice is stored in localStorage.

The X follow task still uses the `twitter://` app scheme (see above).
