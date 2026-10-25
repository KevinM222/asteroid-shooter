# LeaderboardV2 deploy: phone path (Base app) + Remix fallback

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

## How it deploys (CREATE2, deterministic address)
The page does **not** send a contract-creation transaction. Smart accounts (EIP-7702 / ERC-4337, e.g. the Base app wallet)
can't reliably do that, and the first attempt (UserOp tx 0x22d9b1ef…cb06) created nothing. The address the old page
showed, `0xeFEb9570acaD49e4ab1f4e4BBB816CaC899Ee3D7`, **was never deployed. Ignore it.**

Instead it calls the standard CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C` with `data = salt ++ initcode`:
- salt = `keccak256("asteroid-shooter/LeaderboardV2/v1")`
- initcode = `forge build` creation bytecode of this commit + the constructor args below
- **expected V2 address: `0xCcF3b3678f00f5AD8036897Cf17D0b5de67EfEca`** (fixed in advance, whoever sends it)

The page only reports success when that address actually has code (`eth_getCode`), and it confirms role changes by reading
`hasRole`. It prefers EIP-5792 `wallet_sendCalls` + `wallet_getCallsStatus` (Base app), and otherwise falls back to
`eth_sendTransaction` with a 4M gas limit (about 3.22M is used). Cost on Base is roughly 0.00002 ETH.

## A. Phone path: `/deploy/` page in the Base app browser
1. Open the preview URL + `/deploy/` **in the Base app browser** (log in to Vercel if asked).
2. Use wallet 0xacfc…fb30 on Base. The page refuses any other account or chain.
3. **Connect**, then check the constructor table, the expected address `0xCcF3…EfEca` and the gas estimate.
4. **Deploy LeaderboardV2** → approve in the wallet → the page waits until the code is live at the expected address, then
   checks owner / scoreSigner / token / usdc / prices on-chain (all ✅). If it says "Already deployed", go to step 5.
5. **Grant MINTER_ROLE to V2** → approve → wait for "confirmed (hasRole)".
6. **Revoke MINTER_ROLE from old Leaderboard 0xEFd9** → approve. "Roles now" should show V2 = yes, old = no.
7. Tell us it's done so we can set `LEADERBOARD_V2_ADDRESS` in Vercel, set `ECONOMY.LEADERBOARD_V2`, and verify the source.

If you get interrupted, just reopen the page. It detects the already-deployed contract and the current roles.

## B. Fallback: Remix (desktop browser wallet)
Note: a Remix deploy is a plain contract creation and gives a **different** address than the one above. Use it only from a
normal (EOA) wallet, and report the address Remix shows **after** checking it has code on basescan.
1. remix.ethereum.org → new file `LeaderboardV2.flat.sol` → paste `deploy/LeaderboardV2.flat.sol` from this branch.
2. Solidity compiler: **0.8.24** (`0.8.24+commit.e11b9ed9`), Advanced: **optimization on, 200 runs, EVM version cancun**,
   viaIR **off**. Compile `LeaderboardV2`.
3. Deploy & run: Environment "Injected Provider" (Base, 0xacfc…fb30), contract `LeaderboardV2`, constructor args
   from the table above (in that order) → Transact.
4. Roles via "At Address" with the AST address and this ABI:
   `[{"type":"function","name":"grantRole","inputs":[{"type":"bytes32","name":"role"},{"type":"address","name":"account"}],"outputs":[],"stateMutability":"nonpayable"},{"type":"function","name":"revokeRole","inputs":[{"type":"bytes32","name":"role"},{"type":"address","name":"account"}],"outputs":[],"stateMutability":"nonpayable"}]`
   MINTER_ROLE = `0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6`.
   grantRole(MINTER_ROLE, <V2>), then revokeRole(MINTER_ROLE, 0xEFd9a0865306244d4F5227F0eBA2679Dd6d47E6A).

## C. Verify after deploy (no Etherscan key needed; we run these from the repo)
```
ARGS=$(cast abi-encode "constructor(address,address,address,address)" 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 0xcEFB2484932595ffFC809a27B8A5b106A8E1715A 0xACfCA8Bc6567E7DB35AD8C814756695dad1cfB30 0xE2741163168B434Ac58373834E0c22a5A253C962)
forge verify-contract 0xCcF3b3678f00f5AD8036897Cf17D0b5de67EfEca contracts/LeaderboardV2.sol:LeaderboardV2 --chain 8453 --constructor-args $ARGS \
  --verifier blockscout --verifier-url https://base.blockscout.com/api/ --watch
forge verify-contract 0xCcF3b3678f00f5AD8036897Cf17D0b5de67EfEca contracts/LeaderboardV2.sol:LeaderboardV2 --chain 8453 --constructor-args $ARGS --verifier sourcify --watch
```
Verification is unchanged by CREATE2: same contract, same constructor args, and the factory is invisible to the verifier.
The page deploys the exact `forge build` output of this commit (bytecode keccak shown on the page), so the repo source
matches. For a Remix deploy, Blockscout can also take the flattened file with the settings above. Basescan shows
Sourcify-verified source, or verify there later with a new Etherscan key.
