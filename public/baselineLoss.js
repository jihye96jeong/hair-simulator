/**
 * Deterministic virtual hair-loss baseline for full-hair test faces (/lab).
 * Same inputs → same baselineFrame + baselineMask.
 */
import { BASELINE } from "./graftRules.js";

/** Soft edge width in mm when painting scalp into cleared hair. 병원 확인 전 임시값. */
const EDGE_MM_MIN = 2;
const EDGE_MM_MAX = 4;

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

function hashBuffer(bytes) {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function protectYFor(measure) {
  if (measure.kind === "front" && Number.isFinite(measure.browTopY)) return measure.browTopY;
  return measure.height;
}

/** Sample mean forehead/face skin color above the brows (or near crown center). */
export function sampleSkinColor(rgba, faceMask, width, height, measure) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  if (measure.kind === "front") {
    const y0 = Math.max(0, Math.floor(measure.browTopY - measure.pxPerCm * 0.4));
    const y1 = Math.min(height - 1, Math.floor(measure.browTopY + measure.pxPerCm * 0.8));
    const x0 = Math.floor(width * 0.3);
    const x1 = Math.floor(width * 0.7);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * width + x;
        if (faceMask && !faceMask[i]) continue;
        const o = i * 4;
        r += rgba[o];
        g += rgba[o + 1];
        b += rgba[o + 2];
        n += 1;
      }
    }
  } else {
    const { x: cx, y: cy } = measure.crownCenter;
    const rad = Math.max(4, measure.pxPerCm * 1.2);
    for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
      for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = y * width + x;
        const o = i * 4;
        const bright = rgba[o] > 120 && rgba[o + 1] > 100 && rgba[o + 2] > 90;
        if (!bright && faceMask && !faceMask[i]) continue;
        r += rgba[o];
        g += rgba[o + 1];
        b += rgba[o + 2];
        n += 1;
      }
    }
  }
  if (!n) return { r: 200, g: 170, b: 150 };
  return { r: r / n, g: g / n, b: b / n };
}

function skinAtHeight(base, browTopY, y, brighterUp = true) {
  const t = brighterUp && Number.isFinite(browTopY)
    ? Math.min(1, Math.max(0, (browTopY - y) / Math.max(8, browTopY * 0.35)))
    : 0;
  const lift = 18 * t;
  return {
    r: Math.min(255, base.r + lift),
    g: Math.min(255, base.g + lift * 0.92),
    b: Math.min(255, base.b + lift * 0.85),
  };
}

function edgePx(measure) {
  const mm = (EDGE_MM_MIN + EDGE_MM_MAX) / 2;
  return Math.max(1, mm * 0.1 * measure.pxPerCm);
}

function paintCleared(rgba, mask, i, color, alpha) {
  if (alpha <= 0) return;
  const o = i * 4;
  const a = Math.min(1, Math.max(0, alpha));
  rgba[o] = Math.round(rgba[o] * (1 - a) + color.r * a);
  rgba[o + 1] = Math.round(rgba[o + 1] * (1 - a) + color.g * a);
  rgba[o + 2] = Math.round(rgba[o + 2] * (1 - a) + color.b * a);
  mask[i] = Math.max(mask[i], a);
}

