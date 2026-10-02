export const CAP_SECONDS = 120;
export const REGIONS = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주"];
export const AREAS = ["mline", "hairline", "crown"];
export const DENSITIES = ["1k", "2k", "3k"];
export const COMBO_KEYS = AREAS.flatMap((area) => DENSITIES.map((density) => `${area}_${density}`));
export const EXPERIENCE_TYPES = ["preset", "reference"];
export const REFERENCE_SESSION_KEY = "reference";
export const END_REASONS = ["cap", "hidden", "pagehide", "manual", "capture", "error", "disconnected"];
export function normalizePhone(value) {
  if (typeof value !== "string" || !/^[\d\s-]+$/.test(value)) return "";
  return value.replace(/[\s-]/g, "");
}
export function validPhone(value) { return /^(?:010\d{8}|01[16789]\d{7,8})$/.test(normalizePhone(value)); }
