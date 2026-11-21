import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import handler, { redirectFor } from "../../api/onramp.js";
import configHandler from "../../api/config.js";
import { MemoryStore } from "../guards.js";
import { cdpJwt, parseRequest, partnerUserRef, publicConfig, BUNDLES } from "../onramp.js";

// Fresh Ed25519 test key in CDP's format: base64(seed32 || pub32). Generated per run, never a real key.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const SECRET = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const ENV = { CDP_API_KEY_ID: "test-key-id-1234", CDP_API_KEY_SECRET: SECRET, CDP_PROJECT_ID: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b" };
const PLAYER = "0xda66ABf9cEB1f59C628B76758e3211cA5f273839";
const PROD = "https://asteroidsshooter.app";

function fakeRes() {
  return { statusCode: 200, h: {}, body: undefined, setHeader(k, v) { this.h[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
}
function req({ method = "POST", origin = PROD, body = { address: PLAYER, bundle: "usdc5" }, ip = "198.51.100.7" } = {}) {
  return { method, headers: { origin, "x-forwarded-for": ip }, body };
}
function mockCdp(status = 201, json = { session: { onrampUrl: "https://pay.coinbase.com/buy?sessionToken=abc123" } }) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: status < 300, status, json: async () => json }; };
  return { calls, fetchImpl };
}
async function run(r, { env = ENV, cdp = mockCdp(), store = new MemoryStore() } = {}) {
  const res = fakeRes();
  await handler(r, res, { env, fetchImpl: cdp.fetchImpl, store });
  return { res, cdp };
}
function captureLogs(fn) {
  const out = []; const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => out.push(a.map(String).join(" "));
  return Promise.resolve(fn()).finally(() => Object.assign(console, orig)).then((v) => ({ v, logs: out.join("\n") }));
}
const noSecret = (s) => { assert.ok(!String(s).includes(SECRET), "secret leaked"); assert.ok(!String(s).includes(jwk.d), "seed leaked"); };

test("happy path: one CDP call with a valid EdDSA JWT; response is only the pay.coinbase.com url", async () => {
  const { res, cdp } = await run(req());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { url: "https://pay.coinbase.com/buy?sessionToken=abc123" });
  assert.equal(res.h["Access-Control-Allow-Origin"], PROD);
  assert.equal(cdp.calls.length, 1);
  const { url, init } = cdp.calls[0];
  assert.equal(url, "https://api.cdp.coinbase.com/platform/v2/onramp/sessions");
  const body = JSON.parse(init.body);
  assert.deepEqual(body, { destinationAddress: PLAYER, destinationNetwork: "base", purchaseCurrency: "USDC", paymentAmount: "5.00",
    paymentCurrency: "USD", clientIp: "198.51.100.7", partnerUserRef: partnerUserRef(PLAYER, false), redirectUrl: PROD + "/" });
  const jwt = init.headers.Authorization.replace(/^Bearer /, "");
  const [h, c, s] = jwt.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url")); const claims = JSON.parse(Buffer.from(c, "base64url"));
  assert.equal(header.alg, "EdDSA"); assert.equal(header.kid, ENV.CDP_API_KEY_ID); assert.match(header.nonce, /^[0-9a-f]{32}$/);
  assert.deepEqual(claims.uris, ["POST api.cdp.coinbase.com/platform/v2/onramp/sessions"]);
  assert.equal(claims.iss, "cdp"); assert.equal(claims.sub, ENV.CDP_API_KEY_ID); assert.ok(claims.exp - claims.nbf <= 120);
  assert.ok(verify(null, Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, "base64url")), "JWT signature verifies");
  noSecret(JSON.stringify(res.body)); noSecret(JSON.stringify(res.h));
});

test("10 USDC and gas bundles map to fixed amounts; sandbox flag prefixes partnerUserRef", async () => {
  let { cdp } = await run(req({ body: { address: PLAYER, bundle: "usdc10" } }));
  assert.equal(JSON.parse(cdp.calls[0].init.body).paymentAmount, "10.00");
  ({ cdp } = await run(req({ body: { address: PLAYER, bundle: "eth3" } }), { env: { ...ENV, CDP_ONRAMP_SANDBOX: "1" } }));
  const b = JSON.parse(cdp.calls[0].init.body);
  assert.equal(b.purchaseCurrency, "ETH"); assert.equal(b.paymentAmount, "3.00"); assert.match(b.partnerUserRef, /^sandbox-ast-[0-9a-f]{32}$/);
  assert.ok(b.partnerUserRef.length < 50);
});

test("input validation: bad/zero/missing addresses, unknown or prototype bundle names, junk bodies -> 400, no CDP call", async () => {
  const bad = [
    { address: "0x123", bundle: "usdc5" }, { address: "0x0000000000000000000000000000000000000000", bundle: "usdc5" },
    { bundle: "usdc5" }, { address: PLAYER }, { address: PLAYER, bundle: "usdc500" }, { address: PLAYER, bundle: "__proto__" },
    { address: PLAYER, bundle: "toString" }, { address: PLAYER, bundle: "constructor" }, { address: [PLAYER], bundle: "usdc5" },
    { address: PLAYER + " ", bundle: "usdc5" }, "not json", null,
  ];
  for (const body of bad) {
    const { res, cdp } = await run(req({ body }));
    assert.equal(res.statusCode, 400, JSON.stringify(body)); assert.equal(cdp.calls.length, 0);
  }
  assert.throws(() => parseRequest({ address: PLAYER, bundle: "hasOwnProperty" }));
  assert.equal(Object.keys(BUNDLES).length, 3);
});

