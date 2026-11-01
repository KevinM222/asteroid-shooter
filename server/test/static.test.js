// Guards against drift between index.html and its security headers / self-hosted SDK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("../../", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");
const vercel = JSON.parse(readFileSync(new URL("vercel.json", root), "utf8"));

test("CSP script hashes match the inline scripts", () => {
  const csp = vercel.headers.flatMap((h) => h.headers).find((h) => /^Content-Security-Policy/.test(h.key) && /script-src/.test(h.value)).value;
  for (const [, body] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    const h = "sha256-" + createHash("sha256").update(body).digest("base64");
    assert.ok(csp.includes(`'${h}'`), `CSP missing ${h}; update vercel.json`);
  }
});

test("self-hosted mini-app SDK matches its SRI hash", () => {
  const m = html.match(/<script src="\/vendor\/miniapp-sdk\.js" integrity="(sha384-[^"]+)"/);
  assert.ok(m, "SDK script tag missing");
  const h = "sha384-" + createHash("sha384").update(readFileSync(new URL("vendor/miniapp-sdk.js", root))).digest("base64");
  assert.equal(m[1], h);
});

test("index.html calls sdk.actions.ready()", () => {
  assert.match(html, /fc\.actions\.ready\(\)/);
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
