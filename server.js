import "dotenv/config";
import express from "express";
import { createDecartClient, noopLogger } from "@decartai/sdk";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readConfig } from "./lib/config.js";
import { DailyQuota } from "./lib/quota.js";
import { GoogleStore } from "./lib/google-store.js";
import { validateLead, validateSession, ValidationError } from "./lib/validation.js";
import { mountBrowserVendor } from "./lib/browser-vendor.js";
import { assetAvailability } from "./lib/assets.js";

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));

export async function createApp({ config = readConfig(), decart, store = new GoogleStore(), now = Date.now, logger = console } = {}) {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);
  const quota = new DailyQuota({ ...config, now });
  const sessions = new Map();
  const client = decart || (config.decartKey ? createDecartClient({ apiKey: config.decartKey, logger: noopLogger }) : null);

  app.use((_req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "Permissions-Policy": "camera=(self), microphone=()" });
    next();
  });
  app.use((req, res, next) => {
    if (req.method === "POST" && ((req.headers.origin && req.headers.origin !== config.origin) || req.headers["sec-fetch-site"] === "cross-site")) return res.status(403).json({ error: "요청 출처를 확인해 주세요." });
    next();
  });
  app.use(express.json({ limit: "3mb", type: ["application/json", "text/plain"] }));
  app.get("/config", async (_req, res) => {
    res.set("Cache-Control", "no-store").json({ mode: config.mode, anchor: config.anchor, lab: config.lab, assets: await assetAvailability(), privacy: { operator: config.operator, retention: config.retention, recipient: config.recipient } });
  });
  app.post("/token", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!client) return res.status(500).json({ error: "연결 준비가 되지 않았어요. 잠시 후 다시 시도해 주세요." });
    const reservation = quota.reserve(req.ip);
    if (reservation.status) return res.status(reservation.status).json({ error: reservation.error });
    try {
      const token = await client.tokens.create({
        expiresIn: 60, allowedModels: ["lucy-2.5"], allowedOrigins: [config.origin],
        constraints: { realtime: { maxSessionDuration: 120 } },
      });
      if (!token.apiKey) throw new Error("TOKEN_MISSING");
      const sessionId = randomUUID();
      for (const [id, record] of sessions) if (now() - record.createdAt > 86400000) sessions.delete(id);
      sessions.set(sessionId, { createdAt: now(), ended: false, lead: null });
      // apiKey here is the short-lived client credential returned by tokens.create().
      res.json({ token: token.apiKey, sessionId });
    } catch {
      reservation.release();
      logger.error("Decart 토큰 발급 실패");
      res.status(500).json({ error: "연결에 실패했어요. 잠시 후 다시 시도해 주세요." });
    }
  });
  const sessionFor = (req) => {
    const id = req.body?.sessionId;
    const record = typeof id === "string" && sessions.get(id);
    if (!record || now() - record.createdAt > 86400000) throw new ValidationError("체험을 다시 시작해 주세요.");
    return { id, record };
  };
  app.post("/leads", async (req, res) => {
    try {
      const lead = validateLead(req.body, now());
      const { id, record } = sessionFor(req);
      if (record.lead) return res.json({ ok: true });
      // A retry/concurrent click shares the in-flight write.
      if (!record.leadPromise) record.leadPromise = store.saveLead(lead, id, now());
      try { record.lead = await record.leadPromise; } finally { record.leadPromise = null; }
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
      logger.error("리드 저장 실패");
      res.status(503).json({ error: "저장하지 못했어요. 입력을 유지한 채 다시 시도해 주세요." });
    }
  });
  app.post("/session-end", (req, res) => {
    try {
      validateSession(req.body);
      const { record } = sessionFor(req);
      if (record.ended) return res.sendStatus(204);
      record.ended = true;
      res.sendStatus(204);
    } catch (error) {
      if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
      throw error;
    }
  });
  app.get(["/lab", "/lab/"], (_req, res) => config.lab ? res.sendFile(`${publicDir}/index.html`) : res.sendStatus(404));
  await mountBrowserVendor(app);
  app.use(express.static(publicDir, { dotfiles: "deny" }));
  app.use((error, _req, res, _next) => {
    if (error.type === "entity.too.large") return res.status(413).json({ error: "이미지 크기가 너무 큽니다." });
    if (error instanceof SyntaxError) return res.status(400).json({ error: "요청 형식을 확인해 주세요." });
    logger.error("요청 처리 실패");
    res.status(500).json({ error: "요청을 처리하지 못했습니다." });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = readConfig();
  const app = await createApp({ config });
  app.listen(config.port, (error) => {
    if (error) { console.error("서버를 열지 못했습니다. 포트 사용 여부와 실행 권한을 확인하세요."); process.exitCode = 1; return; }
    console.log(`모수 시뮬레이터: http://localhost:${config.port}`);
  });
}
