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
