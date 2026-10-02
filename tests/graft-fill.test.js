import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  buildGraftFillParts,
  buildGraftFillPrompt,
  compositeOutsideMask,
  densityWordForValue,
} from "../lib/graft-fill.js";

test("densityWordForValue maps 0.6/0.8/0.95", () => {
  assert.equal(densityWordForValue(0.6), "sparse");
  assert.equal(densityWordForValue(0.8), "medium");
  assert.equal(densityWordForValue(0.95), "dense");
});

test("graft fill prompt and parts include mask labels and density", () => {
  const prompt = buildGraftFillPrompt({ density: 0.8 });
  assert.ok(prompt.includes("already has hair roughly painted"));
  assert.ok(prompt.includes("medium"));
  assert.ok(prompt.includes("Do not change anything outside the white area"));
  const parts = buildGraftFillParts({
    personB64: "aaa",
    maskB64: "bbb",
    density: 0.6,
  });
  assert.equal(parts[0].text, "BASE PHOTO:");
  assert.equal(parts[1].inlineData.data, "aaa");
  assert.equal(parts[2].text, "FILL MASK (white = add hair here):");
  assert.equal(parts[3].inlineData.data, "bbb");
  assert.ok(parts[4].text.includes("sparse"));
});

test("compositeOutsideMask keeps baseline pixels outside mask", async () => {
  const width = 16;
  const height = 20;
  const baseline = await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).jpeg().toBuffer();
  const filled = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  }).jpeg().toBuffer();
  const maskRgba = Buffer.alloc(width * height * 4, 0);
  for (let y = 4; y < 10; y++) {
    for (let x = 4; x < 12; x++) {
      const o = (y * width + x) * 4;
      maskRgba[o] = 255;
      maskRgba[o + 1] = 255;
      maskRgba[o + 2] = 255;
      maskRgba[o + 3] = 255;
    }
  }
  const mask = await sharp(maskRgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const out = await compositeOutsideMask({ baseline, filled, mask });
  const { data } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // Outside mask → baseline greenish blue
  const outO = (0 * width + 0) * 4;
  assert.ok(Math.abs(data[outO] - 10) < 8);
  assert.ok(Math.abs(data[outO + 1] - 20) < 8);
  assert.ok(Math.abs(data[outO + 2] - 30) < 8);
  // Inside mask → filled red
  const inO = (6 * width + 6) * 4;
  assert.ok(data[inO] > 150);
  assert.ok(data[inO + 1] < 80);
});

test("compositeOutsideMask fails on size mismatch", async () => {
  const baseline = await sharp({
    create: { width: 16, height: 20, channels: 3, background: "#112233" },
  }).jpeg().toBuffer();
  const filled = await sharp({
    create: { width: 32, height: 20, channels: 3, background: "#ff0000" },
  }).jpeg().toBuffer();
  const mask = await sharp({
    create: { width: 16, height: 20, channels: 3, background: "#ffffff" },
  }).png().toBuffer();
  await assert.rejects(
    () => compositeOutsideMask({ baseline, filled, mask }),
    (err) => err.code === "fill-size-mismatch",
  );
});
