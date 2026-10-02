import { sanitizeHairSpec } from "../public/hairPrompt.js";

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

/** Highest match wins; ties keep the earlier candidate. */
export function selectBestCandidate(candidates) {
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
    selected: selectedIndex != null && c.index === selectedIndex,
    core: c.core,
    candidate: pickScoreFields(c.candidateSpec),
    image: `data:${c.mediaType};base64,${c.buffer.toString("base64")}`,
  }));
}

/**
 * Generate 2 candidates in parallel, describe each, pick the highest 0–3 score.
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

  if (Date.now() >= deadline) throw new Error("timeout");
  const edits = await Promise.all([
    editor.edit({ person, reference, features, mediaType }),
    editor.edit({ person, reference, features, mediaType }),
  ]);

  const all = await Promise.all(edits.map(async (edit, index) => {
    if (Date.now() >= deadline) throw new Error("timeout");
    const buffer = edit.buffer;
    const outputType = edit.mediaType || "image/jpeg";
    const described = await vision.describe(buffer, outputType);
    if (!described?.ok) throw new Error(PUBLIC_ERROR);
    const candidateSpec = assertSpec(described.spec);
    const hairMatch = countHairMatches(refSpec, candidateSpec);
    const core = buildFieldComparison(refSpec, candidateSpec);
    const entry = { index, buffer, mediaType: outputType, candidateSpec, hairMatch, core };
    scores.push({
      index,
      hairMatch,
      core,
      candidate: pickScoreFields(candidateSpec),
    });
    return entry;
  }));

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
