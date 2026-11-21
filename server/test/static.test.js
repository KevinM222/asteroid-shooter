// Guards against drift between index.html and its security headers / self-hosted SDK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("../../", import.meta.url);
const page = readFileSync(new URL("index.html", root), "utf8");
const gameJs = readFileSync(new URL("game.js", root), "utf8"); // the game script, loaded with defer
const html = page + "\n" + gameJs; // content checks below look at both
const vercel = JSON.parse(readFileSync(new URL("vercel.json", root), "utf8"));

test("CSP script hashes match the inline scripts", () => {
  const csp = vercel.headers.flatMap((h) => h.headers).find((h) => /^Content-Security-Policy/.test(h.key) && /script-src/.test(h.value)).value;
  for (const [, body] of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    const h = "sha256-" + createHash("sha256").update(body).digest("base64");
    assert.ok(csp.includes(`'${h}'`), `CSP missing ${h}; update vercel.json`);
  }
});

test("self-hosted mini-app SDK matches its SRI hash (lazy-loaded by game.js)", () => {
  const m = gameJs.match(/const MINIAPP_SDK_SRI = '(sha384-[^']+)'/);
  assert.ok(m, "MINIAPP_SDK_SRI missing");
  const h = "sha384-" + createHash("sha384").update(readFileSync(new URL("vendor/miniapp-sdk.js", root))).digest("base64");
  assert.equal(m[1], h);
});

test("game calls sdk.actions.ready() as soon as a mini-app host is detected", () => {
  const init = gameJs.match(/async function initSdk\(\) \{[\s\S]*?\n    \}/)[0];
  assert.match(init, /fc\.actions\.ready\(\)/);
  assert.ok(init.indexOf("fc.actions.ready()") < init.indexOf("fc.context"), "ready() must come before the context lookup");
});

test("loading perf: deferred scripts in dependency order, SDK lazy-loaded, placeholder, preconnect", () => {
  const order = ["phaser@3.80.1/dist/phaser.min.js", "ethers@6.11.1/dist/ethers.umd.min.js", "/game.js"].map((s) => page.indexOf(s));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], "phaser, ethers, game.js order");
  for (const [tag] of page.matchAll(/<script src="[^"]+"[^>]*>/g)) assert.match(tag, /\bdefer\b/, `not deferred: ${tag}`);
  assert.doesNotMatch(page, /<script src="\/vendor\/miniapp-sdk\.js"/, "SDK must not be a blocking tag");
  assert.match(gameJs, /if \(!window\.ReactNativeWebView && window === window\.parent\) return Promise\.resolve\(null\);/);
  assert.match(page, /<div id="game-loading"[^>]*>Loading game…<\/div>/);
  assert.match(gameJs, /postBoot: \(\) => document\.getElementById\('game-loading'\)\?\.remove\(\)/);
  assert.match(page, /<link rel="preconnect" href="https:\/\/cdn\.jsdelivr\.net" crossorigin/);
  assert.match(page, /icon: '\/assets\/accumulator-96\.png'/);
  assert.match(page, /url: 'https:\/\/accumulator-8\.vercel\.app'/);
});

test("X task: follow-intent link, opened outside the game, never by navigating the game window", () => {
  assert.match(html, /<a data-ext data-task="1" href="https:\/\/x\.com\/intent\/follow\?screen_name=kevinmm8222"/);
  const fn = html.match(/function openOutsideGame\(url\) \{[\s\S]*?\n    \}/)[0];
  assert.match(fn, /sdk\?\.actions\?\.openUrl/);
  assert.match(fn, /window\.open\(url, '_blank'\)/);
  assert.doesNotMatch(fn, /location\.(href|assign|replace)/);
  assert.match(html, /closest\('a\[data-task\]'\);\n\s*if \(!a\) return;\n\s*ev\.preventDefault\(\);/);
});

test("click-through tickets persist in localStorage keyed by wallet + task, with issue time and 1 h TTL", () => {
  assert.match(html, /ast:ticket:\$\{String\(userAddress\)\.toLowerCase\(\)\}:\$\{id\}/);
  assert.match(html, /localStorage\.setItem\(k, JSON\.stringify\(v\)\)/);
  assert.match(html, /issuedAt, readyAt: issuedAt \+/);
  assert.match(html, /TICKET_TTL_MS = 3600 \* 1000/);
});

test("silent reconnect on load uses eth_accounts, never eth_requestAccounts", () => {
  assert.match(html, /method: silent \? "eth_accounts" : "eth_requestAccounts"/);
  assert.match(html, /connectWallet\(true\); \/\/ v5\.13/);
});

