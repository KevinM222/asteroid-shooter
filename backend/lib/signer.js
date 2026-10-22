// Shared logic for the score-signing backend (DRAFT, not deployed).
// Keep this file free of Vercel specifics so it can be unit-tested with plain node.
import { Contract, JsonRpcProvider, Wallet, getAddress, isAddress, keccak256, toUtf8Bytes } from "ethers";

export const LEADERBOARD_ABI = [
  "function games(address,uint256) view returns (uint64 startedAt, bool submitted)",
  "function minGameSeconds() view returns (uint256)",
  "function maxPointsPerSecond() view returns (uint256)",
  "function maxScore() view returns (uint256)",
  "function scoreSigner() view returns (address)",
  "function paused() view returns (bool)",
];

export const SCORE_TYPES = {
  Score: [
    { name: "player", type: "address" },
    { name: "gameId", type: "uint256" },
    { name: "score", type: "uint256" },
    { name: "nameHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

export const GRANT_TYPES = {
  LifeGrant: [
    { name: "player", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "grantId", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export function domain(chainId, verifyingContract) {
  return { name: "AsteroidShooterLeaderboard", version: "2", chainId, verifyingContract };
}

// Game rules mirrored from index.html. Update if gameplay scoring changes.
export const POINTS_PER_HIT = 12;
export const SIGNATURE_TTL_SECONDS = 300;
export const MAX_NAME_BYTES = 32;

export class RejectError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function cleanName(name) {
  if (typeof name !== "string") throw new RejectError(400, "name must be a string");
  // printable characters only; the contract caps names at 32 bytes
  const s = name.replace(/[\u0000-\u001f\u007f<>]/g, "").trim();
  if (!s || new TextEncoder().encode(s).length > MAX_NAME_BYTES) throw new RejectError(400, "bad name");
  return s;
}

/**
 * Plausibility checks + EIP-712 signature for one finished game.
 * @param {object} req { player, gameId, score, name }
 * @param {object} cfg { provider, wallet, leaderboard, chainId, now? }
 */
export async function signScore(req, cfg) {
  const { provider, wallet, leaderboard, chainId } = cfg;
  if (!isAddress(req.player)) throw new RejectError(400, "bad player");
  const player = getAddress(req.player);
  const gameId = BigInt(req.gameId);
  const score = BigInt(req.score);
  const name = cleanName(req.name);
  if (gameId <= 0n) throw new RejectError(400, "bad gameId");
  if (score <= 0n) throw new RejectError(400, "bad score");
  if (score % BigInt(POINTS_PER_HIT) !== 0n) throw new RejectError(422, "score is not a multiple of points per hit");

  const lb = new Contract(leaderboard, LEADERBOARD_ABI, provider);
  const [game, minSecs, maxPps, maxScore, onchainSigner, paused, block] = await Promise.all([
    lb.games(player, gameId),
    lb.minGameSeconds(),
    lb.maxPointsPerSecond(),
    lb.maxScore(),
    lb.scoreSigner(),
    lb.paused(),
    provider.getBlock("latest"),
  ]);
  if (paused) throw new RejectError(503, "leaderboard paused");
  if (getAddress(onchainSigner) !== wallet.address) throw new RejectError(500, "signer key does not match contract");
  if (game.startedAt === 0n) throw new RejectError(404, "game not started on-chain");
  if (game.submitted) throw new RejectError(409, "game already submitted");
  if (score > maxScore) throw new RejectError(422, "score too high");

  const now = BigInt(cfg.now ?? block.timestamp);
  const elapsed = now - game.startedAt;
  if (elapsed < minSecs) throw new RejectError(422, "game too short");
  // Same ceiling the contract enforces; the backend can be stricter than the chain.
  if (score > elapsed * maxPps) throw new RejectError(422, "score too high for game length");

  const deadline = now + BigInt(SIGNATURE_TTL_SECONDS);
  const nameHash = keccak256(toUtf8Bytes(name));
  const value = { player, gameId, score, nameHash, deadline };
  const signature = await wallet.signTypedData(domain(chainId, leaderboard), SCORE_TYPES, value);
  return { player, gameId: gameId.toString(), score: score.toString(), name, deadline: deadline.toString(), signature };
}

export function loadConfig(env = process.env) {
  const key = env.SCORE_SIGNER_PRIVATE_KEY;
  const leaderboard = env.LEADERBOARD_V2_ADDRESS;
  if (!key || !leaderboard) throw new RejectError(503, "score signing not configured");
  const chainId = Number(env.CHAIN_ID || 8453);
  const provider = new JsonRpcProvider(env.BASE_RPC_URL || "https://mainnet.base.org", chainId, { staticNetwork: true });
  return { provider, wallet: new Wallet(key), leaderboard: getAddress(leaderboard), chainId };
}
