import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGraftMask,
  assertProtectedRegionUnmasked,
  assertProtectedRegionUnchanged,
  featherMask,
} from "../public/graftGuide.js";
import { buildBaselineLoss } from "../public/baselineLoss.js";
import { categoryMaskFromLabels, measureFrontFromInputs, measureCrownFromInputs } from "../public/faceGeometry.js";
import { BASELINE } from "../public/graftRules.js";

function frontFixture() {
  const width = 96;
  const height = 120;
  const labels = new Uint8Array(width * height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const o = i * 4;
      // High hairline so forehead expose ≥ 2.5cm and baseline can recede.
      if (y < 18) {
        labels[i] = 1;
        rgba[o] = 30; rgba[o + 1] = 20; rgba[o + 2] = 15; rgba[o + 3] = 255;
      } else {
        labels[i] = 3;
        rgba[o] = 200; rgba[o + 1] = 170; rgba[o + 2] = 150; rgba[o + 3] = 255;
      }
    }
  }
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  for (const i of [70, 105, 300, 334]) landmarks[i] = { x: 0.5, y: 0.42, z: 0 };
  for (const i of [33, 133, 263, 362]) landmarks[i] = { x: 0.5, y: 0.48, z: 0 };
  landmarks[54] = { x: 0.2, y: 0.2, z: 0 };
  landmarks[284] = { x: 0.8, y: 0.2, z: 0 };
  landmarks[468] = { x: 0.38, y: 0.48, z: 0 };
  landmarks[469] = { x: 0.44, y: 0.48, z: 0 };
  landmarks[470] = { x: 0.41, y: 0.45, z: 0 };
  landmarks[471] = { x: 0.41, y: 0.51, z: 0 };
  landmarks[472] = { x: 0.41, y: 0.48, z: 0 };
  landmarks[473] = { x: 0.56, y: 0.48, z: 0 };
  landmarks[474] = { x: 0.62, y: 0.48, z: 0 };
  landmarks[475] = { x: 0.59, y: 0.45, z: 0 };
  landmarks[476] = { x: 0.59, y: 0.51, z: 0 };
  landmarks[477] = { x: 0.59, y: 0.48, z: 0 };
  const hairMask = categoryMaskFromLabels(labels, width, height, 1);
  const faceMask = categoryMaskFromLabels(labels, width, height, 3);
  const measure = measureFrontFromInputs({ landmarks, width, height, hairMask, faceMask });
  return {
    measure,
    hairMask,
    faceMask,
    imageData: { width, height, data: rgba },
  };
}

test("buildGraftMask is deterministic, feathered, and clears brow protect zone", async () => {
  const fixture = frontFixture();
  const a = await buildGraftMask({ ...fixture, area: "hairline", grafts: 2000 });
  const b = await buildGraftMask({ ...fixture, area: "hairline", grafts: 2000 });
  assert.equal(a.stats.hash, b.stats.hash);
  assert.ok(a.stats.featherPx > 0);
  assert.ok(assertProtectedRegionUnmasked(
    a.fillMask,
    fixture.measure.width,
    fixture.measure.height,
    fixture.measure.browTopY,
  ));
  assert.ok([...a.fillMask].some((v) => v > 0.05 && v < 0.95));
});

test("mask filled pixels increase with graft level", async () => {
  const fixture = frontFixture();
  const g1 = await buildGraftMask({ ...fixture, area: "hairline", grafts: 1000 });
  const g2 = await buildGraftMask({ ...fixture, area: "hairline", grafts: 2000 });
  const g3 = await buildGraftMask({ ...fixture, area: "hairline", grafts: 3000 });
  assert.ok(g1.stats.filledPixels < g2.stats.filledPixels);
  assert.ok(g2.stats.filledPixels < g3.stats.filledPixels);

  const m1 = await buildGraftMask({ ...fixture, area: "mline", grafts: 1000 });
  const m3 = await buildGraftMask({ ...fixture, area: "mline", grafts: 3000 });
  assert.ok(m1.stats.filledPixels < m3.stats.filledPixels);
});

