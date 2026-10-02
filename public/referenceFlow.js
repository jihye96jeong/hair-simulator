import {
  REFERENCE_HAIR_PROMPT,
  analyzeReference,
  cropFromManual,
  faceFromManual,
  processReference,
  validateReferenceFile,
} from "./hairReference.js";
import { CAP_SECONDS, REFERENCE_SESSION_KEY } from "./shared.js";
import { RealtimeSession } from "./session.js";
import { openFrontCamera, stopMediaStream } from "./camera.js";
import { captureFrame, downloadCapture } from "./capture.js";

const $ = (id) => document.getElementById(id);

/** Try-On panel–identical reference hair controller (one screen). */
export function createReferenceFlow({
  isActive,
  reportEnd,
  onGlobalError,
  getAnchor = () => "on",
  getSharedEls,
}) {
  let camera = null;
  let cameraEpoch = 0;
  let session = null;
  let connecting = false;
  let switching = false;
  let uploadSeq = 0;
  let applySeq = 0;
  let analysis = null;
  let originalUrl = null;
  let processedBlob = null;
  let protectedReady = false;
  let captureCanvas = null;

  function els() {
    return getSharedEls ? getSharedEls() : {
      video: $("output"),
      label: $("stage-label"),
      status: $("status"),
      connect: $("connect"),
      disconnect: $("disconnect"),
    };
  }

  function setError(message) { onGlobalError(message); }
  function setStatus(message) { els().status.textContent = message; $("ref-status").textContent = message; }
  function revoke(url) { if (url) URL.revokeObjectURL(url); }

  function showLabel(on, text) {
    const label = els().label;
    if (text) label.textContent = text;
    label.hidden = !on;
  }

  function clearVideo() {
    const video = els().video;
    video.srcObject = null;
    video.hidden = true;
    showLabel(true, "연결을 누르면 카메라가 켜집니다");
    $("connection-state").hidden = true;
    $("expected-chip").hidden = true;
    $("remaining").hidden = true;
    $("resolution").hidden = true;
    $("combo-label").hidden = true;
    $("ref-live-actions").hidden = true;
    $("time-bar").hidden = true;
  }

  function showStream(stream, { remote = false } = {}) {
    const video = els().video;
    video.hidden = false;
    video.srcObject = stream;
    video.style.transform = remote ? "none" : "scaleX(-1)";
    showLabel(false);
    void video.play().catch(() => undefined);
  }

  function stopCamera() {
    cameraEpoch++;
    stopMediaStream(camera);
    camera = null;
  }

  function clearUpload() {
    uploadSeq++;
    applySeq++;
    if (analysis?.bitmap) {
      try { analysis.bitmap.close(); } catch { /* ignore */ }
    }
    analysis = null;
    processedBlob = null;
    protectedReady = false;
    revoke(originalUrl);
    originalUrl = null;
    $("ref").removeAttribute("src");
    $("ref").hidden = true;
    $("clear").hidden = true;
    $("drop-label").textContent = "상품 이미지를 여기에 놓으세요";
    $("ref-file").value = "";
    $("ref-replace-file").value = "";
    $("ref-manual").hidden = true;
    setStatus("이미지를 고른 뒤 연결을 누르세요.");
    updateButtons();
  }

  function stopLive(reason = "manual") {
    if (session && !session.stopped) session.stop(reason);
    else {
      stopCamera();
      if (isActive()) clearVideo();
    }
  }

  function dispose() {
    stopLive("manual");
    stopCamera();
    clearUpload();
    captureCanvas = null;
    setError("");
    if (isActive()) clearVideo();
  }

  function updateButtons() {
    const live = !session?.stopped && Boolean(session?.rt) && ["connected", "generating"].includes(session?.state);
    const frame = live && els().video.readyState >= 2 && els().video.videoWidth > 0;
    const { connect, disconnect } = els();
    if (isActive()) {
      connect.disabled = !protectedReady || !processedBlob || connecting || live;
      disconnect.disabled = !(live || camera || connecting);
    }
    $("clear").hidden = !analysis;
    $("ref-replace").disabled = !live || connecting || switching;
    $("ref-capture").disabled = !frame || connecting || switching;
    $("ref-connect").disabled = connect.disabled;
    $("ref-disconnect").disabled = disconnect.disabled;
    $("ref-prepare").disabled = connect.disabled;
    $("ref-start").disabled = connect.disabled;
  }

  function updateTime(billed, wall) {
    const remaining = Math.max(0, CAP_SECONDS - Math.max(billed, wall));
    $("remaining").textContent = `${Math.ceil(remaining)}초 남음`;
    $("time-bar").value = remaining;
    $("ref-remaining").textContent = $("remaining").textContent;
    $("ref-time-bar").value = remaining;
  }

  function updateResolution() {
    const video = els().video;
    if (video.videoWidth && video.videoHeight) {
      $("resolution").hidden = false;
      $("resolution").textContent = `${video.videoWidth} × ${video.videoHeight}`;
    }
    updateButtons();
  }

  function manualValues() {
    return {
      top: Number($("ref-crop-top").value) / 100,
      bottom: Number($("ref-crop-bottom").value) / 100,
      left: Number($("ref-crop-left").value) / 100,
      right: Number($("ref-crop-right").value) / 100,
      cx: Number($("ref-face-x").value) / 100,
      cy: Number($("ref-face-y").value) / 100,
      rw: Number($("ref-face-w").value) / 100,
      rh: Number($("ref-face-h").value) / 100,
    };
  }

  async function applyProtection({ face, cropOverride = null, length = "long" }) {
    if (!analysis?.bitmap) return false;
    const result = await processReference({ bitmap: analysis.bitmap, face, cropOverride, length });
    processedBlob = null;
    protectedReady = false;
    if (!result.blob || !result.protected) {
      setStatus(result.status);
      updateButtons();
      return false;
    }
    processedBlob = result.blob;
    protectedReady = true;
    $("ref-processed").src = URL.createObjectURL(result.blob);
    setStatus(result.status);
    updateButtons();
    return true;
  }

  async function ingestFile(file, { liveReplace = false } = {}) {
    const check = validateReferenceFile(file);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    const seq = ++uploadSeq;
    setError("");
    setStatus("이미지를 읽는 중…");
    try {
      if (analysis?.bitmap) {
        try { analysis.bitmap.close(); } catch { /* ignore */ }
      }
      processedBlob = null;
      protectedReady = false;
      revoke(originalUrl);
      originalUrl = URL.createObjectURL(file);
      $("ref").src = originalUrl;
      $("ref").hidden = false;
      $("clear").hidden = false;
      $("drop-label").textContent = "다른 이미지로 바꿀 수 있습니다";
      $("ref-original").src = originalUrl;
      analysis = await analyzeReference(file);
      if (seq !== uploadSeq || !isActive()) return;

      if (analysis.multiFace) {
        $("ref-manual").hidden = false;
        setStatus(`얼굴이 ${analysis.faces.length}명입니다. 한 명 사진으로 바꾸거나 수동 지정하세요.`);
        updateButtons();
        return;
      }
      if (analysis.needsManual) {
        $("ref-manual").hidden = false;
        if (liveReplace) {
          const defaults = { left: 0, right: 0, top: 0, bottom: 0, cx: 0.5, cy: 0.42, rw: 0.3, rh: 0.36 };
          const ok = await applyProtection({
            face: faceFromManual(analysis.width, analysis.height, defaults),
            cropOverride: cropFromManual(analysis.width, analysis.height, defaults),
          });
          if (ok && session && !session.stopped) await pushReferenceToSession(processedBlob);
          return;
        }
        setStatus("얼굴을 찾지 못했습니다. 수동으로 얼굴 보호를 확정하세요.");
        updateButtons();
        return;
      }
      $("ref-manual").hidden = true;
      const ok = await applyProtection({ face: analysis.primary, length: "long" });
      if (!ok || seq !== uploadSeq || !isActive()) return;
      if (liveReplace && session && !session.stopped) await pushReferenceToSession(processedBlob);
      else setStatus("얼굴 보호 준비됨. 연결을 누르세요.");
    } catch (cause) {
      if (seq !== uploadSeq) return;
      console.error(cause);
      setError(cause.message || "이미지를 처리하지 못했습니다.");
      setStatus("이미지 처리에 실패했습니다.");
      updateButtons();
    }
  }

  async function confirmManual() {
    if (!analysis?.bitmap) return;
    const values = manualValues();
    const ok = await applyProtection({
      face: faceFromManual(analysis.width, analysis.height, values),
      cropOverride: cropFromManual(analysis.width, analysis.height, values),
    });
    if (ok) setStatus("얼굴 보호 준비됨. 연결을 누르세요.");
    if (ok && session && !session.stopped && isActive()) await pushReferenceToSession(processedBlob);
  }

  async function pushReferenceToSession(blob) {
    if (!session || session.stopped || !blob) return;
    const seq = ++applySeq;
    switching = true;
    updateButtons();
    setStatus("레퍼런스를 적용하는 중…");
    try {
      await session.setHairReference(blob, REFERENCE_HAIR_PROMPT, { enhance: true });
      if (seq !== applySeq || !isActive() || session.stopped) return;
      setStatus("적용했습니다. 얼굴이 화면 중앙에 있으면 더 안정적입니다.");
      setError("");
    } catch (cause) {
      if (seq !== applySeq) return;
      console.error(cause);
      setError("레퍼런스 적용에 실패했어요.");
      setStatus("적용에 실패했습니다. 다시 시도하세요.");
    } finally {
      if (seq === applySeq) {
        switching = false;
        updateButtons();
      }
    }
  }

  async function connect() {
    if (!isActive() || !protectedReady || !processedBlob || connecting) return;
    if (session && !session.stopped) return;
    connecting = true;
    setError("");
    setStatus("카메라와 Decart에 연결하는 중…");
    updateButtons();
    const epoch = ++cameraEpoch;
    try {
      const sdk = await import("@decartai/sdk");
      const model = sdk.models.realtime("lucy-2.5");
      const stream = await openFrontCamera(model);
      if (epoch !== cameraEpoch || !isActive() || document.hidden) {
        stopMediaStream(stream);
        return;
      }
      camera = stream;
      showStream(stream, { remote: false });

      const active = new RealtimeSession({
        mode: "ref",
        anchor: getAnchor(),
        combo: REFERENCE_SESSION_KEY,
        experienceType: "reference",
        onState: (state) => {
          if (!isActive()) return;
          $("connection-state").hidden = false;
          $("connection-state").textContent = {
            connecting: "연결 중", connected: "연결됨", generating: "생성 중",
            reconnecting: "재연결 중", disconnected: "종료",
          }[state] || state;
          updateButtons();
        },
        onTick: (billed, wall) => {
          if (!isActive()) return;
          $("remaining").hidden = false;
          $("time-bar").hidden = false;
          updateTime(billed, wall);
        },
        onRemote: (remote) => {
          if (!isActive() || active.stopped) return;
          showStream(remote, { remote: true });
          $("expected-chip").hidden = false;
          $("ref-live-actions").hidden = false;
        },
        onError: (message) => { console.error(message); if (isActive()) setError(message); },
        onStop: ({ reason }) => {
          stopCamera();
          if (!isActive()) return;
          clearVideo();
          if (reason === "capture") {
            setStatus("캡처했습니다. 연결을 끊었습니다.");
            return;
          }
          setStatus({
            hidden: "화면 이탈로 연결이 종료되었습니다.",
            manual: "연결을 끊었습니다.",
            error: "연결 오류. 네트워크를 확인하세요.",
            disconnected: "원격 연결이 종료되었습니다.",
            cap: "세션 120초가 끝나 연결을 끊었습니다.",
          }[reason] || "연결이 종료되었습니다.");
          updateButtons();
        },
        report: reportEnd,
      });
      session = active;
      updateTime(0, 0);
      await active.start(camera, async () => {
        const response = await fetch("/token", { method: "POST" });
        const body = await response.json();
        if (!response.ok) throw { publicMessage: body.error };
        return body;
      }, (media, options, token) => sdk.createDecartClient({ apiKey: token, logger: sdk.noopLogger }).realtime.connect(media, options), {
        model: sdk.models.realtime("lucy-2.5"),
        mirror: "auto",
        resolution: "720p",
        initialState: {
          prompt: { text: REFERENCE_HAIR_PROMPT, enhance: true },
          image: processedBlob,
        },
      });
      if (!isActive() && !active.stopped) active.stop("manual");
      if (isActive() && !active.stopped) setStatus("연결됨. 이미지의 Try-On을 바꾸거나 캡처하세요.");
    } catch (cause) {
      console.error(cause);
      if (epoch !== cameraEpoch) return;
      stopCamera();
      clearVideo();
      const message = cause?.code === "camera-denied" ? "카메라 권한이 거부되었습니다."
        : cause?.code === "camera-missing" ? "사용 가능한 카메라가 없습니다."
          : (cause?.publicMessage || cause?.message || "연결에 실패했습니다");
      setError(message);
      setStatus(message);
      session?.stop("error");
    } finally {
      connecting = false;
      updateButtons();
    }
  }

  function captureResult() {
    try {
      const canvas = captureFrame(els().video, "레퍼런스 헤어");
      captureCanvas = canvas;
      session.stop("capture", true);
      stopCamera();
      downloadCapture(canvas, { mode: "ref", anchor: getAnchor(), combo: REFERENCE_SESSION_KEY, pose: "정면" });
      $("ref-captured-image").src = canvas.toDataURL("image/png");
      clearVideo();
      setStatus("캡처 PNG를 저장했습니다.");
    } catch (cause) {
      setError(cause.message || "캡처에 실패했습니다.");
    }
  }

  function bind() {
    $("ref-file").addEventListener("change", () => {
      const file = $("ref-file").files?.[0];
      if (file) void ingestFile(file);
    });
    $("ref-replace").addEventListener("click", () => $("ref-replace-file").click());
    $("ref-replace-file").addEventListener("change", () => {
      const file = $("ref-replace-file").files?.[0];
      if (file) void ingestFile(file, { liveReplace: true });
    });
    const drop = $("drop");
    drop.addEventListener("dragover", (event) => { event.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (event) => {
      event.preventDefault();
      drop.classList.remove("over");
      const file = [...(event.dataTransfer?.files || [])].find((item) => item.type.startsWith("image/"));
      if (file) void ingestFile(file);
    });
    $("clear").addEventListener("click", () => {
      stopLive("manual");
      clearUpload();
      clearVideo();
    });
    $("ref-clear").addEventListener("click", () => $("clear").click());
    $("ref-confirm-manual").addEventListener("click", () => { void confirmManual(); });
    $("ref-capture").addEventListener("click", captureResult);
    $("ref-connect").addEventListener("click", () => { void connect(); });
    $("ref-disconnect").addEventListener("click", () => {
      stopLive("manual");
      setStatus("연결을 끊었습니다.");
    });
    $("ref-prepare").addEventListener("click", () => { void connect(); });
    $("ref-start").addEventListener("click", () => { void connect(); });
    $("ref-pick").addEventListener("click", () => $("ref-file").click());
    for (const event of ["loadeddata", "resize", "playing"]) {
      els().video.addEventListener(event, () => { if (isActive()) updateResolution(); });
    }
  }

  bind();
  clearVideo();
  setStatus("이미지를 고른 뒤 연결을 누르세요.");

  return {
    connect,
    dispose,
    stopLive,
    stopCamera,
    clearVideo,
    updateButtons,
    activate() {
      $("drop").hidden = false;
      updateButtons();
      setStatus(protectedReady ? "얼굴 보호 준비됨. 연결을 누르세요." : "이미지를 고른 뒤 연결을 누르세요.");
    },
    handleHidden() {
      if (!isActive()) return;
      if (session && !session.stopped) session.stop("hidden");
      else if (camera) {
        stopCamera();
        clearVideo();
      }
    },
    handlePageHide() {
      if (session && !session.stopped) session.stop("pagehide");
      stopCamera();
    },
    get hasLiveSession() { return Boolean(session && !session.stopped); },
    get screen() { return "ref-upload"; },
  };
}
