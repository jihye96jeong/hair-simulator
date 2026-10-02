import test from "node:test";
import assert from "node:assert/strict";
import {
  ALIGNMENT_INDICES,
  buildFaceRestorePolygon,
  computeRestoreTopY,
  correctLabSample,
  estimateSimilarityTransform,
  featherRadiusFromFaceWidth,
  labChannelStats,
  polygonMaskAlpha,
  rgbToLab,
} from "../public/faceRestore.js";
import {
  EYEBROW_INDICES,
  EYE_INDICES,
  FACE_OVAL_RING,
  landmarksToPixels,
} from "../public/faceMask.js";

function syntheticLandmarks({ cx = 0.5, cy = 0.52, rx = 0.22, ry = 0.3, browY = 0.38, eyeY = 0.46 } = {}) {
  const landmarks = Array.from({ length: 478 }, () => ({ x: cx, y: cy, z: 0 }));
  FACE_OVAL_RING.forEach((idx, i) => {
    const t = (i / FACE_OVAL_RING.length) * Math.PI * 2 - Math.PI / 2;
    landmarks[idx] = { x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry, z: 0 };
  });
  for (const i of EYEBROW_INDICES) landmarks[i] = { x: cx, y: browY, z: 0 };
  for (const i of EYE_INDICES) landmarks[i] = { x: cx, y: eyeY, z: 0 };
  for (const i of ALIGNMENT_INDICES) landmarks[i] = { x: cx + (i % 2 ? 0.05 : -0.05), y: eyeY, z: 0 };
  landmarks[1] = { x: cx, y: cy, z: 0 };
  landmarks[61] = { x: cx - 0.04, y: cy + 0.12, z: 0 };
  landmarks[291] = { x: cx + 0.04, y: cy + 0.12, z: 0 };
  return landmarks;
}

test("computeRestoreTopY uses eyebrow upper line", () => {
  const points = landmarksToPixels(syntheticLandmarks({ browY: 0.38 }), 100, 100);
  assert.ok(Math.abs(computeRestoreTopY(points) - 38) < 0.01);
});

test("buildFaceRestorePolygon clips oval below brows", () => {
  const landmarks = syntheticLandmarks({ browY: 0.38 });
  const height = 300;
  const topY = computeRestoreTopY(landmarksToPixels(landmarks, 200, height));
  const polygon = buildFaceRestorePolygon(landmarks, 200, height);
  assert.ok(polygon.length >= 3);
  const minY = Math.min(...polygon.map((p) => p.y));
  assert.ok(Math.abs(minY - topY) < 2);
});

test("estimateSimilarityTransform maps aligned points", () => {
  const src = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
  const dst = [{ x: 10, y: 20 }, { x: 30, y: 20 }, { x: 10, y: 40 }];
  const { a, b, tx, ty } = estimateSimilarityTransform(src, dst);
  for (let i = 0; i < src.length; i++) {
    const x = src[i].x;
    const y = src[i].y;
    const px = a * x - b * y + tx;
    const py = b * x + a * y + ty;
    assert.ok(Math.abs(px - dst[i].x) < 1e-6);
    assert.ok(Math.abs(py - dst[i].y) < 1e-6);
  }
});

test("lab color correction shifts mean toward target", () => {
  const sourceStats = labChannelStats([rgbToLab(80, 90, 100), rgbToLab(82, 88, 102)]);
  const targetStats = labChannelStats([rgbToLab(120, 130, 140), rgbToLab(118, 132, 138)]);
  const corrected = correctLabSample(rgbToLab(81, 89, 101), sourceStats, targetStats);
  assert.ok(Math.abs(corrected.L - targetStats.L.mean) < 5);
});

test("polygonMaskAlpha feathers toward edges", () => {
  const square = [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }];
  const feather = featherRadiusFromFaceWidth(80);
  assert.equal(feather, 80 * 0.04);
  assert.equal(polygonMaskAlpha(50, 50, square, feather), 1);
  assert.ok(polygonMaskAlpha(10.5, 50, square, feather) < 1);
});
