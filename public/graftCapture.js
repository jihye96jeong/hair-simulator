/**
 * 모수 탭 전용 캡처. MediaStream 트랙을 stop/교체하지 않고
 * 비디오 요소에서 프레임만 canvas로 복사한 뒤 측정한다.
 * (레퍼런스 탭 selfie.js 와 분리 — selfie는 촬영 후 스트림을 끈다.)
 */
import { measureFrame, medianMeasure } from "./faceGeometry.js";

/**
 * @param {HTMLVideoElement} video
 * @returns {HTMLCanvasElement}
 */
export function grabVideoFrameCanvas(video) {
  const width = video?.videoWidth || 0;
  const height = video?.videoHeight || 0;
  if (!width || !height) {
    const error = new Error("카메라 화면을 아직 준비하지 못했어요.");
    error.code = "graft-capture-not-ready";
    throw error;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, width, height);
  return canvas;
}

/**
 * Capture + measure without touching MediaStream tracks.
 * Stabilization grabs several canvases from the still-playing video.
 */
export async function captureGraftStill(video, {
  pose = "front",
  samples = 5,
  intervalMs = 40,
  skipForeheadCheck = false,
} = {}) {
  const useTest = typeof globalThis.__testGraftMeasure === "function";
  const count = useTest ? 1 : Math.max(1, samples);
  const wait = useTest ? 0 : intervalMs;
  const collected = [];
  let lastHair = null;
  let lastFace = null;
  let lastCanvas = null;
  let lastImage = null;

  for (let i = 0; i < count; i++) {
    const frameCanvas = grabVideoFrameCanvas(video);
    // Measure the frozen canvas — never pass the live MediaStream video into
    // long-running work that might interact with playback, and never stop tracks.
    const result = await measureFrame(frameCanvas, { pose, skipForeheadCheck });
    collected.push(result.measure);
    lastHair = result.hairMask;
    lastFace = result.faceMask;
    lastCanvas = result.frameCanvas || frameCanvas;
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

/** Track readyStates for diagnostics (does not stop tracks). */
export function streamTrackStates(stream) {
  return (stream?.getTracks?.() || []).map((t) => ({
    kind: t.kind,
    readyState: t.readyState,
    enabled: t.enabled,
    muted: t.muted,
  }));
}
