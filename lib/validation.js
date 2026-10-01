import { COMBO_KEYS, END_REASONS, REGIONS, normalizePhone, validPhone } from "../public/shared.js";

export class ValidationError extends Error {}
const reject = (message) => { throw new ValidationError(message); };
function consent(value, now) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now + 60000 && time >= now - 86400000;
}

export function validateLead(body, now = Date.now()) {
  if (!body || typeof body !== "object") reject("입력값을 확인해 주세요.");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 50 || /[\u0000-\u001f]/.test(name)) reject("이름을 확인해 주세요.");
  if (!validPhone(body.phone)) reject("휴대폰 번호를 확인해 주세요.");
  if (!REGIONS.includes(body.region) || body.area !== "hairline" || !COMBO_KEYS.includes(body.density)) reject("지역과 선택한 조합을 확인해 주세요.");
  if (!["save", "referral"].includes(body.action)) reject("요청을 확인해 주세요.");
  if (!consent(body.consentAt, now)) reject("개인정보 수집·이용 동의가 필요합니다.");
  if (body.action === "referral" && !consent(body.thirdPartyConsentAt, now)) reject("제3자 제공 동의가 필요합니다.");
  if (body.thirdPartyConsentAt && !consent(body.thirdPartyConsentAt, now)) reject("동의 시각을 확인해 주세요.");
  const image = typeof body.image === "string" ? body.image.replace(/^data:image\/webp;base64,/, "") : "";
  if (!image || image.length > 2800000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image) || image.length % 4) reject("캡처 이미지를 확인해 주세요.");
  const bytes = Buffer.from(image, "base64");
  if (bytes.toString("base64") !== image || bytes.length > 2 * 1024 * 1024 || bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) + 8 !== bytes.length) reject("WebP 캡처 이미지만 저장할 수 있습니다.");
  return { name, phone: normalizePhone(body.phone), region: body.region, area: body.area, density: body.density, action: body.action, consentAt: new Date(body.consentAt).toISOString(), thirdPartyConsentAt: body.action === "referral" ? new Date(body.thirdPartyConsentAt).toISOString() : "", image: bytes };
}

export function validateSession(body) {
  if (!body || !END_REASONS.includes(body.reason) || !COMBO_KEYS.includes(body.combo) || typeof body.captured !== "boolean") reject("세션 기록을 확인해 주세요.");
  for (const name of ["billedSeconds", "wallSeconds", "switches"]) {
    if (!Number.isFinite(body[name]) || body[name] < 0) reject("세션 기록을 확인해 주세요.");
  }
  if (body.billedSeconds > 125 || body.wallSeconds > 86400 || !Number.isInteger(body.switches) || body.switches > 10000) reject("세션 기록 범위를 확인해 주세요.");
  if (body.mode && !["ref", "text"].includes(body.mode)) reject("모드를 확인해 주세요.");
  if (body.anchor && !["on", "off"].includes(body.anchor)) reject("앵커 설정을 확인해 주세요.");
  return { reason: body.reason, billedSeconds: body.billedSeconds, wallSeconds: body.wallSeconds, switches: body.switches, combo: body.combo, captured: body.captured, mode: body.mode || "", anchor: body.anchor || "" };
}
