import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGraftInpaintPrompt,
  buildGraftInpaintParts,
  densityLabelForGrafts,
  listGraftInpaintAdapters,
  GRAFT_INPAINT_ADAPTERS,
  createGraftInpaintAdapter,
  graftInpaintInactiveReasons,
} from "../lib/graft-inpaint.js";

test("density labels and prompt mention mask-only fill", () => {
  assert.equal(densityLabelForGrafts(1000), "low");
  assert.equal(densityLabelForGrafts(2000), "medium");
  assert.equal(densityLabelForGrafts(3000), "high");
  const prompt = buildGraftInpaintPrompt({ area: "hairline", grafts: 2000 });
  assert.ok(prompt.includes("Density: medium"));
  assert.ok(prompt.includes("Fill only the masked area"));
  assert.ok(prompt.includes("Keep the face, skin, lighting and background unchanged"));
});

test("adapters expose model id, cost estimate, and inactive without key", () => {
  const list = listGraftInpaintAdapters();
  assert.ok(list.length >= 3);
  for (const item of list) {
    assert.ok(item.id);
    assert.ok(Number.isFinite(item.estimatedCostUsd));
  }
  assert.ok(GRAFT_INPAINT_ADAPTERS["gemini-3-pro-image"]);
  assert.deepEqual(graftInpaintInactiveReasons({ apiKey: "" }), ["GEMINI_API_KEY(or GOOGLE_API_KEY)"]);
  assert.equal(createGraftInpaintAdapter({ apiKey: "" }), null);
});

test("inpaint parts order person then mask then instruction", () => {
  const parts = buildGraftInpaintParts({
    personB64: "aaa",
    maskB64: "bbb",
    personMediaType: "image/jpeg",
    maskMediaType: "image/png",
    area: "crown",
    grafts: 1000,
  });
  assert.equal(parts[0].text, "PERSON PHOTO:");
  assert.equal(parts[1].inlineData.data, "aaa");
  assert.match(parts[2].text, /FILL MASK/);
  assert.equal(parts[3].inlineData.mimeType, "image/png");
  assert.match(parts[4].text, /Density: low/);
});