test("baseline fill pixels grow 1000→2000→3000 and 3000 covers ≥90% of void", async () => {
  const fixture = frontFixture();
  for (const area of ["hairline", "mline"]) {
    const baseline = buildBaselineLoss({ ...fixture, area });
    assert.ok(baseline.stats.clearedPixels > 20, area);
    assert.ok(assertProtectedRegionUnchanged(
      fixture.imageData.data,
      baseline.imageData.data,
      fixture.measure.width,
      fixture.measure.height,
      fixture.measure.browTopY,
    ), `${area} protect`);

    const g1 = await buildGraftMask({ ...fixture, area, grafts: 1000, baselineLoss: baseline });
    const g2 = await buildGraftMask({ ...fixture, area, grafts: 2000, baselineLoss: baseline });
    const g3 = await buildGraftMask({ ...fixture, area, grafts: 3000, baselineLoss: baseline });
    assert.ok(g1.stats.filledPixels < g2.stats.filledPixels, `${area} 1k<2k`);
    assert.ok(g2.stats.filledPixels < g3.stats.filledPixels, `${area} 2k<3k`);
    assert.ok(g3.stats.fillRatioOfVoid >= 0.9, `${area} 3k covers void (${g3.stats.fillRatioOfVoid})`);
    assert.ok(assertProtectedRegionUnmasked(
      g3.fillMask,
      fixture.measure.width,
      fixture.measure.height,
      fixture.measure.browTopY,
    ));
  }
});

test("crown mask fills more at higher grafts", async () => {
  const width = 64;
  const height = 64;
  const hairMask = new Uint8Array(width * height);
  const faceMask = new Uint8Array(width * height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 4; y < 50; y++) {
    for (let x = 8; x < 56; x++) {
      const i = y * width + x;
      hairMask[i] = 1;
      rgba[i * 4] = 40; rgba[i * 4 + 1] = 30; rgba[i * 4 + 2] = 20; rgba[i * 4 + 3] = 255;
      if (y > 16 && y < 28 && x > 26 && x < 38) {
        faceMask[i] = 1;
        rgba[i * 4] = 210; rgba[i * 4 + 1] = 190; rgba[i * 4 + 2] = 170;
      }
    }
  }
  const measure = measureCrownFromInputs({ hairMask, faceMask, width, height, rgba });
  const imageData = { width, height, data: rgba };
  const c1 = await buildGraftMask({ imageData, hairMask, measure, area: "crown", grafts: 1000 });
  const c3 = await buildGraftMask({ imageData, hairMask, measure, area: "crown", grafts: 3000 });
  assert.ok(c1.stats.filledPixels < c3.stats.filledPixels);

  const baseline = buildBaselineLoss({
    area: "crown",
    measure,
    imageData,
    hairMask,
    faceMask,
  });
  assert.equal(baseline.geometry.radiusCm, BASELINE.crown.radiusCm);
  const b1 = await buildGraftMask({ imageData, hairMask, measure, area: "crown", grafts: 1000, baselineLoss: baseline });
  const b2 = await buildGraftMask({ imageData, hairMask, measure, area: "crown", grafts: 2000, baselineLoss: baseline });
  const b3 = await buildGraftMask({ imageData, hairMask, measure, area: "crown", grafts: 3000, baselineLoss: baseline });
  assert.ok(b1.stats.filledPixels < b2.stats.filledPixels);
  assert.ok(b2.stats.filledPixels < b3.stats.filledPixels);
  assert.ok(b3.stats.fillRatioOfVoid >= 0.9, `crown 3k ${b3.stats.fillRatioOfVoid}`);
});

test("featherMask softens hard edges", () => {
  const width = 8;
  const height = 8;
  const hard = new Float32Array(width * height);
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) hard[y * width + x] = 1;
  const soft = featherMask(hard, width, height, 1);
  assert.ok(soft[3 * width + 3] > 0.5);
  assert.ok(soft[1 * width + 3] > 0 && soft[1 * width + 3] < 1);
});
