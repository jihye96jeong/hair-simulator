/**
 * Deterministic bald-mask + 2D prefill before Gemini baseline refine.
 * Gemini only photorealizes inside the bald mask; geometry is decided here.
 */

/** Skull ellipse width = face width × this. 병원 확인 전 임시값. */
export const SKULL_WIDTH_FACTOR = 1.15;
/** Skull top = browTopY − faceHeight × this. 병원 확인 전 임시값. */
export const SKULL_TOP_FACE_HEIGHT_FACTOR = 0.9;
/** Side-hair keep band thickness / vertical span around ears (cm). 병원 확인 전 임시값. */
export const SIDE_HAIR_KEEP_CM = 1.5;
/** Soft edge on bald mask (px). Range 3–5. 병원 확인 전 임시값. */
export const BALD_MASK_FEATHER_PX = 4;

function hashBuffer(bytes) {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function faceWidthFromMeasure(measure) {
  const left = measure?.templeLeft?.x;
  const right = measure?.templeRight?.x;
  if (Number.isFinite(left) && Number.isFinite(right)) return Math.abs(right - left);
  return measure.width * 0.45;
}

function skullEllipse(measure) {
  const faceW = faceWidthFromMeasure(measure);
  const faceH = measure.faceHeightPx
    || Math.max(1, (measure.height * 0.55) - (measure.browTopY || 0));
  const cx = Number.isFinite(measure.faceCenterX)
    ? measure.faceCenterX
    : ((measure.templeLeft?.x ?? 0) + (measure.templeRight?.x ?? measure.width)) / 2;
  const rx = (faceW * SKULL_WIDTH_FACTOR) / 2;
  const top = measure.browTopY - faceH * SKULL_TOP_FACE_HEIGHT_FACTOR;
  const earBottom = Math.max(
    measure.earLeft?.y ?? measure.templeLeft?.y ?? measure.browTopY + faceH * 0.55,
    measure.earRight?.y ?? measure.templeRight?.y ?? measure.browTopY + faceH * 0.55,
  );
  const bottom = earBottom;
  const cy = (top + bottom) / 2;
  const ry = Math.max(1, (bottom - top) / 2);
  return { cx, cy, rx, ry, top, bottom };
}

function insideEllipse(x, y, { cx, cy, rx, ry }) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function ellipseOuterRadiusAt(x, y, ell) {
  const dx = x - ell.cx;
  const dy = y - ell.cy;
  const ang = Math.atan2(dy / ell.ry, dx / ell.rx);
  const ex = ell.cx + Math.cos(ang) * ell.rx;
  const ey = ell.cy + Math.sin(ang) * ell.ry;
  return Math.hypot(ex - ell.cx, ey - ell.cy);
}

/**
 * Side-hair keep band: each side, from 1.5cm above ear down to ear bottom,
 * within 1.5cm outside the skull ellipse.
 */
export function buildSideHairKeepMask(measure) {
  const { width, height, pxPerCm, browTopY } = measure;
  const keep = new Float32Array(width * height);
  const band = SIDE_HAIR_KEEP_CM * pxPerCm;
  const ell = skullEllipse(measure);
  for (const ear of [measure.earLeft, measure.earRight, measure.templeLeft, measure.templeRight]) {
    if (!ear) continue;
    const y0 = ear.y - band;
    const y1 = ear.y + band * 0.15;
    const sideSign = ear.x < ell.cx ? -1 : 1;
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(height - 1, Math.ceil(y1)); y++) {
      for (let x = 0; x < width; x++) {
        if (y >= browTopY) continue;
        if (insideEllipse(x, y, ell)) continue;
        const distOut = Math.hypot(x - ell.cx, y - ell.cy) - ellipseOuterRadiusAt(x, y, ell);
        if (distOut < 0 || distOut > band) continue;
        // Prefer the matching side
        if ((x - ell.cx) * sideSign < 0) continue;
        keep[y * width + x] = 1;
      }
    }
  }
  return keep;
}

/**
 * Bald mask = hair region − side keep band. Never includes browTopY and below.
 * Soft mask 0..1 after feather.
 */
export function buildBaldMask({ hairMask, measure }) {
  const { width, height, browTopY } = measure;
  const hard = new Float32Array(width * height);
  const keep = buildSideHairKeepMask(measure);
  for (let i = 0; i < hard.length; i++) {
    const y = Math.floor(i / width);
    if (y >= browTopY) continue;
    if (hairMask[i] && keep[i] < 0.5) hard[i] = 1;
  }
  const soft = featherMaskBox(hard, width, height, BALD_MASK_FEATHER_PX);
  for (let y = Math.floor(browTopY); y < height; y++) {
    for (let x = 0; x < width; x++) soft[y * width + x] = 0;
  }
  // Feather may bleed into the side-hair keep band — hard-zero it.
  for (let i = 0; i < soft.length; i++) {
    if (keep[i] > 0.5) soft[i] = 0;
  }
  return soft;
}

