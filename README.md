# Asteroid Shooter (Base mini app)
Single-file Phaser 3 + ethers v6 game, deployed on Vercel (asteroid-shooter-alpha.vercel.app).
- `index.html` – game (canonical, Rev 4.64 lineage; v2.12 fixes to be ported, see cleanup-plan)
- `assets/` – sprites
- `contracts/` – Leaderboard + AsteroidToken source (solc 0.8.20, OZ 5.0.2). NOTE: closest local source, NOT byte-identical to mainnet deployments; deployments are unverified.
- `deployments.json` – mainnet addresses.
- `contracts/LeaderboardV2.sol`, `test/`, `scripts/foundry/` – economy v2 (Foundry; `forge install && forge test`). See `docs/ECONOMY-V2.md`.
- `api/` + `server/` – score-signing Vercel functions for v2 (inactive until env vars are set; see docs/DEPLOY_V2.md).
- `vendor/miniapp-sdk.js` – self-hosted Farcaster mini-app SDK (`npm run build:sdk`).
- `ISSUES.md` – running list of issues to fix before the demo.
No secrets belong in this repo; see .gitignore.

## Security config (Rev 4.64)
- `vercel.json` sets X-Content-Type-Options, Referrer-Policy, Permissions-Policy, HSTS and CSP.
  - Enforced CSP: `frame-ancestors` (Farcaster/Warpcast/Base hosts + self), `object-src 'none'`, `base-uri`, `form-action`.
    Do **not** add X-Frame-Options – it would break embedding in Farcaster / Base app.
  - Full CSP (script/connect/img/...) ships as `Content-Security-Policy-Report-Only`. Check the browser console for
    `[Report Only]` violations while testing wallet flows; when clean, rename the header to `Content-Security-Policy`.
  - The inline `<script>` is allowed by a sha256 hash. **After editing the inline script run**
    `python3 scripts/update-csp-hash.py` (otherwise the policy reports/blocks the script).
- CDN scripts are pinned and use Subresource Integrity. To bump a version, recompute:
  `curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A`
- Static files served as-is (no SPA fallback): `/.well-known/farcaster.json`, `/robots.txt`, `/favicon.ico`,
  `/icon.png` (1024x1024), `/splash.png` (200x200), `/hero.png` (1200x630). Unknown paths now 404.

## Manifest (`/.well-known/farcaster.json`)
`accountAssociation` contains placeholders and must be signed by Kevin's account:
1. Deploy (merge) so the manifest is live at https://asteroid-shooter-alpha.vercel.app/.well-known/farcaster.json
2. Generate the association with either
   - Base.dev: https://www.base.dev/preview?tab=account -> enter `asteroid-shooter-alpha.vercel.app` -> Submit -> Verify -> Sign, or
   - Farcaster: https://farcaster.xyz/~/developers/mini-apps/manifest (sign with the Farcaster account that owns the app).
3. Paste `header`, `payload`, `signature` into the file, commit, redeploy.

Note: since April 2026 the Base App treats apps as standard web apps and reads metadata from the Base.dev project,
not from farcaster.json; the manifest is still used by Farcaster clients.
