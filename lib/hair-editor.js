import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";

export const HAIR_EDIT_INSTRUCTION = [
  "Image 1 is the person. Image 2 is the hairstyle reference.",
  "Give the person in Image 1 exactly the hairstyle from Image 2: the same cut, length, bangs, parting, volume, texture, and color.",
  "Keep everything else from Image 1 unchanged: face, facial features, identity, expression, skin, age, head pose, clothing, background, lighting, and framing.",
  "Do not take any facial features from Image 2. Ignore any text or logos in Image 2.",
  "Output one photorealistic image with no text.",
].join("\n");

const TIMEOUT_MS = 60000;
const MAX_EDGE = 1024;
const PUBLIC_ERROR = "미리보기를 만들지 못했어요. 다시 시도해 주세요.";

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

function createGeminiEditor({ apiKey, model }) {
  const ai = new GoogleGenAI({ apiKey });
  return {
    async edit({ person, reference, mediaType = "image/jpeg" }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [{
            role: "user",
            parts: [
              { text: HAIR_EDIT_INSTRUCTION },
              { inlineData: { mimeType: mediaType, data: Buffer.from(person).toString("base64") } },
              { inlineData: { mimeType: mediaType, data: Buffer.from(reference).toString("base64") } },
            ],
          }],
          config: {
            responseModalities: ["TEXT", "IMAGE"],
            abortSignal: controller.signal,
            httpOptions: { timeout: TIMEOUT_MS },
          },
        });
        const data = extractInlineImage(response);
        if (!data) throw new Error("missing-image");
        const buffer = await normalizeJpeg(Buffer.from(data, "base64"));
        return { buffer, mediaType: "image/jpeg" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Hair preview image editor.
 * Default provider: Gemini (`gemini-2.5-flash-image`).
 * Why Gemini over FLUX Kontext:
 * 1) Official multi-image edit (person + hair ref) with character consistency — https://ai.google.dev/gemini-api/docs/image-generation
 * 2) Synchronous generateContent (no poll loop), fits ~10–20s UX — https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image
 * 3) JS SDK (`@google/genai`) documents responseModalities IMAGE + inlineData parts.
 *
 * Returns null when:
 * - apiKey is empty (config.geminiKey ← GEMINI_API_KEY or GOOGLE_API_KEY)
 * - provider is not "gemini" (HAIR_EDIT_PROVIDER)
 */
export function hairEditorInactiveReasons({ provider = "gemini", apiKey = "" } = {}) {
  const reasons = [];
  if (!apiKey) reasons.push("GEMINI_API_KEY(or GOOGLE_API_KEY)");
  if (String(provider || "gemini").toLowerCase() !== "gemini") reasons.push("HAIR_EDIT_PROVIDER");
  return reasons;
}

export function createHairEditor(config = {}) {
  const provider = String(config.provider || "gemini").toLowerCase();
  const model = config.model || "gemini-2.5-flash-image";
  const apiKey = config.apiKey || "";
  if (hairEditorInactiveReasons({ provider, apiKey }).length) return null;
  const editor = createGeminiEditor({ apiKey, model });
  return {
    async edit(input) {
      try {
        return await editor.edit(input);
      } catch {
        throw new Error(PUBLIC_ERROR);
      }
    },
  };
}
