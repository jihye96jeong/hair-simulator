import { decodeReferenceBitmap, downscaleBitmap, toUploadDataUrl, validateReferenceFile } from "./hairReference.js";
import { REFERENCE_ENHANCE, buildHairPrompt } from "./hairPrompt.js";
import { CAP_SECONDS, REFERENCE_SESSION_KEY } from "./shared.js";
import { RealtimeSession } from "./session.js";
import { openFrontCamera, stopMediaStream } from "./camera.js";
import { captureFrame, downloadCapture } from "./capture.js";
import { createSelfieCapture } from "./selfie.js";

const $ = (id) => document.getElementById(id);

const STATES = Object.freeze(["idle", "ready", "capture", "generating", "live"]);

/** Simplified reference hair UI: upload → start → auto capture/preview → Lucy. */
export function createReferenceFlow({
  isActive,
  reportEnd,
  onGlobalError,
  getAnchor = () => "on",
  getPrivacy = () => ({}),
  isLab = false,
  getRefMode = () => "preview",
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
  let hairSpec = null;
  let hairPromptText = "";
  let describePromise = null;
  let describeReady = false;
  let describeError = null;
  let selfieDataUrl = "";
  let previewBlob = null;
  let previewDataUrl = "";
  let previewFailCount = 0;
  let consented = false;
  let detailOpen = false;
  let countdownTimer = null;
  let captureCanvas = null;

  const selfie = createSelfieCapture({
    video: $("selfie-video"),
    overlay: $("selfie-guide"),
  });

  function textMode() { return isLab && getRefMode() === "text"; }
  function revoke(url) { if (url) URL.revokeObjectURL(url); }
  function setGlobalError(message) { onGlobalError(message); }

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
    if (next === "capture" || next === "generating" || next === "live") hideBanner();
    updateButtons();
  }

  function invalidatePreview() {
    previewBlob = null;
    previewDataUrl = "";
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
      referenceDataUrl = toUploadDataUrl(bitmap);
      setUiState("ready");
      void describeReference(referenceDataUrl, seq);
    } catch (cause) {
      if (seq !== uploadSeq) return;
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
    const response = await fetch("/hair-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person: selfieDataUrl, reference: referenceDataUrl }),
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
    previewBlob = await (await fetch(previewDataUrl)).blob();
    previewFailCount = 0;
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

      const prompt = hairSpec
        ? buildHairPrompt(hairSpec, { withImage: useImage })
        : hairPromptText;
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
