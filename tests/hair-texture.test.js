import test from "node:test";
import assert from "node:assert/strict";
import {
  meanAlphaInMask,
  mulberry32,
  renderHairTextureLayer,
  seedFromKey,
} from "../public/hairTexture.js";
import { buildFillMask, buildGraftMask, buildPrefillGuide } from "../public/graftGuide.js";
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
      if ((side && y < 70) || y < 14) {
        labels[i] = 1;
        rgba[o] = 40; rgba[o + 1] = 28; rgba[o + 2] = 18; rgba[o + 3] = 255;
      } else {
        labels[i] = 3;
        rgba[o] = 205; rgba[o + 1] = 175; rgba[o + 2] = 155; rgba[o + 3] = 255;
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
  return { measure, imageData: { width, height, data: rgba } };
}

test("hairTexture is deterministic for the same seed", () => {
  const { measure, imageData } = fixture();
  const fillMask = buildFillMask({ area: "hairline", measure, sizeCm: 1.8 });
  const seed = seedFromKey("hairline:2000");
  const a = renderHairTextureLayer({
    width: measure.width,
    height: measure.height,
    fillMask,
    measure,
    area: "hairline",
    rgbaSource: imageData.data,
    seed,
    density: 0.8,
  });
  const b = renderHairTextureLayer({
    width: measure.width,
    height: measure.height,
    fillMask,
    measure,
    area: "hairline",
    rgbaSource: imageData.data,
    seed,
    density: 0.8,
  });
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
  const rng = mulberry32(seed);
  assert.ok(rng() >= 0 && rng() < 1);
});

test("prefillGuide mean alpha increases with graft density", async () => {
  const { measure, imageData } = fixture();
  const g1 = await buildPrefillGuide({ imageData, measure, area: "hairline", grafts: 1000 });
  const g2 = await buildPrefillGuide({ imageData, measure, area: "hairline", grafts: 2000 });
  const g3 = await buildPrefillGuide({ imageData, measure, area: "hairline", grafts: 3000 });
  assert.ok(g1.stats.meanAlpha < g2.stats.meanAlpha, "1k < 2k alpha");
  assert.ok(g2.stats.meanAlpha < g3.stats.meanAlpha, "2k < 3k alpha");
  assert.equal(g1.prefillGuide.type, "image/jpeg");
  const mask = await buildGraftMask({ measure, area: "hairline", grafts: 2000 });
  assert.ok(meanAlphaInMask(g2.textureRgba, mask.fillMask) > 0);
});
