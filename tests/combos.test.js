import test from "node:test";
import assert from "node:assert/strict";
import { COMBOS, stateOf } from "../public/combos.js";
import { AREAS, DENSITIES, COMBO_KEYS, GRAFT_COUNTS } from "../public/shared.js";
import { GRAFT_AREAS, GRAFT_LEVELS, comboKeyFor, promptForArea, ruleFor } from "../public/graftRules.js";

test("모수 keys are area × 1000/2000/3000 with no static PNG map", () => {
  assert.deepEqual(AREAS, ["mline", "hairline", "crown"]);
  assert.deepEqual(DENSITIES, ["1k", "2k", "3k"]);
  assert.deepEqual([...GRAFT_COUNTS], [1000, 2000, 3000]);
  assert.deepEqual(COMBO_KEYS, [
    "mline_1000", "mline_2000", "mline_3000",
    "hairline_1000", "hairline_2000", "hairline_3000",
    "crown_1000", "crown_2000", "crown_3000",
  ]);
  assert.deepEqual(Object.keys(COMBOS), []);
  assert.throws(() => stateOf());
  for (const area of GRAFT_AREAS) {
    for (const grafts of GRAFT_LEVELS) {
      assert.equal(comboKeyFor(area, grafts), `${area}_${grafts}`);
      assert.ok(ruleFor(area, grafts).sizeCm > 0);
      assert.ok(promptForArea(area).includes("Keep the face, eyes, eyebrows"));
    }
  }
});
