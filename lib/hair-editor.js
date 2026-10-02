import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";

const TIMEOUT_MS = 60000;
const MAX_EDGE = 1024;
const PUBLIC_ERROR = "미리보기를 만들지 못했어요. 다시 시도해 주세요.";

export function buildEditInstruction(features, { hasGuide = false } = {}) {
  if (typeof features !== "string" || !features.trim()) {
    throw new Error("invalid-features");
  }
  const lines = [
    "Edit the PERSON PHOTO. Completely remove the person's current hair and replace it with the exact hairstyle from the HAIRSTYLE REFERENCE and any visual hair evidence provided.",
    "The face in the HAIRSTYLE REFERENCE is intentionally covered with gray. Use the reference only for the hair.",
  ];
  if (hasGuide) {
    lines.push(
      "Primary geometry comes from ISOLATED REFERENCE HAIR and ALIGNED HAIR GUIDE: copy the fringe boundary, strand direction, top height, side length, silhouette, texture and color onto the person's head scale.",
      "EDIT REGION white pixels may change; black pixels must remain identical to PERSON PHOTO.",
      "Do not invent waves, volume, a part, or lifted bangs that are absent from the isolated hair and guide.",
    );
  }
  lines.push(
    "Match every listed trait from the Target hairstyle and the visible hair evidence: front length and direction, bangs, part or no part, forehead exposure, overall length, side length around the ears, top silhouette, volume, strand texture, and color.",
    `Target hairstyle: ${features}`,
    "Do not invent a different texture, part, bangs shape, forehead exposure, side length, top silhouette, or volume than the hair evidence and the Target hairstyle line.",
    "The person's own current hair must not influence the result.",
    "The output face must stay the PERSON PHOTO: the same eyes, eyebrows, nose, mouth, jaw, ears, neck, skin tone, expression, and facial proportions. Do not copy the reference person's face or head shape.",
    "Keep the same framing, head pose, clothing, and background. Photorealistic, no text.",
  );
  return lines.join("\n");
}

/** @deprecated Use buildEditInstruction(features). Kept for tests that inspect base wording. */
export const HAIR_EDIT_INSTRUCTION = buildEditInstruction(
  "Front hair lifted up, forehead fully exposed, sides above the ears, short top with messy textured strands, dark brown color.",
);

export function buildEditParts({ personB64, referenceB64, features, mediaType = "image/jpeg", guide, hairOnly, editMask }) {
  const parts = [
    { text: "PERSON PHOTO:" },
    { inlineData: { mimeType: mediaType, data: personB64 } },
    { text: "HAIRSTYLE REFERENCE:" },
    { inlineData: { mimeType: mediaType, data: referenceB64 } },
  ];
  if (hairOnly) parts.push({ text: "ISOLATED REFERENCE HAIR: actual hair pixels, no reference face. Use the fringe boundary, strand direction, silhouette and texture as visual evidence." },
    { inlineData: { mimeType: "image/png", data: Buffer.from(hairOnly).toString("base64") } });
  if (guide) parts.push({ text: "ALIGNED HAIR GUIDE: a rough placement guide on the PERSON PHOTO. Follow the mapped fringe edge, top height and side silhouette. Gray marks removed old hair, not a desired color. Resolve seams photorealistically without restyling the reference." },
    { inlineData: { mimeType: "image/jpeg", data: Buffer.from(guide).toString("base64") } });
  if (editMask) parts.push({ text: "EDIT REGION: white permits hair replacement and exposed forehead reconstruction; black protects the original person and scene. Keep all protected pixels and image coordinates unchanged." },
    { inlineData: { mimeType: "image/png", data: Buffer.from(editMask).toString("base64") } });
  parts.push({ text: buildEditInstruction(features, { hasGuide: Boolean(guide || hairOnly) }) });
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
    async edit({ person, reference, features, mediaType = "image/jpeg", referenceMediaType = mediaType, guide, hairOnly, editMask }) {
      if (typeof features !== "string" || !features.trim()) throw new Error("invalid-features");
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
              features,
              mediaType,
              guide, hairOnly, editMask,
            }),
          }],
          config: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: { aspectRatio: "3:4" },
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
 * Default provider: Gemini (`gemini-3.1-flash-image`).
 */
export function hairEditorInactiveReasons({ provider = "gemini", apiKey = "" } = {}) {
  const reasons = [];
  if (!apiKey) reasons.push("GEMINI_API_KEY(or GOOGLE_API_KEY)");
  if (String(provider || "gemini").toLowerCase() !== "gemini") reasons.push("HAIR_EDIT_PROVIDER");
  return reasons;
}

export function createHairEditor(config = {}) {
  const provider = String(config.provider || "gemini").toLowerCase();
  const model = config.model || "gemini-3.1-flash-image";
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
