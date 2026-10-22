# Deploying LeaderboardV2 (Kevin runs these from 0xacfc…fb30)

Background and contract design: [ECONOMY-V2.md](ECONOMY-V2.md). Nothing here has been run; no keys were created. Leaderboard1 (0xEFd9) has **no withdraw function**, so its 5 USDC cannot be recovered (see ISSUES.md C6).

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
