import { decodeReferenceBitmap, downscaleBitmap, prepareReferenceUpload, validateReferenceFile } from "./hairReference.js";
import { HAIR_LENGTHS, IMAGE_HAIR_PROMPT, REFERENCE_ENHANCE, buildHairPrompt, buildImageHairPrompt } from "./hairPrompt.js";
import { CAP_SECONDS, REFERENCE_SESSION_KEY } from "./shared.js";
import { RealtimeSession } from "./session.js";
import { openFrontCamera, stopMediaStream, videoTrackSettings } from "./camera.js";
import { captureFrame, downloadCapture } from "./capture.js";
import { hairDrifted, lockHairOntoUser } from "./hairFaceLock.js";
import { startLiveFaceLock } from "./liveFaceLock.js";
import { createPortraitStream } from "./portraitStream.js";
import { aspectRatioForLength, createSelfieCapture } from "./selfie.js";

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

/**
 * Simplified reference hair UI: upload → start → auto capture/preview → Lucy live.
 * On the live screen Lucy's video is shown with the user's own face pasted in, time-synced
 * to Lucy's delay (see liveFaceLock.js).
 */
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
  let portrait = null;
  let liveFace = null;
  let remoteVideo = null;
  let liveInfo = { camera: "", input: "", mirror: false, output: "", sync: "" };
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
  let identityDataUrl = "";
  let angleDataUrl = "";
  let previewBlob = null;
  let previewDataUrl = "";
  let geminiPreviewDataUrl = "";
  let lockedMaskDataUrl = "";
  let previewScores = [];
  let previewSelectedIndex = null;
  let previewCandidates = [];
  let previewReferenceCore = null;
  /** Hair length measured on the face-locked still ({ length, reach, clipped }) or null. */
  let previewHairLength = null;
  let previewFailCount = 0;
  let captureAspectRatio = "";
  let consented = false;
  let detailOpen = false;
  let countdownTimer = null;
  let captureCanvas = null;
  let lastLucyPrompt = "";
  let lastLucyEnhance = REFERENCE_ENHANCE;
  let lastLucyImage = null;
  let hairDriftedLive = false;
  let reanchorCount = 0;
  let lastReanchorAt = 0;
  let reanchorPending = false;
  let liveStartedAt = 0;
  let headWasTurned = false;
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
    return buildImageHairPrompt(lucySpec());
  }
  function promptKind(useImage, prompt) {
    const opts = labOptions();
    if (opts.lucyprompt) return "lucyprompt";
    if (!useImage || opts.promptmode === "spec") return "spec-text";
    if (prompt === IMAGE_HAIR_PROMPT) return "IMAGE_HAIR_PROMPT";
    if (prompt.includes("Keep the hairstyle already shown in this attached photo")) return "IMAGE_HAIR_PROMPT+spec";
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

  function attachLabMediaActions(figure, captionText, filename) {
    const cap = document.createElement("figcaption");
    cap.textContent = captionText;
    const row = document.createElement("div");
    row.className = "ref-lab-actions";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "ref-lab-copy";
    copyBtn.textContent = "복사";
    copyBtn.addEventListener("click", () => {
      const img = figure.querySelector("img");
      void copyLabImage(img, copyBtn);
    });
    const dl = document.createElement("a");
    dl.className = "ref-lab-download";
    dl.textContent = "저장";
    dl.download = filename || "lab.png";
    dl.addEventListener("click", (event) => {
      const img = figure.querySelector("img");
      if (!img?.src) {
        event.preventDefault();
        return;
      }
      dl.href = img.src;
    });
    row.append(copyBtn, dl);
    figure.append(cap, row);
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
    const maskedFig = mkFigure("ref-lab-masked", "가린 레퍼런스");
    attachLabMediaActions(maskedFig, "0 masked reference", "00-masked-reference.jpg");
    const selfieFig = mkFigure("ref-lab-selfie", "크롭 촬영본");
    attachLabMediaActions(selfieFig, "1 selfie crop", "01-selfie.jpg");
    const identityFig = mkFigure("ref-lab-identity", "얼굴 클로즈업");
    attachLabMediaActions(identityFig, "1b identity close-up", "01b-identity.jpg");
    const compositeFig = mkFigure("ref-lab-composite", "Gemini 선택본");
    attachLabMediaActions(compositeFig, "3 selected Gemini preview (face-lock base)", "03-gemini-selected.jpg");
    const maskFig = mkFigure("ref-lab-refine-mask", "얼굴 고정 마스크");
    attachLabMediaActions(maskFig, "3b face-lock mask (white = webcam face pixels)", "03b-face-mask.png");
    const finalFig = mkFigure("ref-lab-final", "Lucy 입력");
    attachLabMediaActions(finalFig, "4 final still sent to Lucy", "04-lucy-input.jpg");
    const candidatesEl = document.createElement("div");
    candidatesEl.id = "ref-lab-candidates";
    candidatesEl.className = "ref-lab-candidates";
    const promptEl = document.createElement("pre");
    promptEl.id = "ref-lab-prompt";
    const title = document.createElement("h2");
    title.className = "graft-lab-title";
    title.textContent = "헤어 /lab";
    panel.append(title, maskedFig, selfieFig, identityFig, candidatesEl, compositeFig, maskFig, finalFig, promptEl);
    ($("lab-data-view") || $("stage").parentElement).append(panel);
    labDebug = panel;
    return panel;
  }

  function updateLabDebug({ prompt, enhance } = {}) {
    if (!isLab) return;
    const panel = ensureLabDebug();
    if (!panel) return;
    const setSrc = (sel, url) => {
      const el = panel.querySelector(sel);
      if (!el) return;
      if (url) el.src = url;
      else el.removeAttribute("src");
    };
    setSrc("#ref-lab-masked", maskedReferenceDataUrl);
    setSrc("#ref-lab-selfie", selfieDataUrl);
    setSrc("#ref-lab-identity", identityDataUrl);
    setSrc("#ref-lab-composite", geminiPreviewDataUrl);
    setSrc("#ref-lab-refine-mask", lockedMaskDataUrl);
    setSrc("#ref-lab-final", previewDataUrl);
    const candidatesEl = panel.querySelector("#ref-lab-candidates");
    const promptEl = panel.querySelector("#ref-lab-prompt");
    candidatesEl.innerHTML = "";
    for (const cand of previewCandidates) {
      const wrap = document.createElement("figure");
      wrap.className = "ref-lab-candidate ref-lab-shot";
      const img = document.createElement("img");
      img.alt = `gemini candidate ${cand.index}`;
      if (cand.image) img.src = cand.image;
      wrap.append(img);
      const fields = ["front", "forehead", "sides"];
      const lines = fields.map((field) => {
        const row = cand.core?.[field];
        const ref = row?.ref ?? previewReferenceCore?.[field] ?? "—";
        const val = row?.cand ?? cand.candidate?.[field] ?? "—";
        const ok = row?.match ? "match" : "miss";
        return `${field}: ref=${ref} cand=${val} (${ok})`;
      });
      attachLabMediaActions(
        wrap,
        `2 candidate #${cand.index}${cand.selected || cand.index === previewSelectedIndex ? " ← selected" : ""} sim=${cand.similarity ?? "—"}/10 match=${cand.hairMatch}/3\n${lines.join("\n")}`,
        `candidate-${cand.index}.jpg`,
      );
      candidatesEl.append(wrap);
    }
    const length = hairSpec?.length || "—";
    const cropAspect = captureAspectRatio || (hairSpec?.length ? aspectRatioForLength(hairSpec.length) : "—");
    const geminiAspect = hairSpec?.length ? aspectRatioForLength(hairSpec.length) : "—";
    const promptText = prompt ?? lastLucyPrompt;
    const enhanceVal = enhance ?? lastLucyEnhance;
    promptEl.textContent = [
      `spec.length=${length} bangs=${hairSpec?.bangs || "—"} part=${hairSpec?.part || "—"} front=${hairSpec?.front || "—"} forehead=${hairSpec?.forehead || "—"} crop=${cropAspect} geminiAspect=${geminiAspect} drift=${hairDriftedLive ? "yes" : "no"} reanchor=${reanchorCount} measured=${previewHairLength ? `${previewHairLength.length} (${previewHairLength.reach.toFixed(2)} face heights below chin${previewHairLength.clipped ? ", clipped" : ""})` : "—"} lucy.length=${lucySpec()?.length || "—"}`,
      `5 Lucy live: camera=${liveInfo.camera || "—"} input=${liveInfo.input || "—"} mirror=${liveInfo.mirror} output=${liveInfo.output || "—"}`,
      `5b face sync: ${liveInfo.sync || "—"}`,
      `3 Lucy prompt / enhance`,
      `enhance=${enhanceVal}`,
      promptText,
    ].join("\n");
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
    // Data stays visible in the LAB 데이터 view after the session ends.
    showLabDebug(next === "live" || (isLab && (previewCandidates.length > 0 || Boolean(selfieDataUrl))));
    if (next === "capture" || next === "generating" || next === "live") hideBanner();
    updateButtons();
  }

  function invalidatePreview() {
    previewBlob = null;
    previewDataUrl = "";
    geminiPreviewDataUrl = "";
    lockedMaskDataUrl = "";
    previewScores = [];
    previewSelectedIndex = null;
    previewCandidates = [];
    previewReferenceCore = null;
    previewHairLength = null;
    lastLucyImage = null;
    hairDriftedLive = false;
    reanchorCount = 0;
    lastReanchorAt = 0;
    reanchorPending = false;
    liveStartedAt = 0;
    headWasTurned = false;
    previewFailCount = 0;
    captureAspectRatio = "";
    identityDataUrl = "";
    angleDataUrl = "";
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
    liveFace?.stop();
    liveFace = null;
    portrait?.stop();
    portrait = null;
    stopMediaStream(camera);
    camera = null;
    $("live-face-lock").hidden = true;
    if (remoteVideo) {
      remoteVideo.pause();
      remoteVideo.srcObject = null;
      remoteVideo.remove();
      remoteVideo = null;
    }
  }

  /** Hidden <video> that plays Lucy's remote stream for the face-sync compositor. */
  function ensureRemoteVideo() {
    if (remoteVideo) return remoteVideo;
    remoteVideo = document.createElement("video");
    remoteVideo.muted = true;
    remoteVideo.playsInline = true;
    remoteVideo.autoplay = true;
    remoteVideo.setAttribute("aria-hidden", "true");
    remoteVideo.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:0";
    document.body.appendChild(remoteVideo);
    return remoteVideo;
  }

  /** Lucy's output on screen (already mirrored by the SDK); the composite canvas shares its box. */
  function showLiveStream(stream) {
    const video = $("output");
    video.hidden = false;
    video.srcObject = stream;
    video.style.transform = "none";
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
    const payload = {
      person: selfieDataUrl,
      reference: maskedReferenceDataUrl,
      spec: hairSpec,
      labDebug: isLab,
      editModel: opts.editmodel || undefined,
    };
    if (identityDataUrl) payload.identity = identityDataUrl;
    if (angleDataUrl) payload.angle = angleDataUrl;
    const response = await fetch("/hair-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (uploadSeq !== uploadAtStart) return null;
    previewScores = Array.isArray(body.scores) ? body.scores : [];
    previewSelectedIndex = Number.isInteger(body.selectedIndex) ? body.selectedIndex : null;
    previewCandidates = Array.isArray(body.candidates) ? body.candidates : [];
    previewReferenceCore = body.reference || null;
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
    previewBlob = await (await fetch(previewDataUrl)).blob();
    geminiPreviewDataUrl = previewDataUrl;
    if (uploadSeq !== uploadAtStart) return null;
    const locked = await lockFaceOnPreview(uploadAtStart);
    if (uploadSeq !== uploadAtStart) return null;
    if (locked) {
      previewDataUrl = locked.dataUrl;
      previewBlob = locked.blob;
    }
    previewFailCount = 0;
    updateLabDebug();
    return previewBlob;
  }

  /**
   * Face lock: Gemini's styled frame keeps its hair and hairline; the webcam face
   * (brows to jaw) is aligned and blended back so the features are the user's own pixels.
   * Any failure keeps the plain Gemini preview.
   */
  async function lockFaceOnPreview(uploadAtStart) {
    const locked = await lockHairOntoUser({
      personDataUrl: selfieDataUrl,
      styledBlob: previewBlob,
    }).catch(() => null);
    if (uploadSeq !== uploadAtStart) return null;
    previewHairLength = locked?.hairLength || null;
    if (!locked?.blob) return null;
    lockedMaskDataUrl = locked.maskDataUrl;
    return { dataUrl: locked.dataUrl, blob: locked.blob };
  }

  /**
   * Length Lucy is told: the analysed length, or what the styled still really shows when that
   * is longer (hair visibly reaching further down is hard evidence; a shorter measure may just
   * be the segmenter missing thin ends or the still being cut off at the bottom).
   */
  function lucySpec() {
    if (!hairSpec) return null;
    const measured = previewHairLength;
    if (!measured?.length || HAIR_LENGTHS.indexOf(measured.length) <= HAIR_LENGTHS.indexOf(hairSpec.length)) return hairSpec;
    return { ...hairSpec, length: measured.length };
  }

  /** How long Lucy is left to settle after connect / a re-push before another re-push. */
  const REANCHOR_SETTLE_MS = 2500;
  /** Minimum gap between style-image re-pushes (Lucy flashes if this is too frequent). */
  const REANCHOR_GAP_MS = 3000;
  /** Nose offset (eye-spans) that counts as a turn, and as back to front. */
  const YAW_TURN = 0.18;
  const YAW_FRONT = 0.08;

  /**
   * Push the styled still again. A turn that arrives during the gap is remembered and sent
   * on the next stats tick once the gap has passed.
   */
  function maybeReanchor(active, imageBlob, prompt) {
    if (!active || !imageBlob || active.stopped) return;
    const now = performance.now();
    if (now - liveStartedAt < REANCHOR_SETTLE_MS || now - lastReanchorAt < REANCHOR_GAP_MS) {
      reanchorPending = true;
      return;
    }
    reanchorPending = false;
    lastReanchorAt = now;
    reanchorCount += 1;
    void active.setHairReference(imageBlob, prompt).catch(() => {
      lastReanchorAt = 0;
      reanchorPending = true;
    });
  }

  /** True on the tick the head crosses into a turn, or back to the front. */
  function headTurnedEdge(yaw) {
    if (!Number.isFinite(yaw)) return false;
    const turned = Math.abs(yaw) >= YAW_TURN;
    if (turned && !headWasTurned) {
      headWasTurned = true;
      return true;
    }
    if (headWasTurned && Math.abs(yaw) <= YAW_FRONT) {
      headWasTurned = false;
      return true;
    }
    return false;
  }

  /**
   * Lucy live: the webcam (as a 9:16 portrait stream, same framing as the capture step) goes to
   * Lucy with the face-locked preview as the style image. Lucy's output is shown on screen and
   * the face-sync compositor pastes the user's own face from the matching webcam moment on top,
   * so the features are the user's and move together with Lucy's hair.
   */
  async function connectLucy({ useImage, prompt, imageBlob, seq, uploadAtStart }) {
    connecting = true;
    updateButtons();
    const epoch = ++cameraEpoch;
    try {
      const sdk = await import("@decartai/sdk");
      const model = sdk.models.realtime("lucy-2.5");
      const stream = await openFrontCamera(model, { portrait: true });
      if (epoch !== cameraEpoch || !isActive() || document.hidden || seq !== runSeq || uploadSeq !== uploadAtStart) {
        stopMediaStream(stream);
        return;
      }
      camera = stream;
      const cameraSettings = videoTrackSettings(stream);
      const cameraIsPortrait = Number(cameraSettings.height) > Number(cameraSettings.width);
      portrait = cameraIsPortrait
        ? { stream, portrait: true, source: "camera", stop() {} }
        : { ...createPortraitStream(stream), source: "crop" };
      const lucyInput = portrait.stream;
      // Mirror unless the camera says it faces away from the user.
      const mirror = cameraSettings.facingMode !== "environment";
      liveInfo = {
        camera: `${cameraSettings.width || "?"}×${cameraSettings.height || "?"}`,
        input: portrait.source,
        mirror,
        output: "",
        sync: "",
      };
      setUiState("live");
      // The compositor draws in webcam orientation; flip the canvas the same way the SDK mirrors Lucy.
      $("live-face-lock").style.transform = mirror ? "scaleX(-1)" : "none";

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
          showLiveStream(remote);
          const styledVideo = ensureRemoteVideo();
          styledVideo.srcObject = remote;
          void styledVideo.play().catch(() => undefined);
          const noteOutput = () => {
            if (styledVideo.videoWidth > 0) {
              liveInfo.output = `${styledVideo.videoWidth}×${styledVideo.videoHeight}`;
              updateLabDebug();
            }
          };
          styledVideo.addEventListener("loadedmetadata", noteOutput, { once: true });
          noteOutput();
          liveFace?.stop();
          liveFace = startLiveFaceLock({
            sourceStream: lucyInput,
            styledVideo,
            canvas: $("live-face-lock"),
            mirror,
            onStats: (stats) => {
              const timing = Object.entries(stats.timing || {}).map(([k, v]) => `${k}=${v}ms`).join(" ");
              hairDriftedLive = Boolean(
                lastLucyImage
                && previewHairLength
                && hairDrifted(stats.hair?.lucy, previewHairLength, stats.hair?.webcam),
              );
              if (hairDriftedLive || headTurnedEdge(stats.yaw) || reanchorPending) {
                maybeReanchor(active, lastLucyImage, lastLucyPrompt);
              }
              liveInfo.sync = `latency=${stats.latencyMs}ms lucy=${stats.lucyFps}fps composite=${stats.compositeFps}fps cam=${stats.webcamFps}fps misses=${stats.misses} dropped=${stats.dropped} yaw=${Number(stats.yaw || 0).toFixed(2)} [${stats.mode || "…"}] ${timing}${stats.lastError ? ` err=${stats.lastError}` : ""}${hairDriftedLive ? " drift" : ""}`;
              updateLabDebug();
            },
          });
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
      lastLucyEnhance = REFERENCE_ENHANCE;
      lastLucyImage = useImage ? imageBlob : null;
      liveStartedAt = performance.now();
      lastReanchorAt = 0;
      reanchorPending = false;
      reanchorCount = 0;
      headWasTurned = false;
      hairDriftedLive = false;
      updateLabDebug({ prompt, enhance: lastLucyEnhance });
      await logPipelineTrace({ useImage, prompt, imageBlob });
      console.info("ref-live-input", liveInfo);
      const initialState = useImage
        ? { prompt: { text: prompt, enhance: REFERENCE_ENHANCE }, image: imageBlob }
        : { prompt: { text: prompt, enhance: REFERENCE_ENHANCE } };
      await active.start(lucyInput, async () => {
        const response = await fetch("/token", { method: "POST" });
        const body = await response.json();
        if (!response.ok) throw { publicMessage: body.error };
        return body;
      }, (media, options, token) => sdk.createDecartClient({ apiKey: token, logger: sdk.noopLogger }).realtime.connect(media, options), {
        model: sdk.models.realtime("lucy-2.5"),
        mirror,
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

      $("ref-countdown").hidden = false;
      $("ref-countdown").textContent = "헤어 분석 중…";
      const okDescribe = await waitDescribe(uploadAtStart);
      clearCountdown();
      if (!okDescribe || seq !== runSeq || uploadSeq !== uploadAtStart) return;
      if (!hairSpec?.length) {
        setUiState("ready");
        showBanner("헤어 분석을 마치지 못했어요.", "다시 시도", () => startExperience());
        return;
      }

      const shot = await selfie.capture({ length: hairSpec.length });
      angleDataUrl = "";
      captureAspectRatio = shot.aspectRatio || aspectRatioForLength(hairSpec.length);
      selfieDataUrl = shot.dataUrl;
      identityDataUrl = shot.identityDataUrl || "";
      $("ref-freeze").src = selfieDataUrl;
      setUiState("generating");
      updateLabDebug();

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
      // The compositor canvas is drawn in webcam orientation; flip it to match the mirrored Lucy output.
      const canvas = captureFrame($("output"), "레퍼런스 헤어", liveFace?.active() ? $("live-face-lock") : null, {
        overlayMirror: liveInfo.mirror,
      });
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
      if (session && !session.stopped) session.stop("manual");
      else stopCamera();
      selfie.stop();
      clearCountdown();
      for (const id of ["ref-layer-idle", "ref-layer-ready", "ref-layer-capture", "ref-layer-generating"]) {
        $(id).hidden = true;
      }
      $("ref-live-thumb").hidden = true;
      $("ref-stage-banner").hidden = true;
      $("ref-ready-bar").hidden = true;
      $("ref-live-bar").hidden = true;
      $("ref-bottom").hidden = true;
      const lab = $("ref-lab-debug");
      if (lab) lab.hidden = true;
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
