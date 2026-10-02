import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGraftMask,
  assertProtectedRegionUnmasked,
  assertHairlineMaskWidth,
  MASK_FACE_WIDTH_MIN_RATIO,
  featherMask,
  buildFillMask,
} from "../public/graftGuide.js";
import { categoryMaskFromLabels, measureFrontFromInputs, measureCrownFromInputs } from "../public/faceGeometry.js";

function frontBaselineFixture() {
  const width = 96;
  const height = 120;
  const labels = new Uint8Array(width * height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const o = i * 4;
      const side = x < 14 || x > 81;
      const highHair = side && y < 70;
      if (highHair) {
        labels[i] = 1;
        rgba[o] = 30; rgba[o + 1] = 20; rgba[o + 2] = 14; rgba[o + 3] = 255;
      } else if (y < 18) {
        labels[i] = 3;
        rgba[o] = 210; rgba[o + 1] = 180; rgba[o + 2] = 160; rgba[o + 3] = 255;
      } else {
        labels[i] = 3;
        rgba[o] = 200; rgba[o + 1] = 170; rgba[o + 2] = 150; rgba[o + 3] = 255;
      }
    }
  }
  for (let y = 0; y < 12; y++) {
    for (let x = 20; x < 76; x++) {
      const i = y * width + x;
      labels[i] = 1;
      const o = i * 4;
      rgba[o] = 35; rgba[o + 1] = 24; rgba[o + 2] = 16; rgba[o + 3] = 255;
    }
  }
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  for (const i of [70, 105, 300, 334]) landmarks[i] = { x: 0.5, y: 0.42, z: 0 };
  landmarks[54] = { x: 0.22, y: 0.18, z: 0 };
  landmarks[284] = { x: 0.78, y: 0.18, z: 0 };
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
  return {
    measure,
    hairMask,
    faceMask,
    imageData: { width, height, data: rgba },
  };
}

test("buildGraftMask is deterministic mask-only and protects brow", async () => {
  const fixture = frontBaselineFixture();
  const a = await buildGraftMask({ ...fixture, area: "hairline", grafts: 2000 });
  const b = await buildGraftMask({ ...fixture, area: "hairline", grafts: 2000 });
  assert.equal(a.stats.hash, b.stats.hash);
  assert.ok(a.stats.featherPx > 0);
  assert.equal(a.mask.type, "image/png");
  assert.ok(assertProtectedRegionUnmasked(
    a.fillMask,
    fixture.measure.width,
    fixture.measure.height,
    fixture.measure.browTopY,
  ));
});

test("mask filled pixels increase 1000 → 2000 → 3000", async () => {
  const fixture = frontBaselineFixture();
  for (const area of ["hairline", "mline"]) {
    const g1 = await buildGraftMask({ ...fixture, area, grafts: 1000 });
    const g2 = await buildGraftMask({ ...fixture, area, grafts: 2000 });
    const g3 = await buildGraftMask({ ...fixture, area, grafts: 3000 });
    assert.ok(g1.stats.filledPixels < g2.stats.filledPixels, `${area} 1k<2k`);
    assert.ok(g2.stats.filledPixels < g3.stats.filledPixels, `${area} 2k<3k`);
  }
});

test("hairline mask width must be ≥ 60% of face width", () => {
  const fixture = frontBaselineFixture();
  const hard = buildFillMask({ area: "hairline", measure: fixture.measure, sizeCm: 1.8 });
  assertHairlineMaskWidth({ fillMask: hard, measure: fixture.measure });

  const narrow = new Float32Array(fixture.measure.width * fixture.measure.height);
  const mid = Math.floor(fixture.measure.width / 2);
  for (let y = 10; y < 30; y++) {
    for (let x = mid - 2; x <= mid + 2; x++) narrow[y * fixture.measure.width + x] = 1;
  }
  assert.throws(
    () => assertHairlineMaskWidth({ fillMask: narrow, measure: fixture.measure }),
    (err) => err.code === "mask-width-fail" && /정면/.test(err.message),
  );
  assert.equal(MASK_FACE_WIDTH_MIN_RATIO, 0.6);
});

test("crown fill grows with graft level", async () => {
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
  for (let y = 20; y < 45; y++) {
    for (let x of [2, 3, 60, 61]) {
      hairMask[y * width + x] = 1;
      rgba[(y * width + x) * 4] = 25;
    }
  }
  const measure = measureCrownFromInputs({ hairMask, faceMask, width, height, rgba });
  const c1 = await buildGraftMask({ measure, area: "crown", grafts: 1000 });
  const c3 = await buildGraftMask({ measure, area: "crown", grafts: 3000 });
  assert.ok(c1.stats.filledPixels < c3.stats.filledPixels);
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
