import { CAP_SECONDS } from "./shared.js";
import {
  GRAFT_AREAS,
  GRAFT_LEVELS,
  chipLabel,
  comboKeyFor,
  densityKeyForGrafts,
  promptForArea,
  ruleFor,
} from "./graftRules.js";
import { captureGraftStill, streamTrackStates } from "./graftCapture.js";
import { buildGraftMask, buildPrefillGuide } from "./graftGuide.js";
import { prefillBaseline } from "./baselinePrefill.js";
import { RealtimeSession } from "./session.js";
import { openFrontCamera, stopMediaStream } from "./camera.js";
import {
  assertBaselineForeheadGain,
  blockMediaPipe,
  closeMediaPipe,
  foreheadExposeCm,
  unblockMediaPipe,
} from "./faceGeometry.js";
import { normalizeLucyJpeg } from "./lucyImage.js";

function labSdkLogger(sdk) {
  const base = typeof sdk.createConsoleLogger === "function"
    ? sdk.createConsoleLogger("info")
    : {
      debug: (message, data) => console.debug(message, data),
      info: (message, data) => console.info(message, data),
      warn: (message, data) => console.warn(message, data),
      error: (message, data) => console.error(message, data),
    };
  const scrubValue = (value) => {
    if (typeof value !== "string") return value;
    return value
      .replace(/api_key=[^&\s"']+/gi, "api_key=[redacted]")
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[token]");
  };
  const scrubData = (data) => {
    if (!data || typeof data !== "object") return data;
    const out = Array.isArray(data) ? [...data] : { ...data };
    for (const key of Object.keys(out)) {
      if (/token|api[_-]?key|authorization|secret/i.test(key)) out[key] = "[redacted]";
      else if (typeof out[key] === "string") out[key] = scrubValue(out[key]);
      else if (out[key] && typeof out[key] === "object") out[key] = scrubData(out[key]);
    }
    return out;
  };
  return {
    debug: (message, data) => base.debug(scrubValue(message), data == null ? data : scrubData(data)),
    info: (message, data) => base.info(scrubValue(message), data == null ? data : scrubData(data)),
    warn: (message, data) => base.warn(scrubValue(message), data == null ? data : scrubData(data)),
    error: (message, data) => base.error(scrubValue(message), data == null ? data : scrubData(data)),
  };
}

const $ = (id) => document.getElementById(id);

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("encode"));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("bad-data-url");
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] });
}

async function canvasToJpeg(canvas, quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("frame-encode"))), "image/jpeg", quality);
  });
}

function imageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image-load"));
    };
    img.src = url;
  });
}

