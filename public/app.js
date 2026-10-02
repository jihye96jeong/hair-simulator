import { COMBOS, stateOf, initialStateOf } from "./combos.js";
import { AREAS, CAP_SECONDS, REGIONS, validPhone, normalizePhone } from "./shared.js";
import { RealtimeSession } from "./session.js";
import { openFrontCamera, stopMediaStream } from "./camera.js";
import { captureFrame, downloadCapture } from "./capture.js";
import { createReferenceFlow } from "./referenceFlow.js";

const $ = (id) => document.getElementById(id);
const lab = location.pathname.replace(/\/$/, "") === "/lab";
const params = new URLSearchParams(location.search);
const images = {};
let config;
let combo = "partial";
let mode = "ref";
let anchor = "on";
let screen = "idle";
let camera = null;
let cameraEpoch = 0;
let session = null;
let connecting = false;
let switching = false;
let captureCanvas = null;
let captureCombo = null;
let captureSessionId = null;
let action = "save";
let submitting = false;
let consentAt = null;
let thirdPartyConsentAt = null;
/** Default matches Try-On panel: hair/reference first. */
let activeTab = "reference";

function error(message, target = "error") {
  $(target).textContent = message;
  $(target).hidden = !message;
}
function setStatus(message) { $("status").textContent = message; }
function discardCapture() {
  captureCanvas = null;
  captureCombo = null;
  captureSessionId = null;
  $("captured-image").removeAttribute("src");
  $("captured-image").hidden = true;
  $("contact-preview")?.removeAttribute("src");
  $("saved-image").removeAttribute("src");
  $("lead-form").reset();
  consentAt = thirdPartyConsentAt = null;
}
function showOverlay(id, on) {
  const el = $(id);
  if (el) el.hidden = !on;
}
function showStageLabel(on, text) {
  if (text) $("stage-label").textContent = text;
  $("stage-label").hidden = !on;
}
function clearStage() {
  $("output").srcObject = null;
  $("output").hidden = true;
  $("output").style.transform = "none";
  $("captured-image").hidden = true;
  showStageLabel(true, "연결을 누르면 카메라가 켜집니다");
  $("combo-label").hidden = true;
  $("connection-state").hidden = true;
  $("expected-chip").hidden = true;
  $("remaining").hidden = true;
  $("resolution").hidden = true;
  $("time-bar").hidden = true;
  $("product-actions").hidden = true;
  $("ref-live-actions").hidden = true;
}
function stopCamera() {
  cameraEpoch++;
  stopMediaStream(camera);
  camera = null;
  $("preview").srcObject = null;
}
function usable(key) { return Boolean(COMBOS[key]) && (mode === "text" || (Boolean(images[key]) && (lab || config?.assets?.[key]))); }
function areaKeys(area) { return Object.keys(COMBOS).filter((key) => COMBOS[key].area === area); }
function applyCombo(key) {
  if (COMBOS[key].area !== COMBOS[combo].area) $("pose").value = COMBOS[key].area === "crown" ? "숙임" : "정면";
  combo = key;
  updateButtons();
}
function updateButtons() {
  const live = !session?.stopped && Boolean(session?.rt) && ["connected", "generating"].includes(session?.state);
  const frame = live && $("output").readyState >= 2 && $("output").videoWidth > 0;
  const area = COMBOS[combo].area;
  const busy = connecting || (activeTab === "preset" && screen === "live" && !live);
  for (const button of document.querySelectorAll("[data-area]")) {
    button.classList.toggle("selected", button.dataset.area === area);
    button.setAttribute("aria-pressed", String(button.dataset.area === area));
    button.disabled = !config || !areaKeys(button.dataset.area).some(usable) || busy;
  }
  for (const button of document.querySelectorAll("[data-combo]")) {
    const key = button.dataset.combo;
    button.hidden = COMBOS[key].area !== area;
    button.classList.toggle("selected", key === combo);
    button.setAttribute("aria-pressed", String(key === combo));
    button.disabled = !usable(key) || busy;
  }
  $("prepare").disabled = !config || !usable(combo) || connecting;
  $("experience-start").disabled = $("prepare").disabled;
  if (activeTab === "preset") {
    $("connect").disabled = !config || !usable(combo) || connecting || live;
    $("disconnect").disabled = !(live || camera || connecting);
  }
  for (const id of ["save-result", "referral", "lab-capture"]) $(id).disabled = !frame || switching || connecting;
  $("product-actions").hidden = activeTab !== "preset" || !live || lab;
  $("lab-actions").hidden = !(lab && activeTab === "preset" && live);
  referenceFlow.updateButtons();
}
function reportEnd(payload) {
  const body = new Blob([JSON.stringify(payload)], { type: "application/json" });
  try {
    if (navigator.sendBeacon?.("/session-end", body)) return;
  } catch { /* keepalive fallback */ }
  fetch("/session-end", { method: "POST", body, keepalive: true }).catch(() => console.warn("세션 기록 전송 실패"));
}
function updateResolution() {
  const video = $("output");
  if (activeTab === "preset" && video.videoWidth && video.videoHeight) {
    $("resolution").hidden = false;
    $("resolution").textContent = `${video.videoWidth} × ${video.videoHeight}`;
  } else {
    $("resolution").hidden = true;
  }
  updateButtons();
}
function updateTime(billed, wall) {
  const remaining = Math.max(0, CAP_SECONDS - Math.max(billed, wall));
  $("remaining").hidden = false;
  $("remaining").textContent = `${Math.ceil(remaining)}초 남음`;
  $("time-bar").hidden = false;
  $("time-bar").value = remaining;
}

