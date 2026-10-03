/**
 * Re-frame a landscape webcam stream as a portrait stream for Lucy.
 * A landscape 1280×720 frame leaves the face ~150px tall; Lucy regenerates such a
 * small face loosely and identity drifts. A 9:16 center crop makes the face ~2.7×
 * larger in the frame, which is where Lucy keeps the person's features.
 */
export const PORTRAIT_WIDTH = 720;
export const PORTRAIT_HEIGHT = 1280;
export const PORTRAIT_FPS = 24;

/** Source crop rect (video pixels) for a centered 9:16 window. */
export function portraitCropRect(videoW, videoH, outW = PORTRAIT_WIDTH, outH = PORTRAIT_HEIGHT) {
  const target = outW / outH;
  const current = videoW / videoH;
  if (current > target) {
    const w = Math.round(videoH * target);
    return { x: Math.round((videoW - w) / 2), y: 0, w, h: videoH };
  }
  const h = Math.round(videoW / target);
  return { x: 0, y: Math.round((videoH - h) / 2), w: videoW, h };
}

/** Browser test hook: `globalThis.__testPortraitStream = false` keeps the raw stream. */
export function portraitEnabled() {
  return globalThis.__testPortraitStream !== false;
}

/**
 * Returns { stream, stop } where `stream` carries the cropped portrait frames.
 * `stop()` ends the canvas track and the draw loop; the source stream is left to the caller.
 */
export function createPortraitStream(source, {
  width = PORTRAIT_WIDTH,
  height = PORTRAIT_HEIGHT,
  fps = PORTRAIT_FPS,
} = {}) {
  if (!portraitEnabled() || typeof document === "undefined") {
    return { stream: source, stop() {}, portrait: false };
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = source;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  let timer = null;
  let stopped = false;
  const draw = () => {
    if (stopped || !video.videoWidth || !video.videoHeight) return;
    const crop = portraitCropRect(video.videoWidth, video.videoHeight, width, height);
    ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, width, height);
  };
  void video.play().catch(() => undefined);
  // setInterval keeps frames flowing when rAF is throttled (tab partially hidden).
  timer = setInterval(draw, Math.round(1000 / fps));
  const stream = canvas.captureStream(fps);
  return {
    stream,
    portrait: true,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    },
  };
}