export function createGraftFlow({
  isActive,
  reportEnd,
  onGlobalError,
  getAnchor = () => "on",
  getEnhance = () => false,
  getEditModel = () => "",
  getTestMode = () => false,
  getBaselineMode = () => "refined",
  getFillMode = () => "refined",
  isLab = false,
}) {
  let area = "hairline";
  let grafts = 2000;
  let session = null;
  let camera = null;
  let cameraEpoch = 0;
  let connecting = false;
  let switching = false;
  let screen = "idle";
  let holdBaseline = false;
  let selectionTouched = false;
  let captureBlob = null;
  let baselineFront = null; // { blob, meta, bundle }
  let baselineCrown = null;
  let guideCache = new Map(); // mask entries
  let fillCache = new Map(); // comboKey → { status, blob, meta, maskBlob, stats, error, prefillBlob }
  let captureExposeCm = null;
  let captureMeasure = null;
  let baselineExposeCm = null;
  let baldMaskBlob = null;
  let prefillBaselineBlob = null;
  let labTimings = { prefillMs: null, refineMs: null, fills: {} };
  let tokenPayload = null;
  let labDebug = null;
  let countdownTimer = null;
  let pendingCapture = null; // "front" | "crown"
  let lastBaselineError = null;
  let lucyBaselineBlob = null; // normalized JPEG for Lucy only

  function testMode() {
    return Boolean(isLab && getTestMode());
  }

  function baselineMode() {
    const m = getBaselineMode?.() || "refined";
    return m === "prefill" ? "prefill" : "refined";
  }

  function fillMode() {
    const m = getFillMode?.() || "refined";
    return m === "prefill" ? "prefill" : "refined";
  }

  function setError(message) {
    onGlobalError(message);
  }

  function enhanceFlag() {
    return Boolean(getEnhance());
  }

  function activeBaseline() {
    return area === "crown" && baselineCrown ? baselineCrown : baselineFront;
  }

  function showIdleStage() {
    $("stage-label").hidden = false;
    $("stage-label").textContent = "촬영 시작을 눌러 정면을 찍으세요";
    $("output").hidden = true;
    $("combo-label").hidden = true;
    $("remaining").hidden = true;
    $("graft-hold-baseline")?.classList.add("is-hidden");
    $("graft-capture-layer").hidden = true;
    $("graft-baseline-banner")?.setAttribute("hidden", "");
    clearCountdown();
  }

  function clearCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    if ($("graft-countdown")) $("graft-countdown").hidden = true;
  }

  function updateChip() {
    const el = $("combo-label");
    if (!el) return;
    if (screen !== "live") {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    if (holdBaseline || (!selectionTouched && session?.combo === "baseline")) {
      el.textContent = "시술 전";
      return;
    }
    const fill = fillCache.get(comboKeyFor(area, grafts));
    if (!fill || fill.status === "pending") {
      el.textContent = "준비 중";
      return;
    }
    if (fill.status === "error") {
      el.textContent = "채움 실패";
      return;
    }
    const rule = ruleFor(area, grafts);
    el.textContent = chipLabel(area, grafts, rule.sizeCm);
  }

  function updateButtons() {
    for (const btn of document.querySelectorAll("[data-graft-area]")) {
      const value = btn.getAttribute("data-graft-area");
      btn.setAttribute("aria-pressed", value === area ? "true" : "false");
      btn.classList.toggle("selected", value === area);
      const small = btn.querySelector("small");
      const hints = { mline: "이마 모서리", hairline: "이마선 전체", crown: "고개 숙여 확인" };
      if (small) small.textContent = hints[value];
      btn.disabled = connecting || switching || screen !== "live";
    }
    for (const btn of document.querySelectorAll("[data-graft-level]")) {
      const value = Number(btn.getAttribute("data-graft-level"));
      btn.setAttribute("aria-pressed", value === grafts ? "true" : "false");
      btn.classList.toggle("selected", value === grafts);
      btn.disabled = connecting || switching || screen !== "live";
    }
    const live = screen === "live" && session && !session.stopped;
    $("connect").disabled = connecting || live || screen === "capture";
    $("disconnect").disabled = screen === "idle" && !connecting;
    $("preset-bar").hidden = !(isActive() && screen === "live");
    $("product-actions").hidden = !(isActive() && live);
    const video = $("output");
    const frameReady = live && video && video.srcObject
      && (video.readyState >= 2 || video.videoWidth > 0);
    for (const id of ["save-result", "referral", "lab-capture"]) {
      const el = $(id);
      if (el) el.disabled = !frameReady || connecting || switching;
    }
    $("lab-actions").hidden = !(isLab && isActive() && live);
    if ($("graft-hold-baseline")) {
      $("graft-hold-baseline").classList.toggle("is-hidden", !live);
    }
    updateChip();
  }

  function stopCamera() {
    cameraEpoch += 1;
    stopMediaStream(camera);
    camera = null;
    clearCountdown();
  }

  function resetAll() {
    if (session && !session.stopped) session.stop("manual");
    session = null;
    connecting = false;
    switching = false;
    stopCamera();
    $("output").srcObject = null;
    captureBlob = null;
    baselineFront = null;
    baselineCrown = null;
    lucyBaselineBlob = null;
    guideCache = new Map();
    fillCache = new Map();
    captureExposeCm = null;
    captureMeasure = null;
    baselineExposeCm = null;
    baldMaskBlob = null;
    prefillBaselineBlob = null;
    labTimings = { prefillMs: null, refineMs: null, fills: {} };
    tokenPayload = null;
    pendingCapture = null;
    lastBaselineError = null;
    holdBaseline = false;
    selectionTouched = false;
    screen = "idle";
    showIdleStage();
    updateButtons();
    updateLab();
  }

  async function ensureCamera() {
    if (camera) return camera;
    const sdk = await import("@decartai/sdk");
    const model = sdk.models.realtime("lucy-2.5");
    camera = await openFrontCamera(model);
    return camera;
  }

  async function runCountdown(seconds = 3) {
    const ms = typeof window.__testGraftCountdownMs === "number" ? window.__testGraftCountdownMs : 1000;
    const el = $("graft-countdown");
    el.hidden = false;
    for (let n = seconds; n >= 1; n--) {
      el.textContent = String(n);
      await new Promise((r) => {
        countdownTimer = setTimeout(r, ms);
      });
      countdownTimer = null;
    }
    el.hidden = true;
  }

  async function captureFromVideo({ pose = "front" } = {}) {
    unblockMediaPipe();
    const local = $("graft-local-video");
    local.srcObject = camera;
    local.style.transform = "scaleX(-1)";
    await local.play().catch(() => undefined);
    setCaptureGuide(pose);
    $("graft-capture-layer").hidden = false;
    $("stage-label").hidden = true;
    await runCountdown(3);
    const skipForehead = testMode() || pose === "crown";
    // Frame copy only — never stop/replace camera tracks (unlike selfie.js).
    const measured = await captureGraftStill(local, {
      pose,
      samples: 5,
      intervalMs: 40,
      skipForeheadCheck: skipForehead,
    });
    const blob = await canvasToJpeg(measured.frameCanvas);
    return { blob, measured, pose };
  }

  function setCaptureGuide(pose) {
    $("graft-guide-front").hidden = pose !== "front";
    $("graft-guide-left").hidden = true;
    $("graft-guide-right").hidden = true;
    $("graft-guide-crown").hidden = pose !== "crown";
    $("graft-capture-hint").textContent = pose === "crown"
      ? "고개를 숙여 정수리가 보이게 해주세요"
      : "정면을 바라봐 주세요";
    $("graft-capture-warn").hidden = true;
  }

  async function requestBaseline(prefillBlob, maskBlob, pose = "front") {
    $("status").textContent = "시술 전 모습을 만드는 중…";
    showBaselineBanner(false);
    const response = await fetch("/baseline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        person: await blobToDataUrl(prefillBlob),
        mask: await blobToDataUrl(maskBlob),
        pose,
        ...(getEditModel() ? { editModel: getEditModel() } : {}),
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || "시술 전 이미지를 만들지 못했어요");
      error.code = "baseline-fail";
      throw error;
    }
    return {
      blob: dataUrlToBlob(body.image),
      meta: body,
    };
  }

  async function measureBaselineBlob(blob, { pose = "front" } = {}) {
    const img = await imageFromBlob(blob);
    // Measure a still image — no live MediaStream involved.
    const { measureFrame } = await import("./faceGeometry.js");
    return measureFrame(img, {
      pose,
      skipForeheadCheck: testMode() || pose === "crown",
    });
  }

  function showBaselineBanner(on, message = "") {
    const banner = $("graft-baseline-banner");
    if (!banner) return;
    if (!on) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    $("graft-baseline-message").textContent = message || "시술 전 이미지를 만들지 못했어요";
  }

  async function buildAndCacheMask(a, g) {
    const key = comboKeyFor(a, g);
    if (guideCache.has(key) && guideCache.get(key).maskBlob) return guideCache.get(key);
    const base = a === "crown" ? baselineCrown : baselineFront;
    if (!base?.bundle) throw new Error("기준선이 없어요");
    const built = await buildGraftMask({
      measure: base.bundle.measure,
      area: a,
      grafts: g,
    });
    const prefill = await buildPrefillGuide({
      imageData: base.bundle.imageData,
      measure: base.bundle.measure,
      area: a,
      grafts: g,
      fillMask: built.fillMask,
    });
    const entry = {
      blob: built.mask,
      maskBlob: built.mask,
      prefillBlob: prefill.prefillGuide,
      stats: { ...built.stats, prefill: prefill.stats },
      area: a,
      grafts: g,
    };
    guideCache.set(key, entry);
    updateLab();
    return entry;
  }

  async function requestGraftFill(a, g) {
    const key = comboKeyFor(a, g);
    const existing = fillCache.get(key);
    if (existing && (existing.status === "ready" || existing.status === "pending")) {
      return existing;
    }
    const base = a === "crown" ? baselineCrown : baselineFront;
    if (!base?.blob) throw new Error("기준선이 없어요");
    const maskEntry = await buildAndCacheMask(a, g);
    const rule = ruleFor(a, g);
    const entry = {
      status: "pending",
      blob: null,
      prefillBlob: maskEntry.prefillBlob,
      meta: null,
      maskBlob: maskEntry.maskBlob,
      stats: maskEntry.stats,
      error: null,
      area: a,
      grafts: g,
    };
    fillCache.set(key, entry);
    updateChip();
    updateLab();
    const fillStarted = Date.now();
    try {
      if (fillMode() === "prefill") {
        entry.status = "ready";
        entry.blob = maskEntry.prefillBlob;
        entry.meta = {
          ms: Date.now() - fillStarted,
          estimatedCostUsd: 0,
          model: "prefill",
          densityLabel: rule.density <= 0.7 ? "sparse" : rule.density <= 0.85 ? "medium" : "dense",
          refined: false,
        };
        labTimings.fills[key] = entry.meta.ms;
        fillCache.set(key, entry);
        updateLab();
        updateChip();
        return entry;
      }
      const response = await fetch("/graft-fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          person: await blobToDataUrl(maskEntry.prefillBlob),
          mask: await blobToDataUrl(maskEntry.maskBlob),
          area: a,
          grafts: g,
          density: rule.density,
          ...(getEditModel() ? { editModel: getEditModel() } : {}),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        // Gemini fail → use prefillGuide
        entry.status = "ready";
        entry.blob = maskEntry.prefillBlob;
        entry.meta = {
          ms: Date.now() - fillStarted,
          estimatedCostUsd: 0,
          model: "prefill-fallback",
          densityLabel: body.densityLabel,
          refined: false,
          fallback: true,
        };
      } else {
        entry.status = "ready";
        entry.blob = dataUrlToBlob(body.image);
        entry.meta = { ...body, refined: true };
      }
      labTimings.fills[key] = entry.meta.ms ?? (Date.now() - fillStarted);
      fillCache.set(key, entry);
      updateLab();
      updateChip();
      return entry;
    } catch (cause) {
      // Network / unexpected → still fall back to prefill
      entry.status = "ready";
      entry.blob = maskEntry.prefillBlob;
      entry.meta = {
        ms: Date.now() - fillStarted,
        estimatedCostUsd: 0,
        model: "prefill-fallback",
        refined: false,
        fallback: true,
        error: cause?.message,
      };
      labTimings.fills[key] = entry.meta.ms;
      fillCache.set(key, entry);
      updateChip();
      updateLab();
      return entry;
    }
  }

  function prefetchFillsForArea(a) {
    for (const g of GRAFT_LEVELS) {
      void requestGraftFill(a, g).catch(() => undefined);
    }
  }

  async function waitForFill(a, g, { timeoutMs = 90000 } = {}) {
    const key = comboKeyFor(a, g);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const entry = fillCache.get(key);
      if (entry?.status === "ready" && entry.blob) return entry;
      if (entry?.status === "error") throw new Error(entry.error || "채움 실패");
      if (!entry || entry.status !== "pending") {
        void requestGraftFill(a, g).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 80));
      updateChip();
    }
    throw new Error("모발 채우기 이미지를 만들지 못했어요. 다시 시도해 주세요.");
  }

  async function pushGuide({ forceBaseline = false } = {}) {
    if (!session || session.stopped) return false;
    const base = activeBaseline();
    if (!base) return false;
    if (forceBaseline || holdBaseline) {
      await session.select("baseline", {
        prompt: promptForArea(area),
        image: lucyBaselineBlob || base.blob,
        enhance: enhanceFlag(),
      }, { force: true });
      updateChip();
      return true;
    }
    const key = comboKeyFor(area, grafts);
    let entry = fillCache.get(key);
    if (!entry || entry.status !== "ready") {
      updateChip();
      if (!entry || entry.status !== "pending") {
        void requestGraftFill(area, grafts).catch(() => undefined);
      }
      // Keep previous Lucy image until the fill for this combo is ready.
      if (entry?.status === "pending" || !entry) return false;
      if (entry.status === "error") throw new Error(entry.error || "채움 실패");
    }
    entry = fillCache.get(key);
    await session.select(key, {
      prompt: promptForArea(area),
      image: entry.blob,
      enhance: enhanceFlag(),
    }, { force: true });
    updateChip();
    return true;
  }

  async function prepareLucyBaselineImage() {
    const source = baselineFront?.blob;
    if (!source) throw new Error("기준선이 없어요");
    await closeMediaPipe();
    const normalized = await normalizeLucyJpeg(source);
    lucyBaselineBlob = normalized.blob;
    return lucyBaselineBlob;
  }

  async function startLiveWithBaseline() {
    const sdk = await import("@decartai/sdk");
    const model = sdk.models.realtime("lucy-2.5");
    // Detach preview element without stopping tracks (Lucy will use the same stream).
    const local = $("graft-local-video");
    if (local) local.srcObject = null;
    $("graft-capture-layer").hidden = true;

    const baselineBlob = lucyBaselineBlob || baselineFront?.blob;
    if (!baselineBlob) throw new Error("기준선이 없어요");

    const promptText = promptForArea(area);
    const enhance = enhanceFlag();
    const initialState = {
      prompt: { text: promptText, enhance },
      image: baselineBlob,
    };

    const active = new RealtimeSession({
      mode: "graft",
      anchor: getAnchor(),
      combo: "baseline",
      experienceType: "preset",
      onState: () => updateButtons(),
      onTick: (billed) => {
        if (screen !== "live") return;
        $("remaining").hidden = false;
        $("time-bar").hidden = false;
        const left = Math.max(0, CAP_SECONDS - Math.floor(billed));
        $("remaining").textContent = `${left}초 남음`;
        $("time-bar").value = left;
      },
      onRemote: (remote) => {
        if (!isActive() || active.stopped) return;
        const out = $("output");
        out.srcObject = remote;
        out.style.transform = "none";
        out.hidden = false;
        out.onloadedmetadata = () => updateButtons();
        out.onplaying = () => updateButtons();
        out.play?.().then(() => updateButtons()).catch(() => undefined);
        updateButtons();
      },
      onError: (message) => {
        setError(message);
        resetAll();
      },
      onStop: () => {
        stopCamera();
        screen = "idle";
        showIdleStage();
        updateButtons();
      },
      report: reportEnd,
    });
    active.sessionId = tokenPayload.sessionId;
    session = active;
    screen = "live";
    holdBaseline = false;
    updateButtons();
    ensureLab();

    blockMediaPipe(3000);

    await active.start(
      camera,
      async () => tokenPayload,
      async (media, options, token) => {
        let lastSdkError = "";
        const baseLogger = isLab ? labSdkLogger(sdk) : sdk.noopLogger;
        const logger = {
          debug: (...args) => baseLogger.debug(...args),
          info: (...args) => baseLogger.info(...args),
          warn: (...args) => baseLogger.warn(...args),
          error: (message, data) => {
            const detail = data?.error ?? data?.message ?? message;
            if (detail) {
              const text = String(typeof detail === "string" ? detail : detail?.message || detail);
              if (!/stale connect attempt/i.test(text)) lastSdkError = text;
              else if (!lastSdkError) lastSdkError = text;
            }
            baseLogger.error(message, data);
          },
        };
        const client = sdk.createDecartClient({ apiKey: token, logger });
        try {
          return await client.realtime.connect(media, options);
        } catch (error) {
          const thrown = error?.message || String(error);
          const message = lastSdkError && /stale connect attempt/i.test(thrown)
            ? lastSdkError
            : (lastSdkError || thrown);
          console.info(`connect-failed message=${message}`);
          const wrapped = new Error(message);
          wrapped.connectFailed = true;
          wrapped.cause = error;
          throw wrapped;
        }
      },
      {
        model,
        mirror: "auto",
        resolution: "720p",
        initialState,
      },
    );
    blockMediaPipe(3000);
    $("status").textContent = "준비됨. 부위·모량을 바꿔 보세요";
    updateChip();
    updateLab();
  }

  async function assembleBaselineBundle(blob, measured, meta) {
    return {
      blob,
      meta,
      bundle: {
        imageData: measured.imageData,
        hairMask: measured.hairMask,
        faceMask: measured.faceMask,
        measure: measured.measure,
      },
    };
  }

  async function prepareFrontBaselineFromCapture(captured) {
    captureBlob = captured.blob;
    const measuredBundle = captured.measured || await measureBaselineBlob(captured.blob, { pose: "front" });
    if (measuredBundle?.measure) {
      captureMeasure = measuredBundle.measure;
      captureExposeCm = foreheadExposeCm(captureMeasure);
    }

    if (!testMode()) {
      baselineFront = await assembleBaselineBundle(captured.blob, measuredBundle, {
        pose: "front",
        ms: 0,
        estimatedCostUsd: 0,
        model: "capture",
      });
      baselineExposeCm = foreheadExposeCm(baselineFront.bundle.measure);
      prefetchFillsForArea("hairline");
      return;
    }

    $("status").textContent = "시술 전 모습을 만드는 중…";
    const prefillStarted = Date.now();
    const imageData = measuredBundle.imageData
      || (await measureBaselineBlob(captured.blob, { pose: "front" })).imageData;
    const hairMask = measuredBundle.hairMask;
    const prefilled = await prefillBaseline({
      imageData,
      hairMask,
      measure: captureMeasure,
    });
    labTimings.prefillMs = Date.now() - prefillStarted;
    prefillBaselineBlob = prefilled.prefillBaseline;
    baldMaskBlob = prefilled.baldMask;

    let finalBlob = prefillBaselineBlob;
    let meta = {
      pose: "front",
      ms: labTimings.prefillMs,
      estimatedCostUsd: 0,
      model: "prefill",
      refined: false,
    };

    if (baselineMode() === "refined") {
      try {
        const edited = await requestBaseline(prefillBaselineBlob, baldMaskBlob, "front");
        labTimings.refineMs = edited.meta?.ms ?? null;
        finalBlob = edited.blob;
        meta = { ...edited.meta, refined: true, prefillMs: labTimings.prefillMs };
      } catch (cause) {
        // Gemini fail → keep prefill
        console.info("baseline refine failed — using prefill", cause?.message);
        meta = {
          ...meta,
          fallback: true,
          refineError: cause?.message,
        };
      }
    }

    const measured = await measureBaselineBlob(finalBlob, { pose: "front" });
    const expose = foreheadExposeCm(measured.measure);
    try {
      assertBaselineForeheadGain({
        captureCm: captureExposeCm,
        baselineCm: expose,
      });
      baselineExposeCm = expose;
      baselineFront = await assembleBaselineBundle(finalBlob, measured, meta);
    } catch (cause) {
      if (cause?.code === "baseline-forehead-fail") {
        // Use prefillBaseline instead of Gemini result; do not regenerate.
        console.info("baseline forehead gain fail — using prefillBaseline", {
          captureCm: cause.captureCm,
          baselineCm: cause.baselineCm,
          gainCm: cause.gainCm,
        });
        const prefillMeasured = await measureBaselineBlob(prefillBaselineBlob, { pose: "front" });
        baselineExposeCm = foreheadExposeCm(prefillMeasured.measure);
        baselineFront = await assembleBaselineBundle(prefillBaselineBlob, prefillMeasured, {
          pose: "front",
          ms: labTimings.prefillMs,
          estimatedCostUsd: 0,
          model: "prefill",
          refined: false,
          foreheadFallback: true,
        });
      } else {
        throw cause;
      }
    }
    prefetchFillsForArea("hairline");
  }

  async function startFrontFlow() {
    if (connecting) return;
    connecting = true;
    setError("");
    lastBaselineError = null;
    showBaselineBanner(false);
    updateButtons();
    const epoch = ++cameraEpoch;
    try {
      await ensureCamera();
      if (epoch !== cameraEpoch || !isActive()) return;
      screen = "capture";
      pendingCapture = "front";
      $("status").textContent = "정면 촬영";
      // 1) Capture (tracks stay live)
      const captured = await captureFromVideo({ pose: "front" });
      if (epoch !== cameraEpoch || !isActive()) return;
      if (typeof window !== "undefined") {
        window.__graftLastCaptureTracks = streamTrackStates(camera);
      }

      // 2) Baseline complete before any token (includes MediaPipe remeasure in test mode)
      await prepareFrontBaselineFromCapture(captured);
      if (epoch !== cameraEpoch || !isActive()) return;

      area = "hairline";
      grafts = 2000;
      guideCache = new Map();
      // Prefetch already started in prepareFrontBaselineFromCapture

      // MediaPipe done → normalize Lucy image → then token → connect
      await prepareLucyBaselineImage();
      if (epoch !== cameraEpoch || !isActive()) return;

      // 3) Token only after baseline is ready
      const tokenRes = await fetch("/token", { method: "POST" });
      tokenPayload = await tokenRes.json();
      if (!tokenRes.ok) throw new Error(tokenPayload.error || "세션을 만들지 못했어요");

      // 4) Lucy connect with initialState.image = baseline (mode C)
      await startLiveWithBaseline();
    } catch (cause) {
      if (cause?.code === "baseline-fail" || cause?.code === "baseline-forehead-fail" || /시술 전/.test(cause?.message || "")) {
        lastBaselineError = cause;
        showBaselineBanner(true, cause.message);
        setError(cause.message);
        screen = "idle";
        showIdleStage();
        $("graft-capture-layer").hidden = true;
      } else {
        resetAll();
        setError(cause?.code === "camera-denied"
          ? "카메라 권한을 허용해주세요"
          : (cause?.message || "촬영에 실패했어요"));
      }
    } finally {
      connecting = false;
      updateButtons();
    }
  }

  async function retryBaseline() {
    if (!captureBlob || connecting) return;
    connecting = true;
    setError("");
    updateButtons();
    try {
      // Baseline first — no token until ready
      await prepareFrontBaselineFromCapture({
        blob: captureBlob,
        measured: null,
      });
      if (!baselineFront.bundle) {
        const measured = await measureBaselineBlob(baselineFront.blob, { pose: "front" });
        baselineFront.bundle = {
          imageData: measured.imageData,
          hairMask: measured.hairMask,
          faceMask: measured.faceMask,
          measure: measured.measure,
        };
      }
      await prepareLucyBaselineImage();
      const tokenRes = await fetch("/token", { method: "POST" });
      tokenPayload = await tokenRes.json();
      if (!tokenRes.ok) throw new Error(tokenPayload.error || "세션을 만들지 못했어요");
      await ensureCamera();
      showBaselineBanner(false);
      guideCache = new Map();
      fillCache = new Map();
      prefetchFillsForArea(area);
      await startLiveWithBaseline();
    } catch (cause) {
      lastBaselineError = cause;
      showBaselineBanner(true, cause?.message || "시술 전 이미지를 만들지 못했어요");
      setError(cause?.message || "시술 전 이미지를 만들지 못했어요");
    } finally {
      connecting = false;
      updateButtons();
    }
  }

  async function ensureCrownBaseline() {
    if (baselineCrown) return baselineCrown;
    connecting = true;
    updateButtons();
    try {
      $("status").textContent = "고개를 숙여주세요";
      screen = "capture";
      const captured = await captureFromVideo({ pose: "crown" });
      let blob = captured.blob;
      let meta = { pose: "crown", ms: 0, estimatedCostUsd: 0, model: "capture" };
      if (testMode()) {
        const prefilled = await prefillBaseline({
          imageData: captured.measured.imageData,
          hairMask: captured.measured.hairMask,
          measure: {
            ...captured.measured.measure,
            browTopY: captured.measured.measure.browTopY ?? captured.measured.measure.height * 0.35,
            faceHeightPx: captured.measured.measure.faceHeightPx
              || captured.measured.measure.height * 0.4,
            faceCenterX: captured.measured.measure.crownCenter?.x
              || captured.measured.measure.width / 2,
            templeLeft: { x: captured.measured.measure.width * 0.2, y: captured.measured.measure.height * 0.4 },
            templeRight: { x: captured.measured.measure.width * 0.8, y: captured.measured.measure.height * 0.4 },
            pxPerCm: captured.measured.measure.pxPerCm,
          },
        });
        blob = prefilled.prefillBaseline;
        meta = { pose: "crown", ms: 0, estimatedCostUsd: 0, model: "prefill", refined: false };
        if (baselineMode() === "refined") {
          try {
            const edited = await requestBaseline(prefilled.prefillBaseline, prefilled.baldMask, "crown");
            blob = edited.blob;
            meta = { ...edited.meta, refined: true };
          } catch {
            /* keep prefill */
          }
        }
      }
      const measured = testMode()
        ? await measureBaselineBlob(blob, { pose: "crown" })
        : captured.measured;
      baselineCrown = {
        blob,
        meta,
        bundle: {
          imageData: measured.imageData,
          hairMask: measured.hairMask,
          faceMask: measured.faceMask,
          measure: measured.measure,
        },
      };
      await closeMediaPipe();
      $("graft-capture-layer").hidden = true;
      screen = "live";
      prefetchFillsForArea("crown");
      return baselineCrown;
    } finally {
      connecting = false;
      updateButtons();
    }
  }

  async function changeSelection({ nextArea = area, nextGrafts = grafts } = {}) {
    const nextKey = comboKeyFor(nextArea, nextGrafts);
    if (nextArea === area && nextGrafts === grafts && session?.combo === nextKey) return;
    const areaChanged = nextArea !== area;
    area = nextArea;
    grafts = nextGrafts;
    holdBaseline = false;
    selectionTouched = true;
    updateButtons();
    updateChip();
    if (screen !== "live") return;
    switching = true;
    updateButtons();
    try {
      setError("");
      if (area === "crown") await ensureCrownBaseline();
      if (areaChanged) prefetchFillsForArea(area);
      const fill = fillCache.get(comboKeyFor(area, grafts));
      if (fill?.status === "ready") {
        await pushGuide();
      } else {
        // Keep previous Lucy frame; chip shows "준비 중" until ready then set().
        updateChip();
        void (async () => {
          try {
            await waitForFill(area, grafts);
            if (session && !session.stopped && !holdBaseline
              && comboKeyFor(area, grafts) === nextKey) {
              await pushGuide();
            }
          } catch (cause) {
            if (comboKeyFor(area, grafts) === nextKey) {
              setError(cause?.message || "전환에 실패했어요");
            }
          } finally {
            updateButtons();
            updateChip();
          }
        })();
      }
    } catch (cause) {
      setError(cause?.message || "전환에 실패했어요");
    } finally {
      switching = false;
      updateButtons();
    }
  }

  function bindHoldBaseline() {
    const btn = $("graft-hold-baseline");
    if (!btn) return;
    const apply = async (on) => {
      holdBaseline = on;
      updateChip();
      if (!session || session.stopped) return;
      try {
        await pushGuide({ forceBaseline: on });
      } catch {
        /* ignore hold glitches */
      }
    };
    btn.addEventListener("pointerdown", () => { void apply(true); });
    btn.addEventListener("pointerup", () => { void apply(false); });
    btn.addEventListener("pointerleave", () => { void apply(false); });
    btn.addEventListener("pointercancel", () => { void apply(false); });
  }

  function ensureLab() {
    if (!isLab) return null;
    if (labDebug) {
      labDebug.hidden = false;
      updateLab();
      return labDebug;
    }
    const panel = document.createElement("aside");
    panel.id = "graft-lab-debug";
    panel.className = "ref-lab-debug graft-lab-still";
    panel.innerHTML = `
      <h2 class="graft-lab-title">모수 /lab</h2>
      <label class="check">테스트 모드
        <input type="checkbox" id="graft-lab-testmode" checked>
        <span id="graft-lab-testmode-label">켜짐</span>
      </label>
      <label class="check"><input type="checkbox" id="graft-lab-enhance"> enhance</label>
      <pre id="graft-lab-meta"></pre>
      <div class="graft-lab-strips">
        <div class="graft-lab-strip-row">
          <h3>원본 / 탈모마스크 / prefillBaseline / 최종기준선 / prefillGuide×3 / 최종가이드×3</h3>
          <div id="graft-lab-strip" class="graft-lab-strip"></div>
        </div>
      </div>
      <button type="button" id="graft-lab-save-strips">5장 저장</button>
      <div id="graft-lab-grid" class="ref-lab-candidates"></div>
    `;
    $("stage").insertAdjacentElement("afterend", panel);
    window.__graftTestMode = true;
    $("graft-lab-testmode").addEventListener("change", (e) => {
      window.__graftTestMode = e.target.checked;
      $("graft-lab-testmode-label").textContent = e.target.checked ? "켜짐" : "꺼짐";
    });
    $("graft-lab-enhance").addEventListener("change", (e) => {
      window.__graftLabEnhance = e.target.checked;
    });
    $("graft-lab-save-strips").addEventListener("click", () => {
      void saveLabStrips();
    });
    labDebug = panel;
    updateLab();
    return panel;
  }

  function labFig(blob, caption) {
    const fig = document.createElement("figure");
    fig.className = "ref-lab-shot";
    if (blob) {
      const img = document.createElement("img");
      img.src = URL.createObjectURL(blob);
      fig.append(img);
    } else {
      const empty = document.createElement("div");
      empty.className = "graft-lab-empty";
      empty.textContent = "—";
      fig.append(empty);
    }
    const cap = document.createElement("figcaption");
    cap.textContent = caption;
    fig.append(cap);
    return fig;
  }

  async function saveLabStrips() {
    const shots = [];
    if (captureBlob) shots.push({ name: "01-capture.jpg", blob: captureBlob });
    if (baselineFront?.blob) shots.push({ name: "02-baseline.jpg", blob: baselineFront.blob });
    for (const g of GRAFT_LEVELS) {
      const mask = guideCache.get(comboKeyFor(area, g));
      if (mask?.blob) shots.push({ name: `03-mask-${area}-${g}.png`, blob: mask.blob });
    }
    for (const g of GRAFT_LEVELS) {
      const fill = fillCache.get(comboKeyFor(area, g));
      if (fill?.blob) shots.push({ name: `04-fill-${area}-${g}.jpg`, blob: fill.blob });
    }
    for (const shot of shots.slice(0, 5)) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(shot.blob);
      a.download = shot.name;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }

  function updateLab() {
    if (!isLab || !labDebug) return;
    const fillsMeta = {};
    for (const [key, entry] of fillCache) {
      fillsMeta[key] = {
        status: entry.status,
        ms: entry.meta?.ms ?? labTimings.fills[key] ?? null,
        cost: entry.meta?.estimatedCostUsd ?? null,
        density: entry.meta?.densityLabel ?? null,
        refined: entry.meta?.refined,
        fallback: entry.meta?.fallback,
      };
    }
    const meta = {
      testMode: testMode(),
      baselineMode: baselineMode(),
      fillMode: fillMode(),
      area,
      grafts,
      captureExposeCm,
      baselineExposeCm,
      foreheadGainCm: Number.isFinite(captureExposeCm) && Number.isFinite(baselineExposeCm)
        ? baselineExposeCm - captureExposeCm
        : null,
      timings: labTimings,
      frontBaseline: baselineFront?.meta || null,
      crownBaseline: baselineCrown?.meta || null,
      fills: fillsMeta,
    };
    $("graft-lab-meta").textContent = JSON.stringify(meta, null, 2);
    const strip = $("graft-lab-strip");
    if (strip) {
      strip.innerHTML = "";
      strip.append(labFig(captureBlob, "원본"));
      strip.append(labFig(baldMaskBlob, `탈모 마스크`));
      strip.append(labFig(prefillBaselineBlob, `prefillBaseline\n${labTimings.prefillMs ?? "?"}ms`));
      strip.append(labFig(
        baselineFront?.blob,
        `최종 기준선\n${baselineFront?.meta?.ms ?? labTimings.refineMs ?? "?"}ms · $${baselineFront?.meta?.estimatedCostUsd ?? 0}`,
      ));
      for (const g of GRAFT_LEVELS) {
        const guide = guideCache.get(comboKeyFor(area, g));
        strip.append(labFig(guide?.prefillBlob, `prefill ${g}`));
      }
      for (const g of GRAFT_LEVELS) {
        const fill = fillCache.get(comboKeyFor(area, g));
        const label = fill?.status === "ready"
          ? `최종 ${g}\n${fill.meta?.ms ?? "?"}ms · $${fill.meta?.estimatedCostUsd ?? 0}`
          : `최종 ${g}\n${fill?.status || "대기"}`;
        strip.append(labFig(fill?.blob, label));
      }
    }
    const grid = $("graft-lab-grid");
    if (!grid) return;
    grid.innerHTML = "";
  }

  function mountControls() {
    const areaRow = document.querySelector("[data-areas]");
    const graftRow = document.querySelector("[data-combos]");
    if (!areaRow || !graftRow) return;
    areaRow.innerHTML = "";
    graftRow.innerHTML = "";
    const labels = { mline: "M자", hairline: "헤어라인", crown: "정수리" };
    const hints = { mline: "이마 모서리", hairline: "이마선 전체", crown: "고개 숙여 확인" };
    for (const key of GRAFT_AREAS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("data-graft-area", key);
      btn.innerHTML = `${labels[key]}<small>${hints[key]}</small>`;
      btn.addEventListener("click", () => { void changeSelection({ nextArea: key }); });
      areaRow.append(btn);
    }
    for (const level of GRAFT_LEVELS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("data-graft-level", String(level));
      btn.textContent = `${level.toLocaleString("ko-KR")}모`;
      btn.addEventListener("click", () => { void changeSelection({ nextGrafts: level }); });
      graftRow.append(btn);
    }
  }

  function activate() {
    $("preset-actions").hidden = false;
    $("status").hidden = false;
    $("billing-note").hidden = false;
    $("graft-disclaimer").hidden = false;
    if (screen === "idle") showIdleStage();
    $("preset-bar").hidden = true;
    updateButtons();
    if (isLab) ensureLab();
  }

  function deactivate() {
    resetAll();
    $("preset-actions").hidden = true;
    $("preset-bar").hidden = true;
    $("status").hidden = true;
    $("billing-note").hidden = true;
    $("graft-disclaimer").hidden = true;
    $("graft-capture-layer").hidden = true;
    if (labDebug) labDebug.hidden = true;
  }

  function currentLeadMeta() {
    return {
      area: area === "crown" ? "crown" : area === "mline" ? "mline" : "hairline",
      density: densityKeyForGrafts(grafts),
      combo: comboKeyFor(area, grafts),
      sessionId: session?.sessionId || tokenPayload?.sessionId,
    };
  }

  mountControls();
  bindHoldBaseline();
  $("connect").addEventListener("click", () => { if (isActive()) void startFrontFlow(); });
  $("disconnect").addEventListener("click", () => { if (isActive()) resetAll(); });
  $("graft-baseline-retry")?.addEventListener("click", () => { if (isActive()) void retryBaseline(); });

  return {
    activate,
    deactivate,
    stopLive: resetAll,
    updateButtons,
    currentLeadMeta,
    get busy() { return connecting || switching; },
    get live() { return Boolean(session && !session.stopped && screen === "live"); },
  };
}