test("X button states: countdown text and back-from-X hint", () => {
  assert.match(html, /Claim life \(ready in \$\{left\}s\)/);
  assert.match(html, /id="task-x-hint"[^>]*>Back from X\? Tap Claim Life\./);
});

test("iOS / Coinbase Wallet browser: X app scheme from the game window, https only as a new-window fallback", () => {
  assert.match(html, /X_APP_URLS = \['twitter:\/\/user\?screen_name=kevinmm8222', 'x:\/\/user\?screen_name=kevinmm8222'\]/);
  const ua = html.match(/function useAppScheme\(\) \{[\s\S]*?\n    \}/)[0];
  assert.match(ua, /if \(window\.__inMiniApp\) return false;/); // Base app mini-app path unchanged
  assert.match(ua, /iPhone\|iPad\|iPod/);
  assert.match(ua, /window\.ethereum\?\.isCoinbaseWallet/);
  assert.match(ua, /const walletBrowser = mobile &&/);
  const tr = html.match(/function tryAppSchemes\(urls, httpsUrl\) \{[\s\S]*?\n    \}/)[0];
  assert.match(tr, /if \(!urls\.length\) \{ openOutsideGame\(httpsUrl\); return; \}/);
  assert.match(tr, /location\.href = urls\[0\]/);
  assert.match(tr, /1500\)/);
  // ticket is started and awaited before the app switch
  assert.match(html, /await withTimeout\(startClickTicket\(id\), 4000, 'Task start'\)[\s\S]{0,80}\n\s*tryAppSchemes\(X_APP_URLS, a\.href\);/);
});

test("tilt steering: always on (no toggle), iOS permission asked once from the Start Game tap, calibrated each round, touch wins", () => {
  const start = gameJs.indexOf('startButton.addEventListener("click", async () => {');
  const firstAwait = gameJs.indexOf("await", start);
  const ask = gameJs.indexOf("Tilt.requestOnGesture()", start);
  assert.ok(ask > start && ask < firstAwait, "permission request must run before any await (keeps the iOS user gesture)");
  assert.match(gameJs, /stored === 'denied'\) return/, "a denial is remembered and never re-prompted");
  assert.match(gameJs, /localStorage\.setItem\(KEY, r\)/);
  assert.match(gameJs, /Tilt\.calibrate\(\);[^\n]*\n(?:\s*Awake\.on\(\);[^\n]*\n)?\s*gameplayActive = true;/, "neutral re-calibrated at GO each round");
  assert.match(gameJs, /else if \(!this\._drag\) ship\.x \+= Tilt\.step\(moveSpeed\)/, "a finger on screen overrides tilt; capped at ship speed");
  assert.doesNotMatch(gameJs, /tiltEnabled/, "no toggle");
});

