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
import { measureWithStabilization } from "./faceGeometry.js";
import { buildGraftMask } from "./graftGuide.js";
import { RealtimeSession } from "./session.js";
import { openFrontCamera, stopMediaStream } from "./camera.js";
import { captureFrame, downloadCapture } from "./capture.js";

const $ = (id) => document.getElementById(id);

const AREA_META = {
  mline: { label: "M자", hint: "이마 모서리", pose: "front", captureHint: "정면을 봐주세요" },
  hairline: { label: "헤어라인", hint: "이마선 전체", pose: "front", captureHint: "정면을 봐주세요" },
  crown: { label: "정수리", hint: "고개 숙여 확인", pose: "crown", captureHint: "고개를 숙여 정수리가 원 안에 오게 해주세요" },
};

function frontPose(area) {
  return AREA_META[area]?.pose !== "crown";
}

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

export function createGraftFlow({
  isActive,
  reportEnd,
  onGlobalError,
  getAnchor = () => "on",
  getEnhance = () => false,
  getEditModel = () => "",
  isLab = false,
}) {
  let area = "hairline";
  let grafts = 2000;
  let session = null;
  let camera = null;
  let cameraEpoch = 0;
  let connecting = false;
  let switching = false;
  let screen = "idle"; // idle | preparing | stills | live
  let captureBundle = null;
  let stillBlob = null;
  let stillMeta = null;
  let holdOriginal = false;
  let labDebug = null;
  let labStillsReady = false;

  function setError(message) {
    onGlobalError(message);
  }

  function enhanceFlag() {
    return Boolean(getEnhance());
  }

  function showIdleStage() {
    $("stage-label").hidden = false;
    $("stage-label").textContent = "부위와 모량을 고른 뒤 연결을 누르세요";
    $("output").hidden = true;
    $("combo-label").hidden = true;
    $("remaining").hidden = true;
    $("graft-hold-original")?.classList.add("is-hidden");
    $("graft-capture-layer").hidden = true;
  }

  function showLiveStage(stream, { remote = false } = {}) {
    $("graft-capture-layer").hidden = true;
    $("stage-label").hidden = true;
    $("output").hidden = false;
    $("output").srcObject = stream;
    $("output").style.transform = remote || holdOriginal ? "none" : "scaleX(-1)";
    $("output").play?.().catch(() => undefined);
    updateChip();
    $("combo-label").hidden = false;
    $("graft-hold-original")?.classList.remove("is-hidden");
  }

  function updateChip() {
    const rule = ruleFor(area, grafts);
    $("combo-label").textContent = chipLabel(area, grafts, rule.sizeCm);
  }

  function updateButtons() {
    for (const btn of document.querySelectorAll("[data-graft-area]")) {
      const value = btn.getAttribute("data-graft-area");
      btn.setAttribute("aria-pressed", value === area ? "true" : "false");
      btn.classList.toggle("selected", value === area);
      btn.disabled = connecting || switching;
    }
    for (const btn of document.querySelectorAll("[data-graft-level]")) {
      const value = Number(btn.getAttribute("data-graft-level"));
      btn.setAttribute("aria-pressed", value === grafts ? "true" : "false");
      btn.classList.toggle("selected", value === grafts);
      btn.disabled = connecting || switching;
    }
    const live = screen === "live" && session && !session.stopped;
    const stillsGate = isLab && screen === "stills";
    $("connect").disabled = connecting || live || stillsGate || !isActive();
    $("disconnect").disabled = !live && !connecting && screen !== "stills";
    $("graft-capture").disabled = !live || connecting || switching;
    $("product-actions").hidden = !(isActive() && live);
    const video = $("output");
    const frameReady = live && video && video.readyState >= 2 && video.videoWidth > 0;
    for (const id of ["save-result", "referral", "lab-capture"]) {
      const el = $(id);
      if (el) el.disabled = !frameReady || connecting || switching;
    }
    $("lab-actions").hidden = !(isLab && isActive() && live);
    const startLive = $("graft-lab-start-live");
    if (startLive) startLive.disabled = !labStillsReady || connecting || live;
  }

  function stopCamera() {
    cameraEpoch += 1;
    stopMediaStream(camera);
    camera = null;
  }

  function stopLive(reason = "manual") {
    if (session && !session.stopped) session.stop(reason);
    session = null;
    connecting = false;
    switching = false;
    stillBlob = null;
    stillMeta = null;
    labStillsReady = false;
    stopCamera();
    $("output").srcObject = null;
    screen = "idle";
    showIdleStage();
    if (labDebug) labDebug.hidden = true;
    updateButtons();
  }

  async function ensureCamera(model) {
    if (camera) return camera;
    const stream = await openFrontCamera(model);
    camera = stream;
    return stream;
  }

  async function silentMeasure() {
    const pose = frontPose(area) ? "front" : "crown";
    screen = "preparing";
    // Show local camera without oval/countdown chrome (no guided capture UI).
    $("graft-capture-layer").hidden = false;
    $("graft-guide-front").hidden = true;
    $("graft-guide-crown").hidden = true;
    $("graft-capture-hint").hidden = true;
    $("graft-countdown").hidden = true;
    $("stage-label").hidden = false;
    $("stage-label").textContent = pose === "crown"
      ? "고개를 숙여 정수리를 보여 주세요…"
      : "얼굴을 정면으로 맞춰 주세요…";
    $("output").hidden = true;
    $("combo-label").hidden = true;
    updateButtons();

    const local = $("graft-local-video");
    if (local && camera) {
      local.srcObject = camera;
      local.style.transform = "scaleX(-1)";
      await local.play().catch(() => undefined);
      for (let i = 0; i < 40 && !local.videoWidth; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const source = local && local.videoWidth ? local : null;
    if (!source) {
      throw new Error(pose === "crown"
        ? "고개를 더 숙여 정수리가 화면 가운데 오게 해주세요"
        : "얼굴이 정면으로 보이게 해주세요");
    }

    const measured = await measureWithStabilization(source, {
      pose,
      samples: 5,
      intervalMs: 100,
    });
    const frameBlob = await new Promise((resolve, reject) => {
      measured.frameCanvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("frame-encode"))),
        "image/jpeg",
        0.92,
      );
    });
    captureBundle = {
      pose,
      imageData: measured.imageData,
      hairMask: measured.hairMask,
      faceMask: measured.faceMask,
      measure: measured.measure,
      frameBlob,
      samples: measured.samples,
    };
    $("graft-capture-layer").hidden = true;
    $("graft-capture-hint").hidden = false;
    return captureBundle;
  }

  async function requestInpaint({ level = grafts, maskBlob }) {
    const person = await blobToDataUrl(captureBundle.frameBlob);
    const mask = await blobToDataUrl(maskBlob);
    const editModel = getEditModel();
    const response = await fetch("/graft-inpaint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        person,
        mask,
        area,
        grafts: level,
        ...(editModel ? { editModel } : {}),
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "모발 채우기에 실패했어요.");
    return {
      blob: dataUrlToBlob(body.image),
      model: body.model,
      ms: body.ms,
      estimatedCostUsd: body.estimatedCostUsd,
      densityLabel: body.densityLabel,
    };
  }

  async function buildStillForSelection() {
    if (!captureBundle || captureBundle.pose !== (frontPose(area) ? "front" : "crown")) {
      return null;
    }
    $("status").textContent = "모발 채우는 중…";
    const masked = await buildGraftMask({
      imageData: captureBundle.imageData,
      hairMask: captureBundle.hairMask,
      measure: captureBundle.measure,
      area,
      grafts,
    });
    const painted = await requestInpaint({ level: grafts, maskBlob: masked.mask });
    stillBlob = painted.blob;
    stillMeta = { ...painted, stats: masked.stats };
    return { mask: masked, still: painted };
  }

  async function pushStillToSession({ force = false } = {}) {
    if (!session || session.stopped || !stillBlob) return;
    const prompt = promptForArea(area);
    const key = comboKeyFor(area, grafts);
    await session.select(key, {
      prompt,
      image: stillBlob,
      enhance: enhanceFlag(),
    }, { force });
    updateChip();
  }

  async function startLucyWithStill() {
    if (!stillBlob || !camera) throw new Error("정지 이미지가 없습니다.");
    const sdk = await import("@decartai/sdk");
    const model = sdk.models.realtime("lucy-2.5");
    const active = new RealtimeSession({
      mode: "ref",
      anchor: getAnchor(),
      combo: comboKeyFor(area, grafts),
      experienceType: "preset",
      onState: () => { if (isActive()) updateButtons(); },
      onTick: (billed) => {
        if (!isActive() || screen !== "live") return;
        $("remaining").hidden = false;
        $("time-bar").hidden = false;
        const left = Math.max(0, CAP_SECONDS - Math.floor(billed));
        $("remaining").textContent = `${left}초 남음`;
        $("time-bar").value = left;
      },
      onRemote: (remote) => {
        if (!isActive() || active.stopped || holdOriginal) return;
        showLiveStage(remote, { remote: true });
        updateButtons();
      },
      onError: (message) => {
        if (!isActive()) return;
        setError(message);
        stopLive("error");
      },
      onStop: () => {
        stopCamera();
        if (!isActive()) return;
        screen = "idle";
        showIdleStage();
        updateButtons();
      },
      report: reportEnd,
    });
    session = active;
    screen = "live";
    showLiveStage(camera, { remote: false });
    updateButtons();
    await active.start(camera, async () => {
      const response = await fetch("/token", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw { publicMessage: body.error };
      return body;
    }, (media, options, token) => sdk.createDecartClient({ apiKey: token, logger: sdk.noopLogger }).realtime.connect(media, options), {
      model,
      mirror: "auto",
      resolution: "720p",
      initialState: {
        prompt: { text: promptForArea(area), enhance: enhanceFlag() },
        image: stillBlob,
      },
    });
    if (isActive() && !active.stopped) {
      $("status").textContent = `연결됨 · enhance=${enhanceFlag() ? "true" : "false"}`;
    }
  }

  async function connect() {
    if (connecting || (session && !session.stopped)) return;
    connecting = true;
    setError("");
    labStillsReady = false;
    updateButtons();
    const epoch = ++cameraEpoch;
    try {
      const sdk = await import("@decartai/sdk");
      const model = sdk.models.realtime("lucy-2.5");
      await ensureCamera(model);
      if (epoch !== cameraEpoch || !isActive() || document.hidden) {
        stopCamera();
        return;
      }

      $("status").textContent = "측정 중…";
      await silentMeasure();
      if (epoch !== cameraEpoch || !isActive()) return;

      if (isLab) {
        await renderLabStills();
        screen = "stills";
        $("status").textContent = "정지 이미지를 확인한 뒤 라이브 연결을 누르세요";
        labStillsReady = true;
        updateButtons();
        return;
      }

      await buildStillForSelection();
      if (epoch !== cameraEpoch || !isActive()) return;
      await startLucyWithStill();
    } catch (cause) {
      if (epoch !== cameraEpoch) return;
      stopLive("error");
      const denied = cause?.code === "camera-denied";
      setError(denied ? "카메라 권한을 허용해주세요" : (cause?.publicMessage || cause?.message || "연결에 실패했습니다"));
    } finally {
      connecting = false;
      updateButtons();
    }
  }

  async function changeSelection({ nextArea = area, nextGrafts = grafts } = {}) {
    const areaChanged = nextArea !== area;
    const graftsChanged = nextGrafts !== grafts;
    if (!areaChanged && !graftsChanged) return;
    const needRecapture = areaChanged && frontPose(area) !== frontPose(nextArea);
    area = nextArea;
    grafts = nextGrafts;
    updateChip();
    updateButtons();

    if (isLab && screen === "stills" && captureBundle && !needRecapture) {
      switching = true;
      updateButtons();
      try {
        await buildStillForSelection();
        await renderLabStills({ skipAllLevels: true });
      } catch (cause) {
        setError(cause?.message || "정지 이미지를 바꾸지 못했어요.");
      } finally {
        switching = false;
        updateButtons();
      }
      return;
    }

    if (!(session && !session.stopped && screen === "live")) return;

    switching = true;
    updateButtons();
    try {
      if (needRecapture) {
        if (camera) showLiveStage(camera, { remote: false });
        $("status").textContent = "자세가 바뀌어 다시 측정합니다…";
        await silentMeasure();
      }
      await buildStillForSelection();
      screen = "live";
      if (session?.remoteStream && !holdOriginal) {
        showLiveStage(session.remoteStream, { remote: true });
      }
      await pushStillToSession({ force: true });
      if (isLab) await renderLabStills({ skipAllLevels: true });
    } catch (cause) {
      setError(cause?.message || "가이드를 바꾸지 못했어요.");
      if (session && !session.stopped) {
        screen = "live";
        if (session.remoteStream && !holdOriginal) showLiveStage(session.remoteStream, { remote: true });
      }
    } finally {
      switching = false;
      updateButtons();
    }
  }

  function bindHoldOriginal() {
    const btn = $("graft-hold-original");
    if (!btn) return;
    const down = () => {
      if (!(session && camera)) return;
      holdOriginal = true;
      showLiveStage(camera, { remote: false });
    };
    const up = () => {
      holdOriginal = false;
      if (session?.remoteStream) showLiveStage(session.remoteStream, { remote: true });
    };
    btn.addEventListener("pointerdown", down);
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointerleave", up);
    btn.addEventListener("pointercancel", up);
  }

  function ensureLab() {
    if (!isLab) return null;
    if (labDebug) return labDebug;
    const panel = document.createElement("aside");
    panel.id = "graft-lab-debug";
    panel.className = "ref-lab-debug graft-lab-still";
    panel.hidden = true;
    panel.innerHTML = `
      <h2 class="graft-lab-title">정지 이미지 비교</h2>
      <p class="fine">원본 · 마스크 · 1,000/2,000/3,000모. 단계·경계·머리색·얼굴 유지 확인 후 라이브.</p>
      <label class="check graft-lab-enhance"><input type="checkbox" id="graft-lab-enhance"> Lucy enhance</label>
      <figure class="ref-lab-shot"><img id="graft-lab-frame" alt="capture"><figcaption>원본 캡처</figcaption></figure>
      <canvas id="graft-lab-overlay" width="240" height="320"></canvas>
      <div id="graft-lab-stills" class="ref-lab-candidates"></div>
      <pre id="graft-lab-stats"></pre>
      <button type="button" id="graft-lab-start-live" disabled>라이브 연결</button>
      <button type="button" id="graft-lab-repeat">측정 5회 반복</button>
      <pre id="graft-lab-repeat-out"></pre>
    `;
    $("stage").insertAdjacentElement("afterend", panel);
    $("graft-lab-repeat").addEventListener("click", () => { void runLabRepeat(); });
    $("graft-lab-start-live").addEventListener("click", () => { void startLiveFromLab(); });
    $("graft-lab-enhance").checked = enhanceFlag();
    $("graft-lab-enhance").addEventListener("change", () => {
      // Lab checkbox overrides URL/default via closure read in getEnhance from app —
      // store on window for app getEnhance to read.
      window.__graftLabEnhance = $("graft-lab-enhance").checked;
    });
    labDebug = panel;
    return panel;
  }

  async function renderLabStills({ skipAllLevels = false } = {}) {
    if (!isLab) return;
    const panel = ensureLab();
    if (!panel || !captureBundle) return;
    panel.hidden = false;
    $("graft-lab-frame").src = URL.createObjectURL(captureBundle.frameBlob);
    drawOverlay($("graft-lab-overlay"), captureBundle);
    const stillsEl = $("graft-lab-stills");
    stillsEl.innerHTML = "";
    const lines = [];

    const levels = skipAllLevels ? [grafts] : GRAFT_LEVELS;
    for (const level of levels) {
      const masked = await buildGraftMask({
        imageData: captureBundle.imageData,
        hairMask: captureBundle.hairMask,
        measure: captureBundle.measure,
        area,
        grafts: level,
      });
      const figMask = document.createElement("figure");
      figMask.className = "ref-lab-candidate ref-lab-shot";
      const maskImg = document.createElement("img");
      maskImg.src = URL.createObjectURL(masked.mask);
      figMask.append(maskImg);
      const maskCap = document.createElement("figcaption");
      maskCap.textContent = `mask ${level}`;
      figMask.append(maskCap);
      stillsEl.append(figMask);

      let still;
      try {
        still = await requestInpaint({ level, maskBlob: masked.mask });
      } catch (cause) {
        const fail = document.createElement("figure");
        fail.className = "ref-lab-candidate ref-lab-shot";
        fail.innerHTML = `<figcaption>${level} 실패: ${cause.message}</figcaption>`;
        stillsEl.append(fail);
        lines.push(`#${level} FAIL ${cause.message}`);
        continue;
      }
      if (level === grafts) {
        stillBlob = still.blob;
        stillMeta = { ...still, stats: masked.stats };
      }
      const fig = document.createElement("figure");
      fig.className = "ref-lab-candidate ref-lab-shot";
      const img = document.createElement("img");
      img.src = URL.createObjectURL(still.blob);
      fig.append(img);
      const cap = document.createElement("figcaption");
      cap.textContent = `${level} · ${still.model} · ${still.ms}ms · ~$${still.estimatedCostUsd ?? "?"}\n${JSON.stringify(masked.stats)}`;
      fig.append(cap);
      stillsEl.append(fig);
      lines.push(`#${level} model=${still.model} ms=${still.ms} cost=${still.estimatedCostUsd} density=${still.densityLabel}`);
    }
    $("graft-lab-stats").textContent = lines.join("\n");
    labStillsReady = Boolean(stillBlob);
    updateButtons();
  }

  async function startLiveFromLab() {
    if (!isLab || !labStillsReady || !stillBlob) return;
    connecting = true;
    setError("");
    updateButtons();
    try {
      if (!stillBlob) await buildStillForSelection();
      await startLucyWithStill();
    } catch (cause) {
      setError(cause?.publicMessage || cause?.message || "라이브 연결에 실패했습니다");
      stopLive("error");
    } finally {
      connecting = false;
      updateButtons();
    }
  }

  function drawOverlay(canvas, bundle) {
    if (!canvas || !bundle) return;
    const { measure } = bundle;
    const ctx = canvas.getContext("2d");
    const scale = Math.min(canvas.width / measure.width, canvas.height / measure.height);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#6cf";
    ctx.beginPath();
    if (measure.kind === "front") {
      for (const [i, p] of measure.hairlineCurve.entries()) {
        const x = p.x * scale;
        const y = p.y * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = "#f66";
      for (const p of [measure.templeLeft, measure.templeRight]) {
        ctx.beginPath();
        ctx.arc(p.x * scale, p.y * scale, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = "#fc6";
      ctx.beginPath();
      ctx.moveTo(0, measure.browTopY * scale);
      ctx.lineTo(canvas.width, measure.browTopY * scale);
      ctx.stroke();
    } else {
      const r = ruleFor(area, grafts).sizeCm * measure.pxPerCm * scale;
      ctx.beginPath();
      ctx.arc(measure.crownCenter.x * scale, measure.crownCenter.y * scale, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  async function runLabRepeat() {
    if (!isLab || !camera) return;
    const pose = frontPose(area) ? "front" : "crown";
    const video = $("graft-local-video");
    if (!video) return;
    video.srcObject = camera;
    await video.play().catch(() => undefined);
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const one = await measureWithStabilization(video, { pose, samples: 1, intervalMs: 0 });
      samples.push(one.measure);
      await new Promise((r) => setTimeout(r, 120));
    }
    const px = samples.map((s) => s.pxPerCm);
    const sortedPx = [...px].sort((a, b) => a - b);
    const out = {
      pxPerCm: { min: Math.min(...px), max: Math.max(...px), median: sortedPx[2] },
    };
    if (samples[0].kind === "front") {
      const ys = samples.map((s) => s.hairlineCurve[Math.floor(s.hairlineCurve.length / 2)].y);
      const sortedY = [...ys].sort((a, b) => a - b);
      out.hairlineY = { min: Math.min(...ys), max: Math.max(...ys), median: sortedY[2] };
    } else {
      const xs = samples.map((s) => s.crownCenter.x);
      const ys = samples.map((s) => s.crownCenter.y);
      const sx = [...xs].sort((a, b) => a - b);
      const sy = [...ys].sort((a, b) => a - b);
      out.crownCenter = {
        x: { min: Math.min(...xs), max: Math.max(...xs), median: sx[2] },
        y: { min: Math.min(...ys), max: Math.max(...ys), median: sy[2] },
      };
    }
    $("graft-lab-repeat-out").textContent = JSON.stringify(out, null, 2);
  }

  function mountControls() {
    const areaRow = document.querySelector("[data-areas]");
    const graftRow = document.querySelector("[data-combos]");
    areaRow.innerHTML = "";
    graftRow.innerHTML = "";
    graftRow.classList.add("density");
    for (const key of GRAFT_AREAS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("data-graft-area", key);
      btn.innerHTML = `${AREA_META[key].label}<small>${AREA_META[key].hint}</small>`;
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
    $("preset-bar").hidden = false;
    $("preset-actions").hidden = false;
    $("status").hidden = false;
    $("status").textContent = "";
    $("billing-note").hidden = false;
    $("graft-disclaimer").hidden = false;
    if (screen === "idle") showIdleStage();
    updateButtons();
    if (isLab) ensureLab();
  }

  function deactivate() {
    stopLive("manual");
    $("preset-bar").hidden = true;
    $("preset-actions").hidden = true;
    $("status").hidden = true;
    $("billing-note").hidden = true;
    $("graft-disclaimer").hidden = true;
    $("graft-capture-layer").hidden = true;
    $("graft-hold-original")?.classList.add("is-hidden");
    if (labDebug) labDebug.hidden = true;
  }

  function currentLeadMeta() {
    return {
      area: area === "crown" ? "crown" : area === "mline" ? "mline" : "hairline",
      density: densityKeyForGrafts(grafts),
      combo: comboKeyFor(area, grafts),
      sessionId: session?.sessionId || null,
    };
  }

  function bindOutputReady() {
    const video = $("output");
    if (!video) return;
    for (const event of ["loadeddata", "playing", "resize"]) {
      video.addEventListener(event, () => {
        if (isActive() && screen === "live") updateButtons();
      });
    }
  }

  mountControls();
  bindHoldOriginal();
  bindOutputReady();
  $("connect").addEventListener("click", () => { if (isActive()) void connect(); });
  $("disconnect").addEventListener("click", () => { if (isActive()) stopLive("manual"); });
  $("graft-capture").addEventListener("click", async () => {
    if (!(session && !session.stopped)) return;
    try {
      const shot = await captureFrame($("output"), chipLabel(area, grafts, ruleFor(area, grafts).sizeCm));
      downloadCapture(shot, {
        mode: "ref",
        anchor: getAnchor(),
        combo: comboKeyFor(area, grafts),
        pose: frontPose(area) ? "정면" : "숙임",
      });
    } catch (cause) {
      setError(cause?.message || "캡처에 실패했어요.");
    }
  });

  return {
    activate,
    deactivate,
    stopLive,
    updateButtons,
    currentLeadMeta,
    get busy() { return connecting || switching; },
    get live() { return Boolean(session && !session.stopped && screen === "live"); },
  };
}
