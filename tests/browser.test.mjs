import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
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
    window.__disconnects = 0;
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
      set:async(input)=>window.__sets.push(input),
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
  try { await access(chrome); options.executablePath = chrome; } catch { /* use Playwright Chromium on Linux/CI */ }
  return chromium.launch(options);
}
test("browser: native SDK imports, product flow, capture, consent, lab and automatic stops", { timeout: 60000 }, async (t) => {
  const config = readConfig({ SIMULATOR_MODE: "text", TOKEN_DAILY_IP_LIMIT: "20" });
  const leads = [];
  const sessions = [];
  let issued = 0;
  const app = await createApp({ config, logger: { error() {} },
    decart: { tokens: { create: async () => { issued++; return { apiKey: "test-client-token" }; } } },
    store: { saveLead: async (lead) => { leads.push(lead); return { imageFileId: "test-file" }; } },
  });
  const server = await new Promise((resolve, reject) => { const s = app.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve(s)); s.on("error", reject); });
  // Observe successful beacon requests without an external session storage service.
  server.on("request", (request, response) => {
    if (request.url === "/session-end") response.once("finish", () => {
      if (response.statusCode === 204) sessions.push(request.body);
    });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  config.origin = base;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["camera"], acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(base);
  await expect(page.locator("#prepare")).toBeEnabled();
  // Test installed SDK + its real dependency graph before substituting paid connections.
  const native = await page.evaluate(async () => {
    const sdk = await import("@decartai/sdk");
    const livekit = await import("livekit-client");
    const { default: retry } = await import("p-retry");
    let attempts = 0;
    await retry(async () => { if (++attempts === 1) throw new Error("retry test"); return true; }, { retries: 1, minTimeout: 1 });
    return { model: sdk.models.realtime("lucy-2.5").name, room: typeof livekit.Room, attempts };
  });
  assert.deepEqual(native, { model: "lucy-2.5", room: "function", attempts: 2 });
  // A reload clears the browser module cache, then intercept only the SDK in tests.
  await page.route("**/vendor/sdk/index.js", (route) => route.fulfill({ contentType: "application/javascript", body: fakeSdk }));
  await page.reload();
  await expect(page.locator("#prepare")).toBeEnabled();
  await page.locator('#selection [data-combo="1k"]').click();
  await page.locator("#prepare").click();
  await expect(page.locator("#experience-start")).toBeEnabled();
  assert.equal(issued, 0, "no token before experience");
  await page.locator("#experience-start").click();
  await expect(page.locator("#save-result")).toBeEnabled();
  assert.equal(issued, 1);
  const options = await page.evaluate(() => ({ modeImage: "image" in window.__options.initialState, enhance: window.__options.initialState.prompt.enhance, prompt: window.__options.initialState.prompt.text, mirror: window.__options.mirror, token: window.__clientKey }));
  assert.equal(options.modeImage, false);
  assert.equal(options.enhance, true);
  assert.equal(options.mirror, "auto");
  assert.equal(options.token, "test-client-token");
  await page.locator('#experience [data-combo="2k"]').click();
  await expect(page.locator("#combo-label")).toHaveText("헤어라인 · 2천 모");
  assert.equal(issued, 1, "switching reuses connection");
  await page.evaluate(() => window.__emit("connectionChange", "reconnecting"));
  await expect(page.locator('#experience [data-combo="partial"]')).toBeDisabled();
  await page.evaluate(() => window.__emit("connectionChange", "generating"));
  await expect(page.locator("#save-result")).toBeEnabled();
  await expect(page.locator("#resolution")).toHaveText("1280 × 720");
  await page.locator("#save-result").click();
  await expect(page.locator("#contact")).toBeVisible();
  assert.equal(await page.evaluate(() => window.__disconnects), 1);
  assert.equal(await page.evaluate(() => window.__camera.getTracks().every((track) => track.readyState === "ended")), true);
  await page.locator("#name").fill("테스트 사용자");
  await page.locator("#phone").fill("010-1234-5678");
  await page.locator("#region").selectOption("서울");
  await expect(page.locator("#submit-lead")).toBeDisabled();
  assert.equal(leads.length, 0);
  await page.locator("#consent").check();
  await expect(page.locator("#submit-lead")).toBeEnabled();
  await page.locator("#submit-lead").click();
  await expect(page.locator("#complete")).toBeVisible();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].phone, "01012345678");
  assert.equal(leads[0].density, "2k");
  await expect.poll(() => sessions.length).toBe(1);
  assert.equal(sessions[0].reason, "capture");
  assert.equal(sessions[0].switches, 1);
  // Verify the saved canvas keeps the same red-left / blue-right orientation.
  const decoded = await sharp(leads[0].image).raw().toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => [...decoded.data.subarray((y * decoded.info.width + x) * decoded.info.channels, (y * decoded.info.width + x) * decoded.info.channels + 3)];
  assert.ok(pixel(200, 350)[0] > 200);
  assert.ok(pixel(1000, 350)[2] > 200);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#download-saved").click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^text_anchor_2k_정면_.*\.png$/);
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/mobile-complete.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

  // Referral requires its own consent and closing the form discards the face.
  await page.locator('#complete [data-back]').click();
  await page.locator("#prepare").click();
  await expect(page.locator("#experience-start")).toBeEnabled();
  await page.locator("#experience-start").click();
  await expect(page.locator("#referral")).toBeEnabled();
  await page.locator("#referral").click();
  await page.locator("#name").fill("테스트");
  await page.locator("#phone").fill("01012345678");
  await page.locator("#region").selectOption("경기");
  await page.locator("#consent").check();
  await expect(page.locator("#submit-lead")).toBeDisabled();
  await page.locator("#third-consent").check();
  await expect(page.locator("#submit-lead")).toBeEnabled();
  await page.locator("#close-form").click();
  assert.equal(await page.locator("#captured-image").getAttribute("src"), null);

  // Lab honors URL options and retains the connection after PNG capture.
  await page.goto(`${base}/lab?mode=ref&anchor=off`);
  await expect(page.locator("#prepare")).toBeEnabled();
  await page.locator('#selection [data-combo="2k"]').click();
  await page.locator("#prepare").click();
  await expect(page.locator("#experience-start")).toBeEnabled();
  await page.locator("#experience-start").click();
  await expect(page.locator("#lab-capture")).toBeEnabled();
  assert.equal(await page.evaluate(() => window.__options.queryParams.self_anchor), "false");
  assert.equal(await page.evaluate(() => window.__options.initialState.image instanceof Blob), true);
  await page.locator("#pose").selectOption("좌회전");
  const labDownload = page.waitForEvent("download");
  await page.locator("#lab-capture").click();
  assert.match((await labDownload).suggestedFilename(), /^ref_noanchor_2k_좌회전_.*\.png$/);
  assert.equal(await page.evaluate(() => window.__disconnects), 0);
  await page.evaluate(() => window.__emit("generationTick", { seconds: 120 }));
  await expect(page.locator("#ended-title")).toHaveText("시간 종료");
  assert.equal(await page.evaluate(() => window.__disconnects), 1);

  // A fresh connection starts at zero and hides safely on background transition.
  await page.locator("#retry").click();
  await page.locator("#prepare").click();
  await expect(page.locator("#experience-start")).toBeEnabled();
  await page.locator("#experience-start").click();
  await expect(page.locator("#lab-capture")).toBeEnabled();
  await page.evaluate(() => window.__emit("generationTick", { seconds: 1 }));
  await expect(page.locator("#remaining")).toHaveText("119초 남음");
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(page.locator("#ended")).toBeVisible();
  assert.equal(await page.evaluate(() => window.__disconnects), 1);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  assert.equal(await page.evaluate(() => window.__disconnects), 1);
  assert.deepEqual(pageErrors, []);
  await expect.poll(() => sessions.length).toBe(4);
  assert.equal(sessions.at(-1).reason, "hidden");
  const closingPage = await context.newPage();
  await closingPage.route("**/vendor/sdk/index.js", (route) => route.fulfill({ contentType: "application/javascript", body: fakeSdk }));
  await closingPage.goto(`${base}/lab?mode=text`);
  await expect(closingPage.locator("#prepare")).toBeEnabled();
  await closingPage.locator("#prepare").click();
  await expect(closingPage.locator("#experience-start")).toBeEnabled();
  await closingPage.locator("#experience-start").click();
  await expect(closingPage.locator("#lab-capture")).toBeEnabled();
  await closingPage.close();
  await expect.poll(() => sessions.length).toBe(5);
  assert.ok(["hidden", "pagehide"].includes(sessions.at(-1).reason));
});
