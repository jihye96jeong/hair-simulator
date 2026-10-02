import {
  EYEBROW_INDICES,
  FACE_LANDMARKER_MODEL_PATH,
  MEDIAPIPE_WASM_PATH,
  landmarksToPixels,
} from "./faceMask.js";

/** Iris ring indices (Face Landmarker with iris, 478 landmarks). */
export const LEFT_IRIS = Object.freeze([468, 469, 470, 471, 472]);
export const RIGHT_IRIS = Object.freeze([473, 474, 475, 476, 477]);
/** Approximate temple / forehead corner landmarks. */
export const LEFT_TEMPLE_INDEX = 54;
export const RIGHT_TEMPLE_INDEX = 284;
/** Average adult head width in cm used for crown-only frames (병원 확인 전 임시값). */
export const CROWN_HEAD_WIDTH_CM = 15;
export const IRIS_DIAMETER_CM = 1.17;
export const SELFIE_SEGMENTER_MODEL_PATH = "/models/selfie_multiclass_256x256.tflite";
/** Selfie multiclass categories (MediaPipe selfie_multiclass_256x256). */
export const SEG_HAIR = 1;
export const SEG_FACE_SKIN = 3;

let landmarkerPromise = null;
let segmenterPromise = null;

export function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function irisDiameterPx(points, indices) {
  const pts = indices.map((i) => points[i]).filter(Boolean);
  if (pts.length < 2) return NaN;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return (Math.max(0, maxX - minX) + Math.max(0, maxY - minY)) / 2;
}

export function pxPerCmFromIrises(points) {
  const left = irisDiameterPx(points, LEFT_IRIS);
  const right = irisDiameterPx(points, RIGHT_IRIS);
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) {
    return NaN;
  }
  return ((left + right) / 2) / IRIS_DIAMETER_CM;
}

export function browTopYFromPoints(points) {
  let minY = Infinity;
  for (const i of EYEBROW_INDICES) {
    if (points[i]) minY = Math.min(minY, points[i].y);
  }
  return Number.isFinite(minY) ? minY : NaN;
}

/**
 * Build a hairline curve from the hair/face-skin boundary above the brows.
 * Returns sorted samples { x, y } across the forehead width.
 */
export function hairlineCurveFromMasks({ hairMask, faceMask, width, height, browTopY, sampleCount = 48 }) {
  const samples = [];
  const yLimit = Math.min(height - 1, Math.floor(browTopY + height * 0.08));
  for (let i = 0; i < sampleCount; i++) {
    const x = Math.floor(((i + 0.5) / sampleCount) * (width - 1));
    let boundary = null;
    for (let y = 0; y <= yLimit; y++) {
      const idx = y * width + x;
      if (hairMask[idx] && faceMask[idx]) {
        boundary = y;
        break;
      }
      if (faceMask[idx] && !hairMask[idx] && boundary == null) {
        // first face-skin after hair above: walk up for last hair
        for (let up = y - 1; up >= 0; up--) {
          if (hairMask[up * width + x]) {
            boundary = up;
            break;
          }
        }
        if (boundary == null) boundary = y;
        break;
      }
    }
    if (boundary == null) {
      for (let y = 0; y <= yLimit; y++) {
        if (hairMask[y * width + x]) boundary = y;
        else if (boundary != null) break;
      }
    }
    if (boundary != null) samples.push({ x, y: boundary });
  }
  return samples;
}

export function templesFromCurveAndLandmarks(curve, points) {
  if (!curve.length) {
    return {
      templeLeft: points[LEFT_TEMPLE_INDEX] || null,
      templeRight: points[RIGHT_TEMPLE_INDEX] || null,
    };
  }
  const leftLm = points[LEFT_TEMPLE_INDEX];
  const rightLm = points[RIGHT_TEMPLE_INDEX];
  const leftCurve = curve.reduce((best, p) => (!best || p.x < best.x ? p : best));
  const rightCurve = curve.reduce((best, p) => (!best || p.x > best.x ? p : best));
  return {
    templeLeft: leftLm ? { x: leftLm.x, y: Math.min(leftLm.y, leftCurve.y) } : leftCurve,
    templeRight: rightLm ? { x: rightLm.x, y: Math.min(rightLm.y, rightCurve.y) } : rightCurve,
  };
}

export function headWidthFromHairMask(hairMask, width, height) {
  let minX = width;
  let maxX = 0;
  let found = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!hairMask[y * width + x]) continue;
      found = true;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
  }
  if (!found) return 0;
  return Math.max(0, maxX - minX);
}

