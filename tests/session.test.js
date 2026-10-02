import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeSession } from "../public/session.js";
import { promptForArea } from "../public/graftRules.js";

function fixture() {
  let wall = 0;
  let disconnects = 0;
  let stops = 0;
  const callbacks = new Map();
  const timeouts = [];
  const reports = [];
  const logs = [];
  const sets = [];
  const stream = { getTracks: () => [{ stop: () => stops++ }] };
  const rt = { disconnect: () => disconnects++, getConnectionState: () => "generating", on: (event, callback) => callbacks.set(event, callback), set: async (value) => sets.push(value) };
  const session = new RealtimeSession({ mode: "graft", anchor: "on", combo: "mline_1000", now: () => wall,
    report: (value) => reports.push(value), logger: { info: (...args) => logs.push(args), error() {} },
    timers: { setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return 1; }, setInterval: () => 2, clearTimeout() {}, clearInterval() {} },
  });
  return { session, stream, rt, callbacks, timeouts, reports, logs, sets, setWall: (value) => { wall = value; }, counts: () => ({ disconnects, stops }) };
}
const token = async () => ({ token: "temporary", sessionId: "test-session" });

test("SDK set() always bundles prompt, image, enhance for graft guides", () => {
  const image = new Blob(["image"]);
  const prompt = promptForArea("hairline");
  const state = { prompt, image, enhance: false };
  assert.equal("prompt" in state && "image" in state && "enhance" in state, true);
  assert.equal(state.enhance, false);
  assert.ok(prompt.includes("hairline exactly at the position"));
});
test("tick cap stops once, stops all camera tracks, and reports capture conditions", async () => {
  const f = fixture();
  await f.session.start(f.stream, token, async () => f.rt, {});
  f.setWall(120000);
  f.callbacks.get("generationTick")({ seconds: 120 });
  f.session.stop("hidden");
  f.session.stop("pagehide");
  assert.deepEqual(f.counts(), { disconnects: 1, stops: 1 });
  assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].reason, "cap");
  assert.equal(f.reports[0].billedSeconds, 120);
  assert.equal(f.logs.filter(([event]) => event === "session-end").length, 1);
});
test("125s fallback works without generation ticks", async () => {
  const f = fixture();
  await f.session.start(f.stream, token, async () => f.rt, {});
  assert.equal(f.timeouts[0].ms, 125000);
  f.timeouts[0].fn();
  assert.equal(f.reports[0].reason, "cap");
});
test("a reconnect tick reset preserves total usage; a new session starts at zero", async () => {
  const f = fixture();
  await f.session.start(f.stream, token, async () => f.rt, {});
  f.callbacks.get("generationTick")({ seconds: 70 });
  f.callbacks.get("connectionChange")("reconnecting");
  assert.equal(await f.session.select("hairline_1000", {}), false);
  f.callbacks.get("connectionChange")("generating");
  f.callbacks.get("generationTick")({ seconds: 0 });
  f.callbacks.get("generationTick")({ seconds: 50 });
  assert.equal(f.reports[0].billedSeconds, 120);
  const next = fixture();
  await next.session.start(next.stream, token, async () => next.rt, {});
  next.callbacks.get("generationTick")({ seconds: 1 });
  assert.equal(next.session.billedSeconds, 1);
  next.session.stop("manual");
});
test("switches share the connection; capture closes it immediately", async () => {
  const f = fixture();
  await f.session.start(f.stream, token, async () => f.rt, {});
  assert.equal(await f.session.select("hairline_1000", { prompt: "full state", enhance: true, image: new Blob() }), true);
  assert.equal(f.session.switches, 1);
  assert.equal(f.counts().disconnects, 0);
  f.session.stop("capture", true);
  assert.equal(f.counts().disconnects, 1);
  assert.equal(f.reports[0].captured, true);
  assert.equal(f.reports[0].combo, "hairline_1000");
  assert.equal(f.reports[0].mode, "graft");
  assert.ok(f.logs.some(([event]) => event === "session-end"));
});
test("rapid select drains to the latest preset without reconnect", async () => {
  const f = fixture();
  let active = 0;
  const order = [];
  f.rt.set = async (value) => {
    active++;
    order.push(`start:${value.prompt}`);
    f.sets.push(value);
    await Promise.resolve();
    order.push(`end:${value.prompt}`);
    active--;
  };
  await f.session.start(f.stream, token, async () => f.rt, {});
  const first = f.session.select("hairline_1000", { prompt: "1k", enhance: true });
  const second = f.session.select("hairline_2000", { prompt: "2k", enhance: true });
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(f.session.combo, "hairline_2000");
  assert.deepEqual(f.sets.map((item) => item.prompt), ["1k", "2k"]);
  assert.ok(f.session.switches >= 1);
  assert.equal(active, 0);
  assert.equal(f.counts().disconnects, 0);
  f.session.stop("manual");
});
test("setHairPrompt forces a new set without an image and with enhance false", async () => {
  const f = fixture();
  f.session.experienceType = "reference";
  f.session.combo = "reference";
  await f.session.start(f.stream, token, async () => f.rt, {});
  assert.equal(await f.session.setHairPrompt("prompt-a"), true);
  assert.equal(await f.session.setHairPrompt("prompt-b"), true);
  assert.equal(f.sets.length, 2);
  assert.equal("image" in f.sets[0], false);
  assert.equal("image" in f.sets[1], false);
  assert.equal(f.sets[1].prompt, "prompt-b");
  assert.equal(f.sets[1].enhance, false);
  assert.match(f.session.combo, /^reference:/);
  f.session.stop("manual");
  assert.equal(f.reports[0].combo, "reference");
  assert.equal(f.reports[0].experienceType, "reference");
});
test("setHairReference sends image with enhance false", async () => {
  const f = fixture();
  f.session.experienceType = "reference";
  f.session.combo = "reference";
  await f.session.start(f.stream, token, async () => f.rt, {});
  const image = new Blob(["preview-bytes"]);
  assert.equal(await f.session.setHairReference(image, "prompt-preview"), true);
  assert.equal(f.sets.length, 1);
  assert.equal(f.sets[0].image, image);
  assert.equal(f.sets[0].prompt, "prompt-preview");
  assert.equal(f.sets[0].enhance, false);
  f.session.stop("manual");
});
test("hiding during token issuance prevents a late connection and reports once", async () => {
  const f = fixture();
  let resolveToken;
  let connects = 0;
  const promise = f.session.start(f.stream, () => new Promise((resolve) => { resolveToken = resolve; }), async () => { connects++; return f.rt; }, {});
  f.session.stop("hidden");
  resolveToken(await token());
  await promise;
  assert.equal(connects, 0);
  assert.equal(f.reports.length, 1);
  assert.equal(f.counts().stops, 1);
});
test("late SDK connect result is disposed after stop", async () => {
  const f = fixture();
  let resolveConnect;
  const promise = f.session.start(f.stream, token, () => new Promise((resolve) => { resolveConnect = resolve; }), {});
  await Promise.resolve();
  f.session.stop("hidden");
  resolveConnect(f.rt);
  await promise;
  assert.deepEqual(f.counts(), { disconnects: 1, stops: 1 });
});
test("connect failure records connect-failed reason on session-end", async () => {
  const f = fixture();
  await f.session.start(f.stream, token, async () => {
    const err = new Error("WebSocket closed: 1008 policy_violation");
    err.connectFailed = true;
    throw err;
  }, {});
  assert.equal(f.reports.length, 1);
  assert.match(f.reports[0].reason, /^connect-failed: WebSocket closed: 1008 policy_violation$/);
});
test("insufficient credits connect failure uses credits user message", async () => {
  const errors = [];
  const f = fixture();
  f.session.onError = (message) => errors.push(message);
  await f.session.start(f.stream, token, async () => {
    const err = new Error("Insufficient credits");
    err.connectFailed = true;
    throw err;
  }, {});
  assert.equal(f.reports[0].reason, "connect-failed: Insufficient credits");
  assert.equal(errors[0], "지금은 체험을 이용할 수 없어요. 잠시 후 다시 시도해 주세요.");
});
