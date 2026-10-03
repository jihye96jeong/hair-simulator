import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { createApp } from "../server.js";
import { readConfig } from "../lib/config.js";
import { DailyQuota } from "../lib/quota.js";
import { buildHairPrompt, describeHairKo } from "../public/hairPrompt.js";

const clock = Date.parse("2026-10-01T06:00:00Z");
const quiet = { error() {} };
const previewSpec = {
  hairVisible: true,
  length: "shoulder",
  cut: "layered cut",
  bangs: "see_through",
  part: "none",
  texture: "messy_textured",
  volume: "natural",
  color: "dark brown",
  front: "lifted_up",
  forehead: "fully_exposed",
  sides: "above_ears",
  top: "short",
};
const personPreviewSpec = {
  ...previewSpec,
  front: "falls_down",
  forehead: "covered",
  sides: "over_ears",
  top: "medium",
};
function createPassVision() {
  return {
    describe: async () => ({ ok: true, spec: previewSpec }),
  };
}
async function fixture(t, options = {}) {
  let creates = 0;
  const leads = [];
  const scopes = [];
  const config = readConfig({ APP_ORIGIN: "http://localhost:3000", ...options.env });
  const app = await createApp({ config, now: () => clock, logger: options.logger || quiet,
    decart: options.decart || { tokens: { create: async (input) => { creates++; scopes.push(input); return { apiKey: "temporary-client-token" }; } } },
    store: options.store || { saveLead: async (lead, id) => { leads.push({ lead, id }); return { imageFileId: "private-file" }; } },
    hairVision: options.hairVision === undefined ? createPassVision() : options.hairVision,
    hairEditor: options.hairEditor,
    baselineEditor: options.baselineEditor,
    graftInpaint: options.graftInpaint,
    graftFill: options.graftFill,
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
  assert.equal((await fetch(`${f.base}/vendor/mediapipe/vision_bundle.mjs`)).status, 200);
  assert.equal((await fetch(`${f.base}/vendor/mediapipe/wasm/vision_wasm_internal.wasm`, { method: "HEAD" })).status, 200);
  assert.equal((await fetch(`${f.base}/models/face_landmarker.task`, { method: "HEAD" })).status, 200);
  assert.equal((await fetch(`${f.base}/models/selfie_multiclass_256x256.tflite`, { method: "HEAD" })).status, 200);
  const config = await (await fetch(`${f.base}/config`)).json();
  assert.ok(!("decartKey" in config));
  assert.ok(!("anthropicKey" in config));
  assert.deepEqual(config.assets, {});
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
  assert.deepEqual(f.scopes[0], { expiresIn: 300, allowedModels: ["lucy-2.5"], allowedOrigins: ["http://localhost:3000"], constraints: { realtime: { maxSessionDuration: 120 } } });
});
test("global quota returns 503 and cross-origin requests are rejected", async (t) => {
  const f = await fixture(t, { env: { TOKEN_DAILY_TOTAL_LIMIT: "1" } });
  assert.equal((await f.post("/token", null, { Origin: "https://other.example" })).status, 403);
  assert.equal((await f.post("/token")).status, 200);
  assert.equal((await f.post("/token")).status, 503);
});
test("DISABLE_QUOTA allows unlimited requests without 429", async (t) => {
  const f = await fixture(t, { env: { DISABLE_QUOTA: "true", TOKEN_DAILY_IP_LIMIT: "1" } });
  for (let i = 0; i < 5; i++) {
    const response = await f.post("/token");
    assert.equal(response.status, 200);
  }
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
  for (const patch of [{ consentAt: null }, { action: "referral" }, { phone: "bad" }, { phone: "0101234567" }, { phone: "010abc12345678" }, { region: "없는 지역" }, { image: "not-image" }, { area: "bad" }, { area: "crown", density: "crown_2k" }, { density: "bad" }, { sessionId: "unknown" }]) {
    assert.equal((await f.post("/leads", { ...lead, ...patch })).status, 400);
  }
  assert.equal(f.leads.length, 0);
  const requests = await Promise.all([f.post("/leads", lead), f.post("/leads", lead)]);
  assert.ok(requests.every((r) => r.status === 200));
  assert.equal(f.leads.length, 1);
  assert.equal(f.leads[0].lead.phone, "01012345678");
  assert.ok(Buffer.isBuffer(f.leads[0].lead.image));
});
test("crown captures preserve area and density for all three densities", async (t) => {
  const f = await fixture(t);
  const pairs = [
    { density: "1k", combo: "crown_1000" },
    { density: "2k", combo: "crown_2000" },
    { density: "3k", combo: "crown_3000" },
  ];
  for (const { density, combo } of pairs) {
    const { sessionId } = await (await f.post("/token")).json();
    const lead = { ...await validLead(sessionId), area: "crown", density };
    assert.equal((await f.post("/leads", lead)).status, 200);
    assert.equal(f.leads.at(-1).lead.area, "crown");
    assert.equal(f.leads.at(-1).lead.density, density);
    assert.equal((await f.post("/session-end", {
      sessionId, reason: "capture", billedSeconds: 10, wallSeconds: 11, switches: 1,
      combo, captured: true, mode: "graft",
    })).status, 204);
  }
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
  const body = { sessionId, reason: "pagehide", billedSeconds: 20, wallSeconds: 21, switches: 2, combo: "hairline_2000", captured: false };
  assert.equal((await f.post("/session-end", { ...body, billedSeconds: -1 })).status, 400);
  assert.equal((await f.post("/session-end", body, { "Content-Type": "text/plain" })).status, 204);
  assert.equal((await f.post("/session-end", body)).status, 204);
  assert.equal((await f.post("/session-end", { ...body, sessionId: "unknown" })).status, 400);
});
test("session-end with insufficient credits reason logs server error", async (t) => {
  const errors = [];
  const f = await fixture(t, { logger: { error: (...args) => errors.push(args.join(" ")) } });
  const { sessionId } = await (await f.post("/token")).json();
  assert.equal((await f.post("/session-end", {
    sessionId,
    reason: "connect-failed: Insufficient credits",
    billedSeconds: 0,
    wallSeconds: 1,
    switches: 0,
    combo: "baseline",
    captured: false,
    mode: "graft",
  })).status, 204);
  assert.ok(errors.some((line) => /Decart 크레딧 부족/.test(line)));
});
test("reference experienceType session-end is accepted without allowing arbitrary combo", async (t) => {
  const f = await fixture(t);
  const { sessionId } = await (await f.post("/token")).json();
  const body = { sessionId, reason: "capture", billedSeconds: 8, wallSeconds: 9, switches: 2, combo: "reference", captured: true, experienceType: "reference", mode: "ref", anchor: "on" };
  assert.equal((await f.post("/session-end", body)).status, 204);
  assert.equal((await f.post("/session-end", { ...body, combo: "partial" })).status, 400);
  assert.equal((await f.post("/session-end", { ...body, experienceType: "preset", combo: "reference" })).status, 400);
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

const visibleSpec = {
  hairVisible: true,
  length: "shoulder",
  cut: "layered cut",
  bangs: "see_through",
  part: "none",
  texture: "s_wave",
  volume: "natural",
  color: "ash brown",
  front: "falls_down",
  forehead: "partly_exposed",
  sides: "over_ears",
  top: "medium",
};

async function jpegDataUrl() {
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#654" } }).jpeg().toBuffer();
  return `data:image/jpeg;base64,${image.toString("base64")}`;
}

test("/hair-describe returns prompt text and rejects bad inputs without leaking images", async (t) => {
  const logs = [];
  const logger = { error: (...args) => logs.push(args), info: (...args) => logs.push(args) };
  const f = await fixture(t, {
    logger,
    env: { HAIR_DESCRIBE_DAILY_IP_LIMIT: "2", HAIR_DESCRIBE_DAILY_TOTAL_LIMIT: "10" },
    hairVision: { describe: async () => ({ ok: true, spec: visibleSpec }) },
  });
  const image = await jpegDataUrl();
  const ok = await f.post("/hair-describe", { image });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.deepEqual(await ok.json(), { spec: visibleSpec, prompt: buildHairPrompt(visibleSpec), summary: describeHairKo(visibleSpec) });
  assert.ok(!JSON.stringify(logs).includes(image.slice(30, 80)));
  assert.ok(!JSON.stringify(logs).includes("base64"));

  const hidden = await fixture(t, { hairVision: { describe: async () => ({ ok: true, spec: { ...visibleSpec, hairVisible: false } }) } });
  assert.equal((await hidden.post("/hair-describe", { image: await jpegDataUrl() })).status, 422);

  const badSpec = await fixture(t, { hairVision: { describe: async () => ({ ok: false, error: "invalid-spec" }) } });
  assert.equal((await badSpec.post("/hair-describe", { image: await jpegDataUrl() })).status, 502);

  const none = await fixture(t, { hairVision: null });
  assert.equal((await none.post("/hair-describe", { image: await jpegDataUrl() })).status, 503);

  assert.equal((await f.post("/hair-describe", { image: "not-image" })).status, 400);
  assert.equal((await f.post("/hair-describe", { image: "data:image/gif;base64,AAAA" })).status, 400);
  const huge = `data:image/jpeg;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64")}`;
  assert.equal((await f.post("/hair-describe", { image: huge })).status, 413);
});

test("/hair-describe quota rejects a second success and vision failure releases the reservation", async (t) => {
  const logs = [];
  let fail = true;
  const f = await fixture(t, {
    env: { HAIR_DESCRIBE_DAILY_IP_LIMIT: "1" },
    logger: { error: (...args) => logs.push(args.join(" ")), info() {} },
    hairVision: {
      describe: async () => {
        if (fail) throw new Error("secret-vision-trace");
        return { ok: true, spec: visibleSpec };
      },
    },
  });
  const image = await jpegDataUrl();
  const first = await f.post("/hair-describe", { image });
  assert.equal(first.status, 502);
  assert.ok(!logs.join(" ").includes("secret-vision-trace"));
  fail = false;
  assert.equal((await f.post("/hair-describe", { image })).status, 200);
  assert.equal((await f.post("/hair-describe", { image })).status, 429);
});

test("/hair-preview returns jpeg and rejects bad inputs without leaking images", async (t) => {
  const logs = [];
  const previewJpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#0af" } }).jpeg().toBuffer();
  const f = await fixture(t, {
    logger: { error: (...args) => logs.push(args), info: (...args) => logs.push(args) },
    env: { HAIR_PREVIEW_DAILY_IP_LIMIT: "2" },
    hairEditor: { edit: async () => ({ buffer: previewJpeg, mediaType: "image/jpeg" }) },
  });
  const person = await jpegDataUrl();
  const reference = await jpegDataUrl();
  const ok = await f.post("/hair-preview", { person, reference, spec: previewSpec });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const body = await ok.json();
  assert.match(body.image, /^data:image\/jpeg;base64,/);
  assert.ok(Array.isArray(body.scores));
  assert.equal(body.scores.length, 2);
  assert.ok(!JSON.stringify(logs).includes(person.slice(30, 80)));
  assert.ok(!JSON.stringify(logs).includes("base64"));

  // Extra guide fields are ignored
  const withGuide = await f.post("/hair-preview", {
    person,
    reference,
    spec: previewSpec,
    guide: person,
    hairOnly: person,
    editMask: person,
    guideReason: "should-be-ignored",
  });
  assert.equal(withGuide.status, 200);
  const guideBody = await withGuide.json();
  assert.equal(guideBody.guideUsed, undefined);
  assert.equal(guideBody.guideReason, undefined);

  const none = await fixture(t, { hairEditor: null, hairVision: null });
  assert.equal((await none.post("/hair-preview", { person: await jpegDataUrl(), reference: await jpegDataUrl(), spec: previewSpec })).status, 503);

  assert.equal((await f.post("/hair-preview", { person: "x", reference, spec: previewSpec })).status, 400);
  assert.equal((await f.post("/hair-preview", { person, reference: "data:image/gif;base64,AAAA", spec: previewSpec })).status, 400);
  assert.equal((await f.post("/hair-preview", { person, reference })).status, 400);
  const huge = `data:image/jpeg;base64,${Buffer.alloc(Math.floor(1.2 * 1024 * 1024) + 1).toString("base64")}`;
  assert.equal((await f.post("/hair-preview", { person: huge, reference, spec: previewSpec })).status, 413);
});

test("/hair-preview quota releases on failure and rejects a second success", async (t) => {
  const logs = [];
  let fail = true;
  let edits = 0;
  const previewJpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123" } }).jpeg().toBuffer();
  const f = await fixture(t, {
    env: { HAIR_PREVIEW_DAILY_IP_LIMIT: "1" },
    logger: { error: (...args) => logs.push(args.join(" ")), info() {} },
    hairEditor: {
      edit: async () => {
        edits++;
        if (fail) throw new Error("secret-edit-trace");
        return { buffer: previewJpeg, mediaType: "image/jpeg" };
      },
    },
  });
  const person = await jpegDataUrl();
  const reference = await jpegDataUrl();
  assert.equal((await f.post("/hair-preview", { person, reference, spec: previewSpec })).status, 502);
  assert.ok(!logs.join(" ").includes("secret-edit-trace"));
  fail = false;
  const before = edits;
  assert.equal((await f.post("/hair-preview", { person, reference, spec: previewSpec })).status, 200);
  assert.equal(edits - before, 2, "one request generates two candidates");
  assert.equal((await f.post("/hair-preview", { person, reference, spec: previewSpec })).status, 429);
});

test("/hair-preview contest selects best of two and returns even at zero match", async (t) => {
  const mk = async (color) => sharp({ create: { width: 8, height: 8, channels: 3, background: color } }).jpeg().toBuffer();
  const a = await mk("#111");
  const b = await mk("#222");
  const person = await jpegDataUrl();
  const reference = await jpegDataUrl();
  const weak = {
    ...previewSpec,
    front: "falls_down",
    forehead: "covered",
    sides: "over_ears",
  };
  const okSpec = { ...previewSpec };
  const zero = { ...personPreviewSpec };

  function visionFromSpecs(specs) {
    let i = 0;
    return {
      describe: async () => {
        const spec = specs[i];
        i += 1;
        return { ok: true, spec };
      },
    };
  }

  // Higher match wins
  {
    let n = 0;
    const bufs = [a, b];
    const f = await fixture(t, {
      hairEditor: { edit: async () => ({ buffer: bufs[n++], mediaType: "image/jpeg" }) },
      hairVision: visionFromSpecs([weak, okSpec]),
    });
    const res = await f.post("/hair-preview", { person, reference, spec: previewSpec });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.selectedIndex, 1);
    assert.equal(body.scores.length, 2);
    assert.equal(body.scores[0].hairMatch, 0);
    assert.equal(body.scores[1].hairMatch, 3);
    assert.equal(body.image, `data:image/jpeg;base64,${b.toString("base64")}`);
  }

  // Both score 0 → still 200 with first candidate
  {
    let n = 0;
    const bufs = [a, b];
    const f = await fixture(t, {
      hairEditor: { edit: async () => ({ buffer: bufs[n++], mediaType: "image/jpeg" }) },
      hairVision: visionFromSpecs([zero, zero]),
    });
    const res = await f.post("/hair-preview", { person, reference, spec: previewSpec, labDebug: true });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.selectedIndex, 0);
    assert.equal(body.scores.every((s) => s.hairMatch === 0), true);
    assert.equal(body.image, `data:image/jpeg;base64,${a.toString("base64")}`);
    assert.ok(Array.isArray(body.candidates));
  }

  // Vision failure → 502; quota still one reservation then release
  {
    let edits = 0;
    const f = await fixture(t, {
      env: { HAIR_PREVIEW_DAILY_IP_LIMIT: "1" },
      hairEditor: {
        edit: async () => {
          edits++;
          return { buffer: a, mediaType: "image/jpeg" };
        },
      },
      hairVision: {
        describe: async () => ({ ok: false }),
      },
    });
    assert.equal((await f.post("/hair-preview", { person, reference, spec: previewSpec })).status, 502);
    assert.equal(edits, 2);
    edits = 0;
    assert.equal((await f.post("/hair-preview", { person, reference, spec: previewSpec })).status, 502);
    assert.equal(edits, 2);
  }
});

test("/hair-preview rejects editModel outside allowlist", async (t) => {
  const f = await fixture(t, {
    env: { HAIR_EDIT_MODEL_ALLOWLIST: "gemini-2.5-flash-image" },
    hairEditor: { edit: async () => ({ buffer: Buffer.from("x"), mediaType: "image/jpeg" }) },
  });
  const person = await jpegDataUrl();
  const reference = await jpegDataUrl();
  assert.equal(
    (await f.post("/hair-preview", { person, reference, spec: previewSpec, editModel: "gemini-3.1-flash-image" })).status,
    400,
  );
});

test("/graft-inpaint fills from person+mask and records model timing", async (t) => {
  const outJpeg = await sharp({ create: { width: 32, height: 40, channels: 3, background: { r: 20, g: 10, b: 5 } } }).jpeg().toBuffer();
  let lastInput = null;
  const f = await fixture(t, {
    graftInpaint: {
      meta: { id: "gemini-3-pro-image", estimatedCostUsd: 0.04 },
      inpaint: async (input) => {
        lastInput = input;
        return {
          buffer: outJpeg,
          mediaType: "image/jpeg",
          model: "gemini-3-pro-image",
          ms: 12,
          estimatedCostUsd: 0.04,
          densityLabel: "medium",
        };
      },
    },
  });
  const person = await jpegDataUrl();
  const mask = `data:image/png;base64,${(await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).png().toBuffer()).toString("base64")}`;
  const ok = await f.post("/graft-inpaint", { person, mask, area: "hairline", grafts: 2000 });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.ok(body.image.startsWith("data:image/jpeg;base64,"));
  assert.equal(body.model, "gemini-3-pro-image");
  assert.equal(body.densityLabel, "medium");
  assert.equal(lastInput.area, "hairline");
  assert.equal(lastInput.grafts, 2000);
  assert.equal((await f.post("/graft-inpaint", { person, mask, area: "nope", grafts: 2000 })).status, 400);
  assert.equal((await f.post("/graft-inpaint", { person, mask, area: "hairline", grafts: 500 })).status, 400);
  const none = await fixture(t, { graftInpaint: null });
  assert.equal((await none.post("/graft-inpaint", { person, mask, area: "hairline", grafts: 2000 })).status, 503);
});

test("/graft-fill composites via adapter and has separate quota", async (t) => {
  const outJpeg = await sharp({ create: { width: 32, height: 40, channels: 3, background: { r: 40, g: 20, b: 10 } } }).jpeg().toBuffer();
  let calls = 0;
  let lastDensity = null;
  const f = await fixture(t, {
    env: { GRAFT_FILL_DAILY_IP_LIMIT: "1" },
    graftFill: {
      fill: async ({ density }) => {
        calls++;
        lastDensity = density;
        return {
          buffer: outJpeg,
          mediaType: "image/jpeg",
          model: "gemini-3-pro-image",
          ms: 9,
          estimatedCostUsd: 0.04,
          densityLabel: density <= 0.7 ? "sparse" : density <= 0.85 ? "medium" : "dense",
        };
      },
    },
  });
  const person = await jpegDataUrl();
  const mask = `data:image/png;base64,${(await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).png().toBuffer()).toString("base64")}`;
  const ok = await f.post("/graft-fill", { person, mask, area: "hairline", grafts: 2000 });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.ok(body.image.startsWith("data:image/jpeg;base64,"));
  assert.equal(body.densityLabel, "medium");
  assert.equal(lastDensity, 0.8);
  assert.equal(calls, 1);
  assert.equal((await f.post("/graft-fill", { person, mask, area: "hairline", grafts: 1000 })).status, 429);
  const none = await fixture(t, { graftFill: null });
  assert.equal((await none.post("/graft-fill", { person, mask, area: "hairline", grafts: 2000 })).status, 503);
});

test("/baseline creates Norwood-style still once and has separate quota", async (t) => {
  const outJpeg = await sharp({ create: { width: 32, height: 40, channels: 3, background: { r: 180, g: 150, b: 130 } } }).jpeg().toBuffer();
  let calls = 0;
  let lastPose = null;
  const f = await fixture(t, {
    env: { BASELINE_DAILY_IP_LIMIT: "1" },
    baselineEditor: {
      edit: async ({ pose }) => {
        calls += 1;
        lastPose = pose;
        return {
          buffer: outJpeg,
          mediaType: "image/jpeg",
          model: "gemini-3-pro-image",
          ms: 9,
          estimatedCostUsd: 0.04,
        };
      },
    },
  });
  const person = await jpegDataUrl();
  const ok = await f.post("/baseline", { person, pose: "front" });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.ok(body.image.startsWith("data:image/jpeg;base64,"));
  assert.equal(body.pose, "front");
  assert.equal(lastPose, "front");
  assert.equal(body.estimatedCostUsd, 0.04);
  assert.equal((await f.post("/baseline", { person, pose: "crown" })).status, 429);
  assert.equal(calls, 1);
  const none = await fixture(t, { baselineEditor: null });
  assert.equal((await none.post("/baseline", { person })).status, 503);
});
