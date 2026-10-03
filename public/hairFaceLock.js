import {
  EYEBROW_INDICES,
  EYE_INDICES,
  FACE_OVAL_RING,
  detectFaceLandmarks,
  landmarksToPixels,
} from "./faceMask.js";
import { segmentSelfieHair } from "./faceGeometry.js";

const LEFT_EYE = Object.freeze([33, 133, 159, 145]);
const RIGHT_EYE = Object.freeze([263, 362, 386, 374]);
const NOSE_TIP = 1;
const MOUTH_CENTER = 13;
const SCALE_MIN = 0.45;
const SCALE_MAX = 2.2;
const MAX_ROTATION = 0.6;
/** Identity region starts this fraction of the brow–eye gap above the brows. */
const IDENTITY_BROW_MARGIN_FACTOR = 0.6;
/** Feather (and erosion) of the identity region, as a fraction of image width. Kept narrow so the blend band (where Gemini's and the webcam face mix) stays thin. */
const IDENTITY_FEATHER_RATIO = 0.02;
/** Styled-hair pixels this close to the face keep the styled frame (bangs over brows). */
const HAIR_GUARD_RADIUS = 3;
/** Per-channel gain clamp when matching the styled frame's tone to the webcam photo. */
const TONE_GAIN_MIN = 0.7;
const TONE_GAIN_MAX = 1.3;
const TONE_MIN_SAMPLES = 100;
/** Tone fit fades out over this many feather radii beyond the identity oval. */
const TONE_FADE_FACTOR = 3;
/** How far (fraction of the styled frame's long edge) edge pixels are extended for misaligned borders. */
const EDGE_SLACK_RATIO = 0.25;

function meanPoint(points, indices) {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const index of indices) {
    const point = points[index];
    if (!point) continue;
    x += point.x;
    y += point.y;
    n += 1;
  }
  if (!n) return null;
  return { x: x / n, y: y / n };
}

/** Pixel anchors (left eye, right eye, nose, mouth) or null when the face is unusable. */
export function faceAnchorPoints(landmarks, width, height) {
  if (!Array.isArray(landmarks) || landmarks.length < 468 || !width || !height) return null;
  const points = landmarksToPixels(landmarks, width, height);
  const left = meanPoint(points, LEFT_EYE);
  const right = meanPoint(points, RIGHT_EYE);
  const nose = points[NOSE_TIP];
  const mouth = points[MOUTH_CENTER];
  if (!left || !right || !nose || !mouth) return null;
  const eyeDist = Math.hypot(right.x - left.x, right.y - left.y);
  if (eyeDist < Math.min(width, height) * 0.04) return null;
  return [left, right, nose, mouth];
}

const CHIN = 152;
const JAW_LEFT = 172;
const JAW_RIGHT = 397;

/**
 * Anchors plus chin and jaw points: a least-squares similarity over these matches the pasted
 * face's overall size to the styled face (which Lucy often draws slimmer or shorter), so the
 * paste ends near the styled face's own outline instead of overshooting it.
 */
export function faceAlignPoints(landmarks, width, height) {
  const anchors = faceAnchorPoints(landmarks, width, height);
  if (!anchors) return null;
  const points = landmarksToPixels(landmarks, width, height);
  const extra = [points[CHIN], points[JAW_LEFT], points[JAW_RIGHT]];
  if (extra.some((p) => !p)) return anchors;
  return [...anchors, ...extra];
}

/**
 * Map styled-image pixels onto the webcam photo.
 * Returns null when the faces cannot be aligned without a large warp.
 */
export function similarityFromCorrespondences(src, dst, {
  scaleMin = SCALE_MIN,
  scaleMax = SCALE_MAX,
  maxRotation = MAX_ROTATION,
} = {}) {
  if (!src || !dst || src.length < 2 || src.length !== dst.length) return null;
  const n = src.length;
  let srcCx = 0;
  let srcCy = 0;
  let dstCx = 0;
  let dstCy = 0;
  for (let i = 0; i < n; i++) {
    srcCx += src[i].x;
    srcCy += src[i].y;
    dstCx += dst[i].x;
    dstCy += dst[i].y;
  }
  srcCx /= n;
  srcCy /= n;
  dstCx /= n;
  dstCy /= n;
  let a = 0;
  let b = 0;
  let srcVar = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i].x - srcCx;
    const sy = src[i].y - srcCy;
    const dx = dst[i].x - dstCx;
    const dy = dst[i].y - dstCy;
    a += sx * dx + sy * dy;
    b += sx * dy - sy * dx;
    srcVar += sx * sx + sy * sy;
  }
  const hypot = Math.hypot(a, b);
  if (srcVar < 1e-6 || hypot < 1e-8) return null;
  const scale = hypot / srcVar;
  if (scale < scaleMin || scale > scaleMax) return null;
  const cos = a / hypot;
  const sin = b / hypot;
  if (Math.abs(Math.atan2(sin, cos)) > maxRotation) return null;
  return {
    scale,
    cos,
    sin,
    tx: dstCx - scale * (cos * srcCx - sin * srcCy),
    ty: dstCy - scale * (sin * srcCx + cos * srcCy),
  };
}

export function applyInverse(transform, x, y) {
  const dx = x - transform.tx;
  const dy = y - transform.ty;
  const inv = 1 / transform.scale;
  return {
    x: inv * (transform.cos * dx + transform.sin * dy),
    y: inv * (-transform.sin * dx + transform.cos * dy),
  };
}

export function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Separable box blur with running sums: O(N) regardless of radius. */
function boxBlur(src, width, height, radius) {
  if (radius <= 0) return Float32Array.from(src);
  const tmp = new Float32Array(width * height);
  const dst = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = 0; x < Math.min(width, radius); x++) sum += src[row + x];
    for (let x = 0; x < width; x++) {
      const add = x + radius;
      const drop = x - radius - 1;
      if (add < width) sum += src[row + add];
      if (drop >= 0) sum -= src[row + drop];
      const lo = Math.max(0, x - radius);
      const hi = Math.min(width - 1, x + radius);
      tmp[row + x] = sum / (hi - lo + 1);
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < Math.min(height, radius); y++) sum += tmp[y * width + x];
    for (let y = 0; y < height; y++) {
      const add = y + radius;
      const drop = y - radius - 1;
      if (add < height) sum += tmp[add * width + x];
      if (drop >= 0) sum -= tmp[drop * width + x];
      const lo = Math.max(0, y - radius);
      const hi = Math.min(height - 1, y + radius);
      dst[y * width + x] = sum / (hi - lo + 1);
    }
  }
  return dst;
}

