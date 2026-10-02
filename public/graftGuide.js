import { ruleFor } from "./graftRules.js";
import {
  GUIDE_BOTTOM_BLUR_PX,
  meanAlphaInMask,
  mulberry32,
  renderHairTextureLayer,
  seedFromKey,
} from "./hairTexture.js";

/** Soft edge width in mm (병원 확인 전 임시값). Range 2–4mm. */
const FEATHER_MM = 3;
const PROTECT_GAP_CM = 0.5;
/**
 * Hairline mask must span at least this fraction of temple-to-temple face width.
 * 병원 확인 전 임시값.
 */
export const MASK_FACE_WIDTH_MIN_RATIO = 0.6;

function hashBuffer(bytes) {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function interpolateCurveY(curve, x) {
  if (!curve.length) return NaN;
  if (x <= curve[0].x) return curve[0].y;
  if (x >= curve[curve.length - 1].x) return curve[curve.length - 1].y;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (x <= b.x) {
      const t = (x - a.x) / Math.max(1e-6, b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }
  }
  return curve[curve.length - 1].y;
}

function shiftedHairline(curve, depthPx) {
  return curve.map((p) => ({ x: p.x, y: p.y + depthPx }));
}

function taperedLowerCurve(upper, depthPx, templeLeft, templeRight) {
  const lower = shiftedHairline(upper, depthPx);
  const leftX = templeLeft?.x ?? upper[0].x;
  const rightX = templeRight?.x ?? upper[upper.length - 1].x;
  const span = Math.max(1, rightX - leftX);
  return lower.map((p) => {
    const t = Math.min(1, Math.max(0, (p.x - leftX) / span));
    const edge = Math.min(t, 1 - t) * 2;
    const ease = edge * edge * (3 - 2 * edge);
    const upY = interpolateCurveY(upper, p.x);
    return { x: p.x, y: upY + depthPx * ease };
  });
}

/**
 * Hard geometric fill region (0..1) on a recession baseline measure.
 * Density is applied by Gemini fill — mask geometry is solid (plus feather).
 */
export function buildFillMask({ area, measure, sizeCm }) {
  const { width, height } = measure;
  const mask = new Float32Array(width * height);
  const px = sizeCm * measure.pxPerCm;
  const protectY = measure.kind === "front"
    ? measure.browTopY - PROTECT_GAP_CM * measure.pxPerCm
    : height;

  if (area === "hairline") {
    const upper = measure.hairlineCurve;
    if (!upper?.length) throw new Error("hairline-curve-missing");
    const lower = taperedLowerCurve(upper, px, measure.templeLeft, measure.templeRight);
    const minX = Math.floor(Math.min(upper[0].x, lower[0].x));
    const maxX = Math.ceil(Math.max(upper[upper.length - 1].x, lower[lower.length - 1].x));
    for (let x = minX; x <= maxX; x++) {
      const y0 = interpolateCurveY(upper, x);
      const y1 = Math.min(interpolateCurveY(lower, x), protectY);
      if (!(y1 > y0)) continue;
      for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
        if (y < 0 || y >= height || x < 0 || x >= width) continue;
        if (y >= protectY) continue;
        mask[y * width + x] = 1;
      }
    }
  } else if (area === "mline") {
    const half = px;
    for (const temple of [measure.templeLeft, measure.templeRight]) {
      if (!temple) continue;
      const inward = temple === measure.templeLeft ? 1 : -1;
      const apexX = temple.x;
      const apexY = temple.y;
      const baseX = apexX + inward * half;
      const baseY = Math.min(apexY + half, protectY);
      const minX = Math.floor(Math.min(apexX, baseX));
      const maxX = Math.ceil(Math.max(apexX, baseX));
      for (let x = minX; x <= maxX; x++) {
        const t = (x - apexX) / Math.max(1e-6, baseX - apexX);
        if (t < 0 || t > 1) continue;
        const yTop = apexY + (interpolateCurveY(measure.hairlineCurve, x) - apexY) * Math.min(1, t * 0.35);
        const yBot = apexY + (baseY - apexY) * t;
        const y0 = Math.min(yTop, yBot);
        const y1 = Math.min(Math.max(yTop, yBot), protectY);
        for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
          if (y < 0 || y >= height || x < 0 || x >= width) continue;
          if (y >= protectY) continue;
          mask[y * width + x] = Math.max(mask[y * width + x], 1);
        }
      }
    }
  } else if (area === "crown") {
    const { x: cx, y: cy } = measure.crownCenter;
    const r = px;
    const r2 = r * r;
    const minX = Math.max(0, Math.floor(cx - r - 1));
    const maxX = Math.min(width - 1, Math.ceil(cx + r + 1));
    const minY = Math.max(0, Math.floor(cy - r - 1));
    const maxY = Math.min(height - 1, Math.ceil(cy + r + 1));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        mask[y * width + x] = 1;
      }
    }
  } else {
    throw new Error(`unknown-graft-area:${area}`);
  }
  return mask;
}

