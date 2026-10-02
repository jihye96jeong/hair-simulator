import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeSession } from "../public/session.js";
import { stateOf, initialStateOf } from "../public/combos.js";

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
  const session = new RealtimeSession({ mode: "ref", anchor: "on", combo: "partial", now: () => wall,
    report: (value) => reports.push(value), logger: { info: (...args) => logs.push(args), error() {} },
    timers: { setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return 1; }, setInterval: () => 2, clearTimeout() {}, clearInterval() {} },
  });
  return { session, stream, rt, callbacks, timeouts, reports, logs, sets, setWall: (value) => { wall = value; }, counts: () => ({ disconnects, stops }) };
}
const token = async () => ({ token: "temporary", sessionId: "test-session" });

test("SDK initialState and set() send their correct full state structures", () => {
  const image = new Blob(["image"]);
  const images = { partial: image };
  const state = stateOf("partial", "ref", images);
  assert.deepEqual(initialStateOf("partial", "ref", images), { prompt: { text: state.prompt, enhance: true }, image });
  const text = stateOf("partial", "text", images);
  assert.ok(!("image" in text));
  assert.ok(!text.prompt.includes("from the reference image"));
  assert.throws(() => stateOf("invalid", "ref", images));
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
  assert.equal(await f.session.select("1k", {}), false);
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
  assert.equal(await f.session.select("1k", { prompt: "full state", enhance: true, image: new Blob() }), true);
  assert.equal(f.session.switches, 1);
  assert.equal(f.counts().disconnects, 0);
  f.session.stop("capture", true);
  assert.equal(f.counts().disconnects, 1);
  assert.equal(f.reports[0].captured, true);
  assert.equal(f.reports[0].combo, "1k");
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
  const first = f.session.select("1k", { prompt: "1k", enhance: true });
  const second = f.session.select("2k", { prompt: "2k", enhance: true });
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(f.session.combo, "2k");
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
