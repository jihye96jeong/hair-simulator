import { decodeReferenceBitmap, downscaleBitmap, prepareReferenceUpload, validateReferenceFile } from "./hairReference.js";
import { IMAGE_HAIR_PROMPT, REFERENCE_ENHANCE, buildHairPrompt } from "./hairPrompt.js";
import { CAP_SECONDS, REFERENCE_SESSION_KEY } from "./shared.js";
import { RealtimeSession } from "./session.js";
import { openFrontCamera, stopMediaStream } from "./camera.js";
import { captureFrame, downloadCapture } from "./capture.js";
import { createSelfieCapture } from "./selfie.js";

const $ = (id) => document.getElementById(id);

const STATES = Object.freeze(["idle", "ready", "capture", "generating", "live"]);

async function sha256Prefix8(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
}

async function hashImageInput(input) {
  if (!input) return null;
  if (typeof input === "string" && input.startsWith("data:")) {
    const b64 = input.split(",")[1] || "";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return sha256Prefix8(bytes);
  }
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    return sha256Prefix8(new Uint8Array(await input.arrayBuffer()));
  }
  return sha256Prefix8(new TextEncoder().encode(String(input)));
}

/** Simplified reference hair UI: upload → start → auto capture/preview → Lucy. */
export function createReferenceFlow({
  isActive,
  reportEnd,
  onGlobalError,
  getAnchor = () => "on",
  getPrivacy = () => ({}),
  isLab = false,
  getLabOptions = () => ({}),
}) {
  let uiState = "idle";
  let camera = null;
  let cameraEpoch = 0;
  let session = null;
  let connecting = false;
  let uploadSeq = 0;
  let runSeq = 0;
  let originalUrl = null;
  let referenceDataUrl = "";
  let maskedReferenceDataUrl = "";
  let hairSpec = null;
  let hairPromptText = "";
  let describePromise = null;
  let describeReady = false;
  let describeError = null;
  let selfieDataUrl = "";
  let previewBlob = null;
  let previewDataUrl = "";
  let previewScores = [];
  let previewAttempts = 0;
  let previewSelectedIndex = null;
  let previewCandidates = [];
  let previewPersonCore = null;
  let previewReferenceCore = null;
  let previewFailCount = 0;
  let consented = false;
  let detailOpen = false;
  let countdownTimer = null;
  let captureCanvas = null;
  let lastLucyPrompt = "";
  let labDebug = null;

  const selfie = createSelfieCapture({
    video: $("selfie-video"),
    overlay: $("selfie-guide"),
  });

  /** Explicit lab URL overrides only. Missing params ⇒ identical to `/`. */
  function labOptions() { return getLabOptions() || {}; }
  function textMode() { return labOptions().refmode === "text"; }
  function resolveLucyPrompt(useImage) {
    const opts = labOptions();
    if (opts.lucyprompt) return opts.lucyprompt;
    if (!useImage || opts.promptmode === "spec") {
      return hairSpec ? buildHairPrompt(hairSpec, { withImage: false }) : hairPromptText;
    }
    return IMAGE_HAIR_PROMPT;
  }
  function promptKind(useImage, prompt) {
    const opts = labOptions();
    if (opts.lucyprompt) return "lucyprompt";
    if (!useImage || opts.promptmode === "spec") return "spec-text";
    if (prompt === IMAGE_HAIR_PROMPT) return "IMAGE_HAIR_PROMPT";
    return "other";
  }
  function revoke(url) { if (url) URL.revokeObjectURL(url); }
  function setGlobalError(message) { onGlobalError(message); }

  async function logPipelineTrace({ useImage, prompt, imageBlob }) {
    const geminiRefHash = await hashImageInput(maskedReferenceDataUrl || referenceDataUrl);
    const previewHash = await hashImageInput(previewBlob || previewDataUrl);
    const lucyImageHash = useImage ? await hashImageInput(imageBlob) : null;
    console.info("ref-pipeline", {
      path: location.pathname.replace(/\/$/, "") || "/",
      geminiRefHash,
      lucyImageHash,
      previewHash,
      lucyImageIsPreview: Boolean(useImage) && Boolean(lucyImageHash) && lucyImageHash === previewHash,
      promptKind: promptKind(useImage, prompt),
      enhance: REFERENCE_ENHANCE,
    });
  }

  async function copyLabImage(img, button) {
    if (!img?.src) return;
    const label = button.textContent;
    try {
      const response = await fetch(img.src);
      const blob = await response.blob();
      let pngBlob = blob;
      if (blob.type !== "image/png") {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap);
        bitmap.close();
        pngBlob = await new Promise((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/png");
        });
      }
      await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
      button.textContent = "복사됨";
      setTimeout(() => { button.textContent = label; }, 1200);
    } catch {
      button.textContent = "실패";
      setTimeout(() => { button.textContent = label; }, 1200);
    }
  }

  function attachLabCopyButton(figure, captionText) {
    const cap = document.createElement("figcaption");
    cap.textContent = captionText;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ref-lab-copy";
    btn.textContent = "복사";
    btn.addEventListener("click", () => {
      const img = figure.querySelector("img");
      void copyLabImage(img, btn);
    });
    figure.append(cap, btn);
  }

  function ensureLabDebug() {
    if (!isLab) return null;
    if (labDebug) return labDebug;
    const panel = document.createElement("aside");
    panel.id = "ref-lab-debug";
    panel.className = "ref-lab-debug";
    panel.hidden = true;
    const mkFigure = (id, alt) => {
      const fig = document.createElement("figure");
      fig.className = "ref-lab-shot";
      const img = document.createElement("img");
      img.id = id;
      img.alt = alt;
      fig.append(img);
      return fig;
    };
    const refFig = mkFigure("ref-lab-gemini-ref", "Gemini 레퍼런스");
    attachLabCopyButton(refFig, "0 gemini ref (masked)");
    const selfieFig = mkFigure("ref-lab-selfie", "크롭 정면");
    attachLabCopyButton(selfieFig, "1 selfie");
    const candidatesEl = document.createElement("div");
    candidatesEl.id = "ref-lab-candidates";
    candidatesEl.className = "ref-lab-candidates";
    const tableEl = document.createElement("table");
    tableEl.id = "ref-lab-spec-table";
    tableEl.className = "ref-lab-spec-table";
    const scoresEl = document.createElement("pre");
    scoresEl.id = "ref-lab-scores";
    const promptEl = document.createElement("pre");
    promptEl.id = "ref-lab-prompt";
    panel.append(refFig, selfieFig, candidatesEl, tableEl, scoresEl, promptEl);
    $("stage").insertAdjacentElement("afterend", panel);
    labDebug = panel;
    return panel;
  }

  function updateLabDebug({ prompt } = {}) {
    if (!isLab) return;
    const panel = ensureLabDebug();
    if (!panel) return;
    const refEl = panel.querySelector("#ref-lab-gemini-ref");
    const selfieEl = panel.querySelector("#ref-lab-selfie");
    const candidatesEl = panel.querySelector("#ref-lab-candidates");
    const tableEl = panel.querySelector("#ref-lab-spec-table");
    const scoresEl = panel.querySelector("#ref-lab-scores");
    const promptEl = panel.querySelector("#ref-lab-prompt");
    if (maskedReferenceDataUrl) refEl.src = maskedReferenceDataUrl;
    else refEl.removeAttribute("src");
    if (selfieDataUrl) selfieEl.src = selfieDataUrl;
    else selfieEl.removeAttribute("src");
    candidatesEl.innerHTML = "";
    if (previewCandidates.length) {
      for (const cand of previewCandidates) {
        const wrap = document.createElement("figure");
        wrap.className = "ref-lab-candidate ref-lab-shot";
        const img = document.createElement("img");
        img.alt = `candidate ${cand.index}`;
        if (cand.image) img.src = cand.image;
        wrap.append(img);
        attachLabCopyButton(
          wrap,
          `#${cand.index}${cand.selected ? " ← selected" : ""} match=${cand.hairMatch}/4 changed=${cand.changed ? "yes" : "no"}`,
        );
        candidatesEl.append(wrap);
      }
    }
    const fields = ["front", "forehead", "sides", "top"];
    const rows = [
      ["", ...fields],
      ["ref", ...fields.map((f) => previewReferenceCore?.[f] ?? "—")],
      ["selfie", ...fields.map((f) => previewPersonCore?.[f] ?? "—")],
    ];
    for (const cand of previewCandidates) {
      rows.push([
        `#${cand.index}${cand.selected ? "*" : ""}`,
        ...fields.map((f) => cand.candidate?.[f] ?? cand.core?.[f]?.cand ?? "—"),
      ]);
    }
    tableEl.innerHTML = rows.map((row, i) => {
      const tag = i === 0 ? "th" : "td";
      return `<tr>${row.map((cell) => `<${tag}>${cell}</${tag}>`).join("")}</tr>`;
    }).join("");
    if (previewScores.length || previewCandidates.length) {
      const lines = (previewCandidates.length ? previewCandidates : previewScores).map((s) => (
        `#${s.index} match=${s.hairMatch}/4 changed=${s.changed ? "yes" : "no"} pass=${s.pass ? "yes" : "no"} a${s.attempt ?? "?"}${s.selected || s.index === previewSelectedIndex ? " ← selected" : ""}`
      ));
      scoresEl.textContent = `attempts=${previewAttempts} selected=#${previewSelectedIndex ?? "?"}\n${lines.join("\n")}`;
    } else {
      scoresEl.textContent = "";
    }
    promptEl.textContent = prompt ?? lastLucyPrompt;
  }

  function showLabDebug(on) {
    if (!isLab) return;
    const panel = ensureLabDebug();
    if (panel) panel.hidden = !on;
  }

  function hideBanner() {
    $("ref-stage-banner").hidden = true;
    $("ref-stage-message").textContent = "";
    $("ref-stage-action").hidden = true;
    $("ref-stage-action").onclick = null;
  }

  function showBanner(message, actionLabel, onAction) {
    $("ref-stage-banner").hidden = false;
    $("ref-stage-message").textContent = message;
    if (actionLabel && onAction) {
      $("ref-stage-action").hidden = false;
      $("ref-stage-action").textContent = actionLabel;
      $("ref-stage-action").onclick = () => onAction();
    } else {
      $("ref-stage-action").hidden = true;
      $("ref-stage-action").onclick = null;
    }
  }

  function updateConsentCopy() {
    const privacy = getPrivacy() || {};
    const service = privacy.editService || "외부 AI 서비스";
    const region = privacy.editRegion || "";
    $("ref-consent-extra").textContent = region
      ? `전송 대상: ${service}. 처리 지역: ${region}. 사진은 저장하지 않습니다.`
      : `전송 대상: ${service}. 사진은 저장하지 않습니다.`;
  }

  function clearCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    $("ref-countdown").hidden = true;
  }

  function setUiState(next) {
    uiState = next;
    const map = {
      idle: "ref-layer-idle",
      ready: "ref-layer-ready",
      capture: "ref-layer-capture",
      generating: "ref-layer-generating",
    };
    for (const [state, id] of Object.entries(map)) $(id).hidden = state !== next;
    $("output").hidden = next !== "live";
    $("ref-live-thumb").hidden = next !== "live" || !originalUrl;
    $("ref-ready-bar").hidden = next !== "ready";
    $("ref-live-bar").hidden = next !== "live";
    $("remaining").hidden = next !== "live";
    $("time-bar").hidden = next !== "live";
    $("connection-state").hidden = true;
    $("expected-chip").hidden = true;
    $("resolution").hidden = true;
    showLabDebug(next === "live");
    if (next === "capture" || next === "generating" || next === "live") hideBanner();
    updateButtons();
  }

  function invalidatePreview() {
    previewBlob = null;
    previewDataUrl = "";
    previewScores = [];
    previewAttempts = 0;
    previewSelectedIndex = null;
    previewCandidates = [];
    previewPersonCore = null;
    previewReferenceCore = null;
    previewFailCount = 0;
  }

  function resetDescribe() {
    describePromise = null;
    describeReady = false;
    describeError = null;
    hairSpec = null;
    hairPromptText = "";
  }

  function clearUpload({ keepConsent = false } = {}) {
    uploadSeq++;
    runSeq++;
    clearCountdown();
    selfie.stop();
    stopCamera();
    if (session && !session.stopped) session.stop("manual");
    session = null;
    connecting = false;
    revoke(originalUrl);
    originalUrl = null;
    referenceDataUrl = "";
    maskedReferenceDataUrl = "";
    selfieDataUrl = "";
    invalidatePreview();
    resetDescribe();
    $("ref-ready-thumb").removeAttribute("src");
    $("ref-live-thumb").removeAttribute("src");
    $("ref-freeze").removeAttribute("src");
    $("ref-file").value = "";
    if (!keepConsent) {
      consented = false;
      $("ref-consent-check").checked = false;
      detailOpen = false;
      $("ref-consent-extra").hidden = true;
    }
    setGlobalError("");
    setUiState("idle");
  }

  function stopCamera() {
    cameraEpoch++;
    stopMediaStream(camera);
    camera = null;
  }

  function showLiveStream(stream, { remote = false } = {}) {
    const video = $("output");
    video.hidden = false;
    video.srcObject = stream;
    video.style.transform = remote ? "none" : "scaleX(-1)";
    void video.play().catch(() => undefined);
  }

  function updateTime(billed, wall) {
    const remaining = Math.max(0, CAP_SECONDS - Math.max(billed, wall));
    $("remaining").textContent = `${Math.ceil(remaining)}초 남음`;
    $("time-bar").value = remaining;
  }

  function updateButtons() {
    if (!isActive()) return;
    $("ref-start").disabled = uiState !== "ready" || !consented || !referenceDataUrl || connecting;
    const live = !session?.stopped && Boolean(session?.rt) && ["connected", "generating"].includes(session?.state);
    const frame = live && $("output").readyState >= 2 && $("output").videoWidth > 0;
    $("ref-capture").disabled = !frame || connecting;
  }

  async function describeReference(dataUrl, seq) {
    describeReady = false;
    describeError = null;
    describePromise = (async () => {
      const response = await fetch("/hair-describe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl }),
      });
      const body = await response.json().catch(() => ({}));
      if (seq !== uploadSeq) return;
      if (response.status === 422) {
        describeError = { status: 422, message: body.error || "헤어가 잘 보이는 사진으로 바꿔주세요" };
        throw describeError;
      }
      if (response.status === 429 || response.status === 503) {
        describeError = { status: response.status, message: body.error || "잠시 후 다시 시도해 주세요." };
        throw describeError;
      }
      if (!response.ok) {
        describeError = { status: response.status, message: body.error || "헤어를 분석하지 못했어요." };
        throw describeError;
      }
      hairSpec = body.spec;
      hairPromptText = body.prompt || buildHairPrompt(body.spec, { withImage: false });
      describeReady = true;
    })();
    try {
      await describePromise;
    } catch (error) {
      if (seq !== uploadSeq) return;
      if (error?.status === 422) {
        setUiState("idle");
        showBanner(error.message, "다른 사진", () => $("ref-file").click());
      } else if (error?.status === 429 || error?.status === 503) {
        setUiState("ready");
        showBanner(error.message);
      }
    }
  }

  async function ingestFile(file) {
    const check = validateReferenceFile(file);
    if (!check.ok) {
      showBanner(check.error, "다른 사진", () => $("ref-file").click());
      return;
    }
    const seq = ++uploadSeq;
    runSeq++;
    clearCountdown();
    selfie.stop();
    stopCamera();
    if (session && !session.stopped) session.stop("manual");
    session = null;
    connecting = false;
    invalidatePreview();
    resetDescribe();
    selfieDataUrl = "";
    referenceDataUrl = "";
    maskedReferenceDataUrl = "";
    setGlobalError("");
    hideBanner();
    let bitmap = null;
    try {
      revoke(originalUrl);
      originalUrl = URL.createObjectURL(file);
      $("ref-ready-thumb").src = originalUrl;
      $("ref-live-thumb").src = originalUrl;
      $("ref-original").src = originalUrl;
      const decoded = await decodeReferenceBitmap(file);
      if (seq !== uploadSeq || !isActive()) { decoded.close(); return; }
      const scaled = await downscaleBitmap(decoded);
      bitmap = scaled.bitmap;
      const prepared = await prepareReferenceUpload(bitmap);
      if (seq !== uploadSeq || !isActive()) return;
      referenceDataUrl = prepared.originalDataUrl;
      maskedReferenceDataUrl = prepared.maskedDataUrl;
      setUiState("ready");
      void describeReference(referenceDataUrl, seq);
    } catch (cause) {
      if (seq !== uploadSeq) return;
      referenceDataUrl = "";
      maskedReferenceDataUrl = "";
      showBanner(cause.message || "이미지를 처리하지 못했습니다.", "다른 사진", () => $("ref-file").click());
      setUiState("idle");
    } finally {
      try { bitmap?.close(); } catch { /* ignore */ }
    }
  }

  async function waitDescribe(uploadAtStart) {
    if (describePromise) {
      try { await describePromise; } catch { /* handled below */ }
    }
    if (uploadSeq !== uploadAtStart) return false;
    if (describeError?.status === 422) {
      setUiState("idle");
      showBanner(describeError.message, "다른 사진", () => $("ref-file").click());
      return false;
    }
    if (describeError) {
      setUiState("ready");
      if (describeError.status === 429) showBanner(describeError.message);
      else showBanner(describeError.message, "다시 시도", () => startExperience());
      return false;
    }
    if (!describeReady || !hairPromptText) {
      setUiState("ready");
      showBanner("헤어 분석을 마치지 못했어요.", "다시 시도", () => startExperience());
      return false;
    }
    return true;
  }

  async function createPreview(uploadAtStart) {
    if (previewBlob) return previewBlob;
    if (textMode()) return null;
    if (!hairSpec) {
      const error = new Error("헤어 분석을 마치지 못했어요.");
      error.status = 400;
      throw error;
    }
    const opts = labOptions();
    const response = await fetch("/hair-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        person: selfieDataUrl,
        reference: maskedReferenceDataUrl,
        spec: hairSpec,
        labDebug: isLab,
        editModel: opts.editmodel || undefined,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (uploadSeq !== uploadAtStart) return null;
    if (response.status === 429) {
      const error = new Error(body.error || "오늘 체험 횟수를 모두 사용했어요.");
      error.status = 429;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(body.error || "스타일을 입히지 못했어요");
      error.status = response.status;
      throw error;
    }
    previewDataUrl = body.image;
    previewScores = Array.isArray(body.scores) ? body.scores : [];
    previewAttempts = Number(body.attempts) || 0;
    previewSelectedIndex = Number.isInteger(body.selectedIndex) ? body.selectedIndex : null;
    previewCandidates = Array.isArray(body.candidates) ? body.candidates : [];
    previewPersonCore = body.person || null;
    previewReferenceCore = body.reference || null;
    // faceRestore kept in public/faceRestore.js but disabled — Lucy uses Gemini output as-is.
    previewBlob = await (await fetch(previewDataUrl)).blob();
    previewFailCount = 0;
    updateLabDebug();
    return previewBlob;
  }

  async function connectLucy({ useImage, prompt, imageBlob, seq, uploadAtStart }) {
    connecting = true;
    updateButtons();
    const epoch = ++cameraEpoch;
    try {
      const sdk = await import("@decartai/sdk");
      const model = sdk.models.realtime("lucy-2.5");
      const stream = await openFrontCamera(model);
      if (epoch !== cameraEpoch || !isActive() || document.hidden || seq !== runSeq || uploadSeq !== uploadAtStart) {
        stopMediaStream(stream);
        return;
      }
      camera = stream;
      setUiState("live");
      showLiveStream(stream, { remote: false });

      const active = new RealtimeSession({
        mode: "ref",
        anchor: getAnchor(),
        combo: REFERENCE_SESSION_KEY,
        experienceType: "reference",
        onState: () => {
          if (!isActive() || uiState !== "live") return;
          updateButtons();
        },
        onTick: (billed, wall) => {
          if (!isActive() || uiState !== "live") return;
          $("remaining").hidden = false;
          $("time-bar").hidden = false;
          updateTime(billed, wall);
        },
        onRemote: (remote) => {
          if (!isActive() || active.stopped || uiState !== "live") return;
          showLiveStream(remote, { remote: true });
        },
        onError: (message) => {
          if (!isActive()) return;
          setUiState("ready");
          showBanner(message, "다시 시도", () => startExperience());
        },
        onStop: ({ reason }) => {
          stopCamera();
          if (!isActive()) return;
          $("output").srcObject = null;
          $("output").hidden = true;
          setUiState(referenceDataUrl ? "ready" : "idle");
          if (reason === "error") showBanner("연결에 실패했어요.", "다시 시도", () => startExperience());
        },
        report: reportEnd,
      });
      session = active;
      updateTime(0, 0);
      lastLucyPrompt = prompt;
      updateLabDebug({ prompt });
      await logPipelineTrace({ useImage, prompt, imageBlob });
      const initialState = useImage
        ? { prompt: { text: prompt, enhance: REFERENCE_ENHANCE }, image: imageBlob }
        : { prompt: { text: prompt, enhance: REFERENCE_ENHANCE } };
      await active.start(camera, async () => {
        const response = await fetch("/token", { method: "POST" });
        const body = await response.json();
        if (!response.ok) throw { publicMessage: body.error };
        return body;
      }, (media, options, token) => sdk.createDecartClient({ apiKey: token, logger: sdk.noopLogger }).realtime.connect(media, options), {
        model: sdk.models.realtime("lucy-2.5"),
        mirror: "auto",
        resolution: "720p",
        initialState,
      });
      if ((!isActive() || seq !== runSeq) && !active.stopped) active.stop("manual");
    } catch (cause) {
      if (epoch !== cameraEpoch || seq !== runSeq) return;
      stopCamera();
      const denied = cause?.code === "camera-denied";
      setUiState("ready");
      showBanner(
        denied ? "카메라 권한을 허용해주세요" : (cause?.publicMessage || cause?.message || "연결에 실패했습니다"),
        "다시 시도",
        () => startExperience(),
      );
      session?.stop("error");
    } finally {
      connecting = false;
      updateButtons();
    }
  }

  async function runAutoPipeline({ forceText = false } = {}) {
    const seq = ++runSeq;
    const uploadAtStart = uploadSeq;
    hideBanner();
    setGlobalError("");
    try {
      setUiState("capture");
      await selfie.start();
      await new Promise((resolve) => {
        const video = $("selfie-video");
        if (video.readyState >= 2 && video.videoWidth > 0) return resolve();
        const done = () => { video.removeEventListener("loadeddata", done); resolve(); };
        video.addEventListener("loadeddata", done);
        setTimeout(resolve, 2000);
      });
      if (seq !== runSeq || uploadSeq !== uploadAtStart || !isActive()) return;

      let count = 3;
      $("ref-countdown").hidden = false;
      $("ref-countdown").textContent = String(count);
      await new Promise((resolve, reject) => {
        countdownTimer = setInterval(() => {
          count -= 1;
          if (seq !== runSeq) {
            clearCountdown();
            reject(new Error("cancelled"));
            return;
          }
          if (count <= 0) {
            clearCountdown();
            resolve();
            return;
          }
          $("ref-countdown").textContent = String(count);
        }, 1000);
      });
      if (seq !== runSeq || uploadSeq !== uploadAtStart || !isActive()) return;

      const shot = await selfie.capture();
      selfieDataUrl = shot.dataUrl;
      $("ref-freeze").src = selfieDataUrl;
      setUiState("generating");

      const okDescribe = await waitDescribe(uploadAtStart);
      if (!okDescribe || seq !== runSeq || uploadSeq !== uploadAtStart) return;

      let imageBlob = null;
      let useImage = !forceText && !textMode();
      if (useImage) {
        try {
          imageBlob = await createPreview(uploadAtStart);
          if (seq !== runSeq || uploadSeq !== uploadAtStart) return;
          if (!imageBlob) useImage = false;
        } catch (error) {
          if (seq !== runSeq || uploadSeq !== uploadAtStart) return;
          if (error.status === 429) {
            setUiState("ready");
            showBanner(error.message);
            return;
          }
          previewFailCount += 1;
          setUiState("ready");
          if (previewFailCount >= 2) {
            showBanner("스타일을 입히지 못했어요", "간단 모드로 체험", () => { void runAutoPipeline({ forceText: true }); });
          } else {
            showBanner("스타일을 입히지 못했어요", "다시 시도", () => startExperience());
          }
          return;
        }
      }

      const prompt = resolveLucyPrompt(useImage);
      await connectLucy({ useImage, prompt, imageBlob, seq, uploadAtStart });
    } catch (cause) {
      if (seq !== runSeq) return;
      clearCountdown();
      selfie.stop();
      if (cause?.message === "cancelled") return;
      const denied = cause?.code === "camera-denied";
      setUiState("ready");
      showBanner(
        denied ? "카메라 권한을 허용해주세요" : (cause?.message || "시작하지 못했어요."),
        "다시 시도",
        () => startExperience(),
      );
    }
  }

  function startExperience() {
    if (!isActive() || uiState !== "ready" || !consented || !referenceDataUrl || connecting) return;
    void runAutoPipeline({ forceText: textMode() });
  }

  function endLive() {
    runSeq++;
    clearCountdown();
    hideBanner();
    if (session && !session.stopped) session.stop("manual");
    else stopCamera();
    session = null;
    connecting = false;
    $("output").srcObject = null;
    $("output").hidden = true;
    setUiState("ready");
  }

  function captureResult() {
    try {
      const canvas = captureFrame($("output"), "레퍼런스 헤어");
      captureCanvas = canvas;
      session?.stop("capture", true);
      stopCamera();
      downloadCapture(canvas, { mode: "ref", anchor: getAnchor(), combo: REFERENCE_SESSION_KEY, pose: "정면" });
      $("ref-captured-image").src = canvas.toDataURL("image/png");
      setUiState("ready");
    } catch (cause) {
      showBanner(cause.message || "캡처에 실패했습니다.", "다시 시도", () => updateButtons());
    }
  }

  function bind() {
    $("ref-file").addEventListener("change", () => {
      const file = $("ref-file").files?.[0];
      if (file) void ingestFile(file);
    });
    $("ref-change").addEventListener("click", () => $("ref-file").click());
    $("ref-consent-check").addEventListener("change", () => {
      consented = $("ref-consent-check").checked;
      updateButtons();
    });
    $("ref-consent-detail").addEventListener("click", (event) => {
      event.preventDefault();
      detailOpen = !detailOpen;
      updateConsentCopy();
      $("ref-consent-extra").hidden = !detailOpen;
    });
    $("ref-start").addEventListener("click", () => startExperience());
    $("ref-capture").addEventListener("click", captureResult);
    $("ref-end").addEventListener("click", endLive);
    for (const event of ["loadeddata", "playing", "resize"]) {
      $("output").addEventListener(event, () => { if (isActive() && uiState === "live") updateButtons(); });
    }
  }

  bind();
  setUiState("idle");

  return {
    dispose() {
      clearUpload();
      setGlobalError("");
    },
    stopLive(reason = "manual") {
      if (session && !session.stopped) session.stop(reason);
      else stopCamera();
      if (isActive()) setUiState(referenceDataUrl ? "ready" : "idle");
    },
    stopCamera,
    updateButtons,
    activate() {
      updateConsentCopy();
      if (!STATES.includes(uiState)) setUiState("idle");
      else setUiState(uiState === "live" ? "ready" : (referenceDataUrl ? "ready" : "idle"));
      $("ref-bottom").hidden = false;
    },
    handleHidden() {
      if (!isActive()) return;
      if (session && !session.stopped) session.stop("hidden");
      else stopCamera();
      selfie.stop();
      clearCountdown();
      if (uiState === "capture" || uiState === "generating" || uiState === "live") setUiState(referenceDataUrl ? "ready" : "idle");
    },
    handlePageHide() {
      if (session && !session.stopped) session.stop("pagehide");
      stopCamera();
      selfie.stop();
      clearCountdown();
    },
    get hasLiveSession() { return Boolean(session && !session.stopped); },
    get state() { return uiState; },
  };
}
