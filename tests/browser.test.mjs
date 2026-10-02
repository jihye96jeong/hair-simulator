import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import sharp from "sharp";
import { createApp } from "../server.js";
import { readConfig } from "../lib/config.js";

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

test("browser: Try-On hair panel, reference connect/swap, preset flow", { timeout: 60000 }, async (t) => {
  const config = readConfig({ SIMULATOR_MODE: "ref", TOKEN_DAILY_IP_LIMIT: "20" });
  const leads = [];
  let issued = 0;
  const app = await createApp({
    config,
    logger: { error() {} },
    decart: { tokens: { create: async () => { issued++; return { apiKey: "test-client-token" }; } } },
    store: { saveLead: async (lead) => { leads.push(lead); return { imageFileId: "test-file" }; } },
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

  // Exact Try-On chrome: hair mode first, one screen.
  await expect(page.locator("header h1")).toHaveText("Try-On");
  await expect(page.locator("#tab-reference")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#stage-label")).toContainText("연결을 누르면 카메라가 켜집니다");
  await expect(page.locator("#drop-label")).toContainText("상품 이미지를 여기에 놓으세요");
  await expect(page.locator("#connect")).toHaveText("연결");
  await expect(page.locator("#disconnect")).toHaveText("끊기");
  await expect(page.locator("main > p.fine")).toContainText("초당 $0.02");

  // Invalid file
  await page.locator("#ref-file").setInputFiles({ name: "bad.gif", mimeType: "image/gif", buffer: Buffer.from([1, 2, 3]) });
  await expect(page.locator("#error")).toContainText("JPG, PNG, WebP");

  // Upload + connect (reference)
  const png = await sharp({ create: { width: 360, height: 480, channels: 3, background: { r: 120, g: 90, b: 60 } } }).png().toBuffer();
  await page.locator("#ref-file").setInputFiles({ name: "style.png", mimeType: "image/png", buffer: png });
  if (await page.locator("#ref-manual").isVisible()) await page.locator("#ref-confirm-manual").click();
  await expect(page.locator("#connect")).toBeEnabled({ timeout: 15000 });
  assert.equal(issued, 0);
  await page.locator("#connect").click();
  await expect(page.locator("#ref-capture")).toBeEnabled();
  assert.equal(issued, 1);
  const initial = await page.evaluate(() => ({
    hasImage: "image" in window.__options.initialState,
    prompt: window.__options.initialState.prompt.text,
    enhance: window.__options.initialState.prompt.enhance,
    token: window.__clientKey,
  }));
  assert.equal(initial.hasImage, true);
  assert.equal(initial.enhance, true);
  assert.match(initial.prompt, /Change only the hair/);
  assert.equal(initial.token, "test-client-token");

  // Same-session swap
  const png2 = await sharp({ create: { width: 360, height: 480, channels: 3, background: { r: 40, g: 40, b: 40 } } }).png().toBuffer();
  await page.locator("#ref-replace-file").setInputFiles({ name: "style2.png", mimeType: "image/png", buffer: png2 });
  if (await page.locator("#ref-manual").isVisible()) await page.locator("#ref-confirm-manual").click();
  await expect.poll(async () => page.evaluate(() => window.__sets.length)).toBeGreaterThan(0);
  assert.equal(issued, 1);

  await page.locator("#disconnect").click();
  await expect(page.locator("#status")).toContainText("끊");

  // Preset mode on the same screen
  await page.locator("#tab-preset").click();
  await expect(page.locator("#preset-bar")).toBeVisible();
  await expect(page.locator("#drop")).toBeHidden();
  await page.locator('#preset-bar [data-combo="1k"]').click();
  await page.locator('#preset-bar [data-area="crown"]').click();
  await expect(page.locator('#preset-bar [data-combo="crown_1k"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator("#connect").click();
  await expect(page.locator("#save-result")).toBeEnabled();
  assert.equal(issued, 2);
  await page.locator('#preset-bar [data-combo="crown_2k"]').click();
  await expect(page.locator("#combo-label")).toHaveText("정수리 · 2천 모");
  assert.equal(issued, 2, "density switch reuses connection");

  // Failed set keeps selection
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

  // Native SDK import still works
  const nativePage = await context.newPage();
  await nativePage.goto(base);
  const native = await nativePage.evaluate(async () => {
    const sdk = await import("@decartai/sdk");
    return sdk.models.realtime("lucy-2.5").name;
  });
  assert.equal(native, "lucy-2.5");
});
