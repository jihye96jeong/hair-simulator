/** Limits shown in UI and enforced in prepareReferenceFromFile. */
export const REFERENCE_MAX_BYTES = 8 * 1024 * 1024;
export const REFERENCE_ALLOWED_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);
export const REFERENCE_MAX_EDGE = 2048;
export const REFERENCE_COMBO_KEY = "reference";

/** Hair-only prompt for the reference tab. Do not reuse for density presets. */
export const REFERENCE_HAIR_PROMPT =
  "Change only the hair of the person in the live camera feed, using the reference image solely as a hairstyle guide. Match the reference hairstyle’s cut, length, silhouette, parting, bangs, color, and texture. Preserve the camera subject’s identity, facial geometry, eyes, eyebrows, nose, mouth, skin tone, skin texture, expression, age, and head pose. Preserve the body, clothing, lighting, and background. Do not copy the reference person’s face, facial proportions, skin, makeup, clothing, or background. Do not beautify or reshape the face. The hairstyle must fit the camera subject’s own scalp and follow their head movement naturally.";

export function validateReferenceFile(file) {
  if (!file || typeof file !== "object") {
    return { ok: false, error: "이미지 파일을 선택해 주세요." };
  }
  const type = String(file.type || "").toLowerCase();
  if (!REFERENCE_ALLOWED_TYPES.includes(type)) {
    return { ok: false, error: "JPG, PNG, WebP 이미지만 사용할 수 있습니다." };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, error: "빈 파일입니다. 다른 이미지를 선택해 주세요." };
  }
  if (file.size > REFERENCE_MAX_BYTES) {
    return { ok: false, error: `이미지는 ${Math.floor(REFERENCE_MAX_BYTES / (1024 * 1024))}MB 이하여야 합니다.` };
  }
  return { ok: true };
}

export function hairBand(imageWidth, imageHeight, face, length = "long") {
  const full = { sx: 0, sy: 0, sw: imageWidth, sh: imageHeight };
  if (!face || face.width < 8 || face.height < 8) return full;
  // Longer multipliers keep bangs, side hair, and shoulder-length hair in frame.
  const below = length === "short" ? 1.05 : 1.65;
  const above = length === "short" ? 0.45 : 0.55;
  const side = length === "short" ? 0.55 : 0.75;
  const sy = clamp(Math.round(face.y - face.height * above), 0, imageHeight - 1);
  const bottom = clamp(Math.round(face.y + face.height * below), sy + 1, imageHeight);
  const sx = clamp(Math.round(face.x - face.width * side), 0, imageWidth - 1);
  const right = clamp(Math.round(face.x + face.width * (1 + side)), sx + 1, imageWidth);
  const band = { sx, sy, sw: right - sx, sh: bottom - sy };
  if (band.sh < imageHeight * 0.12) return full;
  return band;
}

export function faceMask(crop, face) {
  const left = face.x + face.width * 0.18;
  const right = face.x + face.width * 0.82;
  // Keep forehead/hairline outside the blur ellipse.
  const top = face.y + face.height * 0.22;
  const bottom = face.y + face.height * 0.96;
  const mask = {
    cx: (left + right) / 2 - crop.sx,
    cy: (top + bottom) / 2 - crop.sy,
    rx: (right - left) / 2,
    ry: (bottom - top) / 2,
  };
  if (mask.rx < 4 || mask.ry < 4) return null;
  const outside =
    mask.cx + mask.rx < 0 ||
    mask.cy + mask.ry < 0 ||
    mask.cx - mask.rx > crop.sw ||
    mask.cy - mask.ry > crop.sh;
  return outside ? null : mask;
}

export function normalizeCrop(imageWidth, imageHeight, crop) {
  const sx = clamp(Math.round(crop.sx), 0, imageWidth - 1);
  const sy = clamp(Math.round(crop.sy), 0, imageHeight - 1);
  const sw = clamp(Math.round(crop.sw), 1, imageWidth - sx);
  const sh = clamp(Math.round(crop.sh), 1, imageHeight - sy);
  return { sx, sy, sw, sh };
}

export function faceFromManual(imageWidth, imageHeight, manual) {
  const cx = clamp(Number(manual.cx), 0, 1) * imageWidth;
  const cy = clamp(Number(manual.cy), 0, 1) * imageHeight;
  const rw = clamp(Number(manual.rw), 0.05, 0.6) * imageWidth;
  const rh = clamp(Number(manual.rh), 0.05, 0.7) * imageHeight;
  return {
    x: cx - rw / 2,
    y: cy - rh / 2,
    width: rw,
    height: rh,
  };
}

