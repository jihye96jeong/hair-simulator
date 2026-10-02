/**
 * Pose / quality helpers for 4-direction graft capture.
 * Yaw/pitch are geometric approximations from Face Landmarker (not MediaPipe matrix).
 */

/** Nose tip and cheek landmarks for crude head-pose estimates. */
export const NOSE_TIP = 1;
export const LEFT_CHEEK = 234;
export const RIGHT_CHEEK = 454;
export const FOREHEAD = 10;
export const CHIN = 152;

/**
 * Approximate yaw in degrees. Negative = looking left (subject's left / camera right).
 * Uses nose tip offset between cheeks.
 */
export function estimateYawDegrees(points) {
  const nose = points[NOSE_TIP];
  const left = points[LEFT_CHEEK];
  const right = points[RIGHT_CHEEK];
  if (!nose || !left || !right) return NaN;
  const midX = (left.x + right.x) / 2;
  const half = Math.max(1e-3, Math.abs(right.x - left.x) / 2);
  const t = Math.max(-1, Math.min(1, (nose.x - midX) / half));
  return (Math.asin(t) * 180) / Math.PI;
}

/**
 * Approximate pitch in degrees. Positive = looking down (chin closer / forehead up in frame).
 */
export function estimatePitchDegrees(points) {
  const forehead = points[FOREHEAD];
  const nose = points[NOSE_TIP];
  const chin = points[CHIN];
  if (!forehead || !nose || !chin) return NaN;
  const faceH = Math.max(1e-3, chin.y - forehead.y);
  const noseRatio = (nose.y - forehead.y) / faceH;
  // Neutral ~0.45; looking down pushes nose toward chin → higher ratio
  return (noseRatio - 0.45) * 90;
}

export const SHOT_ORDER = Object.freeze(["front", "left", "right", "crown"]);

export const SHOT_META = Object.freeze({
  front: {
    label: "정면",
    hint: "정면을 바라봐 주세요",
    guide: "front",
    yawMin: -10,
    yawMax: 10,
    pitchMax: 20,
  },
  left: {
    label: "왼쪽",
    hint: "고개를 왼쪽으로 살짝 돌려 주세요",
    guide: "left",
    yawMin: -45,
    yawMax: -25,
    pitchMax: 25,
  },
  right: {
    label: "오른쪽",
    hint: "고개를 오른쪽으로 살짝 돌려 주세요",
    guide: "right",
    yawMin: 25,
    yawMax: 45,
    pitchMax: 25,
  },
  crown: {
    label: "정수리",
    hint: "고개를 숙여 정수리가 보이게 해주세요",
    guide: "crown",
    yawMin: -90,
    yawMax: 90,
    pitchMin: 25,
  },
});

/**
 * Quality warnings for a shot. Always returns { ok, warnings[], metrics }.
 * Does not block — user decides whether to retake.
 */
export function evaluateShotQuality({
  direction,
  yaw,
  pitch,
  faceCount = 1,
  brightness = 0.5,
  motion = 0,
  hairRatio = 0.2,
}) {
  const meta = SHOT_META[direction];
  if (!meta) throw new Error(`unknown-shot:${direction}`);
  const warnings = [];
  const metrics = { yaw, pitch, faceCount, brightness, motion, hairRatio };

  if (faceCount > 1) warnings.push("얼굴이 여러 명 감지됐어요");
  if (brightness < 0.18) warnings.push("화면이 너무 어두워요");
  if (motion > 0.08) warnings.push("흔들림이 커요. 잠시 멈춘 뒤 다시 찍어 주세요");

  if (direction === "crown") {
    if (Number.isFinite(pitch) && pitch < (meta.pitchMin ?? 25)) {
      warnings.push("고개를 더 숙여 정수리가 보이게 해주세요");
    }
    if (hairRatio < 0.08) warnings.push("머리 영역이 너무 작아요. 정수리가 가운데 오게 해주세요");
    // Face landmarks may be missing for crown — only warn if we have yaw and it's wild
  } else {
    if (!Number.isFinite(yaw)) warnings.push("얼굴을 인식하지 못했어요");
    else if (yaw < meta.yawMin || yaw > meta.yawMax) {
      warnings.push(`권장 각도: ${meta.label} (현재 yaw ${yaw.toFixed(0)}°)`);
    }
    if (Number.isFinite(pitch) && pitch > (meta.pitchMax ?? 25)) {
      warnings.push("너무 숙였어요. 고개를 조금 들어 주세요");
    }
  }

  return { ok: warnings.length === 0, warnings, metrics };
}

/** Live pose bucket for Lucy reference switching. */
export function livePoseFromAngles(yaw, pitch) {
  if (Number.isFinite(pitch) && pitch >= 28) return "crown";
  if (Number.isFinite(yaw) && yaw <= -20) return "left";
  if (Number.isFinite(yaw) && yaw >= 20) return "right";
  return "front";
}
