export const CAP_SECONDS = 120;
export const REGIONS = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주"];
export const AREAS = ["mline", "hairline", "crown"];
/** Lead API density labels (unchanged). */
export const DENSITIES = ["1k", "2k", "3k"];
/** Session-end / Lucy combo keys: area_graftCount (e.g. hairline_2000). */
export const GRAFT_COUNTS = Object.freeze([1000, 2000, 3000]);
export const COMBO_KEYS = AREAS.flatMap((area) => GRAFT_COUNTS.map((grafts) => `${area}_${grafts}`));
export const EXPERIENCE_TYPES = ["preset", "reference"];
export const REFERENCE_SESSION_KEY = "reference";
export const END_REASONS = ["cap", "hidden", "pagehide", "manual", "capture", "error", "disconnected"];
export const SESSION_MODES = Object.freeze(["ref", "text", "graft"]);

/** Exact END_REASONS, or connect/disconnect detail reasons used by RealtimeSession. */
export function isAllowedSessionEndReason(reason) {
  if (END_REASONS.includes(reason)) return true;
  if (typeof reason !== "string" || reason.length === 0 || reason.length > 300) return false;
  return /^(connect-failed:|disconnected:|error:)/.test(reason);
}
export function normalizePhone(value) {
  if (typeof value !== "string" || !/^[\d\s-]+$/.test(value)) return "";
  return value.replace(/[\s-]/g, "");
}
export function validPhone(value) { return /^(?:010\d{8}|01[16789]\d{7,8})$/.test(normalizePhone(value)); }
