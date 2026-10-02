import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPARE_FIELDS,
  PASS_MATCH_MIN,
  candidatePasses,
  countHairMatches,
  evaluateCandidate,
  fatalMismatches,
  pickCoreFields,
  runPreviewContest,
  selectPassingCandidate,
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

test("hairMatch counts all compare fields and never exceeds 9", () => {
  assert.equal(COMPARE_FIELDS.length, 9);
  assert.equal(countHairMatches(ref, ref), 9);
  assert.ok(countHairMatches(ref, person) < PASS_MATCH_MIN);
  assert.deepEqual(Object.keys(pickCoreFields(ref)).sort(), [...COMPARE_FIELDS].sort());
});

test("straight short falling bangs vs wavy parted volume is a fatal fail", () => {
  const wavyParted = {
    ...ref,
    front: "parted_curtain",
    forehead: "fully_exposed",
    texture: "s_wave",
    part: "center",
    volume: "voluminous",
    bangs: "curtain",
  };
  const result = evaluateCandidate(ref, person, wavyParted);
  assert.equal(result.pass, false);
  assert.ok(result.fatals.some((f) => f.field === "texture"));
  assert.ok(result.fatals.some((f) => f.field === "front"));
  assert.ok(result.fatals.some((f) => f.field === "part"));
  assert.ok(fatalMismatches(ref, wavyParted).length >= 3);
  assert.equal(candidatePasses(ref, person, wavyParted), false);
});

test("all fields match => hairMatch 9; same as person => changed false", () => {
  const allMatch = evaluateCandidate(ref, person, ref);
  assert.equal(allMatch.hairMatch, 9);
  assert.equal(allMatch.changed, true);
  assert.equal(allMatch.pass, true);
  assert.equal(allMatch.fatals.length, 0);

  const unchanged = evaluateCandidate(ref, person, person);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.pass, false);

  const sameAsSelfie = evaluateCandidate(ref, ref, ref);
  assert.equal(sameAsSelfie.hairMatch, 9);
  assert.equal(sameAsSelfie.changed, false);
  assert.equal(sameAsSelfie.pass, true);
});

test("selectPassingCandidate ignores non-passers even with high match", () => {
  const pick = selectPassingCandidate([
    { index: 0, hairMatch: 8, pass: false, buffer: "a" },
    { index: 1, hairMatch: 7, pass: true, buffer: "b" },
  ]);
  assert.equal(pick.buffer, "b");
  assert.equal(selectPassingCandidate([{ hairMatch: 9, pass: false }]), null);
});

const passCompare = async () => ({
  frontDirection: true, part: true, foreheadExposure: true, texture: true, volume: true,
  silhouette: true, sideLength: true, color: true, identity: true, scene: true,
  uncertain: false, reasons: [], pass: true,
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
    compare: passCompare,
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
  assert.equal(result.selectedIndex, 0);
  assert.equal(result.candidates[0].hairMatch, 9);
  assert.equal(result.candidates[0].changed, true);
});

test("runPreviewContest retries then rejects without fallback", async () => {
  const miss = { ...person };
  let describes = 0;
  const vision = {
    describe: async () => {
      describes += 1;
      if (describes === 1) return { ok: true, spec: person };
      return { ok: true, spec: miss };
    },
    compare: passCompare,
  };
  let edits = 0;
  const editor = {
    edit: async () => ({ buffer: Buffer.from(String(edits++)), mediaType: "image/jpeg" }),
  };
  await assert.rejects(
    () => runPreviewContest({
      editor,
      vision,
      person: Buffer.from("p"),
      reference: Buffer.from("r"),
      referenceSpec: ref,
      features: "Target",
      labDebug: true,
    }),
    (error) => {
      assert.equal(error.code, "no-style-match");
      assert.equal(error.attempts, 2);
      assert.ok(Array.isArray(error.failReasons) && error.failReasons.length);
      assert.ok(Array.isArray(error.candidates));
      return true;
    },
  );
  assert.equal(edits, 4);
});
