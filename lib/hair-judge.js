import { sanitizeHairSpec } from "../public/hairPrompt.js";

const PUBLIC_ERROR = "미리보기를 채점하지 못했어요.";

export const CORE_HAIR_FIELDS = Object.freeze(["front", "forehead", "sides", "top"]);

export function pickCoreFields(spec) {
  const out = {};
  for (const field of CORE_HAIR_FIELDS) out[field] = spec?.[field] ?? null;
  return out;
}

export function countHairMatches(referenceSpec, candidateSpec) {
  let matches = 0;
  for (const field of CORE_HAIR_FIELDS) {
    if (referenceSpec?.[field] != null && referenceSpec[field] === candidateSpec?.[field]) {
      matches += 1;
    }
  }
  return Math.min(CORE_HAIR_FIELDS.length, matches);
}

export function coreFieldsEqual(a, b) {
  return CORE_HAIR_FIELDS.every((field) => a?.[field] === b?.[field]);
}

export function isHairChanged(personSpec, candidateSpec) {
  return CORE_HAIR_FIELDS.some((field) => personSpec?.[field] !== candidateSpec?.[field]);
}

export function buildCoreComparison(referenceSpec, candidateSpec, personSpec = null) {
  const core = {};
  for (const field of CORE_HAIR_FIELDS) {
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
  const hairMatch = countHairMatches(referenceSpec, candidateSpec);
  if (hairMatch < 3) return false;
  if (coreFieldsEqual(referenceSpec, personSpec)) return true;
  return isHairChanged(personSpec, candidateSpec);
}

export function evaluateCandidate(referenceSpec, personSpec, candidateSpec) {
  const hairMatch = countHairMatches(referenceSpec, candidateSpec);
  const changed = isHairChanged(personSpec, candidateSpec);
  return {
    hairMatch,
    changed,
    pass: candidatePasses(referenceSpec, personSpec, candidateSpec),
    core: buildCoreComparison(referenceSpec, candidateSpec, personSpec),
  };
}

/** Prefer pass && highest hairMatch. */
export function selectPassingCandidate(candidates) {
  const pass = candidates.filter((c) => c.pass);
  if (!pass.length) return null;
  return pass.reduce((best, cur) => (cur.hairMatch > best.hairMatch ? cur : best));
}

/** Pick highest hairMatch when no candidate passes. */
export function selectFallbackCandidate(candidates) {
  if (!candidates.length) return null;
  return candidates.reduce((best, cur) => (cur.hairMatch > best.hairMatch ? cur : best));
}

function assertSpec(spec) {
  const sanitized = sanitizeHairSpec(spec);
  if (!sanitized.ok || !sanitized.spec.hairVisible) throw new Error("invalid-spec");
  return sanitized.spec;
}

/**
 * Generate 2 candidates, describe each, optionally regenerate 2 more, then pick.
 * Quota is owned by the caller (one reserve per /hair-preview).
 * Person spec always comes from vision.describe(person) — the cropped selfie buffer.
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
}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  const refSpec = assertSpec(referenceSpec);
  const scores = [];
  let attempts = 0;
  let all = [];

  // Cropped selfie only — never the reference image.
  const personDescribe = await vision.describe(person, mediaType);
  if (!personDescribe?.ok) throw new Error(PUBLIC_ERROR);
  const personSpec = assertSpec(personDescribe.spec);

  async function describeCandidate(buffer, index, attempt) {
    if (Date.now() >= deadline) throw new Error("timeout");
    const described = await vision.describe(buffer, mediaType);
    if (!described?.ok) throw new Error(PUBLIC_ERROR);
    const candidateSpec = assertSpec(described.spec);
    const evaluation = evaluateCandidate(refSpec, personSpec, candidateSpec);
    const entry = {
      index,
      buffer,
      candidateSpec,
      ...evaluation,
    };
    scores.push({
      hairMatch: entry.hairMatch,
      changed: entry.changed,
      pass: entry.pass,
      attempt,
      index: entry.index,
      core: entry.core,
      candidate: pickCoreFields(candidateSpec),
    });
    return entry;
  }

  async function batch(count) {
    if (Date.now() >= deadline) throw new Error("timeout");
    attempts += 1;
    const edits = await Promise.all(
      Array.from({ length: count }, () => editor.edit({ person, reference, features, mediaType })),
    );
    const scored = await Promise.all(
      edits.map((edit, offset) => describeCandidate(edit.buffer, all.length + offset, attempts)),
    );
    all = all.concat(scored);
    return scored;
  }

  await batch(2);
  let selected = selectPassingCandidate(all);
  if (!selected) {
    await batch(2);
    selected = selectPassingCandidate(all) || selectFallbackCandidate(all);
  }
  if (!selected) throw new Error(PUBLIC_ERROR);

  const candidates = labDebug
    ? all.map((c) => ({
      index: c.index,
      hairMatch: c.hairMatch,
      changed: c.changed,
      pass: c.pass,
      selected: c.index === selected.index,
      core: c.core,
      candidate: pickCoreFields(c.candidateSpec),
      image: `data:image/jpeg;base64,${c.buffer.toString("base64")}`,
    }))
    : undefined;

  return {
    buffer: selected.buffer,
    mediaType: "image/jpeg",
    scores,
    attempts,
    selectedIndex: selected.index,
    candidates,
    reference: pickCoreFields(refSpec),
    person: pickCoreFields(personSpec),
    ms: Date.now() - started,
  };
}
