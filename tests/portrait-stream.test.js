import test from "node:test";
import assert from "node:assert/strict";
import {
  PORTRAIT_HEIGHT,
  PORTRAIT_WIDTH,
  createPortraitStream,
  portraitCropRect,
} from "../public/portraitStream.js";

test("portrait crop centers a 9:16 window inside a landscape webcam frame", () => {
  const crop = portraitCropRect(1280, 720);
  assert.equal(crop.h, 720);
  assert.equal(crop.w, 405);
  assert.equal(crop.y, 0);
  assert.ok(Math.abs(crop.x - (1280 - 405) / 2) <= 1);
  assert.equal(PORTRAIT_WIDTH / PORTRAIT_HEIGHT, 9 / 16);
});

test("portrait crop keeps an already-portrait frame full width", () => {
  const crop = portraitCropRect(720, 1280);
  assert.deepEqual(crop, { x: 0, y: 0, w: 720, h: 1280 });
  const tall = portraitCropRect(720, 1600);
  assert.equal(tall.w, 720);
  assert.equal(tall.h, 1280);
  assert.equal(tall.y, 160);
});

test("createPortraitStream passes the source through outside a browser", () => {
  const source = { getTracks: () => [] };
  const result = createPortraitStream(source);
  assert.equal(result.stream, source);
  assert.equal(result.portrait, false);
  result.stop();
});
