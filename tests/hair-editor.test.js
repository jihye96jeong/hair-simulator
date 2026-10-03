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
  assert.ok(parts[4].text.includes("Do not move, zoom, or reshape the face."));
  assert.ok(parts[4].text.includes("intentionally covered with a flat skin-tone patch"));
  assert.equal(parts[4].text.includes("covered with gray"), false);
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

  const withAngle = buildEditParts({
    personB64: "cGVyc29u",
    referenceB64: "cmVm",
    identityB64: "aWRlbnRpdHk=",
    angleB64: "YW5nbGU=",
  });
  assert.equal(withAngle.length, 9);
  assert.equal(withAngle[4].text, "PERSON HEAD & HAIRLINE ANGLE PHOTO (same person, crown/angle view):");
  assert.equal(withAngle[5].inlineData.data, "YW5nbGU=");
  assert.ok(withAngle.at(-1).text.includes("PERSON HEAD & HAIRLINE ANGLE PHOTO"));
});

test("gemini editor config passes imageConfig.aspectRatio through", async () => {
  const source = await readFile(new URL("../lib/hair-editor.js", import.meta.url), "utf8");
  assert.ok(source.includes("imageConfig: { aspectRatio }"));
  assert.ok(source.includes('aspectRatio = "3:4"'));
});
