import test from "node:test";
import assert from "node:assert/strict";
import {
  SCORE_FIELDS,
  countHairMatches,
  pickScoreFields,
  runPreviewContest,
  selectBestCandidate,
} from "../lib/hair-judge.js";

const ref = {
  front: "falls_down",
  forehead: "partly_exposed",
  sides: "above_ears",
  top: "short",
  hairVisible: true,
  length: "short",
  cut: "layered cut",
  bangs: "see_through",
  part: "none",
  texture: "straight",
  volume: "natural",
  color: "black",
};

const person = {
  ...ref,
  front: "lifted_up",
  forehead: "fully_exposed",
  sides: "over_ears",
  top: "medium",
  bangs: "none",
  texture: "s_wave",
  volume: "voluminous",
  length: "shoulder",
};

test("countHairMatches only scores front/forehead/sides and stays in 0–3", () => {
  assert.deepEqual([...SCORE_FIELDS], ["front", "forehead", "sides"]);
  assert.equal(countHairMatches(ref, ref), 3);
  assert.equal(countHairMatches(ref, person), 0);
  assert.equal(countHairMatches(ref, { ...ref, front: "lifted_up" }), 2);
  assert.equal(countHairMatches(ref, { ...person, front: ref.front, forehead: ref.forehead, sides: ref.sides }), 3);
  assert.ok(countHairMatches(ref, ref) <= 3);
  assert.deepEqual(Object.keys(pickScoreFields(ref)).sort(), [...SCORE_FIELDS].sort());
});

test("selectBestCandidate picks highest score and keeps first on ties", () => {
  const pick = selectBestCandidate([
    { index: 0, hairMatch: 1, buffer: "a" },
    { index: 1, hairMatch: 3, buffer: "b" },
    { index: 2, hairMatch: 2, buffer: "c" },
  ]);
  assert.equal(pick.buffer, "b");
  const tie = selectBestCandidate([
    { index: 0, hairMatch: 2, buffer: "first" },
    { index: 1, hairMatch: 2, buffer: "second" },
  ]);
  assert.equal(tie.buffer, "first");
  assert.equal(selectBestCandidate([]), null);
});

test("runPreviewContest picks higher match without regenerate", async () => {
  const weak = { ...person };
  const strong = { ...ref };
  let describes = 0;
  const vision = {
    describe: async () => {
      describes += 1;
      return { ok: true, spec: describes === 1 ? weak : strong };
    },
  };
  let edits = 0;
  const editor = {
    edit: async () => ({ buffer: Buffer.from(`c${edits++}`), mediaType: "image/jpeg" }),
  };
  const result = await runPreviewContest({
    editor,
    vision,
    person: Buffer.from("p"),
    reference: Buffer.from("r"),
    referenceSpec: ref,
    labDebug: true,
  });
  assert.equal(edits, 2);
  assert.equal(describes, 2);
  assert.equal(result.selectedIndex, 1);
  assert.equal(result.scores[0].hairMatch, 0);
  assert.equal(result.scores[1].hairMatch, 3);
  assert.equal(result.candidates[1].selected, true);
});

test("runPreviewContest prefers one reference-vs-candidates compare call and picks by similarity", async () => {
  let compares = 0;
  let describes = 0;
  let seen = null;
  const vision = {
    describe: async () => { describes += 1; return { ok: true, spec: ref }; },
    compare: async (input) => {
      compares += 1;
      seen = input;
      return {
        ok: true,
        scores: [
          { front: ref.front, forehead: ref.forehead, sides: ref.sides, similarity: 4 },
          { front: person.front, forehead: ref.forehead, sides: ref.sides, similarity: 8 },
        ],
      };
    },
  };
  let edits = 0;
  const editor = {
    edit: async () => ({ buffer: Buffer.from(`c${edits++}`), mediaType: "image/jpeg" }),
  };
  const result = await runPreviewContest({
    editor,
    vision,
    person: Buffer.from("p"),
    reference: Buffer.from("r"),
    referenceSpec: ref,
    labDebug: true,
  });
  assert.equal(compares, 1);
  assert.equal(describes, 0);
  assert.equal(seen.reference.toString(), "r");
  assert.equal(seen.candidates.length, 2);
  // Similarity against the reference image outranks the text-spec field match (3/3 vs 2/3).
  assert.equal(result.selectedIndex, 1);
  assert.equal(result.scores[0].hairMatch, 3);
  assert.equal(result.scores[0].similarity, 4);
  assert.equal(result.scores[1].hairMatch, 2);
  assert.equal(result.scores[1].similarity, 8);
  assert.equal(result.candidates[1].selected, true);
  assert.equal(result.candidates[1].similarity, 8);
});

test("selectBestCandidate falls back to field match when similarity ties", () => {
  const pick = selectBestCandidate([
    { index: 0, hairMatch: 1, similarity: 6, buffer: "a" },
    { index: 1, hairMatch: 3, similarity: 6, buffer: "b" },
  ]);
  assert.equal(pick.buffer, "b");
  const tie = selectBestCandidate([
    { index: 0, hairMatch: 2, similarity: 6, buffer: "first" },
    { index: 1, hairMatch: 2, similarity: 6, buffer: "second" },
  ]);
  assert.equal(tie.buffer, "first");
});

test("sanitizeComparison validates enums and the 0–10 similarity", async () => {
  const { sanitizeComparison } = await import("../lib/hair-vision.js");
  const ok = sanitizeComparison({ front: "falls_down", forehead: "covered", sides: "over_ears", similarity: 7, extra: 1 });
  assert.deepEqual(ok, { front: "falls_down", forehead: "covered", sides: "over_ears", similarity: 7 });
  assert.equal(sanitizeComparison({ front: "nope", forehead: "covered", sides: "over_ears", similarity: 7 }), null);
  assert.equal(sanitizeComparison({ front: "falls_down", forehead: "covered", sides: "over_ears", similarity: 11 }), null);
  assert.equal(sanitizeComparison({ front: "falls_down", forehead: "covered", sides: "over_ears", similarity: "7" }), null);
  assert.equal(sanitizeComparison(null), null);
});

test("runPreviewContest returns a buffer when both candidates score 0", async () => {
  const vision = {
    describe: async () => ({ ok: true, spec: person }),
  };
  let edits = 0;
  const editor = {
    edit: async () => ({ buffer: Buffer.from(`zero-${edits++}`), mediaType: "image/jpeg" }),
  };
  const result = await runPreviewContest({
    editor,
    vision,
    person: Buffer.from("p"),
    reference: Buffer.from("r"),
    referenceSpec: ref,
  });
  assert.equal(edits, 2);
  assert.equal(result.selectedIndex, 0);
  assert.equal(result.scores.every((s) => s.hairMatch === 0), true);
  assert.equal(result.buffer.toString(), "zero-0");
});
