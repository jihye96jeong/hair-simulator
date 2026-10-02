import test from "node:test";
import assert from "node:assert/strict";
import {
  CORE_HAIR_FIELDS,
  buildCoreComparison,
  candidatePasses,
  countHairMatches,
  coreFieldsEqual,
  evaluateCandidate,
  isHairChanged,
  pickCoreFields,
  runPreviewContest,
  selectFallbackCandidate,
  selectPassingCandidate,
} from "../lib/hair-judge.js";

const ref = {
  front: "lifted_up",
  forehead: "fully_exposed",
  sides: "above_ears",
  top: "short",
  hairVisible: true,
  length: "short",
  cut: "layered cut",
  bangs: "none",
  part: "none",
  texture: "messy_textured",
  volume: "natural",
  color: "dark brown",
};

const person = {
  ...ref,
  front: "falls_down",
  forehead: "covered",
  sides: "over_ears",
  top: "medium",
};

test("hairMatch is 0-4 over the four core fields only", () => {
  assert.equal(CORE_HAIR_FIELDS.length, 4);
  assert.equal(countHairMatches(ref, ref), 4);
  assert.equal(countHairMatches(ref, person), 0);
  assert.equal(countHairMatches(ref, { ...ref, top: "medium" }), 3);
  assert.ok(countHairMatches(ref, ref) <= 4);
  assert.deepEqual(pickCoreFields(ref), {
    front: "lifted_up",
    forehead: "fully_exposed",
    sides: "above_ears",
    top: "short",
  });
});

test("evaluateCandidate: all four match => hairMatch 4; same as person => changed false", () => {
  const allMatch = evaluateCandidate(ref, person, ref);
  assert.equal(allMatch.hairMatch, 4);
  assert.equal(allMatch.changed, true);
  assert.equal(allMatch.pass, true);

  const unchanged = evaluateCandidate(ref, person, person);
  assert.equal(unchanged.hairMatch, 0);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.pass, false);

  const sameAsSelfie = evaluateCandidate(ref, ref, ref);
  assert.equal(sameAsSelfie.hairMatch, 4);
  assert.equal(sameAsSelfie.changed, false);
  assert.equal(sameAsSelfie.pass, true);
});

test("core field comparison helpers", () => {
  assert.equal(coreFieldsEqual(ref, ref), true);
  assert.equal(isHairChanged(person, ref), true);
  assert.equal(isHairChanged(ref, { ...ref }), false);
  const core = buildCoreComparison(ref, ref, person);
  assert.equal(core.front.match, true);
  assert.equal(core.front.person, "falls_down");
});

test("candidatePasses requires hairMatch>=3 and change vs person unless ref equals person", () => {
  const near = { ...ref, top: "medium" };
  assert.equal(candidatePasses(ref, person, near), true);
  const weak = { ...ref, front: "falls_down", forehead: "covered", sides: "over_ears", top: "medium" };
  assert.equal(countHairMatches(ref, weak), 0);
  assert.equal(candidatePasses(ref, person, weak), false);
  assert.equal(candidatePasses(ref, ref, ref), true);
});

test("selectPassingCandidate and fallback by hairMatch", () => {
  const pick = selectPassingCandidate([
    { index: 0, hairMatch: 3, pass: true, buffer: "a" },
    { index: 1, hairMatch: 4, pass: true, buffer: "b" },
    { index: 2, hairMatch: 4, pass: false, buffer: "c" },
  ]);
  assert.equal(pick.buffer, "b");
  const fallback = selectFallbackCandidate([
    { hairMatch: 2, buffer: "x" },
    { hairMatch: 3, buffer: "y" },
  ]);
  assert.equal(fallback.buffer, "y");
});

test("runPreviewContest describes the cropped person buffer first", async () => {
  const personBuf = Buffer.from("cropped-selfie");
  const described = [];
  const vision = {
    describe: async (buf) => {
      described.push(Buffer.from(buf).toString());
      if (described.length === 1) return { ok: true, spec: person };
      return { ok: true, spec: ref };
    },
  };
  let edits = 0;
  const editor = {
    edit: async () => ({ buffer: Buffer.from(`c${edits++}`), mediaType: "image/jpeg" }),
  };
  const result = await runPreviewContest({
    editor,
    vision,
    person: personBuf,
    reference: Buffer.from("masked-ref"),
    referenceSpec: ref,
    features: "Target",
    labDebug: true,
  });
  assert.equal(described[0], "cropped-selfie");
  assert.equal(described.length, 3);
  assert.deepEqual(result.person, pickCoreFields(person));
  assert.deepEqual(result.reference, pickCoreFields(ref));
  assert.equal(result.selectedIndex, 0);
  assert.equal(result.candidates[0].hairMatch, 4);
  assert.equal(result.candidates[0].changed, true);
});

test("runPreviewContest retries batch and falls back to best hairMatch", async () => {
  const twoMatch = { ...ref, front: "falls_down", top: "medium" };
  let describes = 0;
  const vision = {
    describe: async () => {
      describes += 1;
      if (describes === 1) return { ok: true, spec: person };
      if (describes === 2 || describes === 3) return { ok: true, spec: twoMatch };
      return { ok: true, spec: ref };
    },
  };
  let edits = 0;
  const editor = {
    edit: async () => ({ buffer: Buffer.from(String(edits++)), mediaType: "image/jpeg" }),
  };
  const result = await runPreviewContest({
    editor,
    vision,
    person: Buffer.from("p"),
    reference: Buffer.from("r"),
    referenceSpec: ref,
    features: "Target",
  });
  assert.equal(result.attempts, 2);
  assert.equal(result.selectedIndex, 2);
  assert.equal(evaluateCandidate(ref, person, ref).pass, true);
});
