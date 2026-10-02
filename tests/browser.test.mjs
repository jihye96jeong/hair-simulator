import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import sharp from "sharp";
import { createApp } from "../server.js";
import { readConfig } from "../lib/config.js";
import { buildHairPrompt } from "../public/hairPrompt.js";

const fakeSdk = `
export const noopLogger = {debug(){}, info(){}, warn(){}, error(){}};
export const models = { realtime: (name) => ({name, width:1280, height:720}) };
export function createDecartClient({apiKey}) {
  window.__clientKey = apiKey;
  return { realtime: { connect: async (stream, options) => {
    window.__options = options;
    window.__camera = stream;
    window.__disconnects = (window.__disconnects || 0);
    window.__sets = [];
    window.__events = {};
    const canvas = document.createElement('canvas');
    canvas.width=1280; canvas.height=720;
    const ctx=canvas.getContext('2d');
    const draw=()=>{ctx.fillStyle='#f00000';ctx.fillRect(0,0,640,720);ctx.fillStyle='#0000f0';ctx.fillRect(640,0,640,720);};
    draw();
    const timer=setInterval(draw,30);
    const remote=canvas.captureStream(30);
    const rt = {
      getConnectionState:()=> 'generating',
      on:(event, callback)=> window.__events[event]=callback,
      set:async(input)=>{if(window.__rejectSet)throw new Error('test set failure');window.__sets.push(input);},
      disconnect:()=>{window.__disconnects++;clearInterval(timer);remote.getTracks().forEach(t=>t.stop());},
    };
    window.__emit=(event,data)=>window.__events[event]?.(data);
    options.onConnectionChange('generating');
    options.onRemoteStream(remote);
    return rt;
  } } };
}
`;

async function launch() {
  const options = { headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] };
  const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  try { await access(chrome); options.executablePath = chrome; } catch { /* Playwright Chromium */ }
  return chromium.launch(options);
}

const describeSpec = {
  hairVisible: true,
  length: "shoulder",
  cut: "layered cut",
  bangs: "see_through",
  part: "none",
  texture: "s_wave",
  volume: "natural",
  color: "ash brown",
};

const FORBIDDEN_REF_BUTTONS = [
  "이 스타일로 체험하기",
  "다시 만들기",
  "촬영",
  "다시 촬영",
  "연결",
  "끊기",
  "준비",
];

async function visibleActionLabels(page) {
  return page.locator("#stage button:visible, #ref-bottom button:visible, #preset-actions button:visible").allTextContents();
}

async function assertNoForbidden(page) {
  const labels = await visibleActionLabels(page);
  for (const bad of FORBIDDEN_REF_BUTTONS) {
    assert.equal(labels.includes(bad), false, `unexpected button visible: ${bad}`);
  }
}

