import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";

const TIMEOUT_MS = 60000;
const MAX_EDGE = 1024;
const PUBLIC_ERROR = "모발 채우기 이미지를 만들지 못했어요. 다시 시도해 주세요.";

/** Rough USD per image (문서/가격표 기준 대략치, 비교용). */
export const GRAFT_INPAINT_ADAPTERS = Object.freeze({
  "gemini-3-pro-image": Object.freeze({
    id: "gemini-3-pro-image",
    label: "Gemini 3 Pro Image",
    provider: "gemini",
    estimatedCostUsd: 0.04,
  }),
  "gemini-2.5-flash-image": Object.freeze({
    id: "gemini-2.5-flash-image",
    label: "Gemini 2.5 Flash Image",
    provider: "gemini",
    estimatedCostUsd: 0.02,
  }),
  "gemini-3.1-flash-image": Object.freeze({
    id: "gemini-3.1-flash-image",
    label: "Gemini 3.1 Flash Image",
    provider: "gemini",
    estimatedCostUsd: 0.02,
  }),
});

export function densityLabelForGrafts(grafts) {
  if (grafts <= 1000) return "low";
  if (grafts <= 2000) return "medium";
  return "high";
}

export function buildGraftInpaintPrompt({ area, grafts, densityLabel }) {
  const density = densityLabel || densityLabelForGrafts(grafts);
  return [
    "PERSON PHOTO and FILL MASK are attached.",
    "White pixels in the FILL MASK are the only region to edit. Black pixels must stay identical to the PERSON PHOTO.",
    "Fill only the masked area with natural hair matching the person's existing hair color, texture, thickness and direction.",
    "Keep the face, skin, lighting and background unchanged.",
    `Density: ${density} (by graft count ${grafts}).`,
    `Target area: ${area}.`,
    "Blend softly at mask edges so no hard boundary is visible. Photorealistic, no text, no watermark.",
  ].join(" ");
}

export function buildGraftInpaintParts({ personB64, maskB64, personMediaType, maskMediaType, area, grafts }) {
  const densityLabel = densityLabelForGrafts(grafts);
  return [
    { text: "PERSON PHOTO:" },
    { inlineData: { mimeType: personMediaType, data: personB64 } },
    { text: "FILL MASK (white = fill with hair, black = keep unchanged):" },
    { inlineData: { mimeType: maskMediaType, data: maskB64 } },
    { text: buildGraftInpaintPrompt({ area, grafts, densityLabel }) },
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

function createGeminiInpaintAdapter({ apiKey, model }) {
  const meta = GRAFT_INPAINT_ADAPTERS[model] || {
    id: model,
    label: model,
    provider: "gemini",
    estimatedCostUsd: null,
  };
  const ai = new GoogleGenAI({ apiKey });
  return {
    meta,
    async inpaint({ person, mask, personMediaType = "image/jpeg", maskMediaType = "image/png", area, grafts, aspectRatio = "3:4" }) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [{
            role: "user",
            parts: buildGraftInpaintParts({
              personB64: Buffer.from(person).toString("base64"),
              maskB64: Buffer.from(mask).toString("base64"),
              personMediaType,
              maskMediaType,
              area,
              grafts,
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
        const buffer = await normalizeJpeg(Buffer.from(data, "base64"));
        return {
          buffer,
          mediaType: "image/jpeg",
          model: meta.id,
          ms: Date.now() - started,
          estimatedCostUsd: meta.estimatedCostUsd,
          densityLabel: densityLabelForGrafts(grafts),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function graftInpaintInactiveReasons({ apiKey = "" } = {}) {
  const reasons = [];
  if (!apiKey) reasons.push("GEMINI_API_KEY(or GOOGLE_API_KEY)");
  return reasons;
}

/**
 * @param {{ apiKey: string, model?: string }} config
 * @returns {null | { meta: object, inpaint: Function }}
 */
export function createGraftInpaintAdapter(config = {}) {
  const apiKey = config.apiKey || "";
  if (graftInpaintInactiveReasons({ apiKey }).length) return null;
  const model = config.model || "gemini-3-pro-image";
  return createGeminiInpaintAdapter({ apiKey, model });
}

export function listGraftInpaintAdapters() {
  return Object.values(GRAFT_INPAINT_ADAPTERS);
}

export async function runGraftInpaint(adapter, input) {
  try {
    return await adapter.inpaint(input);
  } catch {
    throw new Error(PUBLIC_ERROR);
  }
}
