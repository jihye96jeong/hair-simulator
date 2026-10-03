import { sanitizeHairSpec } from "../public/hairPrompt.js";
import { aspectRatioForLength } from "../public/selfie.js";

const PUBLIC_ERROR = "미리보기를 채점하지 못했어요.";

/** Score fields for candidate selection (0–3). */
export const SCORE_FIELDS = Object.freeze(["front", "forehead", "sides"]);

export function pickScoreFields(spec) {
  const out = {};
  for (const field of SCORE_FIELDS) out[field] = spec?.[field] ?? null;
  return out;
}

export function countHairMatches(referenceSpec, candidateSpec) {
  let matches = 0;
  for (const field of SCORE_FIELDS) {
    if (referenceSpec?.[field] != null && referenceSpec[field] === candidateSpec?.[field]) {
      matches += 1;
    }
  }
  return Math.min(SCORE_FIELDS.length, matches);
}

export function buildFieldComparison(referenceSpec, candidateSpec) {
  const core = {};
  for (const field of SCORE_FIELDS) {
    const ref = referenceSpec?.[field] ?? null;
    const cand = candidateSpec?.[field] ?? null;
    core[field] = { ref, cand, match: ref != null && ref === cand };
  }
  return core;
}

/** Highest similarity (when scored) wins, then highest field match; ties keep the earlier candidate. */
export function selectBestCandidate(candidates) {
  if (!candidates.length) return null;
  return candidates.reduce((best, cur) => {
    const bestSim = best.similarity ?? -1;
    const curSim = cur.similarity ?? -1;
    if (curSim !== bestSim) return curSim > bestSim ? cur : best;
    return cur.hairMatch > best.hairMatch ? cur : best;
  });
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
    similarity: c.similarity ?? null,
    selected: selectedIndex != null && c.index === selectedIndex,
    core: c.core,
    candidate: pickScoreFields(c.candidateSpec),
    image: `data:${c.mediaType};base64,${c.buffer.toString("base64")}`,
  }));
}

/** One vision call that sees the reference next to every candidate. */
async function scoreByComparison({ vision, reference, mediaType, refSpec, edits }) {
  const compared = await vision.compare({
    reference,
    referenceMediaType: mediaType,
    candidates: edits.map((edit) => ({ buffer: edit.buffer, mediaType: edit.mediaType || "image/jpeg" })),
  });
  if (!compared?.ok || compared.scores.length !== edits.length) throw new Error(PUBLIC_ERROR);
  return edits.map((edit, index) => {
    const score = compared.scores[index];
    const candidateSpec = pickScoreFields(score);
    return {
      index,
      buffer: edit.buffer,
      mediaType: edit.mediaType || "image/jpeg",
      candidateSpec,
      similarity: score.similarity,
      hairMatch: countHairMatches(refSpec, candidateSpec),
      core: buildFieldComparison(refSpec, candidateSpec),
    };
  });
}

/** Fallback: describe each candidate on its own and match the fields to the reference spec. */
async function scoreByDescription({ vision, refSpec, edits, deadline }) {
  return Promise.all(edits.map(async (edit, index) => {
    if (Date.now() >= deadline) throw new Error("timeout");
    const outputType = edit.mediaType || "image/jpeg";
    const described = await vision.describe(edit.buffer, outputType);
    if (!described?.ok) throw new Error(PUBLIC_ERROR);
    const candidateSpec = assertSpec(described.spec);
    return {
      index,
      buffer: edit.buffer,
      mediaType: outputType,
      candidateSpec,
      similarity: null,
      hairMatch: countHairMatches(refSpec, candidateSpec),
      core: buildFieldComparison(refSpec, candidateSpec),
    };
  }));
}

/**
 * Generate 2 candidates in parallel, score them against the reference image
 * (`vision.compare`, falling back to per-candidate `describe`), pick the best.
 */
export async function runPreviewContest({
  editor,
  vision,
  person,
  reference,
  referenceSpec,
  identity,
  angle,
  mediaType = "image/jpeg",
  identityMediaType = "image/jpeg",
  angleMediaType = "image/jpeg",
  timeoutMs = 90000,
  labDebug = false,
}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  const refSpec = assertSpec(referenceSpec);
  const scores = [];
  const aspectRatio = aspectRatioForLength(refSpec.length);

  if (Date.now() >= deadline) throw new Error("timeout");
  const edits = await Promise.all([
    editor.edit({ person, reference, identity, angle, mediaType, identityMediaType, angleMediaType, aspectRatio }),
    editor.edit({ person, reference, identity, angle, mediaType, identityMediaType, angleMediaType, aspectRatio }),
  ]);

  if (Date.now() >= deadline) throw new Error("timeout");
  const all = typeof vision.compare === "function"
    ? await scoreByComparison({ vision, reference, mediaType, refSpec, edits })
    : await scoreByDescription({ vision, refSpec, edits, deadline });
  for (const entry of all) {
    scores.push({
      index: entry.index,
      hairMatch: entry.hairMatch,
      similarity: entry.similarity,
      core: entry.core,
      candidate: pickScoreFields(entry.candidateSpec),
    });
  }

  const selected = selectBestCandidate(all);
  if (!selected) throw new Error(PUBLIC_ERROR);

  return {
    buffer: selected.buffer,
    mediaType: selected.mediaType,
    scores,
    selectedIndex: selected.index,
    candidates: labDebug ? labCandidates(all, selected.index) : undefined,
    reference: pickScoreFields(refSpec),
    ms: Date.now() - started,
  };
}