/** Scanline fill (even-odd) of a polygon; pixel centers at +0.5. */
function polygonMask(width, height, polygon) {
  const mask = new Float32Array(width * height);
  const n = polygon.length;
  const xs = [];
  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = polygon[i].y;
      const yj = polygon[j].y;
      if ((yi > py) !== (yj > py)) {
        xs.push(((polygon[j].x - polygon[i].x) * (py - yi)) / (yj - yi) + polygon[i].x);
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const row = y * width;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const x1 = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = x0; x <= x1; x++) mask[row + x] = 1;
    }
  }
  return mask;
}

/**
 * Full face oval (no temple inset) clipped just above the brows: brows, eyes,
 * nose, mouth, cheeks, and jaw outline. These pixels stay the webcam photo.
 */
export function buildIdentityPolygon(landmarks, width, height, { browMarginPx = null } = {}) {
  if (!Array.isArray(landmarks) || landmarks.length < 468) return null;
  const points = landmarksToPixels(landmarks, width, height);
  let minBrow = Infinity;
  for (const i of EYEBROW_INDICES) if (points[i]) minBrow = Math.min(minBrow, points[i].y);
  let minEye = Infinity;
  for (const i of EYE_INDICES) if (points[i]) minEye = Math.min(minEye, points[i].y);
  if (!Number.isFinite(minBrow) || !Number.isFinite(minEye)) return null;
  const gap = Math.max(0, minEye - minBrow);
  const topY = minBrow - (browMarginPx ?? gap * IDENTITY_BROW_MARGIN_FACTOR);
  const oval = FACE_OVAL_RING.map((i) => points[i]).filter(Boolean);
  if (oval.length < 3) return null;
  const polygon = [];
  for (let i = 0; i < oval.length; i++) {
    const a = oval[i];
    const b = oval[(i + 1) % oval.length];
    const aBelow = a.y >= topY;
    const bBelow = b.y >= topY;
    if (aBelow) polygon.push({ x: a.x, y: a.y });
    if (aBelow !== bBelow) {
      const dy = b.y - a.y;
      const t = Math.abs(dy) < 1e-9 ? 0 : (topY - a.y) / dy;
      polygon.push({ x: a.x + t * (b.x - a.x), y: topY });
    }
  }
  return polygon.length >= 3 ? polygon : null;
}

/**
 * Forehead fade for `compositeSyncedFace`: the paste is fully the person's up to `startPx`
 * above the brow line and fades to nothing at `endPx`, measured along the head's up axis.
 * The forehead has no identity and no texture to hide a seam, so a long ramp there is the
 * only edge that disappears.
 */
export function foreheadFade(landmarks, width, height, { startPx, endPx }) {
  if (!Array.isArray(landmarks) || landmarks.length < 468) return null;
  const points = landmarksToPixels(landmarks, width, height);
  const l = points[33];
  const r = points[263];
  if (!l || !r) return null;
  const span = Math.hypot(r.x - l.x, r.y - l.y);
  if (!(span > 1)) return null;
  // Up = eye line rotated 90° toward the forehead (image y grows downward).
  let ux = (r.y - l.y) / span;
  let uy = -(r.x - l.x) / span;
  if (uy > 0) { ux = -ux; uy = -uy; }
  // Brow line: the brow point farthest along `up`.
  let best = -Infinity;
  let bx = 0;
  let by = 0;
  for (const i of EYEBROW_INDICES) {
    const p = points[i];
    if (!p) continue;
    const d = p.x * ux + p.y * uy;
    if (d > best) { best = d; bx = p.x; by = p.y; }
  }
  if (!Number.isFinite(best)) return null;
  // Anchor the line at the eye midpoint's lateral position so roll does not shift it.
  const mx = (l.x + r.x) / 2;
  const my = (l.y + r.y) / 2;
  const along = (bx - mx) * ux + (by - my) * uy;
  return { x: mx + ux * along, y: my + uy * along, ux, uy, start: startPx, end: Math.max(startPx + 1, endPx) };
}

/** Per-channel gain/offset that maps `styled` tones onto `person` tones over the sampled pixels. */
export function fitTone(person, styled, sampleIndices) {
  const n = sampleIndices.length;
  if (n < TONE_MIN_SAMPLES) return { gain: [1, 1, 1], offset: [0, 0, 0], samples: n };
  const sums = new Float64Array(12);
  for (const i of sampleIndices) {
    for (let c = 0; c < 3; c++) {
      const s = styled[i * 4 + c];
      const p = person[i * 4 + c];
      sums[c * 4] += s;
      sums[c * 4 + 1] += p;
      sums[c * 4 + 2] += s * s;
      sums[c * 4 + 3] += p * p;
    }
  }
  return toneFromSums(sums, n);
}

/**
 * Closed-form per-channel gain/offset from running sums: for each channel c,
 * sums[c*4..c*4+3] = Σstyled, Σperson, Σstyled², Σperson².
 */
export function toneFromSums(sums, n) {
  const gain = [1, 1, 1];
  const offset = [0, 0, 0];
  if (n < TONE_MIN_SAMPLES) return { gain, offset, samples: n };
  for (let c = 0; c < 3; c++) {
    const meanS = sums[c * 4] / n;
    const meanP = sums[c * 4 + 1] / n;
    const stdS = Math.sqrt(Math.max(1e-6, sums[c * 4 + 2] / n - meanS * meanS));
    const stdP = Math.sqrt(Math.max(1e-6, sums[c * 4 + 3] / n - meanP * meanP));
    gain[c] = Math.min(TONE_GAIN_MAX, Math.max(TONE_GAIN_MIN, stdP / stdS));
    offset[c] = meanP - gain[c] * meanS;
  }
  return { gain, offset, samples: n };
}

/**
 * Bilinear sample; coordinates are clamped to the image so a slightly zoomed or
 * shifted styled frame extends its edge pixels instead of leaving a misaligned border.
 * Returns false only when the point is far outside (more than `slack` px).
 */
function sampleBilinear(data, width, height, x, y, out, offset, slack = Infinity) {
  let sx = x - 0.5;
  let sy = y - 0.5;
  if (sx < -slack || sy < -slack || sx > width - 1 + slack || sy > height - 1 + slack) return false;
  sx = Math.min(width - 1, Math.max(0, sx));
  sy = Math.min(height - 1, Math.max(0, sy));
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = sx - x0;
  const ty = sy - y0;
  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;
  for (let c = 0; c < 3; c++) {
    const top = data[i00 + c] * (1 - tx) + data[i10 + c] * tx;
    const bottom = data[i01 + c] * (1 - tx) + data[i11 + c] * tx;
    out[offset + c] = Math.round(top * (1 - ty) + bottom * ty);
  }
  out[offset + 3] = 255;
  return true;
}

