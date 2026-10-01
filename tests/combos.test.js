import test from "node:test";
import assert from "node:assert/strict";
import { COMBOS, stateOf } from "../public/combos.js";
import { AREAS, DENSITIES, COMBO_KEYS } from "../public/shared.js";

test("six hair presets map area × density to asset paths", () => {
  assert.deepEqual(AREAS, ["hairline", "crown"]);
  assert.deepEqual(DENSITIES, ["partial", "1k", "2k"]);
  assert.deepEqual(COMBO_KEYS, ["partial", "1k", "2k", "crown_partial", "crown_1k", "crown_2k"]);
  assert.deepEqual(Object.keys(COMBOS), COMBO_KEYS);
  for (const key of COMBO_KEYS) {
    const combo = COMBOS[key];
    assert.ok(AREAS.includes(combo.area));
    assert.ok(DENSITIES.includes(combo.density));
    assert.match(combo.image, /^assets\/0[1-6]_(hairline|crown)_(partial|1000|2000)\.png$/);
    assert.ok(combo.prompt.includes("Do not copy a face from the reference"));
    assert.ok(combo.prompt.length <= 750);
  }
});

test("unsupported preset throws; text mode drops reference image", () => {
  const images = { partial: new Blob(["x"]) };
  assert.throws(() => stateOf("missing", "ref", images));
  assert.throws(() => stateOf("1k", "ref", {}));
  const text = stateOf("partial", "text", images);
  assert.equal("image" in text, false);
  assert.ok(!text.prompt.includes("from the reference image"));
});
