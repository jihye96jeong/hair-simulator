/**
 * Hair-state analysis from 4 directional shots + segment masks.
 * Pure helpers are unit-tested with fake masks; MediaPipe I/O stays in callers.
 */

export const HAIR_TYPES = Object.freeze([
  "near_bald",
  "receding_m",
  "thinning_front",
  "thinning_crown",
  "full_hair",
]);

export const DEFAULT_NEAR_BALD = Object.freeze({
  color: "black",
  length: "short",
});

function meanRgb(rgba, mask, width, height, limit = 800) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const step = Math.max(1, Math.floor((width * height) / (limit * 4)));
  for (let i = 0; i < width * height; i += step) {
    if (!mask[i]) continue;
    const o = i * 4;
    r += rgba[o];
    g += rgba[o + 1];
    b += rgba[o + 2];
    n += 1;
    if (n >= limit) break;
  }
  if (!n) return null;
  return { r: r / n, g: g / n, b: b / n };
}

function colorNameFromRgb({ r, g, b }) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  if (max < 55) return "black";
  if (max > 180 && chroma < 35) return "gray";
  if (r > g + 20 && r > b + 20) return "brown";
  if (max < 110) return "dark_brown";
  return "brown";
}

function lengthFromHairExtent(hairMask, width, height, browTopY) {
  let maxY = 0;
  let minY = height;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!hairMask[y * width + x]) continue;
      count += 1;
      maxY = Math.max(maxY, y);
      minY = Math.min(minY, y);
    }
  }
  if (!count) return "buzz";
  const span = (maxY - minY) / height;
  const belowBrow = Number.isFinite(browTopY) ? (maxY - browTopY) / height : span;
  if (span < 0.18 || count / (width * height) < 0.04) return "buzz";
  if (belowBrow > 0.35 || span > 0.55) return "long";
  return "short";
}

export function hairlineRetreatScores({ hairMask, faceMask, width, height, browTopY, templeLeft, templeRight, hairlineCurve }) {
  const midX = Math.floor(width / 2);
  let midHairY = browTopY;
  if (hairlineCurve?.length) {
    const mid = hairlineCurve[Math.floor(hairlineCurve.length / 2)];
    midHairY = mid.y;
  }
  const foreheadGap = Math.max(0, (midHairY - (browTopY - height * 0.08)) / height);

  const leftX = Math.floor(templeLeft?.x ?? width * 0.22);
  const rightX = Math.floor(templeRight?.x ?? width * 0.78);
  const sampleTemple = (x) => {
    let hair = 0;
    let skin = 0;
    for (let y = Math.floor(browTopY - height * 0.12); y < Math.floor(browTopY + height * 0.05); y++) {
      if (y < 0 || y >= height || x < 0 || x >= width) continue;
      const i = y * width + x;
      if (hairMask[i]) hair += 1;
      else if (faceMask[i]) skin += 1;
    }
    const t = hair + skin;
    return t ? skin / t : 1;
  };
  const mline = (sampleTemple(leftX) + sampleTemple(rightX)) / 2;
  return { foreheadGap, mlineRetreat: mline, midHairY };
}

export function frontDensityScore({ hairMask, faceMask, width, height, browTopY, hairlineCurve }) {
  let hair = 0;
  let skin = 0;
  const y0 = Math.floor(Math.min(...(hairlineCurve || [{ y: browTopY }]).map((p) => p.y)));
  const y1 = Math.floor(browTopY + height * 0.02);
  for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
    for (let x = Math.floor(width * 0.25); x < Math.floor(width * 0.75); x++) {
      const i = y * width + x;
      if (hairMask[i]) hair += 1;
      else if (faceMask[i]) skin += 1;
    }
  }
  const t = hair + skin;
  return t ? hair / t : 0;
}

export function crownScalpExposure({ hairMask, faceMask, width, height, rgba }) {
  let scalp = 0;
  let hair = 0;
  const yMax = Math.floor(height * 0.55);
  for (let y = 0; y < yMax; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!hairMask[i] && !faceMask[i]) continue;
      hair += hairMask[i] ? 1 : 0;
      const o = i * 4;
      const bright = rgba
        && rgba[o] > 130 && rgba[o + 1] > 110 && rgba[o + 2] > 95
        && Math.max(rgba[o], rgba[o + 1], rgba[o + 2]) - Math.min(rgba[o], rgba[o + 1], rgba[o + 2]) < 55;
      if (faceMask[i] || bright) scalp += 1;
    }
  }
  const t = Math.max(1, hair + scalp);
  return scalp / t;
}

/**
 * Classify hair type and fill needs from analyzed metrics.
 */