function featherMaskBox(mask, width, height, radiusPx) {
  const r = Math.max(1, Math.round(radiusPx));
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
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
      tmp[y * width + x] = sum / (n || 1);
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
      out[y * width + x] = sum / (n || 1);
    }
  }
  return out;
}

function sampleForeheadSkin(rgba, width, height, measure) {
  const y1 = Math.max(0, Math.floor(measure.browTopY - 2 * measure.pxPerCm));
  const y0 = Math.max(0, Math.floor(measure.browTopY - 1 * measure.pxPerCm));
  const x0 = Math.floor((measure.templeLeft?.x ?? width * 0.25) + width * 0.05);
  const x1 = Math.floor((measure.templeRight?.x ?? width * 0.75) - width * 0.05);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const hiFreq = [];
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
      const o = (y * width + x) * 4;
      r += rgba[o];
      g += rgba[o + 1];
      b += rgba[o + 2];
      n += 1;
    }
  }
  if (!n) return { mean: [200, 170, 150], texture: new Float32Array(0) };
  const mean = [r / n, g / n, b / n];
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
      const o = (y * width + x) * 4;
      const lum = (rgba[o] + rgba[o + 1] + rgba[o + 2]) / 3;
      const meanLum = (mean[0] + mean[1] + mean[2]) / 3;
      hiFreq.push(lum - meanLum);
    }
  }
  return { mean, texture: Float32Array.from(hiFreq) };
}

function textureAt(tex, i) {
  if (!tex.length) return 0;
  return tex[i % tex.length];
}

/**
 * Simple inward diffusion inpaint for background (outside skull, in bald mask).
 * Iterates only the mask bbox for speed.
 */
function inpaintBackground(rgba, width, height, targetMask, protectY) {
  const out = new Uint8ClampedArray(rgba);
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < Math.min(height, protectY); y++) {
    for (let x = 0; x < width; x++) {
      if (targetMask[y * width + x] <= 0.05) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX) return out;

  const rCh = new Float32Array(width * height);
  const gCh = new Float32Array(width * height);
  const bCh = new Float32Array(width * height);
  const known = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const y = Math.floor(i / width);
    if (y >= protectY || targetMask[i] < 0.05) known[i] = 1;
    const o = i * 4;
    rCh[i] = out[o];
    gCh[i] = out[o + 1];
    bCh[i] = out[o + 2];
  }
  const x0 = Math.max(1, minX - 1);
  const x1 = Math.min(width - 2, maxX + 1);
  const y0 = Math.max(1, minY - 1);
  const y1 = Math.min(protectY - 1, maxY + 1);
  for (let iter = 0; iter < 24; iter++) {
    let changed = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * width + x;
        if (targetMask[i] < 0.05 || known[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const j = (y + dy) * width + (x + dx);
          if (!known[j] && targetMask[j] >= 0.05) continue;
          r += rCh[j];
          g += gCh[j];
          b += bCh[j];
          n += 1;
        }
        if (!n) continue;
        rCh[i] = r / n;
        gCh[i] = g / n;
        bCh[i] = b / n;
        known[i] = 1;
        changed += 1;
      }
    }
    if (!changed) break;
  }
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = y * width + x;
      const a = targetMask[i];
      if (a < 0.05) continue;
      const o = i * 4;
      out[o] = Math.round(out[o] * (1 - a) + rCh[i] * a);
      out[o + 1] = Math.round(out[o + 1] * (1 - a) + gCh[i] * a);
      out[o + 2] = Math.round(out[o + 2] * (1 - a) + bCh[i] * a);
    }
  }
  return out;
}

function canvasFromRgba(rgba, width, height) {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(width, height);
    c.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
    return c;
  }
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    c.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
    return c;
  }
  return { width, height, __rgba: rgba, convertToBlob: async () => new Blob([rgba]) };
}

async function canvasToBlob(canvas, type, quality) {
  if (canvas.__rgba) {
    try {
      const sharp = (await import("sharp")).default;
      const { width, height } = canvas;
      const buf = await sharp(Buffer.from(canvas.__rgba), { raw: { width, height, channels: 4 } })
        .jpeg({ quality: Math.round((quality || 0.9) * 100) })
        .toBuffer();
      return new Blob([buf], { type: type || "image/jpeg" });
    } catch {
      return new Blob([canvas.__rgba], { type: type || "application/octet-stream" });
    }
  }
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), type, quality);
  });
}

function maskToPngRgba(mask, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < mask.length; i++) {
    const v = Math.round(Math.min(1, Math.max(0, mask[i])) * 255);
    const o = i * 4;
    rgba[o] = v;
    rgba[o + 1] = v;
    rgba[o + 2] = v;
    rgba[o + 3] = 255;
  }
  return rgba;
}

/**
 * Assert bald mask does not invade protect region or side-hair keep band (hard keep).
 */
