/**
 * 병원 확인 전 임시값.
 * 병원 기준을 받으면 이 표(RULES / GRAFT_LEVELS)만 바꿔도 되도록 숫자를 한곳에 모은다.
 */
export const GRAFT_LEVELS = Object.freeze([1000, 2000, 3000]);

/**
 * sizeCm 의미:
 * - mline: 양쪽 이마 모서리를 채우는 삼각형 한 변의 길이
 * - hairline: 헤어라인을 아래로 내리는 깊이
 * - crown: 채우는 원의 반지름
 * density: 새로 채우는 영역의 머리카락 밀도 (0~1)
 */
export const RULES = Object.freeze({
  mline: Object.freeze({
    1000: Object.freeze({ sizeCm: 1.0, density: 0.6 }),
    2000: Object.freeze({ sizeCm: 1.8, density: 0.8 }),
    3000: Object.freeze({ sizeCm: 2.5, density: 0.95 }),
  }),
  hairline: Object.freeze({
    1000: Object.freeze({ sizeCm: 0.8, density: 0.6 }),
    2000: Object.freeze({ sizeCm: 1.5, density: 0.8 }),
    3000: Object.freeze({ sizeCm: 2.2, density: 0.95 }),
  }),
  crown: Object.freeze({
    1000: Object.freeze({ sizeCm: 2.0, density: 0.6 }),
    2000: Object.freeze({ sizeCm: 3.0, density: 0.8 }),
    3000: Object.freeze({ sizeCm: 3.8, density: 0.95 }),
  }),
});

export const GRAFT_AREAS = Object.freeze(Object.keys(RULES));

export function ruleFor(area, grafts) {
  const table = RULES[area];
  if (!table) throw new Error(`unknown-graft-area:${area}`);
  const rule = table[grafts];
  if (!rule) throw new Error(`unknown-graft-level:${area}:${grafts}`);
  return { sizeCm: rule.sizeCm, density: rule.density };
}

export function densityKeyForGrafts(grafts) {
  if (grafts === 1000) return "1k";
  if (grafts === 2000) return "2k";
  if (grafts === 3000) return "3k";
  throw new Error(`unknown-graft-level:${grafts}`);
}

export function comboKeyFor(area, grafts) {
  return `${area}_${densityKeyForGrafts(grafts)}`;
}

export function chipLabel(area, grafts, sizeCm) {
  const graftsLabel = `${grafts.toLocaleString("en-US")}모`;
  if (area === "mline") return `M자 · ${graftsLabel} · 모서리 약 ${sizeCm.toFixed(1)}cm`;
  if (area === "crown") return `정수리 · ${graftsLabel} · 반경 약 ${sizeCm.toFixed(1)}cm`;
  return `헤어라인 · ${graftsLabel} · 약 ${sizeCm.toFixed(1)}cm`;
}

export const GRAFT_PROMPTS = Object.freeze({
  common: "Keep the face, eyes, eyebrows, skin, expression, and identity exactly as in the reference image. The hair stays attached to the scalp and moves with the head.",
  hairline: "Keep the person's hairline exactly at the position and density shown in the reference image. ",
  mline: "Keep the filled temple corners of the hairline exactly as shown in the reference image. ",
  crown: "Keep the crown hair density exactly as shown in the reference image, with no scalp showing through in the filled area. ",
});

export function promptForArea(area) {
  const head = GRAFT_PROMPTS[area];
  if (!head) throw new Error(`unknown-graft-area:${area}`);
  return `${head}${GRAFT_PROMPTS.common}`;
}
