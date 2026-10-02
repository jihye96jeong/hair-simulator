import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateYawDegrees,
  estimatePitchDegrees,
  evaluateShotQuality,
  livePoseFromAngles,
  SHOT_ORDER,
} from "../public/graftPose.js";
import {
  classifyHairState,
  analyzeHairFromShots,
  prefetchOrder,
  buildAnalysisInpaintPrompt,
} from "../public/graftAnalyze.js";
import { categoryMaskFromLabels, measureFrontFromInputs, measureCrownFromInputs } from "../public/faceGeometry.js";
import { LEFT_IRIS, RIGHT_IRIS } from "../public/faceGeometry.js";

test("shot order is front left right crown", () => {
  assert.deepEqual([...SHOT_ORDER], ["front", "left", "right", "crown"]);
});

test("yaw and pitch estimates respond to landmark shifts", () => {
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  pts[1] = { x: 0.55, y: 0.5 };
  pts[234] = { x: 0.3, y: 0.5 };
  pts[454] = { x: 0.7, y: 0.5 };
  pts[10] = { x: 0.5, y: 0.2 };
  pts[152] = { x: 0.5, y: 0.9 };
  const yaw = estimateYawDegrees(pts);
  assert.ok(yaw > 0);
  const pitch = estimatePitchDegrees(pts);
  assert.ok(Number.isFinite(pitch));
});

test("quality warnings for front yaw and multi-face", () => {
  const bad = evaluateShotQuality({ direction: "front", yaw: 30, pitch: 0, faceCount: 2, brightness: 0.5 });
  assert.equal(bad.ok, false);
  assert.ok(bad.warnings.some((w) => w.includes("여러")));
  const ok = evaluateShotQuality({ direction: "front", yaw: 2, pitch: 0, faceCount: 1, brightness: 0.5 });
  assert.equal(ok.ok, true);
  assert.equal(livePoseFromAngles(0, 35), "crown");
  assert.equal(livePoseFromAngles(-30, 0), "left");
});

function frontBundle() {
  const width = 64;
  const height = 80;
  const labels = new Uint8Array(width * height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const o = i * 4;
      if (y < 22) {
        labels[i] = 1;
        rgba[o] = 30; rgba[o + 1] = 20; rgba[o + 2] = 15; rgba[o + 3] = 255;
      } else {
        labels[i] = 3;
        rgba[o] = 200; rgba[o + 1] = 170; rgba[o + 2] = 150; rgba[o + 3] = 255;
      }
    }
  }
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  for (const i of [70, 105, 300, 334]) landmarks[i] = { x: 0.5, y: 0.35, z: 0 };
  landmarks[54] = { x: 0.2, y: 0.28, z: 0 };
  landmarks[284] = { x: 0.8, y: 0.28, z: 0 };
  for (const i of LEFT_IRIS) landmarks[i] = { x: 0.4, y: 0.42, z: 0 };
  landmarks[468] = { x: 0.37, y: 0.42, z: 0 };
  landmarks[469] = { x: 0.43, y: 0.42, z: 0 };
  for (const i of RIGHT_IRIS) landmarks[i] = { x: 0.6, y: 0.42, z: 0 };
  landmarks[473] = { x: 0.57, y: 0.42, z: 0 };
  landmarks[474] = { x: 0.63, y: 0.42, z: 0 };
  const hairMask = categoryMaskFromLabels(labels, width, height, 1);
  const faceMask = categoryMaskFromLabels(labels, width, height, 3);
  const measure = measureFrontFromInputs({ landmarks, width, height, hairMask, faceMask });
  return { imageData: { width, height, data: rgba }, hairMask, faceMask, measure };
}

test("classify and analyze produce type + needs + prefetch order", () => {
  const near = classifyHairState({
    hairRatioFront: 0.02,
    foreheadGap: 0.1,
    mlineRetreat: 0.8,
    frontDensity: 0.05,
    crownExposure: 0.5,
  });
  assert.equal(near.type, "near_bald");
  assert.equal(near.color, "black");
  assert.ok(near.needs.hairline && near.needs.mline && near.needs.crown);

  const front = frontBundle();
  const width = 64;
  const height = 64;
  const hairMask = new Uint8Array(width * height);
  const faceMask = new Uint8Array(width * height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 4; y < 40; y++) {
    for (let x = 10; x < 50; x++) {
      const i = y * width + x;
      hairMask[i] = 1;
      rgba[i * 4] = 40; rgba[i * 4 + 1] = 30; rgba[i * 4 + 2] = 20; rgba[i * 4 + 3] = 255;
      if (y > 12 && y < 22 && x > 25 && x < 35) {
        faceMask[i] = 1;
        rgba[i * 4] = 210; rgba[i * 4 + 1] = 190; rgba[i * 4 + 2] = 170;
      }
    }
  }
  const crownMeasure = measureCrownFromInputs({ hairMask, faceMask, width, height, rgba });
  const analysis = analyzeHairFromShots({
    front,
    left: front,
    right: front,
    crown: { imageData: { width, height, data: rgba }, hairMask, faceMask, measure: crownMeasure },
  });
  assert.ok(analysis.type);
  assert.ok(analysis.preferredArea);
  const order = prefetchOrder(analysis.preferredArea);
  assert.equal(order[0].grafts, 2000);
  assert.equal(order[0].area, analysis.preferredArea);
  assert.equal(order.length, 9);
  const prompt = buildAnalysisInpaintPrompt({ analysis, area: "hairline", grafts: 2000 });
  assert.ok(prompt.includes(`Match color ${analysis.color}`));
  assert.ok(prompt.includes("Density: medium"));
});