async function waitLive(page) {
  await expect(page.locator("#ref-layer-capture")).toBeVisible({ timeout: 10000 });
  await expect(page.locator("#ref-live-bar")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#ref-capture")).toBeEnabled({ timeout: 15000 });
}

test("browser: simplified reference flow, reuse, fallback, preset", { timeout: 180000 }, async (t) => {
  const config = readConfig({ SIMULATOR_MODE: "ref", TOKEN_DAILY_IP_LIMIT: "20" });
  const leads = [];
  let issued = 0;
  let previewCalls = 0;
  let failPreview = false;
  const previewJpeg = await sharp({ create: { width: 64, height: 80, channels: 3, background: { r: 10, g: 200, b: 40 } } }).jpeg().toBuffer();
  const app = await createApp({
    config,
    logger: { error() {} },
    decart: { tokens: { create: async () => { issued++; return { apiKey: "test-client-token" }; } } },
    store: { saveLead: async (lead) => { leads.push(lead); return { imageFileId: "test-file" }; } },
    hairVision: { describe: async () => ({ ok: true, spec: describeSpec }) },
    hairEditor: {
      edit: async () => {
        previewCalls++;
        if (failPreview) throw new Error("preview fail");
        return { buffer: previewJpeg, mediaType: "image/jpeg" };
      },
    },
  });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve(s));
    s.on("error", reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  config.origin = base;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const browser = await launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["camera"] });
  const page = await context.newPage();
  await page.route("**/vendor/sdk/index.js", (route) => route.fulfill({ contentType: "application/javascript", body: fakeSdk }));
  await page.goto(base);

  await expect(page.locator("header h1")).toHaveText("Try-On");
  await expect(page.locator("#tab-reference")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#ref-layer-idle")).toBeVisible();
  await expect(page.locator("#ref-ready-bar")).toBeHidden();
  await assertNoForbidden(page);

  // Bad file → stage banner
  await page.locator("#ref-file").setInputFiles({ name: "bad.gif", mimeType: "image/gif", buffer: Buffer.from([1, 2, 3]) });
  await expect(page.locator("#ref-stage-message")).toContainText("JPG, PNG, WebP");

  // Upload → ready (user action 1)
  let clicks = 0;
  const refPng = await sharp({ create: { width: 360, height: 480, channels: 3, background: { r: 120, g: 90, b: 60 } } }).png().toBuffer();
  await page.locator("#ref-file").setInputFiles({ name: "style.png", mimeType: "image/png", buffer: refPng });
  clicks += 1;
  await expect(page.locator("#ref-layer-ready")).toBeVisible({ timeout: 10000 });
  await expect(page.locator("#ref-ready-thumb")).toBeVisible();
  await expect(page.locator("#ref-ready-bar")).toBeVisible();
  await expect(page.locator("#ref-start")).toBeDisabled();
  await expect(page.locator("#ref-summary")).toBeHidden();
  await assertNoForbidden(page);

  // Consent (user action 2) + start (user action 3)
  await page.locator("#ref-consent-check").check();
  clicks += 1;
  await expect(page.locator("#ref-start")).toBeEnabled();
  await page.locator("#ref-start").click();
  clicks += 1;
  assert.ok(clicks <= 3, `user clicks should be ≤3, got ${clicks}`);
  assert.equal(issued, 0, "must not connect Decart before preview finishes");

  await waitLive(page);
  assert.equal(previewCalls, 1);
  assert.equal(issued, 1);
  await expect(page.locator("#ref-live-thumb")).toBeVisible();
  await expect(page.locator("#remaining")).toBeVisible();
  await assertNoForbidden(page);
  const liveLabels = await visibleActionLabels(page);
  assert.deepEqual(liveLabels.filter((t) => ["캡처", "종료"].includes(t)).sort(), ["캡처", "종료"].sort());

  const initial = await page.evaluate(async () => {
    const image = window.__options.initialState.image;
    const buf = image ? new Uint8Array(await image.arrayBuffer()) : null;
    return {
      hasImage: "image" in window.__options.initialState,
      enhance: window.__options.initialState.prompt.enhance,
      prompt: window.__options.initialState.prompt.text,
      imageBytes: buf ? Array.from(buf) : null,
    };
  });
  assert.equal(initial.hasImage, true);
  assert.equal(initial.enhance, false);
  assert.equal(initial.prompt, buildHairPrompt(describeSpec, { withImage: true }));
  assert.deepEqual(initial.imageBytes, Array.from(previewJpeg));
  assert.notDeepEqual(initial.imageBytes, Array.from(refPng));

  // Same photo retry → no second /hair-preview
  await page.locator("#ref-end").click();
  await expect(page.locator("#ref-layer-ready")).toBeVisible();
  await expect(page.locator("#ref-consent-check")).toBeChecked();
  await page.locator("#ref-start").click();
  await waitLive(page);
  assert.equal(previewCalls, 1, "same reference must reuse preview");
  assert.equal(issued, 2);
  await page.locator("#ref-end").click();

  // New photo → preview again
  const ref2 = await sharp({ create: { width: 360, height: 480, channels: 3, background: { r: 20, g: 20, b: 200 } } }).png().toBuffer();
  await page.locator("#ref-file").setInputFiles({ name: "style2.png", mimeType: "image/png", buffer: ref2 });
  await expect(page.locator("#ref-layer-ready")).toBeVisible({ timeout: 10000 });
  await page.locator("#ref-consent-check").check();
  await page.locator("#ref-start").click();
  await waitLive(page);
  assert.equal(previewCalls, 2, "new reference must remake preview");
  await page.locator("#ref-end").click();

  // Two consecutive preview failures → simple mode
  failPreview = true;
  const ref3 = await sharp({ create: { width: 360, height: 480, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
  await page.locator("#ref-file").setInputFiles({ name: "style3.png", mimeType: "image/png", buffer: ref3 });
  await expect(page.locator("#ref-layer-ready")).toBeVisible({ timeout: 10000 });
  await page.locator("#ref-consent-check").check();
  await page.locator("#ref-start").click();
  await expect(page.locator("#ref-stage-message")).toContainText("스타일을 입히지 못했어요", { timeout: 20000 });
  await expect(page.locator("#ref-stage-action")).toHaveText("다시 시도");
  assert.equal(issued, 3); // previous success only; no token on fail
  await page.locator("#ref-stage-action").click();
  await expect(page.locator("#ref-stage-action")).toHaveText("간단 모드로 체험", { timeout: 20000 });
  await page.locator("#ref-stage-action").click();
  await expect(page.locator("#ref-live-bar")).toBeVisible({ timeout: 20000 });
  const textInitial = await page.evaluate(() => ({
    hasImage: "image" in window.__options.initialState,
    prompt: window.__options.initialState.prompt.text,
    enhance: window.__options.initialState.prompt.enhance,
  }));
  assert.equal(textInitial.hasImage, false);
  assert.equal(textInitial.enhance, false);
  assert.equal(textInitial.prompt, buildHairPrompt(describeSpec, { withImage: false }));
  await page.locator("#ref-end").click();

  // Preset mode regression
  await page.locator("#tab-preset").click();
  await expect(page.locator("#preset-bar")).toBeVisible();
  await expect(page.locator("#drop")).toBeHidden();
  await page.locator('#preset-bar [data-combo="1k"]').click();
  await page.locator('#preset-bar [data-area="crown"]').click();
  await expect(page.locator('#preset-bar [data-combo="crown_1k"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator("#connect").click();
  await expect(page.locator("#save-result")).toBeEnabled();
  await page.locator('#preset-bar [data-combo="crown_2k"]').click();
  await expect(page.locator("#combo-label")).toHaveText("정수리 · 2천 모");
  await page.evaluate(() => { window.__rejectSet = true; });
  await page.locator('#preset-bar [data-area="hairline"]').click();
  await expect(page.locator("#error")).toContainText("헤어 참고 이미지 변경에 실패");
  await expect(page.locator('#preset-bar [data-area="crown"]')).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => { window.__rejectSet = false; });
  await page.locator("#save-result").click();
  await expect(page.locator("#contact")).toBeVisible();
  await page.locator("#name").fill("테스트");
  await page.locator("#phone").fill("010-1234-5678");
  await page.locator("#region").selectOption("서울");
  await page.locator("#consent").check();
  await page.locator("#submit-lead").click();
  await expect(page.locator("#complete")).toBeVisible();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].area, "crown");
  assert.equal(leads[0].density, "2k");

  const nativePage = await context.newPage();
  await nativePage.goto(base);
  const native = await nativePage.evaluate(async () => {
    const sdk = await import("@decartai/sdk");
    return sdk.models.realtime("lucy-2.5").name;
  });
  assert.equal(native, "lucy-2.5");
});

test("browser: reference UI state screenshots", { timeout: 120000 }, async (t) => {
  const config = readConfig({ SIMULATOR_MODE: "ref", TOKEN_DAILY_IP_LIMIT: "20" });
  const previewJpeg = await sharp({ create: { width: 64, height: 80, channels: 3, background: { r: 10, g: 200, b: 40 } } }).jpeg().toBuffer();
  const app = await createApp({
    config,
    logger: { error() {} },
    decart: { tokens: { create: async () => ({ apiKey: "shot-token" }) } },
    store: { saveLead: async () => ({ imageFileId: "x" }) },
    hairVision: { describe: async () => ({ ok: true, spec: describeSpec }) },
    hairEditor: { edit: async () => ({ buffer: previewJpeg, mediaType: "image/jpeg" }) },
  });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve(s));
    s.on("error", reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  config.origin = base;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const outDir = new URL("../tmp/ref-ui-shots/", import.meta.url);
  await mkdir(outDir, { recursive: true });

  const browser = await launch();
  t.after(() => browser.close());

  async function shot(name, width, height, run) {
    const context = await browser.newContext({ viewport: { width, height }, permissions: ["camera"] });
    const page = await context.newPage();
    await page.route("**/vendor/sdk/index.js", (route) => route.fulfill({ contentType: "application/javascript", body: fakeSdk }));
    await page.goto(base);
    await run(page);
    await page.screenshot({ path: new URL(`${name}.png`, outDir).pathname, fullPage: false });
    await context.close();
  }

  const refPng = await sharp({ create: { width: 360, height: 480, channels: 3, background: { r: 120, g: 90, b: 60 } } }).png().toBuffer();

  await shot("01-idle-mobile", 375, 812, async (page) => {
    await expect(page.locator("#ref-layer-idle")).toBeVisible();
  });
  await shot("01-idle-desktop", 480, 900, async (page) => {
    await expect(page.locator("#ref-layer-idle")).toBeVisible();
  });

  await shot("02-ready-mobile", 375, 812, async (page) => {
    await page.locator("#ref-file").setInputFiles({ name: "style.png", mimeType: "image/png", buffer: refPng });
    await expect(page.locator("#ref-layer-ready")).toBeVisible({ timeout: 10000 });
  });
  await shot("02-ready-desktop", 480, 900, async (page) => {
    await page.locator("#ref-file").setInputFiles({ name: "style.png", mimeType: "image/png", buffer: refPng });
    await expect(page.locator("#ref-layer-ready")).toBeVisible({ timeout: 10000 });
  });

  await shot("03-capture-mobile", 375, 812, async (page) => {
    await page.locator("#ref-file").setInputFiles({ name: "style.png", mimeType: "image/png", buffer: refPng });
    await expect(page.locator("#ref-layer-ready")).toBeVisible({ timeout: 10000 });
    await page.locator("#ref-consent-check").check();
    await page.locator("#ref-start").click();
    await expect(page.locator("#ref-layer-capture")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#ref-countdown")).toBeVisible({ timeout: 5000 });
  });

  await shot("04-generating-mobile", 375, 812, async (page) => {
    await page.route("**/hair-preview", async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    await page.locator("#ref-file").setInputFiles({ name: "style.png", mimeType: "image/png", buffer: refPng });
    await expect(page.locator("#ref-layer-ready")).toBeVisible({ timeout: 10000 });
    await page.locator("#ref-consent-check").check();
    await page.locator("#ref-start").click();
    await expect(page.locator("#ref-layer-generating")).toBeVisible({ timeout: 15000 });
  });

  await shot("05-live-mobile", 375, 812, async (page) => {
    await page.locator("#ref-file").setInputFiles({ name: "style.png", mimeType: "image/png", buffer: refPng });
    await expect(page.locator("#ref-layer-ready")).toBeVisible({ timeout: 10000 });
    await page.locator("#ref-consent-check").check();
    await page.locator("#ref-start").click();
    await expect(page.locator("#ref-live-bar")).toBeVisible({ timeout: 30000 });
  });
  await shot("05-live-desktop", 480, 900, async (page) => {
    await page.locator("#ref-file").setInputFiles({ name: "style.png", mimeType: "image/png", buffer: refPng });
    await expect(page.locator("#ref-layer-ready")).toBeVisible({ timeout: 10000 });
    await page.locator("#ref-consent-check").check();
    await page.locator("#ref-start").click();
    await expect(page.locator("#ref-live-bar")).toBeVisible({ timeout: 30000 });
  });
});
