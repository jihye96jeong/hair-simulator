export const REFERENCE_ENHANCE = false;

/** Lucy prompt when a Gemini preview image is attached (no structured hair-spec sentences). */
export const IMAGE_HAIR_PROMPT = "Apply the exact hairstyle from the reference image, including the direction of the front hair, how much forehead is visible, the side length around the ears, the top length, texture, and color. The hair grows from the person's own scalp and moves naturally with their head. Keep the person's face, eyes, eyebrows, skin, expression, and identity unchanged.";

export const HAIR_LENGTHS = Object.freeze(["buzz", "very_short", "short", "chin", "shoulder", "chest", "long"]);
export const HAIR_BANGS = Object.freeze(["none", "see_through", "full", "side_swept", "curtain"]);
export const HAIR_PARTS = Object.freeze(["none", "center", "side", "slicked_back"]);
export const HAIR_TEXTURES = Object.freeze(["straight", "c_curl", "s_wave", "curly", "permed", "messy_textured"]);
export const HAIR_VOLUMES = Object.freeze(["flat", "natural", "voluminous"]);
export const HAIR_FRONTS = Object.freeze(["lifted_up", "falls_down", "swept_to_side", "parted_curtain"]);
export const HAIR_FOREHEADS = Object.freeze(["fully_exposed", "partly_exposed", "covered"]);
export const HAIR_SIDES = Object.freeze(["above_ears", "half_over_ears", "over_ears"]);
export const HAIR_TOPS = Object.freeze(["very_short", "short", "medium", "long"]);

const PHRASE = /^[a-z][a-z \-]{0,39}$/;

const LENGTH_EN = {
  buzz: "buzz",
  very_short: "very short",
  short: "short",
  chin: "chin-length",
  shoulder: "shoulder-length",
  chest: "chest-length",
  long: "long",
};
const BANGS_EN = {
  see_through: "light see-through bangs",
  full: "full bangs",
  side_swept: "side-swept bangs",
  curtain: "curtain bangs",
};
const PART_EN = {
  center: "a center part",
  side: "a side part",
  slicked_back: "hair slicked back",
};
const TEXTURE_EN = {
  straight: "straight texture",
  c_curl: "soft C curls",
  s_wave: "soft S-shaped waves",
  curly: "curly texture",
  permed: "permed texture",
  messy_textured: "messy textured strands",
};
const VOLUME_EN = {
  flat: "flat",
  natural: "natural",
  voluminous: "voluminous",
};
const FRONT_EN = {
  lifted_up: "Front hair lifted up",
  falls_down: "Front hair falls down",
  swept_to_side: "Front hair swept to the side",
  parted_curtain: "Front hair parted curtain-style",
};
const FOREHEAD_EN = {
  fully_exposed: "forehead fully exposed",
  partly_exposed: "forehead partly exposed",
  covered: "forehead covered",
};
const SIDES_EN = {
  above_ears: "sides above the ears",
  half_over_ears: "sides half over the ears",
  over_ears: "sides over the ears",
};
const TOP_EN = {
  very_short: "very short top",
  short: "short top",
  medium: "medium top",
  long: "long top",
};
const TEXTURE_EDIT_EN = {
  straight: "straight strands",
  c_curl: "soft C-curl strands",
  s_wave: "soft S-wave strands",
  curly: "curly strands",
  permed: "permed strands",
  messy_textured: "messy textured strands",
};

const LENGTH_KO = {
  buzz: "버즈",
  very_short: "아주 짧은",
  short: "짧은",
  chin: "턱 길이",
  shoulder: "어깨 길이",
  chest: "가슴 길이",
  long: "긴",
};
const BANGS_KO = {
  see_through: "시스루뱅",
  full: "풀뱅",
  side_swept: "사이드뱅",
  curtain: "커튼뱅",
};
const PART_KO = {
  center: "가운데 가르마",
  side: "사이드 가르마",
  slicked_back: "올백",
};
const TEXTURE_KO = {
  straight: "직모",
  c_curl: "C컬",
  s_wave: "S컬",
  curly: "컬리",
  permed: "펌",
  messy_textured: "메시 텍스처",
};
const CUT_KO = {
  "layered cut": "레이어드 컷",
  "two-block": "투블럭",
  bob: "보브",
  "wolf cut": "울프컷",
};
const COLOR_KO = {
  "ash brown": "애쉬브라운",
  "jet black": "제트블랙",
  black: "블랙",
  brown: "브라운",
};

