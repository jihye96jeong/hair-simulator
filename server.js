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
import { createHairVision } from "./lib/hair-vision.js";
import { createHairEditor, hairEditorInactiveReasons } from "./lib/hair-editor.js";
import { runPreviewContest } from "./lib/hair-judge.js";
import { buildEditFeatures, buildHairPrompt, describeHairKo, sanitizeHairSpec } from "./public/hairPrompt.js";

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));

const DESCRIBE_MAX_BYTES = 2 * 1024 * 1024;
const PREVIEW_MAX_BYTES = Math.floor(1.2 * 1024 * 1024);

function parseDataImage(image, maxBytes) {
  if (typeof image !== "string") return { status: 400, error: "이미지 형식을 확인해 주세요." };
  const trimmed = image.trim();
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(trimmed);
  if (!match) {
    if (trimmed.startsWith("data:image/")) return { status: 400, error: "JPG, PNG, WebP 이미지만 사용할 수 있습니다." };
    return { status: 400, error: "이미지 형식을 확인해 주세요." };
  }
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) return { status: 400, error: "이미지 형식을 확인해 주세요." };
  if (buffer.length > maxBytes) return { status: 413, error: "이미지 크기가 너무 큽니다." };
  return { buffer, mediaType: match[1] };
}

export async function createApp({
  config = readConfig(),
  decart,
  store = new GoogleStore(),
  now = Date.now,
  logger = console,
  hairVision,
  hairEditor,
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);
  const quota = new DailyQuota({ ...config, now });
  const describeQuota = new DailyQuota({ ipLimit: config.describeIpLimit, totalLimit: config.describeTotalLimit, now });
  const previewQuota = new DailyQuota({ ipLimit: config.previewIpLimit, totalLimit: config.previewTotalLimit, now });
  const sessions = new Map();
  const client = decart || (config.decartKey ? createDecartClient({ apiKey: config.decartKey, logger: noopLogger }) : null);
  const vision = hairVision === undefined
    ? (config.anthropicKey ? createHairVision({ apiKey: config.anthropicKey, model: config.visionModel }) : null)
    : hairVision;
  const editor = hairEditor === undefined
    ? createHairEditor({ provider: config.editProvider, model: config.editModel, apiKey: config.geminiKey })
    : hairEditor;
  if (hairEditor === undefined && !editor) {
    const missing = hairEditorInactiveReasons({ provider: config.editProvider, apiKey: config.geminiKey });
    logger.warn?.(`hair-preview disabled: missing or invalid ${missing.join(", ")}`);
  }

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
    res.set("Cache-Control", "no-store").json({
      mode: config.mode,
      anchor: config.anchor,
      lab: config.lab,
      assets: await assetAvailability(),
      privacy: {
        operator: config.operator,
        retention: config.retention,
        recipient: config.recipient,
        editService: config.editServiceLabel,
        editRegion: config.editServiceRegion,
      },
    });
  });
  app.post("/hair-describe", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!vision) return res.status(503).json({ error: "헤어 분석을 사용할 수 없어요." });
    const parsed = parseDataImage(req.body?.image, DESCRIBE_MAX_BYTES);
    if (parsed.status) return res.status(parsed.status).json({ error: parsed.error });
    const reservation = describeQuota.reserve(req.ip);
    if (reservation.status) return res.status(reservation.status).json({ error: reservation.error });
    try {
      const result = await vision.describe(parsed.buffer, parsed.mediaType);
      if (!result?.ok) {
        logger.info?.("hair-describe", { ok: false });
        return res.status(502).json({ error: "헤어를 분석하지 못했어요. 다른 사진으로 시도해 주세요." });
      }
      if (!result.spec.hairVisible) {
        logger.info?.("hair-describe", { ok: false });
        return res.status(422).json({ error: "헤어가 잘 보이는 사진을 올려 주세요." });
      }
      logger.info?.("hair-describe", { ok: true });
      res.json({ spec: result.spec, prompt: buildHairPrompt(result.spec), summary: describeHairKo(result.spec) });
    } catch {
      reservation.release();
      logger.error("헤어 분석 실패");
      res.status(502).json({ error: "헤어를 분석하지 못했어요. 다른 사진으로 시도해 주세요." });
    }
  });
  function resolveEditModel(requested) {
    const trimmed = typeof requested === "string" ? requested.trim() : "";
    if (!trimmed || trimmed === config.editModel) return { ok: true, model: config.editModel };
    if (!config.editModelAllowlist.includes(trimmed)) return { ok: false };
    return { ok: true, model: trimmed };
  }

  app.post("/hair-preview", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!editor || !vision) return res.status(503).json({ error: "미리보기를 만들 수 없어요." });
    const modelChoice = resolveEditModel(req.body?.editModel);
    if (!modelChoice.ok) return res.status(400).json({ error: "허용되지 않은 편집 모델입니다." });
    const previewEditor = modelChoice.model === config.editModel && editor
      ? editor
      : createHairEditor({ provider: config.editProvider, model: modelChoice.model, apiKey: config.geminiKey });
    if (!previewEditor) return res.status(503).json({ error: "미리보기를 만들 수 없어요." });
    const person = parseDataImage(req.body?.person, PREVIEW_MAX_BYTES);
    if (person.status) return res.status(person.status).json({ error: person.error });
    const reference = parseDataImage(req.body?.reference, PREVIEW_MAX_BYTES);
    if (reference.status) return res.status(reference.status).json({ error: reference.error });
    const sanitized = sanitizeHairSpec(req.body?.spec);
    if (!sanitized.ok || !sanitized.spec.hairVisible) {
      return res.status(400).json({ error: "헤어 정보가 올바르지 않아요." });
    }
    const features = buildEditFeatures(sanitized.spec);
    const reservation = previewQuota.reserve(req.ip);
    if (reservation.status) return res.status(reservation.status).json({ error: reservation.error });
    const started = Date.now();
    try {
      const result = await runPreviewContest({
        editor: previewEditor,
        vision,
        person: person.buffer,
        reference: reference.buffer,
        referenceSpec: sanitized.spec,
        features,
        mediaType: "image/jpeg",
        timeoutMs: 90000,
        labDebug: req.body?.labDebug === true,
      });
      logger.info?.("hair-preview", {
        ok: true,
        ms: result.ms ?? (Date.now() - started),
        scores: result.scores,
        selectedIndex: result.selectedIndex,
      });
      res.json({
        image: `data:${result.mediaType};base64,${result.buffer.toString("base64")}`,
        scores: result.scores,
        selectedIndex: result.selectedIndex,
        candidates: result.candidates,
        reference: result.reference,
        editModel: modelChoice.model,
      });
    } catch (error) {
      reservation.release();
      logger.info?.("hair-preview", {
        ok: false,
        ms: Date.now() - started,
        reason: error?.code || "error",
      });
      logger.error("헤어 미리보기 실패");
      res.status(502).json({ error: "미리보기를 만들지 못했어요. 다시 시도해 주세요." });
    }
  });
  app.post("/token", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!client) return res.status(500).json({ error: "연결 준비가 되지 않았어요. 잠시 후 다시 시도해 주세요." });
    const reservation = quota.reserve(req.ip);
    if (reservation.status) return res.status(reservation.status).json({ error: reservation.error });
    try {
      const token = await client.tokens.create({
        expiresIn: 300, allowedModels: ["lucy-2.5"], allowedOrigins: [config.origin],
        constraints: { realtime: { maxSessionDuration: 120 } },
      });
      if (!token.apiKey) throw new Error("TOKEN_MISSING");
      const sessionId = randomUUID();
      for (const [id, record] of sessions) if (now() - record.createdAt > 86400000) sessions.delete(id);
      sessions.set(sessionId, { createdAt: now(), ended: false, lead: null });
      res.json({ token: token.apiKey, sessionId, expiresAt: token.expiresAt ? new Date(token.expiresAt).toISOString() : undefined });
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
