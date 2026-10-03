/**
 * MediaPipe vision tasks off the main thread for the Lucy live compositor.
 * One worker instance per task so the webcam landmarker, Lucy landmarker and hair segmenter
 * run in parallel and never block rendering.
 *
 *   init  { type: "init", task: "face" | "hair" }     → { type: "ready" } | { type: "init-error", error }
 *   frame { id, bitmap, ts }                            → face: { id, landmarks: Float32Array(478*3) | null }
 *                                                         hair: { id, width, height, mask: Uint8Array | null }
 *
 * A classic worker: MediaPipe's wasm loader uses importScripts(), which module workers lack.
 */
/* global importScripts, MediaPipeVision */
const WASM_PATH = "/vendor/mediapipe/wasm";
const FACE_MODEL_PATH = "/models/face_landmarker.task";
const HAIR_MODEL_PATH = "/models/selfie_multiclass_256x256.tflite";
const HAIR = 1;

let task = null;
let runner = null;
let lastTs = -1;

async function init(kind) {
  importScripts("/vendor/mediapipe/vision_bundle.classic.js");
  const { FilesetResolver, FaceLandmarker, ImageSegmenter } = MediaPipeVision;
  const files = await FilesetResolver.forVisionTasks(WASM_PATH);
  if (kind === "face") {
    runner = await FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: FACE_MODEL_PATH, delegate: "CPU" },
      runningMode: "VIDEO",
      numFaces: 1,
    });
  } else if (kind === "hair") {
    runner = await ImageSegmenter.createFromOptions(files, {
      baseOptions: { modelAssetPath: HAIR_MODEL_PATH, delegate: "CPU" },
      runningMode: "VIDEO",
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
  } else {
    throw new Error(`unknown task ${kind}`);
  }
  task = kind;
}

function detectFace(bitmap, ts) {
  const faces = runner.detectForVideo(bitmap, ts).faceLandmarks || [];
  if (faces.length !== 1) return { landmarks: null, count: faces.length };
  const points = faces[0];
  const flat = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    flat[i * 3] = points[i].x;
    flat[i * 3 + 1] = points[i].y;
    flat[i * 3 + 2] = points[i].z;
  }
  return { landmarks: flat, count: 1 };
}

function segmentHair(bitmap, ts) {
  const result = runner.segmentForVideo(bitmap, ts);
  const mask = result?.categoryMask;
  if (!mask) return { mask: null };
  const width = mask.width;
  const height = mask.height;
  const labels = mask.getAsUint8Array
    ? mask.getAsUint8Array()
    : mask.getAsFloat32Array().map((v) => Math.round(v));
  const hair = new Uint8Array(width * height);
  for (let i = 0; i < hair.length; i++) hair[i] = labels[i] === HAIR ? 1 : 0;
  try { mask.close?.(); } catch { /* ignore */ }
  return { width, height, mask: hair };
}

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type === "init") {
    try {
      await init(data.task);
      self.postMessage({ type: "ready", task });
    } catch (error) {
      self.postMessage({ type: "init-error", error: String(error?.message || error) });
    }
    return;
  }
  const { id, bitmap, ts } = data;
  try {
    if (!runner) throw new Error("worker not ready");
    const t = Math.max(lastTs + 1, Math.round(ts));
    lastTs = t;
    if (task === "face") {
      const out = detectFace(bitmap, t);
      self.postMessage({ id, ...out }, out.landmarks ? [out.landmarks.buffer] : []);
    } else {
      const out = segmentHair(bitmap, t);
      self.postMessage({ id, ...out }, out.mask ? [out.mask.buffer] : []);
    }
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error) });
  } finally {
    try { bitmap?.close?.(); } catch { /* ignore */ }
  }
};
