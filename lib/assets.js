import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { COMBOS } from "../public/combos.js";

export async function assetAvailability() {
  return Object.fromEntries(await Promise.all(Object.entries(COMBOS).map(async ([key, combo]) => {
    try {
      const actual = await readFile(new URL(`../public/${combo.image}`, import.meta.url));
      let placeholder;
      try { placeholder = await readFile(new URL(`../public/assets/placeholder_${key}.webp`, import.meta.url)); } catch { /* no fallback installed */ }
      const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
      return [key, actual.length > 0 && (!placeholder || hash(actual) !== hash(placeholder))];
    } catch { return [key, false]; }
  })));
}