function clearHairline(rgba, mask, hairMask, measure, faceMask, skin) {
  const { width, height, hairlineCurve, pxPerCm } = measure;
  const recedePx = BASELINE.hairline.recedeCm * pxPerCm;
  const soft = edgePx(measure);
  const protectY = protectYFor(measure);
  const virtual = hairlineCurve.map((p) => ({ x: p.x, y: p.y - recedePx }));
  let cleared = 0;
  const minX = Math.floor(Math.min(virtual[0].x, hairlineCurve[0].x));
  const maxX = Math.ceil(Math.max(virtual[virtual.length - 1].x, hairlineCurve[hairlineCurve.length - 1].x));
  for (let x = minX; x <= maxX; x++) {
    if (x < 0 || x >= width) continue;
    const yVirt = interpolateCurveY(virtual, x);
    const yOrig = interpolateCurveY(hairlineCurve, x);
    // Core void between virtual and original; soft only on outer edges.
    const y0 = Math.floor(yVirt);
    const y1 = Math.min(Math.ceil(yOrig), Math.floor(protectY) - 1);
    for (let y = y0 - Math.ceil(soft); y <= y1 + Math.ceil(soft * 0.25); y++) {
      if (y < 0 || y >= height || y >= protectY) continue;
      const i = y * width + x;
      if (!hairMask[i] && !(faceMask && faceMask[i])) continue;
      let alpha = 0;
      if (y >= yVirt && y <= yOrig) alpha = 1;
      else if (y < yVirt) alpha = 1 - (yVirt - y) / soft;
      else if (y > yOrig) alpha = 1 - (y - yOrig) / soft;
      alpha = Math.min(1, Math.max(0, alpha));
      if (alpha <= 0) continue;
      const color = skinAtHeight(skin, measure.browTopY, y, true);
      paintCleared(rgba, mask, i, color, alpha);
      if (alpha > 0.35) {
        hairMask[i] = 0;
        cleared += 1;
      }
    }
  }
  return {
    cleared,
    geometry: {
      kind: "hairline",
      recedeCm: BASELINE.hairline.recedeCm,
      virtualHairline: virtual,
      originalHairline: hairlineCurve.map((p) => ({ ...p })),
    },
  };
}

function clearMline(rgba, mask, hairMask, measure, faceMask, skin) {
  const { width, height, pxPerCm } = measure;
  const side = BASELINE.mline.cornerCm * pxPerCm;
  const soft = edgePx(measure);
  const protectY = protectYFor(measure);
  let cleared = 0;
  for (const temple of [measure.templeLeft, measure.templeRight]) {
    if (!temple) continue;
    const inward = temple === measure.templeLeft ? 1 : -1;
    const apexX = temple.x;
    const apexY = temple.y;
    const baseX = apexX + inward * side;
    const baseY = Math.min(apexY + side, protectY);
    const minX = Math.floor(Math.min(apexX, baseX) - soft);
    const maxX = Math.ceil(Math.max(apexX, baseX) + soft);
    for (let x = minX; x <= maxX; x++) {
      if (x < 0 || x >= width) continue;
      const t = (x - apexX) / Math.max(1e-6, baseX - apexX);
      if (t < -0.05 || t > 1.05) continue;
      const yTop = apexY + (interpolateCurveY(measure.hairlineCurve, x) - apexY) * Math.min(1, Math.max(0, t) * 0.35);
      const yBot = apexY + (baseY - apexY) * Math.min(1, Math.max(0, t));
      const y0 = Math.floor(Math.min(yTop, yBot) - soft);
      const y1 = Math.min(Math.ceil(Math.max(yTop, yBot) + soft), Math.floor(protectY) - 1);
      for (let y = y0; y <= y1; y++) {
        if (y < 0 || y >= height || y >= protectY) continue;
        const i = y * width + x;
        if (!hairMask[i]) continue;
        const tt = Math.min(1, Math.max(0, t));
        const edgeDist = Math.min(tt, 1 - tt) * side;
        let alpha = 1;
        if (edgeDist < soft) alpha = edgeDist / soft;
        const color = skinAtHeight(skin, measure.browTopY, y, true);
        paintCleared(rgba, mask, i, color, alpha);
        if (alpha > 0.35) {
          hairMask[i] = 0;
          cleared += 1;
        }
      }
    }
  }
  return {
    cleared,
    geometry: {
      kind: "mline",
      cornerCm: BASELINE.mline.cornerCm,
      templeLeft: measure.templeLeft ? { ...measure.templeLeft } : null,
      templeRight: measure.templeRight ? { ...measure.templeRight } : null,
    },
  };
}

/** Deterministic hash → [0,1) for crown thinning. */
function unitHash(x, y, seed) {
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h >>> 0) / 4294967296;
}