/**
 * Styled (Gemini) frame is the base, so hair, hairline, and shadows stay
 * photorealistic. The webcam face is aligned onto it and blended back inside the
 * identity oval, except where the styled frame drew hair over the face (bangs).
 * The styled frame's tone is first matched to the webcam photo so the blend is seamless.
 */
export function renderLockedPreview({
  person,
  styled,
  personWidth,
  personHeight,
  styledWidth,
  styledHeight,
  personLandmarks,
  styledLandmarks,
  styledHair = null,
  featherRadius = null,
  toneMatch = true,
} = {}) {
  const src = faceAnchorPoints(styledLandmarks, styledWidth, styledHeight);
  const dst = faceAnchorPoints(personLandmarks, personWidth, personHeight);
  if (!src || !dst) return null;
  const transform = similarityFromCorrespondences(src, dst);
  if (!transform) return null;
  const identityPolygon = buildIdentityPolygon(personLandmarks, personWidth, personHeight);
  if (!identityPolygon) return null;

  const pixels = personWidth * personHeight;
  const feather = featherRadius ?? Math.max(1, Math.round(personWidth * IDENTITY_FEATHER_RATIO));
  // Edge pixels of the styled frame are extended up to this far; beyond it the webcam photo shows.
  const slack = Math.max(styledWidth, styledHeight) * EDGE_SLACK_RATIO;

  // Aligned styled frame in webcam coordinates (edge-extended); far outside it the webcam photo shows.
  const aligned = new Uint8ClampedArray(pixels * 4);
  const covered = new Uint8Array(pixels);
  const hairHard = new Float32Array(pixels);
  const useHair = styledHair?.length === styledWidth * styledHeight;
  for (let y = 0; y < personHeight; y++) {
    for (let x = 0; x < personWidth; x++) {
      const i = y * personWidth + x;
      const center = applyInverse(transform, x + 0.5, y + 0.5);
      if (sampleBilinear(styled, styledWidth, styledHeight, center.x, center.y, aligned, i * 4, slack)) {
        covered[i] = 1;
        if (useHair) {
          const sx = Math.min(styledWidth - 1, Math.max(0, Math.floor(center.x)));
          const sy = Math.min(styledHeight - 1, Math.max(0, Math.floor(center.y)));
          if (styledHair[sy * styledWidth + sx]) hairHard[i] = 1;
        }
      } else {
        aligned.set(person.subarray(i * 4, i * 4 + 4), i * 4);
      }
    }
  }

  // Identity alpha: hard oval → eroded by one feather → feathered.
  const identityHard = polygonMask(personWidth, personHeight, identityPolygon);
  let core = identityHard;
  let alpha = identityHard;
  if (feather > 0) {
    const shrink = boxBlur(identityHard, personWidth, personHeight, feather);
    core = new Float32Array(pixels);
    for (let i = 0; i < pixels; i++) core[i] = shrink[i] > 0.97 ? 1 : 0;
    alpha = boxBlur(core, personWidth, personHeight, feather);
  }
  const hairGuard = useHair ? boxBlur(hairHard, personWidth, personHeight, HAIR_GUARD_RADIUS) : null;

  // Tone match on skin that both frames show (identity core, no styled hair).
  const samples = [];
  for (let i = 0; i < pixels; i++) {
    if (core[i] >= 1 && covered[i] && !(hairGuard && hairGuard[i] > 0)) samples.push(i);
  }
  const tone = toneMatch
    ? fitTone(person, aligned, samples)
    : { gain: [1, 1, 1], offset: [0, 0, 0], samples: 0 };
  // Apply the tone fit fully around the face and fade it out with distance, so the
  // blend seam disappears while hair color and background far from the face stay Gemini's.
  const toneWeight = toneMatch ? boxBlur(identityHard, personWidth, personHeight, feather * TONE_FADE_FACTOR) : null;

  const out = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    const guard = hairGuard ? Math.min(1, hairGuard[i] * 2) : 0;
    const a = covered[i] ? alpha[i] * (1 - guard) : 1;
    const w = toneWeight && covered[i] ? Math.min(1, toneWeight[i] * 1.5) : 0;
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      const s = aligned[o + c] * (1 + (tone.gain[c] - 1) * w) + tone.offset[c] * w;
      out[o + c] = Math.round(person[o + c] * a + s * (1 - a));
    }
    out[o + 3] = 255;
  }
  const faceMask = new Float32Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const guard = hairGuard ? Math.min(1, hairGuard[i] * 2) : 0;
    faceMask[i] = alpha[i] * (1 - guard);
  }
  return { rgba: out, mode: "face", faceMask, transform, tone };
}

/**
 * Live overlay: Lucy's frame stays as-is (hair moves with the video). The webcam
 * face is warped onto Lucy's landmarks and returned as an RGBA patch with alpha 0
 * everywhere outside the identity oval, so it can be drawn on top of the video.
 * Returns null when the two faces cannot be aligned.
 */
export function compositeLiveFace({
  base,
  baseWidth,
  baseHeight,
  baseLandmarks,
  face,
  faceWidth,
  faceHeight,
  faceLandmarks,
  featherRadius = 0,
  toneMatch = true,
} = {}) {
  const src = faceAnchorPoints(faceLandmarks, faceWidth, faceHeight);
  const dst = faceAnchorPoints(baseLandmarks, baseWidth, baseHeight);
  if (!src || !dst) return null;
  const transform = similarityFromCorrespondences(src, dst);
  if (!transform) return null;
  const polygon = buildIdentityPolygon(baseLandmarks, baseWidth, baseHeight);
  if (!polygon) return null;

  const pixels = baseWidth * baseHeight;
  const identityHard = polygonMask(baseWidth, baseHeight, polygon);
  let core = identityHard;
  let alpha = identityHard;
  if (featherRadius > 0) {
    const shrink = boxBlur(identityHard, baseWidth, baseHeight, featherRadius);
    core = new Float32Array(pixels);
    for (let i = 0; i < pixels; i++) core[i] = shrink[i] > 0.97 ? 1 : 0;
    alpha = boxBlur(core, baseWidth, baseHeight, featherRadius);
  }

  const aligned = new Uint8ClampedArray(pixels * 4);
  const covered = new Uint8Array(pixels);
  for (let y = 0; y < baseHeight; y++) {
    for (let x = 0; x < baseWidth; x++) {
      const i = y * baseWidth + x;
      if (alpha[i] <= 0.004) continue;
      const center = applyInverse(transform, x + 0.5, y + 0.5);
      if (sampleBilinear(face, faceWidth, faceHeight, center.x, center.y, aligned, i * 4, 0)) covered[i] = 1;
    }
  }
  const samples = [];
  for (let i = 0; i < pixels; i++) if (core[i] >= 1 && covered[i]) samples.push(i);
  const tone = toneMatch
    ? fitTone(base, aligned, samples)
    : { gain: [1, 1, 1], offset: [0, 0, 0], samples: 0 };

  const out = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    if (!covered[i] || alpha[i] <= 0.004) continue;
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      out[o + c] = Math.round(Math.min(255, Math.max(0, aligned[o + c] * tone.gain[c] + tone.offset[c])));
    }
    out[o + 3] = Math.round(alpha[i] * 255);
  }
  return { rgba: out, transform, tone };
}

