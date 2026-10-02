import test from "node:test";
import assert from "node:assert/strict";
import {
  categoryMaskFromLabels,
  crownCenterFromMasks,
  hairlineCurveFromMasks,
  headWidthFromHairMask,
  irisDiameterPx,
  measureCrownFromInputs,
  measureFrontFromInputs,
  median,
  medianMeasure,
  pxPerCmFromIrises,
  assertBaselineForeheadGain,
  BASELINE_FOREHEAD_GAIN_MIN_CM,
  LEFT_IRIS,
  RIGHT_IRIS,
} from "../public/faceGeometry.js";

function fakeLandmarks() {
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  // brows
  for (const i of [70, 105, 300, 334]) pts[i] = { x: 0.5, y: 0.32, z: 0 };
  // eyes
  for (const i of [33, 133, 263, 362]) pts[i] = { x: 0.5, y: 0.4, z: 0 };
  // temples
  pts[54] = { x: 0.22, y: 0.3, z: 0 };
  pts[284] = { x: 0.78, y: 0.3, z: 0 };
  // left iris ~12px at 200x200 → normalized
  for (const i of LEFT_IRIS) pts[i] = { x: 0.4 + (i - 468) * 0.01, y: 0.4, z: 0 };
  pts[468] = { x: 0.37, y: 0.4, z: 0 };
  pts[469] = { x: 0.43, y: 0.4, z: 0 };
  pts[470] = { x: 0.4, y: 0.37, z: 0 };
  pts[471] = { x: 0.4, y: 0.43, z: 0 };
  pts[472] = { x: 0.4, y: 0.4, z: 0 };
  for (const i of RIGHT_IRIS) pts[i] = { x: 0.6 + (i - 473) * 0.01, y: 0.4, z: 0 };
  pts[473] = { x: 0.57, y: 0.4, z: 0 };
  pts[474] = { x: 0.63, y: 0.4, z: 0 };
  pts[475] = { x: 0.6, y: 0.37, z: 0 };
  pts[476] = { x: 0.6, y: 0.43, z: 0 };
  pts[477] = { x: 0.6, y: 0.4, z: 0 };
  return pts;
}

test("median and iris pxPerCm from fake landmarks", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const pts = fakeLandmarks().map((p) => ({ x: p.x * 200, y: p.y * 200 }));
  const left = irisDiameterPx(pts, LEFT_IRIS);
  const right = irisDiameterPx(pts, RIGHT_IRIS);
  assert.ok(left > 0 && right > 0);
  const pcm = pxPerCmFromIrises(pts);
  assert.ok(pcm > 0);
});

test("hairline curve and front measure from fake masks", () => {
  const width = 80;
  const height = 100;
  const labels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      // Keep hairline high enough for FOREHEAD_EXPOSE_MIN_CM (temporary).
      if (y < 16 + Math.sin(x / 10) * 2) labels[i] = 1; // hair
      else if (y < 70) labels[i] = 3; // face skin
    }
  }
  const hairMask = categoryMaskFromLabels(labels, width, height, 1);
  const faceMask = categoryMaskFromLabels(labels, width, height, 3);
  const curve = hairlineCurveFromMasks({ hairMask, faceMask, width, height, browTopY: 40, sampleCount: 20 });
  assert.ok(curve.length >= 10);
  const measure = measureFrontFromInputs({
    landmarks: fakeLandmarks(),
    width,
    height,
    hairMask,
    faceMask,
  });
  assert.equal(measure.kind, "front");
  assert.ok(measure.pxPerCm > 0);
  assert.ok(measure.foreheadExposeCm >= 2.5);
  assert.ok(measure.templeLeft.x < measure.templeRight.x);
});

