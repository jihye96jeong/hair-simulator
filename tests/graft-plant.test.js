import test from "node:test";
import assert from "node:assert/strict";
import {
  GOALS,
  GRAFTS_PER_TAP,
  GROW_MS,
  MAX_DENSITY_PER_CM2,
  PATCH_DENSITY_PER_CM2,
  PATCH_SPILL,
  SHADE_COUNT,
  STRAND_LEN_CM,
  affineFromPoints,
  applyAffine,
  blendAffine,
  countWithin,
  createPlanting,
  flowDirection,
  growth,
  headFrame,
  invertAffine,
  landmarkPixels,
  mulberry32,
  patchRadius,
  planPatch,
  sampleHairColor,
  shadeColors,
  toHeadSpace,
  trackPoints,
} from "../public/graftPlant.js";

/** Synthetic 478-point face (normalized) in a 720×960 picture; eyes 0.3 apart, irises 0.04 wide. */
function face({ dx = 0, dy = 0, scale = 1, roll = 0 } = {}) {
  const base = new Array(478).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0 }));
  const put = (i, x, y) => {
    // rotate around the centre by roll, scale, shift
    const cx = x - 0.5;
    const cy = y - 0.5;
    base[i] = {
      x: 0.5 + (cx * Math.cos(roll) - cy * Math.sin(roll)) * scale + dx,
      y: 0.5 + (cx * Math.sin(roll) + cy * Math.cos(roll)) * scale + dy,
      z: 0,
    };
  };
  put(33, 0.35, 0.45); put(263, 0.65, 0.45); // outer eye corners
  put(133, 0.42, 0.45); put(362, 0.58, 0.45); // inner corners
  put(10, 0.5, 0.2); // forehead top
  put(54, 0.36, 0.26); put(284, 0.64, 0.26); // temples
  put(168, 0.5, 0.44); put(6, 0.5, 0.47); // nasion / bridge
  put(234, 0.3, 0.55); put(454, 0.7, 0.55); // sides
  put(152, 0.5, 0.78); // chin (not tracked)
  const iris = (c, cx, cy) => {
    put(c, cx, cy); put(c + 1, cx + 0.02, cy); put(c + 2, cx, cy - 0.015); put(c + 3, cx - 0.02, cy); put(c + 4, cx, cy + 0.015);
  };
  iris(468, 0.385, 0.45);
  iris(473, 0.615, 0.45);
  return base;
}

const W = 720;
const H = 960;

test("affineFromPoints recovers a similarity and inverts back", () => {
  const src = landmarkPixels(face(), W, H);
  const dst = landmarkPixels(face({ dx: 0.05, dy: -0.03, scale: 1.2, roll: 0.15 }), W, H);
  const t = affineFromPoints(trackPoints(src), trackPoints(dst));
  assert.ok(t);
  for (const i of [10, 33, 263, 454]) {
    const p = applyAffine(t, src[i]);
    assert.ok(Math.hypot(p.x - dst[i].x, p.y - dst[i].y) < 0.5, `point ${i}`);
  }
  const inv = invertAffine(t);
  const back = applyAffine(inv, applyAffine(t, { x: 100, y: 200 }));
  assert.ok(Math.abs(back.x - 100) < 1e-6 && Math.abs(back.y - 200) < 1e-6);
  // collinear points → null
  assert.equal(affineFromPoints([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]), null);
  const half = blendAffine(t, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, 0.5);
  assert.ok(Math.abs(half.a - (t.a + 1) / 2) < 1e-9);
});

test("headFrame: px per cm from the irises, up points to the forehead", () => {
  const pts = landmarkPixels(face(), W, H);
  const frame = headFrame(pts);
  assert.ok(frame);
  assert.ok(Math.abs(frame.span - 0.3 * W) < 1e-6);
  // iris 0.04 wide horizontally, 0.03 tall → mean 0.035 of 720 px ≈ 25.2 px per 1.17 cm
  assert.ok(Math.abs(frame.pxPerCm - ((0.04 * W + 0.03 * H) / 2) / 1.17) < 1e-6);
  assert.ok(frame.up.y < -0.99);
  const above = toHeadSpace(frame, pts[10]);
  assert.ok(above.v > 0.9 && Math.abs(above.u) < 0.05);
});

