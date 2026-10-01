import { COMBOS, stateOf, initialStateOf } from "./combos.js";
import { CAP_SECONDS, REGIONS, validPhone, normalizePhone } from "./shared.js";
import { RealtimeSession } from "./session.js";
import { captureFrame, downloadCapture } from "./capture.js";

const $ = (id) => document.getElementById(id);
const lab = location.pathname.replace(/\/$/, "") === "/lab";
const params = new URLSearchParams(location.search);
const images = {};
let config;
let combo = "partial";
let mode = "ref";
let anchor = "on";
let screen = "selection";
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

function error(message, target = "error") {
  $(target).textContent = message;
  $(target).hidden = !message;
}
function discardCapture() {
  captureCanvas = null;
  captureCombo = null;
  captureSessionId = null;
  $("captured-image").removeAttribute("src");
  $("saved-image").removeAttribute("src");
  $("lead-form").reset();
  consentAt = thirdPartyConsentAt = null;
}
function show(next) {
  if (["contact", "complete"].includes(screen) && !["contact", "complete"].includes(next)) discardCapture();
  screen = next;
  for (const section of document.querySelectorAll(".screen")) section.hidden = section.id !== next;
  updateButtons();
}
function stopCamera() {
  cameraEpoch++;
  for (const track of camera?.getTracks() || []) track.stop();
  camera = null;
  $("preview").srcObject = null;
}
function usable(key) { return mode === "text" || (Boolean(images[key]) && (lab || config?.assets?.[key])); }
function updateButtons() {
  const live = !session?.stopped && Boolean(session?.rt) && ["connected", "generating"].includes(session?.state);
  const frame = live && $("output").readyState >= 2 && $("output").videoWidth > 0;
  for (const button of document.querySelectorAll("[data-combo]")) {
    const key = button.dataset.combo;
    button.classList.toggle("selected", key === combo);
    button.setAttribute("aria-pressed", String(key === combo));
    button.disabled = !usable(key) || (screen === "experience" && (!live || switching || connecting));
  }
  $("prepare").disabled = !config || !usable(combo) || connecting;
  $("experience-start").disabled = !camera || connecting || !usable(combo);
  for (const id of ["save-result", "referral", "lab-capture"]) $(id).disabled = !frame || switching || connecting;
  $("retry").disabled = connecting;
  $("disconnect").disabled = Boolean(session?.stopped);
}
function reportEnd(payload) {
  const body = new Blob([JSON.stringify(payload)], { type: "application/json" });
  try {
    if (navigator.sendBeacon?.("/session-end", body)) return;
  } catch { /* use keepalive fallback */ }
  fetch("/session-end", { method: "POST", body, keepalive: true }).catch(() => console.warn("세션 기록 전송 실패"));
}
function updateResolution() {
  const video = $("output");
  if (video.videoWidth && video.videoHeight) {
    $("resolution").textContent = `${video.videoWidth} × ${video.videoHeight}`;
    video.parentElement.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  }
  updateButtons();
}
function updateTime(billed, wall) {
  const remaining = Math.max(0, CAP_SECONDS - Math.max(billed, wall));
  $("remaining").textContent = `${Math.ceil(remaining)}초 남음`;
  $("time-bar").value = remaining;
}
async function prepareCamera() {
  if (!config || !usable(combo) || connecting) return;
  error("");
  show("preparation");
  const epoch = ++cameraEpoch;
  $("camera-message").textContent = "카메라 권한 요청 중";
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("카메라 사용에 HTTPS 연결이 필요합니다.");
    const portrait = matchMedia("(orientation: portrait)").matches;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: portrait ? { facingMode: "user" } : { facingMode: "user", width: 1280, height: 720 } });
    if (epoch !== cameraEpoch || document.hidden || screen !== "preparation") { stream.getTracks().forEach((track) => track.stop()); return; }
    camera = stream;
    $("preview").srcObject = stream;
    await $("preview").play();
    $("camera-message").textContent = "카메라 준비 완료 · 실시간 연결 대기";
    updateButtons();
  } catch (cause) {
    if (epoch !== cameraEpoch) return;
    stopCamera();
    const message = cause.name === "NotAllowedError" ? "카메라 권한이 거부되었습니다. 접근 허용 후 재시도하십시오." : cause.name === "NotFoundError" ? "사용 가능한 카메라가 없습니다." : "카메라 초기화 실패. 권한 및 HTTPS 연결을 확인하십시오.";
    $("camera-message").textContent = message;
    error(message);
    updateButtons();
  }
}
async function startExperience() {
  if (connecting || !camera || !usable(combo) || document.hidden) return;
  connecting = true;
  error("");
  show("experience");
  $("output").srcObject = null;
  $("resolution").textContent = "";
  $("connection-state").textContent = "연결 중";
  $("combo-label").textContent = COMBOS[combo].label;
  updateTime(0, 0);
  const active = new RealtimeSession({
    mode, anchor, combo,
    onState: (state) => {
      $("connection-state").textContent = { connecting: "연결 중", connected: "연결됨", generating: "생성 중", reconnecting: "재연결 중", disconnected: "종료" }[state];
      updateButtons();
    },
    onTick: updateTime,
    onRemote: (stream) => { $("output").srcObject = stream; $("output").play().catch(() => error("영상 재생 대기. 영상을 누르면 재생됩니다.")); },
    onError: (message) => { console.error(message); error(message); },
    onStop: ({ reason }) => {
      stopCamera();
      $("output").srcObject = null;
      $("connection-state").textContent = "종료";
      if (reason === "capture") return;
      $("ended-title").textContent = reason === "cap" ? "시간 종료" : "연결 종료";
      $("ended-message").textContent = { hidden: "화면 이탈로 연결이 종료되었습니다.", manual: "연결을 종료했습니다.", error: "연결 오류. 네트워크 상태를 확인하십시오.", disconnected: "원격 연결이 종료되었습니다." }[reason] || "최대 연결 시간 120초에 도달했습니다.";
      if (!["contact", "complete"].includes(screen)) show("ended");
      updateButtons();
    }, report: reportEnd,
  });
  session = active;
  updateButtons();
  try {
    const sdk = await import("@decartai/sdk");
    if (active.stopped) return;
    await active.start(camera, async () => {
      const response = await fetch("/token", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw { publicMessage: body.error };
      return body;
    }, (stream, options, token) => sdk.createDecartClient({ apiKey: token, logger: sdk.noopLogger }).realtime.connect(stream, options), {
      model: sdk.models.realtime("lucy-2.5"), mirror: "auto", resolution: "720p",
      initialState: initialStateOf(combo, mode, images),
      ...(anchor === "off" ? { queryParams: { self_anchor: "false" } } : {}),
    });
  } catch {
    error("연결 초기화 실패. 잠시 후 재시도하십시오.");
    active.stop("error");
  } finally {
    connecting = false;
    updateButtons();
  }
}
async function selectCombo(key) {
  if (!usable(key) || switching || connecting) return;
  if (screen !== "experience") { combo = key; updateButtons(); return; }
  switching = true;
  updateButtons();
  try {
    if (await session.select(key, stateOf(key, mode, images))) {
      combo = key;
      $("combo-label").textContent = COMBOS[combo].label;
    }
  } catch {
    error("모수 변경 실패. 연결 상태를 확인하십시오.");
  } finally { switching = false; updateButtons(); }
}
function openForm(nextAction) {
  try {
    const canvas = captureFrame($("output"), COMBOS[combo].label);
    captureCanvas = canvas;
    captureCombo = combo;
    captureSessionId = session.sessionId;
    action = nextAction;
    // Stop before image serialization or opening the contact form.
    session.stop("capture", true);
    $("captured-image").src = canvas.toDataURL("image/webp", .85);
    $("captured-image").parentElement.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
    $("captured-label").textContent = COMBOS[captureCombo].label;
    $("contact-title").textContent = action === "referral" ? "병원 소개 요청" : "결과 저장";
    $("submit-lead").textContent = action === "referral" ? "병원 소개 요청" : "결과 저장";
    $("third-party").hidden = action !== "referral";
    $("third-consent").required = action === "referral";
    $("lead-form").reset();
    consentAt = thirdPartyConsentAt = null;
    error("", "form-error");
    show("contact");
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
  $("close-form").disabled = true;
  error("", "form-error");
  try {
    const payload = {
      name: $("name").value.trim(), phone: normalizePhone($("phone").value), region: $("region").value,
      area: "hairline", density: captureCombo, action, consentAt,
      ...(action === "referral" ? { thirdPartyConsentAt } : {}),
      image: captureCanvas.toDataURL("image/webp", .85), sessionId: captureSessionId,
    };
    const response = await fetch("/leads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    $("complete-title").textContent = action === "referral" ? "소개 요청 접수 완료" : "저장 완료";
    $("complete-message").textContent = action === "referral" ? "병원 소개 요청 제출 완료 · PNG 다운로드 가능" : "이미지 저장 완료 · PNG 다운로드 가능";
    $("saved-image").src = $("captured-image").src;
    $("saved-stage").style.aspectRatio = `${captureCanvas.width} / ${captureCanvas.height}`;
    show("complete");
  } catch (cause) { error(cause.message || "저장 실패. 재시도하십시오.", "form-error"); }
  finally { submitting = false; $("close-form").disabled = false; updateForm(); }
}
function reset() {
  session?.stop("manual");
  stopCamera();
  discardCapture();
  error("");
  show("selection");
}

for (const container of document.querySelectorAll("[data-combos]")) {
  for (const [key] of Object.entries(COMBOS)) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.combo = key;
    button.textContent = { partial: "부분", "1k": "1천 모", "2k": "2천 모" }[key];
    const description = document.createElement("small");
    description.textContent = { partial: "양쪽 모서리", "1k": "헤어라인 채우기", "2k": "앞머리 전체" }[key];
    button.append(description);
    button.addEventListener("click", () => selectCombo(key));
    container.append(button);
  }
}
for (const region of REGIONS) $("region").add(new Option(region, region));
$("prepare").addEventListener("click", prepareCamera);
$("experience-start").addEventListener("click", startExperience);
$("disconnect").addEventListener("click", () => session?.stop("manual"));
$("retry").addEventListener("click", () => { error(""); show("selection"); });
document.querySelectorAll("[data-back]").forEach((button) => button.addEventListener("click", reset));
$("save-result").addEventListener("click", () => openForm("save"));
$("referral").addEventListener("click", () => openForm("referral"));
$("lab-capture").addEventListener("click", () => {
  try {
    const canvas = captureFrame($("output"), COMBOS[combo].label);
    session.captured = true;
    downloadCapture(canvas, { mode, anchor, combo, pose: $("pose").value });
  } catch (cause) { error(cause.message); }
});
$("close-form").addEventListener("click", reset);
$("lead-form").addEventListener("input", updateForm);
$("lead-form").addEventListener("submit", submitLead);
$("consent").addEventListener("change", () => { consentAt = $("consent").checked ? new Date().toISOString() : null; updateForm(); });
$("third-consent").addEventListener("change", () => { thirdPartyConsentAt = $("third-consent").checked ? new Date().toISOString() : null; updateForm(); });
$("download-saved").addEventListener("click", () => captureCanvas && downloadCapture(captureCanvas, { mode, anchor, combo: captureCombo, pose: "정면" }));
for (const event of ["loadeddata", "resize", "playing"]) $("output").addEventListener(event, updateResolution);
$("output").addEventListener("click", () => $("output").play().catch(() => {}));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) return;
  if (session && !session.stopped) session.stop("hidden");
  else if (camera || screen === "preparation") { stopCamera(); show("selection"); }
});
window.addEventListener("pagehide", () => { session?.stop("pagehide"); stopCamera(); if (!submitting) discardCapture(); });
window.addEventListener("pageshow", (event) => { if (event.persisted) reset(); });