const referenceFlow = createReferenceFlow({
  isActive: () => activeTab === "reference",
  reportEnd,
  onGlobalError: (message) => error(message),
  getAnchor: () => (lab ? anchor : "on"),
  isLab: lab,
  getRefMode: () => (lab && params.get("refmode") === "text" ? "text" : "preview"),
  getPrivacy: () => config?.privacy || {},
  getSharedEls: () => ({
    video: $("output"),
    label: $("stage-label"),
    status: $("status"),
    connect: $("connect"),
    disconnect: $("disconnect"),
  }),
});

function stopPresetLive(reason = "manual") {
  if (session && !session.stopped) session.stop(reason);
  else {
    stopCamera();
    if (activeTab === "preset") clearStage();
  }
}

function selectTab(next) {
  if (next === activeTab) return;
  if (activeTab === "preset") {
    stopPresetLive("manual");
    stopCamera();
    clearStage();
    showOverlay("contact", false);
    showOverlay("complete", false);
  } else {
    referenceFlow.dispose();
  }
  activeTab = next;
  error("");
  $("tab-reference").setAttribute("aria-pressed", String(next === "reference"));
  $("tab-preset").setAttribute("aria-pressed", String(next === "preset"));
  document.documentElement.classList.toggle("tab-reference", next === "reference");
  $("ref-bottom").hidden = next !== "reference";
  $("preset-bar").hidden = next !== "preset";
  $("preset-actions").hidden = next !== "preset";
  $("status").hidden = next !== "preset";
  $("billing-note").hidden = next !== "preset";
  $("panel-preset").hidden = next !== "preset";
  $("panel-reference").hidden = next !== "reference";
  if (next === "reference") {
    screen = "idle";
    referenceFlow.activate();
  } else {
    setStatus(usable(combo) ? "부위를 고른 뒤 연결을 누르세요." : "참고 이미지가 없습니다.");
    updateButtons();
  }
}

