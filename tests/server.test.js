import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { createApp } from "../server.js";
import { readConfig } from "../lib/config.js";
import { DailyQuota } from "../lib/quota.js";

const clock = Date.parse("2026-10-01T06:00:00Z");
const quiet = { error() {} };
async function fixture(t, options = {}) {
  let creates = 0;
  const leads = [];
  const scopes = [];
  const config = readConfig({ APP_ORIGIN: "http://localhost:3000", ...options.env });
  const app = await createApp({ config, now: () => clock, logger: quiet,
    decart: options.decart || { tokens: { create: async (input) => { creates++; scopes.push(input); return { apiKey: "temporary-client-token" }; } } },
    store: options.store || { saveLead: async (lead, id) => { leads.push({ lead, id }); return { imageFileId: "private-file" }; } },
  });
  const server = await new Promise((resolve, reject) => { const s = app.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve(s)); s.on("error", reject); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  return { base, post, leads, scopes, creates: () => creates };
}
async function validLead(sessionId) {
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } }).webp().toBuffer();
  return { sessionId, name: "홍길동", phone: "010-1234-5678", region: "서울", area: "hairline", density: "1k", action: "save", consentAt: new Date(clock).toISOString(), image: `data:image/webp;base64,${image.toString("base64")}` };
}
test("serves the UI, local SDK and config without server secrets", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base)).status, 200);
  assert.equal((await fetch(`${f.base}/vendor/sdk/index.js`)).status, 200);
  assert.equal((await fetch(`${f.base}/vendor/retry.js`)).status, 200);
  const config = await (await fetch(`${f.base}/config`)).json();
  assert.ok(!("decartKey" in config));
  assert.equal(config.assets.partial, false);
  assert.equal((await fetch(`${f.base}/.env`)).status, 404);
  assert.equal((await fetch(`${f.base}/server.js`)).status, 404);
});
test("fourth token rejected; model/origin/session duration scoped", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) {
    const response = await f.post("/token");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).token, "temporary-client-token");
  }
  assert.equal((await f.post("/token")).status, 429);
  assert.equal(f.creates(), 3);
  assert.deepEqual(f.scopes[0], { expiresIn: 60, allowedModels: ["lucy-2.5"], allowedOrigins: ["http://localhost:3000"], constraints: { realtime: { maxSessionDuration: 120 } } });
});
test("global quota returns 503 and cross-origin requests are rejected", async (t) => {
  const f = await fixture(t, { env: { TOKEN_DAILY_TOTAL_LIMIT: "1" } });
  assert.equal((await f.post("/token", null, { Origin: "https://other.example" })).status, 403);
  assert.equal((await f.post("/token")).status, 200);
  assert.equal((await f.post("/token")).status, 503);
});
test("failed token issuance rolls back quota and returns sanitized errors", async (t) => {
  const f = await fixture(t, { env: { TOKEN_DAILY_IP_LIMIT: "1" }, decart: { tokens: { create: async () => { throw new Error("secret must not leak"); } } } });
  for (let i = 0; i < 2; i++) {
    const response = await f.post("/token");
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes("secret"));
  }
});
test("daily quota rolls over at Korea midnight and protects parallel reservations", () => {
  let now = Date.parse("2026-10-01T14:59:59Z");
  const quota = new DailyQuota({ ipLimit: 1, totalLimit: 2, now: () => now });
  const first = quota.reserve("a");
  assert.equal(quota.reserve("a").status, 429);
  first.release(); first.release();
  assert.ok(quota.reserve("a").release);
  now += 1000;
  assert.ok(quota.reserve("a").release);
});
test("server enforces both consents, phone, region and WebP; valid lead saved once", async (t) => {
  const f = await fixture(t);
  const { sessionId } = await (await f.post("/token")).json();
  const lead = await validLead(sessionId);
  for (const patch of [{ consentAt: null }, { action: "referral" }, { phone: "bad" }, { phone: "0101234567" }, { phone: "010abc12345678" }, { region: "없는 지역" }, { image: "not-image" }, { density: "bad" }, { sessionId: "unknown" }]) {
    assert.equal((await f.post("/leads", { ...lead, ...patch })).status, 400);
  }
  assert.equal(f.leads.length, 0);
  const requests = await Promise.all([f.post("/leads", lead), f.post("/leads", lead)]);
  assert.ok(requests.every((r) => r.status === 200));
  assert.equal(f.leads.length, 1);
  assert.equal(f.leads[0].lead.phone, "01012345678");
  assert.ok(Buffer.isBuffer(f.leads[0].lead.image));
});
test("referral with explicit third-party consent is accepted", async (t) => {
  const f = await fixture(t);
  const { sessionId } = await (await f.post("/token")).json();
  const lead = await validLead(sessionId);
  assert.equal((await f.post("/leads", { ...lead, action: "referral", thirdPartyConsentAt: lead.consentAt })).status, 200);
});
test("beacon text/plain body accepted; duplicate and invalid reports handled", async (t) => {
  const f = await fixture(t);
  const { sessionId } = await (await f.post("/token")).json();
  const body = { sessionId, reason: "pagehide", billedSeconds: 20, wallSeconds: 21, switches: 2, combo: "2k", captured: false };
  assert.equal((await f.post("/session-end", { ...body, billedSeconds: -1 })).status, 400);
  assert.equal((await f.post("/session-end", body, { "Content-Type": "text/plain" })).status, 204);
  assert.equal((await f.post("/session-end", body)).status, 204);
  assert.equal((await f.post("/session-end", { ...body, sessionId: "unknown" })).status, 400);
});
test("CLI entry point starts the app and serves the page without configured keys", { timeout: 10000 }, async (t) => {
  const portFinder = createServer();
  await new Promise((resolve, reject) => { portFinder.listen(0, "127.0.0.1", resolve); portFinder.on("error", reject); });
  const port = portFinder.address().port;
  await new Promise((resolve) => portFinder.close(resolve));
  const child = spawn(process.execPath, ["server.js"], { cwd: new URL("../", import.meta.url), env: { ...process.env, PORT: String(port), APP_ORIGIN: `http://127.0.0.1:${port}`, DECART_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } });
  await Promise.race([
    new Promise((resolve) => child.stdout.on("data", (data) => { if (data.toString().includes("모수 시뮬레이터:")) resolve(); })),
    once(child, "exit").then(() => { throw new Error("CLI exited before listening"); }),
  ]);
  assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/token`, { method: "POST" })).status, 500);
});
