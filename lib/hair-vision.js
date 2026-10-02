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

export function createHairVision({ apiKey, model }) {
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
  return {
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
