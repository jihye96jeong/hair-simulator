/**
 * Deterministic short-hair strand texture (no external PNG, no dot noise).
 * Same seed + geometry → same strokes.
 */

/** Strand length range in mm. 병원 확인 전 임시값. */
const STRAND_LEN_MM = Object.freeze({ min: 3, max: 8 });
/** Stroke thickness in px. 병원 확인 전 임시값. */
const STRAND_THICKNESS_PX = Object.freeze({ min: 1, max: 2 });
/** Bottom feather blur for natural hairline (px). 병원 확인 전 임시값. */
export const GUIDE_BOTTOM_BLUR_PX = 12;

export function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromKey(key) {
  let h = 2166136261;
  const s = String(key);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Sample mean/variance of remaining side hair (dark pixels near temples).
 */
export function sampleSideHairColor(rgba, width, height, measure) {
  const samples = [];
  const bands = [
    { x0: 0, x1: Math.floor(width * 0.18) },
    { x0: Math.floor(width * 0.82), x1: width },
  ];
  const y0 = Math.floor((measure.browTopY || height * 0.35));
  const y1 = Math.min(height - 1, Math.floor(y0 + height * 0.35));
  for (const band of bands) {
    for (let y = y0; y <= y1; y++) {
      for (let x = band.x0; x < band.x1; x++) {
        const o = (y * width + x) * 4;
        const lum = (rgba[o] + rgba[o + 1] + rgba[o + 2]) / 3;
        if (lum > 30 && lum < 140) samples.push([rgba[o], rgba[o + 1], rgba[o + 2]]);
      }
    }
  }
  if (!samples.length) return { mean: [40, 28, 20], std: [12, 10, 8] };
  const mean = [0, 0, 0];
  for (const c of samples) {
    mean[0] += c[0];
    mean[1] += c[1];
    mean[2] += c[2];
  }
  mean[0] /= samples.length;
  mean[1] /= samples.length;
  mean[2] /= samples.length;
  const std = [0, 0, 0];
  for (const c of samples) {
    std[0] += (c[0] - mean[0]) ** 2;
    std[1] += (c[1] - mean[1]) ** 2;
    std[2] += (c[2] - mean[2]) ** 2;
  }
  std[0] = Math.sqrt(std[0] / samples.length) || 8;
  std[1] = Math.sqrt(std[1] / samples.length) || 8;
  std[2] = Math.sqrt(std[2] / samples.length) || 8;
  return { mean, std };
}

function colorFromStats(rng, stats) {
  return [
    Math.min(255, Math.max(0, stats.mean[0] + (rng() * 2 - 1) * stats.std[0])),
    Math.min(255, Math.max(0, stats.mean[1] + (rng() * 2 - 1) * stats.std[1])),
    Math.min(255, Math.max(0, stats.mean[2] + (rng() * 2 - 1) * stats.std[2])),
  ];
}

function directionForArea(area, measure, x, y) {
  if (area === "crown") {
    const cx = measure.crownCenter?.x ?? measure.width / 2;
    const cy = measure.crownCenter?.y ?? measure.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    const ang = Math.atan2(dy, dx) + 0.55; // swirl
    return { dx: Math.cos(ang), dy: Math.sin(ang) };
  }
  // hairline / mline: flow down and outward from center
  const cx = measure.faceCenterX
    ?? ((measure.templeLeft?.x ?? 0) + (measure.templeRight?.x ?? measure.width)) / 2;
  const outward = x < cx ? -1 : 1;
  const ang = Math.PI / 2 + outward * 0.35;
  return { dx: Math.cos(ang), dy: Math.sin(ang) };
}

/**
 * Draw curved strands into an offscreen canvas exaggerated over the fill mask.
 * Returns rgba (with alpha) of the texture layer only.
 */
export function renderHairTextureLayer({
  width,
  height,
  fillMask,
  measure,
  area,
  rgbaSource,
  seed,
  density = 0.8,
}) {
  const rng = mulberry32(seed >>> 0);
  const stats = sampleSideHairColor(rgbaSource, width, height, measure);
  const pxPerMm = measure.pxPerCm / 10;
  let canvas;
  let ctx;
  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext("2d");
  } else if (typeof document !== "undefined") {
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext("2d");
  } else {
    // Node: software stroke into rgba
    return renderHairTextureSoftware({
      width, height, fillMask, measure, area, stats, rng, pxPerMm, density,
    });
  }
  ctx.clearRect(0, 0, width, height);
  ctx.globalAlpha = density;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const bounds = maskBoundsSimple(fillMask, width, height);
  const areaPx = Math.max(1, bounds.widthPx * bounds.heightPx);
  const strandCount = Math.max(40, Math.floor(areaPx / 28));
  for (let s = 0; s < strandCount; s++) {
    // Pick start inside mask
    let x = 0;
    let y = 0;
    let found = false;
    for (let tries = 0; tries < 12; tries++) {
      x = bounds.minX + rng() * Math.max(1, bounds.widthPx);
      y = bounds.minY + rng() * Math.max(1, bounds.heightPx);
      const ix = Math.min(width - 1, Math.max(0, Math.floor(x)));
      const iy = Math.min(height - 1, Math.max(0, Math.floor(y)));
      if (fillMask[iy * width + ix] > 0.2) {
        found = true;
        break;
      }
    }
    if (!found) continue;
    const lenMm = STRAND_LEN_MM.min + rng() * (STRAND_LEN_MM.max - STRAND_LEN_MM.min);
    const len = lenMm * pxPerMm;
    const thick = STRAND_THICKNESS_PX.min
      + rng() * (STRAND_THICKNESS_PX.max - STRAND_THICKNESS_PX.min);
    const dir = directionForArea(area, measure, x, y);
    const bend = (rng() * 2 - 1) * 0.45;
    const col = colorFromStats(rng, stats);
    ctx.strokeStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`;
    ctx.lineWidth = thick;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const mx = x + dir.dx * len * 0.5 + (-dir.dy) * bend * len;
    const my = y + dir.dy * len * 0.5 + dir.dx * bend * len;
    const ex = x + dir.dx * len;
    const ey = y + dir.dy * len;
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.stroke();
  }

  const imageData = ctx.getImageData(0, 0, width, height);
  // Multiply alpha by fillMask (feathered) so bottom softens with mask
  const data = imageData.data;
  for (let i = 0; i < fillMask.length; i++) {
    const o = i * 4;
    data[o + 3] = Math.round(data[o + 3] * Math.min(1, fillMask[i]));
  }
  return data;
}

function maskBoundsSimple(fillMask, width, height, threshold = 0.15) {
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
  if (maxX < minX) return { minX: 0, maxX: 0, minY: 0, maxY: 0, widthPx: 1, heightPx: 1 };
  return {
    minX, maxX, minY, maxY,
    widthPx: maxX - minX + 1,
    heightPx: maxY - minY + 1,
  };
}

function renderHairTextureSoftware({
  width, height, fillMask, measure, area, stats, rng, pxPerMm, density,
}) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const bounds = maskBoundsSimple(fillMask, width, height);
  const areaPx = Math.max(1, bounds.widthPx * bounds.heightPx);
  const strandCount = Math.max(40, Math.floor(areaPx / 28));
  for (let s = 0; s < strandCount; s++) {
    let x = bounds.minX + rng() * Math.max(1, bounds.widthPx);
    let y = bounds.minY + rng() * Math.max(1, bounds.heightPx);
    const ix = Math.min(width - 1, Math.max(0, Math.floor(x)));
    const iy = Math.min(height - 1, Math.max(0, Math.floor(y)));
    if (fillMask[iy * width + ix] < 0.2) continue;
    const len = (STRAND_LEN_MM.min + rng() * (STRAND_LEN_MM.max - STRAND_LEN_MM.min)) * pxPerMm;
    const thick = STRAND_THICKNESS_PX.min
      + rng() * (STRAND_THICKNESS_PX.max - STRAND_THICKNESS_PX.min);
    const dir = directionForArea(area, measure, x, y);
    const col = colorFromStats(rng, stats);
    const steps = Math.max(4, Math.floor(len));
    for (let t = 0; t <= steps; t++) {
      const u = t / steps;
      const px = Math.round(x + dir.dx * len * u);
      const py = Math.round(y + dir.dy * len * u);
      const rad = Math.max(0, Math.round(thick / 2));
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const xx = px + dx;
          const yy = py + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const i = yy * width + xx;
          const m = fillMask[i];
          if (m < 0.05) continue;
          const o = i * 4;
          const a = Math.min(255, Math.round(220 * density * m));
          rgba[o] = col[0] | 0;
          rgba[o + 1] = col[1] | 0;
          rgba[o + 2] = col[2] | 0;
          rgba[o + 3] = Math.max(rgba[o + 3], a);
        }
      }
    }
  }
  return rgba;
}

/**
 * Mean alpha (0..1) of texture where fillMask > 0.15 — for density tests.
 */
export function meanAlphaInMask(textureRgba, fillMask, threshold = 0.15) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < fillMask.length; i++) {
    if (fillMask[i] < threshold) continue;
    sum += textureRgba[i * 4 + 3] / 255;
    n += 1;
  }
  return n ? sum / n : 0;
}
