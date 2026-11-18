// Regression: per-game state must reset on every start, including "Play Again (1 Life)".
// Bug (Nov 18 2026): score/misses/shields carried over between games, so game 2 started at Missed 3/3
// with game 1's score, ended on the first miss, and /api/score rejected "score too high for game length".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { checkPlausible } from "../guards.js";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const resetSrc = html.match(/function resetRoundState\(scene\) \{[\s\S]*?\n    \}/)?.[0];

function makeGroup(n) {
  return { n, clear(fromScene, destroy) { assert.equal(fromScene, true); assert.equal(destroy, true); this.n = 0; } };
}

test("resetRoundState clears score, misses, shields, leftover sprites and old timers", () => {
  assert.ok(resetSrc, "resetRoundState missing from index.html");
  const removed = [];
  const timer = (name) => ({ remove: () => removed.push(name) });
  const ctx = {
    MAX_SHIELDS: 3, score: 36, misses: 3, shields: 1, speedMultiplier: 1.6, canShoot: false,
    asteroids: makeGroup(4), lazerGroup: makeGroup(2), shown: 0,
    updateScoreDisplay() { this.shown++; },
  };
  vm.createContext(ctx);
  // run with the page's globals as context vars
  vm.runInContext(`${resetSrc.replace("updateScoreDisplay()", "updateScoreDisplay.call(this)")}
    var scene = { spawnTimer: T("spawn"), shootTimer: T("shoot") };
    resetRoundState(scene); var sceneAfter = scene;`, Object.assign(ctx, { T: timer }));
  assert.equal(ctx.score, 0);
  assert.equal(ctx.misses, 0);
  assert.equal(ctx.shields, 3);
  assert.equal(ctx.speedMultiplier, 1.0);
  assert.equal(ctx.canShoot, true);
  assert.equal(ctx.asteroids.n, 0);
  assert.equal(ctx.lazerGroup.n, 0);
  assert.deepEqual(removed.sort(), ["shoot", "spawn"]);
  assert.equal(ctx.sceneAfter.spawnTimer, null);
  assert.equal(ctx.sceneAfter.shootTimer, null);
  assert.equal(ctx.shown, 1);
});

test("the start flow (shared by Start Game and Play Again) resets state before the countdown", () => {
  const start = html.match(/startButton\.addEventListener\("click", async \(\) => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(start, "start handler missing");
  const reset = start.indexOf("resetRoundState(sceneInstance)");
  const countdown = start.indexOf('countdownText.setText("GO!")');
  assert.ok(reset > 0 && reset < countdown, "resetRoundState must run before the countdown");
  // Play Again must keep going through the same start handler (new on-chain game + new session).
  assert.match(html, /getElementById\("play-again-btn"\)\.addEventListener\("click", \(\) => \{[\s\S]*?sb\.click\(\);/);
});

test("anti-cheat still meaningful: a fresh short game passes, a carried-over score in a short game fails", () => {
  // Fresh 20 s game (incl. 3.8 s countdown) with 4 hits = 48 points: fine.
  checkPlausible({ score: 48, chainElapsedSec: 20, serverElapsedMs: 20_000, maxPointsPerSecond: 20 });
  // What the bug sent: 48 points after a ~5 s game that ended on the first miss.
  assert.throws(() => checkPlausible({ score: 48, chainElapsedSec: 5, serverElapsedMs: 5_000, maxPointsPerSecond: 20 }), /too high for game length/);
});
