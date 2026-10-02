import test from "node:test";
import assert from "node:assert/strict";
import { COMBOS, stateOf } from "../public/combos.js";
import { AREAS, DENSITIES, COMBO_KEYS } from "../public/shared.js";
import { GRAFT_AREAS, GRAFT_LEVELS, comboKeyFor, promptForArea, ruleFor } from "../public/graftRules.js";

test("모수 keys are area × 1k/2k/3k with no static PNG map", () => {
  assert.deepEqual(AREAS, ["mline", "hairline", "crown"]);
  assert.deepEqual(DENSITIES, ["1k", "2k", "3k"]);
  assert.deepEqual(COMBO_KEYS, [
    "mline_1k", "mline_2k", "mline_3k",
    "hairline_1k", "hairline_2k", "hairline_3k",
    "crown_1k", "crown_2k", "crown_3k",
  ]);
  assert.deepEqual(Object.keys(COMBOS), []);
  assert.throws(() => stateOf());
  for (const area of GRAFT_AREAS) {
    for (const grafts of GRAFT_LEVELS) {
      assert.equal(comboKeyFor(area, grafts), `${area}_${grafts === 1000 ? "1k" : grafts === 2000 ? "2k" : "3k"}`);
      assert.ok(ruleFor(area, grafts).sizeCm > 0);
      assert.ok(promptForArea(area).includes("Keep the face, eyes, eyebrows"));
    }
  }
});
