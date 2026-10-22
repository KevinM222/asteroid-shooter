// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {AsteroidToken} from "../contracts/AsteroidToken.sol";
import {LeaderboardV2} from "../contracts/LeaderboardV2.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract LeaderboardV2Test is Test {
    MockUSDC usdc;
    AsteroidToken ast;
    LeaderboardV2 lb;

    address owner = makeAddr("owner");
    uint256 signerKey = 0xA11CE;
    address signer;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_800_000_000);
        signer = vm.addr(signerKey);
        usdc = new MockUSDC();
        vm.prank(owner);
        ast = new AsteroidToken(); // owner is admin + minter, like the live token
        lb = new LeaderboardV2(address(usdc), address(ast), owner, signer);
        vm.prank(owner);
        ast.setupLeaderboardAsMinter(address(lb));
        usdc.mint(alice, 100e6);
        usdc.mint(bob, 100e6);
    }

    // ------------------------------------------------------------ helpers
    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _scoreSig(address player, uint256 gameId, uint256 score, string memory name, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _sign(signerKey, lb.scoreDigest(player, gameId, score, name, deadline));
    }

    function _buy(address p, uint256 lives) internal {
        vm.startPrank(p);
        usdc.approve(address(lb), lb.packPrice(lives));
        lb.buyLives(lives);
        vm.stopPrank();
    }

    function _play(address p, uint256 score, uint256 secondsPlayed) internal returns (uint256 gameId) {
        if (lb.playerLives(p) == 0) _buy(p, 1);
        vm.prank(p);
        gameId = lb.startGame();
        vm.warp(block.timestamp + secondsPlayed);
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = _scoreSig(p, gameId, score, "pilot", deadline);
        vm.prank(p);
        lb.submitScore(gameId, score, "pilot", deadline, sig);
    }

    // ---------------------------------------------------------- deployment
    function test_ConstructorRejectsTokenWithNoCode() public {
        // v1 was deployed pointing at an address with no code (the Sepolia AST address).
        address dead = 0x05BF8973157bcD41e197a16Aa2d39cb78395bfDf;
        vm.expectRevert(abi.encodeWithSelector(LeaderboardV2.NotAContract.selector, dead));
        new LeaderboardV2(address(usdc), dead, owner, signer);
        vm.expectRevert(abi.encodeWithSelector(LeaderboardV2.NotAContract.selector, address(0xBEEF)));
        new LeaderboardV2(address(0xBEEF), address(ast), owner, signer);
        vm.expectRevert(LeaderboardV2.ZeroAddress.selector);
        new LeaderboardV2(address(usdc), address(ast), address(0), signer);
    }

    // ------------------------------------------------------------- pricing
    function test_PackPricesMatchUi() public view {
        assertEq(lb.packPrice(1), 100_000); //  $0.10
        assertEq(lb.packPrice(10), 900_000); // $0.90
        assertEq(lb.packPrice(25), 2_250_000); // $2.25
        assertEq(lb.packPrice(50), 4_500_000); // $4.50
        assertEq(lb.lifePrice(), 100_000);
    }

    function test_BuyLivesChargesExactPackPrice() public {
        uint256 before = usdc.balanceOf(alice);
        _buy(alice, 10);
        assertEq(before - usdc.balanceOf(alice), 900_000);
        assertEq(lb.playerLives(alice), 10);
        assertEq(usdc.balanceOf(address(lb)), 900_000);
        assertEq(usdc.allowance(alice, address(lb)), 0); // exact approval fully used
    }

    function test_BuyLivesRejectsUnlistedPack() public {
        vm.startPrank(alice);
        usdc.approve(address(lb), 1e6);
        vm.expectRevert(abi.encodeWithSelector(LeaderboardV2.PackNotForSale.selector, 7));
        lb.buyLives(7);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- games
    function test_StartGameNeedsAndSpendsALife() public {
        vm.prank(alice);
        vm.expectRevert(LeaderboardV2.NoLives.selector);
        lb.startGame();
        _buy(alice, 1);
        vm.prank(alice);
        uint256 id = lb.startGame();
        assertEq(id, 1);
        assertEq(lb.playerLives(alice), 0);
    }

    function test_SignedScoreRecordsAndRewards() public {
        _play(alice, 1200, 120);
        // 1200/100 = 12 + 50 personal best + 100 all-time high
        assertEq(ast.balanceOf(alice), 162e18);
        assertEq(lb.playerHighScore(alice), 1200);
        assertEq(lb.allTimeHigh(), 1200);
        LeaderboardV2.ScoreView[] memory top = lb.getTopScores(10);
        assertEq(top.length, 1);
        assertEq(top[0].player, alice);
        assertEq(top[0].score, 1200);
        assertEq(top[0].playerName, "pilot");
    }

    function test_SecondGameOnlyGetsBonusesIfBetter() public {
        _play(alice, 1200, 120);
        _play(alice, 600, 60); // not a PB, not ATH
        assertEq(ast.balanceOf(alice), 162e18 + 6e18);
        _play(bob, 1300, 120); // bob: PB + new ATH
        assertEq(ast.balanceOf(bob), 13e18 + 50e18 + 100e18);
    }

    function test_ReplayRejected() public {
        _buy(alice, 1);
        vm.prank(alice);
        uint256 id = lb.startGame();
        vm.warp(block.timestamp + 60);
        uint256 dl = block.timestamp + 300;
        bytes memory sig = _scoreSig(alice, id, 500, "pilot", dl);
        vm.prank(alice);
        lb.submitScore(id, 500, "pilot", dl, sig);
        vm.prank(alice);
        vm.expectRevert(LeaderboardV2.AlreadySubmitted.selector);
        lb.submitScore(id, 500, "pilot", dl, sig);
    }

    function test_SignatureIsBoundToPlayerScoreAndName() public {
        _buy(alice, 1);
        _buy(bob, 1);
        vm.prank(alice);
        uint256 id = lb.startGame();
        vm.prank(bob);
        lb.startGame();
        vm.warp(block.timestamp + 60);
        uint256 dl = block.timestamp + 300;
        bytes memory sig = _scoreSig(alice, id, 500, "pilot", dl);

        vm.startPrank(alice);
        vm.expectRevert(LeaderboardV2.BadSignature.selector);
        lb.submitScore(id, 900, "pilot", dl, sig); // inflated score
        vm.expectRevert(LeaderboardV2.BadSignature.selector);
        lb.submitScore(id, 500, "other", dl, sig); // different name
        vm.expectRevert(LeaderboardV2.BadSignature.selector);
        lb.submitScore(id, 500, "pilot", dl + 1, sig); // different deadline
        vm.stopPrank();

        vm.prank(bob); // someone else front-running alice's signature
        vm.expectRevert(LeaderboardV2.BadSignature.selector);
        lb.submitScore(id, 500, "pilot", dl, sig);
    }

    function test_WrongSignerRejected() public {
        _buy(alice, 1);
        vm.prank(alice);
        uint256 id = lb.startGame();
        vm.warp(block.timestamp + 60);
        uint256 dl = block.timestamp + 300;
        bytes memory sig = _sign(0xBAD, lb.scoreDigest(alice, id, 500, "pilot", dl));
        vm.prank(alice);
        vm.expectRevert(LeaderboardV2.BadSignature.selector);
        lb.submitScore(id, 500, "pilot", dl, sig);
    }

    function test_ExpiredAndUnknownGame() public {
        _buy(alice, 1);
        vm.prank(alice);
        uint256 id = lb.startGame();
        vm.warp(block.timestamp + 60);
        uint256 dl = block.timestamp + 10;
        bytes memory sig = _scoreSig(alice, id, 500, "pilot", dl);
        vm.warp(dl + 1);
        vm.prank(alice);
        vm.expectRevert(LeaderboardV2.Expired.selector);
        lb.submitScore(id, 500, "pilot", dl, sig);

        uint256 dl2 = block.timestamp + 100;
        bytes memory sig2 = _scoreSig(alice, 99, 500, "pilot", dl2);
        vm.prank(alice);
        vm.expectRevert(LeaderboardV2.UnknownGame.selector);
        lb.submitScore(99, 500, "pilot", dl2, sig2);
    }

    function test_ContractRejectsImpossiblyFastScores() public {
        _buy(alice, 1);
        vm.prank(alice);
        uint256 id = lb.startGame();
        vm.warp(block.timestamp + 2);
        uint256 dl = block.timestamp + 300;
        bytes memory sig = _scoreSig(alice, id, 100, "pilot", dl);
        vm.prank(alice);
        vm.expectRevert(LeaderboardV2.GameTooShort.selector);
        lb.submitScore(id, 100, "pilot", dl, sig);

        vm.warp(block.timestamp + 8); // 10 s elapsed -> cap 200 points
        sig = _scoreSig(alice, id, 5000, "pilot", dl);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LeaderboardV2.ScoreTooFast.selector, 5000, 200));
        lb.submitScore(id, 5000, "pilot", dl, sig);
    }

    function test_SignerUnsetBlocksScores() public {
        vm.prank(owner);
        lb.setScoreSigner(address(0));
        _buy(alice, 1);
        vm.prank(alice);
        uint256 id = lb.startGame();
        vm.warp(block.timestamp + 60);
        vm.prank(alice);
        vm.expectRevert(LeaderboardV2.SignerNotSet.selector);
        lb.submitScore(id, 100, "pilot", block.timestamp + 1, hex"00");
    }

    function test_InvalidNames() public {
        _buy(alice, 1);
        vm.prank(alice);
        uint256 id = lb.startGame();
        vm.warp(block.timestamp + 60);
        vm.startPrank(alice);
        vm.expectRevert(LeaderboardV2.InvalidName.selector);
        lb.submitScore(id, 100, "", block.timestamp + 1, hex"00");
        vm.expectRevert(LeaderboardV2.InvalidName.selector);
        lb.submitScore(id, 100, "123456789012345678901234567890123", block.timestamp + 1, hex"00");
        vm.stopPrank();
    }

    // ------------------------------------------------------------- minting
    function test_NoPublicMintPath() public {
        // v1 had mintReward(address,uint256) with no access control. v2 has no such function.
        (bool ok,) = address(lb).call(abi.encodeWithSignature("mintReward(address,uint256)", alice, 1000));
        assertFalse(ok);
        bytes32 role = ast.MINTER_ROLE();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        ast.mint(alice, 1);
    }

    function test_PerGameRewardCap() public {
        vm.prank(owner);
        lb.setScoreRules(5, 1000, 1_000_000);
        _play(alice, 90_000, 120); // 900 + 150 bonus, capped at 500
        assertEq(ast.balanceOf(alice), 500e18);
    }

    function test_DailyMintCapAndReset() public {
        vm.prank(owner);
        lb.setRewardRules(100, 50, 100, 500, 200); // 200 AST/day total
        _play(alice, 1200, 120); // wants 162
        _play(bob, 1300, 120); // wants 163, only 38 left
        assertEq(ast.balanceOf(alice), 162e18);
        assertEq(ast.balanceOf(bob), 38e18);
        _play(bob, 100, 60); // cap reached: score recorded, no AST
        assertEq(ast.balanceOf(bob), 38e18);
        assertEq(lb.topScoresLength(), 3);
        vm.warp(block.timestamp + 1 days);
        _play(bob, 100, 60);
        assertEq(ast.balanceOf(bob), 39e18);
    }

    function test_MissingMinterRoleStillRecordsScore() public {
        bytes32 role = ast.MINTER_ROLE();
        vm.prank(owner);
        ast.revokeRole(role, address(lb));
        _play(alice, 1200, 120);
        assertEq(ast.balanceOf(alice), 0);
        assertEq(lb.topScoresLength(), 1);
        assertEq(lb.mintedToday(), 0);
    }

    // --------------------------------------------------------- free lives
    function test_DailyLivesCooldown() public {
        vm.prank(alice);
        lb.claimDailyLives();
        assertEq(lb.playerLives(alice), 1);
        vm.warp(block.timestamp + 1 days - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LeaderboardV2.DailyNotReady.selector, block.timestamp + 1));
        lb.claimDailyLives();
        vm.warp(block.timestamp + 1);
        vm.prank(alice);
        lb.claimDailyLives();
        assertEq(lb.playerLives(alice), 2);
    }

    function test_LifeGrantOnceOnly() public {
        uint256 dl = block.timestamp + 600;
        bytes memory sig = _sign(signerKey, lb.grantDigest(alice, 3, 42, dl));
        vm.prank(bob);
        vm.expectRevert(LeaderboardV2.BadSignature.selector);
        lb.claimLifeGrant(3, 42, dl, sig);
        vm.prank(alice);
        lb.claimLifeGrant(3, 42, dl, sig);
        assertEq(lb.playerLives(alice), 3);
        vm.prank(alice);
        vm.expectRevert(LeaderboardV2.GrantUsed.selector);
        lb.claimLifeGrant(3, 42, dl, sig);
        vm.prank(alice);
        vm.expectRevert(LeaderboardV2.InvalidAmount.selector);
        lb.claimLifeGrant(11, 43, dl, sig);
    }

    // ---------------------------------------------------------------- owner
    function test_OnlyOwner() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
        vm.startPrank(alice);
        vm.expectRevert(err);
        lb.setScoreSigner(alice);
        vm.expectRevert(err);
        lb.awardFreeLives(alice, 5);
        vm.expectRevert(err);
        lb.withdraw(address(usdc), alice, 1);
        vm.expectRevert(err);
        lb.setPackPrice(10, 1);
        vm.expectRevert(err);
        lb.pause();
        uint256[20] memory none;
        vm.expectRevert(err);
        lb.endSeason(none);
        vm.stopPrank();
    }

    function test_OwnerWithdrawWorksEvenWhenPaused() public {
        _buy(alice, 50);
        vm.startPrank(owner);
        lb.pause();
        lb.withdraw(address(usdc), owner, 4_500_000);
        vm.stopPrank();
        assertEq(usdc.balanceOf(owner), 4_500_000);
        assertEq(usdc.balanceOf(address(lb)), 0);
    }

    function test_PauseBlocksPlay() public {
        vm.prank(owner);
        lb.pause();
        vm.startPrank(alice);
        usdc.approve(address(lb), 100_000);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        lb.buyLives(1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        lb.claimDailyLives();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        lb.startGame();
        vm.stopPrank();
    }

    function test_RenounceDisabledAndTwoStepTransfer() public {
        vm.prank(owner);
        vm.expectRevert(LeaderboardV2.RenounceDisabled.selector);
        lb.renounceOwnership();
        vm.prank(owner);
        lb.transferOwnership(bob);
        assertEq(lb.owner(), owner);
        vm.prank(bob);
        lb.acceptOwnership();
        assertEq(lb.owner(), bob);
    }

    function test_EndSeasonPaysTopTenAndResets() public {
        address[12] memory players;
        for (uint256 i = 0; i < 12; i++) {
            players[i] = address(uint160(0x1000 + i));
            usdc.mint(players[i], 1e6);
            _play(players[i], 100 * (i + 1), 60); // player 11 best
        }
        uint256 pot = usdc.balanceOf(address(lb)); // 12 * $0.10
        assertEq(pot, 1_200_000);
        uint256 pool = pot * 6000 / 10_000;
        uint256[20] memory astPrize;
        astPrize[0] = 5000;
        astPrize[1] = 3000;
        uint256 firstAstBefore = ast.balanceOf(players[11]);
        vm.prank(owner);
        lb.endSeason(astPrize);
        assertEq(usdc.balanceOf(players[11]), 1e6 - 100_000 + pool * 32 / 100);
        assertEq(usdc.balanceOf(players[10]), 1e6 - 100_000 + pool * 19 / 100);
        assertEq(usdc.balanceOf(players[2]), 1e6 - 100_000 + pool * 6 / 100); // 10th place
        assertEq(usdc.balanceOf(players[1]), 1e6 - 100_000); // 11th place: no USDC
        assertEq(ast.balanceOf(players[11]) - firstAstBefore, 5000e18);
        assertEq(lb.topScoresLength(), 0);
        assertEq(lb.season(), 2);
        assertEq(usdc.balanceOf(address(lb)), pot - pool);
    }

    function test_WorstCaseInsertGas() public {
        vm.startPrank(owner);
        lb.setScoreRules(1, 1_000_000, 1_000_000);
        vm.stopPrank();
        for (uint256 i = 0; i < 100; i++) {
            address p = address(uint160(0x5000 + i));
            vm.prank(owner);
            lb.awardFreeLives(p, 1);
            vm.prank(p);
            uint256 id = lb.startGame();
            vm.warp(block.timestamp + 1);
            bytes memory s1 = _scoreSig(p, id, 10, "x", block.timestamp + 10);
            vm.prank(p);
            lb.submitScore(id, 10, "x", block.timestamp + 10, s1);
        }
        // new #1 on a full board shifts all 100 entries
        vm.prank(owner);
        lb.awardFreeLives(alice, 1);
        vm.prank(alice);
        uint256 gid = lb.startGame();
        vm.warp(block.timestamp + 60);
        uint256 dl = block.timestamp + 10;
        bytes memory sig = _scoreSig(alice, gid, 1000, "pilot", dl);
        vm.prank(alice);
        uint256 g0 = gasleft();
        lb.submitScore(gid, 1000, "pilot", dl, sig);
        uint256 used = g0 - gasleft();
        emit log_named_uint("worst-case submitScore gas", used);
        assertLt(used, 1_000_000);
        assertEq(lb.getTopScores(1)[0].player, alice);
    }

    // ------------------------------------------------------------- sorting
    function testFuzz_TopListStaysSortedAndCapped(uint256 seed) public {
        vm.startPrank(owner);
        lb.setScoreRules(1, 1_000_000, 1_000_000);
        lb.setRewardRules(100, 0, 0, 0, 0); // no minting, keeps the fuzz fast
        vm.stopPrank();
        for (uint256 i = 0; i < 110; i++) {
            address p = address(uint160(uint256(keccak256(abi.encode(seed, i)))) | 1);
            vm.prank(owner);
            lb.awardFreeLives(p, 1);
            uint256 score = (uint256(keccak256(abi.encode(seed, i, "s"))) % 100_000) + 1;
            vm.prank(p);
            uint256 id = lb.startGame();
            vm.warp(block.timestamp + 1);
            uint256 dl = block.timestamp + 10;
            bytes memory sig = _scoreSig(p, id, score, "x", dl);
            vm.prank(p);
            lb.submitScore(id, score, "x", dl, sig);
        }
        LeaderboardV2.ScoreView[] memory top = lb.getTopScores(200);
        assertEq(top.length, 100);
        for (uint256 i = 1; i < top.length; i++) {
            assertGe(top[i - 1].score, top[i].score);
        }
    }
}