export function cropFromManual(imageWidth, imageHeight, manual) {
  const left = clamp(Number(manual.left), 0, 0.45);
  const right = clamp(Number(manual.right), 0, 0.45);
  const top = clamp(Number(manual.top), 0, 0.45);
  const bottom = clamp(Number(manual.bottom), 0, 0.45);
  const sx = Math.round(imageWidth * left);
  const sy = Math.round(imageHeight * top);
  const sw = Math.max(1, Math.round(imageWidth * (1 - left - right)));
  const sh = Math.max(1, Math.round(imageHeight * (1 - top - bottom)));
  return normalizeCrop(imageWidth, imageHeight, { sx, sy, sw, sh });
}

export async function detectFaces(bitmap) {
  const Detector = globalThis.FaceDetector;
  if (!Detector) return { available: false, faces: [] };
  try {
    const detector = new Detector({ fastMode: true, maxDetectedFaces: 5 });
    const detected = await detector.detect(bitmap);
    const faces = detected
      .map((item) => item.boundingBox)
      .filter(Boolean)
      .map((box) => ({ x: box.x, y: box.y, width: box.width, height: box.height }))
      .filter((face) => face.width >= 8 && face.height >= 8)
      .sort((a, b) => b.width * b.height - a.width * a.height);
    return { available: true, faces };
  } catch {
    return { available: false, faces: [] };
  }
}

export async function decodeReferenceBitmap(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    try {
      return await createImageBitmap(blob);
    } catch {
      const error = new Error("이미지로 열 수 없습니다. 다른 파일을 선택해 주세요.");
      error.code = "decode-failed";
      throw error;
    }
  }
}

export async function downscaleBitmap(bitmap, maxEdge = REFERENCE_MAX_EDGE) {
  const edge = Math.max(bitmap.width, bitmap.height);
  if (edge <= maxEdge) return { bitmap, scaled: false };
  const scale = maxEdge / edge;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return { bitmap, scaled: false };
  context.drawImage(bitmap, 0, 0, width, height);
  const scaled = await createImageBitmap(canvas);
  bitmap.close();
  return { bitmap: scaled, scaled: true };
}

export async function renderProtectedReference(bitmap, crop, mask) {
  const canvas = document.createElement("canvas");
  canvas.width = crop.sw;
  canvas.height = crop.sh;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
  if (mask) blurFace(canvas, context, mask);
  return canvasToJpeg(canvas);
}

/**
 * Analyze an uploaded reference without claiming face protection until a mask is applied.
 */
export async function analyzeReference(blob) {
  const bitmap0 = await decodeReferenceBitmap(blob);
  const { bitmap } = await downscaleBitmap(bitmap0);
  const detection = await detectFaces(bitmap);
  const primary = detection.faces[0] || null;
  return {
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
    detectionAvailable: detection.available,
    faces: detection.faces,
    primary,
    needsManual: !detection.available || detection.faces.length !== 1,
    multiFace: detection.faces.length > 1,
  };
}

export async function processReference({ bitmap, face, cropOverride = null, length = "long" }) {
  const crop = cropOverride || hairBand(bitmap.width, bitmap.height, face, length);
  const mask = face ? faceMask(crop, face) : null;
  if (!mask) {
    return {
      blob: null,
      crop,
      mask: null,
      protected: false,
      status: "얼굴 보호 영역이 확정되지 않았습니다. 수동으로 얼굴 위치를 지정해 주세요.",
    };
  }
  const blob = await renderProtectedReference(bitmap, crop, mask);
  return {
    blob,
    crop,
    mask,
    protected: Boolean(blob),
    status: blob ? "얼굴 영역을 가린 헤어 참고 이미지를 준비했습니다." : "전처리에 실패했습니다.",
  };
}

function blurFace(canvas, context, mask) {
  const blurred = document.createElement("canvas");
  blurred.width = canvas.width;
  blurred.height = canvas.height;
  const blurredContext = blurred.getContext("2d");
  if (!blurredContext) return;
  blurredContext.filter = `blur(${Math.max(18, Math.round(mask.rx * 0.55))}px)`;
  blurredContext.drawImage(canvas, 0, 0);
  context.save();
  context.beginPath();
  context.ellipse(mask.cx, mask.cy, mask.rx, mask.ry, 0, 0, Math.PI * 2);
  context.clip();
  context.drawImage(blurred, 0, 0);
  context.restore();
}

function canvasToJpeg(canvas) {
  return new Promise((resolve) => {
    canvas.toBlob((result) => resolve(result), "image/jpeg", 0.92);
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
