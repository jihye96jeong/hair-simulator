/**
 * Normalize stills for Lucy realtime the same way /hair-preview does server-side:
 * keep aspect ratio, fit long edge to maxEdge, JPEG quality ~0.9 (no letterbox, no center-crop).
 */

export const LUCY_IMAGE_MAX_EDGE = 1024;
export const LUCY_IMAGE_JPEG_QUALITY = 0.9;

function imageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image-load"));
    };
    img.src = url;
  });
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("frame-encode"))), "image/jpeg", quality);
  });
}

/**
 * @param {Blob} blob
 * @param {{ maxEdge?: number, quality?: number }} [opts]
 * @returns {Promise<{ blob: Blob, width: number, height: number, sourceWidth: number, sourceHeight: number }>}
 */
export async function normalizeLucyJpeg(blob, {
  maxEdge = LUCY_IMAGE_MAX_EDGE,
  quality = LUCY_IMAGE_JPEG_QUALITY,
} = {}) {
  const img = await imageFromBlob(blob);
  const sourceWidth = img.naturalWidth || img.width;
  const sourceHeight = img.naturalHeight || img.height;
  if (!sourceWidth || !sourceHeight) throw new Error("image-empty");
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(img, 0, 0, width, height);
  const out = await canvasToJpeg(canvas, quality);
  return { blob: out, width, height, sourceWidth, sourceHeight };
}
