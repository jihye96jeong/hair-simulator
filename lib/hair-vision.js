import Anthropic from "@anthropic-ai/sdk";
import { HAIR_SPEC_TOOL, sanitizeHairSpec } from "../public/hairPrompt.js";

const TIMEOUT_MS = 15000;
const PUBLIC_ERROR = "헤어를 분석하지 못했어요. 다른 사진으로 시도해 주세요.";

const INSTRUCTION = [
  "Describe only the hairstyle of the person in the photo.",
  "Do not output face details, identity, name, age, or inferred gender.",
  "If a feature is not visible from the front, pick the most plausible value.",
  "If hair is covered, cropped, or not clearly visible, set hairVisible to false.",
  "Call the submit_hair_spec tool with every required field.",
].join(" ");

export const VISUAL_CHECK_FIELDS = Object.freeze([
  "frontDirection", "part", "foreheadExposure", "texture", "volume", "silhouette",
  "sideLength", "color", "identity", "scene",
]);
const COMPARE_TOOL = {
  name: "submit_hair_comparison", description: "Compare actual images; never compensate one mismatch with another match.",
  input_schema: { type: "object", additionalProperties: false,
    required: [...VISUAL_CHECK_FIELDS, "uncertain", "reasons"],
    properties: {
      ...Object.fromEntries(VISUAL_CHECK_FIELDS.map((field) => [field, { type: "boolean", description: "True only if visually preserved/matched." }])),
      uncertain: { type: "boolean" },
      reasons: { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 12 },
    } },
};

export function validateVisualComparison(raw) {
  if (!raw || VISUAL_CHECK_FIELDS.some((key) => typeof raw[key] !== "boolean")
    || typeof raw.uncertain !== "boolean" || !Array.isArray(raw.reasons)) throw new Error("invalid-visual-comparison");
  return { ...Object.fromEntries(VISUAL_CHECK_FIELDS.map((key) => [key, raw[key]])),
    uncertain: raw.uncertain, reasons: raw.reasons.filter((r) => typeof r === "string").slice(0, 12).map((r) => r.slice(0, 240)),
    pass: !raw.uncertain && VISUAL_CHECK_FIELDS.every((key) => raw[key]) };
}

export function createHairVision({ apiKey, model }) {
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
  return {
    async compare({ reference, person, candidate, referenceMediaType = "image/jpeg", personMediaType = "image/jpeg", candidateMediaType = "image/jpeg", live = false }) {
      const photo = (buffer, media_type) => ({ type: "image", source: { type: "base64", media_type, data: Buffer.from(buffer).toString("base64") } });
      const message = await client.messages.create({
        model, max_tokens: 1024, tools: [COMPARE_TOOL], tool_choice: { type: "tool", name: COMPARE_TOOL.name },
        messages: [{ role: "user", content: [
          { type: "text", text: "HAIR REFERENCE (ignore covered face):" }, photo(reference, referenceMediaType),
          { type: "text", text: "ORIGINAL PERSON AND SCENE:" }, photo(person, personMediaType),
          { type: "text", text: "CANDIDATE TO ACCEPT OR REJECT:" }, photo(candidate, candidateMediaType),
          { type: "text", text: [
            "Compare these images side by side. Inspect actual fringe boundary and direction, fringe separation/part, visible forehead area, strand straightness/waves/curls, top height/overall volume, hair silhouette, side length and color.",
            "A plausible or attractive haircut is insufficient. Mark each hair field false for a meaningful visible mismatch with the HAIR REFERENCE, even if enum labels could be identical. Adapt size to the person's head, but do not change the style.",
            "Identity compares candidate with ORIGINAL PERSON: eyes, brows, nose, mouth, jaw, ears, neck and skin must be retained, never the reference face. Scene compares clothes, background, framing and pose with ORIGINAL PERSON.",
            live ? "This is a live video frame: allow natural head movement and video resizing, but require the same person, clothes, environment and hairstyle." : "This is a still edit: reject moved facial features, changed expression, camera pose, framing or background.",
            "If evidence is ambiguous, set uncertain true. Give concise hair mismatch reasons only; do not describe identity or background contents. Call submit_hair_comparison.",
          ].join(" ") },
        ] }],
      }, { timeout: TIMEOUT_MS });
      return validateVisualComparison(message.content.find((item) => item.type === "tool_use" && item.name === COMPARE_TOOL.name)?.input);
    },
    async describe(imageBuffer, mediaType) {
      try {
        const message = await client.messages.create({
          model,
          max_tokens: 512,
          tools: [HAIR_SPEC_TOOL],
          tool_choice: { type: "tool", name: HAIR_SPEC_TOOL.name },
          messages: [{
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: Buffer.from(imageBuffer).toString("base64"),
                },
              },
              { type: "text", text: INSTRUCTION },
            ],
          }],
        }, { timeout: TIMEOUT_MS });
        const block = message.content.find((item) => item.type === "tool_use" && item.name === HAIR_SPEC_TOOL.name);
        if (!block || !block.input) throw new Error("missing-tool");
        return sanitizeHairSpec(block.input);
      } catch {
        throw new Error(PUBLIC_ERROR);
      }
    },
  };
}
