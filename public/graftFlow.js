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
import { measureFrame, measureWithStabilization } from "./faceGeometry.js";
import { buildGraftMask } from "./graftGuide.js";
import { buildBaselineLoss } from "./baselineLoss.js";
import {
  SHOT_ORDER,
  SHOT_META,
  evaluateShotQuality,
  livePoseFromAngles,
} from "./graftPose.js";
import { analyzeHairFromShots, prefetchOrder } from "./graftAnalyze.js";
import { createDelayedStream, estimateStreamLagMs } from "./graftDelay.js";
import { RealtimeSession } from "./session.js";
import { openFrontCamera, stopMediaStream } from "./camera.js";

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

function meanBrightness(imageData) {
  const d = imageData.data;
  let s = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 16) {
    s += d[i] + d[i + 1] + d[i + 2];
    n += 3;
  }
  return n ? s / n / 255 : 0;
}

async function rgbaToJpegBlob(imageData, quality = 0.92) {
  if (typeof document === "undefined") {
    return new Blob([imageData.data], { type: "application/octet-stream" });
  }
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext("2d").putImageData(
    imageData instanceof ImageData
      ? imageData
      : new ImageData(imageData.data, imageData.width, imageData.height),
    0,
    0,
  );
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("frame-encode"))), "image/jpeg", quality);
  });
}

