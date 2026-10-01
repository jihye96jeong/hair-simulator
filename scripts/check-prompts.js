import assert from "node:assert/strict";
import { COMBOS, stateOf } from "../public/combos.js";
for (const [key, combo] of Object.entries(COMBOS)) {
  assert.ok(combo.prompt.length <= 750, `${key}: 750자 초과`);
  assert.ok(!stateOf(key, "text", {}).prompt.includes("from the reference image"));
  console.log(`${key}: ${combo.prompt.length}/750 통과`);
}
