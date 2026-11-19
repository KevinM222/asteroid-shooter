import { test } from "node:test";
import assert from "node:assert/strict";
import { cors, pickOrigin } from "../http.js";

function fakeRes() {
  const h = {};
  return { h, setHeader: (k, v) => { h[k] = v; }, status() { return this; }, end() {}, json() {} };
}

test("CORS echoes the new domain and the old vercel.app domain", () => {
  for (const o of ["https://asteroidsshooter.app", "https://asteroid-shooter-alpha.vercel.app"]) {
    const res = fakeRes();
    cors({ method: "OPTIONS", headers: { origin: o } }, res);
    assert.equal(res.h["Access-Control-Allow-Origin"], o);
  }
});

test("CORS never echoes an unknown origin", () => {
  assert.equal(pickOrigin("https://evil.example"), "https://asteroidsshooter.app");
  assert.equal(pickOrigin(undefined), "https://asteroidsshooter.app");
});

test("ALLOWED_ORIGIN adds comma-separated origins", () => {
  process.env.ALLOWED_ORIGIN = "https://a.example, https://b.example";
  try { assert.equal(pickOrigin("https://b.example"), "https://b.example"); }
  finally { delete process.env.ALLOWED_ORIGIN; }
});