function clearCrown(rgba, mask, hairMask, measure, faceMask, skin) {
  const { width, height, pxPerCm, crownCenter } = measure;
  const R = BASELINE.crown.radiusCm * pxPerCm;
  const thinning = BASELINE.crown.thinning;
  const soft = edgePx(measure);
  const { x: cx, y: cy } = crownCenter;
  const scalp = {
    r: Math.min(255, skin.r + 22),
    g: Math.min(255, skin.g + 18),
    b: Math.min(255, skin.b + 14),
  };
  let cleared = 0;
  const minX = Math.max(0, Math.floor(cx - R - soft));
  const maxX = Math.min(width - 1, Math.ceil(cx + R + soft));
  const minY = Math.max(0, Math.floor(cy - R - soft));
  const maxY = Math.min(height - 1, Math.ceil(cy + R + soft));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > R + soft) continue;
      const i = y * width + x;
      if (!hairMask[i]) continue;
      const centerWeight = 1 - Math.min(1, dist / Math.max(1, R));
      const edge = dist > R ? 1 - (dist - R) / soft : 1;
      const clearProb = thinning * (0.35 + 0.65 * centerWeight) * Math.max(0, edge);
      if (unitHash(x, y, 0x51a7e) > clearProb) continue;
      paintCleared(rgba, mask, i, scalp, Math.min(1, 0.55 + 0.45 * centerWeight));
      hairMask[i] = 0;
      cleared += 1;
    }
  }
  return {
    cleared,
    geometry: {
      kind: "crown",
      radiusCm: BASELINE.crown.radiusCm,
      thinning: BASELINE.crown.thinning,
      crownCenter: { ...crownCenter },
    },
  };
}

/**
 * Build a deterministic virtual-loss frame for one area.
 * @returns {{ imageData, baselineMask, hairMask, geometry, stats }}
 */
export function buildBaselineLoss({
  area,
  measure,
  imageData,
  hairMask,
  faceMask,
}) {
  if (!BASELINE[area]) throw new Error(`unknown-baseline-area:${area}`);
  const { width, height } = measure;
  if (imageData.width !== width || imageData.height !== height) {
    throw new Error("frame-size-mismatch");
  }
  const rgba = new Uint8ClampedArray(imageData.data);
  const nextHair = Uint8Array.from(hairMask);
  const baselineMask = new Float32Array(width * height);
  const skin = sampleSkinColor(rgba, faceMask, width, height, measure);
  const protectY = protectYFor(measure);

  let result;
  if (area === "hairline") result = clearHairline(rgba, baselineMask, nextHair, measure, faceMask, skin);
  else if (area === "mline") result = clearMline(rgba, baselineMask, nextHair, measure, faceMask, skin);
  else result = clearCrown(rgba, baselineMask, nextHair, measure, faceMask, skin);

  // Never modify below browTopY
  if (measure.kind === "front" && Number.isFinite(protectY)) {
    const from = Math.floor(protectY);
    for (let y = Math.max(0, from); y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (baselineMask[i] === 0) continue;
        const o = i * 4;
        rgba[o] = imageData.data[o];
        rgba[o + 1] = imageData.data[o + 1];
        rgba[o + 2] = imageData.data[o + 2];
        rgba[o + 3] = imageData.data[o + 3];
        baselineMask[i] = 0;
        nextHair[i] = hairMask[i];
      }
    }
  }

  let cleared = 0;
  for (let i = 0; i < baselineMask.length; i++) if (baselineMask[i] >= 0.35) cleared += 1;
  const cm2 = cleared / (measure.pxPerCm * measure.pxPerCm);

  return {
    imageData: { width, height, data: rgba },
    baselineMask,
    hairMask: nextHair,
    geometry: result.geometry,
    stats: {
      area,
      clearedPixels: cleared,
      clearedCm2: cm2,
      hash: hashBuffer(rgba),
      skin,
      // 정수리 pxPerCm는 CROWN_HEAD_WIDTH_CM 기반 임시값 (faceGeometry 주석 참고).
      pxPerCm: measure.pxPerCm,
      pxPerCmNote: measure.kind === "crown" ? "temporary-crown-head-width" : "iris",
    },
  };
}

export function voidSizeCmFor(area) {
  if (area === "hairline") return BASELINE.hairline.recedeCm;
  if (area === "mline") return BASELINE.mline.cornerCm;
  if (area === "crown") return BASELINE.crown.radiusCm;
  throw new Error(`unknown-baseline-area:${area}`);
}

export function clampFillSizeCm(area, sizeCm) {
  return Math.min(sizeCm, voidSizeCmFor(area));
}
