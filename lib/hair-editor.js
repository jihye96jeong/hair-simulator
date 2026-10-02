import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";

const TIMEOUT_MS = 60000;
const MAX_EDGE = 1024;
const PUBLIC_ERROR = "미리보기를 만들지 못했어요. 다시 시도해 주세요.";

export function buildEditInstruction({ hasIdentity = false } = {}) {
  return [
    "Edit the PERSON PHOTO. Completely remove the person's current hair and replace it with the exact hairstyle from the HAIRSTYLE REFERENCE.",
    "The face in the HAIRSTYLE REFERENCE is intentionally covered with gray. Use the reference only for the hair.",
    "Match precisely: front hair direction, how much forehead is visible, side length around the ears, top length and volume, strand texture, and color.",
    "The person's own current hair must not influence the result.",
    hasIdentity
      ? "The output face must match the IDENTITY CLOSE-UP exactly. Keep the same eyes, eyebrows, nose, mouth, jaw, ears, skin tone, and facial proportions. Do not copy the reference person's face."
      : "The output face must stay the PERSON PHOTO: same eyes, eyebrows, nose, mouth, jaw, ears, skin tone, and facial proportions. Do not copy the reference person's face.",
    "Keep the same framing, head pose, clothing, and background. Photorealistic, no text.",
  ].join("\n");
}

/** @deprecated Use buildEditInstruction(). Kept for tests that inspect base wording. */
export const HAIR_EDIT_INSTRUCTION = buildEditInstruction();

export function buildEditParts({
  personB64,
  referenceB64,
  identityB64,
  mediaType = "image/jpeg",
  identityMediaType = "image/jpeg",
}) {
  const parts = [
    { text: "PERSON PHOTO:" },
    { inlineData: { mimeType: mediaType, data: personB64 } },
  ];
  if (identityB64) {
    parts.push(
      { text: "IDENTITY CLOSE-UP (same person, keep this face exactly):" },
      { inlineData: { mimeType: identityMediaType, data: identityB64 } },
    );
  }
  parts.push(
    { text: "HAIRSTYLE REFERENCE:" },
    { inlineData: { mimeType: mediaType, data: referenceB64 } },
    { text: buildEditInstruction({ hasIdentity: Boolean(identityB64) }) },
  );
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

function createGeminiEditor({ apiKey, model }) {
  const ai = new GoogleGenAI({ apiKey });
  return {
    async edit({
      person,
      reference,
      identity,
      mediaType = "image/jpeg",
      identityMediaType = "image/jpeg",
      aspectRatio = "3:4",
    }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [{
            role: "user",
            parts: buildEditParts({
              personB64: Buffer.from(person).toString("base64"),
              referenceB64: Buffer.from(reference).toString("base64"),
              identityB64: identity ? Buffer.from(identity).toString("base64") : undefined,
              mediaType,
              identityMediaType,
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
        return { buffer, mediaType: "image/jpeg" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Hair preview image editor.
 * Default provider: Gemini (`gemini-3-pro-image`).
 */
export function hairEditorInactiveReasons({ provider = "gemini", apiKey = "" } = {}) {
  const reasons = [];
  if (!apiKey) reasons.push("GEMINI_API_KEY(or GOOGLE_API_KEY)");
  if (String(provider || "gemini").toLowerCase() !== "gemini") reasons.push("HAIR_EDIT_PROVIDER");
  return reasons;
}

export function createHairEditor(config = {}) {
  const provider = String(config.provider || "gemini").toLowerCase();
  const model = config.model || "gemini-3-pro-image";
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
