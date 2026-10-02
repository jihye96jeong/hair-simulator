export function readConfig(env = process.env) {
  const integer = (name, fallback, min = 1, max = 1000000) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 설정이 올바르지 않습니다.`);
    return value;
  };
  const origin = new URL(env.APP_ORIGIN || `http://localhost:${env.PORT || 3000}`).origin;
  const mode = env.SIMULATOR_MODE || "ref";
  const anchor = env.SIMULATOR_ANCHOR || "on";
  if (!["ref", "text"].includes(mode) || !["on", "off"].includes(anchor)) throw new Error("시뮬레이터 설정이 올바르지 않습니다.");
  const editProvider = (env.HAIR_EDIT_PROVIDER || "gemini").toLowerCase();
  return {
    port: integer("PORT", 3000, 1, 65535), origin,
    trustProxy: integer("TRUST_PROXY", 0, 0, 10),
    ipLimit: integer("TOKEN_DAILY_IP_LIMIT", 3), totalLimit: integer("TOKEN_DAILY_TOTAL_LIMIT", 100),
    decartKey: env.DECART_API_KEY || "", mode, anchor, lab: env.ENABLE_LAB !== "false",
    anthropicKey: env.ANTHROPIC_API_KEY || "",
    visionModel: env.HAIR_VISION_MODEL || "claude-haiku-4-5-20251001",
    describeIpLimit: integer("HAIR_DESCRIBE_DAILY_IP_LIMIT", 20),
    describeTotalLimit: integer("HAIR_DESCRIBE_DAILY_TOTAL_LIMIT", 500),
    editProvider,
    editModel: env.HAIR_EDIT_MODEL || "gemini-3-pro-image",
    editModelAllowlist: (env.HAIR_EDIT_MODEL_ALLOWLIST
      || "gemini-3.1-flash-image,gemini-3.1-flash-lite-image,gemini-3-pro-image,gemini-2.5-flash-image")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    geminiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "",
    previewIpLimit: integer("HAIR_PREVIEW_DAILY_IP_LIMIT", 10),
    previewTotalLimit: integer("HAIR_PREVIEW_DAILY_TOTAL_LIMIT", 200),
    operator: env.PRIVACY_OPERATOR || "모수 시뮬레이터 운영자",
    retention: env.PRIVACY_RETENTION || "수집일로부터 30일",
    recipient: env.REFERRAL_RECIPIENT || "소개를 요청한 지역의 제휴 병원",
    editServiceLabel: env.PRIVACY_EDIT_SERVICE || "Google Gemini",
    editServiceRegion: env.PRIVACY_EDIT_REGION || "국외(미국 등)",
  };
}

export function koreaDay(time = Date.now()) {
  return new Date(time + 9 * 3600000).toISOString().slice(0, 10);
}