/** Transform a polygon (array of {x,y}) with a similarity transform. */
export function transformPolygon(polygon, transform) {
  const { scale, cos, sin, tx, ty } = transform;
  return polygon.map((p) => ({
    x: scale * (cos * p.x - sin * p.y) + tx,
    y: scale * (sin * p.x + cos * p.y) + ty,
  }));
}

/** Axis-aligned bounds of a polygon, grown by `margin` and clamped to width×height (integers). */
export function polygonRegion(polygon, width, height, margin = 0) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const x0 = Math.max(0, Math.floor(minX - margin));
  const y0 = Math.max(0, Math.floor(minY - margin));
  const x1 = Math.min(width, Math.ceil(maxX + margin));
  const y1 = Math.min(height, Math.ceil(maxY + margin));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Regions above this many pixels build their soft masks at half resolution. */
const MASK_HALF_RES_PIXELS = 120000;

/** Mask grid scale (1 or 2) used by compositeSyncedFace for a region of `pixels` pixels. */
export function maskScaleFor(pixels) {
  return pixels > MASK_HALF_RES_PIXELS ? 2 : 1;
}

/**
 * Writes the webcam's own hair into the face crop's alpha channel (alpha 0 under hair), so the
 * paste never lays the user's bangs over Lucy's forehead. `hair` is a 0..1 mask (1 = hair) of
 * `hairWidth`×`hairHeight` covering the crop (sizes may differ by rounding); it is softly grown
 * by about `growPx` crop pixels first, because segmentation masks stop a little inside the hair.
 */
export function maskFaceHair(face, width, height, hair, hairWidth, hairHeight, growPx = 0, forehead = null) {
  if (!face || !hair || face.length !== width * height * 4 || hair.length !== hairWidth * hairHeight) return false;
  const r = Math.round(growPx);
  let soft = hair;
  let softW = hairWidth;
  let softH = hairHeight;
  let anyHair = false;
  for (let i = 0; i < hair.length && !anyHair; i++) anyHair = hair[i] > 0.002;
  if (r > 0 && anyHair) {
    // Grown at half resolution: the mask is soft and coarse (segmenter output) anyway.
    softW = Math.max(1, hairWidth >> 1);
    softH = Math.max(1, hairHeight >> 1);
    const half = new Float32Array(softW * softH);
    for (let y = 0; y < softH; y++) {
      const sy0 = Math.min(hairHeight - 1, y * 2) * hairWidth;
      for (let x = 0; x < softW; x++) half[y * softW + x] = hair[sy0 + Math.min(hairWidth - 1, x * 2)];
    }
    const blurred = boxBlur(half, softW, softH, Math.max(1, r >> 1));
    soft = blurred;
    for (let i = 0; i < soft.length; i++) soft[i] = Math.min(1, blurred[i] * 2);
  }
  const shadow = forehead ? foreheadShadowMask(face, width, height, forehead) : null;
  const sx = softW / width;
  const sy = softH / height;
  let touched = false;
  for (let y = 0; y < height; y++) {
    const hy = Math.min(softH - 1, (y * sy) | 0) * softW;
    for (let x = 0; x < width; x++) {
      let h = soft[hy + Math.min(softW - 1, (x * sx) | 0)];
      if (shadow) {
        const s = shadow[y * width + x];
        if (s > h) h = s;
      }
      if (h <= 0.002) continue;
      face[(y * width + x) * 4 + 3] = Math.round(255 * (1 - Math.min(1, h)));
      touched = true;
    }
  }
  return touched;
}

/**
 * Hair the segmenter misses (thin bangs, wisps) and the shadow it throws on the forehead are
 * both much darker than the person's skin. Above the brow line (`line` = {x, y, ux, uy} in crop
 * px, `up` pointing to the forehead, from `startPx` on) pixels whose smoothed luminance falls
 * below `darkRatio` × the skin luminance (median of small patches at `skin` points, cheeks) are
 * masked, 0..1. A forehead is featureless skin, so nothing legitimate is lost.
 */
function foreheadShadowMask(face, width, height, { line, startPx = 0, skin = [], darkRatio = 0.75, blurPx = 2 }) {
  if (!line || !skin.length) return null;
  const lumAt = (x, y) => {
    const o = (y * width + x) * 4;
    return 0.299 * face[o] + 0.587 * face[o + 1] + 0.114 * face[o + 2];
  };
  const samples = [];
  for (const p of skin) {
    const cx = Math.round(p.x);
    const cy = Math.round(p.y);
    if (cx < 2 || cy < 2 || cx >= width - 2 || cy >= height - 2) continue;
    let s = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += lumAt(cx + dx, cy + dy);
    samples.push(s / 25);
  }
  if (samples.length < 2) return null;
  samples.sort((a, b) => a - b);
  const skinLum = samples[samples.length >> 1];
  if (skinLum < 40) return null;
  // Only the rows that can lie above the brow line are examined (the forehead is the top of the crop).
  const dAt = (x, y) => (x + 0.5 - line.x) * line.ux + (y + 0.5 - line.y) * line.uy - startPx;
  let rows = 0;
  for (let y = height - 1; y >= 0 && rows === 0; y--) {
    if (dAt(0, y) > 0 || dAt(width - 1, y) > 0) rows = y + 1;
  }
  if (rows === 0) return null;
  const lum = new Float32Array(width * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < width; x++) lum[y * width + x] = lumAt(x, y);
  const smooth = blurPx > 0 ? boxBlur(lum, width, rows, Math.round(blurPx)) : lum;
  // Dark below hi × skin, fully masked below lo × skin.
  const hi = skinLum * darkRatio;
  const lo = skinLum * darkRatio * 0.8;
  const ramp = Math.max(1, blurPx * 2);
  const out = new Float32Array(width * height);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      const d = dAt(x, y);
      if (d <= 0) continue;
      const v = smooth[y * width + x];
      if (v >= hi) continue;
      let s = v <= lo ? 1 : (hi - v) / (hi - lo);
      // Ease in over the first rows above the line so the cut has no straight lower edge.
      if (d < ramp) s *= d / ramp;
      out[y * width + x] = s;
    }
  }
  return out;
}