async function initialize() {
  updateButtons();
  try {
    const response = await fetch("/config");
    if (!response.ok) throw new Error();
    config = await response.json();
    mode = lab && ["ref", "text"].includes(params.get("mode")) ? params.get("mode") : config.mode;
    anchor = lab ? (params.get("anchor") === "off" ? "off" : "on") : config.anchor;
    console.info("simulator", { mode, anchor, lab, orientation: "portrait UI / native remote output" });
    $("product-actions").hidden = lab;
    $("lab-actions").hidden = !lab;
    $("lab-conditions").textContent = `mode=${mode} · anchor=${anchor} · mirror=auto`;
    $("privacy-text").textContent = `수집 주체: ${config.privacy.operator}. 목적: 예상 이미지 저장 및 요청한 안내. 항목: 이름, 휴대폰, 지역, 선택 부위·모수, 예상 이미지, 동의 시각. 보관 기간: ${config.privacy.retention}.`;
    $("referral-text").textContent = `제공받는 자: ${config.privacy.recipient}. 목적: 요청한 지역의 병원 소개 및 상담 안내. 제공 항목: 이름, 휴대폰, 지역, 선택 부위·모수, 예상 이미지. 보관 기간: ${config.privacy.retention}.`;
    await Promise.all(Object.entries(COMBOS).map(async ([key, value]) => {
      try {
        let image = await fetch(`/${value.image}`);
        if (!image.ok && lab) image = await fetch(`/assets/placeholder_${key}.webp`);
        if (image.ok) images[key] = await image.blob();
      } catch { /* unavailable references are disabled; text mode remains usable */ }
    }));
    if (!usable(combo)) {
      combo = Object.keys(COMBOS).find(usable) || "partial";
      error("참고 이미지 미등록. 이미지 등록 후 연결할 수 있습니다.");
    }
    if (mode === "ref" && !images[combo]) error("참고 이미지 로드 실패. 새로고침 후 재시도하십시오.");
    if (lab && mode === "ref" && !config.assets[combo]) error("현재 회색 플레이스홀더입니다. 실제 머리 참고 이미지로 교체한 뒤 얼굴·모수 차이를 검증하세요.");
    show("selection");
  } catch { error("설정 로드 실패. 새로고침 후 재시도하십시오."); }
}
initialize();