async function startPreset() {
  if (activeTab !== "preset" || connecting || !usable(combo) || document.hidden) return;
  if (session && !session.stopped) return;
  connecting = true;
  error("");
  setStatus("카메라와 Decart에 연결하는 중…");
  updateButtons();
  const epoch = ++cameraEpoch;
  try {
    const sdk = await import("@decartai/sdk");
    const model = sdk.models.realtime("lucy-2.5");
    const stream = await openFrontCamera(model);
    if (epoch !== cameraEpoch || activeTab !== "preset" || document.hidden) {
      stopMediaStream(stream);
      return;
    }
    camera = stream;
    $("preview").srcObject = stream;
    $("output").hidden = false;
    $("output").srcObject = stream;
    $("output").style.transform = "scaleX(-1)";
    showStageLabel(false);
    await $("output").play().catch(() => {});

    const active = new RealtimeSession({
      mode, anchor, combo, experienceType: "preset",
      onState: (state) => {
        if (activeTab !== "preset") return;
        $("connection-state").hidden = false;
        $("connection-state").textContent = { connecting: "연결 중", connected: "연결됨", generating: "생성 중", reconnecting: "재연결 중", disconnected: "종료" }[state];
        updateButtons();
      },
      onTick: (billed, wall) => { if (activeTab === "preset") updateTime(billed, wall); },
      onRemote: (remote) => {
        if (activeTab !== "preset" || active.stopped) return;
        $("output").style.transform = "none";
        $("output").srcObject = remote;
        $("output").hidden = false;
        showStageLabel(false);
        $("combo-label").hidden = false;
        $("combo-label").textContent = COMBOS[combo].label;
        $("expected-chip").hidden = false;
        $("output").play().catch(() => error("영상 재생 대기."));
      },
      onError: (message) => { console.error(message); if (activeTab === "preset") error(message); },
      onStop: ({ reason }) => {
        stopCamera();
        if (activeTab !== "preset") return;
        clearStage();
        screen = "idle";
        if (reason === "capture") return;
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
    screen = "live";
    updateTime(0, 0);
    await active.start(camera, async () => {
      const response = await fetch("/token", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw { publicMessage: body.error };
      return body;
    }, (media, options, token) => sdk.createDecartClient({ apiKey: token, logger: sdk.noopLogger }).realtime.connect(media, options), {
      model: sdk.models.realtime("lucy-2.5"), mirror: "auto", resolution: "720p",
      initialState: initialStateOf(combo, mode, images),
      ...(anchor === "off" ? { queryParams: { self_anchor: "false" } } : {}),
    });
    if (activeTab !== "preset" && !active.stopped) active.stop("manual");
    if (activeTab === "preset" && !active.stopped) setStatus("연결됨. 부위·모수를 바꾸며 확인할 수 있습니다.");
  } catch (cause) {
    console.error(cause);
    stopCamera();
    clearStage();
    if (activeTab === "preset") {
      error(cause?.publicMessage || cause?.message || "연결에 실패했습니다");
      setStatus($("error").textContent);
    }
    session?.stop("error");
  } finally {
    connecting = false;
    updateButtons();
  }
}

async function selectCombo(key) {
  if (!usable(key) || connecting || activeTab !== "preset") return;
  const previous = combo;
  applyCombo(key);
  $("combo-label").textContent = COMBOS[combo].label;
  if (!session || session.stopped || screen !== "live") return;
  switching = true;
  updateButtons();
  try {
    await session.select(key, stateOf(key, mode, images));
    if (session.stopped) return;
    applyCombo(session.combo);
    $("combo-label").textContent = COMBOS[combo].label;
    error("");
  } catch (cause) {
    console.error(cause);
    applyCombo(session?.stopped ? previous : (session?.combo || previous));
    $("combo-label").textContent = COMBOS[combo].label;
    error("헤어 참고 이미지 변경에 실패했어요.");
  } finally { switching = false; updateButtons(); }
}
function selectArea(area) {
  const keys = areaKeys(area).filter(usable);
  const key = keys.find((key) => COMBOS[key].density === COMBOS[combo].density) || keys[0];
  if (key) return selectCombo(key);
}
function openForm(nextAction) {
  try {
    const canvas = captureFrame($("output"), COMBOS[combo].label);
    captureCanvas = canvas;
    captureCombo = combo;
    captureSessionId = session.sessionId;
    action = nextAction;
    session.stop("capture", true);
    const url = canvas.toDataURL("image/webp", .85);
    $("captured-image").src = url;
    $("contact-preview").src = url;
    $("captured-label").textContent = COMBOS[captureCombo].label;
    $("contact-title").textContent = action === "referral" ? "병원 소개 요청" : "결과 저장";
    $("submit-lead").textContent = action === "referral" ? "병원 소개 요청" : "결과 저장";
    $("third-party").hidden = action !== "referral";
    $("third-consent").required = action === "referral";
    $("lead-form").reset();
    consentAt = thirdPartyConsentAt = null;
    error("", "form-error");
    showOverlay("contact", true);
    updateForm();
  } catch (cause) { error(cause.message || "영상 캡처 실패."); }
}
function updateForm() {
  $("submit-lead").disabled = submitting || !captureCanvas || !$("name").value.trim() || !validPhone($("phone").value) || !$("region").value || !$("consent").checked || (action === "referral" && !$("third-consent").checked);
}
async function submitLead(event) {
  event.preventDefault();
  updateForm();
  if ($("submit-lead").disabled || submitting) return;
  submitting = true;
  updateForm();
  error("", "form-error");
  try {
    const payload = {
      name: $("name").value.trim(), phone: normalizePhone($("phone").value), region: $("region").value,
      area: COMBOS[captureCombo].area, density: COMBOS[captureCombo].density, action, consentAt,
      ...(action === "referral" ? { thirdPartyConsentAt } : {}),
      image: captureCanvas.toDataURL("image/webp", .85), sessionId: captureSessionId,
    };
    const response = await fetch("/leads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    $("complete-title").textContent = action === "referral" ? "소개 요청 접수 완료" : "저장 완료";
    $("complete-message").textContent = action === "referral" ? "병원 소개 요청 제출 완료" : "이미지 저장 완료";
    $("saved-image").src = $("contact-preview").src;
    showOverlay("contact", false);
    showOverlay("complete", true);
  } catch (cause) { error(cause.message || "저장 실패.", "form-error"); }
  finally { submitting = false; updateForm(); }
}
function reset() {
  session?.stop("manual");
  stopCamera();
  discardCapture();
  error("");
  clearStage();
  showOverlay("contact", false);
  showOverlay("complete", false);
  screen = "idle";
  if (activeTab === "preset") setStatus("부위를 고른 뒤 연결을 누르세요.");
}

for (const container of document.querySelectorAll("[data-areas]")) {
  for (const area of AREAS) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.area = area;
    button.textContent = area === "crown" ? "정수리" : "헤어라인";
    button.addEventListener("click", () => selectArea(area));
    container.append(button);
  }
}
for (const container of document.querySelectorAll("[data-combos]")) {
  for (const [key, value] of Object.entries(COMBOS)) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.combo = key;
    button.textContent = { partial: "부분", "1k": "1천 모", "2k": "2천 모" }[value.density];
    const description = document.createElement("small");
    description.textContent = (value.area === "crown" ? { partial: "중앙 희박", "1k": "정수리 중심", "2k": "정수리 전체" } : { partial: "모서리", "1k": "채우기", "2k": "전체" })[value.density];
    button.append(description);
    button.addEventListener("click", () => selectCombo(key));
    container.append(button);
  }
}
for (const region of REGIONS) $("region").add(new Option(region, region));

$("connect").addEventListener("click", () => {
  if (activeTab === "preset") void startPreset();
});
$("disconnect").addEventListener("click", () => {
  if (activeTab === "reference") {
    referenceFlow.stopLive("manual");
    setStatus("연결을 끊었습니다.");
  } else {
    session?.stop("manual");
  }
});
$("prepare").addEventListener("click", () => { if (activeTab === "preset") void startPreset(); });
$("experience-start").addEventListener("click", () => { if (activeTab === "preset") void startPreset(); });
$("retry").addEventListener("click", reset);
$("save-result").addEventListener("click", () => openForm("save"));
$("referral").addEventListener("click", () => openForm("referral"));
$("lab-capture").addEventListener("click", () => {
  try {
    const canvas = captureFrame($("output"), COMBOS[combo].label);
    session.captured = true;
    downloadCapture(canvas, { mode, anchor, combo, pose: $("pose").value });
  } catch (cause) { error(cause.message); }
});
$("close-form").addEventListener("click", () => { showOverlay("contact", false); discardCapture(); });
$("complete-back").addEventListener("click", () => { showOverlay("complete", false); discardCapture(); reset(); });
$("lead-form").addEventListener("input", updateForm);
$("lead-form").addEventListener("submit", submitLead);
$("consent").addEventListener("change", () => { consentAt = $("consent").checked ? new Date().toISOString() : null; updateForm(); });
$("third-consent").addEventListener("change", () => { thirdPartyConsentAt = $("third-consent").checked ? new Date().toISOString() : null; updateForm(); });
$("download-saved").addEventListener("click", () => captureCanvas && downloadCapture(captureCanvas, { mode, anchor, combo: captureCombo, pose: COMBOS[captureCombo].area === "crown" ? "숙임" : "정면" }));
for (const event of ["loadeddata", "resize", "playing"]) $("output").addEventListener(event, updateResolution);
$("output").addEventListener("click", () => $("output").play().catch(() => {}));

$("tab-reference").addEventListener("click", () => selectTab("reference"));
$("tab-preset").addEventListener("click", () => selectTab("preset"));
document.querySelector(".modes").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const order = ["reference", "preset"];
  const index = order.indexOf(activeTab);
  const next = event.key === "Home" ? "reference"
    : event.key === "End" ? "preset"
      : order[(index + (event.key === "ArrowRight" ? 1 : -1) + order.length) % order.length];
  selectTab(next);
  $(`tab-${next}`).focus();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) return;
  if (activeTab === "reference") referenceFlow.handleHidden();
  else if (session && !session.stopped) session.stop("hidden");
  else if (camera) { stopCamera(); clearStage(); }
});
window.addEventListener("pagehide", () => {
  if (activeTab === "reference") referenceFlow.handlePageHide();
  else {
    session?.stop("pagehide");
    stopCamera();
    if (!submitting) discardCapture();
  }
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  if (activeTab === "reference") referenceFlow.dispose();
  else reset();
});