/**
 * Lucy-base, time-synced face paste for one region of the Lucy frame.
 * Lucy's frame (hair, body, background, lighting) stays; inside the identity oval the pixels
 * are the webcam face captured at the same moment, aligned by `transform` (webcam → Lucy
 * coordinates). Lucy's own hair over the face (bangs) stays on top.
 *
 * `base`        Lucy RGBA for the region (regionWidth×regionHeight at region.x/y of the Lucy frame)
 * `baseHair`    optional hair mask for the same region, Uint8 (1 = hair) or Float32 (0..1 soft),
 *               at full region size or at the mask grid size (see maskScaleFor)
 * `face`        webcam RGBA crop (faceWidth×faceHeight located at faceX/faceY of the webcam frame,
 *               stored at `faceScale` × the webcam resolution)
 * `polygon`     identity oval in Lucy-frame coordinates (the webcam oval, transformed)
 * `clipPolygon` optional oval of the styled face itself; the paste never reaches beyond it
 *               grown by `clipGrow` px, so the user's skin is not laid over Lucy's hair or background
 * `blendRadius` > 0 enables low-frequency transfer: colour/lighting below this radius (px) come
 *               from Lucy's frame, detail above it from the webcam face (`blendStrength` 0..1).
 *               Replaces the gain/offset tone match.
 * `fade`        optional forehead ramp from `foreheadFade` (Lucy-frame px): alpha is 1 up to
 *               `start` above the brow line and 0 at `end`.
 * Returns RGBA for the region (alpha 0 where Lucy stays) and the fitted tone.
 */
