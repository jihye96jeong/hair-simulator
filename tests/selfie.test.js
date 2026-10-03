import test from "node:test";
import assert from "node:assert/strict";
import {
  GUIDE_INSET_SIDE,
  GUIDE_INSET_TOP,
  aspectRatioForLength,
  clampRect,
  coverMapping,
  cropRectFromGuide,
  displayCropToVideo,
  faceGuideEllipse,
  identityCropFromGuide,
  viewportCropRect,
} from "../public/selfie.js";

test("faceGuideEllipse matches CSS inset 12% 18%", () => {
  const e = faceGuideEllipse(400, 500);
  assert.equal(e.left, 400 * GUIDE_INSET_SIDE);
  assert.equal(e.top, 500 * GUIDE_INSET_TOP);
  assert.equal(e.width, 400 * (1 - 2 * GUIDE_INSET_SIDE));
  assert.equal(e.height, 500 * (1 - 2 * GUIDE_INSET_TOP));
});

test("cropRectFromGuide is 3:4 by default and 2:3 for long styles, same top", () => {
  const ellipse = { left: 72, top: 60, width: 256, height: 380 };
  const crop34 = cropRectFromGuide(ellipse);
  assert.ok(Math.abs(crop34.width - 256 * 2.2) < 1e-9);
  assert.ok(Math.abs(crop34.height - crop34.width * 4 / 3) < 1e-9);
  assert.ok(Math.abs(crop34.top - (60 - 380 * 0.9)) < 1e-9);
  assert.ok(Math.abs(crop34.left + crop34.width / 2 - (72 + 128)) < 1e-9);

  const crop23 = cropRectFromGuide(ellipse, { aspectRatio: "2:3" });
  assert.ok(Math.abs(crop23.width - crop34.width) < 1e-9);
  assert.ok(Math.abs(crop23.height - crop23.width * 3 / 2) < 1e-9);
  assert.equal(crop23.top, crop34.top);
  assert.ok(crop23.height > crop34.height);
});

test("aspectRatioForLength maps chest/long to 2:3; shoulder and shorter stay 3:4", () => {
  assert.equal(aspectRatioForLength("short"), "3:4");
  assert.equal(aspectRatioForLength("chin"), "3:4");
  assert.equal(aspectRatioForLength("shoulder"), "3:4");
  assert.equal(aspectRatioForLength("chest"), "2:3");
  assert.equal(aspectRatioForLength("long"), "2:3");
});

test("identityCropFromGuide is 1:1 centered on the ellipse at 1.4× width", () => {
  const ellipse = { left: 72, top: 60, width: 256, height: 380 };
  const id = identityCropFromGuide(ellipse);
  assert.ok(Math.abs(id.width - 256 * 1.4) < 1e-9);
  assert.equal(id.width, id.height);
  assert.ok(Math.abs(id.left + id.width / 2 - (72 + 128)) < 1e-9);
  assert.ok(Math.abs(id.top + id.height / 2 - (60 + 190)) < 1e-9);
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

test("viewportCropRect maintains 3:4 or 2:3 framing centered in container without negative top", () => {
  const crop34 = viewportCropRect({ elementW: 360, elementH: 480, aspectRatio: "3:4" });
  assert.equal(crop34.left, 0);
  assert.equal(crop34.top, 0);
  assert.equal(crop34.width, 360);
  assert.equal(crop34.height, 480);

  const cropWide = viewportCropRect({ elementW: 500, elementH: 400, aspectRatio: "3:4" });
  assert.equal(cropWide.height, 400);
  assert.equal(cropWide.width, 300);
  assert.equal(cropWide.left, 100);
  assert.equal(cropWide.top, 0);

  const cropTall23 = viewportCropRect({ elementW: 360, elementH: 600, aspectRatio: "2:3" });
  assert.equal(cropTall23.width, 360);
  assert.equal(cropTall23.height, 540);
  assert.equal(cropTall23.left, 0);
  assert.equal(cropTall23.top, 30);
});
