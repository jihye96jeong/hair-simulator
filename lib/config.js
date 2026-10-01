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
  return {
    port: integer("PORT", 3000, 1, 65535), origin,
    trustProxy: integer("TRUST_PROXY", 0, 0, 10),
    ipLimit: integer("TOKEN_DAILY_IP_LIMIT", 3), totalLimit: integer("TOKEN_DAILY_TOTAL_LIMIT", 100),
    decartKey: env.DECART_API_KEY || "", mode, anchor, lab: env.ENABLE_LAB !== "false",
    operator: env.PRIVACY_OPERATOR || "모수 시뮬레이터 운영자",
    retention: env.PRIVACY_RETENTION || "수집일로부터 30일",
    recipient: env.REFERRAL_RECIPIENT || "소개를 요청한 지역의 제휴 병원",
  };
}

export function koreaDay(time = Date.now()) {
  return new Date(time + 9 * 3600000).toISOString().slice(0, 10);
}
