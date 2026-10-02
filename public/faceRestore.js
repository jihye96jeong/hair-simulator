/**
 * Face restore is unused in the live pipeline (referenceFlow never calls it).
 * Prior runs glued selfie bangs onto the Gemini result and warped identity into a third face.
 * Keep these helpers for experiments; do not composite unless alignment is proven stable.
 */
import {
  EYEBROW_INDICES,
  FACE_OVAL_RING,
  detectFaceLandmarks,
  landmarksToPixels,
} from "./faceMask.js";

/** Left eye, right eye, nose tip, mouth left, mouth right. */
export const ALIGNMENT_INDICES = Object.freeze([159, 386, 1, 61, 291]);

export function computeRestoreTopY(points) {
  let minBrow = Infinity;
  for (const i of EYEBROW_INDICES) {
    if (points[i]) minBrow = Math.min(minBrow, points[i].y);
  }
  if (!Number.isFinite(minBrow)) {
    const error = new Error("face-landmarks");
    error.code = "face-landmarks";
    throw error;
  }
  return minBrow;
}

/**
 * Face oval from eyebrow top to chin (hairline / upper forehead stay from the edit result).
 */
export function buildFaceRestorePolygon(landmarks, width, height) {
  if (!Array.isArray(landmarks) || landmarks.length < 468) {
    const error = new Error("face-landmarks");
    error.code = "face-landmarks";
    throw error;
  }
  const points = landmarksToPixels(landmarks, width, height);
  const topY = computeRestoreTopY(points);
  const oval = FACE_OVAL_RING.map((i) => points[i]);
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
  if (polygon.length < 3) {
    const error = new Error("face-polygon");
    error.code = "face-polygon";
    throw error;
  }
  return polygon;
}

export function alignmentPointsFromLandmarks(landmarks, width, height) {
  const points = landmarksToPixels(landmarks, width, height);
  return ALIGNMENT_INDICES.map((i) => {
    if (!points[i]) throw new Error("face-landmarks");
    return { x: points[i].x, y: points[i].y };
  });
}

/** x' = a*x - b*y + tx, y' = b*x + a*y + ty */
export function estimateSimilarityTransform(src, dst) {
  if (!Array.isArray(src) || src.length !== dst.length || src.length < 2) {
    throw new Error("need-points");
  }
  const n = src.length;
  let mx = 0;
  let my = 0;
  let Mx = 0;
  let My = 0;
  for (let i = 0; i < n; i++) {
    mx += src[i].x;
    my += src[i].y;
    Mx += dst[i].x;
    My += dst[i].y;
  }
  mx /= n;
  my /= n;
  Mx /= n;
  My /= n;
  let sxx = 0;
  let sxy = 0;
  let syx = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i].x - mx;
    const y = src[i].y - my;
    const X = dst[i].x - Mx;
    const Y = dst[i].y - My;
    sxx += x * X + y * Y;
    sxy += x * Y - y * X;
    syx += x * x + y * y;
  }
  const denom = syx || 1e-9;
  const a = sxx / denom;
  const b = sxy / denom;
  const tx = Mx - a * mx + b * my;
  const ty = My - b * mx - a * my;
  return { a, b, tx, ty };
}

export function faceWidthFromPolygon(polygon) {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of polygon) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
  }
  return Math.max(1, maxX - minX);
}

export function featherRadiusFromFaceWidth(faceWidth) {
  return Math.max(1, faceWidth * 0.04);
}

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c) {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * (c ** (1 / 2.4)) - 0.055;
  return Math.min(255, Math.max(0, Math.round(v * 255)));
}

export function rgbToLab(r, g, b) {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  let x = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
  let y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  let z = R * 0.0193339 + G * 0.119192 + B * 0.9503041;
  x /= 0.95047;
  z /= 1.08883;
  const f = (t) => (t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const inv = (t) => {
    const t3 = t ** 3;
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
  };
  const x = 0.95047 * inv(fx);
  const y = inv(fy);
  const z = 1.08883 * inv(fz);
  const R = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const G = x * -0.969266 + y * 1.8760108 + z * 0.041556;
  const B = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
  return {
    r: linearToSrgb(R),
    g: linearToSrgb(G),
    b: linearToSrgb(B),
  };
}

export function labChannelStats(labSamples) {
  const stats = { L: { mean: 0, std: 0 }, a: { mean: 0, std: 0 }, b: { mean: 0, std: 0 } };
  const n = labSamples.length;
  if (!n) return stats;
  for (const ch of ["L", "a", "b"]) {
    let sum = 0;
    for (const sample of labSamples) sum += sample[ch];
    const mean = sum / n;
    let varSum = 0;
    for (const sample of labSamples) {
      const d = sample[ch] - mean;
      varSum += d * d;
    }
    stats[ch] = { mean, std: Math.sqrt(varSum / n) || 1e-6 };
  }
  return stats;
}

/** Match source Lab distribution to target (per channel). */
export function correctLabSample(sample, sourceStats, targetStats) {
  const out = {};
  for (const ch of ["L", "a", "b"]) {
    const src = sourceStats[ch];
    const dst = targetStats[ch];
    out[ch] = ((sample[ch] - src.mean) / src.std) * dst.std + dst.mean;
  }
  return out;
}

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function distanceToPolygonEdge(x, y, polygon) {
  let min = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1e-9;
    let t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (d < min) min = d;
  }
  return min;
}