test("flowDirection: hairline falls forward and outward, crown swirls, face hangs down", () => {
  const frame = headFrame(landmarkPixels(face(), W, H));
  const at = (u, v) => ({
    x: frame.eyeMid.x + (frame.right.x * u + frame.up.x * v) * frame.span,
    y: frame.eyeMid.y + (frame.right.y * u + frame.up.y * v) * frame.span,
  });
  const left = flowDirection(frame, at(-0.5, 0.9));
  const right = flowDirection(frame, at(0.5, 0.9));
  assert.ok(left.y > 0.6 && right.y > 0.6, "hairline hair points down the forehead");
  assert.ok(left.x < -0.1 && right.x > 0.1, "and outward toward the temples");
  const crownA = flowDirection(frame, at(0.4, 1.75));
  const crownB = flowDirection(frame, at(-0.3, 1.75));
  assert.ok(Math.abs(crownA.y) > 0.5 && Math.abs(crownB.y) > 0.5, "crown hair runs tangentially around the whorl");
  assert.ok(Math.sign(crownA.y) !== Math.sign(crownB.y), "opposite sides of the whorl run opposite ways");
  const nose = flowDirection(frame, at(0, 0));
  assert.ok(nose.y > 0.99, "hair planted on the face just hangs down");
  const jittered = flowDirection(frame, at(0, 0), 0.3);
  assert.ok(Math.abs(Math.hypot(jittered.x, jittered.y) - 1) < 1e-9);
});

test("growth eases from 0 to 1 over GROW_MS", () => {
  assert.equal(growth(0), 0);
  assert.ok(growth(GROW_MS / 2) > 0.5 && growth(GROW_MS / 2) < 1);
  assert.equal(growth(GROW_MS), 1);
  assert.equal(growth(GROW_MS * 3), 1);
  let prev = -1;
  for (let t = 0; t <= GROW_MS; t += 250) {
    assert.ok(growth(t) >= prev);
    prev = growth(t);
  }
});

test("planPatch: 100 units at surgical density, 1–3 hairs each, within the radius; repeat taps spread", () => {
  const pts = landmarkPixels(face(), W, H);
  const frame = headFrame(pts);
  const pxPerCm = frame.pxPerCm;
  const center = { x: frame.eyeMid.x, y: frame.eyeMid.y - frame.span * 1.0 };
  const rng = mulberry32(7);
  const patch = planPatch({ center, frame, pxPerCm, rng, bornAt: 123 });
  assert.equal(patch.count, GRAFTS_PER_TAP);
  assert.equal(patch.bornAt, 123);
  const expectedR = Math.sqrt(GRAFTS_PER_TAP / (PATCH_DENSITY_PER_CM2 * Math.PI)) * pxPerCm;
  assert.ok(Math.abs(patch.radius - expectedR) < 1e-9, "first tap is one pass at PATCH_DENSITY");
  assert.ok(patch.radius / pxPerCm > 0.8 && patch.radius / pxPerCm < 1.1, "≈ 1 cm radius");
  const inside = countWithin(patch.centers, center, patch.radius + 1e-6);
  assert.ok(inside >= GRAFTS_PER_TAP * 0.7 && inside < GRAFTS_PER_TAP, `most units inside the radius (${inside})`);
  assert.equal(countWithin(patch.centers, center, patch.radius * (1 + PATCH_SPILL) + 1e-6), GRAFTS_PER_TAP, "all within the feathered rim");
  const strands = patch.shades.reduce((n, arr) => n + arr.length / 6, 0);
  assert.ok(strands >= GRAFTS_PER_TAP && strands <= GRAFTS_PER_TAP * 3);
  assert.ok(strands > GRAFTS_PER_TAP * 1.6 && strands < GRAFTS_PER_TAP * 2.4, `mean ≈ 2 hairs per unit (${strands})`);
  assert.equal(patch.shades.length, SHADE_COUNT);
  for (const arr of patch.shades) {
    for (let i = 0; i < arr.length; i += 6) {
      assert.ok(Math.abs(Math.hypot(arr[i + 2], arr[i + 3]) - 1) < 1e-6, "unit direction");
      assert.ok(arr[i + 4] / pxPerCm >= STRAND_LEN_CM.min && arr[i + 4] / pxPerCm <= STRAND_LEN_CM.max, "length within STRAND_LEN_CM");
    }
  }
  // Tapping the same spot again: the second patch must widen so density stays under the cap.
  const second = planPatch({ center, frame, pxPerCm, rng, existing: patch.centers });
  assert.ok(second.radius > patch.radius * 1.1, `second tap spreads (${second.radius} > ${patch.radius})`);
  const all = new Float32Array([...patch.centers, ...second.centers]);
  const density = countWithin(all, center, second.radius) / (Math.PI * (second.radius / pxPerCm) ** 2);
  assert.ok(density <= MAX_DENSITY_PER_CM2 + 1e-6, `density ${density} ≤ cap`);
  assert.equal(patchRadius({ center: { x: 0, y: 0 }, existing: new Float32Array(0), pxPerCm: 30 }), Math.sqrt(100 / (35 * Math.PI)) * 30);
});

