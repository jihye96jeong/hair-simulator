/**
 * @deprecated Static combo PNG assets were removed from the 모수 tab.
 * Kept only so stale imports do not crash; all graft live paths use graftRules + graftGuide.
 */
export const KEEP = "Keep the person's face, eyes, eyebrows, nose, mouth, jaw, ears, neck, skin, expression, clothing, background, and identity unchanged.";
export const COMBOS = Object.freeze({});

export function stateOf() {
  throw new Error("static-combos-removed");
}

export function initialStateOf() {
  throw new Error("static-combos-removed");
}
