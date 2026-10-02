/** MediaPipe Face Landmarker face oval ring (ordered). */
export const FACE_OVAL_RING = Object.freeze([
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
]);

/** Combined left/right eyebrow landmark indices from FaceLandmarker. */
export const EYEBROW_INDICES = Object.freeze([
  46, 52, 53, 55, 63, 65, 66, 70, 105, 107,
  276, 282, 283, 285, 293, 295, 296, 300, 334, 336,
]);

/** Combined left/right eye landmark indices (min y ≈ upper lid). */
export const EYE_INDICES = Object.freeze([
  7, 33, 133, 144, 145, 153, 154, 155, 157, 158, 159, 160, 161, 163, 173, 246,
  249, 263, 362, 373, 374, 380, 381, 382, 384, 385, 386, 387, 388, 390, 398, 466,
]);

export const MASK_FILL = "#808080";
export const EYEBROW_EYE_GAP_FACTOR = 0.3;
/** Pull oval ear/temple points inward so bangs, hairline, and side hair stay visible. */
export const MASK_SIDE_INSET = 0.22;
export const FACE_COUNT_ERROR = "얼굴이 한 명만 정면으로 나온 사진을 올려주세요";

export const MEDIAPIPE_WASM_PATH = "/vendor/mediapipe/wasm";
export const FACE_LANDMARKER_MODEL_PATH = "/models/face_landmarker.task";

let landmarkerPromise = null;

export function landmarksToPixels(landmarks, width, height) {
  return landmarks.map((p) => ({
    x: Number(p.x) * width,
    y: Number(p.y) * height,
  }));
}

export function computeMaskTopY(points) {
  let minBrow = Infinity;
  for (const i of EYEBROW_INDICES) {
    if (points[i]) minBrow = Math.min(minBrow, points[i].y);
  }
  let minEye = Infinity;
  for (const i of EYE_INDICES) {
    if (points[i]) minEye = Math.min(minEye, points[i].y);
  }
  if (!Number.isFinite(minBrow) || !Number.isFinite(minEye)) {
    const error = new Error(FACE_COUNT_ERROR);
    error.code = "face-landmarks";
    throw error;
  }
  const gap = Math.max(0, minEye - minBrow);
  return minBrow + gap * EYEBROW_EYE_GAP_FACTOR;
}

/**
 * Build a fill polygon covering the face below the brows (ears/hairline/forehead kept).
 * `landmarks` are MediaPipe normalized (0–1) points.
 */
export function buildFaceMaskPolygon(landmarks, width, height) {
  if (!Array.isArray(landmarks) || landmarks.length < 468) {
    const error = new Error(FACE_COUNT_ERROR);
    error.code = "face-landmarks";
    throw error;
  }
  const points = landmarksToPixels(landmarks, width, height);
  const topY = computeMaskTopY(points);
  const rawOval = FACE_OVAL_RING.map((i) => points[i]);
  const minX = Math.min(...rawOval.map((p) => p.x));
  const maxX = Math.max(...rawOval.map((p) => p.x));
  const cx = (minX + maxX) / 2;
  const oval = rawOval.map((p) => ({
    x: cx + (p.x - cx) * (1 - MASK_SIDE_INSET),
    y: p.y,
  }));
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
      polygon.push({
        x: a.x + t * (b.x - a.x),
        y: topY,
      });
    }
  }
  if (polygon.length < 3) {
    const error = new Error(FACE_COUNT_ERROR);
    error.code = "face-polygon";
    throw error;
  }
  return polygon;
}

export function fillMaskPolygon(ctx, polygon, fill = MASK_FILL) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(polygon[0].x, polygon[0].y);
  for (let i = 1; i < polygon.length; i++) ctx.lineTo(polygon[i].x, polygon[i].y);
  ctx.closePath();
  ctx.fill();
}

export function faceCountError() {
  const error = new Error(FACE_COUNT_ERROR);
  error.code = "face-count";
  return error;
}

async function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_PATH);
      return FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: FACE_LANDMARKER_MODEL_PATH,
          delegate: "CPU",
        },
        runningMode: "IMAGE",
        numFaces: 2,
      });
    })();
  }
  return landmarkerPromise;
}

/** Returns an array of face landmark lists (normalized). Test hook: globalThis.__testDetectFaces. */
export async function detectFaceLandmarks(imageSource) {
  if (typeof globalThis.__testDetectFaces === "function") {
    return globalThis.__testDetectFaces(imageSource);
  }
  const landmarker = await getLandmarker();
  const result = landmarker.detect(imageSource);
  return result.faceLandmarks || [];
}

/**
 * Draw the source bitmap and fill the single-face mask with solid gray.
 * Throws face-count when 0 or 2+ faces.
 */
export async function maskReferenceForPreview(bitmap) {
  const faces = await detectFaceLandmarks(bitmap);
  if (faces.length !== 1) throw faceCountError();
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    const error = new Error("이미지를 준비하지 못했습니다.");
    error.code = "encode-failed";
    throw error;
  }
  ctx.drawImage(bitmap, 0, 0);
  const polygon = buildFaceMaskPolygon(faces[0], bitmap.width, bitmap.height);
  fillMaskPolygon(ctx, polygon);
  return canvas.toDataURL("image/jpeg", 0.9);
}