export function classifyHairState(metrics) {
  const {
    hairRatioFront = 0,
    foreheadGap = 0,
    mlineRetreat = 0,
    frontDensity = 1,
    crownExposure = 0,
    colorRgb = null,
    length = "short",
  } = metrics;

  let type = "full_hair";
  if (hairRatioFront < 0.06 && frontDensity < 0.15) type = "near_bald";
  else if (mlineRetreat > 0.55 && foreheadGap > 0.04) type = "receding_m";
  else if (frontDensity < 0.45) type = "thinning_front";
  else if (crownExposure > 0.35) type = "thinning_crown";

  const nearBald = type === "near_bald";
  const color = nearBald
    ? DEFAULT_NEAR_BALD.color
    : (colorRgb ? colorNameFromRgb(colorRgb) : "black");
  const hairLength = nearBald ? DEFAULT_NEAR_BALD.length : length;

  const needs = {
    hairline: type === "near_bald" || type === "thinning_front" || type === "receding_m" || foreheadGap > 0.05,
    mline: type === "near_bald" || type === "receding_m" || mlineRetreat > 0.4,
    crown: type === "near_bald" || type === "thinning_crown" || crownExposure > 0.28,
  };

  // full_hair with no measurable deficit → mark sufficient
  if (type === "full_hair") {
    needs.hairline = foreheadGap > 0.06;
    needs.mline = mlineRetreat > 0.5;
    needs.crown = crownExposure > 0.32;
  }

  const preferredArea = !needs.mline && !needs.hairline && needs.crown ? "crown"
    : needs.mline && mlineRetreat >= frontDensity ? "mline"
      : needs.crown && crownExposure > 0.4 ? "crown"
        : needs.hairline ? "hairline"
          : "hairline";

  return {
    type,
    color,
    length: hairLength,
    needs,
    preferredArea,
    metrics: {
      hairRatioFront,
      foreheadGap,
      mlineRetreat,
      frontDensity,
      crownExposure,
    },
  };
}

/**
 * Build analysis object from per-shot measured bundles.
 * @param {{ front?: object, left?: object, right?: object, crown?: object }} shots
 *   each: { imageData, hairMask, faceMask, measure }
 */
export function analyzeHairFromShots(shots) {
  const front = shots.front;
  if (!front) throw new Error("front-shot-required");
  const { width, height } = front.measure;
  const hairRatioFront = front.hairMask.reduce((a, v) => a + v, 0) / (width * height);
  const retreat = hairlineRetreatScores({
    hairMask: front.hairMask,
    faceMask: front.faceMask,
    width,
    height,
    browTopY: front.measure.browTopY,
    templeLeft: front.measure.templeLeft,
    templeRight: front.measure.templeRight,
    hairlineCurve: front.measure.hairlineCurve,
  });
  const frontDensity = frontDensityScore({
    hairMask: front.hairMask,
    faceMask: front.faceMask,
    width,
    height,
    browTopY: front.measure.browTopY,
    hairlineCurve: front.measure.hairlineCurve,
  });
  const colorRgb = meanRgb(front.imageData.data, front.hairMask, width, height);
  const length = lengthFromHairExtent(
    front.hairMask,
    width,
    height,
    front.measure.browTopY,
  );

  let crownExposure = 0;
  if (shots.crown) {
    crownExposure = crownScalpExposure({
      hairMask: shots.crown.hairMask,
      faceMask: shots.crown.faceMask,
      width: shots.crown.measure.width,
      height: shots.crown.measure.height,
      rgba: shots.crown.imageData.data,
    });
  }

  return classifyHairState({
    hairRatioFront,
    foreheadGap: retreat.foreheadGap,
    mlineRetreat: retreat.mlineRetreat,
    frontDensity,
    crownExposure,
    colorRgb,
    length,
  });
}

export function densityLabelForGrafts(grafts) {
  if (grafts <= 1000) return "low";
  if (grafts <= 2000) return "medium";
  return "high";
}

export function buildAnalysisInpaintPrompt({ analysis, area, grafts }) {
  const density = densityLabelForGrafts(grafts);
  return [
    "Fill only the masked area with natural hair that continues the person's existing hair.",
    `Match color ${analysis.color}, length ${analysis.length}, texture and growth direction. No visible edge.`,
    "Keep the face, skin, lighting and background unchanged.",
    `Density: ${density}.`,
    `Target area: ${area}.`,
  ].join(" ");
}

/** Prefetch order: preferred area @ 2000 first, then other levels of that area, then other areas. */
export function prefetchOrder(preferredArea, levels = [1000, 2000, 3000], areas = ["hairline", "mline", "crown"]) {
  const ordered = [];
  const restLevels = levels.filter((g) => g !== 2000);
  ordered.push({ area: preferredArea, grafts: 2000 });
  for (const g of restLevels) ordered.push({ area: preferredArea, grafts: g });
  for (const area of areas) {
    if (area === preferredArea) continue;
    ordered.push({ area, grafts: 2000 });
    for (const g of restLevels) ordered.push({ area, grafts: g });
  }
  return ordered;
}