export function featherMask(mask, width, height, radiusPx) {
  const r = Math.max(1, Math.round(radiusPx));
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  const span = r * 2 + 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= width) continue;
        sum += mask[y * width + xx];
        n += 1;
      }
      tmp[y * width + x] = sum / (n || span);
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= height) continue;
        sum += tmp[yy * width + x];
        n += 1;
      }
      out[y * width + x] = sum / (n || span);
    }
  }
  return out;
}

function protectBelowBrow(mask, width, height, browTopY) {
  if (!Number.isFinite(browTopY)) return mask;
  const from = Math.floor(browTopY);
  for (let y = Math.max(0, from); y < height; y++) {
    for (let x = 0; x < width; x++) mask[y * width + x] = 0;
  }
  return mask;
}

export function maskBounds(fillMask, width, height, threshold = 0.15) {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (fillMask[y * width + x] < threshold) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX) return { minX: 0, maxX: 0, minY: 0, maxY: 0, widthPx: 0, heightPx: 0 };
  return {
    minX,
    maxX,
    minY,
    maxY,
    widthPx: maxX - minX + 1,
    heightPx: maxY - minY + 1,
  };
}

export function faceWidthPx(measure) {
  const left = measure?.templeLeft?.x;
  const right = measure?.templeRight?.x;
  if (!(Number.isFinite(left) && Number.isFinite(right))) return 0;
  return Math.abs(right - left);
}

/**
 * Hairline mask must follow the full hairline band across most of the face width.
 */
export function assertHairlineMaskWidth({
  fillMask,
  measure,
  minRatio = MASK_FACE_WIDTH_MIN_RATIO,
} = {}) {
  const { width, height } = measure;
  const faceW = faceWidthPx(measure);
  const bounds = maskBounds(fillMask, width, height);
  if (!(faceW > 0) || !(bounds.widthPx >= faceW * minRatio)) {
    const error = new Error("얼굴이 정면으로 보이게 다시 촬영해주세요");
    error.code = "mask-width-fail";
    error.faceWidthPx = faceW;
    error.maskWidthPx = bounds.widthPx;
    throw error;
  }
  return bounds;
}

function countFilled(fillMask, threshold = 0.15) {
  let n = 0;
  for (let i = 0; i < fillMask.length; i++) if (fillMask[i] >= threshold) n += 1;
  return n;
}

function maskRgba(fillMask, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < fillMask.length; i++) {
    const v = Math.round(Math.min(1, Math.max(0, fillMask[i])) * 255);
    const o = i * 4;
    rgba[o] = v;
    rgba[o + 1] = v;
    rgba[o + 2] = v;
    rgba[o + 3] = 255;
  }
  return rgba;
}

function canvasFromRgba(rgba, width, height) {
  let canvas;
  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(width, height);
  } else if (typeof document !== "undefined") {
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
  } else {
    return {
      width,
      height,
      __rgba: rgba,
      getContext: () => null,
      convertToBlob: async () => new Blob([rgba], { type: "application/octet-stream" }),
    };
  }
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba), width, height), 0, 0);
  return canvas;
}

async function canvasToBlob(canvas, type, quality) {
  if (canvas.__rgba) {
    try {
      const sharp = (await import("sharp")).default;
      const { width, height } = canvas;
      if (type === "image/png") {
        return new Blob([
          await sharp(Buffer.from(canvas.__rgba), { raw: { width, height, channels: 4 } }).png().toBuffer(),
        ], { type: "image/png" });
      }
      return new Blob([
        await sharp(Buffer.from(canvas.__rgba), { raw: { width, height, channels: 4 } })
          .jpeg({ quality: Math.round((quality || 0.9) * 100) })
          .toBuffer(),
      ], { type: "image/jpeg" });
    } catch {
      return new Blob([canvas.__rgba], { type: type || "application/octet-stream" });
    }
  }
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode"))), type, quality);
  });
}

