import sharp from "sharp";
import { mkdir, access } from "node:fs/promises";
import { COMBOS } from "../public/combos.js";
const dir = new URL("../public/assets/", import.meta.url);
await mkdir(dir, { recursive: true });
for (const [key, combo] of Object.entries(COMBOS)) {
  const label = `${combo.area.toUpperCase()} ${combo.density.toUpperCase()}`;
  const path = new URL(`placeholder_${key}.webp`, dir);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#d1d5db"/><text x="640" y="340" text-anchor="middle" font-family="sans-serif" font-size="48" fill="#4b5563">${label}</text><text x="640" y="405" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#4b5563">REFERENCE PLACEHOLDER</text></svg>`;
  try { await access(path); } catch { await sharp(Buffer.from(svg)).webp().toFile(path.pathname); }
  console.log(`${key}: 1280 × 720 예비 플레이스홀더 준비 완료`);
}