export function crownCenterFromMasks({ hairMask, faceMask, width, height, rgba }) {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  const topBand = Math.floor(height * 0.55);
  for (let y = 0; y < topBand; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!hairMask[i]) continue;
      const scalp = faceMask[i] || isBrightScalpPixel(rgba, i);
      if (!scalp) continue;
      sumX += x;
      sumY += y;
      count += 1;
    }
  }
  if (count > 0) return { x: sumX / count, y: sumY / count };

  let hairSumX = 0;
  let hairSumY = 0;
  let hairCount = 0;
  let minY = height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!hairMask[y * width + x]) continue;
      minY = Math.min(minY, y);
    }
  }
  const bandEnd = Math.min(height, minY + Math.floor(height * 0.25));
  for (let y = minY; y < bandEnd; y++) {
    for (let x = 0; x < width; x++) {
      if (!hairMask[y * width + x]) continue;
      hairSumX += x;
      hairSumY += y;
      hairCount += 1;
    }
  }
  if (!hairCount) return null;
  return { x: hairSumX / hairCount, y: hairSumY / hairCount };
}

function isBrightScalpPixel(rgba, pixelIndex) {
  if (!rgba) return false;
  const o = pixelIndex * 4;
  const r = rgba[o];
  const g = rgba[o + 1];
  const b = rgba[o + 2];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max > 140 && (max - min) < 45 && r > 100 && g > 90 && b > 80;
}

export function categoryMaskFromLabels(labels, width, height, category) {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = labels[i] === category ? 1 : 0;
  return out;
}

export function measureFrontFromInputs({
  landmarks,
  width,
  height,
  hairMask,
  faceMask,
}) {
  if (!landmarks || landmarks.length < 478) {
    const error = new Error("얼굴이 정면으로 보이게 해주세요");
    error.code = "front-face";
    throw error;
  }
  const points = landmarksToPixels(landmarks, width, height);
  const pxPerCm = pxPerCmFromIrises(points);
  if (!Number.isFinite(pxPerCm) || pxPerCm <= 0) {
    const error = new Error("얼굴이 정면으로 보이게 해주세요");
    error.code = "front-iris";
    throw error;
  }
  const browTopY = browTopYFromPoints(points);
  if (!Number.isFinite(browTopY)) {
    const error = new Error("얼굴이 정면으로 보이게 해주세요");
    error.code = "front-brow";
    throw error;
  }
  const hairlineCurve = hairlineCurveFromMasks({ hairMask, faceMask, width, height, browTopY });
  if (hairlineCurve.length < 8) {
    const error = new Error("얼굴이 정면으로 보이게 해주세요");
    error.code = "front-hairline";
    throw error;
  }
  const temples = templesFromCurveAndLandmarks(hairlineCurve, points);
  return {
    kind: "front",
    width,
    height,
    pxPerCm,
    browTopY,
    hairlineCurve,
    templeLeft: temples.templeLeft,
    templeRight: temples.templeRight,
  };
}

export function measureCrownFromInputs({ hairMask, faceMask, width, height, rgba }) {
  const headWidthPx = headWidthFromHairMask(hairMask, width, height);
  if (headWidthPx < width * 0.15) {
    const error = new Error("고개를 더 숙여 정수리가 화면 가운데 오게 해주세요");
    error.code = "crown-hair";
    throw error;
  }
  const pxPerCm = headWidthPx / CROWN_HEAD_WIDTH_CM;
  const crownCenter = crownCenterFromMasks({ hairMask, faceMask, width, height, rgba });
  if (!crownCenter) {
    const error = new Error("고개를 더 숙여 정수리가 화면 가운데 오게 해주세요");
    error.code = "crown-center";
    throw error;
  }
  return {
    kind: "crown",
    width,
    height,
    headWidthPx,
    pxPerCm,
    crownCenter,
  };
}

export function medianMeasure(samples) {
  if (!samples.length) throw new Error("no-samples");
  const first = samples[0];
  if (first.kind === "crown") {
    return {
      ...first,
      headWidthPx: median(samples.map((s) => s.headWidthPx)),
      pxPerCm: median(samples.map((s) => s.pxPerCm)),
      crownCenter: {
        x: median(samples.map((s) => s.crownCenter.x)),
        y: median(samples.map((s) => s.crownCenter.y)),
      },
    };
  }
  const curveLen = Math.min(...samples.map((s) => s.hairlineCurve.length));
  const hairlineCurve = [];
  for (let i = 0; i < curveLen; i++) {
    hairlineCurve.push({
      x: median(samples.map((s) => s.hairlineCurve[i].x)),
      y: median(samples.map((s) => s.hairlineCurve[i].y)),
    });
  }
  return {
    ...first,
    pxPerCm: median(samples.map((s) => s.pxPerCm)),
    browTopY: median(samples.map((s) => s.browTopY)),
    hairlineCurve,
    templeLeft: {
      x: median(samples.map((s) => s.templeLeft.x)),
      y: median(samples.map((s) => s.templeLeft.y)),
    },
    templeRight: {
      x: median(samples.map((s) => s.templeRight.x)),
      y: median(samples.map((s) => s.templeRight.y)),
    },
  };
}

