# LeaderboardV2 deploy: phone path (MetaMask) + Remix fallback

Owner wallet: `0xACfCA8Bc6567E7DB35AD8C814756695dad1cfB30` (Kevin). Chain: Base mainnet (8453).

## Constructor (order matters)
`constructor(address usdc_, address token_, address owner_, address signer_)`

| arg | value |
|---|---|
| usdc_ | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| token_ (AST) | `0xcEFB2484932595ffFC809a27B8A5b106A8E1715A` |
| owner_ | `0xACfCA8Bc6567E7DB35AD8C814756695dad1cfB30` |
| signer_ | `0xE2741163168B434Ac58373834E0c22a5A253C962` (score signer; its key exists only in Vercel env) |

There are no other constructor args. Pack prices (1=$0.10, 10=$0.90, 25=$2.25, 50=$4.50), the daily life, and the reward caps are
set by the constructor/defaults and can be changed later by the owner.

ABI-encoded args (for verification):
`000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000cefb2484932595fffc809a27b8a5b106a8e1715a000000000000000000000000acfca8bc6567e7db35ad8c814756695dad1cfb30000000000000000000000000e2741163168b434ac58373834e0c22a5a253c962`

## A. Phone path: `/deploy/` page in the MetaMask app browser
1. In MetaMask (phone) → Browser tab → open the preview URL + `/deploy/` (log in to Vercel if asked).
2. Make sure the account is 0xacfc…fb30 and the network is Base. The page refuses any other account or chain.
3. **Connect**, check the constructor table and the gas estimate.
4. **Deploy LeaderboardV2** → confirm in MetaMask → the page shows the new address and the Basescan tx link, then checks
   owner / scoreSigner / token / usdc / prices on-chain (all ✅).
5. **Grant MINTER_ROLE to V2** → confirm.
6. **Revoke MINTER_ROLE from old Leaderboard 0xEFd9** → confirm. The "Roles now" box should show V2 = yes, old = no.
7. Send the V2 address back so we can set `LEADERBOARD_V2_ADDRESS` in Vercel, set `ECONOMY.LEADERBOARD_V2`, and verify the source.

The page saves the V2 address in the browser, so if you get interrupted, reopening it resumes at step 5 (or paste the address).

## B. Fallback: Remix (desktop or phone browser + MetaMask)
1. remix.ethereum.org → new file `LeaderboardV2.flat.sol` → paste `deploy/LeaderboardV2.flat.sol` from this branch.
2. Solidity compiler: **0.8.24** (`0.8.24+commit.e11b9ed9`), Advanced: **optimization on, 200 runs, EVM version cancun**,
   viaIR **off**. Compile `LeaderboardV2`.
3. Deploy & run: Environment "Injected Provider – MetaMask" (Base, 0xacfc…fb30), contract `LeaderboardV2`, constructor args
   from the table above (in that order) → Transact.
4. Roles via "At Address" with the AST address and this ABI:
   `[{"type":"function","name":"grantRole","inputs":[{"type":"bytes32","name":"role"},{"type":"address","name":"account"}],"outputs":[],"stateMutability":"nonpayable"},{"type":"function","name":"revokeRole","inputs":[{"type":"bytes32","name":"role"},{"type":"address","name":"account"}],"outputs":[],"stateMutability":"nonpayable"}]`
   MINTER_ROLE = `0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6`.
   grantRole(MINTER_ROLE, <V2>), then revokeRole(MINTER_ROLE, 0xEFd9a0865306244d4F5227F0eBA2679Dd6d47E6A).

## C. Verify after deploy (no Etherscan key needed; we run these from the repo)
```
ARGS=$(cast abi-encode "constructor(address,address,address,address)" 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 0xcEFB2484932595ffFC809a27B8A5b106A8E1715A 0xACfCA8Bc6567E7DB35AD8C814756695dad1cfB30 0xE2741163168B434Ac58373834E0c22a5A253C962)
forge verify-contract <V2> contracts/LeaderboardV2.sol:LeaderboardV2 --chain 8453 --constructor-args $ARGS \
  --verifier blockscout --verifier-url https://base.blockscout.com/api/ --watch
forge verify-contract <V2> contracts/LeaderboardV2.sol:LeaderboardV2 --chain 8453 --constructor-args $ARGS --verifier sourcify --watch
```
The page deploys the exact `forge build` output of this commit (bytecode keccak shown on the page), so the repo source
matches. For a Remix deploy, Blockscout can also take the flattened file with the settings above. Basescan shows
Sourcify-verified source, or verify there later with a new Etherscan key.
