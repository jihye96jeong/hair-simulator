export const CAP_SECONDS = 120;
export const REGIONS = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주"];
export const COMBO_KEYS = ["partial", "1k", "2k"];
export const END_REASONS = ["cap", "hidden", "pagehide", "manual", "capture", "error", "disconnected"];
export function normalizePhone(value) {
  if (typeof value !== "string" || !/^[\d\s-]+$/.test(value)) return "";
  return value.replace(/[\s-]/g, "");
}
export function validPhone(value) { return /^(?:010\d{8}|01[16789]\d{7,8})$/.test(normalizePhone(value)); }
