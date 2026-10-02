import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { HAIR_EDIT_INSTRUCTION, buildEditInstruction, buildEditParts } from "../lib/hair-editor.js";

const FEATURES = "Front hair lifted up, forehead fully exposed, sides above the ears, short top with messy textured strands, dark brown color.";

test("buildEditParts alternates labels and images then instruction with features", () => {
  const parts = buildEditParts({
    personB64: "cGVyc29u",
    referenceB64: "cmVm",
    features: FEATURES,
    mediaType: "image/jpeg",
  });
  assert.deepEqual(parts.map((p) => Object.keys(p)[0]), ["text", "inlineData", "text", "inlineData", "text"]);
  assert.equal(parts[0].text, "PERSON PHOTO:");
  assert.equal(parts[1].inlineData.data, "cGVyc29u");
  assert.equal(parts[2].text, "HAIRSTYLE REFERENCE:");
  assert.equal(parts[3].inlineData.data, "cmVm");
  assert.equal(parts[4].text, buildEditInstruction(FEATURES));
  assert.ok(parts[4].text.includes("Match these precisely:"));
  assert.ok(parts[4].text.includes(`Target hairstyle: ${FEATURES}`));
  assert.ok(parts[4].text.includes("Completely remove the person's current hair"));
  assert.ok(parts[4].text.includes("intentionally covered with gray"));
  assert.throws(() => buildEditParts({ personB64: "a", referenceB64: "b", features: "" }), /invalid-features/);
  assert.ok(HAIR_EDIT_INSTRUCTION.includes("Target hairstyle:"));
});

test("gemini editor config requests imageConfig.aspectRatio 3:4", async () => {
  const source = await readFile(new URL("../lib/hair-editor.js", import.meta.url), "utf8");
  assert.ok(source.includes('imageConfig: { aspectRatio: "3:4" }'));
});
