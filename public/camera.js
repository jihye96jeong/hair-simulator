/**
 * Front camera for Decart realtime. Constraints follow the model ideal size/fps
 * (same approach as change_ai/src/session.ts). Call only after a user gesture.
 */
export async function openFrontCamera(model) {
  if (!navigator.mediaDevices?.getUserMedia) {
    const error = new Error("이 브라우저는 카메라를 지원하지 않습니다.");
    error.code = "camera-unsupported";
    throw error;
  }
  const fps = typeof model?.fps === "number"
    ? model.fps
    : (model?.fps?.ideal ?? model?.fps?.max ?? model?.fps?.exact ?? 24);
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: model?.width || 1280 },
        height: { ideal: model?.height || 720 },
        frameRate: { ideal: fps },
      },
    });
  } catch (cause) {
    const error = new Error(
      cause?.name === "NotAllowedError" ? "카메라 권한이 거부되었습니다."
        : cause?.name === "NotFoundError" ? "사용 가능한 카메라가 없습니다."
          : "카메라를 열지 못했습니다.",
    );
    error.code = cause?.name === "NotAllowedError" ? "camera-denied"
      : cause?.name === "NotFoundError" ? "camera-missing" : "camera-failed";
    error.cause = cause;
    throw error;
  }
}

export function stopMediaStream(stream) {
  for (const track of stream?.getTracks?.() || []) track.stop();
}
