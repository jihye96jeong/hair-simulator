import test from "node:test";
import assert from "node:assert/strict";
import {
  EYEBROW_EYE_GAP_FACTOR,
  EYEBROW_INDICES,
  EYE_INDICES,
  FACE_OVAL_RING,
  MASK_FILL,
  MASK_SIDE_INSET,
  buildFaceMaskPolygon,
  computeMaskTopY,
  landmarksToPixels,
  polygonMeanColor,
} from "../public/faceMask.js";

function syntheticLandmarks({
  cx = 0.5,
  cy = 0.52,
  rx = 0.22,
  ry = 0.3,
  browY = 0.4,
  eyeY = 0.46,
} = {}) {
  const landmarks = Array.from({ length: 478 }, () => ({ x: cx, y: cy, z: 0 }));
  FACE_OVAL_RING.forEach((idx, i) => {
    const t = (i / FACE_OVAL_RING.length) * Math.PI * 2 - Math.PI / 2;
    landmarks[idx] = { x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry, z: 0 };
  });
  for (const i of EYEBROW_INDICES) landmarks[i] = { x: cx, y: browY, z: 0 };
  for (const i of EYE_INDICES) landmarks[i] = { x: cx, y: eyeY, z: 0 };
  return landmarks;
}

test("computeMaskTopY sits 0.3 of the brow–eye gap below the brows", () => {
  const points = landmarksToPixels(syntheticLandmarks({ browY: 0.4, eyeY: 0.5 }), 100, 100);
  const topY = computeMaskTopY(points);
  assert.ok(Math.abs(topY - (40 + 10 * EYEBROW_EYE_GAP_FACTOR)) < 1e-6);
});

test("buildFaceMaskPolygon stays below brows and follows the oval chin", () => {
  const width = 200;
  const height = 300;
  const landmarks = syntheticLandmarks();
  const polygon = buildFaceMaskPolygon(landmarks, width, height);
  assert.ok(polygon.length >= 3);
  const topY = computeMaskTopY(landmarksToPixels(landmarks, width, height));
  for (const p of polygon) {
    assert.ok(p.y + 1e-6 >= topY, `point above mask top: ${p.y} < ${topY}`);
    assert.ok(p.x >= 0 && p.x <= width);
    assert.ok(p.y >= 0 && p.y <= height);
  }
  const maxY = Math.max(...polygon.map((p) => p.y));
  assert.ok(maxY > height * 0.6, "chin should be included");
  assert.equal(MASK_FILL, "#808080");
  const minX = Math.min(...polygon.map((p) => p.x));
  const maxX = Math.max(...polygon.map((p) => p.x));
  const fullWidth = 200 * 0.22 * 2;
  assert.ok(maxX - minX < fullWidth * (1 - MASK_SIDE_INSET / 2), "temples inset so side hair stays");
});

test("polygonMeanColor averages only pixels inside the polygon and falls back when unreadable", () => {
  const width = 10;
  const height = 10;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      // Left half skin-ish, right half blue.
      const skin = x < 5;
      data[o] = skin ? 200 : 0;
      data[o + 1] = skin ? 150 : 0;
      data[o + 2] = skin ? 120 : 255;
      data[o + 3] = 255;
    }
  }
  const ctx = {
    canvas: { width, height },
    getImageData: (x0, y0, w, h) => {
      const out = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) out.set(data.subarray(((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + w) * 4), y * w * 4);
      return { data: out };
    },
  };
  const leftSquare = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 10 }, { x: 0, y: 10 }];
  assert.equal(polygonMeanColor(ctx, leftSquare), "rgb(200, 150, 120)");
  const broken = { canvas: { width, height }, getImageData: () => { throw new Error("tainted"); } };
  assert.equal(polygonMeanColor(broken, leftSquare), MASK_FILL);
  assert.equal(polygonMeanColor(ctx, [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]), MASK_FILL);
});

test("buildFaceMaskPolygon rejects incomplete landmark sets", () => {
  assert.throws(() => buildFaceMaskPolygon([], 10, 10), /얼굴이 한 명만/);
  assert.throws(() => buildFaceMaskPolygon(Array(10).fill({ x: 0, y: 0 }), 10, 10), /얼굴이 한 명만/);
});