async function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import("@mediapipe/tasks-vision");
      const files = await vision.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_PATH);
      return vision.FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: FACE_LANDMARKER_MODEL_PATH, delegate: "CPU" },
        runningMode: "IMAGE",
        numFaces: 1,
      });
    })();
  }
  return landmarkerPromise;
}

async function getSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const vision = await import("@mediapipe/tasks-vision");
      const files = await vision.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_PATH);
      return vision.ImageSegmenter.createFromOptions(files, {
        baseOptions: { modelAssetPath: SELFIE_SEGMENTER_MODEL_PATH, delegate: "CPU" },
        runningMode: "IMAGE",
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
    })();
  }
  return segmenterPromise;
}

function canvasFromVideoOrImage(source) {
  const width = source.videoWidth || source.naturalWidth || source.width;
  const height = source.videoHeight || source.naturalHeight || source.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, width, height);
  return { canvas, ctx, width, height, imageData: ctx.getImageData(0, 0, width, height) };
}

async function segmentLabels(canvas) {
  const segmenter = await getSegmenter();
  return new Promise((resolve, reject) => {
    try {
      segmenter.segment(canvas, (result) => {
        try {
          const mask = result.categoryMask;
          if (!mask) throw new Error("no-mask");
          const data = mask.getAsUint8Array ? mask.getAsUint8Array() : new Uint8Array(mask.getAsFloat32Array().map((v) => Math.round(v)));
          resolve({ labels: data, width: mask.width, height: mask.height });
        } catch (error) {
          reject(error);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

export async function measureFrame(source, { pose = "front" } = {}) {
  // Browser/unit test hook: skip MediaPipe wasm when a deterministic stub is installed.
  if (typeof globalThis.__testGraftMeasure === "function") {
    return globalThis.__testGraftMeasure(source, { pose });
  }
  const { canvas, width, height, imageData } = canvasFromVideoOrImage(source);
  const seg = await segmentLabels(canvas);
  // Resize category mask to canvas size if needed
  let labels = seg.labels;
  if (seg.width !== width || seg.height !== height) {
    labels = resizeMaskNearest(seg.labels, seg.width, seg.height, width, height);
  }
  const hairMask = categoryMaskFromLabels(labels, width, height, SEG_HAIR);
  const faceMask = categoryMaskFromLabels(labels, width, height, SEG_FACE_SKIN);

  if (pose === "crown") {
    return {
      measure: measureCrownFromInputs({
        hairMask,
        faceMask,
        width,
        height,
        rgba: imageData.data,
      }),
      hairMask,
      faceMask,
      frameCanvas: canvas,
      imageData,
    };
  }

  const landmarker = await getLandmarker();
  const detected = landmarker.detect(canvas);
  const face = detected.faceLandmarks?.[0];
  return {
    measure: measureFrontFromInputs({
      landmarks: face,
      width,
      height,
      hairMask,
      faceMask,
    }),
    hairMask,
    faceMask,
    frameCanvas: canvas,
    imageData,
  };
}

function resizeMaskNearest(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y / dh) * sh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x / dw) * sw));
      out[y * dw + x] = src[sy * sw + sx];
    }
  }
  return out;
}

export async function measureWithStabilization(source, {
  pose = "front",
  samples = 5,
  intervalMs = 100,
} = {}) {
  const useTest = typeof globalThis.__testGraftMeasure === "function";
  const count = useTest ? 1 : samples;
  const wait = useTest ? 0 : intervalMs;
  const collected = [];
  let lastHair = null;
  let lastFace = null;
  let lastCanvas = null;
  let lastImage = null;
  for (let i = 0; i < count; i++) {
    const result = await measureFrame(source, { pose });
    collected.push(result.measure);
    lastHair = result.hairMask;
    lastFace = result.faceMask;
    lastCanvas = result.frameCanvas;
    lastImage = result.imageData;
    if (i < count - 1) await new Promise((r) => setTimeout(r, wait));
  }
  return {
    measure: medianMeasure(collected),
    samples: collected,
    hairMask: lastHair,
    faceMask: lastFace,
    frameCanvas: lastCanvas,
    imageData: lastImage,
  };
}
