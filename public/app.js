import { REGIONS, validPhone, normalizePhone } from "./shared.js";
import { chipLabel, ruleFor } from "./graftRules.js";
import { createReferenceFlow } from "./referenceFlow.js";
import { createGraftFlow } from "./graftFlow.js";
import { captureFrame, downloadCapture } from "./capture.js";

const $ = (id) => document.getElementById(id);
const lab = location.pathname.replace(/\/$/, "") === "/lab";
const params = new URLSearchParams(location.search);
let config;
let mode = "ref";
let anchor = "on";
let captureCanvas = null;
let captureMeta = null;
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

function discardCapture() {
  captureCanvas = null;
  captureMeta = null;
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

function clearSharedStage() {
  $("output").srcObject = null;
  $("output").hidden = true;
  $("output").style.transform = "none";
  $("captured-image").hidden = true;
  $("stage-label").hidden = true;
  $("combo-label").hidden = true;
  $("connection-state").hidden = true;
  $("expected-chip").hidden = true;
  $("remaining").hidden = true;
  $("resolution").hidden = true;
  $("time-bar").hidden = true;
  $("product-actions").hidden = true;
}

function reportEnd(payload) {
  const body = new Blob([JSON.stringify(payload)], { type: "application/json" });
  try {
    if (navigator.sendBeacon?.("/session-end", body)) return;
  } catch { /* keepalive fallback */ }
  fetch("/session-end", { method: "POST", body, keepalive: true }).catch(() => console.warn("세션 기록 전송 실패"));
}

function getLabRefOptions() {
  if (!lab) return {};
  const opts = {};
  const refmode = params.get("refmode");
  if (refmode === "text" || refmode === "preview") opts.refmode = refmode;
  const promptmode = params.get("promptmode");
  if (promptmode === "spec" || promptmode === "image") opts.promptmode = promptmode;
  const lucyprompt = params.get("lucyprompt");
  if (lucyprompt) opts.lucyprompt = lucyprompt;
  if (params.get("anchor") === "off") opts.anchor = "off";
  else if (params.get("anchor") === "on") opts.anchor = "on";
  const editmodel = params.get("editmodel");
  if (editmodel) opts.editmodel = editmodel;
  return opts;
}

const referenceFlow = createReferenceFlow({
  isActive: () => activeTab === "reference",
  reportEnd,
  onGlobalError: (message) => error(message),
  getAnchor: () => getLabRefOptions().anchor || "on",
  isLab: lab,
  getLabOptions: getLabRefOptions,
  getPrivacy: () => config?.privacy || {},
});

const graftFlow = createGraftFlow({
  isActive: () => activeTab === "preset",
  reportEnd,
  onGlobalError: (message) => error(message),
  getAnchor: () => (lab && params.get("anchor") === "off" ? "off" : "on"),
  getEnhance: () => {
    if (typeof window.__graftLabEnhance === "boolean") return window.__graftLabEnhance;
    if (params.get("enhance") === "true") return true;
    if (params.get("enhance") === "false") return false;
    return Boolean(config?.graftEnhanceDefault);
  },
  getEditModel: () => (lab ? (params.get("editmodel") || "") : ""),
  isLab: lab,
});

function updateButtons() {
  if (activeTab === "preset") {
    graftFlow.updateButtons();
    return;
  }
  referenceFlow.updateButtons();
}

function selectTab(next) {
  if (next === activeTab) return;
  if (activeTab === "preset") {
    graftFlow.deactivate();
    clearSharedStage();
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
  $("panel-preset").hidden = next !== "preset";
  $("panel-reference").hidden = next !== "reference";
  if (next === "reference") {
    graftFlow.deactivate();
    referenceFlow.activate();
  } else {
    referenceFlow.dispose?.();
    clearSharedStage();
    graftFlow.activate();
  }
  updateButtons();
}

function openForm(nextAction) {
  try {
    const meta = graftFlow.currentLeadMeta();
    const grafts = meta.density === "1k" ? 1000 : meta.density === "3k" ? 3000 : 2000;
    const areaKey = meta.area;
    const label = chipLabel(areaKey, grafts, ruleFor(areaKey, grafts).sizeCm);
    const canvas = captureFrame($("output"), label);
    captureCanvas = canvas;
    captureMeta = meta;
    captureSessionId = meta.sessionId;
    action = nextAction;
    graftFlow.stopLive("capture");
    const url = canvas.toDataURL("image/webp", 0.85);
    $("captured-image").src = url;
    $("contact-preview").src = url;
    $("captured-label").textContent = label;
    $("contact-title").textContent = action === "referral" ? "병원 소개 요청" : "결과 저장";
    $("submit-lead").textContent = action === "referral" ? "병원 소개 요청" : "결과 저장";
    $("third-party").hidden = action !== "referral";
    $("third-consent").required = action === "referral";
    $("lead-form").reset();
    consentAt = thirdPartyConsentAt = null;
    error("", "form-error");
    showOverlay("contact", true);
    updateForm();
  } catch (cause) {
    error(cause.message || "영상 캡처 실패.");
  }
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
      name: $("name").value.trim(),
      phone: normalizePhone($("phone").value),
      region: $("region").value,
      area: captureMeta.area,
      density: captureMeta.density,
      action,
      consentAt,
      ...(action === "referral" ? { thirdPartyConsentAt } : {}),
      image: captureCanvas.toDataURL("image/webp", 0.85),
      sessionId: captureSessionId,
    };
    const response = await fetch("/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    $("complete-title").textContent = action === "referral" ? "소개 요청 접수 완료" : "저장 완료";
    $("complete-message").textContent = action === "referral" ? "병원 소개 요청 제출 완료" : "이미지 저장 완료";
    $("saved-image").src = $("contact-preview").src;
    showOverlay("contact", false);
    showOverlay("complete", true);
  } catch (cause) {
    error(cause.message || "저장 실패.", "form-error");
  } finally {
    submitting = false;
    updateForm();
  }
}

for (const region of REGIONS) $("region").add(new Option(region, region));

$("disconnect").addEventListener("click", () => {
  if (activeTab === "reference") referenceFlow.stopLive("manual");
  else graftFlow.stopLive("manual");
});
$("save-result").addEventListener("click", () => openForm("save"));
$("referral").addEventListener("click", () => openForm("referral"));
$("lab-capture").addEventListener("click", () => {
  try {
    const meta = graftFlow.currentLeadMeta();
    const grafts = meta.density === "1k" ? 1000 : meta.density === "3k" ? 3000 : 2000;
    const canvas = captureFrame($("output"), chipLabel(meta.area, grafts, ruleFor(meta.area, grafts).sizeCm));
    downloadCapture(canvas, { mode, anchor, combo: meta.combo, pose: meta.area === "crown" ? "숙임" : "정면" });
  } catch (cause) {
    error(cause.message);
  }
});
$("close-form").addEventListener("click", () => { showOverlay("contact", false); discardCapture(); });
$("complete-back").addEventListener("click", () => {
  showOverlay("complete", false);
  discardCapture();
  if (activeTab === "preset") graftFlow.activate();
});
$("lead-form").addEventListener("input", updateForm);
$("lead-form").addEventListener("submit", submitLead);
$("consent").addEventListener("change", () => {
  consentAt = $("consent").checked ? new Date().toISOString() : null;
  updateForm();
});
$("third-consent").addEventListener("change", () => {
  thirdPartyConsentAt = $("third-consent").checked ? new Date().toISOString() : null;
  updateForm();
});
$("download-saved").addEventListener("click", () => {
  if (!captureCanvas || !captureMeta) return;
  downloadCapture(captureCanvas, {
    mode,
    anchor,
    combo: captureMeta.combo,
    pose: captureMeta.area === "crown" ? "숙임" : "정면",
  });
});
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
  else graftFlow.stopLive("hidden");
});
window.addEventListener("pagehide", () => {
  if (activeTab === "reference") referenceFlow.handlePageHide();
  else {
    graftFlow.stopLive("pagehide");
    if (!submitting) discardCapture();
  }
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  if (activeTab === "reference") referenceFlow.dispose();
  else graftFlow.deactivate();
});

async function initialize() {
  $("ref-bottom").hidden = false;
  $("preset-bar").hidden = true;
  $("preset-actions").hidden = true;
  $("status").hidden = true;
  $("billing-note").hidden = true;
  $("graft-disclaimer").hidden = true;
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
    referenceFlow.activate();
    updateButtons();
  } catch {
    error("설정 로드 실패. 새로고침 후 재시도하십시오.");
  }
}
initialize();
