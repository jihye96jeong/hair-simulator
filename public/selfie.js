import { openFrontCamera, stopMediaStream } from "./camera.js";

/** Matches `.selfie-guide { inset: 12% 18%; }` */
export const GUIDE_INSET_TOP = 0.12;
export const GUIDE_INSET_SIDE = 0.18;
export const SELFIE_OUT_WIDTH = 768;
export const SELFIE_OUT_HEIGHT = 1024;
export const SELFIE_JPEG_QUALITY = 0.9;
export const CROP_WIDTH_FACTOR = 2.2;
export const CROP_TOP_FACTOR = 0.9;

/**
 * object-fit: cover mapping from element box → source video pixels.
 */
export function coverMapping({ videoW, videoH, displayW, displayH }) {
  const scale = Math.max(displayW / videoW, displayH / videoH);
  const renderedW = videoW * scale;
  const renderedH = videoH * scale;
  return {
    scale,
    offsetX: (renderedW - displayW) / 2,
    offsetY: (renderedH - displayH) / 2,
  };
}

/** Face-guide ellipse in element (CSS) coordinates. */
export function faceGuideEllipse(elementW, elementH) {
  return {
    left: elementW * GUIDE_INSET_SIDE,
    top: elementH * GUIDE_INSET_TOP,
    width: elementW * (1 - 2 * GUIDE_INSET_SIDE),
    height: elementH * (1 - 2 * GUIDE_INSET_TOP),
  };
}

/** 3:4 crop box in element coordinates, anchored above the guide ellipse. */
export function cropRectFromGuide(ellipse) {
  const width = ellipse.width * CROP_WIDTH_FACTOR;
  const height = width * (4 / 3);
  const centerX = ellipse.left + ellipse.width / 2;
  return {
    left: centerX - width / 2,
    top: ellipse.top - ellipse.height * CROP_TOP_FACTOR,
    width,
    height,
  };
}

export function clampRect(x, y, w, h, maxW, maxH) {
  let nw = Math.min(w, maxW);
  let nh = Math.min(h, maxH);
  let nx = x;
  let ny = y;
  if (nx < 0) nx = 0;
  if (ny < 0) ny = 0;
  if (nx + nw > maxW) nx = maxW - nw;
  if (ny + nh > maxH) ny = maxH - nh;
  if (nx < 0) nx = 0;
  if (ny < 0) ny = 0;
  return { x: nx, y: ny, w: nw, h: nh };
}

/**
 * Map a display-space crop rect into video pixel space.
 * `mirrored` accounts for CSS `scaleX(-1)` on the preview video.
 */
export function displayCropToVideo({
  crop,
  elementW,
  elementH,
  videoW,
  videoH,
  mirrored = true,
}) {
  const { scale, offsetX, offsetY } = coverMapping({
    videoW,
    videoH,
    displayW: elementW,
    displayH: elementH,
  });

  const toVideo = (ex, ey) => {
    const ux = mirrored ? elementW - ex : ex;
    return {
      x: (ux + offsetX) / scale,
      y: (ey + offsetY) / scale,
    };
  };

  const a = toVideo(crop.left, crop.top);
  const b = toVideo(crop.left + crop.width, crop.top + crop.height);
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  return clampRect(x1, y1, x2 - x1, y2 - y1, videoW, videoH);
}

/**
 * Local front-camera selfie for hair preview (no Decart, no billing).
 * Capture is face-centered 3:4 JPEG; on-screen preview may still CSS-mirror.
 */
export function createSelfieCapture({ video, overlay, onStatus = () => {} } = {}) {
  let stream = null;

  async function start() {
    stop();
    stream = await openFrontCamera({ width: 1280, height: 720, fps: 24 });
    if (video) {
      video.srcObject = stream;
      video.hidden = false;
      video.style.transform = "scaleX(-1)";
      void video.play().catch(() => undefined);
    }
    if (overlay) overlay.hidden = false;
    onStatus("정면을 보고 얼굴이 타원 안에 들어오게 해주세요");
    return stream;
  }

  function stop() {
    stopMediaStream(stream);
    stream = null;
    if (video) {
      video.srcObject = null;
      video.hidden = true;
      video.style.transform = "none";
    }
    if (overlay) overlay.hidden = true;
  }

  async function capture() {
    if (!video || !video.videoWidth) {
      const error = new Error("카메라 화면을 아직 준비하지 못했어요.");
      error.code = "selfie-not-ready";
      throw error;
    }
    const elementW = video.clientWidth || video.videoWidth;
    const elementH = video.clientHeight || video.videoHeight;
    const videoW = video.videoWidth;
    const videoH = video.videoHeight;
    const ellipse = faceGuideEllipse(elementW, elementH);
    const cropDisplay = cropRectFromGuide(ellipse);
    const src = displayCropToVideo({
      crop: cropDisplay,
      elementW,
      elementH,
      videoW,
      videoH,
      mirrored: true,
    });

    const canvas = document.createElement("canvas");
    canvas.width = SELFIE_OUT_WIDTH;
    canvas.height = SELFIE_OUT_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      const error = new Error("촬영에 실패했습니다.");
      error.code = "selfie-encode-failed";
      throw error;
    }
    // Unmirrored source pixels (CSS mirror is display-only).
    ctx.drawImage(
      video,
      src.x, src.y, src.w, src.h,
      0, 0, SELFIE_OUT_WIDTH, SELFIE_OUT_HEIGHT,
    );
    const dataUrl = canvas.toDataURL("image/jpeg", SELFIE_JPEG_QUALITY);
    stop();
    return {
      dataUrl,
      width: SELFIE_OUT_WIDTH,
      height: SELFIE_OUT_HEIGHT,
      crop: src,
    };
  }

  return {
    start,
    stop,
    capture,
    get active() { return Boolean(stream); },
  };
}
