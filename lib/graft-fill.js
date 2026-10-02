import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";

const TIMEOUT_MS = 60000;
const MAX_EDGE = 1024;
const PUBLIC_ERROR = "모발 채우기 이미지를 만들지 못했어요. 다시 시도해 주세요.";

/** Rough USD per image (가격표 대략치, 비교용). */
export const GRAFT_FILL_COST_USD = Object.freeze({
  "gemini-3-pro-image": 0.04,
  "gemini-2.5-flash-image": 0.02,
  "gemini-3.1-flash-image": 0.02,
  "gemini-3.1-flash-lite-image": 0.02,
});

export function densityWordForValue(density) {
  const d = Number(density);
  if (d <= 0.7) return "sparse";
  if (d <= 0.85) return "medium";
  return "dense";
}

export function buildGraftFillPrompt({ density }) {
  const word = densityWordForValue(density);
  return [
    "This photo already has hair roughly painted inside the white area of the FILL MASK. Inside that area only, make the hair look photorealistic while keeping its exact coverage, boundary shape, and density.",
    `Hair density in the filled area: ${word}.`,
    "Do not change anything outside the white area.",
    "Keep the face, skin, expression, clothing, background, lighting, and framing identical.",
    "Photorealistic, no text.",
  ].join(" ");
}

export function buildGraftFillParts({
  personB64,
  maskB64,
  personMediaType = "image/jpeg",
  maskMediaType = "image/png",
  density,
}) {
  return [
    { text: "BASE PHOTO:" },
    { inlineData: { mimeType: personMediaType, data: personB64 } },
    { text: "FILL MASK (white = add hair here):" },
    { inlineData: { mimeType: maskMediaType, data: maskB64 } },
    { text: buildGraftFillPrompt({ density }) },
  ];
}

async function normalizeJpeg(buffer) {
  return sharp(buffer)
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

function extractInlineImage(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const data = part.inlineData?.data || part.inline_data?.data;
    if (data) return data;
  }
  return null;
}

/**
 * Composite: outside the (feathered) mask, keep baseline pixels.
 * Fails if baseline and filled differ in size after normalize.
 */
export async function compositeOutsideMask({ baseline, filled, mask }) {
  const baseMeta = await sharp(baseline).metadata();
  const fillMeta = await sharp(filled).metadata();
  const maskMeta = await sharp(mask).metadata();
  const width = baseMeta.width;
  const height = baseMeta.height;
  if (!width || !height) throw new Error("bad-baseline-size");
  if (fillMeta.width !== width || fillMeta.height !== height) {
    const error = new Error("fill-size-mismatch");
    error.code = "fill-size-mismatch";
    throw error;
  }
  if (maskMeta.width !== width || maskMeta.height !== height) {
    // Resize mask to baseline size (nearest) when aspect matches after Gemini mask round-trip
    const resizedMask = await sharp(mask)
      .resize(width, height, { fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return compositeRaw({
      baseline,
      filled,
      maskRaw: resizedMask.data,
      width,
      height,
      maskChannels: resizedMask.info.channels,
    });
  }
  const maskRaw = await sharp(mask).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return compositeRaw({
    baseline,
    filled,
    maskRaw: maskRaw.data,
    width,
    height,
    maskChannels: maskRaw.info.channels,
  });
}

async function compositeRaw({ baseline, filled, maskRaw, width, height, maskChannels }) {
  const base = await sharp(baseline).ensureAlpha().raw().toBuffer();
  const fill = await sharp(filled).ensureAlpha().raw().toBuffer();
  const out = Buffer.from(base);
  const ch = maskChannels;
  for (let i = 0; i < width * height; i++) {
    const m = maskRaw[i * ch] / 255; // white = fill
    if (m <= 0.02) continue;
    const o = i * 4;
    const a = Math.min(1, m);
    out[o] = Math.round(base[o] * (1 - a) + fill[o] * a);
    out[o + 1] = Math.round(base[o + 1] * (1 - a) + fill[o + 1] * a);
    out[o + 2] = Math.round(base[o + 2] * (1 - a) + fill[o + 2] * a);
    out[o + 3] = 255;
  }
  return sharp(out, { raw: { width, height, channels: 4 } }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

function createGeminiFill({ apiKey, model }) {
  const ai = new GoogleGenAI({ apiKey });
  return {
    async fill({
      person,
      mask,
      personMediaType = "image/jpeg",
      maskMediaType = "image/png",
      density = 0.8,
      aspectRatio = "3:4",
    }) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [{
            role: "user",
            parts: buildGraftFillParts({
              personB64: Buffer.from(person).toString("base64"),
              maskB64: Buffer.from(mask).toString("base64"),
              personMediaType,
              maskMediaType,
              density,
            }),
          }],
          config: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: { aspectRatio },
            abortSignal: controller.signal,
            httpOptions: { timeout: TIMEOUT_MS },
          },
        });
        const data = extractInlineImage(response);
        if (!data) throw new Error("missing-image");
        let buffer = await normalizeJpeg(Buffer.from(data, "base64"));
        // Match baseline size before composite; fail if aspect differs too much
        const baseMeta = await sharp(person).metadata();
        const fillMeta = await sharp(buffer).metadata();
        if (baseMeta.width && baseMeta.height && fillMeta.width && fillMeta.height) {
          const baseRatio = baseMeta.width / baseMeta.height;
          const fillRatio = fillMeta.width / fillMeta.height;
          if (Math.abs(baseRatio - fillRatio) > 0.08) {
            const error = new Error("fill-aspect-mismatch");
            error.code = "fill-size-mismatch";
            throw error;
          }
          buffer = await sharp(buffer)
            .resize(baseMeta.width, baseMeta.height, { fit: "fill" })
            .jpeg({ quality: 90, mozjpeg: true })
            .toBuffer();
        }
        buffer = await compositeOutsideMask({ baseline: person, filled: buffer, mask });
        return {
          buffer,
          mediaType: "image/jpeg",
          model,
          ms: Date.now() - started,
          estimatedCostUsd: GRAFT_FILL_COST_USD[model] ?? 0.04,
          densityLabel: densityWordForValue(density),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function graftFillInactiveReasons({ apiKey = "" } = {}) {
  const reasons = [];
  if (!apiKey) reasons.push("GEMINI_API_KEY(or GOOGLE_API_KEY)");
  return reasons;
}

export function createGraftFillAdapter(config = {}) {
  const apiKey = config.apiKey || "";
  if (graftFillInactiveReasons({ apiKey }).length) return null;
  const model = config.model || "gemini-3-pro-image";
  return createGeminiFill({ apiKey, model });
}

export async function runGraftFill(adapter, input) {
  try {
    return await adapter.fill(input);
  } catch (error) {
    if (error?.code === "fill-size-mismatch") throw error;
    // Caller may fall back to prefillGuide; still surface a typed failure.
    const wrapped = new Error(PUBLIC_ERROR);
    wrapped.code = "graft-fill-fail";
    wrapped.cause = error;
    throw wrapped;
  }
}

export { PUBLIC_ERROR as GRAFT_FILL_PUBLIC_ERROR };
