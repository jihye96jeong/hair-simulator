import Anthropic from "@anthropic-ai/sdk";
import {
  HAIR_FOREHEADS,
  HAIR_FRONTS,
  HAIR_SIDES,
  HAIR_SPEC_TOOL,
  sanitizeHairSpec,
} from "../public/hairPrompt.js";

const TIMEOUT_MS = 15000;
const PUBLIC_ERROR = "헤어를 분석하지 못했어요. 다른 사진으로 시도해 주세요.";

const INSTRUCTION = [
  "Describe only the hairstyle of the person in the photo.",
  "Do not output face details, identity, name, age, or inferred gender.",
  "If a feature is not visible from the front, pick the most plausible value.",
  "If hair is covered, cropped, or not clearly visible, set hairVisible to false.",
  "Bangs means hair deliberately cut to fall over the forehead. Face-framing layers that start at the cheeks or below, with a visible part, are NOT bangs: set bangs to none and front to parted_curtain or swept_to_side.",
  "Call the submit_hair_spec tool with every required field.",
].join(" ");

const COMPARE_INSTRUCTION = [
  "The first image is the HAIRSTYLE REFERENCE (its face is intentionally covered). The following images are CANDIDATE results, in order.",
  "For each candidate, judge only the hair against the reference: front hair direction, forehead coverage, side length around the ears, top length and volume, texture, and color.",
  "Give similarity from 0 (completely different hairstyle) to 10 (same hairstyle). Ignore the face, skin, clothing, and background.",
  "Call the submit_hair_comparison tool with one entry per candidate, in the same order.",
].join(" ");

export const HAIR_COMPARE_TOOL = Object.freeze({
  name: "submit_hair_comparison",
  description: "Score how closely each candidate's hairstyle matches the reference hairstyle. Never describe faces or identity.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["candidates"],
    properties: {
      candidates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "front", "forehead", "sides", "similarity"],
          properties: {
            index: { type: "integer", description: "0-based candidate order." },
            front: { type: "string", enum: [...HAIR_FRONTS] },
            forehead: { type: "string", enum: [...HAIR_FOREHEADS] },
            sides: { type: "string", enum: [...HAIR_SIDES] },
            similarity: { type: "integer", minimum: 0, maximum: 10 },
          },
        },
      },
    },
  },
});

/** Validate one comparison entry; null when unusable. */
export function sanitizeComparison(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!HAIR_FRONTS.includes(raw.front) || !HAIR_FOREHEADS.includes(raw.forehead) || !HAIR_SIDES.includes(raw.sides)) return null;
  const similarity = raw.similarity;
  if (typeof similarity !== "number" || !Number.isInteger(similarity) || similarity < 0 || similarity > 10) return null;
  return { front: raw.front, forehead: raw.forehead, sides: raw.sides, similarity };
}

function imageBlock(buffer, mediaType) {
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: Buffer.from(buffer).toString("base64") },
  };
}

export function createHairVision({ apiKey, model }) {
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
  return {
    /** Reference + candidates in one call → per-candidate hair fields and 0–10 similarity. */
    async compare({ reference, referenceMediaType = "image/jpeg", candidates }) {
      try {
        const content = [{ type: "text", text: "HAIRSTYLE REFERENCE:" }, imageBlock(reference, referenceMediaType)];
        candidates.forEach((candidate, index) => {
          content.push({ type: "text", text: `CANDIDATE ${index}:` }, imageBlock(candidate.buffer, candidate.mediaType || "image/jpeg"));
        });
        content.push({ type: "text", text: COMPARE_INSTRUCTION });
        const message = await client.messages.create({
          model,
          max_tokens: 1024,
          tools: [HAIR_COMPARE_TOOL],
          tool_choice: { type: "tool", name: HAIR_COMPARE_TOOL.name },
          messages: [{ role: "user", content }],
        }, { timeout: TIMEOUT_MS });
        const block = message.content.find((item) => item.type === "tool_use" && item.name === HAIR_COMPARE_TOOL.name);
        const entries = block?.input?.candidates;
        if (!Array.isArray(entries)) throw new Error("missing-tool");
        const byIndex = new Map();
        entries.forEach((entry, position) => {
          const clean = sanitizeComparison(entry);
          const index = Number.isInteger(entry?.index) ? entry.index : position;
          if (clean && !byIndex.has(index)) byIndex.set(index, clean);
        });
        const scores = candidates.map((_, index) => byIndex.get(index) || null);
        if (scores.some((score) => !score)) throw new Error("incomplete");
        return { ok: true, scores };
      } catch {
        throw new Error(PUBLIC_ERROR);
      }
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
