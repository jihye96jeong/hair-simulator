const KEEP = "The hair stays attached to the scalp and moves with the person's head. Keep the person's face, eyes, eyebrows, skin, and identity unchanged.";

export const COMBOS = Object.freeze({
  partial: { label: "헤어라인 · 부분", image: "assets/hairline_partial.webp",
    prompt: "Replace the person's receding hairline with the short black hairline from the reference image, filling only the corners of the temples with natural-density hair. " + KEEP },
  "1k": { label: "헤어라인 · 1천 모", image: "assets/hairline_1k.webp",
    prompt: "Replace the person's receding hairline with the fuller short black hairline from the reference image, filling the temples with dense, evenly spaced hair. " + KEEP },
  "2k": { label: "헤어라인 · 2천 모", image: "assets/hairline_2k.webp",
    prompt: "Replace the person's receding hairline with the low, full short black hairline from the reference image, covering the whole front of the scalp with dense hair. " + KEEP },
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
