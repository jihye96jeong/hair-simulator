import { ruleFor } from "./graftRules.js";

/** Soft edge width in mm (병원 확인 전 임시값). */
const FEATHER_MM = 3;
const PROTECT_GAP_CM = 0.5;

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

/** Soft lift of ends toward temples so the drop tapers at the sides. */
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
 * Hard geometric fill region (0..1) before feathering.
 * Larger sizeCm → deeper / wider fill. Density is not painted here; it goes to the inpaint prompt.
 */
export function buildFillMask({ area, measure, sizeCm, rgba, hairMask }) {
  const { width, height } = measure;
  const mask = new Float32Array(width * height);
  const px = sizeCm * measure.pxPerCm;
  const protectY = measure.kind === "front"
    ? measure.browTopY - PROTECT_GAP_CM * measure.pxPerCm
    : height;

  if (area === "hairline") {
    const upper = measure.hairlineCurve;
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
        const i = y * width + x;
        if (!hairMask[i]) continue;
        const o = i * 4;
        const bright = rgba
          && rgba[o] > 120 && rgba[o + 1] > 100 && rgba[o + 2] > 90
          && Math.max(rgba[o], rgba[o + 1], rgba[o + 2]) - Math.min(rgba[o], rgba[o + 1], rgba[o + 2]) < 50;
        // Prefer scalp-showing pixels; still allow sparse fill inside radius.
        if (!bright && (x + y) % 2 !== 0) continue;
        mask[i] = 1;
      }
    }
  } else {
    throw new Error(`unknown-graft-area:${area}`);
  }
  return mask;
}

/** Separable box blur for soft mask edges (white=fill). */
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
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

async function canvasToBlob(canvas, type, quality) {
  if (canvas.__rgba) {
    return new Blob([canvas.__rgba], { type: type || "application/octet-stream" });
  }
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode"))), type, quality);
  });
}

function maskToRgba(fillMask) {
  const rgba = new Uint8ClampedArray(fillMask.length * 4);
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

function countFilled(fillMask, threshold = 0.15) {
  let n = 0;
  for (let i = 0; i < fillMask.length; i++) if (fillMask[i] >= threshold) n += 1;
  return n;
}

/**
 * Build a feathered fill mask only (white = inpaint). No painted hair.
 */
export async function buildGraftMask({
  imageData,
  hairMask,
  measure,
  area,
  grafts,
}) {
  const rule = ruleFor(area, grafts);
  const { width, height } = measure;
  if (imageData.width !== width || imageData.height !== height) {
    throw new Error("frame-size-mismatch");
  }
  const hard = buildFillMask({
    area,
    measure,
    sizeCm: rule.sizeCm,
    rgba: imageData.data,
    hairMask,
  });
  const radiusPx = Math.max(1, FEATHER_MM * 0.1 * measure.pxPerCm);
  let soft = featherMask(hard, width, height, radiusPx);
  if (measure.kind === "front") {
    soft = protectBelowBrow(soft, width, height, measure.browTopY);
  }
  const rgba = maskToRgba(soft);
  const maskCanvas = canvasFromRgba(rgba, width, height);
  const mask = await canvasToBlob(maskCanvas, "image/png");
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
      hash: hashBuffer(rgba),
      featherPx: radiusPx,
    },
  };
}

/** @deprecated Use buildGraftMask. Kept so older imports keep working during transition. */
export async function buildGraftGuide(input) {
  const result = await buildGraftMask(input);
  return {
    ...result,
    guide: result.mask,
  };
}

/** Mask must be fully black (0) at/below browTopY. */
export function assertProtectedRegionUnmasked(fillMask, width, height, browTopY) {
  const from = Math.floor(browTopY);
  for (let y = Math.max(0, from); y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (fillMask[y * width + x] !== 0) return false;
    }
  }
  return true;
}

/** @deprecated Prefer assertProtectedRegionUnmasked for mask-only guides. */
export function assertProtectedRegionUnchanged(originalRgba, guidedRgba, width, height, browTopY) {
  void originalRgba;
  void guidedRgba;
  // Legacy painted-guide helper no longer applies; treat as pass-through for old call sites.
  return assertProtectedRegionUnmasked(
    new Float32Array(width * height),
    width,
    height,
    browTopY,
  );
}
