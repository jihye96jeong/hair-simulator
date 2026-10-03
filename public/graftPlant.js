/**
 * 모수2 — touch planting (logic only, no DOM).
 *
 * The user taps the live picture; each tap plants GRAFTS_PER_TAP follicular units that grow
 * over a few seconds. Grafts live in a *reference head frame*: the pixel space of the face
 * landmarks of one anchor frame. Every video frame is related to that frame by an affine
 * transform fitted on stable landmarks, so planted hair follows the head (position, distance,
 * roll and most of yaw) and taps are stored where they landed on the head.
 *
 * Realism knobs (병원 확인 전 임시값):
 *   one pass of follicular units is planted at ~PATCH_DENSITY_PER_CM2; tapping a spot that is
 *   already dense spreads the new grafts outward instead of stacking past MAX_DENSITY_PER_CM2;
 *   a unit carries 1–3 hairs; hairs are a few mm to ~1 cm long once grown; direction follows
 *   the scalp (hairline falls forward and outward, the crown swirls).
 */

import { pxPerCmFromIrises } from "./faceGeometry.js";

export const GRAFTS_PER_TAP = 100;
export const GOALS = Object.freeze([1000, 2000, 3000]);
export const DEFAULT_GOAL = 2000;
/** Follicular units per cm² for one pass. */
export const PATCH_DENSITY_PER_CM2 = 35;
/** Above this a tap widens its patch instead of stacking more units on the same skin. */
export const MAX_DENSITY_PER_CM2 = 55;
/** Share of a tap's units that spill past its radius (feathered rim) and how far (× radius). */
export const PATCH_SPILL_FRACTION = 0.2;
export const PATCH_SPILL = 0.35;
/** Hairs per unit: P(1) P(2) P(3). Mean 2.0. */
export const HAIRS_PER_GRAFT_WEIGHTS = Object.freeze([0.25, 0.5, 0.25]);
/** Time for a planted unit to reach full length on screen. */
export const GROW_MS = 6000;
export const STRAND_LEN_CM = Object.freeze({ min: 0.7, max: 1.6 });
/** Real hair shaft width (cm). Strands are drawn near this: individual hairs are sub-pixel on a webcam. */
export const HAIR_WIDTH_CM = 0.007;
/** Drawn strand width in cm (slightly above the real shaft so coverage accumulates). */
export const STRAND_WIDTH_CM = 0.016;
/** Never thinner than this on screen. */
export const STRAND_MIN_PX = 0.7;
/** Strand opacity; hundreds of translucent strands build the texture, no single stroke reads. */
export const STRAND_ALPHA = 0.7;
/**
 * The scalp under hair reads darker than the strands that can be resolved: a soft density
 * shadow per patch, with coverage ≈ 1 − exp(−density · hairs · width · length · gain).
 */
export const SHADOW_GAIN = 1.3;
export const SHADOW_FEATHER = 1.35;
/** Hair layer blur (picture px) so strokes match the camera's softness. */
export const HAIR_BLUR_PX = 0.6;
export const SHADE_COUNT = 5;
/** Outer eye-corner span of an adult, used when the irises are not measurable. */
export const EYE_SPAN_CM = 9;
/** Landmarks the head-tracking affine is fitted on (no jaw: talking must not move hair). */
export const TRACK_INDICES = Object.freeze([10, 54, 284, 33, 263, 133, 362, 168, 6, 234, 454]);

const FLOAT_FIELDS = 6; // x, y, dx, dy, len, bend

export function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normalized landmarks → pixel points. */
export function landmarkPixels(landmarks, width, height) {
  return landmarks.map((p) => ({ x: p.x * width, y: p.y * height }));
}

/**
 * Least-squares affine `src → dst` in canvas `setTransform` order:
 *   x' = a·x + c·y + e,  y' = b·x + d·y + f
 * Needs ≥ 3 non-collinear points; returns null otherwise.
 */
export function affineFromPoints(src, dst) {
  const n = Math.min(src.length, dst.length);
  if (n < 3) return null;
  let sxx = 0; let sxy = 0; let syy = 0; let sx = 0; let sy = 0;
  let rxx = 0; let rxy = 0; let rx = 0;
  let ryx = 0; let ryy = 0; let ry = 0;
  for (let i = 0; i < n; i++) {
    const { x, y } = src[i];
    const qx = dst[i].x;
    const qy = dst[i].y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y;
    rxx += x * qx; rxy += y * qx; rx += qx;
    ryx += x * qy; ryy += y * qy; ry += qy;
  }
  const m = [sxx, sxy, sx, sxy, syy, sy, sx, sy, n];
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const inv = [
    (m[4] * m[8] - m[5] * m[7]) / det, (m[2] * m[7] - m[1] * m[8]) / det, (m[1] * m[5] - m[2] * m[4]) / det,
    (m[5] * m[6] - m[3] * m[8]) / det, (m[0] * m[8] - m[2] * m[6]) / det, (m[2] * m[3] - m[0] * m[5]) / det,
    (m[3] * m[7] - m[4] * m[6]) / det, (m[1] * m[6] - m[0] * m[7]) / det, (m[0] * m[4] - m[1] * m[3]) / det,
  ];
  const solve = (r0, r1, r2) => [
    inv[0] * r0 + inv[1] * r1 + inv[2] * r2,
    inv[3] * r0 + inv[4] * r1 + inv[5] * r2,
    inv[6] * r0 + inv[7] * r1 + inv[8] * r2,
  ];
  const [a, c, e] = solve(rxx, rxy, rx);
  const [b, d, f] = solve(ryx, ryy, ry);
  return { a, b, c, d, e, f };
}