/**
 * Build a white FILL MASK PNG only (no painted hair / no dot noise).
 */
export async function buildGraftMask({ measure, area, grafts }) {
  const rule = ruleFor(area, grafts);
  const { width, height } = measure;
  const hard = buildFillMask({ area, measure, sizeCm: rule.sizeCm });
  const radiusPx = Math.max(1, FEATHER_MM * 0.1 * measure.pxPerCm);
  let soft = featherMask(hard, width, height, radiusPx);
  // Extra bottom soft-edge so strands thin out toward the hairline (10–15px).
  soft = featherMask(soft, width, height, GUIDE_BOTTOM_BLUR_PX);
  if (measure.kind === "front") {
    soft = protectBelowBrow(soft, width, height, measure.browTopY);
  }
  let bounds = maskBounds(soft, width, height);
  if (area === "hairline") {
    bounds = assertHairlineMaskWidth({ fillMask: soft, measure });
  }
  const rgba = maskRgba(soft, width, height);
  const canvas = canvasFromRgba(rgba, width, height);
  const mask = await canvasToBlob(canvas, "image/png");
  return {
    mask,
    fillMask: soft,
    rgba,
    stats: {
      area,
      grafts,
      sizeCm: rule.sizeCm,
      density: rule.density,
      pxPerCm: measure.pxPerCm,
      filledPixels: countFilled(soft),
      faceWidthPx: faceWidthPx(measure),
      maskWidthPx: bounds.widthPx,
      hash: hashBuffer(rgba),
      featherPx: radiusPx,
      bottomBlurPx: GUIDE_BOTTOM_BLUR_PX,
    },
  };
}

/**
 * Composite deterministic hair texture into the baseline inside the fill mask.
 * Density maps to globalAlpha (0.6 / 0.8 / 0.95).
 */
export async function buildPrefillGuide({
  imageData,
  measure,
  area,
  grafts,
  fillMask: existingMask,
}) {
  const rule = ruleFor(area, grafts);
  const { width, height, data: src } = imageData;
  let fillMask = existingMask;
  if (!fillMask) {
    const built = await buildGraftMask({ measure, area, grafts });
    fillMask = built.fillMask;
  }
  const seed = seedFromKey(`${area}:${grafts}:${width}x${height}:${Math.round(measure.browTopY || 0)}`);
  const texture = renderHairTextureLayer({
    width,
    height,
    fillMask,
    measure,
    area,
    rgbaSource: src,
    seed,
    density: rule.density,
  });
  const out = new Uint8ClampedArray(src);
  for (let i = 0; i < fillMask.length; i++) {
    const o = i * 4;
    const a = (texture[o + 3] / 255) * Math.min(1, fillMask[i]);
    if (a <= 0.01) continue;
    out[o] = Math.round(out[o] * (1 - a) + texture[o] * a);
    out[o + 1] = Math.round(out[o + 1] * (1 - a) + texture[o + 1] * a);
    out[o + 2] = Math.round(out[o + 2] * (1 - a) + texture[o + 2] * a);
  }
  if (measure.kind === "front" && Number.isFinite(measure.browTopY)) {
    for (let y = Math.floor(measure.browTopY); y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        out[o] = src[o];
        out[o + 1] = src[o + 1];
        out[o + 2] = src[o + 2];
        out[o + 3] = src[o + 3];
      }
    }
  }
  const canvas = canvasFromRgba(out, width, height);
  const prefillGuide = await canvasToBlob(canvas, "image/jpeg", 0.9);
  return {
    prefillGuide,
    fillMask,
    textureRgba: texture,
    rgba: out,
    stats: {
      area,
      grafts,
      density: rule.density,
      seed,
      meanAlpha: meanAlphaInMask(texture, fillMask),
      hash: hashBuffer(out),
    },
  };
}

/** @deprecated Alias — callers should use buildGraftMask; returns mask as `guide` for older tests. */
export async function buildGraftGuide(input) {
  const result = await buildGraftMask(input);
  return {
    guide: result.mask,
    guidedRgba: result.rgba,
    fillMask: result.fillMask,
    mask: result.mask,
    rgba: result.rgba,
    stats: result.stats,
  };
}

export function assertProtectedRegionUnmasked(fillMask, width, height, browTopY) {
  const from = Math.floor(browTopY);
  for (let y = Math.max(0, from); y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (fillMask[y * width + x] !== 0) return false;
    }
  }
  return true;
}

export { meanAlphaInMask, mulberry32, seedFromKey };