test("createPlanting: 100 per tap up to the chosen goal, raise/reset", () => {
  const pts = landmarkPixels(face(), W, H);
  const frame = headFrame(pts);
  const planting = createPlanting({ goal: 2000, rng: mulberry32(1) });
  const plant = (n = 1) => {
    let last = null;
    for (let i = 0; i < n; i++) last = planting.plant({ center: { x: 300 + i, y: 200 }, frame, pxPerCm: frame.pxPerCm, now: 1000 + i });
    return last;
  };
  assert.equal(planting.remaining, 2000);
  assert.ok(plant());
  assert.equal(planting.planted, 100);
  assert.ok(planting.growing(1500));
  assert.equal(planting.growing(1000 + GROW_MS + 1), false);
  plant(19);
  assert.equal(planting.planted, 2000);
  assert.equal(planting.done, true);
  assert.equal(plant(), null, "goal reached: no more planting");
  assert.equal(planting.centers.length, 2000 * 2);
  assert.equal(planting.setGoal(2500), false);
  assert.equal(planting.setGoal(3000), true);
  assert.equal(planting.done, false);
  assert.equal(planting.remaining, 1000);
  // Lower goal than planted → done, planting blocked, nothing removed.
  planting.setGoal(1000);
  assert.equal(planting.done, true);
  assert.equal(plant(), null);
  assert.equal(planting.planted, 2000);
  planting.reset();
  assert.equal(planting.planted, 0);
  assert.equal(planting.patches.length, 0);
  assert.equal(planting.centers.length, 0);
  // Missing anchor → null
  assert.equal(planting.plant({ center: null, frame, pxPerCm: 30 }), null);
  assert.equal(planting.plant({ center: { x: 1, y: 1 }, frame, pxPerCm: 0 }), null);
  assert.deepEqual(GOALS, [1000, 2000, 3000]);
});

test("createPlanting: the last tap before the goal plants only what is left", () => {
  const frame = headFrame(landmarkPixels(face(), W, H));
  const planting = createPlanting({ goal: 1000, rng: mulberry32(2) });
  for (let i = 0; i < 9; i++) planting.plant({ center: { x: 300, y: 200 + i * 40 }, frame, pxPerCm: frame.pxPerCm });
  assert.equal(planting.remaining, 100);
  const last = planting.plant({ center: { x: 300, y: 600 }, frame, pxPerCm: frame.pxPerCm });
  assert.equal(last.count, 100);
  assert.equal(planting.done, true);
});

test("sampleHairColor: dark pixels above the forehead set the shades, else a natural fallback", () => {
  const pts = landmarkPixels(face(), W, H);
  const rgba = new Uint8ClampedArray(W * H * 4).fill(230); // bright background
  // paint dark brown hair above the forehead (y < 0.2·H)
  for (let y = 0; y < Math.round(0.2 * H); y++) {
    for (let x = Math.round(0.3 * W); x < Math.round(0.7 * W); x++) {
      const o = (y * W + x) * 4;
      rgba[o] = 60; rgba[o + 1] = 40; rgba[o + 2] = 30; rgba[o + 3] = 255;
    }
  }
  const stats = sampleHairColor(rgba, W, H, pts);
  assert.ok(Math.abs(stats.mean[0] - 60) < 1 && Math.abs(stats.mean[2] - 30) < 1, JSON.stringify(stats.mean));
  const shades = shadeColors(stats);
  assert.equal(shades.length, SHADE_COUNT);
  assert.ok(shades.every((s) => /^rgb\(\d+,\d+,\d+\)$/.test(s)));
  const bright = sampleHairColor(new Uint8ClampedArray(W * H * 4).fill(230), W, H, pts);
  assert.deepEqual(bright.mean, [38, 27, 21]);
  assert.deepEqual(sampleHairColor(null, W, H, pts).mean, [38, 27, 21]);
});
