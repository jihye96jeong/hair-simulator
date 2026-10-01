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
let screen = "welcome";
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
  $("step-label").textContent = lab ? "기술 검증" : ({ welcome: "내 얼굴로 보는 헤어라인", selection: "1 / 4 선택", preparation: "2 / 4 준비", experience: "3 / 4 체험", contact: "4 / 4 결과", complete: "저장 완료", ended: "체험 종료" }[next]);
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
  $("camera-message").textContent = "카메라 권한을 요청하고 있어요.";
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("휴대폰에서는 HTTPS 주소로 접속해 주세요.");
    const portrait = matchMedia("(orientation: portrait)").matches;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: portrait ? { facingMode: "user" } : { facingMode: "user", width: 1280, height: 720 } });
    if (epoch !== cameraEpoch || document.hidden || screen !== "preparation") { stream.getTracks().forEach((track) => track.stop()); return; }
    camera = stream;
    $("preview").srcObject = stream;
    await $("preview").play();
    $("camera-message").textContent = "준비가 되면 아래 버튼을 눌러 주세요. 아직 체험 연결 전이에요.";
    updateButtons();
  } catch (cause) {
    if (epoch !== cameraEpoch) return;
    stopCamera();
    const message = cause.name === "NotAllowedError" ? "카메라 접근을 허용한 뒤 다시 시작해 주세요." : cause.name === "NotFoundError" ? "사용할 수 있는 카메라를 찾지 못했어요." : "카메라를 열지 못했어요. 카메라 권한과 HTTPS 주소를 확인해 주세요.";
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
      $("connection-state").textContent = { connecting: "연결 중", connected: "연결됨", generating: "체험 중", reconnecting: "다시 연결 중", disconnected: "종료" }[state];
      updateButtons();
    },
    onTick: updateTime,
    onRemote: (stream) => { $("output").srcObject = stream; $("output").play().catch(() => error("영상 재생을 위해 화면을 다시 눌러 주세요.")); },
    onError: (message) => { console.error(message); error(message); },
    onStop: ({ reason }) => {
      stopCamera();
      $("output").srcObject = null;
      $("connection-state").textContent = "종료";
      if (reason === "capture") return;
      $("ended-title").textContent = reason === "cap" ? "시간이 끝났어요" : "체험이 끝났어요";
      $("ended-message").textContent = { hidden: "다른 화면으로 이동해 체험을 종료했어요.", manual: "내 헤어라인의 변화를 비교해 보셨나요?", error: "연결 상태를 확인한 뒤 다시 시작해 주세요.", disconnected: "연결이 종료되었어요. 다시 체험할 수 있어요." }[reason] || "다시 시작하면 다른 모수도 비교할 수 있어요.";
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
    error("체험 연결을 준비하지 못했어요. 잠시 후 다시 시도해 주세요.");
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
    error("모수를 바꾸지 못했어요. 연결 상태를 확인해 주세요.");
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
    $("contact-title").textContent = action === "referral" ? "병원 소개를 요청해 볼까요?" : "내 결과를 남겨 볼까요?";
    $("submit-lead").textContent = action === "referral" ? "병원 소개 요청하기" : "결과 저장하기";
    $("third-party").hidden = action !== "referral";
    $("third-consent").required = action === "referral";
    $("lead-form").reset();
    consentAt = thirdPartyConsentAt = null;
    error("", "form-error");
    show("contact");
    updateForm();
  } catch (cause) { error(cause.message || "현재 영상을 캡처하지 못했어요."); }
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
    $("complete-title").textContent = action === "referral" ? "소개 요청을 남겼어요" : "결과를 저장했어요";
    $("complete-message").textContent = action === "referral" ? "선택한 지역과 연락처로 소개 의사를 기록했어요. 아래에서 내 예상 이미지를 내려받을 수 있어요." : "내 예상 이미지를 아래에서 내려받을 수 있어요.";
    $("saved-image").src = $("captured-image").src;
    $("saved-stage").style.aspectRatio = `${captureCanvas.width} / ${captureCanvas.height}`;
    show("complete");
  } catch (cause) { error(cause.message || "저장하지 못했어요. 다시 시도해 주세요.", "form-error"); }
  finally { submitting = false; $("close-form").disabled = false; updateForm(); }
}
function reset() {
  session?.stop("manual");
  stopCamera();
  discardCapture();
  error("");
  show("welcome");
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
$("start").addEventListener("click", () => show("selection"));
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
  $("start").disabled = true;
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
      error("헤어라인 이미지를 준비하고 있어요. 준비가 끝나면 체험할 수 있습니다.");
    }
    if (mode === "ref" && !images[combo]) error("헤어라인 이미지를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
    if (lab && mode === "ref" && !config.assets[combo]) error("현재 회색 플레이스홀더입니다. 실제 머리 참고 이미지로 교체한 뒤 얼굴·모수 차이를 검증하세요.");
    $("start").disabled = false;
    updateButtons();
  } catch { error("화면을 준비하지 못했어요. 새로고침 후 다시 시도해 주세요."); }
}
initialize();