export function createGraftFlow({
  isActive,
  reportEnd,
  onGlobalError,
  getAnchor = () => "on",
  getEnhance = () => false,
  getEditModel = () => "",
  getPrefetchMode = () => "preferred",
  getDelaySync = () => true,
  getBaselineLoss = () => false,
  isLab = false,
}) {
  let area = "hairline";
  let grafts = 2000;
  let showBaseline = false;
  let session = null;
  let camera = null;
  let cameraEpoch = 0;
  let connecting = false;
  let switching = false;
  let screen = "idle";
  let shotIndex = 0;
  let retakeDir = null;
  let shots = {};
  let analysis = null;
  let stillCache = new Map();
  let baselineCache = new Map();
  let stripCache = new Map();
  let graftSessionId = null;
  let prefetchAbort = null;
  let holdOriginal = false;
  let delayed = null;
  let poseTimer = null;
  let liveView = "front";
  let labDebug = null;
  let outputHome = null;
  let tokenPayload = null;

  function baselineOn() {
    return Boolean(isLab && getBaselineLoss());
  }

  function setError(message) {
    onGlobalError(message);
  }

  function enhanceFlag() {
    return Boolean(getEnhance());
  }

  function showIdleStage() {
    $("stage-label").hidden = false;
    $("stage-label").textContent = "촬영 시작을 눌러 정면·왼쪽·오른쪽·정수리 4장을 찍으세요";
    $("output").hidden = true;
    $("combo-label").hidden = true;
    $("remaining").hidden = true;
    $("graft-hold-original")?.classList.add("is-hidden");
    $("graft-capture-layer").hidden = true;
    $("graft-split").hidden = true;
    $("stage").classList.remove("graft-split-on");
    restoreOutputHome();
  }

  function restoreOutputHome() {
    if (outputHome && $("output")?.parentElement !== outputHome) {
      outputHome.appendChild($("output"));
    }
  }

  function mountOutputInSplit() {
    const pane = document.querySelector(".graft-pane-sim");
    const out = $("output");
    if (!pane || !out) return;
    if (!outputHome) outputHome = out.parentElement;
    pane.appendChild(out);
    out.hidden = false;
  }

  function setCaptureGuide(direction) {
    const meta = SHOT_META[direction];
    $("graft-capture-hint").textContent = meta.hint;
    $("graft-guide-front").hidden = direction !== "front";
    $("graft-guide-left").hidden = direction !== "left";
    $("graft-guide-right").hidden = direction !== "right";
    $("graft-guide-crown").hidden = direction !== "crown";
  }

  function renderThumbs() {
    const el = $("graft-thumbs");
    if (!el) return;
    el.innerHTML = "";
    for (const dir of SHOT_ORDER) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "graft-thumb";
      btn.dataset.shot = dir;
      btn.setAttribute("aria-label", `${SHOT_META[dir].label} 다시 찍기`);
      if (shots[dir]?.thumbUrl) {
        const img = document.createElement("img");
        img.src = shots[dir].thumbUrl;
        img.alt = SHOT_META[dir].label;
        btn.append(img);
        if (shots[dir].quality && !shots[dir].quality.ok) btn.classList.add("warn");
      } else {
        btn.textContent = SHOT_META[dir].label;
        btn.classList.add("empty");
      }
      if ((retakeDir || SHOT_ORDER[shotIndex]) === dir && screen === "capture") btn.classList.add("active");
      btn.addEventListener("click", () => {
        if (screen !== "capture") return;
        retakeDir = dir;
        shotIndex = SHOT_ORDER.indexOf(dir);
        void enterCaptureStep();
      });
      el.append(btn);
    }
    $("graft-results").disabled = !SHOT_ORDER.every((d) => shots[d]) || connecting;
  }

  function updateSimLabel() {
    const el = $("graft-sim-label");
    if (!el) return;
    let text;
    if (holdOriginal) text = "현재";
    else if (showBaseline) text = "기준선(탈모 상태)";
    else {
      const rule = ruleFor(area, grafts);
      text = chipLabel(area, grafts, rule.sizeCm);
    }
    el.textContent = text;
    $("combo-label").hidden = screen !== "live";
    $("combo-label").textContent = text;
  }

  function updateButtons() {
    for (const btn of document.querySelectorAll("[data-graft-area]")) {
      const value = btn.getAttribute("data-graft-area");
      btn.setAttribute("aria-pressed", value === area ? "true" : "false");
      btn.classList.toggle("selected", value === area);
      const sufficient = !baselineOn() && analysis?.needs && !analysis.needs[value];
      btn.classList.toggle("sufficient", Boolean(sufficient));
      const small = btn.querySelector("small");
      const hints = { mline: "이마 모서리", hairline: "이마선 전체", crown: "고개 숙여 확인" };
      if (small) {
        if (sufficient) small.textContent = "현재 상태로 충분";
        else if (screen === "live" && !stillCache.has(cacheKey(value, grafts, value === "crown" ? "crown" : "front"))) {
          small.textContent = "준비 중";
        } else small.textContent = hints[value];
      }
      const ready = stillCache.has(cacheKey(value, grafts, value === "crown" ? "crown" : "front"))
        || (showBaseline && baselineCache.has(value));
      btn.disabled = connecting || switching || (screen === "live" && !ready && !sufficient && !showBaseline);
    }
    for (const btn of document.querySelectorAll("[data-graft-level]")) {
      const value = Number(btn.getAttribute("data-graft-level"));
      btn.setAttribute("aria-pressed", !showBaseline && value === grafts ? "true" : "false");
      btn.classList.toggle("selected", !showBaseline && value === grafts);
      const ready = stillCache.has(cacheKey(area, value, area === "crown" ? "crown" : "front"));
      const sufficient = !baselineOn() && analysis?.needs && !analysis.needs[area];
      btn.disabled = connecting || switching || (screen === "live" && !ready && !sufficient);
    }
    const baselineBtn = $("graft-baseline-btn");
    if (baselineBtn) {
      baselineBtn.hidden = !isLab || !baselineOn();
      baselineBtn.setAttribute("aria-pressed", showBaseline ? "true" : "false");
      baselineBtn.classList.toggle("selected", showBaseline);
      baselineBtn.disabled = connecting || switching || (screen === "live" && !baselineCache.has(area));
    }
    const live = screen === "live" && session && !session.stopped;
    $("connect").disabled = connecting || live || screen === "capture" || screen === "prefetch";
    $("disconnect").disabled = screen === "idle" && !connecting;
    if ($("graft-shutter")) $("graft-shutter").disabled = screen !== "capture" || connecting;
    $("preset-bar").hidden = !(isActive() && (screen === "live" || screen === "prefetch"));
    $("graft-shot-bar").hidden = !(isActive() && screen === "capture");
    if ($("graft-original-btn")) $("graft-original-btn").hidden = !live;
    $("product-actions").hidden = !(isActive() && live);
    const video = $("output");
    const frameReady = live && video && video.readyState >= 2 && video.videoWidth > 0;
    for (const id of ["save-result", "referral", "lab-capture"]) {
      const el = $(id);
      if (el) el.disabled = !frameReady || connecting || switching;
    }
    $("lab-actions").hidden = !(isLab && isActive() && live);
    updateSimLabel();
  }

  function cacheKey(a, g, view) {
    return `${comboKeyFor(a, g)}|${view}${baselineOn() ? "|bl" : ""}`;
  }

  function stopCamera() {
    cameraEpoch += 1;
    stopMediaStream(camera);
    camera = null;
    delayed?.stop();
    delayed = null;
    if (poseTimer) {
      clearInterval(poseTimer);
      poseTimer = null;
    }
  }

  function resetAll() {
    prefetchAbort?.abort();
    prefetchAbort = null;
    if (session && !session.stopped) session.stop("manual");
    session = null;
    connecting = false;
    switching = false;
    stopCamera();
    $("output").srcObject = null;
    shots = {};
    analysis = null;
    stillCache = new Map();
    baselineCache = new Map();
    stripCache = new Map();
    graftSessionId = null;
    tokenPayload = null;
    shotIndex = 0;
    retakeDir = null;
    showBaseline = false;
    screen = "idle";
    showIdleStage();
    renderThumbs();
    updateButtons();
  }

  async function ensureCamera() {
    if (camera) return camera;
    const sdk = await import("@decartai/sdk");
    const model = sdk.models.realtime("lucy-2.5");
    camera = await openFrontCamera(model);
    return camera;
  }

  async function enterCaptureStep() {
    screen = "capture";
    const dir = retakeDir || SHOT_ORDER[shotIndex];
    setCaptureGuide(dir);
    $("graft-capture-layer").hidden = false;
    $("graft-split").hidden = true;
    $("stage-label").hidden = true;
    $("graft-capture-warn").hidden = true;
    const local = $("graft-local-video");
    local.srcObject = camera;
    local.style.transform = "scaleX(-1)";
    await local.play().catch(() => undefined);
    $("status").textContent = `${SHOT_META[dir].label} · ${Math.min(shotIndex + 1, 4)}/4`;
    renderThumbs();
    updateButtons();
  }

  async function startCapture() {
    if (connecting) return;
    connecting = true;
    setError("");
    updateButtons();
    const epoch = ++cameraEpoch;
    try {
      await ensureCamera();
      if (epoch !== cameraEpoch || !isActive()) return;
      shotIndex = 0;
      retakeDir = null;
      await enterCaptureStep();
    } catch (cause) {
      resetAll();
      setError(cause?.code === "camera-denied" ? "카메라 권한을 허용해주세요" : (cause?.message || "카메라를 열지 못했어요"));
    } finally {
      connecting = false;
      updateButtons();
    }
  }

  /** Wait until bangs are pushed aside (front only). */
  async function waitForeheadClear(local) {
    const warn = $("graft-capture-warn");
    const deadline = Date.now() + 8000;
    while (true) {
      try {
        await measureFrame(local, { pose: "front" });
        if (warn) warn.hidden = true;
        return;
      } catch (cause) {
        if (cause?.code !== "forehead-bangs") throw cause;
        if (warn) {
          warn.hidden = false;
          warn.textContent = cause.message;
        }
        $("status").textContent = cause.message;
        if (Date.now() >= deadline) throw cause;
        await new Promise((r) => setTimeout(r, 280));
      }
    }
  }

  async function takeShutter() {
    if (screen !== "capture" || !camera) return;
    const dir = retakeDir || SHOT_ORDER[shotIndex];
    const local = $("graft-local-video");
    connecting = true;
    updateButtons();
    try {
      if (dir === "front") await waitForeheadClear(local);
      const pose = dir === "crown" ? "crown" : "front";
      const measured = await measureWithStabilization(local, { pose, samples: 5, intervalMs: 40 });
      const blob = await new Promise((resolve, reject) => {
        measured.frameCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error("frame-encode"))), "image/jpeg", 0.92);
      });

      let yaw = 0;
      let pitch = dir === "crown" ? 40 : 0;
      if (measured.measure.kind === "front" && measured.measure.templeLeft && measured.measure.templeRight) {
        const tl = measured.measure.templeLeft;
        const tr = measured.measure.templeRight;
        const mid = (tl.x + tr.x) / 2;
        const half = Math.max(1, Math.abs(tr.x - tl.x) / 2);
        const hx = measured.measure.hairlineCurve?.[Math.floor(measured.measure.hairlineCurve.length / 2)]?.x ?? mid;
        yaw = ((hx - mid) / half) * 35;
      }

      const hairRatio = measured.hairMask.reduce((a, v) => a + v, 0)
        / (measured.measure.width * measured.measure.height);
      const quality = evaluateShotQuality({
        direction: dir,
        yaw,
        pitch,
        faceCount: 1,
        brightness: meanBrightness(measured.imageData),
        motion: 0,
        hairRatio,
      });

      if (shots[dir]?.thumbUrl) URL.revokeObjectURL(shots[dir].thumbUrl);
      shots[dir] = {
        bundle: {
          pose: measured.measure.kind,
          imageData: measured.imageData,
          hairMask: measured.hairMask,
          faceMask: measured.faceMask,
          measure: measured.measure,
          frameBlob: blob,
        },
        blob,
        thumbUrl: URL.createObjectURL(blob),
        quality,
        yaw,
        pitch,
      };

      const warn = $("graft-capture-warn");
      if (quality.warnings.length) {
        warn.hidden = false;
        warn.textContent = `${quality.warnings.join(" · ")} (다시 찍을 수 있어요)`;
      } else warn.hidden = true;

      if (retakeDir) {
        retakeDir = null;
        const nextMissing = SHOT_ORDER.findIndex((d) => !shots[d]);
        shotIndex = nextMissing >= 0 ? nextMissing : SHOT_ORDER.length - 1;
      } else if (shotIndex < SHOT_ORDER.length - 1) {
        shotIndex += 1;
      }

      renderThumbs();
      if (SHOT_ORDER.every((d) => shots[d])) {
        $("status").textContent = "4장 준비됨. 결과 보기를 누르세요";
      } else {
        await enterCaptureStep();
      }
    } catch (cause) {
      setError(cause?.message || "촬영에 실패했어요");
    } finally {
      connecting = false;
      renderThumbs();
      updateButtons();
    }
  }

  function ensureBaseline(a) {
    if (baselineCache.has(a)) return baselineCache.get(a);
    const shot = a === "crown" ? shots.crown : shots.front;
    if (!shot) return null;
    const built = buildBaselineLoss({
      area: a,
      measure: shot.bundle.measure,
      imageData: shot.bundle.imageData,
      hairMask: shot.bundle.hairMask,
      faceMask: shot.bundle.faceMask,
    });
    baselineCache.set(a, built);
    return built;
  }

  async function generateStill(a, g) {
    const view = a === "crown" ? "crown" : "front";
    const key = cacheKey(a, g, view);
    if (stillCache.has(key)) return stillCache.get(key);
    if (!baselineOn() && analysis?.needs && !analysis.needs[a]) return null;
    const shot = a === "crown" ? shots.crown : shots.front;
    const baseline = baselineOn() ? ensureBaseline(a) : null;
    const masked = await buildGraftMask({
      imageData: shot.bundle.imageData,
      hairMask: shot.bundle.hairMask,
      measure: shot.bundle.measure,
      area: a,
      grafts: g,
      baselineLoss: baseline,
    });
    if (masked.stats.filledPixels < 8) return null;
    const personBlob = baseline
      ? await rgbaToJpegBlob(baseline.imageData)
      : shot.blob;
    const response = await fetch("/graft-inpaint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        person: await blobToDataUrl(personBlob),
        mask: await blobToDataUrl(masked.mask),
        area: a,
        grafts: g,
        view,
        sessionId: graftSessionId,
        analysis: analysis
          ? { color: analysis.color, length: analysis.length, type: analysis.type }
          : undefined,
        ...(getEditModel() ? { editModel: getEditModel() } : {}),
      }),
      signal: prefetchAbort?.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "생성 실패");
    const entry = {
      blob: dataUrlToBlob(body.image),
      meta: { ...body, stats: masked.stats, area: a, grafts: g, view, baseline: Boolean(baseline) },
      mask: masked.mask,
      personBlob,
    };
    stillCache.set(key, entry);
    rememberStrip(a, g, entry, baseline, shot);
    updateButtons();
    updateLab();
    return entry;
  }

  function rememberStrip(a, g, entry, baseline, shot) {
    if (!isLab) return;
    const row = stripCache.get(a) || { capture: shot.blob, baseline: null, levels: {} };
    row.capture = shot.blob;
    if (baseline) {
      row.baseline = baseline;
      row.baselineBlobPromise = row.baselineBlobPromise || rgbaToJpegBlob(baseline.imageData);
    }
    row.levels[g] = entry;
    stripCache.set(a, row);
  }

  async function startPrefetch() {
    prefetchAbort?.abort();
    prefetchAbort = new AbortController();
    const mode = getPrefetchMode();
    let areas;
    if (baselineOn()) areas = [...GRAFT_AREAS];
    else if (mode === "all") areas = [...GRAFT_AREAS];
    else areas = GRAFT_AREAS.filter((a) => analysis?.needs?.[a]);
    if (baselineOn()) {
      for (const a of areas) ensureBaseline(a);
    }
    const order = prefetchOrder(
      analysis?.preferredArea || "hairline",
      GRAFT_LEVELS,
      areas.length ? areas : [...GRAFT_AREAS],
    );
    for (const item of order) {
      if (prefetchAbort.signal.aborted) break;
      try {
        $("status").textContent = `미리 생성 중… ${item.area} ${item.grafts}모`;
        await generateStill(item.area, item.grafts);
      } catch (cause) {
        if (cause.name === "AbortError") break;
        console.warn("prefetch", cause);
      }
    }
    if (!prefetchAbort.signal.aborted) $("status").textContent = "준비됨. 부위·모량을 바꿔 보세요";
    updateButtons();
    updateLab();
  }

  async function pushStill({ force = false } = {}) {
    void force;
    if (!session || session.stopped) return false;
    if (showBaseline) {
      const bl = ensureBaseline(area);
      if (!bl) {
        setError("기준선이 아직 없어요");
        return false;
      }
      const blob = await rgbaToJpegBlob(bl.imageData);
      const t0 = performance.now();
      await session.select(`baseline_${area}`, {
        prompt: promptForArea(area),
        image: blob,
        enhance: enhanceFlag(),
      }, { force: true });
      const ms = Math.round(performance.now() - t0);
      if (isLab && $("graft-lab-switch-ms")) $("graft-lab-switch-ms").textContent = `set() ${ms}ms (기준선)`;
      updateSimLabel();
      return true;
    }
    const view = area === "crown" ? "crown" : liveView === "crown" ? "crown" : "front";
    let entry = stillCache.get(cacheKey(area, grafts, view === "crown" && area !== "crown" ? "front" : (area === "crown" ? "crown" : "front")));
    if (!entry) {
      try {
        entry = await generateStill(area, grafts);
      } catch (cause) {
        setError(cause?.message || "아직 준비 중이에요");
        return false;
      }
    }
    if (!entry) {
      setError("이 부위는 현재 상태로 충분해요");
      return false;
    }
    const t0 = performance.now();
    await session.select(comboKeyFor(area, grafts), {
      prompt: promptForArea(area),
      image: entry.blob,
      enhance: enhanceFlag(),
    }, { force: true });
    const ms = Math.round(performance.now() - t0);
    if (isLab && $("graft-lab-switch-ms")) $("graft-lab-switch-ms").textContent = `set() ${ms}ms`;
    updateSimLabel();
    return true;
  }

  async function startSplitLive() {
    const sdk = await import("@decartai/sdk");
    const model = sdk.models.realtime("lucy-2.5");
    try {
      await generateStill(area, grafts);
    } catch { /* prefetch continues */ }

    const still = stillCache.get(cacheKey(area, grafts, area === "crown" ? "crown" : "front"));
    $("graft-capture-layer").hidden = true;
    $("graft-split").hidden = false;
    $("stage").classList.add("graft-split-on");
    mountOutputInSplit();

    const active = new RealtimeSession({
      mode: "ref",
      anchor: getAnchor(),
      combo: comboKeyFor(area, grafts),
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
        if (!isActive() || active.stopped || holdOriginal) return;
        $("output").srcObject = remote;
        $("output").style.transform = "none";
        $("output").hidden = false;
        $("output").play?.().catch(() => undefined);
        updateButtons();
        if (getDelaySync() && delayed) {
          void estimateStreamLagMs($("graft-live-original"), $("output")).then((ms) => {
            if (ms > 0) delayed.setDelay(ms);
          });
        }
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

    delayed?.stop();
    delayed = createDelayedStream(camera, { delayMs: getDelaySync() ? 200 : 0 });
    const orig = $("graft-live-original");
    orig.srcObject = delayed.stream;
    orig.style.transform = "scaleX(-1)";
    orig.play?.().catch(() => undefined);
    $("graft-hold-original")?.classList.remove("is-hidden");

    updateButtons();
    ensureLab();

    await active.start(
      camera,
      async () => tokenPayload,
      (media, options, token) => sdk.createDecartClient({ apiKey: token, logger: sdk.noopLogger }).realtime.connect(media, options),
      {
        model,
        mirror: "auto",
        resolution: "720p",
        initialState: {
          prompt: { text: promptForArea(area), enhance: enhanceFlag() },
          image: still?.blob || shots.front.blob,
        },
      },
    );
    startPoseWatch();
  }

  function startPoseWatch() {
    if (poseTimer) clearInterval(poseTimer);
    poseTimer = setInterval(() => {
      if (screen !== "live" || !session || session.stopped) return;
      const next = area === "crown" ? "crown" : livePoseFromAngles(shots.front?.yaw ?? 0, 0);
      if (next !== liveView) {
        liveView = next;
        void pushStill({ force: true });
      }
    }, 800);
  }

  async function onResults() {
    if (!SHOT_ORDER.every((d) => shots[d])) return;
    connecting = true;
    updateButtons();
    try {
      $("graft-capture-layer").hidden = true;
      $("status").textContent = "머리 상태 분석 중…";
      screen = "prefetch";
      analysis = analyzeHairFromShots({
        front: shots.front.bundle,
        left: shots.left.bundle,
        right: shots.right.bundle,
        crown: shots.crown.bundle,
      });
      area = analysis.preferredArea;
      grafts = 2000;
      showBaseline = false;

      const tokenRes = await fetch("/token", { method: "POST" });
      tokenPayload = await tokenRes.json();
      if (!tokenRes.ok) throw new Error(tokenPayload.error || "세션을 만들지 못했어요");
      graftSessionId = tokenPayload.sessionId;

      void startPrefetch();
      await startSplitLive();
    } catch (cause) {
      setError(cause?.message || "결과 준비에 실패했어요");
      screen = "capture";
      $("graft-capture-layer").hidden = false;
    } finally {
      connecting = false;
      updateButtons();
    }
  }

  async function changeSelection({ nextArea = area, nextGrafts = grafts, baseline = false } = {}) {
    const same = nextArea === area && nextGrafts === grafts && baseline === showBaseline;
    if (same) return;
    area = nextArea;
    grafts = nextGrafts;
    showBaseline = Boolean(baseline) && baselineOn();
    updateButtons();
    if (!baselineOn() && analysis?.needs && !analysis.needs[nextArea] && !showBaseline) {
      setError("현재 상태로 충분 — 머리를 덧붙이지 않습니다");
      return;
    }
    if (screen !== "live") return;
    switching = true;
    updateButtons();
    try {
      setError("");
      await pushStill({ force: true });
    } catch (cause) {
      setError(cause?.message || "전환에 실패했어요");
    } finally {
      switching = false;
      updateButtons();
    }
  }

  function bindHoldOriginal() {
    const apply = (on) => {
      holdOriginal = on;
      if (!session) return;
      if (on) {
        $("output").srcObject = delayed?.stream || camera;
        $("output").style.transform = "scaleX(-1)";
      } else if (session.remoteStream) {
        $("output").srcObject = session.remoteStream;
        $("output").style.transform = "none";
      }
      updateSimLabel();
    };
    for (const id of ["graft-hold-original", "graft-original-btn"]) {
      const btn = $(id);
      if (!btn) continue;
      btn.addEventListener("pointerdown", () => apply(true));
      btn.addEventListener("pointerup", () => apply(false));
      btn.addEventListener("pointerleave", () => apply(false));
    }
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
      <p class="fine">Lucy는 reference 이미지 1장만 받습니다. set() 교체는 문서상 near-instant(실측 ms는 아래).</p>
      <label class="check">가상 탈모
        <input type="checkbox" id="graft-lab-baseline" checked>
        <span id="graft-lab-baseline-label">켜짐</span>
      </label>
      <label class="check">미리생성
        <select id="graft-lab-prefetch">
          <option value="preferred">판정 부위만</option>
          <option value="all">9개 전부</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" id="graft-lab-delay" checked> 원본 지연 동기화</label>
      <label class="check"><input type="checkbox" id="graft-lab-enhance"> enhance</label>
      <pre id="graft-lab-analysis"></pre>
      <div id="graft-lab-thumbs" class="graft-thumbs"></div>
      <div id="graft-lab-strips" class="graft-lab-strips"></div>
      <button type="button" id="graft-lab-save-strips">5장 한 번에 저장</button>
      <div id="graft-lab-grid" class="ref-lab-candidates"></div>
      <pre id="graft-lab-switch-ms"></pre>
      <p class="fine">영상 픽스처: lab/fixtures/videos/ (git 제외). 정수리: lab/fixtures/crown/. 결과: lab/results/</p>
    `;
    $("stage").insertAdjacentElement("afterend", panel);
    window.__graftBaselineLoss = true;
    const baselineInput = $("graft-lab-baseline");
    const baselineLabel = $("graft-lab-baseline-label");
    baselineInput.addEventListener("change", (e) => {
      window.__graftBaselineLoss = e.target.checked;
      baselineLabel.textContent = e.target.checked ? "켜짐" : "꺼짐";
      stillCache = new Map();
      baselineCache = new Map();
      stripCache = new Map();
      if (screen === "live" || screen === "prefetch") void startPrefetch();
      updateButtons();
      updateLab();
    });
    $("graft-lab-prefetch").addEventListener("change", (e) => {
      window.__graftPrefetchMode = e.target.value;
    });
    $("graft-lab-delay").addEventListener("change", (e) => {
      window.__graftDelaySync = e.target.checked;
      if (!e.target.checked) delayed?.setDelay(0);
    });
    $("graft-lab-enhance").addEventListener("change", (e) => {
      window.__graftLabEnhance = e.target.checked;
    });
    $("graft-lab-save-strips").addEventListener("click", () => { void downloadStrips(); });
    labDebug = panel;
    updateLab();
    return panel;
  }

  async function downloadStrips() {
    for (const [a, row] of stripCache) {
      const files = [
        { name: `${a}_00_capture.jpg`, blob: row.capture },
      ];
      if (row.baselineBlobPromise) {
        files.push({ name: `${a}_01_baseline.jpg`, blob: await row.baselineBlobPromise });
      }
      for (const g of GRAFT_LEVELS) {
        if (row.levels[g]?.blob) {
          files.push({ name: `${a}_${g}.jpg`, blob: row.levels[g].blob });
        }
      }
      for (const file of files) {
        const url = URL.createObjectURL(file.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.name;
        link.click();
        URL.revokeObjectURL(url);
        await new Promise((r) => setTimeout(r, 120));
      }
    }
  }

  async function updateLab() {
    if (!isLab || !labDebug) return;
    if (analysis) {
      $("graft-lab-analysis").textContent = JSON.stringify({
        ...analysis,
        baselineLoss: baselineOn(),
      }, null, 2);
    }
    const thumbs = $("graft-lab-thumbs");
    if (thumbs) {
      thumbs.innerHTML = "";
      for (const dir of SHOT_ORDER) {
        if (!shots[dir]) continue;
        const fig = document.createElement("figure");
        fig.className = "ref-lab-shot";
        const img = document.createElement("img");
        img.src = shots[dir].thumbUrl;
        fig.append(img);
        const cap = document.createElement("figcaption");
        cap.textContent = `${dir} yaw=${Number(shots[dir].yaw).toFixed(0)}° ${shots[dir].quality?.ok ? "ok" : "warn"}`;
        fig.append(cap);
        thumbs.append(fig);
      }
    }
    const strips = $("graft-lab-strips");
    if (strips) {
      strips.innerHTML = "";
      for (const a of GRAFT_AREAS) {
        const row = stripCache.get(a);
        if (!row) continue;
        const wrap = document.createElement("div");
        wrap.className = "graft-lab-strip-row";
        const title = document.createElement("h3");
        title.textContent = a;
        wrap.append(title);
        const line = document.createElement("div");
        line.className = "graft-lab-strip";
        const cells = [
          { label: "캡처", blob: row.capture, cm2: null },
        ];
        if (row.baseline) {
          cells.push({
            label: "기준선",
            blob: await (row.baselineBlobPromise || rgbaToJpegBlob(row.baseline.imageData)),
            cm2: `비움 ${row.baseline.stats.clearedCm2.toFixed(2)}cm²`,
          });
        }
        for (const g of GRAFT_LEVELS) {
          const entry = row.levels[g];
          if (!entry) continue;
          cells.push({
            label: `${g.toLocaleString("ko-KR")}모`,
            blob: entry.blob,
            cm2: entry.meta.stats
              ? `채움 ${Number(entry.meta.stats.filledCm2 || 0).toFixed(2)}cm²`
              : null,
          });
        }
        for (const cell of cells) {
          const fig = document.createElement("figure");
          fig.className = "ref-lab-shot";
          const img = document.createElement("img");
          img.src = URL.createObjectURL(cell.blob);
          fig.append(img);
          const cap = document.createElement("figcaption");
          cap.textContent = cell.cm2 ? `${cell.label}\n${cell.cm2}` : cell.label;
          fig.append(cap);
          line.append(fig);
        }
        wrap.append(line);
        strips.append(wrap);
      }
    }
    const grid = $("graft-lab-grid");
    if (!grid) return;
    grid.innerHTML = "";
    for (const [key, entry] of stillCache) {
      const fig = document.createElement("figure");
      fig.className = "ref-lab-candidate ref-lab-shot";
      const img = document.createElement("img");
      img.src = URL.createObjectURL(entry.blob);
      fig.append(img);
      const cap = document.createElement("figcaption");
      cap.textContent = `${key}\n${entry.meta.model || ""} ${entry.meta.ms ?? ""}ms filled=${entry.meta.stats?.filledPixels ?? "?"}`;
      fig.append(cap);
      grid.append(fig);
    }
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
      btn.addEventListener("click", () => { void changeSelection({ nextArea: key, baseline: false }); });
      areaRow.append(btn);
    }
    if (isLab) {
      const baselineBtn = document.createElement("button");
      baselineBtn.type = "button";
      baselineBtn.id = "graft-baseline-btn";
      baselineBtn.className = "ghost";
      baselineBtn.textContent = "기준선";
      baselineBtn.hidden = true;
      baselineBtn.addEventListener("click", () => {
        void changeSelection({ nextArea: area, nextGrafts: grafts, baseline: true });
      });
      graftRow.append(baselineBtn);
    }
    for (const level of GRAFT_LEVELS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("data-graft-level", String(level));
      btn.textContent = `${level.toLocaleString("ko-KR")}모`;
      btn.addEventListener("click", () => {
        void changeSelection({ nextGrafts: level, baseline: false });
      });
      graftRow.append(btn);
    }
  }

  function activate() {
    $("preset-actions").hidden = false;
    $("status").hidden = false;
    $("billing-note").hidden = false;
    $("graft-disclaimer").hidden = false;
    if (screen === "idle") showIdleStage();
    $("graft-shot-bar").hidden = true;
    $("preset-bar").hidden = true;
    updateButtons();
    if (isLab) ensureLab();
  }

  function deactivate() {
    resetAll();
    $("preset-actions").hidden = true;
    $("preset-bar").hidden = true;
    $("graft-shot-bar").hidden = true;
    $("status").hidden = true;
    $("billing-note").hidden = true;
    $("graft-disclaimer").hidden = true;
    $("graft-capture-layer").hidden = true;
    $("graft-split").hidden = true;
    $("stage").classList.remove("graft-split-on");
    restoreOutputHome();
    if (labDebug) labDebug.hidden = true;
  }

  function currentLeadMeta() {
    return {
      area: area === "crown" ? "crown" : area === "mline" ? "mline" : "hairline",
      density: densityKeyForGrafts(grafts),
      combo: comboKeyFor(area, grafts),
      sessionId: session?.sessionId || graftSessionId,
    };
  }

  mountControls();
  bindHoldOriginal();
  $("connect").addEventListener("click", () => { if (isActive()) void startCapture(); });
  $("disconnect").addEventListener("click", () => { if (isActive()) resetAll(); });
  $("graft-shutter")?.addEventListener("click", () => { if (isActive()) void takeShutter(); });
  $("graft-results")?.addEventListener("click", () => { if (isActive()) void onResults(); });

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