export function applyAffine(t, p) {
  return { x: t.a * p.x + t.c * p.y + t.e, y: t.b * p.x + t.d * p.y + t.f };
}

export function invertAffine(t) {
  const det = t.a * t.d - t.b * t.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = t.d / det;
  const b = -t.b / det;
  const c = -t.c / det;
  const d = t.a / det;
  return { a, b, c, d, e: -(a * t.e + c * t.f), f: -(b * t.e + d * t.f) };
}

/** Uniform scale carried by the affine (geometric mean of the singular values). */
export function affineScale(t) {
  return Math.sqrt(Math.abs(t.a * t.d - t.b * t.c)) || 1;
}

/** Element-wise blend for smoothing: prev + (next - prev) * k. */
export function blendAffine(prev, next, k) {
  if (!prev) return { ...next };
  const out = {};
  for (const key of ["a", "b", "c", "d", "e", "f"]) out[key] = prev[key] + (next[key] - prev[key]) * k;
  return out;
}

/**
 * Head frame of a landmark set in pixels: eye midpoint, outer eye span, `right` along the eye
 * line (toward the image right) and `up` toward the forehead, plus px per cm.
 */
export function headFrame(points) {
  const l = points[33];
  const r = points[263];
  const top = points[10];
  if (!l || !r || !top) return null;
  const span = Math.hypot(r.x - l.x, r.y - l.y);
  if (!(span > 1)) return null;
  const eyeMid = { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  const right = { x: (r.x - l.x) / span, y: (r.y - l.y) / span };
  let up = { x: top.x - eyeMid.x, y: top.y - eyeMid.y };
  const ul = Math.hypot(up.x, up.y) || 1;
  up = { x: up.x / ul, y: up.y / ul };
  const iris = pxPerCmFromIrises(points);
  const pxPerCm = Number.isFinite(iris) && iris > 0 ? iris : span / EYE_SPAN_CM;
  return { eyeMid, span, right, up, pxPerCm };
}

/** Head-space coordinates of a pixel point: u lateral (right +), v vertical (up +), in eye spans. */
export function toHeadSpace(frame, p) {
  const dx = p.x - frame.eyeMid.x;
  const dy = p.y - frame.eyeMid.y;
  return {
    u: (dx * frame.right.x + dy * frame.right.y) / frame.span,
    v: (dx * frame.up.x + dy * frame.up.y) / frame.span,
  };
}

/**
 * Unit direction a hair grows in at pixel point `p` (reference frame). Hairline hair falls
 * toward the face and outward; the crown swirls; anything on the face just hangs down.
 */
export function flowDirection(frame, p, jitter = 0) {
  const { u, v } = toHeadSpace(frame, p);
  const { right, up } = frame;
  const rotate = (vec, ang) => ({
    x: vec.x * Math.cos(ang) - vec.y * Math.sin(ang),
    y: vec.x * Math.sin(ang) + vec.y * Math.cos(ang),
  });
  const down = { x: -up.x, y: -up.y };
  let dir;
  if (v > 1.35) {
    // Crown: tangent of a swirl around a point high on the head, slightly off centre.
    const cu = 0.08;
    const cv = 1.75;
    const du = u - cu;
    const dv = v - cv;
    const len = Math.hypot(du, dv) || 1;
    // tangent (clockwise seen from the front) blended with a little outward component
    const tu = -dv / len;
    const tv = du / len;
    const ou = du / len;
    const ov = dv / len;
    const mu = tu * 0.85 + ou * 0.35;
    const mv = tv * 0.85 + ov * 0.35;
    const ml = Math.hypot(mu, mv) || 1;
    dir = { x: (right.x * mu + up.x * mv) / ml, y: (right.y * mu + up.y * mv) / ml };
  } else if (v > 0.55) {
    // Hairline / front: forward (down the forehead) tilted outward toward the temples.
    const side = Math.max(-1, Math.min(1, u / 0.7));
    dir = rotate(down, -side * 0.45);
  } else {
    dir = down;
  }
  if (jitter) dir = rotate(dir, jitter);
  return dir;
}

/** 0..1 visible length fraction for a unit planted `ageMs` ago (fast start, eases to full). */
export function growth(ageMs) {
  const t = Math.max(0, Math.min(1, ageMs / GROW_MS));
  return 1 - (1 - t) * (1 - t);
}

function hairsFor(rng) {
  const r = rng();
  if (r < HAIRS_PER_GRAFT_WEIGHTS[0]) return 1;
  if (r < HAIRS_PER_GRAFT_WEIGHTS[0] + HAIRS_PER_GRAFT_WEIGHTS[1]) return 2;
  return 3;
}

/** Number of planted unit centres within `radius` px of `center`. */
export function countWithin(points, center, radius) {
  const r2 = radius * radius;
  let n = 0;
  for (let i = 0; i < points.length; i += 2) {
    const dx = points[i] - center.x;
    const dy = points[i + 1] - center.y;
    if (dx * dx + dy * dy <= r2) n += 1;
  }
  return n;
}

/**
 * Radius (px) for planting `count` units at `center`: one pass at PATCH_DENSITY_PER_CM2,
 * widened until the units already there plus the new ones stay under MAX_DENSITY_PER_CM2.
 */
export function patchRadius({ center, existing, pxPerCm, count = GRAFTS_PER_TAP }) {
  const base = Math.sqrt(count / (PATCH_DENSITY_PER_CM2 * Math.PI)) * pxPerCm;
  let r = base;
  for (let step = 0; step < 24; step++) {
    const areaCm2 = Math.PI * (r / pxPerCm) ** 2;
    const density = (countWithin(existing, center, r) + count) / areaCm2;
    if (density <= MAX_DENSITY_PER_CM2) break;
    r *= 1.12;
  }
  return r;
}

/**
 * Plan one tap: `count` units around `center` (reference-frame px). Strands are grouped by
 * shade so the renderer strokes one path per colour:
 *   { x, y, radius, count, bornAt, centers: Float32Array(count*2), shadow: 0..1 coverage,
 *     shades: Float32Array[SHADE_COUNT] of [x, y, dx, dy, len, bend]… }
 */
export function planPatch({ center, frame, pxPerCm, existing = new Float32Array(0), rng = Math.random, count = GRAFTS_PER_TAP, bornAt = 0 }) {
  const radius = patchRadius({ center, existing, pxPerCm, count });
  const centers = new Float32Array(count * 2);
  const buckets = Array.from({ length: SHADE_COUNT }, () => []);
  const spread = 0.04 * pxPerCm;
  for (let i = 0; i < count; i++) {
    const ang = rng() * Math.PI * 2;
    // Uniform disk with a feathered rim (~20% of units spill up to 1.35 r) so neighbouring taps
    // merge into one area instead of reading as separate discs.
    const spill = rng() < PATCH_SPILL_FRACTION ? 1 + PATCH_SPILL * rng() : 1;
    const rad = Math.sqrt(rng()) * radius * spill;
    const gx = center.x + Math.cos(ang) * rad;
    const gy = center.y + Math.sin(ang) * rad;
    centers[i * 2] = gx;
    centers[i * 2 + 1] = gy;
    const hairs = hairsFor(rng);
    for (let h = 0; h < hairs; h++) {
      const sx = gx + (rng() * 2 - 1) * spread;
      const sy = gy + (rng() * 2 - 1) * spread;
      const dir = flowDirection(frame, { x: sx, y: sy }, (rng() * 2 - 1) * 0.3);
      const len = (STRAND_LEN_CM.min + rng() * (STRAND_LEN_CM.max - STRAND_LEN_CM.min)) * pxPerCm;
      const bend = (rng() * 2 - 1) * 0.35;
      const shade = Math.min(SHADE_COUNT - 1, Math.floor(rng() * SHADE_COUNT));
      buckets[shade].push(sx, sy, dir.x, dir.y, len, bend);
    }
  }
  const areaCm2 = Math.PI * (radius / pxPerCm) ** 2;
  const density = count / areaCm2;
  const meanLen = (STRAND_LEN_CM.min + STRAND_LEN_CM.max) / 2;
  const shadow = 1 - Math.exp(-density * 2 * HAIR_WIDTH_CM * meanLen * SHADOW_GAIN);
  return {
    x: center.x,
    y: center.y,
    radius,
    count,
    bornAt,
    centers,
    shadow,
    shades: buckets.map((b) => Float32Array.from(b)),
  };
}

/**
 * Mean / spread of the user's own hair colour, sampled above the forehead and beside the
 * temples (dark pixels only). Falls back to a natural dark brown.
 */
export function sampleHairColor(rgba, width, height, points) {
  const frame = headFrame(points);
  const fallback = { mean: [38, 27, 21], std: [10, 8, 7] };
  if (!frame || !rgba) return fallback;
  const samples = [];
  const probe = (u0, u1, v0, v1) => {
    for (let v = v0; v <= v1; v += 0.05) {
      for (let u = u0; u <= u1; u += 0.05) {
        const px = frame.eyeMid.x + (frame.right.x * u + frame.up.x * v) * frame.span;
        const py = frame.eyeMid.y + (frame.right.y * u + frame.up.y * v) * frame.span;
        const x = Math.round(px);
        const y = Math.round(py);
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const o = (y * width + x) * 4;
        const lum = (rgba[o] + rgba[o + 1] + rgba[o + 2]) / 3;
        if (lum < 90) samples.push([rgba[o], rgba[o + 1], rgba[o + 2]]);
      }
    }
  };
  probe(-0.45, 0.45, 1.2, 1.9); // above the forehead
  probe(-0.95, -0.6, 0.2, 1.0); // left side
  probe(0.6, 0.95, 0.2, 1.0); // right side
  if (samples.length < 20) return fallback;
  const mean = [0, 0, 0];
  for (const c of samples) { mean[0] += c[0]; mean[1] += c[1]; mean[2] += c[2]; }
  for (let i = 0; i < 3; i++) mean[i] /= samples.length;
  const std = [0, 0, 0];
  for (const c of samples) { std[0] += (c[0] - mean[0]) ** 2; std[1] += (c[1] - mean[1]) ** 2; std[2] += (c[2] - mean[2]) ** 2; }
  for (let i = 0; i < 3; i++) std[i] = Math.max(5, Math.sqrt(std[i] / samples.length));
  return { mean, std };
}

/**
 * SHADE_COUNT CSS colours spread around the sampled hair colour (darkest first). The layer is
 * multiplied onto the picture, so these are reflectances: lifted a little above the sampled
 * (already lit) colour so hair over skin lands on the sampled tone instead of below it.
 */
export function shadeColors(stats, count = SHADE_COUNT) {
  const out = [];
  const mid = (count - 1) / 2;
  for (let i = 0; i < count; i++) {
    const k = ((i - mid) / Math.max(1, mid)) * 1.2;
    const c = stats.mean.map((m, ch) => Math.max(0, Math.min(255, Math.round(m * 1.25 + 12 + k * stats.std[ch]))));
    out.push(`rgb(${c[0]},${c[1]},${c[2]})`);
  }
  return out;
}

/** Colour of the scalp shadow under the hair (slightly above the darkest strand reflectance). */
export function shadowColor(stats) {
  const c = stats.mean.map((m) => Math.max(0, Math.min(255, Math.round(m * 1.35 + 18))));
  return c;
}

/**
 * Planting state for one session: goal, planted count, patches.
 * `plant()` returns the new patch or null when the goal is reached / the tap can't be anchored.
 */
export function createPlanting({ goal = DEFAULT_GOAL, rng = Math.random } = {}) {
  const state = { goal, planted: 0, patches: [], centers: new Float32Array(0) };
  function appendCenters(patch) {
    const next = new Float32Array(state.centers.length + patch.centers.length);
    next.set(state.centers);
    next.set(patch.centers, state.centers.length);
    state.centers = next;
  }
  return {
    get goal() { return state.goal; },
    get planted() { return state.planted; },
    get remaining() { return Math.max(0, state.goal - state.planted); },
    get done() { return state.planted >= state.goal; },
    get patches() { return state.patches; },
    get centers() { return state.centers; },
    setGoal(next) {
      if (!GOALS.includes(next)) return false;
      state.goal = next;
      return true;
    },
    /** Grows at most GRAFTS_PER_TAP units, fewer when the goal is almost reached. */
    plant({ center, frame, pxPerCm, now = 0 }) {
      if (!center || !frame || !(pxPerCm > 0)) return null;
      const count = Math.min(GRAFTS_PER_TAP, state.goal - state.planted);
      if (count <= 0) return null;
      const patch = planPatch({ center, frame, pxPerCm, existing: state.centers, rng, count, bornAt: now });
      state.patches.push(patch);
      state.planted += count;
      appendCenters(patch);
      return patch;
    },
    /** True while any patch is still growing at `now`. */
    growing(now) {
      return state.patches.some((p) => now - p.bornAt < GROW_MS);
    },
    reset() {
      state.planted = 0;
      state.patches = [];
      state.centers = new Float32Array(0);
    },
  };
}

/** Points used for tracking, in pixels, or null when any is missing. */
export function trackPoints(points) {
  const out = [];
  for (const i of TRACK_INDICES) {
    if (!points[i]) return null;
    out.push(points[i]);
  }
  return out;
}

export { FLOAT_FIELDS };
