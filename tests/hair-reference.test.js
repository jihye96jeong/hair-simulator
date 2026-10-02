import test from "node:test";
import assert from "node:assert/strict";
import {
  REFERENCE_HAIR_PROMPT,
  REFERENCE_MAX_BYTES,
  cropFromManual,
  faceFromManual,
  faceMask,
  hairBand,
  validateReferenceFile,
} from "../public/hairReference.js";
import { validateSession, ValidationError } from "../lib/validation.js";

test("reference file validation matches UI limits", () => {
  assert.equal(validateReferenceFile(null).ok, false);
  assert.equal(validateReferenceFile({ type: "image/gif", size: 10 }).ok, false);
  assert.equal(validateReferenceFile({ type: "image/png", size: 0 }).ok, false);
  assert.equal(validateReferenceFile({ type: "image/png", size: REFERENCE_MAX_BYTES + 1 }).ok, false);
  assert.equal(validateReferenceFile({ type: "image/jpeg", size: 1024 }).ok, true);
  assert.equal(validateReferenceFile({ type: "image/webp", size: 2048 }).ok, true);
});

test("hairBand keeps longer hair and side silhouette", () => {
  const face = { x: 50, y: 80, width: 100, height: 120 };
  const shortBand = hairBand(200, 400, face, "short");
  const longBand = hairBand(200, 400, face, "long");
  assert.ok(longBand.sh > shortBand.sh);
  assert.ok(longBand.sy + longBand.sh > face.y + face.height);
  assert.ok(longBand.sx < face.x);
  assert.deepEqual(hairBand(100, 200, null), { sx: 0, sy: 0, sw: 100, sh: 200 });
});

test("faceMask leaves hairline and sides outside blur", () => {
  const face = { x: 50, y: 80, width: 100, height: 120 };
  const crop = hairBand(200, 300, face, "long");
  const mask = faceMask(crop, face);
  assert.ok(mask);
  const top = mask.cy - mask.ry + crop.sy;
  const left = mask.cx - mask.rx + crop.sx;
  const right = mask.cx + mask.rx + crop.sx;
  assert.ok(top > face.y + face.height * 0.15);
  assert.ok(left > face.x);
  assert.ok(right < face.x + face.width);
});

test("manual crop and face helpers stay inside image bounds", () => {
  const crop = cropFromManual(1000, 800, { left: 0.1, right: 0.1, top: 0.05, bottom: 0.2 });
  assert.deepEqual(crop, { sx: 100, sy: 40, sw: 800, sh: 600 });
  const face = faceFromManual(1000, 800, { cx: 0.5, cy: 0.4, rw: 0.3, rh: 0.4 });
  assert.equal(face.width, 300);
  assert.equal(face.height, 320);
});

test("reference prompt prioritizes identity preservation", () => {
  assert.ok(REFERENCE_HAIR_PROMPT.includes("Change only the hair"));
  assert.ok(REFERENCE_HAIR_PROMPT.includes("Do not copy the reference person’s face"));
  assert.ok(REFERENCE_HAIR_PROMPT.includes("Do not beautify or reshape the face"));
  assert.ok(REFERENCE_HAIR_PROMPT.length <= 1200);
});

test("session-end accepts reference experienceType without weakening presets", () => {
  const base = { reason: "manual", billedSeconds: 12, wallSeconds: 13, switches: 1, captured: false };
  assert.equal(validateSession({ ...base, combo: "2k" }).experienceType, "preset");
  assert.equal(validateSession({ ...base, combo: "reference", experienceType: "reference" }).combo, "reference");
  assert.throws(() => validateSession({ ...base, combo: "partial", experienceType: "reference" }), ValidationError);
  assert.throws(() => validateSession({ ...base, combo: "reference" }), ValidationError);
  assert.throws(() => validateSession({ ...base, combo: "anything", experienceType: "reference" }), ValidationError);
  assert.throws(() => validateSession({ ...base, combo: "2k", experienceType: "other" }), ValidationError);
});
