import assert from "node:assert/strict";
import { GRAFT_AREAS, GRAFT_LEVELS, promptForArea } from "../public/graftRules.js";
for (const area of GRAFT_AREAS) {
  const prompt = promptForArea(area);
  assert.ok(prompt.length <= 750, `${area}: 750자 초과`);
  assert.ok(prompt.includes("Keep the face, eyes, eyebrows"));
  console.log(`${area}: ${prompt.length}/750 통과`);
}
for (const grafts of GRAFT_LEVELS) assert.ok(grafts > 0);
