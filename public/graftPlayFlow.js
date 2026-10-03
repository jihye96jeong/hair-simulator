/**
 * 모수2 tab — plant grafts by touch on the live camera picture.
 *
 * Camera → hidden <video>. Each video frame is cropped to a portrait picture and queued for a
 * short moment (about one landmark detection, 60–300 ms). Face landmarks (worker when
 * possible) produce keyframes: the affine transform from the reference head frame to that
 * frame. The picture shown is always a frame whose head pose is known, interpolated between
 * the two keyframes around it, so the planted hair and the head come from the same instant —
 * no drift when the user moves, at the full camera frame rate.
 *
 * Runs fully on the device: no network, no cost, no identity drift.
 */
import { openFrontCamera, stopMediaStream, videoTrackSettings } from "./camera.js";
import { createFaceDetectorAsync } from "./liveFaceLock.js";
import {
  DEFAULT_GOAL,
  GOALS,
  GRAFTS_PER_TAP,
  STRAND_MIN_PX,
  STRAND_WIDTH_CM,
  affineFromPoints,
  affineScale,
  applyAffine,
  blendAffine,
  createPlanting,
  growth,
  headFrame,
  invertAffine,
  landmarkPixels,
  sampleHairColor,
  shadeColors,
  trackPoints,
} from "./graftPlant.js";

const $ = (id) => document.getElementById(id);

/** Landmarks run on a copy no larger than this on its long side. */
const DETECT_MAX_SIDE = 384;
/** Keyframe smoothing (1 = raw landmarks). Interpolation between keyframes smooths further. */
const SMOOTH = 0.7;
/** Display delay = this × the measured detection interval, clamped. */
const DELAY_FACTOR = 1.5;
const DELAY_MIN_MS = 60;
const DELAY_MAX_MS = 350;
/** Frames kept for delayed display. */
const QUEUE_LIMIT = 16;
const KEYFRAME_LIMIT = 8;
/** Hair stays at the last pose this long after the face is lost, then fades out. */
const LOST_HOLD_MS = 700;
const LOST_FADE_MS = 600;
/** Portrait picture: landscape webcams are centre-cropped to this aspect. */
const PICTURE_ASPECT = 3 / 4;
const CAMERA_MODEL = { width: 1280, height: 720, fps: 30 };
const HINT_MS = 1800;

function fmt(n) {
  return n.toLocaleString("ko-KR");
}

