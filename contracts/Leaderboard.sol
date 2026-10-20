// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "./AsteroidToken.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Leaderboard is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    struct Score {
        address player;
        uint256 score;
        string playerName;
    }

    Score[] public scores;
    AsteroidToken public token;
    address public usdcAddress = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // Base mainnet USDC

    uint256 public constant MAX_SCORES = 100;
    mapping(address => uint256) public playerLives;
    mapping(address => uint256) public playerHighScore;
    uint256 public allTimeHigh;
    uint256 public lifePrice = 100000;
    uint256 public lastPayoutTimestamp;

    event ATHBeaten(address indexed player, uint256 score);
    event LivesBought(address indexed player, uint256 amount);

    constructor(address _tokenAddress) Ownable(msg.sender) {
        require(_tokenAddress != address(0), "Invalid token");
        token = AsteroidToken(_tokenAddress);
        lastPayoutTimestamp = block.timestamp;
    }

    function startGame(string calldata _playerName) external nonReentrant {
        require(bytes(_playerName).length > 0 && bytes(_playerName).length <= 32, "Invalid name");
        if (playerLives[msg.sender] > 0) playerLives[msg.sender]--;
    }

    function submitScore(uint256 _score, string calldata _playerName) external nonReentrant {
        require(_score > 0, "Score must be positive");
        require(bytes(_playerName).length > 0 && bytes(_playerName).length <= 32, "Invalid name");
        scores.push(Score(msg.sender, _score, _playerName));
        uint256 i = scores.length - 1;
        Score memory newScore = scores[i];
        uint256 maxIterations = 50;
        uint256 iterations = 0;
        while (i > 0 && scores[i - 1].score < newScore.score && iterations < maxIterations) {
            scores[i] = scores[i - 1];
            i--;
            iterations++;
        }
        scores[i] = newScore;
        if (scores.length > MAX_SCORES) scores.pop();
        if (_score >= 100) {
            token.mint(msg.sender, (_score / 100) * 1e18);
        }
        if (_score > playerHighScore[msg.sender]) {
            playerHighScore[msg.sender] = _score;
            token.mint(msg.sender, 50 * 1e18);
        }
        if (_score > allTimeHigh) {
            allTimeHigh = _score;
            emit ATHBeaten(msg.sender, _score);
            token.mint(msg.sender, 100 * 1e18);
        }
    }

    function mintReward(address player, uint256 amount) external nonReentrant {
        require(player != address(0), "Invalid player");
        token.mint(player, amount * 1e18);
    }

    function buyLives(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be positive");
        uint256 cost = amount * lifePrice;
        IERC20(usdcAddress).safeTransferFrom(msg.sender, address(this), cost);
        playerLives[msg.sender] += amount;
        emit LivesBought(msg.sender, amount);
    }

    function awardFreeLives(address player, uint256 amount) external onlyOwner {
        require(amount > 0, "Amount must be positive");
        playerLives[player] += amount;
    }

    function getTopScores(uint256 count) external view returns (Score[] memory) {
        uint256 len = count > scores.length ? scores.length : count;
        Score[] memory top = new Score[](len);
        for (uint i = 0; i < len; i++) {
            top[i] = scores[i];
        }
        return top;
    }

    function hasFreeGame(address) external pure returns (bool) {
        return true;
    }

    address public chainlinkRegistry = 0x86C369E074F93eE3DE67e5b4F536d85B79bc0fD6; // Fixed checksum

    function _distributePrizes() internal {
        require(block.timestamp >= lastPayoutTimestamp + 30 days, "Too soon");
        require(scores.length >= 20, "Not enough scores");

        uint256 totalPot = IERC20(usdcAddress).balanceOf(address(this));
        if (totalPot == 0) {
            lastPayoutTimestamp = block.timestamp;
            return;
        }

        uint256 prizeAmount = totalPot * 60 / 100;

        uint256[10] memory usdcPercents = [uint256(32), uint256(19), uint256(13), uint256(5), uint256(5), uint256(5), uint256(5), uint256(5), uint256(5), uint256(6)];
        uint256[10] memory usdcShares;
        address[10] memory usdcWinners;

        for (uint i = 0; i < 10; i++) {
            usdcShares[i] = prizeAmount * usdcPercents[i] / 100;
            usdcWinners[i] = scores[i].player;
        }

        uint256[20] memory astAmounts = [
            uint256(5000), uint256(3000), uint256(2000), uint256(1000), uint256(1000), uint256(1000), uint256(1000), uint256(1000), uint256(1000), uint256(1000),
            uint256(500), uint256(500), uint256(500), uint256(500), uint256(500), uint256(500), uint256(500), uint256(500), uint256(500), uint256(500)
        ];
        address[20] memory astWinners;
        for (uint i = 0; i < 20 && i < scores.length; i++) {
            astWinners[i] = scores[i].player;
        }

        delete scores;
        lastPayoutTimestamp = block.timestamp;

        for (uint i = 0; i < 10; i++) {
            if (usdcShares[i] > 0) {
                IERC20(usdcAddress).safeTransfer(usdcWinners[i], usdcShares[i]);
            }
        }

        for (uint i = 0; i < 20 && i < astWinners.length; i++) {
            if (astAmounts[i] > 0) {
                token.mint(astWinners[i], astAmounts[i] * 1e18);
            }
        }

        uint256 remaining = IERC20(usdcAddress).balanceOf(address(this));
        if (remaining > 0) {
            IERC20(usdcAddress).safeTransfer(owner(), remaining);
        }
    }

    function performUpkeep(bytes calldata) external {
        require(msg.sender == chainlinkRegistry || msg.sender == owner(), "Only Chainlink or Owner");
        _distributePrizes();
    }

    function updateChainlinkRegistry(address _new) external onlyOwner {
        require(_new != address(0), "Invalid address");
        chainlinkRegistry = _new;
    }

    function updateLifePrice(uint256 _newPrice) external onlyOwner {
        lifePrice = _newPrice;
    }
}