export function compositeSyncedFace({
  base,
  region,
  baseHair = null,
  face,
  faceX = 0,
  faceY = 0,
  faceWidth,
  faceHeight,
  faceScale = 1,
  transform,
  polygon,
  clipPolygon = null,
  clipGrow = 0,
  featherRadius = 0,
  toneMatch = true,
  blendRadius = 0,
  blendStrength = 1,
  fade = null,
} = {}) {
  if (!base || !face || !region || !transform || !polygon?.length) return null;
  const { x: rx, y: ry, width: rw, height: rh } = region;
  const pixels = rw * rh;
  if (base.length !== pixels * 4 || face.length !== faceWidth * faceHeight * 4) return null;

  // Masks (oval, clip, feather, hair) are built at half resolution for large regions: the
  // edges are soft anyway and the blurs dominate the cost. `ms` = mask scale.
  const ms = maskScaleFor(pixels);
  const mw = Math.ceil(rw / ms);
  const mh = Math.ceil(rh / ms);
  const mpixels = mw * mh;
  const toMask = (p) => ({ x: (p.x - rx) / ms, y: (p.y - ry) / ms });
  const identityHard = polygonMask(mw, mh, polygon.map(toMask));
  if (clipPolygon?.length >= 3) {
    let clip = polygonMask(mw, mh, clipPolygon.map(toMask));
    const grow = Math.round(clipGrow / ms);
    if (grow > 0) {
      // Dilate: anything within clipGrow of the styled oval counts as inside.
      const grown = boxBlur(clip, mw, mh, grow);
      clip = new Float32Array(mpixels);
      for (let i = 0; i < mpixels; i++) clip[i] = grown[i] > 0.002 ? 1 : 0;
    }
    for (let i = 0; i < mpixels; i++) identityHard[i] *= clip[i];
  }
  const feather = Math.round(featherRadius / ms);
  let core = identityHard;
  let alphaMask = identityHard;
  if (feather > 0) {
    const shrink = boxBlur(identityHard, mw, mh, feather);
    core = new Float32Array(mpixels);
    for (let i = 0; i < mpixels; i++) core[i] = shrink[i] > 0.97 ? 1 : 0;
    alphaMask = boxBlur(core, mw, mh, feather);
  }
  if (fade) {
    // Long ramp up the forehead (smoothstep along the head's up axis); also keeps the tone
    // samples / low-frequency weights to the part that is really pasted.
    if (alphaMask === identityHard) alphaMask = Float32Array.from(identityHard);
    const inv = 1 / (fade.end - fade.start);
    for (let my = 0; my < mh; my++) {
      const py = ry + (my + 0.5) * ms;
      for (let mx = 0; mx < mw; mx++) {
        const i = my * mw + mx;
        if (alphaMask[i] <= 0) continue;
        const px = rx + (mx + 0.5) * ms;
        const d = (px - fade.x) * fade.ux + (py - fade.y) * fade.uy;
        if (d <= fade.start) continue;
        if (d >= fade.end) { alphaMask[i] = 0; continue; }
        const t = (d - fade.start) * inv;
        alphaMask[i] *= 1 - t * t * (3 - 2 * t);
      }
    }
  }
  let hairSoft = null;
  if (baseHair?.length === pixels || baseHair?.length === mpixels) {
    const hairHard = new Float32Array(mpixels);
    if (baseHair.length === mpixels) {
      for (let i = 0; i < mpixels; i++) hairHard[i] = Math.min(1, Math.max(0, baseHair[i]));
    } else {
      for (let y = 0; y < mh; y++) {
        const sy = Math.min(rh - 1, y * ms);
        for (let x = 0; x < mw; x++) hairHard[y * mw + x] = Math.min(1, Math.max(0, baseHair[sy * rw + Math.min(rw - 1, x * ms)]));
      }
    }
    hairSoft = feather > 0 ? boxBlur(hairHard, mw, mh, Math.max(1, feather)) : hairHard;
  }
  // Per-column / per-row lookup tables for sampling the mask grid bilinearly at full resolution.
  const cx0 = new Int32Array(rw);
  const cx1 = new Int32Array(rw);
  const cwx = new Float32Array(rw);
  for (let x = 0; x < rw; x++) {
    const fx = Math.max(0, Math.min(mw - 1, (x + 0.5) / ms - 0.5));
    cx0[x] = fx | 0;
    cx1[x] = cx0[x] < mw - 1 ? cx0[x] + 1 : cx0[x];
    cwx[x] = fx - cx0[x];
  }
  const ry0 = new Int32Array(rh);
  const ry1 = new Int32Array(rh);
  const rwy = new Float32Array(rh);
  for (let y = 0; y < rh; y++) {
    const fy = Math.max(0, Math.min(mh - 1, (y + 0.5) / ms - 0.5));
    ry0[y] = fy | 0;
    ry1[y] = ry0[y] < mh - 1 ? ry0[y] + 1 : ry0[y];
    rwy[y] = fy - ry0[y];
  }

  // Inverse similarity, stepped incrementally along each row (no per-pixel trig or objects).
  // `faceScale` converts webcam-frame coordinates into crop pixels (the crop may be stored smaller).
  const inv = faceScale / transform.scale;
  const ax = inv * transform.cos;
  const ay = -inv * transform.sin;
  const fwMax = faceWidth - 1;
  const fhMax = faceHeight - 1;
  const offX = faceX * faceScale + 0.5;
  const offY = faceY * faceScale + 0.5;
  // [r, g, b, alpha 0..1]; the crop's alpha is 0 where the webcam frame shows the user's own hair.
  const rgbSample = [0, 0, 0, 1];
  const sampleFace = (sx, sy) => {
    if (sx < 0 || sy < 0 || sx > fwMax || sy > fhMax) return false;
    const x0 = sx | 0;
    const y0 = sy | 0;
    const x1 = x0 < fwMax ? x0 + 1 : x0;
    const y1 = y0 < fhMax ? y0 + 1 : y0;
    const tx = sx - x0;
    const ty = sy - y0;
    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;
    const i00 = (y0 * faceWidth + x0) * 4;
    const i10 = (y0 * faceWidth + x1) * 4;
    const i01 = (y1 * faceWidth + x0) * 4;
    const i11 = (y1 * faceWidth + x1) * 4;
    rgbSample[0] = face[i00] * w00 + face[i10] * w10 + face[i01] * w01 + face[i11] * w11;
    rgbSample[1] = face[i00 + 1] * w00 + face[i10 + 1] * w10 + face[i01 + 1] * w01 + face[i11 + 1] * w11;
    rgbSample[2] = face[i00 + 2] * w00 + face[i10 + 2] * w10 + face[i01 + 2] * w01 + face[i11 + 2] * w11;
    rgbSample[3] = (face[i00 + 3] * w00 + face[i10 + 3] * w10 + face[i01 + 3] * w01 + face[i11 + 3] * w11) / 255;
    return true;
  };

  // Low-frequency transfer: the pasted face keeps the webcam's detail (identity) but takes
  // Lucy's colour, lighting and shading, so there is no tone step at the oval edge. Computed on
  // the mask grid with a mask-normalised blur (skin only: inside the oval, not under hair).
  // The low pass itself is computed on a grid twice as coarse as the mask grid (it is smooth by
  // construction) and bilinearly lifted onto the mask grid for pass 2.
  let deltas = null;
  const bs = ms * 2;
  const blend = Math.round(blendRadius / bs);
  if (blend > 0 && blendStrength > 0) {
    const bw = Math.ceil(mw / 2);
    const bh = Math.ceil(mh / 2);
    const bpixels = bw * bh;
    const weight = new Float32Array(bpixels);
    const faceSmall = [new Float32Array(bpixels), new Float32Array(bpixels), new Float32Array(bpixels)];
    const baseSmall = [new Float32Array(bpixels), new Float32Array(bpixels), new Float32Array(bpixels)];
    for (let gy = 0; gy < bh; gy++) {
      const my = Math.min(mh - 1, gy * 2);
      const dy0 = ry + (gy + 0.5) * bs - transform.ty;
      const by = Math.min(rh - 1, Math.round((gy + 0.5) * bs - 0.5));
      for (let gx = 0; gx < bw; gx++) {
        const mx = Math.min(mw - 1, gx * 2);
        const mi = my * mw + mx;
        let w = identityHard[mi];
        if (hairSoft) w *= 1 - Math.min(1, hairSoft[mi]);
        if (w <= 0.01) continue;
        const dx0 = rx + (gx + 0.5) * bs - transform.tx;
        const sx = inv * (transform.cos * dx0 + transform.sin * dy0) - offX;
        const sy = inv * (-transform.sin * dx0 + transform.cos * dy0) - offY;
        if (!sampleFace(sx, sy)) continue;
        w *= rgbSample[3];
        if (w <= 0.01) continue;
        const bx = Math.min(rw - 1, Math.round((gx + 0.5) * bs - 0.5));
        const bo = (by * rw + bx) * 4;
        const i = gy * bw + gx;
        weight[i] = w;
        for (let c = 0; c < 3; c++) {
          faceSmall[c][i] = rgbSample[c] * w;
          baseSmall[c][i] = base[bo + c] * w;
        }
      }
    }
    const den = boxBlur(weight, bw, bh, blend);
    deltas = [];
    for (let c = 0; c < 3; c++) {
      const lowFace = boxBlur(faceSmall[c], bw, bh, blend);
      const lowBase = boxBlur(baseSmall[c], bw, bh, blend);
      const coarse = new Float32Array(bpixels);
      for (let i = 0; i < bpixels; i++) {
        if (den[i] > 1e-3) coarse[i] = ((lowBase[i] - lowFace[i]) / den[i]) * blendStrength;
      }
      // Lift to the mask grid (bilinear, clamped).
      const d = new Float32Array(mpixels);
      for (let my = 0; my < mh; my++) {
        const fy = Math.max(0, Math.min(bh - 1, (my + 0.5) / 2 - 0.5));
        const y0 = fy | 0;
        const y1 = Math.min(bh - 1, y0 + 1);
        const wy = fy - y0;
        const r0 = y0 * bw;
        const r1 = y1 * bw;
        const row = my * mw;
        for (let mx = 0; mx < mw; mx++) {
          const fx = Math.max(0, Math.min(bw - 1, (mx + 0.5) / 2 - 0.5));
          const x0 = fx | 0;
          const x1 = Math.min(bw - 1, x0 + 1);
          const wx = fx - x0;
          d[row + mx] = (coarse[r0 + x0] * (1 - wx) + coarse[r0 + x1] * wx) * (1 - wy)
            + (coarse[r1 + x0] * (1 - wx) + coarse[r1 + x1] * wx) * wy;
        }
      }
      deltas.push(d);
    }
  }

  // Pass 1 (sparse): tone statistics from core pixels not under Lucy's hair (running sums only).
  // Skipped when the low-frequency transfer already carries Lucy's tone.
  let tone = { gain: [1, 1, 1], offset: [0, 0, 0], samples: 0 };
  if (toneMatch && !deltas) {
    const stride = pixels > 40000 ? 4 : 1;
    const sums = new Float64Array(12);
    let n = 0;
    for (let y = 0; y < rh; y += stride) {
      const my = Math.min(mh - 1, (y / ms) | 0);
      const dx0 = rx + 0.5 - transform.tx;
      const dy0 = ry + y + 0.5 - transform.ty;
      let sx = inv * (transform.cos * dx0 + transform.sin * dy0) - offX;
      let sy = inv * (-transform.sin * dx0 + transform.cos * dy0) - offY;
      for (let x = 0; x < rw; x += stride, sx += ax * stride, sy += ay * stride) {
        const mi = my * mw + Math.min(mw - 1, (x / ms) | 0);
        if (core[mi] < 1 || (hairSoft && hairSoft[mi] > 0.2)) continue;
        if (!sampleFace(sx, sy) || rgbSample[3] < 0.8) continue;
        const o = (y * rw + x) * 4;
        for (let c = 0; c < 3; c++) {
          const s = rgbSample[c];
          const p = base[o + c];
          sums[c * 4] += s;
          sums[c * 4 + 1] += p;
          sums[c * 4 + 2] += s * s;
          sums[c * 4 + 3] += p * p;
        }
        n += 1;
      }
    }
    tone = toneFromSums(sums, n);
  }

  // Pass 2 (full): alpha, face sample and tone in one sweep; nothing stored per pixel but the output.
  // Inlined (no helper calls) because this loop is the hot path of the live compositor.
  const out = new Uint8ClampedArray(pixels * 4);
  const [g0, g1, g2] = tone.gain;
  const [f0, f1, f2] = tone.offset;
  const direct = ms === 1;
  let painted = 0;
  for (let y = 0; y < rh; y++) {
    const dx0 = rx + 0.5 - transform.tx;
    const dy0 = ry + y + 0.5 - transform.ty;
    let sx = inv * (transform.cos * dx0 + transform.sin * dy0) - offX;
    let sy = inv * (-transform.sin * dx0 + transform.cos * dy0) - offY;
    const row = y * rw;
    const a0 = ry0[y] * mw;
    const a1 = ry1[y] * mw;
    const wy = rwy[y];
    const mrow = direct ? y * mw : 0;
    for (let x = 0; x < rw; x++, sx += ax, sy += ay) {
      let a;
      let d0 = 0;
      let d1 = 0;
      let d2 = 0;
      if (direct) {
        a = alphaMask[mrow + x];
        if (a <= 0.004) continue;
        if (hairSoft) a *= 1 - Math.min(1, hairSoft[mrow + x]);
        if (deltas) {
          d0 = deltas[0][mrow + x];
          d1 = deltas[1][mrow + x];
          d2 = deltas[2][mrow + x];
        }
      } else {
        const wx = cwx[x];
        const x0 = cx0[x];
        const x1 = cx1[x];
        const w00 = (1 - wx) * (1 - wy);
        const w10 = wx * (1 - wy);
        const w01 = (1 - wx) * wy;
        const w11 = wx * wy;
        a = alphaMask[a0 + x0] * w00 + alphaMask[a0 + x1] * w10 + alphaMask[a1 + x0] * w01 + alphaMask[a1 + x1] * w11;
        if (a <= 0.004) continue;
        if (hairSoft) {
          const h = hairSoft[a0 + x0] * w00 + hairSoft[a0 + x1] * w10 + hairSoft[a1 + x0] * w01 + hairSoft[a1 + x1] * w11;
          a *= 1 - Math.min(1, h);
        }
        if (deltas) {
          // The low-pass delta is smooth by construction; the nearest mask cell is enough.
          const di = (wy < 0.5 ? a0 : a1) + (wx < 0.5 ? x0 : x1);
          d0 = deltas[0][di];
          d1 = deltas[1][di];
          d2 = deltas[2][di];
        }
      }
      if (a <= 0.004) continue;
      if (sx < 0 || sy < 0 || sx > fwMax || sy > fhMax) continue;
      const fx0 = sx | 0;
      const fy0 = sy | 0;
      const fx1 = fx0 < fwMax ? fx0 + 1 : fx0;
      const fy1 = fy0 < fhMax ? fy0 + 1 : fy0;
      const tx = sx - fx0;
      const ty = sy - fy0;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      const i00 = (fy0 * faceWidth + fx0) * 4;
      const i10 = (fy0 * faceWidth + fx1) * 4;
      const i01 = (fy1 * faceWidth + fx0) * 4;
      const i11 = (fy1 * faceWidth + fx1) * 4;
      // The crop's own alpha (0 under the user's hair) thins the paste there, so Lucy's forehead shows.
      const fa = face[i00 + 3] * w00 + face[i10 + 3] * w10 + face[i01 + 3] * w01 + face[i11 + 3] * w11;
      if (fa < 254) {
        a *= fa / 255;
        if (a <= 0.004) continue;
      }
      const o = (row + x) * 4;
      // Uint8ClampedArray rounds and clamps on store.
      out[o] = (face[i00] * w00 + face[i10] * w10 + face[i01] * w01 + face[i11] * w11) * g0 + f0 + d0;
      out[o + 1] = (face[i00 + 1] * w00 + face[i10 + 1] * w10 + face[i01 + 1] * w01 + face[i11 + 1] * w11) * g1 + f1 + d1;
      out[o + 2] = (face[i00 + 2] * w00 + face[i10 + 2] * w10 + face[i01 + 2] * w01 + face[i11 + 2] * w11) * g2 + f2 + d2;
      out[o + 3] = Math.min(1, a) * 255;
      painted += 1;
    }
  }
  return { rgba: out, tone, painted };
}

