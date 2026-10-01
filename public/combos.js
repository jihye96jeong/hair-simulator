// KEEP draws from change_ai/shared/modes.ts hair prompt: identity/face stay; do not copy the reference face.
const KEEP = "The new hair grows from the person's own scalp and moves with their head. Keep the person's exact face, eyes, eyebrows, nose, mouth, skin, identity, body, clothes, and the background unchanged. Do not copy a face from the reference.";

export const COMBOS = Object.freeze({
  partial: { area: "hairline", density: "partial", label: "헤어라인 · 부분", image: "assets/01_hairline_partial.png",
    prompt: "Replace the person's receding hairline with the short black hairline from the reference image, filling only the corners of the temples with natural-density hair. " + KEEP },
  "1k": { area: "hairline", density: "1k", label: "헤어라인 · 1천 모", image: "assets/02_hairline_1000.png",
    prompt: "Replace the person's receding hairline with the fuller short black hairline from the reference image, filling the temples with dense, evenly spaced hair. " + KEEP },
  "2k": { area: "hairline", density: "2k", label: "헤어라인 · 2천 모", image: "assets/03_hairline_2000.png",
    prompt: "Replace the person's receding hairline with the low, full short black hairline from the reference image, covering the whole front of the scalp with dense hair. " + KEEP },
  crown_partial: { area: "crown", density: "partial", label: "정수리 · 부분", image: "assets/04_crown_partial.png",
    prompt: "Replace only the person's thinning crown with the short black crown hair from the reference image, lightly filling the small central thinning patch with natural-density hair. Preserve the natural hair whorl, existing front hairline, temples, and surrounding hairstyle. " + KEEP },
  crown_1k: { area: "crown", density: "1k", label: "정수리 · 1천 모", image: "assets/05_crown_1000.png",
    prompt: "Replace only the person's thinning crown with the fuller short black crown hair from the reference image, filling the central crown with dense, evenly spaced hair. Preserve the natural hair whorl, existing front hairline, temples, and surrounding hairstyle. " + KEEP },
  crown_2k: { area: "crown", density: "2k", label: "정수리 · 2천 모", image: "assets/06_crown_2000.png",
    prompt: "Replace only the person's thinning crown with the full short black crown hair from the reference image, covering the whole thinning crown area with dense hair. Preserve the natural hair whorl, existing front hairline, temples, and surrounding hairstyle. " + KEEP },
});

export function stateOf(key, mode, images) {
  const combo = COMBOS[key];
  if (!combo) throw new Error("알 수 없는 조합입니다.");
  if (mode === "text") {
    return { prompt: combo.prompt.replaceAll(" from the reference image", ""), enhance: true };
  }
  if (mode !== "ref" || !images[key]) throw new Error("참고 이미지가 준비되지 않았습니다.");
  return { prompt: combo.prompt, image: images[key], enhance: true };
}

// SDK connect uses ModelState; set() uses SetInput. They are different types.
export function initialStateOf(key, mode, images) {
  const { prompt, image, enhance } = stateOf(key, mode, images);
  return { prompt: { text: prompt, enhance }, ...(image ? { image } : {}) };
}
