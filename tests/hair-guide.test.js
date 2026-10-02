import test from "node:test";
import assert from "node:assert/strict";
import { alignHairFaces } from "../public/hairGuide.js";
import { FACE_OVAL_RING, EYEBROW_INDICES, EYE_INDICES } from "../public/faceMask.js";

function landmarks({ cx = 0.5, cy = 0.52, rx = 0.18, ry = 0.24, browY = 0.38, eyeY = 0.46, yaw = 0 } = {}) {
  const pts = Array.from({ length: 478 }, () => ({ x: cx, y: cy, z: 0 }));
  FACE_OVAL_RING.forEach((idx, i) => {
    const t = (i / FACE_OVAL_RING.length) * Math.PI * 2 - Math.PI / 2;
    pts[idx] = { x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry, z: 0 };
  });
  for (const i of EYEBROW_INDICES) pts[i] = { x: cx, y: browY, z: 0 };
  for (const i of EYE_INDICES) pts[i] = { x: cx, y: eyeY, z: 0 };
  pts[33] = { x: cx - 0.06 + yaw, y: eyeY, z: 0 };
  pts[263] = { x: cx + 0.06 + yaw, y: eyeY, z: 0 };
  pts[1] = { x: cx + yaw * 0.4, y: cy, z: 0 };
  pts[61] = { x: cx - 0.04, y: cy + 0.1, z: 0 };
  pts[291] = { x: cx + 0.04, y: cy + 0.1, z: 0 };
  return pts;
}

test("alignHairFaces accepts near-matching frontal faces", () => {
  const fit = alignHairFaces(landmarks(), landmarks({ cx: 0.51 }), { width: 200, height: 300 }, { width: 200, height: 300 });
  assert.ok(Number.isFinite(fit.a));
  assert.ok(fit.residual < 0.065);
});

test("alignHairFaces rejects large yaw differences", () => {
  assert.throws(
    () => alignHairFaces(landmarks({ yaw: 0.2 }), landmarks({ yaw: -0.2 }), { width: 200, height: 300 }, { width: 200, height: 300 }),
    /alignment-pose-or-fit/,
  );
});
