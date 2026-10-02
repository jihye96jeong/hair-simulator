import test from "node:test";
import assert from "node:assert/strict";
import {
  BASELINE_REFINE_PROMPT,
  buildBaselineParts,
  promptForBaselinePose,
  baselineEditorInactiveReasons,
} from "../lib/baseline-editor.js";

test("baseline refine prompt and parts include mask", () => {
  assert.ok(BASELINE_REFINE_PROMPT.includes("already shows the person with severe hair loss"));
  assert.ok(BASELINE_REFINE_PROMPT.includes("Do not add hair on the top or front"));
  assert.equal(promptForBaselinePose("front"), BASELINE_REFINE_PROMPT);
  assert.equal(promptForBaselinePose("crown"), BASELINE_REFINE_PROMPT);
  const parts = buildBaselineParts({ personB64: "abc", maskB64: "msk", pose: "front" });
  assert.equal(parts[0].text, "BASE PHOTO:");
  assert.equal(parts[1].inlineData.data, "abc");
  assert.equal(parts[2].text, "MASK (white = bald area to refine):");
  assert.equal(parts[3].inlineData.data, "msk");
  assert.equal(parts[4].text, BASELINE_REFINE_PROMPT);
  assert.ok(baselineEditorInactiveReasons({ apiKey: "" }).length > 0);
  assert.equal(baselineEditorInactiveReasons({ apiKey: "k" }).length, 0);
});