export function createGraftPlayFlow({ isActive = () => true, onGlobalError = () => {} } = {}) {
  const canvas = $("plant-canvas");
  const ctx = canvas.getContext("2d");
  const small = document.createElement("canvas");
  const smallCtx = small.getContext("2d");
  const planting = createPlanting({ goal: DEFAULT_GOAL });
  const pool = [];

  let video = null;
  let stream = null;
  let detector = null;
  let rafHandle = 0;
  let rvfcHandle = 0;
  let running = false;
  let starting = false;
  let inflight = false;
  let mirror = true;
  let crop = null;
  let ref = null;
  /** Queued pictures { canvas, t } oldest first; keyframes { t, affine|null } oldest first. */
  let queue = [];
  let keyframes = [];
  let delayMs = 120;
  let detectIntervalMs = 80;
  let lastDetectAt = 0;
  /** Transform used for the picture currently on screen (taps map through it). */
  let displayAffine = null;
  let displayT = 0;
  let lastFaceAt = -Infinity;
  let shades = shadeColors({ mean: [38, 27, 21], std: [10, 8, 7] });
  let showHair = true;
  let hintTimer = 0;
  const stats = { detectMs: 0, renderMs: 0, fps: 0, delayMs: 0, queue: 0 };
  let frames = 0;
  let fpsAt = 0;
  let hudAt = 0;

  function takeCanvas() {
    const c = pool.pop() || document.createElement("canvas");
    if (c.width !== crop.w || c.height !== crop.h) {
      c.width = crop.w;
      c.height = crop.h;
    }
    return c;
  }

  function giveCanvas(c) {
    if (pool.length < QUEUE_LIMIT + 2) pool.push(c);
  }

  function setHint(text, { sticky = false } = {}) {
    const el = $("plant-hint");
    el.textContent = text;
    el.hidden = !text;
    clearTimeout(hintTimer);
    if (text && !sticky) hintTimer = setTimeout(() => { el.hidden = true; }, HINT_MS);
  }

  const tracking = (now) => Boolean(ref && displayAffine) && now - lastFaceAt <= LOST_HOLD_MS;

  function updateHud(now = performance.now()) {
    $("plant-count").textContent = `${fmt(planting.planted)} / ${fmt(planting.goal)}모`;
    $("plant-progress-fill").style.width = `${Math.min(100, (planting.planted / planting.goal) * 100)}%`;
    const state = $("plant-state");
    if (!running) {
      state.hidden = true;
    } else if (!tracking(now)) {
      state.textContent = "얼굴을 찾는 중";
      state.hidden = false;
    } else if (planting.done) {
      state.textContent = planting.growing(now) ? "자라는 중" : "완료";
      state.hidden = false;
    } else if (planting.planted === 0) {
      state.textContent = "심을 곳을 터치";
      state.hidden = false;
    } else {
      state.textContent = planting.growing(now) ? "자라는 중" : `터치당 ${GRAFTS_PER_TAP}모`;
      state.hidden = false;
    }
    $("plant-done").hidden = !(running && planting.done);
    $("plant-done-message").textContent = `${fmt(planting.goal)}모를 모두 심었어요`;
    $("plant-raise").hidden = planting.goal >= GOALS[GOALS.length - 1];
    for (const btn of $("plant-goals").querySelectorAll("button")) {
      btn.setAttribute("aria-pressed", String(Number(btn.dataset.goal) === planting.goal));
    }
    $("plant-reset").disabled = planting.planted === 0;
    $("plant-hold").disabled = !running || planting.planted === 0;
    $("plant-stop").hidden = !running;
    $("plant-start").hidden = running || starting;
    $("plant-hud").hidden = !running;
  }

  function pop(clientX, clientY, text) {
    const layer = $("plant-layer");
    const rect = layer.getBoundingClientRect();
    const el = document.createElement("span");
    el.className = "plant-pop";
    el.textContent = text;
    el.style.left = `${clientX - rect.left}px`;
    el.style.top = `${clientY - rect.top}px`;
    const ring = document.createElement("span");
    ring.className = "plant-ring";
    ring.style.left = el.style.left;
    ring.style.top = el.style.top;
    layer.append(ring, el);
    const remove = (node) => node.addEventListener("animationend", () => node.remove(), { once: true });
    remove(el);
    remove(ring);
    try { navigator.vibrate?.(12); } catch { /* optional */ }
  }

  /** Pointer position → picture pixel, honouring `object-fit: contain` and the mirror. */
  function pictureFromPointer(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !canvas.width || !canvas.height) return null;
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const dw = canvas.width * scale;
    const dh = canvas.height * scale;
    const ox = rect.left + (rect.width - dw) / 2;
    const oy = rect.top + (rect.height - dh) / 2;
    let x = (clientX - ox) / scale;
    const y = (clientY - oy) / scale;
    if (x < 0 || y < 0 || x > canvas.width || y > canvas.height) return null;
    if (mirror) x = canvas.width - x;
    return { x, y };
  }

  /** Head transform at picture time `t`: interpolated between the keyframes around it. */
  function affineAt(t) {
    let before = null;
    let after = null;
    for (const k of keyframes) {
      if (k.t <= t) before = k;
      else { after = k; break; }
    }
    const a = before?.affine ? before : null;
    const b = after?.affine ? after : null;
    if (a && b && b.t > a.t) return blendAffine(a.affine, b.affine, (t - a.t) / (b.t - a.t));
    if (a) return a.affine;
    if (b) return b.affine;
    return displayAffine;
  }

  function drawHair(now, affine) {
    const since = now - lastFaceAt;
    const alpha = since < LOST_HOLD_MS ? 1 : Math.max(0, 1 - (since - LOST_HOLD_MS) / LOST_FADE_MS);
    if (!showHair || !affine || !ref || alpha <= 0 || !planting.patches.length) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.setTransform(affine.a, affine.b, affine.c, affine.d, affine.e, affine.f);
    ctx.lineCap = "round";
    const scale = affineScale(affine);
    ctx.lineWidth = Math.max(STRAND_MIN_PX / scale, STRAND_WIDTH_CM * ref.frame.pxPerCm);
    for (let s = 0; s < shades.length; s++) {
      ctx.strokeStyle = shades[s];
      ctx.beginPath();
      let any = false;
      for (const patch of planting.patches) {
        const g = growth(now - patch.bornAt);
        if (g <= 0.02) continue;
        const arr = patch.shades[s];
        for (let i = 0; i < arr.length; i += 6) {
          const x = arr[i];
          const y = arr[i + 1];
          const dx = arr[i + 2];
          const dy = arr[i + 3];
          const len = arr[i + 4] * g;
          const bend = arr[i + 5];
          ctx.moveTo(x, y);
          ctx.quadraticCurveTo(
            x + dx * len * 0.5 - dy * bend * len,
            y + dy * len * 0.5 + dx * bend * len,
            x + dx * len,
            y + dy * len,
          );
          any = true;
        }
      }
      if (any) ctx.stroke();
    }
    ctx.restore();
  }

  /** Display loop: show the newest queued picture older than the delay, with its head pose. */
  function renderLoop(now) {
    if (!running) return;
    rafHandle = requestAnimationFrame(renderLoop);
    const target = now - delayMs;
    let index = -1;
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].t <= target) index = i;
      else break;
    }
    if (index < 0) {
      if (now - hudAt > 250) { hudAt = now; updateHud(now); }
      return;
    }
    const frame = queue[index];
    for (let i = 0; i < index; i++) giveCanvas(queue[i].canvas);
    queue = queue.slice(index);
    if (frame.t === displayT) return;
    const t0 = performance.now();
    const affine = affineAt(frame.t);
    if (affine) displayAffine = affine;
    displayT = frame.t;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(frame.canvas, 0, 0);
    drawHair(now, displayAffine);
    stats.renderMs += (performance.now() - t0 - stats.renderMs) * 0.2;
    stats.delayMs = Math.round(delayMs);
    stats.queue = queue.length;
    frames += 1;
    if (now - fpsAt >= 1000) {
      stats.fps = frames;
      frames = 0;
      fpsAt = now;
    }
    if (now - hudAt > 250) {
      hudAt = now;
      updateHud(now);
    }
  }

  function pushKeyframe(k) {
    keyframes.push(k);
    if (keyframes.length > KEYFRAME_LIMIT) keyframes.shift();
  }

  function anchor(points, frameCanvas, t) {
    const track = trackPoints(points);
    const frame = headFrame(points);
    if (!track || !frame) {
      pushKeyframe({ t, affine: null });
      return;
    }
    if (!ref) {
      ref = { track, frame };
      pushKeyframe({ t, affine: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } });
      try {
        const rgba = frameCanvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, frameCanvas.width, frameCanvas.height).data;
        shades = shadeColors(sampleHairColor(rgba, frameCanvas.width, frameCanvas.height, points));
      } catch { /* keep default shades */ }
    } else {
      const next = affineFromPoints(ref.track, track);
      const prev = [...keyframes].reverse().find((k) => k.affine)?.affine || null;
      pushKeyframe({ t, affine: next ? blendAffine(prev, next, SMOOTH) : null });
    }
    lastFaceAt = t;
  }

  function detectNewest(now) {
    if (inflight || !detector || detector.busy || !queue.length) return;
    const newest = queue[queue.length - 1];
    smallCtx.drawImage(newest.canvas, 0, 0, small.width, small.height);
    inflight = true;
    const t0 = performance.now();
    if (lastDetectAt) detectIntervalMs += (now - lastDetectAt - detectIntervalMs) * 0.2;
    lastDetectAt = now;
    detector.detect(small, now).then((faces) => {
      if (!running) return;
      const took = performance.now() - t0;
      stats.detectMs += (took - stats.detectMs) * 0.2;
      delayMs = Math.min(DELAY_MAX_MS, Math.max(DELAY_MIN_MS, Math.max(detectIntervalMs, took) * DELAY_FACTOR));
      if (faces.length === 1) anchor(landmarkPixels(faces[0], newest.canvas.width, newest.canvas.height), newest.canvas, newest.t);
      else pushKeyframe({ t: newest.t, affine: null });
    }).catch((error) => {
      if (running) console.warn("plant detect", error);
    }).finally(() => { inflight = false; });
  }

  /** Per camera frame: crop into a pooled canvas and queue it; run landmarks when idle. */
  function onVideoFrameTick(now) {
    if (!running) return;
    rvfcHandle = video.requestVideoFrameCallback
      ? video.requestVideoFrameCallback(() => onVideoFrameTick(performance.now()))
      : requestAnimationFrame(onVideoFrameTick);
    if (!video.videoWidth) return;
    if (!crop) setupPicture();
    const c = takeCanvas();
    c.getContext("2d").drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    queue.push({ canvas: c, t: now });
    while (queue.length > QUEUE_LIMIT) giveCanvas(queue.shift().canvas);
    detectNewest(now);
  }

  function setupPicture() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw / vh > PICTURE_ASPECT) {
      const w = Math.round(vh * PICTURE_ASPECT);
      crop = { x: Math.round((vw - w) / 2), y: 0, w, h: vh };
    } else {
      crop = { x: 0, y: 0, w: vw, h: vh };
    }
    canvas.width = crop.w;
    canvas.height = crop.h;
    const k = Math.min(1, DETECT_MAX_SIDE / Math.max(crop.w, crop.h));
    small.width = Math.max(1, Math.round(crop.w * k));
    small.height = Math.max(1, Math.round(crop.h * k));
  }

  async function start() {
    if (running || starting || !isActive()) return;
    starting = true;
    updateHud();
    setHint("카메라를 켜는 중…", { sticky: true });
    try {
      stream = await openFrontCamera(CAMERA_MODEL, { portrait: true });
      const settings = videoTrackSettings(stream);
      mirror = settings.facingMode ? settings.facingMode !== "environment" : true;
      canvas.style.transform = mirror ? "scaleX(-1)" : "none";
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.setAttribute("aria-hidden", "true");
      video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:0";
      document.body.appendChild(video);
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      detector = await createFaceDetectorAsync();
      if (!isActive()) { stop(); return; }
      crop = null;
      ref = null;
      queue = [];
      keyframes = [];
      displayAffine = null;
      displayT = 0;
      lastDetectAt = 0;
      lastFaceAt = -Infinity;
      running = true;
      canvas.hidden = false;
      onVideoFrameTick(performance.now());
      rafHandle = requestAnimationFrame(renderLoop);
      setHint("머리에서 모발이 필요한 곳을 터치하세요");
    } catch (error) {
      onGlobalError(error?.message || "카메라를 열지 못했습니다.");
      stop();
    } finally {
      starting = false;
      updateHud();
    }
  }

  function stop() {
    running = false;
    inflight = false;
    cancelAnimationFrame(rafHandle);
    if (video?.cancelVideoFrameCallback && rvfcHandle) video.cancelVideoFrameCallback(rvfcHandle);
    else cancelAnimationFrame(rvfcHandle);
    rvfcHandle = 0;
    detector?.close?.();
    detector = null;
    stopMediaStream(stream);
    stream = null;
    if (video) {
      video.srcObject = null;
      video.remove();
      video = null;
    }
    for (const f of queue) giveCanvas(f.canvas);
    queue = [];
    keyframes = [];
    crop = null;
    ref = null;
    displayAffine = null;
    displayT = 0;
    planting.reset();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.hidden = true;
    setHint("");
    updateHud();
  }

  function plantAtPicture(pic, now) {
    const inv = invertAffine(displayAffine);
    if (!inv) return null;
    const center = applyAffine(inv, pic);
    return planting.plant({ center, frame: ref.frame, pxPerCm: ref.frame.pxPerCm, now });
  }

  function onTap(event) {
    if (!running) return;
    event.preventDefault();
    const now = performance.now();
    if (!tracking(now)) {
      setHint("얼굴이 보이게 정면을 봐주세요");
      return;
    }
    if (planting.done) {
      setHint(`${fmt(planting.goal)}모를 모두 심었어요. 목표를 올리거나 다시 심을 수 있어요`);
      return;
    }
    const pic = pictureFromPointer(event.clientX, event.clientY);
    if (!pic) return;
    const patch = plantAtPicture(pic, now);
    if (!patch) return;
    pop(event.clientX, event.clientY, `+${patch.count}`);
    if (planting.planted === patch.count) setHint("심은 모발이 자라납니다. 계속 터치해서 늘려보세요");
    updateHud(now);
  }

  function bind() {
    for (const goal of GOALS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.goal = String(goal);
      btn.textContent = `${fmt(goal)}모`;
      btn.setAttribute("aria-pressed", String(goal === planting.goal));
      btn.addEventListener("click", () => {
        planting.setGoal(goal);
        updateHud();
      });
      $("plant-goals").append(btn);
    }
    canvas.addEventListener("pointerdown", onTap);
    $("plant-start").addEventListener("click", () => { void start(); });
    $("plant-stop").addEventListener("click", stop);
    $("plant-reset").addEventListener("click", () => {
      planting.reset();
      setHint("처음부터 다시 심어보세요");
      updateHud();
    });
    $("plant-raise").addEventListener("click", () => {
      const next = GOALS.find((g) => g > planting.goal);
      if (next) planting.setGoal(next);
      updateHud();
    });
    const hold = $("plant-hold");
    const release = () => { showHair = true; hold.setAttribute("aria-pressed", "false"); };
    hold.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      showHair = false;
      hold.setAttribute("aria-pressed", "true");
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) hold.addEventListener(type, release);
    hold.addEventListener("keydown", (event) => { if (event.key === " " || event.key === "Enter") showHair = false; });
    hold.addEventListener("keyup", release);
  }

  function activate() {
    $("plant-layer").hidden = false;
    $("plant-bar").hidden = false;
    $("plant-disclaimer").hidden = false;
    document.documentElement.classList.add("tab-plant");
    updateHud();
  }

  function deactivate() {
    stop();
    $("plant-layer").hidden = true;
    $("plant-bar").hidden = true;
    $("plant-disclaimer").hidden = true;
    document.documentElement.classList.remove("tab-plant");
  }

  bind();
  updateHud();

  const api = {
    activate,
    deactivate,
    stop,
    start,
    get running() { return running; },
    get planting() { return planting; },
    get stats() {
      const now = performance.now();
      const head = ref && displayAffine
        ? { ...applyAffine(displayAffine, ref.frame.eyeMid), span: ref.frame.span * affineScale(displayAffine), up: ref.frame.up }
        : null;
      return {
        ...stats,
        planted: planting.planted,
        goal: planting.goal,
        tracking: tracking(now),
        mirror,
        picture: canvas.width ? `${canvas.width}×${canvas.height}` : "",
        head,
      };
    },
    /** Test hook: plant at picture coordinates without a pointer event. */
    plantAt(x, y) {
      if (!running || !tracking(performance.now())) return null;
      const now = performance.now();
      const patch = plantAtPicture({ x, y }, now);
      updateHud(now);
      return patch;
    },
  };
  globalThis.__graftPlay = api;
  return api;
}
