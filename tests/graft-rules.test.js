import test from "node:test";
import assert from "node:assert/strict";
import { GRAFT_AREAS, GRAFT_LEVELS, RULES, ruleFor } from "../public/graftRules.js";

test("graft rules increase sizeCm and density with 1000 < 2000 < 3000 for every area", () => {
  for (const area of GRAFT_AREAS) {
    const a = ruleFor(area, 1000);
    const b = ruleFor(area, 2000);
    const c = ruleFor(area, 3000);
    assert.ok(a.sizeCm < b.sizeCm, `${area} sizeCm`);
    assert.ok(b.sizeCm < c.sizeCm, `${area} sizeCm`);
    assert.ok(a.density < b.density, `${area} density`);
    assert.ok(b.density < c.density, `${area} density`);
    assert.deepEqual(RULES[area][1000], a);
  }
  assert.deepEqual([...GRAFT_LEVELS], [1000, 2000, 3000]);
  assert.throws(() => ruleFor("nope", 1000));
  assert.throws(() => ruleFor("hairline", 500));
});
