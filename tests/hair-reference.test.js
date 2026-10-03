import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { REFERENCE_MAX_BYTES, REFERENCE_MAX_EDGE, validateReferenceFile } from "../public/hairReference.js";
import { validateSession, ValidationError } from "../lib/validation.js";

test("reference file validation matches UI limits", () => {
  assert.equal(REFERENCE_MAX_EDGE, 1024);
  assert.equal(validateReferenceFile(null).ok, false);
  assert.equal(validateReferenceFile({ type: "image/gif", size: 10 }).ok, false);
  assert.equal(validateReferenceFile({ type: "image/png", size: 0 }).ok, false);
  assert.equal(validateReferenceFile({ type: "image/png", size: REFERENCE_MAX_BYTES + 1 }).ok, false);
  assert.equal(validateReferenceFile({ type: "image/jpeg", size: 1024 }).ok, true);
  assert.equal(validateReferenceFile({ type: "image/webp", size: 2048 }).ok, true);
});

test("session-end accepts reference experienceType without weakening presets", () => {
  const base = { reason: "manual", billedSeconds: 12, wallSeconds: 13, switches: 1, captured: false };
  assert.equal(validateSession({ ...base, combo: "hairline_2000" }).experienceType, "preset");
  assert.equal(validateSession({ ...base, combo: "baseline" }).combo, "baseline");
  assert.equal(validateSession({ ...base, combo: "reference", experienceType: "reference" }).combo, "reference");
  assert.throws(() => validateSession({ ...base, combo: "partial", experienceType: "reference" }), ValidationError);
  assert.throws(() => validateSession({ ...base, combo: "reference" }), ValidationError);
  assert.throws(() => validateSession({ ...base, combo: "anything", experienceType: "reference" }), ValidationError);
  assert.throws(() => validateSession({ ...base, combo: "hairline_2000", experienceType: "other" }), ValidationError);
  assert.throws(() => validateSession({ ...base, combo: "hairline_2k" }), ValidationError);
});

test("Decart image path only uses preview blob, never raw reference upload variable", async () => {
  const flow = await readFile(new URL("../public/referenceFlow.js", import.meta.url), "utf8");
  const session = await readFile(new URL("../public/session.js", import.meta.url), "utf8");
  assert.ok(session.includes("setHairReference"));
  assert.ok(session.includes("setHairPrompt"));
  assert.ok(flow.includes("RealtimeSession"));
  assert.ok(flow.includes("image: imageBlob"));
  // Lucy's output is shown with the user's own face pasted in sync (browser-side compositor).
  assert.ok(flow.includes("startLiveFaceLock"));
  assert.match(flow, /sourceStream:\s*lucyInput/);
  assert.equal(flow.includes("image: referenceDataUrl"), false);
  assert.equal(flow.includes("image: originalUrl"), false);
  assert.ok(flow.includes("/hair-preview"));
  assert.ok(flow.includes("previewBlob"));
  assert.ok(flow.includes("maskedReferenceDataUrl"));
  assert.ok(flow.includes("reference: maskedReferenceDataUrl"));
  assert.equal(flow.includes("restoreFaceOnPreview"), false);
  // Face lock runs in the browser only; no server refine round-trip.
  assert.ok(flow.includes("lockHairOntoUser"));
  assert.equal(flow.includes("/hair-refine"), false);
  assert.ok(flow.includes("previewBlob = locked.blob"));
  assert.ok(flow.includes("previewDataUrl"));
});
