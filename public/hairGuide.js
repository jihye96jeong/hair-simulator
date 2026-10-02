import { detectFaceLandmarks, EYEBROW_INDICES, landmarksToPixels, MEDIAPIPE_WASM_PATH } from "./faceMask.js";
import { estimateSimilarityTransform } from "./faceRestore.js";

let segmenterPromise;
const MODEL = "/models/selfie_multiclass_256x256.tflite";
const ANCHORS = [33, 263, 1, 61, 291];

function canvasFor(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  return canvas;
}

async function load(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

async function segmentHair(image) {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const { ImageSegmenter, FilesetResolver } = await import("@mediapipe/tasks-vision");
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_PATH);
      return ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL, delegate: "CPU" },
        runningMode: "IMAGE", outputCategoryMask: true, outputConfidenceMasks: false,
      });
    })().catch((error) => { segmenterPromise = null; throw error; });
  }
  const segmenter = await segmenterPromise;
  const result = segmenter.segment(image);
  try {
    const mask = result.categoryMask;
    const data = mask.getAsUint8Array();
    const small = document.createElement("canvas");
    small.width = mask.width;
    small.height = mask.height;
    const ctx = small.getContext("2d");
    const pixels = ctx.createImageData(small.width, small.height);
    let count = 0;
    for (let i = 0; i < data.length; i++) {
      // SelfieMulticlass class 1 is hair, independently of color/length/texture.
      const alpha = data[i] === 1 ? 255 : 0;
      count += alpha > 0 ? 1 : 0;
      pixels.data.set([255, 255, 255, alpha], i * 4);
    }
    const fraction = count / data.length;
    if (fraction < 0.003 || fraction > 0.55) throw new Error("hair-segmentation-area");
    ctx.putImageData(pixels, 0, 0);
    const full = canvasFor(image);
    full.getContext("2d").drawImage(small, 0, 0, full.width, full.height);
    return full;
  } finally {
    result.close();
  }
}

/** Reject pose/landmark fits that would move the fringe onto the wrong face location. */
export function alignHairFaces(refLandmarks, personLandmarks, refSize, personSize) {
  const ref = landmarksToPixels(refLandmarks, refSize.width, refSize.height);
  const person = landmarksToPixels(personLandmarks, personSize.width, personSize.height);
  const src = ANCHORS.map((i) => ref[i]);
  const dst = ANCHORS.map((i) => person[i]);
  if ([...src, ...dst].some((p) => !p || !Number.isFinite(p.x + p.y))) throw new Error("alignment-landmarks");
  const eyeWidth = Math.hypot(dst[1].x - dst[0].x, dst[1].y - dst[0].y);
  if (eyeWidth < 20) throw new Error("alignment-small-face");
  const transform = estimateSimilarityTransform(src, dst);
  const { a, b, tx, ty } = transform;
  const scale = Math.hypot(a, b);
  const residual = Math.sqrt(src.reduce((sum, p, i) => sum
    + (a * p.x - b * p.y + tx - dst[i].x) ** 2
    + (b * p.x + a * p.y + ty - dst[i].y) ** 2, 0) / src.length) / eyeWidth;
  const yaw = (pts) => (pts[2].x - (pts[0].x + pts[1].x) / 2) / Math.abs(pts[1].x - pts[0].x);
  if (scale < 0.25 || scale > 4 || residual > 0.065
    || Math.abs(Math.atan2(b, a)) > 0.3 || Math.abs(yaw(src) - yaw(dst)) > 0.12) {
    throw new Error("alignment-pose-or-fit");
  }
  return { ...transform, residual };
}

