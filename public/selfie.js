import { openFrontCamera, stopMediaStream } from "./camera.js";

const SELFIE_MAX_EDGE = 1024;

/**
 * Local front-camera selfie for hair preview (no Decart, no billing).
 * Capture is unmirrored JPEG; on-screen preview may still CSS-mirror.
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
    const width = video.videoWidth;
    const height = video.videoHeight;
    const edge = Math.max(width, height);
    const scale = edge > SELFIE_MAX_EDGE ? SELFIE_MAX_EDGE / edge : 1;
    const outW = Math.max(1, Math.round(width * scale));
    const outH = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      const error = new Error("촬영에 실패했습니다.");
      error.code = "selfie-encode-failed";
      throw error;
    }
    // Unmirrored: draw the raw camera frame as-is (no scaleX(-1)).
    ctx.drawImage(video, 0, 0, outW, outH);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    stop();
    return { dataUrl, width: outW, height: outH };
  }

  return {
    start,
    stop,
    capture,
    get active() { return Boolean(stream); },
  };
}