async function initialize() {
  $("ref-bottom").hidden = false;
  $("preset-bar").hidden = true;
  $("preset-actions").hidden = true;
  $("status").hidden = true;
  $("billing-note").hidden = true;
  document.documentElement.classList.add("tab-reference");
  $("tab-reference").setAttribute("aria-pressed", "true");
  $("tab-preset").setAttribute("aria-pressed", "false");
  updateButtons();
  try {
    const response = await fetch("/config");
    if (!response.ok) throw new Error();
    config = await response.json();
    mode = lab && ["ref", "text"].includes(params.get("mode")) ? params.get("mode") : config.mode;
    anchor = lab ? (params.get("anchor") === "off" ? "off" : "on") : config.anchor;
    console.info("simulator", { mode, anchor, lab });
    $("lab-conditions").textContent = `mode=${mode} · anchor=${anchor} · mirror=auto`;
    $("privacy-text").textContent = `수집 주체: ${config.privacy.operator}. 목적: 예상 이미지 저장 및 요청한 안내. 항목: 이름, 휴대폰, 지역, 선택 부위·모수, 예상 이미지, 동의 시각. 보관 기간: ${config.privacy.retention}.`;
    $("referral-text").textContent = `제공받는 자: ${config.privacy.recipient}. 목적: 요청한 지역의 병원 소개 및 상담 안내. 제공 항목: 이름, 휴대폰, 지역, 선택 부위·모수, 예상 이미지. 보관 기간: ${config.privacy.retention}.`;
    await Promise.all(Object.entries(COMBOS).map(async ([key, value]) => {
      try {
        let image = await fetch(`/${value.image}`);
        if (!image.ok && lab) image = await fetch(`/assets/placeholder_${key}.webp`);
        if (image.ok) images[key] = await image.blob();
      } catch { /* ignore */ }
    }));
    if (!usable(combo)) applyCombo(Object.keys(COMBOS).find(usable) || "partial");
    setStatus("이미지를 고른 뒤 연결을 누르세요.");
    referenceFlow.activate();
    updateButtons();
  } catch {
    error("설정 로드 실패. 새로고침 후 재시도하십시오.");
  }
}
initialize();
