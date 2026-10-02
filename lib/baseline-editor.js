import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";
import { compositeOutsideMask } from "./graft-fill.js";

const TIMEOUT_MS = 60000;
const MAX_EDGE = 1024;
const PUBLIC_ERROR = "시술 전 이미지를 만들지 못했어요";

/** Rough USD per image (가격표 대략치, 비교용). */
export const BASELINE_COST_USD = Object.freeze({
  "gemini-3-pro-image": 0.04,
  "gemini-2.5-flash-image": 0.02,
  "gemini-3.1-flash-image": 0.02,
  "gemini-3.1-flash-lite-image": 0.02,
});

/** Refine a 2D-prefilled bald photo inside the bald MASK only. */
export const BASELINE_REFINE_PROMPT = [
  "This photo already shows the person with severe hair loss; the bald area was roughly painted.",
  "Inside the white area of the MASK only, make the bald scalp and the background look photorealistic:",
  "natural scalp skin with subtle shine and texture, consistent lighting,",
  "and short trimmed hair at the edges where it meets the remaining side hair.",
  "Do not add hair on the top or front of the head.",
  "Do not change anything outside the white area.",
  "Photorealistic, no text.",
].join(" ");

/** @deprecated Kept for tests that assert historical wording; refine path uses BASELINE_REFINE_PROMPT. */
export const BASELINE_FRONT_PROMPT = BASELINE_REFINE_PROMPT;
export const BASELINE_CROWN_PROMPT = BASELINE_REFINE_PROMPT;

export function promptForBaselinePose(_pose = "front") {
  return BASELINE_REFINE_PROMPT;
}

export function buildBaselineParts({
  personB64,
  maskB64,
  personMediaType = "image/jpeg",
  maskMediaType = "image/png",
  pose = "front",
}) {
  const parts = [
    { text: "BASE PHOTO:" },
    { inlineData: { mimeType: personMediaType, data: personB64 } },
  ];
  if (maskB64) {
    parts.push({ text: "MASK (white = bald area to refine):" });
    parts.push({ inlineData: { mimeType: maskMediaType, data: maskB64 } });
  }
  parts.push({ text: promptForBaselinePose(pose) });
  return parts;
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

function createGeminiBaselineEditor({ apiKey, model }) {
  const ai = new GoogleGenAI({ apiKey });
  return {
    async edit({
      person,
      mask,
      mediaType = "image/jpeg",
      maskMediaType = "image/png",
      pose = "front",
      aspectRatio = "3:4",
    }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const started = Date.now();
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [{
            role: "user",
            parts: buildBaselineParts({
              personB64: Buffer.from(person).toString("base64"),
              maskB64: mask ? Buffer.from(mask).toString("base64") : undefined,
              personMediaType: mediaType,
              maskMediaType,
              pose,
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
        if (mask) {
          const baseMeta = await sharp(person).metadata();
          const fillMeta = await sharp(buffer).metadata();
          if (baseMeta.width && baseMeta.height && fillMeta.width && fillMeta.height) {
            const baseRatio = baseMeta.width / baseMeta.height;
            const fillRatio = fillMeta.width / fillMeta.height;
            if (Math.abs(baseRatio - fillRatio) > 0.08) {
              const error = new Error("baseline-aspect-mismatch");
              error.code = "fill-size-mismatch";
              throw error;
            }
            buffer = await sharp(buffer)
              .resize(baseMeta.width, baseMeta.height, { fit: "fill" })
              .jpeg({ quality: 90, mozjpeg: true })
              .toBuffer();
          }
          buffer = await compositeOutsideMask({ baseline: person, filled: buffer, mask });
        }
        return {
          buffer,
          mediaType: "image/jpeg",
          model,
          ms: Date.now() - started,
          estimatedCostUsd: BASELINE_COST_USD[model] ?? 0.04,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function baselineEditorInactiveReasons({ provider = "gemini", apiKey = "" } = {}) {
  const reasons = [];
  if (!apiKey) reasons.push("GEMINI_API_KEY(or GOOGLE_API_KEY)");
  if (String(provider || "gemini").toLowerCase() !== "gemini") reasons.push("HAIR_EDIT_PROVIDER");
  return reasons;
}

/**
 * Test-mode baseline refine editor (Gemini).
 * Prefill is done in the browser; this only photorealizes inside the bald mask.
 */
export function createBaselineEditor(config = {}) {
  const provider = String(config.provider || "gemini").toLowerCase();
  const model = config.model || "gemini-3-pro-image";
  const apiKey = config.apiKey || "";
  if (baselineEditorInactiveReasons({ provider, apiKey }).length) return null;
  const editor = createGeminiBaselineEditor({ apiKey, model });
  return {
    async edit(input) {
      try {
        return await editor.edit(input);
      } catch (error) {
        if (error?.code === "fill-size-mismatch") throw error;
        throw new Error(PUBLIC_ERROR);
      }
    },
  };
}

export { PUBLIC_ERROR as BASELINE_PUBLIC_ERROR };
