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
