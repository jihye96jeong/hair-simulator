import { openFrontCamera, stopMediaStream } from "./camera.js";

/** Matches `.selfie-guide { inset: 12% 18%; }` */
export const GUIDE_INSET_TOP = 0.12;
export const GUIDE_INSET_SIDE = 0.18;
export const SELFIE_OUT_WIDTH = 768;
export const SELFIE_OUT_HEIGHT = 1024;
/** 2:3 output height for chest / long crops (width stays SELFIE_OUT_WIDTH). */
export const SELFIE_OUT_HEIGHT_TALL = 1152;
export const SELFIE_JPEG_QUALITY = 0.9;
export const CROP_WIDTH_FACTOR = 2.2;
export const CROP_TOP_FACTOR = 0.9;
export const IDENTITY_CROP_FACTOR = 1.4;
export const IDENTITY_OUT_SIZE = 512;
export const LONG_CROP_LENGTHS = Object.freeze(["chest", "long"]);

/** Gemini / crop aspect from reference hair length. */
export function aspectRatioForLength(length) {
  return LONG_CROP_LENGTHS.includes(length) ? "2:3" : "3:4";
}

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

/**
 * Viewport-matching crop rect in element coordinates.
 * Keeps the visual distance/framing that the user saw during the live webcam countdown,
 * avoiding abrupt zoom-ins on the result screen.
 */
export function viewportCropRect({ elementW, elementH, aspectRatio = "3:4" } = {}) {
  const targetAspect = aspectRatio === "2:3" ? (2 / 3) : (3 / 4);
  const elementAspect = elementW / elementH;
  let width;
  let height;
  if (elementAspect > targetAspect) {
    height = elementH;
    width = height * targetAspect;
  } else {
    width = elementW;
    height = width / targetAspect;
  }
  const left = (elementW - width) / 2;
  const top = (elementH - height) / 2;
  return { left, top, width, height };
}

/**
 * Face-centered crop in element coordinates, anchored above the guide ellipse.
 * Default 3:4; chest/long styles use 2:3 by extending downward.
 */
export function cropRectFromGuide(ellipse, { aspectRatio = "3:4" } = {}) {
  const width = ellipse.width * CROP_WIDTH_FACTOR;
  const height = aspectRatio === "2:3" ? width * (3 / 2) : width * (4 / 3);
  const centerX = ellipse.left + ellipse.width / 2;
  return {
    left: centerX - width / 2,
    top: ellipse.top - ellipse.height * CROP_TOP_FACTOR,
    width,
    height,
  };
}

/** 1:1 identity close-up centered on the face guide ellipse. */
export function identityCropFromGuide(ellipse) {
  const size = ellipse.width * IDENTITY_CROP_FACTOR;
  const centerX = ellipse.left + ellipse.width / 2;
  const centerY = ellipse.top + ellipse.height / 2;
  return {
    left: centerX - size / 2,
    top: centerY - size / 2,
    width: size,
    height: size,
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
 * Capture is face-centered 3:4 or 2:3 JPEG; on-screen preview may still CSS-mirror.
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

  async function captureFrameData({ length } = {}) {
    if (!video || !video.videoWidth) {
      const error = new Error("카메라 화면을 아직 준비하지 못했어요.");
      error.code = "selfie-not-ready";
      throw error;
    }
    const aspectRatio = aspectRatioForLength(length);
    const outWidth = SELFIE_OUT_WIDTH;
    const outHeight = aspectRatio === "2:3" ? SELFIE_OUT_HEIGHT_TALL : SELFIE_OUT_HEIGHT;
    const elementW = video.clientWidth || video.videoWidth;
    const elementH = video.clientHeight || video.videoHeight;
    const videoW = video.videoWidth;
    const videoH = video.videoHeight;
    const ellipse = faceGuideEllipse(elementW, elementH);
    const cropDisplay = viewportCropRect({ elementW, elementH, aspectRatio });
    const identityDisplay = identityCropFromGuide(ellipse);
    const src = displayCropToVideo({
      crop: cropDisplay,
      elementW,
      elementH,
      videoW,
      videoH,
      mirrored: true,
    });
    const identitySrc = displayCropToVideo({
      crop: identityDisplay,
      elementW,
      elementH,
      videoW,
      videoH,
      mirrored: true,
    });

    const canvas = document.createElement("canvas");
    canvas.width = outWidth;
    canvas.height = outHeight;
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
      0, 0, outWidth, outHeight,
    );
    const dataUrl = canvas.toDataURL("image/jpeg", SELFIE_JPEG_QUALITY);

    const identityCanvas = document.createElement("canvas");
    identityCanvas.width = IDENTITY_OUT_SIZE;
    identityCanvas.height = IDENTITY_OUT_SIZE;
    const identityCtx = identityCanvas.getContext("2d");
    if (!identityCtx) {
      const error = new Error("촬영에 실패했습니다.");
      error.code = "selfie-encode-failed";
      throw error;
    }
    identityCtx.drawImage(
      video,
      identitySrc.x, identitySrc.y, identitySrc.w, identitySrc.h,
      0, 0, IDENTITY_OUT_SIZE, IDENTITY_OUT_SIZE,
    );
    const identityDataUrl = identityCanvas.toDataURL("image/jpeg", SELFIE_JPEG_QUALITY);
    return {
      dataUrl,
      identityDataUrl,
      width: outWidth,
      height: outHeight,
      aspectRatio,
      crop: src,
      identityCrop: identitySrc,
    };
  }

  async function capture({ length } = {}) {
    const shot = await captureFrameData({ length });
    stop();
    return shot;
  }

  return {
    start,
    stop,
    capture,
    get active() { return Boolean(stream); },
  };
}
