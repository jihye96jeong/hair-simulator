import test from "node:test";
import assert from "node:assert/strict";
import {
  assertBaldMaskRespectsKeep,
  assertProtectRegionUnchanged,
  buildBaldMask,
  buildSideHairKeepMask,
  prefillBaseline,
  SIDE_HAIR_KEEP_CM,
  SKULL_WIDTH_FACTOR,
} from "../public/baselinePrefill.js";
import { categoryMaskFromLabels, measureFrontFromInputs } from "../public/faceGeometry.js";

function fixture() {
  const width = 96;
  const height = 120;
  const labels = new Uint8Array(width * height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const o = i * 4;
      const side = x < 14 || x > 81;
      if ((side && y < 70) || y < 18) {
        labels[i] = 1;
        rgba[o] = 35; rgba[o + 1] = 24; rgba[o + 2] = 16; rgba[o + 3] = 255;
      } else {
        labels[i] = 3;
        rgba[o] = 200; rgba[o + 1] = 170; rgba[o + 2] = 150; rgba[o + 3] = 255;
      }
    }
  }
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  for (const i of [70, 105, 300, 334]) landmarks[i] = { x: 0.5, y: 0.42, z: 0 };
  landmarks[54] = { x: 0.22, y: 0.18, z: 0 };
  landmarks[284] = { x: 0.78, y: 0.18, z: 0 };
  landmarks[234] = { x: 0.12, y: 0.48, z: 0 };
  landmarks[454] = { x: 0.88, y: 0.48, z: 0 };
  landmarks[152] = { x: 0.5, y: 0.88, z: 0 };
  for (const [i, x] of [[468, 0.38], [469, 0.44], [470, 0.41], [471, 0.41], [472, 0.41]]) {
    landmarks[i] = { x, y: 0.48, z: 0 };
  }
  landmarks[470].y = 0.45; landmarks[471].y = 0.51;
  for (const [i, x] of [[473, 0.56], [474, 0.62], [475, 0.59], [476, 0.59], [477, 0.59]]) {
    landmarks[i] = { x, y: 0.48, z: 0 };
  }
  landmarks[475].y = 0.45; landmarks[476].y = 0.51;
  const hairMask = categoryMaskFromLabels(labels, width, height, 1);
  const faceMask = categoryMaskFromLabels(labels, width, height, 3);
  const measure = measureFrontFromInputs({
    landmarks, width, height, hairMask, faceMask, skipForeheadCheck: true,
  });
  return { measure, hairMask, imageData: { width, height, data: rgba } };
}

test("bald mask constants are marked temporary defaults", () => {
  assert.equal(SKULL_WIDTH_FACTOR, 1.15);
  assert.equal(SIDE_HAIR_KEEP_CM, 1.5);
});

test("bald mask respects protect region and side-hair keep band", () => {
  const { measure, hairMask } = fixture();
  const bald = buildBaldMask({ hairMask, measure });
  const keep = buildSideHairKeepMask(measure);
  assert.doesNotThrow(() => assertBaldMaskRespectsKeep({
    baldMask: bald,
    keepMask: keep,
    measure,
    threshold: 0.5,
  }));
  let maxProtect = 0;
  for (let y = Math.floor(measure.browTopY); y < measure.height; y++) {
    for (let x = 0; x < measure.width; x++) {
      maxProtect = Math.max(maxProtect, bald[y * measure.width + x]);
    }
  }
  assert.equal(maxProtect, 0);
});

test("prefillBaseline leaves protect-region pixels unchanged", async () => {
  const { measure, hairMask, imageData } = fixture();
  const src = new Uint8ClampedArray(imageData.data);
  const result = await prefillBaseline({ imageData, hairMask, measure });
  assert.ok(assertProtectRegionUnchanged(
    src,
    result.rgba,
    measure.width,
    measure.height,
    measure.browTopY,
  ));
  assert.equal(result.prefillBaseline.type, "image/jpeg");
  assert.equal(result.baldMask.type, "image/png");
});
