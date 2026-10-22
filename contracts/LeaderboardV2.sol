// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev The deployed AsteroidToken (AST) exposes mint(address,uint256) gated by MINTER_ROLE.
interface IMintableERC20 {
    function mint(address to, uint256 amount) external;
}

/// @title Asteroid Shooter Leaderboard v2
/// @notice Lives, server-signed scores, AST rewards and a USDC prize pot.
///
/// Security model (what changed from v1):
///  - Scores are only accepted with an EIP-712 signature from `scoreSigner` (a backend key).
///    Each signature is bound to (player, gameId, score, name, deadline). A game id is created
///    on-chain by startGame() and can be submitted exactly once, so signatures cannot be replayed.
///  - The contract also refuses scores that are impossible for the time since startGame()
///    (score > elapsed seconds * maxPointsPerSecond), even if the signer key were misused.
///  - There is no public mint path. AST is minted only as a reward for a valid signed score,
///    capped per game and per UTC day (limits the damage of a leaked signer key).
///  - Free lives: any player can claim `dailyLives` once per `dailyCooldown`; extra lives
///    (tasks, promos) need a one-time signer grant. The owner can still award lives.
///  - Life packs are priced per pack, so the contract charges exactly what the UI shows.
///  - The owner can withdraw USDC, pay out a season, and pause everything. Ownership uses a
///    two-step transfer and cannot be renounced, so the pot can never be orphaned.
///  - Token and USDC addresses are immutable and must be contracts at deploy time
///    (v1 was deployed pointing at an address with no code, which broke every score).
contract LeaderboardV2 is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- types
    struct Entry {
        address player;
        uint96 score;
    }

    struct ScoreView {
        address player;
        uint256 score;
        string playerName;
    }

    struct Game {
        uint64 startedAt;
        bool submitted;
    }

    // ------------------------------------------------------------ constants
    bytes32 public constant SCORE_TYPEHASH =
        keccak256("Score(address player,uint256 gameId,uint256 score,bytes32 nameHash,uint256 deadline)");
    bytes32 public constant GRANT_TYPEHASH =
        keccak256("LifeGrant(address player,uint256 amount,uint256 grantId,uint256 deadline)");

    uint256 public constant MAX_SCORES = 100;
    uint256 public constant MAX_NAME_BYTES = 32;
    uint256 public constant MAX_GRANT_LIVES = 10;

    // ------------------------------------------------------------ immutables
    IERC20 public immutable usdc;
    IMintableERC20 public immutable token;

    // ---------------------------------------------------------------- state
    address public scoreSigner;

    Entry[] internal _top; // sorted, highest first, at most MAX_SCORES
    mapping(address => string) public playerName;
    mapping(address => uint256) public playerLives;
    mapping(address => uint256) public playerHighScore;
    uint256 public allTimeHigh;

    mapping(address => uint256) public gamesStarted; // last game id per player (ids start at 1)
    mapping(address => mapping(uint256 => Game)) public games;

    mapping(address => uint256) public lastDailyClaim;
    mapping(address => mapping(uint256 => bool)) public grantUsed;

    /// @notice USDC price (6 decimals) of a pack of `lives` lives. 0 = pack not for sale.
    mapping(uint256 => uint256) public packPrice;

    // Rules (owner-tunable)
    uint256 public dailyCooldown = 1 days;
    uint256 public dailyLives = 1;
    uint256 public minGameSeconds = 5;
    uint256 public maxPointsPerSecond = 20; // current game: 12 pts per hit, ~0.83 asteroids/s
    uint256 public maxScore = 1_000_000;

    // Rewards in whole AST (token has 18 decimals)
    uint256 public pointsPerAst = 100;
    uint256 public personalBestBonus = 50;
    uint256 public allTimeHighBonus = 100;
    uint256 public maxAstPerGame = 500;
    uint256 public dailyMintCap = 50_000; // whole AST per UTC day, across all players
    uint256 public mintedToday; // in wei
    uint256 public mintDay;

    // Seasons / prizes
    uint256 public season = 1;
    uint256 public seasonStartedAt;
    uint256 public prizeShareBps = 6000; // share of the USDC pot paid to the top 10 at season end

    // --------------------------------------------------------------- events
    event GameStarted(address indexed player, uint256 indexed gameId, uint256 livesLeft);
    event ScoreSubmitted(address indexed player, uint256 indexed gameId, uint256 score, uint256 astReward, string name);
    event ATHBeaten(address indexed player, uint256 score);
    event RewardMintFailed(address indexed player, uint256 amount);
    event LivesBought(address indexed player, uint256 lives, uint256 usdcPaid);
    event DailyLivesClaimed(address indexed player, uint256 lives);
    event LivesGranted(address indexed player, uint256 lives, uint256 grantId);
    event LivesAwarded(address indexed player, uint256 lives);
    event ScoreSignerUpdated(address indexed signer);
    event PackPriceUpdated(uint256 indexed lives, uint256 price);
    event RulesUpdated();
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event SeasonEnded(uint256 indexed season, uint256 prizePool, uint256 entries);

    // --------------------------------------------------------------- errors
    error ZeroAddress();
    error NotAContract(address account);
    error InvalidName();
    error InvalidAmount();
    error PackNotForSale(uint256 lives);
    error NoLives();
    error UnknownGame();
    error AlreadySubmitted();
    error Expired();
    error BadSignature();
    error SignerNotSet();
    error ScoreTooFast(uint256 score, uint256 maxAllowed);
    error GameTooShort();
    error ScoreTooHigh();
    error DailyNotReady(uint256 availableAt);
    error GrantUsed();
    error RenounceDisabled();

    constructor(address usdc_, address token_, address owner_, address signer_)
        Ownable(owner_)
        EIP712("AsteroidShooterLeaderboard", "2")
    {
        if (usdc_ == address(0) || token_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (usdc_.code.length == 0) revert NotAContract(usdc_);
        if (token_.code.length == 0) revert NotAContract(token_);
        usdc = IERC20(usdc_);
        token = IMintableERC20(token_);
        scoreSigner = signer_; // may be zero at deploy; scores are refused until it is set
        seasonStartedAt = block.timestamp;

        // Same prices the UI shows: $0.10 each, 10% off for packs of 10+.
        _setPackPrice(1, 100_000);
        _setPackPrice(10, 900_000);
        _setPackPrice(25, 2_250_000);
        _setPackPrice(50, 4_500_000);
    }

    // ============================================================== players

    /// @notice Spend one life and open a game. The returned id is what the backend signs.
    function startGame() external whenNotPaused returns (uint256 gameId) {
        uint256 lives = playerLives[msg.sender];
        if (lives == 0) revert NoLives();
        unchecked {
            playerLives[msg.sender] = lives - 1;
        }
        gameId = ++gamesStarted[msg.sender];
        games[msg.sender][gameId] = Game({startedAt: uint64(block.timestamp), submitted: false});
        emit GameStarted(msg.sender, gameId, lives - 1);
    }

    /// @notice Record a score that the backend signed for this player and game.
    function submitScore(
        uint256 gameId,
        uint256 score,
        string calldata name,
        uint256 deadline,
        bytes calldata signature
    ) external whenNotPaused nonReentrant {
        uint256 nameLen = bytes(name).length;
        if (nameLen == 0 || nameLen > MAX_NAME_BYTES) revert InvalidName();
        if (score == 0) revert InvalidAmount();
        if (score > maxScore) revert ScoreTooHigh();
        if (block.timestamp > deadline) revert Expired();

        Game storage g = games[msg.sender][gameId];
        _checkGame(g, score);
        _checkSigner(
            keccak256(abi.encode(SCORE_TYPEHASH, msg.sender, gameId, score, keccak256(bytes(name)), deadline)),
            signature
        );

        g.submitted = true;
        playerName[msg.sender] = name;
        _insert(msg.sender, score);
        uint256 minted = _reward(msg.sender, score);
        emit ScoreSubmitted(msg.sender, gameId, score, minted, name);
    }

    /// @notice Pay USDC for a pack of lives. Approve exactly packPrice(lives) first.
    function buyLives(uint256 lives) external whenNotPaused nonReentrant {
        uint256 price = packPrice[lives];
        if (price == 0) revert PackNotForSale(lives);
        usdc.safeTransferFrom(msg.sender, address(this), price);
        playerLives[msg.sender] += lives;
        emit LivesBought(msg.sender, lives, price);
    }

    /// @notice Free lives, once per cooldown, for any wallet.
    function claimDailyLives() external whenNotPaused {
        uint256 next = nextDailyClaimAt(msg.sender);
        if (block.timestamp < next) revert DailyNotReady(next);
        lastDailyClaim[msg.sender] = block.timestamp;
        playerLives[msg.sender] += dailyLives;
        emit DailyLivesClaimed(msg.sender, dailyLives);
    }

    /// @notice Extra free lives authorised by the backend (tasks, promos). Each grant id works once.
    function claimLifeGrant(uint256 amount, uint256 grantId, uint256 deadline, bytes calldata signature)
        external
        whenNotPaused
    {
        if (amount == 0 || amount > MAX_GRANT_LIVES) revert InvalidAmount();
        if (block.timestamp > deadline) revert Expired();
        if (grantUsed[msg.sender][grantId]) revert GrantUsed();
        _checkSigner(keccak256(abi.encode(GRANT_TYPEHASH, msg.sender, amount, grantId, deadline)), signature);
        grantUsed[msg.sender][grantId] = true;
        playerLives[msg.sender] += amount;
        emit LivesGranted(msg.sender, amount, grantId);
    }

    // ================================================================ views

    function getTopScores(uint256 count) external view returns (ScoreView[] memory list) {
        uint256 len = count > _top.length ? _top.length : count;
        list = new ScoreView[](len);
        for (uint256 i = 0; i < len; i++) {
            Entry memory e = _top[i];
            list[i] = ScoreView(e.player, e.score, playerName[e.player]);
        }
    }

    function topScoresLength() external view returns (uint256) {
        return _top.length;
    }

    /// @notice v1-compatible single life price (price of a 1-life pack).
    function lifePrice() external view returns (uint256) {
        return packPrice[1];
    }

    function nextDailyClaimAt(address player) public view returns (uint256) {
        uint256 last = lastDailyClaim[player];
        return last == 0 ? 0 : last + dailyCooldown;
    }

    function prizePot() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice EIP-712 digest the backend signs for a score (exposed for tests and tooling).
    function scoreDigest(address player, uint256 gameId, uint256 score, string calldata name, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(SCORE_TYPEHASH, player, gameId, score, keccak256(bytes(name)), deadline))
        );
    }

    function grantDigest(address player, uint256 amount, uint256 grantId, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(GRANT_TYPEHASH, player, amount, grantId, deadline)));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ================================================================ owner

    function setScoreSigner(address signer_) external onlyOwner {
        scoreSigner = signer_; // zero disables scores and grants
        emit ScoreSignerUpdated(signer_);
    }

    function setPackPrice(uint256 lives, uint256 price) external onlyOwner {
        if (lives == 0) revert InvalidAmount();
        _setPackPrice(lives, price);
    }

    function setLifeRules(uint256 dailyCooldown_, uint256 dailyLives_) external onlyOwner {
        if (dailyLives_ > MAX_GRANT_LIVES) revert InvalidAmount();
        dailyCooldown = dailyCooldown_;
        dailyLives = dailyLives_;
        emit RulesUpdated();
    }

    function setScoreRules(uint256 minGameSeconds_, uint256 maxPointsPerSecond_, uint256 maxScore_) external onlyOwner {
        if (maxScore_ > type(uint96).max) revert InvalidAmount();
        minGameSeconds = minGameSeconds_;
        maxPointsPerSecond = maxPointsPerSecond_;
        maxScore = maxScore_;
        emit RulesUpdated();
    }

    function setRewardRules(
        uint256 pointsPerAst_,
        uint256 personalBestBonus_,
        uint256 allTimeHighBonus_,
        uint256 maxAstPerGame_,
        uint256 dailyMintCap_
    ) external onlyOwner {
        if (pointsPerAst_ == 0) revert InvalidAmount();
        pointsPerAst = pointsPerAst_;
        personalBestBonus = personalBestBonus_;
        allTimeHighBonus = allTimeHighBonus_;
        maxAstPerGame = maxAstPerGame_;
        dailyMintCap = dailyMintCap_;
        emit RulesUpdated();
    }

    function setPrizeShareBps(uint256 bps) external onlyOwner {
        if (bps > 10_000) revert InvalidAmount();
        prizeShareBps = bps;
        emit RulesUpdated();
    }

    function awardFreeLives(address player, uint256 lives) external onlyOwner {
        if (player == address(0)) revert ZeroAddress();
        if (lives == 0) revert InvalidAmount();
        playerLives[player] += lives;
        emit LivesAwarded(player, lives);
    }

    /// @notice Withdraw USDC (or any token sent here by mistake). Works while paused.
    function withdraw(address erc20, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        IERC20(erc20).safeTransfer(to, amount);
        emit Withdrawn(erc20, to, amount);
    }

    /// @notice Close the season: pay prizeShareBps of the pot to the top 10 and reset the board.
    /// Owner-only so the top of the board can be reviewed for cheating before money moves.
    /// The rest of the pot stays in the contract (withdraw it or roll it into the next season).
    /// @param seasonAst Whole AST minted to the top 20 (index 0 = 1st). Use zeros to skip.
    function endSeason(uint256[20] calldata seasonAst) external onlyOwner nonReentrant {
        uint256 pot = usdc.balanceOf(address(this));
        uint256 pool = pot * prizeShareBps / 10_000;
        uint16[10] memory pct = [uint16(32), 19, 13, 5, 5, 5, 5, 5, 5, 6];
        uint256 n = _top.length;

        address[20] memory winners;
        for (uint256 i = 0; i < 20 && i < n; i++) {
            winners[i] = _top[i].player;
        }
        delete _top;
        uint256 ended = season;
        season = ended + 1;
        seasonStartedAt = block.timestamp;

        for (uint256 i = 0; i < 10 && i < n; i++) {
            uint256 share = pool * pct[i] / 100;
            if (share > 0) usdc.safeTransfer(winners[i], share);
        }
        for (uint256 i = 0; i < 20 && i < n; i++) {
            if (seasonAst[i] > 0) _mintUncapped(winners[i], seasonAst[i] * 1e18);
        }
        emit SeasonEnded(ended, pool, n);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ============================================================= internal

    function _checkGame(Game storage g, uint256 score) internal view {
        if (g.startedAt == 0) revert UnknownGame();
        if (g.submitted) revert AlreadySubmitted();
        uint256 elapsed = block.timestamp - g.startedAt;
        if (elapsed < minGameSeconds) revert GameTooShort();
        uint256 cap = elapsed * maxPointsPerSecond;
        if (score > cap) revert ScoreTooFast(score, cap);
    }

    function _checkSigner(bytes32 structHash, bytes calldata signature) internal view {
        address signer = scoreSigner;
        if (signer == address(0)) revert SignerNotSet();
        if (ECDSA.recover(_hashTypedDataV4(structHash), signature) != signer) revert BadSignature();
    }

    function _reward(address player, uint256 score) internal returns (uint256) {
        uint256 reward = score / pointsPerAst;
        if (score > playerHighScore[player]) {
            playerHighScore[player] = score;
            reward += personalBestBonus;
        }
        if (score > allTimeHigh) {
            allTimeHigh = score;
            reward += allTimeHighBonus;
            emit ATHBeaten(player, score);
        }
        if (reward > maxAstPerGame) reward = maxAstPerGame;
        return _mintCapped(player, reward * 1e18);
    }

    function _setPackPrice(uint256 lives, uint256 price) internal {
        packPrice[lives] = price;
        emit PackPriceUpdated(lives, price);
    }

    /// @dev Keeps _top sorted (highest first, ties keep the earlier entry ahead), max MAX_SCORES.
    function _insert(address player, uint256 score) internal {
        uint256 n = _top.length;
        uint256 i;
        if (n < MAX_SCORES) {
            _top.push();
            i = n;
        } else {
            if (score <= _top[n - 1].score) return;
            i = n - 1;
        }
        while (i > 0 && _top[i - 1].score < score) {
            _top[i] = _top[i - 1];
            unchecked {
                --i;
            }
        }
        // casting to uint96 is safe: score <= maxScore <= type(uint96).max (enforced in setScoreRules)
        // forge-lint: disable-next-line(unsafe-typecast)
        _top[i] = Entry(player, uint96(score));
    }

    function _mintCapped(address to, uint256 amount) internal returns (uint256) {
        if (amount == 0) return 0;
        uint256 today = block.timestamp / 1 days;
        if (today != mintDay) {
            mintDay = today;
            mintedToday = 0;
        }
        uint256 capWei = dailyMintCap * 1e18;
        uint256 room = capWei > mintedToday ? capWei - mintedToday : 0;
        if (amount > room) amount = room;
        if (amount == 0) return 0;
        if (!_tryMint(to, amount)) return 0;
        mintedToday += amount;
        return amount;
    }

    function _mintUncapped(address to, uint256 amount) internal {
        _tryMint(to, amount);
    }

    /// @dev A missing MINTER_ROLE must not block score recording; it emits RewardMintFailed instead.
    function _tryMint(address to, uint256 amount) internal returns (bool ok) {
        try token.mint(to, amount) {
            ok = true;
        } catch {
            emit RewardMintFailed(to, amount);
        }
    }
}