function maskToPngDataUrl(mask, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < mask.length; i++) {
    const v = Math.round(Math.min(1, Math.max(0, mask[i])) * 255);
    const o = i * 4;
    rgba[o] = v;
    rgba[o + 1] = v;
    rgba[o + 2] = v;
    rgba[o + 3] = 255;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas.toDataURL("image/png");
}

function drawBitmap(bitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return canvas;
}

/**
 * Hair length category read off the styled still itself: how far below the chin the hair
 * reaches, in face heights (forehead top → chin). The analysed spec often says "shoulder" for
 * chest-length hair, and Lucy then obeys the words, so the picture is the authority here.
 * `mask` is a hair mask (0/1 or 0..1, counted above 0.5) of `width`×`height`; the landmarks are
 * normalised so the mask may be a downscaled copy of the frame. The lowest 2 % of hair pixels
 * are ignored as specks. Returns null when there is too little hair or no usable face.
 * `clipped` means the hair runs off the bottom of the image (the real length is at least this).
 * `area` is the hair area in face-height² units, a framing-independent size of the hairstyle.
 */
export function hairLengthFromMask(mask, width, height, landmarks) {
  if (!mask || mask.length !== width * height || !Array.isArray(landmarks) || landmarks.length < 468) return null;
  const points = landmarksToPixels(landmarks, width, height);
  const chin = points[152].y;
  const faceHeight = chin - points[10].y;
  if (!(faceHeight > 8)) return null;
  const rows = new Uint32Array(height);
  let total = 0;
  for (let y = 0; y < height; y++) {
    let n = 0;
    const row = y * width;
    for (let x = 0; x < width; x++) if (mask[row + x] > 0.5) n += 1;
    rows[y] = n;
    total += n;
  }
  if (total < faceHeight * faceHeight * 0.05) return null;
  const skip = total * 0.02;
  let acc = 0;
  let bottom = height - 1;
  for (let y = height - 1; y >= 0; y--) {
    acc += rows[y];
    if (acc >= skip) { bottom = y; break; }
  }
  const reach = (bottom + 0.5 - chin) / faceHeight;
  let widest = 0;
  for (let y = 0; y < height; y++) if (rows[y] > widest) widest = rows[y];
  const clipped = rows[height - 1] + rows[height - 2] >= widest * 0.2;
  let length;
  if (reach < -0.6) length = "very_short";
  else if (reach < -0.3) length = "short";
  else if (reach < 0.15) length = "chin";
  else if (reach < 1.0) length = "shoulder";
  else if (reach < 1.7) length = "chest";
  else length = "long";
  // Fraction of the forehead band (brows → 0.45 face-heights above, between the eyes) that is
  // hair: full bangs sit near 1, an exposed forehead near 0. Used to catch Lucy dropping bangs.
  let browY = Infinity;
  for (const i of EYEBROW_INDICES) if (points[i].y < browY) browY = points[i].y;
  const midX = (points[33].x + points[263].x) / 2;
  const half = Math.abs(points[263].x - points[33].x) * 0.7;
  const x0 = Math.max(0, Math.floor(midX - half));
  const x1 = Math.min(width, Math.ceil(midX + half));
  const y0 = Math.max(0, Math.floor(browY - faceHeight * 0.45));
  const y1 = Math.min(height, Math.ceil(browY));
  let frontHair = 0;
  let frontTotal = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) {
      frontTotal += 1;
      if (mask[row + x] > 0.5) frontHair += 1;
    }
  }
  return {
    reach, length, clipped,
    area: total / (faceHeight * faceHeight),
    front: frontTotal ? frontHair / frontTotal : 0,
  };
}