test("front measure rejects bangs covering forehead", () => {
  const width = 80;
  const height = 100;
  const labels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (y < 30) labels[i] = 1; // hair almost to brow (~32)
      else if (y < 70) labels[i] = 3;
    }
  }
  assert.throws(() => measureFrontFromInputs({
    landmarks: fakeLandmarks(),
    width,
    height,
    hairMask: categoryMaskFromLabels(labels, width, height, 1),
    faceMask: categoryMaskFromLabels(labels, width, height, 3),
  }), /앞머리를 넘겨/);
});

test("crown measure finds center and rejects tiny hair", () => {
  const width = 60;
  const height = 60;
  const hairMask = new Uint8Array(width * height);
  const faceMask = new Uint8Array(width * height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 5; y < 40; y++) {
    for (let x = 10; x < 50; x++) {
      const i = y * width + x;
      hairMask[i] = 1;
      if (y > 12 && y < 22 && x > 25 && x < 35) {
        faceMask[i] = 1;
        rgba[i * 4] = 200;
        rgba[i * 4 + 1] = 180;
        rgba[i * 4 + 2] = 160;
        rgba[i * 4 + 3] = 255;
      }
    }
  }
  assert.ok(headWidthFromHairMask(hairMask, width, height) > 20);
  const center = crownCenterFromMasks({ hairMask, faceMask, width, height, rgba });
  assert.ok(center.x > 20 && center.x < 40);
  const measure = measureCrownFromInputs({ hairMask, faceMask, width, height, rgba });
  assert.equal(measure.kind, "crown");
  assert.ok(measure.pxPerCm > 0);

  const tiny = new Uint8Array(width * height);
  tiny[0] = 1;
  assert.throws(() => measureCrownFromInputs({
    hairMask: tiny, faceMask, width, height, rgba,
  }));
});

test("medianMeasure stabilizes front samples", () => {
  const labels = Uint8Array.from({ length: 80 * 100 }, (_, i) => (Math.floor(i / 80) < 16 ? 1 : 3));
  const base = measureFrontFromInputs({
    landmarks: fakeLandmarks(),
    width: 80,
    height: 100,
    hairMask: categoryMaskFromLabels(labels, 80, 100, 1),
    faceMask: categoryMaskFromLabels(labels, 80, 100, 3),
  });
  const jittered = [0, 1, -1].map((d) => ({
    ...base,
    browTopY: base.browTopY + d,
    pxPerCm: base.pxPerCm + d * 0.01,
    hairlineCurve: base.hairlineCurve.map((p) => ({ x: p.x, y: p.y + d })),
    templeLeft: { x: base.templeLeft.x, y: base.templeLeft.y + d },
    templeRight: { x: base.templeRight.x, y: base.templeRight.y + d },
  }));
  const mid = medianMeasure(jittered);
  assert.equal(mid.browTopY, base.browTopY);
});

test("assertBaselineForeheadGain requires ≥ 3.0cm gain", () => {
  assert.equal(BASELINE_FOREHEAD_GAIN_MIN_CM, 3.0);
  assert.equal(assertBaselineForeheadGain({ captureCm: 1.0, baselineCm: 4.5 }), 3.5);
  assert.throws(
    () => assertBaselineForeheadGain({ captureCm: 2.0, baselineCm: 4.5 }),
    (err) => err.code === "baseline-forehead-fail" && /시술 전/.test(err.message),
  );
  assert.throws(
    () => assertBaselineForeheadGain({ captureCm: NaN, baselineCm: 5 }),
    (err) => err.code === "baseline-forehead-fail",
  );
});

test("MediaPipe block gate and closeMediaPipe are safe without models", async () => {
  const {
    blockMediaPipe,
    closeMediaPipe,
    isMediaPipeBlocked,
    unblockMediaPipe,
  } = await import("../public/faceGeometry.js");
  unblockMediaPipe();
  assert.equal(isMediaPipeBlocked(), false);
  blockMediaPipe(50);
  assert.equal(isMediaPipeBlocked(), true);
  await closeMediaPipe();
  unblockMediaPipe();
  assert.equal(isMediaPipeBlocked(), false);
});
