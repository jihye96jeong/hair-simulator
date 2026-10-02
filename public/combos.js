/**
 * @deprecated Static combo assets removed from the 모수 tab.
 * Kept as an empty map so legacy imports do not crash.
 */
export const KEEP = "Keep the person's face, eyes, eyebrows, nose, mouth, jaw, ears, neck, skin, expression, clothing, background, and identity unchanged.";
export const COMBOS = Object.freeze({});

export function stateOf() {
  throw new Error("static-combos-removed");
}

export function initialStateOf() {
  throw new Error("static-combos-removed");
}