export function assertBaldMaskRespectsKeep({ baldMask, keepMask, measure, threshold = 0.35 }) {
  const { width, height, browTopY } = measure;
  for (let y = Math.floor(browTopY); y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (baldMask[y * width + x] > threshold) {
        const error = new Error("bald-mask-protect");
        error.code = "bald-mask-protect";
        throw error;
      }
    }
  }
  for (let i = 0; i < baldMask.length; i++) {
    if (keepMask[i] > 0.5 && baldMask[i] > threshold) {
      const error = new Error("bald-mask-side-keep");
      error.code = "bald-mask-side-keep";
      throw error;
    }
  }
  return true;
}

/**
 * 2D prefill: scalp paint inside skull, background inpaint outside, protect below brow.
 */
export async function prefillBaseline({ imageData, hairMask, measure }) {
  const { width, height, data: src } = imageData;
  const rgba = new Uint8ClampedArray(src);
  const baldMask = buildBaldMask({ hairMask, measure });
  // Zero protect after feather
  for (let y = Math.floor(measure.browTopY); y < height; y++) {
    for (let x = 0; x < width; x++) baldMask[y * width + x] = 0;
  }
  const keep = buildSideHairKeepMask(measure);
  try {
    assertBaldMaskRespectsKeep({ baldMask, keepMask: keep, measure, threshold: 0.5 });
  } catch {
    // Soft feather may slightly overlap keep — zero keep hard
    for (let i = 0; i < baldMask.length; i++) {
      if (keep[i] > 0.5) baldMask[i] = 0;
    }
  }

  const ell = skullEllipse(measure);
  const skin = sampleForeheadSkin(rgba, width, height, measure);
  const outsideMask = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    if (y >= measure.browTopY) continue;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const a = baldMask[i];
      if (a <= 0.02) continue;
      if (insideEllipse(x, y, ell)) {
        const t = Math.min(1, Math.max(0, (ell.cy + ell.ry - y) / Math.max(1, 2 * ell.ry)));
        const bright = 1 + 0.08 * t;
        const tex = textureAt(skin.texture, i) * 0.35;
        const o = i * 4;
        const nr = Math.min(255, Math.max(0, skin.mean[0] * bright + tex));
        const ng = Math.min(255, Math.max(0, skin.mean[1] * bright + tex));
        const nb = Math.min(255, Math.max(0, skin.mean[2] * bright + tex));
        rgba[o] = Math.round(rgba[o] * (1 - a) + nr * a);
        rgba[o + 1] = Math.round(rgba[o + 1] * (1 - a) + ng * a);
        rgba[o + 2] = Math.round(rgba[o + 2] * (1 - a) + nb * a);
      } else {
        outsideMask[i] = a;
      }
    }
  }
  const inpainted = inpaintBackground(rgba, width, height, outsideMask, measure.browTopY);
  // Protect region: restore original
  for (let y = Math.floor(measure.browTopY); y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      inpainted[o] = src[o];
      inpainted[o + 1] = src[o + 1];
      inpainted[o + 2] = src[o + 2];
      inpainted[o + 3] = src[o + 3];
    }
  }

  const prefillCanvas = canvasFromRgba(inpainted, width, height);
  const maskRgba = maskToPngRgba(baldMask, width, height);
  const maskCanvas = canvasFromRgba(maskRgba, width, height);
  let prefillBaselineBlob;
  let baldMaskBlob;
  if (prefillCanvas.convertToBlob) {
    prefillBaselineBlob = await canvasToBlob(prefillCanvas, "image/jpeg", 0.9);
    baldMaskBlob = await canvasToBlob(maskCanvas, "image/png");
  } else {
    prefillBaselineBlob = await canvasToBlob(prefillCanvas, "image/jpeg", 0.9);
    // PNG for mask via sharp path
    try {
      const sharp = (await import("sharp")).default;
      baldMaskBlob = new Blob([
        await sharp(Buffer.from(maskRgba), { raw: { width, height, channels: 4 } }).png().toBuffer(),
      ], { type: "image/png" });
    } catch {
      baldMaskBlob = await canvasToBlob(maskCanvas, "image/png");
    }
  }

  return {
    prefillBaseline: prefillBaselineBlob,
    baldMask: baldMaskBlob,
    baldMaskFloat: baldMask,
    rgba: inpainted,
    stats: {
      filledPixels: baldMask.reduce((n, v) => n + (v > 0.15 ? 1 : 0), 0),
      hash: hashBuffer(inpainted),
      maskHash: hashBuffer(maskRgba),
      featherPx: BALD_MASK_FEATHER_PX,
    },
  };
}

/** Compare protect-region pixels byte-identical. */
export function assertProtectRegionUnchanged(srcRgba, outRgba, width, height, browTopY) {
  const from = Math.floor(browTopY);
  for (let y = Math.max(0, from); y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (srcRgba[o] !== outRgba[o]
        || srcRgba[o + 1] !== outRgba[o + 1]
        || srcRgba[o + 2] !== outRgba[o + 2]) {
        return false;
      }
    }
  }
  return true;
}