test("CORS: unknown origins get 403 and no CDP call; never '*'; preview origin only on its own preview deployment", async () => {
  let { res, cdp } = await run(req({ origin: "https://evil.example" }));
  assert.equal(res.statusCode, 403); assert.equal(cdp.calls.length, 0); assert.equal(res.h["Access-Control-Allow-Origin"], undefined);
  const prev = "https://asteroid-shooter-git-feat-x-kevin-s-projects-bface346.vercel.app";
  ({ res } = await run(req({ origin: prev })));
  assert.equal(res.statusCode, 403, "preview origin refused on production");
  const penv = { ...ENV, VERCEL_ENV: "preview", VERCEL_BRANCH_URL: prev.slice(8) };
  ({ res, cdp } = await run(req({ origin: prev }), { env: penv }));
  assert.equal(res.statusCode, 200); assert.equal(res.h["Access-Control-Allow-Origin"], prev);
  assert.equal(JSON.parse(cdp.calls[0].init.body).redirectUrl, prev + "/");
  ({ res } = await run(req({ origin: "https://other-preview.vercel.app" }), { env: penv }));
  assert.equal(res.statusCode, 403);
  ({ res } = await run(req({ method: "OPTIONS" })));
  assert.equal(res.statusCode, 204); assert.equal(res.h["Access-Control-Allow-Methods"], "POST");
  ({ res } = await run(req({ method: "GET" })));
  assert.equal(res.statusCode, 405);
  for (const r of [req(), req({ method: "OPTIONS" }), req({ origin: "https://evil.example" })]) {
    const x = await run(r); assert.notEqual(x.res.h["Access-Control-Allow-Origin"], "*");
  }
  assert.equal(redirectFor({ headers: { origin: "https://evil.example" } }, ENV), PROD + "/");
});

test("rate limits: 6th request a minute from one IP and 11th per address an hour -> 429", async () => {
  const store = new MemoryStore();
  for (let i = 0; i < 5; i++) assert.equal((await run(req(), { store })).res.statusCode, 200);
  assert.equal((await run(req(), { store })).res.statusCode, 429);
  const s2 = new MemoryStore(); let last;
  for (let i = 0; i < 11; i++) last = (await run(req({ ip: "203.0.113." + i }), { store: s2 })).res.statusCode;
  assert.equal(last, 429);
});

test("missing CDP env -> 503 everywhere, config says onramp off; no crash, no CDP call", async () => {
  const { res, cdp } = await run(req(), { env: {} });
  assert.equal(res.statusCode, 503); assert.equal(cdp.calls.length, 0);
  assert.deepEqual(publicConfig({}), { onramp: false, cdpProjectId: "2b9579c1-2d80-43b0-9c24-3b7ae2a9f524", bundles: ["usdc5", "usdc10", "eth3"] });
  assert.equal(publicConfig({ CDP_PROJECT_ID: "off" }).cdpProjectId, null);
  const cres = fakeRes(); configHandler({ method: "GET", headers: {} }, cres, { env: {} });
  assert.equal(cres.statusCode, 200); assert.equal(cres.body.onramp, false);
  const cres2 = fakeRes(); configHandler({ method: "GET", headers: {} }, cres2, { env: ENV });
  assert.deepEqual(cres2.body, { onramp: true, cdpProjectId: ENV.CDP_PROJECT_ID, bundles: ["usdc5", "usdc10", "eth3"] });
  noSecret(JSON.stringify(cres2.body)); assert.ok(!JSON.stringify(cres2.body).includes(ENV.CDP_API_KEY_ID));
  assert.equal(publicConfig({ CDP_PROJECT_ID: "<script>" }).cdpProjectId, null);
});

test("CDP errors: generic messages, logs carry only status/type, never the key, JWT, or address", async () => {
  for (const [status, expect] of [[401, 502], [500, 502], [429, 429]]) {
    const cdp = mockCdp(status, { errorType: "unauthorized", errorMessage: "detail " + SECRET });
    const { v: res, logs } = await captureLogs(async () => (await run(req(), { cdp })).res);
    assert.equal(res.statusCode, expect);
    noSecret(JSON.stringify(res.body)); noSecret(logs);
    assert.ok(!logs.includes("Bearer") && !logs.includes("eyJ"), "no JWT in logs");
    assert.ok(!JSON.stringify(res.body).includes("detail"), "CDP message not echoed");
  }
  const { res } = await run(req(), { cdp: mockCdp(201, { session: { onrampUrl: "https://evil.example/x" } }) });
  assert.equal(res.statusCode, 502, "only pay.coinbase.com links are passed to the page");
  const { v, logs } = await captureLogs(async () => (await run(req(), { env: { ...ENV, CDP_API_KEY_SECRET: "garbage" } })).res);
  assert.equal(v.statusCode, 503); noSecret(logs); assert.ok(!logs.includes("garbage"));
});

test("legacy ECDSA PEM keys sign ES256", () => {
  const { privateKey: ec, publicKey: ecPub } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = ec.export({ format: "pem", type: "sec1" });
  const jwt = cdpJwt({ keyId: "k", keySecret: pem.replace(/\n/g, "\\n"), method: "POST", host: "h", path: "/p" });
  const [h, c, s] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(h, "base64url")).alg, "ES256");
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: ecPub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
});