export const HAIR_SPEC_TOOL = Object.freeze({
  name: "submit_hair_spec",
  description: "Describe only the hairstyle visible in the photo. Never include identity, face, name, age, or inferred gender.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "hairVisible", "length", "cut", "bangs", "part", "texture", "volume", "color",
      "front", "forehead", "sides", "top",
    ],
    properties: {
      hairVisible: { type: "boolean", description: "False if hair is cropped, covered, or not clearly visible." },
      length: { type: "string", enum: [...HAIR_LENGTHS] },
      cut: { type: "string", description: "Short English phrase such as layered cut or two-block." },
      bangs: { type: "string", enum: [...HAIR_BANGS] },
      part: { type: "string", enum: [...HAIR_PARTS] },
      texture: { type: "string", enum: [...HAIR_TEXTURES] },
      volume: { type: "string", enum: [...HAIR_VOLUMES] },
      color: { type: "string", description: "Short English color phrase such as ash brown." },
      front: { type: "string", enum: [...HAIR_FRONTS], description: "How the front hair sits relative to the face." },
      forehead: { type: "string", enum: [...HAIR_FOREHEADS], description: "How much forehead is visible." },
      sides: { type: "string", enum: [...HAIR_SIDES], description: "Side length relative to the ears." },
      top: { type: "string", enum: [...HAIR_TOPS], description: "Length/volume on top of the head." },
    },
  },
});

export function sanitizeHairSpec(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid-spec" };
  }
  const hairVisible = raw.hairVisible;
  if (typeof hairVisible !== "boolean") return { ok: false, error: "invalid-spec" };
  if (!HAIR_LENGTHS.includes(raw.length)) return { ok: false, error: "invalid-spec" };
  if (!HAIR_BANGS.includes(raw.bangs)) return { ok: false, error: "invalid-spec" };
  if (!HAIR_PARTS.includes(raw.part)) return { ok: false, error: "invalid-spec" };
  if (!HAIR_TEXTURES.includes(raw.texture)) return { ok: false, error: "invalid-spec" };
  if (!HAIR_VOLUMES.includes(raw.volume)) return { ok: false, error: "invalid-spec" };
  if (!HAIR_FRONTS.includes(raw.front)) return { ok: false, error: "invalid-spec" };
  if (!HAIR_FOREHEADS.includes(raw.forehead)) return { ok: false, error: "invalid-spec" };
  if (!HAIR_SIDES.includes(raw.sides)) return { ok: false, error: "invalid-spec" };
  if (!HAIR_TOPS.includes(raw.top)) return { ok: false, error: "invalid-spec" };
  if (typeof raw.cut !== "string" || !PHRASE.test(raw.cut)) return { ok: false, error: "invalid-spec" };
  if (typeof raw.color !== "string" || !PHRASE.test(raw.color)) return { ok: false, error: "invalid-spec" };
  return {
    ok: true,
    spec: {
      hairVisible,
      length: raw.length,
      cut: raw.cut,
      bangs: raw.bangs,
      part: raw.part,
      texture: raw.texture,
      volume: raw.volume,
      color: raw.color,
      front: raw.front,
      forehead: raw.forehead,
      sides: raw.sides,
      top: raw.top,
    },
  };
}

/** One English sentence of edit targets from sanitized enum fields only. */
export function buildEditFeatures(spec) {
  return `${FRONT_EN[spec.front]}, ${FOREHEAD_EN[spec.forehead]}, ${SIDES_EN[spec.sides]}, ${TOP_EN[spec.top]} with ${TEXTURE_EDIT_EN[spec.texture]}, ${spec.color} color.`;
}

export function buildHairPrompt(spec, { withImage = false } = {}) {
  const details = [];
  if (spec.bangs !== "none") details.push(BANGS_EN[spec.bangs]);
  if (spec.part !== "none") details.push(PART_EN[spec.part]);
  details.push(TEXTURE_EN[spec.texture]);
  const body = `Change only the hair to a ${LENGTH_EN[spec.length]} ${spec.cut} with ${details.join(", ")}, ${VOLUME_EN[spec.volume]} volume, ${spec.color} color. The hair grows naturally from the person's own scalp and moves with their head. Keep the person's face, eyes, eyebrows, skin, expression, and identity unchanged.`;
  const prompt = withImage
    ? `Give the person the exact hairstyle shown in the reference image: ${body}`
    : body;
  return prompt;
}

export function describeHairKo(spec) {
  const parts = [
    LENGTH_KO[spec.length],
    CUT_KO[spec.cut] || spec.cut,
    spec.bangs === "none" ? "" : BANGS_KO[spec.bangs],
    spec.part === "none" ? "" : PART_KO[spec.part],
    TEXTURE_KO[spec.texture],
    spec.volume === "natural" ? "" : (spec.volume === "flat" ? "볼륨 적음" : "볼륨 많음"),
    COLOR_KO[spec.color] || spec.color,
  ].filter(Boolean);
  return parts.join(" · ");
}