/**
 * Has Lucy's hair drifted back to the person's own hair? Compares the live hair measure with
 * the styled still (`target`) and the webcam (`own`), both from `hairLengthFromMask`: it is a
 * drift when the live hair is far from the target and clearly closer to the person's own hair.
 * Reach is only compared when neither side is cut off by its frame; area always is.
 */
/**
 * Head turn, −1..1: nose vs the eye midpoint, in eye-spans. About ±0.2 is a clear left/right turn.
 * Lucy v2v copies the camera hair again on a turn, so the live session re-sends the style then.
 */
export function headYaw(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 468) return 0;
  const span = landmarks[263].x - landmarks[33].x;
  if (Math.abs(span) < 1e-4) return 0;
  const mid = (landmarks[33].x + landmarks[263].x) / 2;
  return (landmarks[1].x - mid) / span;
}

export function hairDrifted(live, target, own, { minDistance = 0.35, ownRatio = 0.6 } = {}) {
  if (!live || !target) return false;
  const distance = (a, b) => {
    const area = Math.abs((a.area ?? 0) - (b.area ?? 0)) / Math.max(0.3, b.area || 0.3);
    const reach = a.clipped || b.clipped ? 0 : Math.abs(a.reach - b.reach);
    const front = Math.abs((a.front ?? 0) - (b.front ?? 0));
    return Math.max(area, reach, front);
  };
  const toTarget = distance(live, target);
  if (toTarget < minDistance) return false;
  if (!own) return toTarget > minDistance * 1.6;
  return distance(live, own) < toTarget * ownRatio;
}

/**
 * Final still for Lucy: Gemini's styled frame with the webcam face blended back.
 * Returns null when alignment is not possible; the caller keeps the Gemini preview.
 * Browser tests set `__testFaceRestore = "skip"` so the preview bytes stay unchanged.
 */
export async function lockHairOntoUser({ personDataUrl, styledBlob } = {}) {
  if (!personDataUrl || !styledBlob) return null;
  if (globalThis.__testFaceRestore === "skip") return null;
  let personBitmap = null;
  let styledBitmap = null;
  try {
    personBitmap = await createImageBitmap(await (await fetch(personDataUrl)).blob());
    styledBitmap = await createImageBitmap(styledBlob);
    const personCanvas = drawBitmap(personBitmap);
    const styledCanvas = drawBitmap(styledBitmap);
    const personFaces = await detectFaceLandmarks(personCanvas);
    const styledFaces = await detectFaceLandmarks(styledCanvas);
    if (personFaces.length !== 1 || styledFaces.length !== 1) return null;
    let styledHair = null;
    try {
      styledHair = await segmentSelfieHair(styledCanvas);
    } catch {
      styledHair = null;
    }
    const hairLength = styledHair
      ? hairLengthFromMask(styledHair, styledCanvas.width, styledCanvas.height, styledFaces[0])
      : null;
    const personCtx = personCanvas.getContext("2d", { willReadFrequently: true });
    const styledCtx = styledCanvas.getContext("2d", { willReadFrequently: true });
    const rendered = renderLockedPreview({
      person: personCtx.getImageData(0, 0, personCanvas.width, personCanvas.height).data,
      styled: styledCtx.getImageData(0, 0, styledCanvas.width, styledCanvas.height).data,
      personWidth: personCanvas.width,
      personHeight: personCanvas.height,
      styledWidth: styledCanvas.width,
      styledHeight: styledCanvas.height,
      personLandmarks: personFaces[0],
      styledLandmarks: styledFaces[0],
      styledHair,
    });
    if (!rendered) return hairLength ? { blob: null, hairLength } : null;
    const out = document.createElement("canvas");
    out.width = personCanvas.width;
    out.height = personCanvas.height;
    out.getContext("2d").putImageData(new ImageData(rendered.rgba, out.width, out.height), 0, 0);
    const blob = await new Promise((resolve) => out.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) return null;
    const maskDataUrl = maskToPngDataUrl(rendered.faceMask, out.width, out.height);
    console.info("hair-face-lock", {
      mode: rendered.mode,
      scale: Number(rendered.transform.scale.toFixed(3)),
      hairMask: Boolean(styledHair),
      toneSamples: rendered.tone.samples,
      hairLength: hairLength ? `${hairLength.length} (${hairLength.reach.toFixed(2)} face heights below the chin${hairLength.clipped ? ", clipped" : ""})` : null,
    });
    return { blob, dataUrl: out.toDataURL("image/jpeg", 0.92), maskDataUrl, mode: rendered.mode, hairLength };
  } catch (error) {
    console.warn("hair-face-lock", error?.message || error);
    return null;
  } finally {
    try { personBitmap?.close(); } catch { /* ignore */ }
    try { styledBitmap?.close(); } catch { /* ignore */ }
  }
}
