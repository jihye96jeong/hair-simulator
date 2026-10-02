import test from "node:test";
import assert from "node:assert/strict";
import {
  GUIDE_INSET_SIDE,
  GUIDE_INSET_TOP,
  clampRect,
  coverMapping,
  cropRectFromGuide,
  displayCropToVideo,
  faceGuideEllipse,
} from "../public/selfie.js";

test("faceGuideEllipse matches CSS inset 12% 18%", () => {
  const e = faceGuideEllipse(400, 500);
  assert.equal(e.left, 400 * GUIDE_INSET_SIDE);
  assert.equal(e.top, 500 * GUIDE_INSET_TOP);
  assert.equal(e.width, 400 * (1 - 2 * GUIDE_INSET_SIDE));
  assert.equal(e.height, 500 * (1 - 2 * GUIDE_INSET_TOP));
});

test("cropRectFromGuide is 3:4 and starts above the ellipse", () => {
  const ellipse = { left: 72, top: 60, width: 256, height: 380 };
  const crop = cropRectFromGuide(ellipse);
  assert.ok(Math.abs(crop.width - 256 * 2.2) < 1e-9);
  assert.ok(Math.abs(crop.height - crop.width * 4 / 3) < 1e-9);
  assert.ok(Math.abs(crop.top - (60 - 380 * 0.9)) < 1e-9);
  assert.ok(Math.abs(crop.left + crop.width / 2 - (72 + 128)) < 1e-9);
});

test("coverMapping centers a landscape video in a portrait element", () => {
  const m = coverMapping({ videoW: 1280, videoH: 720, displayW: 360, displayH: 480 });
  assert.ok(Math.abs(m.scale - 480 / 720) < 1e-9);
  assert.ok(m.offsetX > 0);
  assert.equal(m.offsetY, 0);
  const centerVideoX = (180 + m.offsetX) / m.scale;
  assert.ok(Math.abs(centerVideoX - 640) < 1e-6);
});

test("displayCropToVideo mirrors horizontally and clamps to video bounds", () => {
  const elementW = 360;
  const elementH = 480;
  const videoW = 1280;
  const videoH = 720;
  const ellipse = faceGuideEllipse(elementW, elementH);
  const crop = cropRectFromGuide(ellipse);
  const src = displayCropToVideo({
    crop,
    elementW,
    elementH,
    videoW,
    videoH,
    mirrored: true,
  });
  assert.ok(src.x >= 0);
  assert.ok(src.y >= 0);
  assert.ok(src.x + src.w <= videoW + 1e-9);
  assert.ok(src.y + src.h <= videoH + 1e-9);
  assert.ok(src.w > 0);
  assert.ok(src.h > 0);

  const unmirrored = displayCropToVideo({
    crop,
    elementW,
    elementH,
    videoW,
    videoH,
    mirrored: false,
  });
  // Same crop width/height; x origin differs when mirrored.
  assert.ok(Math.abs(src.w - unmirrored.w) < 1e-6);
  assert.ok(Math.abs(src.h - unmirrored.h) < 1e-6);
  assert.notEqual(src.x, unmirrored.x);
});

test("clampRect keeps the box inside bounds", () => {
  assert.deepEqual(clampRect(-20, -10, 100, 80, 200, 100), { x: 0, y: 0, w: 100, h: 80 });
  assert.deepEqual(clampRect(150, 40, 100, 80, 200, 100), { x: 100, y: 20, w: 100, h: 80 });
  assert.deepEqual(clampRect(0, 0, 500, 400, 200, 100), { x: 0, y: 0, w: 200, h: 100 });
});
