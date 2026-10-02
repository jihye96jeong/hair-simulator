import { sanitizeHairSpec } from "../public/hairPrompt.js";
import sharp from "sharp";

const PUBLIC_ERROR = "미리보기를 채점하지 못했어요.";

/** Preserve exact decoded selfie pixels outside the locally prepared hair edit region. */
export async function preserveOutsideHair({ person, candidate, editMask }) {
  const source = await sharp(person, { limitInputPixels: 4194304 }).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = source.info;
  const maskMeta = await sharp(editMask, { limitInputPixels: 4194304 }).metadata();
  const candidateMeta = await sharp(candidate, { limitInputPixels: 4194304 }).metadata();
  if (maskMeta.width !== width || maskMeta.height !== height
    || Math.abs(candidateMeta.width / candidateMeta.height - width / height) > 0.025) throw new Error("edit-coordinate-mismatch");
  const edited = await sharp(candidate).resize(width, height, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const mask = await sharp(editMask).removeAlpha().greyscale().raw().toBuffer();
  const output = Buffer.from(source.data);
  for (let i = 0; i < mask.length; i++) {
    const alpha = mask[i] / 255;
    for (let c = 0; c < channels; c++) output[i * channels + c] = Math.round(edited[i * channels + c] * alpha + output[i * channels + c] * (1 - alpha));
  }
  return sharp(output, { raw: { width, height, channels } }).png().toBuffer();
}

/** Exact-match score fields (0–N). Fatal groups are separate and cannot be offset by this count. */
export const COMPARE_FIELDS = Object.freeze([
  "front", "forehead", "sides", "top", "texture", "bangs", "part", "volume", "length",
]);

/** @deprecated Use COMPARE_FIELDS. Kept for existing imports. */
export const CORE_HAIR_FIELDS = COMPARE_FIELDS;

export const PASS_MATCH_MIN = 6;

const TEXTURE_GROUP = Object.freeze({
  straight: "straight",
  messy_textured: "messy",
  c_curl: "wavy",
  s_wave: "wavy",
  curly: "curly",
  permed: "curly",
});

const FRONT_GROUP = Object.freeze({
  falls_down: "down",
  lifted_up: "up",
  swept_to_side: "side",
  parted_curtain: "parted",
});

const LENGTH_RANK = Object.freeze({
  buzz: 0, very_short: 1, short: 2, chin: 3, shoulder: 4, chest: 5, long: 6,
});

const TOP_RANK = Object.freeze({
  very_short: 0, short: 1, medium: 2, long: 3,
});

const SIDE_RANK = Object.freeze({
  above_ears: 0, half_over_ears: 1, over_ears: 2,
});

export function pickCoreFields(spec) {
  const out = {};
  for (const field of COMPARE_FIELDS) out[field] = spec?.[field] ?? null;
  return out;
}

export function countHairMatches(referenceSpec, candidateSpec) {
  let matches = 0;
  for (const field of COMPARE_FIELDS) {
    if (referenceSpec?.[field] != null && referenceSpec[field] === candidateSpec?.[field]) {
      matches += 1;
    }
  }
  return Math.min(COMPARE_FIELDS.length, matches);
}

export function coreFieldsEqual(a, b) {
  return COMPARE_FIELDS.every((field) => a?.[field] === b?.[field]);
}

export function isHairChanged(personSpec, candidateSpec) {
  return COMPARE_FIELDS.some((field) => personSpec?.[field] !== candidateSpec?.[field]);
}

export function fatalMismatches(referenceSpec, candidateSpec) {
  const fails = [];
  const add = (field, reason) => fails.push({
    field,
    ref: referenceSpec?.[field] ?? null,
    cand: candidateSpec?.[field] ?? null,
    reason,
  });

  if (TEXTURE_GROUP[referenceSpec.texture] !== TEXTURE_GROUP[candidateSpec.texture]) {
    add("texture", "texture-family");
  }
  if (FRONT_GROUP[referenceSpec.front] !== FRONT_GROUP[candidateSpec.front]) {
    add("front", "front-direction");
  }
  if (referenceSpec.part !== candidateSpec.part) add("part", "part");
  if (referenceSpec.bangs !== candidateSpec.bangs) add("bangs", "bangs");
  if (referenceSpec.volume !== candidateSpec.volume) add("volume", "volume");
  if (referenceSpec.forehead !== candidateSpec.forehead) add("forehead", "forehead");
  const lengthGap = Math.abs(
    (LENGTH_RANK[referenceSpec.length] ?? 0) - (LENGTH_RANK[candidateSpec.length] ?? 0),
  );
  if (lengthGap >= 2) add("length", "length-gap");
  const topGap = Math.abs(
    (TOP_RANK[referenceSpec.top] ?? 0) - (TOP_RANK[candidateSpec.top] ?? 0),
  );
  if (topGap >= 2) add("top", "top-gap");
  const sideGap = Math.abs(
    (SIDE_RANK[referenceSpec.sides] ?? 0) - (SIDE_RANK[candidateSpec.sides] ?? 0),
  );
  if (sideGap >= 2) add("sides", "sides-gap");
  return fails;
}

export function buildCoreComparison(referenceSpec, candidateSpec, personSpec = null) {
  const core = {};
  for (const field of COMPARE_FIELDS) {
    core[field] = {
      ref: referenceSpec?.[field] ?? null,
      person: personSpec ? (personSpec[field] ?? null) : undefined,
      cand: candidateSpec?.[field] ?? null,
      match: referenceSpec?.[field] != null && referenceSpec[field] === candidateSpec?.[field],
    };
  }
  return core;
}

export function candidatePasses(referenceSpec, personSpec, candidateSpec) {
  if (fatalMismatches(referenceSpec, candidateSpec).length) return false;
  if (countHairMatches(referenceSpec, candidateSpec) < PASS_MATCH_MIN) return false;
  if (coreFieldsEqual(referenceSpec, personSpec)) return true;
  return isHairChanged(personSpec, candidateSpec);
}

export function evaluateCandidate(referenceSpec, personSpec, candidateSpec) {
  const hairMatch = countHairMatches(referenceSpec, candidateSpec);
  const changed = isHairChanged(personSpec, candidateSpec);
  const fatals = fatalMismatches(referenceSpec, candidateSpec);
  return {
    hairMatch,
    changed,
    fatals,
    pass: candidatePasses(referenceSpec, personSpec, candidateSpec),
    core: buildCoreComparison(referenceSpec, candidateSpec, personSpec),
  };
}

export function selectPassingCandidate(candidates) {
  const pass = candidates.filter((c) => c.pass);
  if (!pass.length) return null;
  return pass.reduce((best, cur) => (cur.hairMatch > best.hairMatch ? cur : best));
}

/** Unused by contest — kept so tests can assert we no longer send this pick to Lucy. */
export function selectFallbackCandidate(candidates) {
  if (!candidates.length) return null;
  return candidates.reduce((best, cur) => (cur.hairMatch > best.hairMatch ? cur : best));
}

function assertSpec(spec) {
  const sanitized = sanitizeHairSpec(spec);
  if (!sanitized.ok || !sanitized.spec.hairVisible) throw new Error("invalid-spec");
  return sanitized.spec;
}

function labCandidates(all, selectedIndex = null) {
  return all.map((c) => ({
    index: c.index,
    hairMatch: c.hairMatch,
    changed: c.changed,
    pass: c.pass,
    fatals: c.fatals,
    selected: selectedIndex != null && c.index === selectedIndex,
    core: c.core,
    candidate: pickCoreFields(c.candidateSpec),
    visual: c.visual,
    route: c.route,
    attempt: c.attempt,
    rawImage: `data:image/jpeg;base64,${c.rawBuffer.toString("base64")}`,
    image: `data:${c.mediaType};base64,${c.buffer.toString("base64")}`,
  }));
}

function throwNoMatch({ all, scores, attempts, refSpec, personSpec, labDebug }) {
  const error = new Error("no-style-match");
  error.code = "no-style-match";
  error.failReasons = all.flatMap((c) => (
    c.fatals.length
      ? c.fatals.map((f) => `#${c.index} ${f.field}: ${f.ref}≠${f.cand}`)
      : [`#${c.index} match=${c.hairMatch}/${COMPARE_FIELDS.length}`]
  ));
  error.scores = scores;
  error.attempts = attempts;
  error.reference = pickCoreFields(refSpec);
  error.person = pickCoreFields(personSpec);
  if (labDebug) error.candidates = labCandidates(all, null);
  throw error;
}

/**
 * Generate 2 candidates, describe each, optionally regenerate 2 more, then pick a passer only.
 */
export async function runPreviewContest({
  editor,
  vision,
  person,
  reference,
  referenceSpec,
  features,
  mediaType = "image/jpeg",
  timeoutMs = 90000,
  labDebug = false,
  guide,
  hairOnly,
  editMask,
  referenceMediaType = mediaType,
}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  const refSpec = assertSpec(referenceSpec);
  const scores = [];
  let attempts = 0;
  let all = [];

  const personDescribe = await vision.describe(person, mediaType);
  if (!personDescribe?.ok) throw new Error(PUBLIC_ERROR);
  const personSpec = assertSpec(personDescribe.spec);

  async function describeCandidate(edit, index, attempt, route) {
    if (Date.now() >= deadline) throw new Error("timeout");
    const rawBuffer = edit.buffer;
    const buffer = editMask ? await preserveOutsideHair({ person, candidate: rawBuffer, editMask }) : rawBuffer;
    const outputType = editMask ? "image/png" : (edit.mediaType || "image/jpeg");
    const described = await vision.describe(buffer, outputType);
    if (!described?.ok) throw new Error(PUBLIC_ERROR);
    const candidateSpec = assertSpec(described.spec);
    const evaluation = evaluateCandidate(refSpec, personSpec, candidateSpec);
    // Compare the actual final image, including preservation, not independent labels alone.
    const visual = await vision.compare({ person, reference, candidate: buffer,
      personMediaType: mediaType, referenceMediaType, candidateMediaType: outputType });
    if (!visual.pass) {
      evaluation.pass = false;
      evaluation.fatals.push({ field: "visual", reason: "image-comparison", ref: "match", cand: "mismatch-or-uncertain" });
    }
    const entry = {
      index, attempt, route, rawBuffer, visual, mediaType: outputType,
      buffer,
      candidateSpec,
      ...evaluation,
    };
    scores.push({
      hairMatch: entry.hairMatch,
      changed: entry.changed,
      pass: entry.pass,
      fatals: entry.fatals,
      attempt,
      index: entry.index,
      core: entry.core,
      candidate: pickCoreFields(candidateSpec),
      visual, route,
    });
    return entry;
  }

  async function batch(count, guided) {
    if (Date.now() >= deadline) throw new Error("timeout");
    attempts += 1;
    const edits = await Promise.all(
      Array.from({ length: count }, () => editor.edit({ person, reference, features, mediaType, referenceMediaType,
        guide: guided ? guide : undefined, hairOnly, editMask })),
    );
    const scored = await Promise.all(
      edits.map((edit, offset) => describeCandidate(edit, all.length + offset, attempts, guided ? "aligned-guide" : "reference-images")),
    );
    all = all.concat(scored);
    return scored;
  }

  await batch(2, Boolean(guide));
  let selected = selectPassingCandidate(all);
  if (!selected) {
    // A misleading visual guide must not lock every retry into the same bad shape.
    await batch(2, false);
    selected = selectPassingCandidate(all);
  }
  if (!selected) {
    throwNoMatch({ all, scores, attempts, refSpec, personSpec, labDebug });
  }

  return {
    buffer: selected.buffer,
    mediaType: selected.mediaType,
    scores,
    attempts,
    selectedIndex: selected.index,
    candidates: labDebug ? labCandidates(all, selected.index) : undefined,
    reference: pickCoreFields(refSpec),
    person: pickCoreFields(personSpec),
    ms: Date.now() - started,
  };
}
