/** Limits shown in UI and enforced in prepareReferenceFromFile. */
export const REFERENCE_MAX_BYTES = 8 * 1024 * 1024;
export const REFERENCE_ALLOWED_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);
export const REFERENCE_MAX_EDGE = 1024;
export const REFERENCE_COMBO_KEY = "reference";

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

export function toUploadDataUrl(bitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) {
    const error = new Error("이미지를 준비하지 못했습니다.");
    error.code = "encode-failed";
    throw error;
  }
  context.drawImage(bitmap, 0, 0);
  return canvas.toDataURL("image/jpeg", 0.9);
}
