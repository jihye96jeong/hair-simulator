import test from "node:test";
import assert from "node:assert/strict";
import { buildBaselineLoss, voidSizeCmFor, clampFillSizeCm } from "../public/baselineLoss.js";
import { BASELINE } from "../public/graftRules.js";
import { categoryMaskFromLabels, measureFrontFromInputs, measureCrownFromInputs } from "../public/faceGeometry.js";
import { assertProtectedRegionUnchanged } from "../public/graftGuide.js";

function frontFullHair() {
  const width = 96;
  const height = 120;
  const labels = new Uint8Array(width * height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const o = i * 4;
      if (y < 18) {
        labels[i] = 1;
        rgba[o] = 28; rgba[o + 1] = 18; rgba[o + 2] = 12; rgba[o + 3] = 255;
      } else {
        labels[i] = 3;
        rgba[o] = 205; rgba[o + 1] = 175; rgba[o + 2] = 155; rgba[o + 3] = 255;
      }
    }
  }
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  for (const i of [70, 105, 300, 334]) landmarks[i] = { x: 0.5, y: 0.42, z: 0 };
  landmarks[54] = { x: 0.18, y: 0.18, z: 0 };
  landmarks[284] = { x: 0.82, y: 0.18, z: 0 };
  for (const [i, x] of [[468, 0.38], [469, 0.44], [470, 0.41], [471, 0.41], [472, 0.41]]) {
    landmarks[i] = { x, y: 0.48, z: 0 };
  }
  landmarks[470].y = 0.45;
  landmarks[471].y = 0.51;
  for (const [i, x] of [[473, 0.56], [474, 0.62], [475, 0.59], [476, 0.59], [477, 0.59]]) {
    landmarks[i] = { x, y: 0.48, z: 0 };
  }
  landmarks[475].y = 0.45;
  landmarks[476].y = 0.51;
  const hairMask = categoryMaskFromLabels(labels, width, height, 1);
  const faceMask = categoryMaskFromLabels(labels, width, height, 3);
  const measure = measureFrontFromInputs({ landmarks, width, height, hairMask, faceMask });
  return { measure, hairMask, faceMask, imageData: { width, height, data: rgba } };
}

test("BASELINE void sizes and clamp", () => {
  assert.equal(voidSizeCmFor("hairline"), BASELINE.hairline.recedeCm);
  assert.equal(voidSizeCmFor("mline"), BASELINE.mline.cornerCm);
  assert.equal(voidSizeCmFor("crown"), BASELINE.crown.radiusCm);
  assert.equal(clampFillSizeCm("hairline", 9), BASELINE.hairline.recedeCm);
  assert.equal(clampFillSizeCm("hairline", 1), 1);
});

test("baselineLoss is deterministic and protects brow region", () => {
  const fixture = frontFullHair();
  const a = buildBaselineLoss({ ...fixture, area: "hairline" });
  const b = buildBaselineLoss({ ...fixture, area: "hairline" });
  assert.equal(a.stats.hash, b.stats.hash);
  assert.ok(a.stats.clearedPixels > 30);
  assert.ok(assertProtectedRegionUnchanged(
    fixture.imageData.data,
    a.imageData.data,
    fixture.measure.width,
    fixture.measure.height,
    fixture.measure.browTopY,
  ));
  const m = buildBaselineLoss({ ...fixture, area: "mline" });
  assert.ok(m.stats.clearedPixels > 10);
  assert.ok(assertProtectedRegionUnchanged(
    fixture.imageData.data,
    m.imageData.data,
    fixture.measure.width,
    fixture.measure.height,
    fixture.measure.browTopY,
  ));
});

test("crown baseline thins center more than edge", () => {
  const width = 64;
  const height = 64;
  const hairMask = new Uint8Array(width * height);
  const faceMask = new Uint8Array(width * height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 4; y < 50; y++) {
    for (let x = 8; x < 56; x++) {
      const i = y * width + x;
      hairMask[i] = 1;
      rgba[i * 4] = 35; rgba[i * 4 + 1] = 25; rgba[i * 4 + 2] = 18; rgba[i * 4 + 3] = 255;
    }
  }
  const measure = measureCrownFromInputs({ hairMask, faceMask, width, height, rgba });
  const baseline = buildBaselineLoss({
    area: "crown",
    measure,
    imageData: { width, height, data: rgba },
    hairMask,
    faceMask,
  });
  assert.ok(baseline.stats.clearedPixels > 20);
  assert.equal(baseline.stats.pxPerCmNote, "temporary-crown-head-width");
});