test("tilt off switch lives in the start-screen settings panel, defaults ON, persisted, and stops listening/asking when off", () => {
  assert.match(page, /id="settings-btn"[^>]*aria-controls="settings-panel"/);
  assert.match(page, /<input type="checkbox" id="tilt-setting" checked>/);
  assert.match(gameJs, /localStorage\.getItem\(ON_KEY\) !== '0'/, "unset = ON");
  assert.match(gameJs, /if \(asked \|\| !enabled\(\) \|\| !needsPermission\(\)\) return;/, "no prompt when off");
  assert.match(gameJs, /if \(listening \|\| !enabled\(\)/, "no listener when off");
});

test("tilt drift fix: 5° dead zone, finger release re-levels after a settle window, slow auto-recenter", () => {
  assert.match(gameJs, /const DEAD = 5;/);
  assert.match(gameJs, /this\._drag = null;\s*\n\s*if \(gameplayActive\) Tilt\.settle\(250\);/, "release parks the ship");
  assert.match(gameJs, /calibrate\(\) \{ this\.settle\(200\); \}/, "GO averages ~200 ms of readings");
  assert.match(gameJs, /neutral = settleSum \/ settleN/);
  assert.match(gameJs, /RECENTER_AFTER/);
});

test("daily free life UI: auto-claim message, chain re-read after start and on return, local next/used times", () => {
  assert.match(gameJs, /freeClaimNeeded \? 'Using your free daily life… confirm in wallet'/);
  assert.match(gameJs, /sendAndConfirm\(calls[^\n]*\n\s*refreshDailyFromChain\(\)/, "re-read right after the start/claim confirms");
  assert.match(gameJs, /visibilitychange', \(\) => \{ if \(document\.visibilityState === 'visible'\) refreshDailyFromChain\(\)/);
  assert.match(gameJs, /Next free life: \$\{fmtWhen\(nextDailyAtMs\)\}/);
  assert.match(gameJs, /'function lastDailyClaim\(address\) view returns \(uint256\)'/);
});

test("screen wake lock: on at GO, off at game over / leaving play, re-acquired on return, silent fallback video", () => {
  assert.match(gameJs, /navigator\.wakeLock\.request\('screen'\)/);
  assert.match(gameJs, /Awake\.on\(\);[^\n]*\n\s*gameplayActive = true;/);
  assert.match(gameJs, /gameplayActive = false;\n\s*Awake\.off\(\);/, "released at game over");
  assert.match(gameJs, /function exitPlayMode\(\) \{\n\s*Awake\.off\(\);/);
  assert.match(gameJs, /if \(want && document\.visibilityState === 'visible'\) acquire\(\)/);
  const start = gameJs.indexOf('startButton.addEventListener("click", async () => {');
  const on = gameJs.indexOf("Awake.on()", start);
  assert.ok(on > start && on < gameJs.indexOf("await", start), "wake lock + video started inside the tap, before any await");
  assert.match(gameJs, /const needVideo = \(\) => isIOS \|\| !hasApi\(\) \|\| !!lockErr;/, "video also runs on iOS even when navigator.wakeLock exists");
  assert.match(gameJs, /video\.muted = false;/, "WebKit ignores muted video for display sleep");
  assert.doesNotMatch(gameJs, /video\.loop = true/, "WebKit ignores looping video for display sleep");
  assert.match(gameJs, /addEventListener\('timeupdate'/);
  assert.match(gameJs, /debug=wake/);
  assert.ok(readFileSync(new URL("assets/keepawake.mp4", root)).length < 10000, "fallback video stays tiny");
  assert.match(vercel.headers[0].headers.find((h) => h.key === "Content-Security-Policy-Report-Only").value, /media-src 'self'/);
});

test("sign-in SDKs: self-hosted, SRI-pinned, lazy-loaded only (no new first-load scripts)", () => {
  for (const [name, file] of [["BASE_ACCOUNT_SRI", "vendor/base-account.js"], ["CDP_SRI", "vendor/cdp-embedded.js"]]) {
    const m = gameJs.match(new RegExp(`const ${name} = '(sha384-[^']+)'`));
    assert.ok(m, `${name} missing`);
    const h = "sha384-" + createHash("sha384").update(readFileSync(new URL(file, root))).digest("base64");
    assert.equal(m[1], h, `${file} does not match ${name}; rebuild and update the hash`);
    assert.ok(!page.includes(file), `${file} must not be a first-load script`);
  }
  assert.match(gameJs, /s\.integrity = sri/);
  assert.match(gameJs, /crossOrigin = 'anonymous'/);
  // first-load scripts unchanged vs PR #17
  const srcs = [...page.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.every((s) => !/vendor\/(base-account|cdp-embedded)/.test(s)));
});

test("provider order: injected wallet first, then EIP-6963, then mini-app; chooser only when nothing is available", () => {
  assert.match(gameJs, /chosenProvider \|\| window\.ethereum \|\| eip6963\[0\]\?\.provider \|\| fcProvider/);
  assert.match(gameJs, /function openSignInChooser\(/);
  assert.match(gameJs, /createOnLogin: 'smart'/);
  assert.match(gameJs, /eth_requestAccounts/);
});

test("sign-in chooser + Add funds UI present, hidden in game mode, email/SMS gated on config", () => {
  for (const id of ["add-funds", "add-funds-panel", "fund-usdc5", "fund-usdc10", "fund-eth3", "sign-out-row", "sign-out"]) assert.ok(page.includes(`id="${id}"`), id);
  assert.match(page, /body\.game-mode #add-funds, body\.game-mode #add-funds-panel \{ display: none !important; \}/);
  assert.ok(page.includes('<div class="fund-row"><button id="add-funds"'), "Add funds sits in its own row (the buy row hides when nothing is for sale)");
  assert.match(gameJs, /cdpProjectId/);
  assert.match(gameJs, /\/api\/onramp/);
  assert.match(gameJs, /ast_onramp_pending/);
});

test("CSP allows the CDP / Base Account hosts the lazy SDKs talk to", () => {
  const csp = vercel.headers.flatMap((h) => h.headers).find((h) => /^Content-Security-Policy/.test(h.key) && /script-src/.test(h.value)).value;
  for (const host of ["https://api.cdp.coinbase.com", "https://keys.coinbase.com", "https://secure-wallet.cdp.coinbase.com"]) assert.ok(csp.includes(host), host);
});
