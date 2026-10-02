import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { HAIR_EDIT_INSTRUCTION, buildEditInstruction, buildEditParts } from "../lib/hair-editor.js";

test("buildEditParts uses person, optional identity, reference, then instruction", () => {
  const parts = buildEditParts({
    personB64: "cGVyc29u",
    referenceB64: "cmVm",
    mediaType: "image/jpeg",
  });
  assert.deepEqual(parts.map((p) => Object.keys(p)[0]), ["text", "inlineData", "text", "inlineData", "text"]);
  assert.equal(parts[0].text, "PERSON PHOTO:");
  assert.equal(parts[1].inlineData.data, "cGVyc29u");
  assert.equal(parts[2].text, "HAIRSTYLE REFERENCE:");
  assert.equal(parts[3].inlineData.data, "cmVm");
  assert.equal(parts[4].text, buildEditInstruction());
  assert.ok(parts[4].text.includes("Match precisely: front hair direction"));
  assert.equal(parts[4].text.includes("Target hairstyle:"), false);
  assert.ok(parts[4].text.includes("Completely remove the person's current hair"));
  assert.ok(parts[4].text.includes("intentionally covered with gray"));
  assert.equal(parts.length, 5);

  const withIdentity = buildEditParts({
    personB64: "cGVyc29u",
    referenceB64: "cmVm",
    identityB64: "aWRlbnRpdHk=",
  });
  assert.equal(withIdentity.length, 7);
  assert.equal(withIdentity[2].text, "IDENTITY CLOSE-UP (same person, keep this face exactly):");
  assert.equal(withIdentity[3].inlineData.data, "aWRlbnRpdHk=");
  assert.ok(withIdentity.at(-1).text.startsWith("Edit the PERSON PHOTO"));
  assert.ok(withIdentity.at(-1).text.includes("The output face must match the IDENTITY CLOSE-UP exactly."));
  assert.ok(HAIR_EDIT_INSTRUCTION.includes("HAIRSTYLE REFERENCE"));
});

test("gemini editor config passes imageConfig.aspectRatio through", async () => {
  const source = await readFile(new URL("../lib/hair-editor.js", import.meta.url), "utf8");
  assert.ok(source.includes("imageConfig: { aspectRatio }"));
  assert.ok(source.includes('aspectRatio = "3:4"'));
});
