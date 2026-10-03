export function captureFrame(video, comboLabel, overlay = null, { overlayMirror = false } = {}) {
  const width = video.videoWidth || video.width;
  const height = video.videoHeight || video.height;
  const playing = video.readyState === undefined || video.readyState >= 2;
  if (!playing || !width || !height) throw new Error("영상이 준비된 후 다시 눌러 주세요.");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  // Remote output is already mirrored by the SDK. Apply no extra CSS/canvas flip.
  context.drawImage(video, 0, 0);
  if (overlay?.width && overlay?.height) {
    context.save();
    if (overlayMirror) {
      context.translate(width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(overlay, 0, 0, width, height);
    context.restore();
  }
  const font = Math.max(18, Math.round(canvas.width / 40));
  const pad = Math.round(canvas.width / 50);
  context.font = `600 ${font}px sans-serif`;
  context.fillStyle = "rgba(0,0,0,.7)";
  context.fillRect(pad, canvas.height - pad - font * 1.7, context.measureText("예상 이미지").width + pad * 2, font * 1.7);
  context.fillStyle = "#fff";
  context.fillText("예상 이미지", pad * 2, canvas.height - pad - font * .45);
  context.fillStyle = "rgba(0,0,0,.7)";
  context.fillRect(pad, pad, context.measureText(comboLabel).width + pad * 2, font * 1.7);
  context.fillStyle = "#fff";
  context.fillText(comboLabel, pad * 2, pad + font * 1.15);
  return canvas;
}

export function downloadCapture(canvas, { mode, anchor, combo, pose }) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${mode}_${anchor === "off" ? "noanchor" : "anchor"}_${combo}_${pose}_${new Date().toISOString().replaceAll(/[:.]/g, "-")}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, "image/png");
}
