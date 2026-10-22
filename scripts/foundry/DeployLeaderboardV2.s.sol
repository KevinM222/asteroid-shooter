// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {LeaderboardV2} from "../../contracts/LeaderboardV2.sol";

/// Deploys LeaderboardV2 on Base mainnet with Kevin's wallet as owner.
/// It does NOT grant MINTER_ROLE or touch the old boards; those are separate, explicit steps
/// (see docs/ECONOMY-V2.md).
///
///   export SCORE_SIGNER=0x...   # public address of the backend signer key (not the key itself)
///   forge script scripts/foundry/DeployLeaderboardV2.s.sol \
///     --rpc-url base --account kevin --sender 0xacfca8bc6567e7db35ad8c814756695dad1cfb30 \
///     --broadcast --verify
contract DeployLeaderboardV2 is Script {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // Base mainnet USDC
    address constant AST = 0xcEFB2484932595ffFC809a27B8A5b106A8E1715A; // live AsteroidToken
    address constant OWNER = 0xACfCA8Bc6567E7DB35AD8C814756695dad1cfB30; // Kevin

    function run() external returns (LeaderboardV2 lb) {
        require(block.chainid == 8453, "Base mainnet only (chainId 8453)");
        address signer = vm.envAddress("SCORE_SIGNER");
        require(signer != address(0) && signer != OWNER, "SCORE_SIGNER must be a separate hot key");
        require(USDC.code.length > 0 && AST.code.length > 0, "token/usdc has no code");

        vm.startBroadcast();
        lb = new LeaderboardV2(USDC, AST, OWNER, signer);
        vm.stopBroadcast();

        require(lb.owner() == OWNER, "owner mismatch");
        require(address(lb.token()) == AST && address(lb.usdc()) == USDC, "address mismatch");
        console2.log("LeaderboardV2 deployed at", address(lb));
        console2.log("constructor args (for manual verification):");
        console2.logBytes(abi.encode(USDC, AST, OWNER, signer));
    }
}