export function polygonMaskAlpha(x, y, polygon, featherPx) {
  if (!pointInPolygon(x, y, polygon)) return 0;
  const dist = distanceToPolygonEdge(x, y, polygon);
  if (featherPx <= 0) return 1;
  return Math.min(1, dist / featherPx);
}

async function loadImage(dataUrl) {
  const img = new Image();
  img.decoding = "async";
  img.src = dataUrl;
  await img.decode();
  return img;
}

/**
 * Composite the selfie face (brow top → chin) onto the Gemini preview.
 */
export async function restoreFaceOnPreview({
  selfieDataUrl,
  previewDataUrl,
  detectFaces = detectFaceLandmarks,
} = {}) {
  if (globalThis.__testFaceRestore === "skip") {
    return { ok: true, skipped: true, dataUrl: previewDataUrl };
  }
  try {
    const [selfieImg, previewImg] = await Promise.all([
      loadImage(selfieDataUrl),
      loadImage(previewDataUrl),
    ]);
    const selfieFaces = await detectFaces(selfieImg);
    const previewFaces = await detectFaces(previewImg);
    if (selfieFaces.length !== 1 || previewFaces.length !== 1) {
      return { ok: true, skipped: true, dataUrl: previewDataUrl };
    }

    const w = previewImg.width;
    const h = previewImg.height;
    const previewCanvas = document.createElement("canvas");
    previewCanvas.width = w;
    previewCanvas.height = h;
    const previewCtx = previewCanvas.getContext("2d", { willReadFrequently: true });
    previewCtx.drawImage(previewImg, 0, 0);

    const selfieCanvas = document.createElement("canvas");
    selfieCanvas.width = selfieImg.width;
    selfieCanvas.height = selfieImg.height;
    const selfieCtx = selfieCanvas.getContext("2d", { willReadFrequently: true });
    selfieCtx.drawImage(selfieImg, 0, 0);

    const srcPoints = alignmentPointsFromLandmarks(selfieFaces[0], selfieImg.width, selfieImg.height);
    const dstPoints = alignmentPointsFromLandmarks(previewFaces[0], w, h);
    const { a, b, tx, ty } = estimateSimilarityTransform(srcPoints, dstPoints);

    const warped = document.createElement("canvas");
    warped.width = w;
    warped.height = h;
    const warpedCtx = warped.getContext("2d", { willReadFrequently: true });
    warpedCtx.setTransform(a, b, -b, a, tx, ty);
    warpedCtx.drawImage(selfieCanvas, 0, 0);
    warpedCtx.setTransform(1, 0, 0, 1, 0, 0);

    const polygon = buildFaceRestorePolygon(previewFaces[0], w, h);
    const feather = featherRadiusFromFaceWidth(faceWidthFromPolygon(polygon));

    const previewData = previewCtx.getImageData(0, 0, w, h);
    const warpedData = warpedCtx.getImageData(0, 0, w, h);
    const targetLabs = [];
    const sourceLabs = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (polygonMaskAlpha(x + 0.5, y + 0.5, polygon, 0) <= 0) continue;
        const i = (y * w + x) * 4;
        targetLabs.push(rgbToLab(previewData.data[i], previewData.data[i + 1], previewData.data[i + 2]));
        sourceLabs.push(rgbToLab(warpedData.data[i], warpedData.data[i + 1], warpedData.data[i + 2]));
      }
    }
    const targetStats = labChannelStats(targetLabs);
    const sourceStats = labChannelStats(sourceLabs);

    const out = previewCtx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const alpha = polygonMaskAlpha(x + 0.5, y + 0.5, polygon, feather);
        if (alpha <= 0) {
          out.data[i] = previewData.data[i];
          out.data[i + 1] = previewData.data[i + 1];
          out.data[i + 2] = previewData.data[i + 2];
          out.data[i + 3] = 255;
          continue;
        }
        const corrected = correctLabSample(
          rgbToLab(warpedData.data[i], warpedData.data[i + 1], warpedData.data[i + 2]),
          sourceStats,
          targetStats,
        );
        const rgb = labToRgb(corrected.L, corrected.a, corrected.b);
        const inv = 1 - alpha;
        out.data[i] = Math.round(rgb.r * alpha + previewData.data[i] * inv);
        out.data[i + 1] = Math.round(rgb.g * alpha + previewData.data[i + 1] * inv);
        out.data[i + 2] = Math.round(rgb.b * alpha + previewData.data[i + 2] * inv);
        out.data[i + 3] = 255;
      }
    }
    previewCtx.putImageData(out, 0, 0);
    return { ok: true, skipped: false, dataUrl: previewCanvas.toDataURL("image/jpeg", 0.92) };
  } catch {
    return { ok: true, skipped: true, dataUrl: previewDataUrl };
  }
}
