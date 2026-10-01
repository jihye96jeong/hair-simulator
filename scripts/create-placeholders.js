import sharp from "sharp";
import { mkdir, access, copyFile } from "node:fs/promises";
const dir = new URL("../public/assets/", import.meta.url);
await mkdir(dir, { recursive: true });
for (const [key, label] of [["partial", "PARTIAL"], ["1k", "1,000"], ["2k", "2,000"]]) {
  const path = new URL(`placeholder_${key}.webp`, dir);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#d1d5db"/><text x="640" y="340" text-anchor="middle" font-family="sans-serif" font-size="48" fill="#4b5563">${label}</text><text x="640" y="405" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#4b5563">REFERENCE PLACEHOLDER</text></svg>`;
  try { await access(path); } catch { await sharp(Buffer.from(svg)).webp().toFile(path.pathname); }
  const actual = new URL(`hairline_${key}.webp`, dir);
  try { await access(actual); console.log(`${key}: 기존 에셋 유지`); } catch {
    await copyFile(path, actual);
    console.log(`${key}: 1280 × 720 회색 플레이스홀더 생성`);
  }
}