/** Entirely local and transient. Never paste reference face pixels into the guide. */
export async function prepareHairGuide({ referenceDataUrl, selfieDataUrl }) {
  try {
    const [ref, person] = await Promise.all([load(referenceDataUrl), load(selfieDataUrl)]);
    const refFaces = await detectFaceLandmarks(ref);
    const personFaces = await detectFaceLandmarks(person);
    if (refFaces.length !== 1 || personFaces.length !== 1) throw new Error("alignment-face-count");
    const fit = alignHairFaces(refFaces[0], personFaces[0], ref, person);
    const refMask = await segmentHair(ref);
    const personMask = await segmentHair(person);
    const cutout = canvasFor(ref);
    const cutCtx = cutout.getContext("2d");
    cutCtx.drawImage(ref, 0, 0);
    cutCtx.globalCompositeOperation = "destination-in";
    cutCtx.drawImage(refMask, 0, 0);
    const warped = canvasFor(person);
    const ctx = warped.getContext("2d");
    ctx.setTransform(fit.a, fit.b, -fit.b, fit.a, fit.tx, fit.ty);
    ctx.drawImage(cutout, 0, 0);
    ctx.resetTransform();
    const mapped = ctx.getImageData(0, 0, person.width, person.height);
    const originalHair = personMask.getContext("2d").getImageData(0, 0, person.width, person.height);
    const points = landmarksToPixels(personFaces[0], person.width, person.height);
    const browY = Math.min(...EYEBROW_INDICES.map((i) => points[i].y));
    const left = Math.min(points[234].x, points[454].x);
    const right = Math.max(points[234].x, points[454].x);
    const guide = canvasFor(person);
    const guideCtx = guide.getContext("2d");
    guideCtx.drawImage(person, 0, 0);
    const guidePixels = guideCtx.getImageData(0, 0, person.width, person.height);
    const editMask = canvasFor(person);
    const maskCtx = editMask.getContext("2d");
    const maskPixels = maskCtx.createImageData(person.width, person.height);
    let referenceCount = 0;
    for (let y = 0; y < person.height; y++) {
      for (let x = 0; x < person.width; x++) {
        const i = (y * person.width + x) * 4;
        // Protect facial features below brows, even if hair segmentation leaks into them.
        const protectedFace = y >= browY && y <= points[152].y && x >= left && x <= right;
        if (protectedFace) mapped.data[i + 3] = 0;
        const refAlpha = mapped.data[i + 3] / 255;
        referenceCount += refAlpha;
        const oldHair = !protectedFace && originalHair.data[i + 3] > 0;
        const forehead = y < browY && y >= points[10].y && x >= left && x <= right;
        const alpha = protectedFace ? 0 : (oldHair || forehead ? 255 : mapped.data[i + 3]);
        maskPixels.data.set([alpha, alpha, alpha, 255], i);
        // Remove the old silhouette from the rough guide, then paint only aligned hair.
        for (let c = 0; c < 3; c++) {
          const base = oldHair ? 128 : guidePixels.data[i + c];
          guidePixels.data[i + c] = Math.round(mapped.data[i + c] * refAlpha + base * (1 - refAlpha));
        }
      }
    }
    if (referenceCount / (person.width * person.height) < 0.003) throw new Error("alignment-empty-guide");
    // A clipped style cannot be used as a silhouette guide (especially long hair).
    const border = (x, y) => mapped.data[(y * person.width + x) * 4 + 3] > 128;
    let clipped = 0;
    for (let x = 0; x < person.width; x++) clipped += border(x, 0) + border(x, person.height - 1);
    for (let y = 0; y < person.height; y++) clipped += border(0, y) + border(person.width - 1, y);
    if (clipped > (person.width + person.height) * 0.015) throw new Error("alignment-clipped-hair");
    guideCtx.putImageData(guidePixels, 0, 0);
    maskCtx.putImageData(maskPixels, 0, 0);
    return { ok: true, guide: guide.toDataURL("image/jpeg", 0.9),
      editMask: editMask.toDataURL("image/png"), hairOnly: cutout.toDataURL("image/png"),
      reason: "aligned-hair", residual: fit.residual };
  } catch (error) {
    return { ok: false, reason: error.message === "alignment-clipped-hair" ? error.message : "guide-unavailable-or-unstable" };
  }
}
