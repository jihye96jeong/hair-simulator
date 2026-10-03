import { createVideoFaceDetector } from "./faceMask.js";
import { createVideoHairSegmenter } from "./faceGeometry.js";
import {
  buildIdentityPolygon,
  compositeSyncedFace,
  faceAlignPoints,
  faceAnchorPoints,
  maskScaleFor,
  polygonRegion,
  similarityFromCorrespondences,
  transformPolygon,
} from "./hairFaceLock.js";

/** Webcam frames kept for matching against Lucy's delayed output (Lucy lags ~0.5–1.5 s). */
const BUFFER_MS = 2500;
/** Keep the last composite on screen this long when Lucy's face cannot be found. */
const HOLD_MS = 400;
/** Face crop margin around the identity oval (fraction of the eye span). */
const CROP_MARGIN = 0.12;
/**
 * Webcam crops are stored at this scale. Resampling them back up when pasting softens the
 * webcam grain to Lucy's smoother render and halves the pixels crossing to the worker.
 */
const CROP_SCALE = 0.7;
/** Edge feather of the pasted face (fraction of the eye span). */
const FEATHER_RATIO = 0.08;
/** The paste may reach this far (fraction of the eye span) beyond Lucy's own face oval. */
const CLIP_GROW_RATIO = 0.05;
/**
 * Low-frequency transfer radius (fraction of the eye span): colour, lighting and shading
 * coarser than this come from Lucy's frame, finer detail (the identity) from the webcam.
 */
const BLEND_RATIO = 0.16;
const BLEND_STRENGTH = 1;
/** Lucy never returns a frame faster than this; closer candidates are look-alikes. */
const MIN_LUCY_LATENCY_MS = 250;
/** Weight of expression features (mouth/eyes) vs. head position when matching frames. */
const EXPRESSION_WEIGHT = 2.5;
/** When several buffered frames fit equally, prefer the one at the running latency estimate. */
const LATENCY_SMOOTHING = 0.15;
/** Landmarks and hair are detected on a downscaled copy (MediaPipe resizes to ≤256 px anyway). */
const DETECT_MAX_SIDE = 512;

/**
 * Mouth and eye openness relative to the inter-ocular distance: tells frames apart when the
 * head is still but the expression moves, so the pasted face carries the right expression.
 */
export function expressionFeatures(landmarks) {
  const d = (a, b) => Math.hypot(landmarks[a].x - landmarks[b].x, landmarks[a].y - landmarks[b].y);
  const eyeSpan = d(33, 263) || 1e-6;
  return [d(13, 14) / eyeSpan, d(159, 145) / eyeSpan, d(386, 374) / eyeSpan];
}

/** Squared distance between two anchor sets (pixels²) plus weighted expression distance. */
export function frameMatchScore(anchorsA, anchorsB, exprA, exprB, scalePx) {
  let position = 0;
  for (let i = 0; i < anchorsA.length; i++) {
    position += (anchorsA[i].x - anchorsB[i].x) ** 2 + (anchorsA[i].y - anchorsB[i].y) ** 2;
  }
  let expression = 0;
  for (let i = 0; i < exprA.length; i++) expression += (exprA[i] - exprB[i]) ** 2;
  // Expression deltas are relative to the eye span; scale them to the same pixel² units.
  return position + EXPRESSION_WEIGHT * expression * scalePx * scalePx;
}

/**
 * Pick the buffered webcam frame that shows the same moment as Lucy's frame.
 * Returns { entry, latencyMs, ambiguous }. `latencyEstimate` breaks ties when the head is still.
 */
export function pickSyncedFrame(entries, lucyAnchors, lucyExpr, lucyTime, latencyEstimate, minLatencyMs = 0) {
  if (!entries.length) return null;
  const eyeSpan = Math.hypot(lucyAnchors[1].x - lucyAnchors[0].x, lucyAnchors[1].y - lucyAnchors[0].y) || 1;
  let best = null;
  let bestScore = Infinity;
  let secondScore = Infinity;
  for (const entry of entries) {
    // Lucy cannot show a frame sooner than its real pipeline delay; such candidates are
    // look-alikes from a back-and-forth motion, not the same moment.
    if (lucyTime - entry.t < minLatencyMs) continue;
    const score = frameMatchScore(lucyAnchors, entry.anchors, lucyExpr, entry.expr, eyeSpan);
    if (score < bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = entry;
    } else if (score < secondScore) {
      secondScore = score;
    }
  }
  // "Clearly better" = the runner-up is worse by more than landmark jitter (~1.5% of the eye
  // span per anchor, i.e. ~4 px at a 250 px eye span).
  const margin = lucyAnchors.length * (0.015 * eyeSpan) ** 2;
  const ambiguous = secondScore - bestScore < margin;
  if (ambiguous && Number.isFinite(latencyEstimate)) {
    const target = lucyTime - latencyEstimate;
    let nearest = best;
    let nearestDt = Infinity;
    for (const entry of entries) {
      if (lucyTime - entry.t < minLatencyMs) continue;
      const score = frameMatchScore(lucyAnchors, entry.anchors, lucyExpr, entry.expr, eyeSpan);
      if (score - bestScore > margin) continue;
      const dt = Math.abs(entry.t - target);
      if (dt < nearestDt) {
        nearestDt = dt;
        nearest = entry;
      }
    }
    best = nearest;
  }
  if (!best) return null;
  return { entry: best, latencyMs: lucyTime - best.t, ambiguous };
}

/** A hair mask is reused this long (shifted with the head) before it counts as stale. */
const HAIR_MASK_MAX_AGE_MS = 1500;
/** Main-thread fallback segmentation cadence when the worker is unavailable. */
const HAIR_FALLBACK_INTERVAL_MS = 300;
const WORKER_INIT_TIMEOUT_MS = 20000;

/**
 * One job-at-a-time worker client. `ready` resolves true when the worker answered the init
 * message, false when it failed or timed out (the caller then falls back to the main thread).
 * `send` rejects when the worker fails; `post` is fire-and-forget.
 */
function createWorkerClient(url, { type, init }) {
  let worker = null;
  let pending = null;
  let nextId = 1;
  let closed = false;
  let failed = false;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const fail = () => {
    failed = true;
    resolveReady(false);
    if (pending) {
      pending.reject(new Error("worker failed"));
      pending = null;
    }
  };
  try {
    worker = new Worker(url, type ? { type } : undefined);
    worker.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === "ready") {
        resolveReady(true);
        return;
      }
      if (data.type === "init-error") {
        fail();
        return;
      }
      if (!pending || pending.id !== data.id) return;
      const current = pending;
      pending = null;
      if (data.error) current.reject(new Error(data.error));
      else current.resolve(data);
    };
    worker.onerror = () => fail();
    worker.postMessage(init);
    setTimeout(() => resolveReady(false), WORKER_INIT_TIMEOUT_MS);
  } catch {
    fail();
  }
  return {
    ready,
    get busy() { return Boolean(pending); },
    get failed() { return failed; },
    /** Sends one job (`transfer` lists transferable buffers); resolves with the reply. */
    send(message, transfer = []) {
      return new Promise((resolve, reject) => {
        if (closed || failed || !worker || pending) {
          for (const t of transfer) t?.close?.();
          reject(new Error("worker unavailable"));
          return;
        }
        const id = nextId++;
        pending = { id, resolve, reject };
        worker.postMessage({ ...message, id }, transfer);
      });
    },
    post(message) {
      if (!closed && !failed && worker) worker.postMessage(message);
    },
    close() {
      closed = true;
      try { worker?.terminate(); } catch { /* ignore */ }
      worker = null;
      if (pending) {
        pending.reject(new Error("closed"));
        pending = null;
      }
    },
  };
}

function createVisionWorkerClient(task) {
  return createWorkerClient(new URL("./visionWorker.js", import.meta.url), { init: { type: "init", task } });
}

function createCompositeWorkerClient() {
  return createWorkerClient(new URL("./compositeWorker.js", import.meta.url), { type: "module", init: { type: "init" } });
}

function unflattenLandmarks(flat) {
  const out = new Array(flat.length / 3);
  for (let i = 0; i < out.length; i++) out[i] = { x: flat[i * 3], y: flat[i * 3 + 1], z: flat[i * 3 + 2] };
  return out;
}

/**
 * Face landmarker for one video stream: in a worker when possible, else on the main thread.
 * `detect(small, ts)` resolves with the landmark lists (0 or 1 face). `busy` means a frame is
 * still being processed; callers drop frames instead of queueing them.
 */
async function createFaceDetectorAsync() {
  const client = createVisionWorkerClient("face");
  if (await client.ready) {
    return {
      mode: "worker",
      get busy() { return client.busy; },
      async detect(small, ts) {
        const bitmap = await createImageBitmap(small);
        const reply = await client.send({ bitmap, ts }, [bitmap]);
        return reply.landmarks ? [unflattenLandmarks(reply.landmarks)] : [];
      },
      close() { client.close(); },
    };
  }
  client.close();
  const local = await createVideoFaceDetector();
  return {
    mode: "main-thread",
    busy: false,
    async detect(small, ts) { return local.detect(small, ts); },
    close() {},
  };
}

/**
 * Hair mask of Lucy's frame (1 = hair), used so Lucy's bangs stay over the pasted face.
 * Segmentation is the slowest step (hundreds of ms on CPU), so it runs in a worker and the
 * compositor uses the latest mask, shifted by how far the head moved since it was taken.
 * Falls back to a main-thread segmenter at a low cadence when the worker cannot start.
 */
function createHairMaskProvider() {
  const client = createVisionWorkerClient("hair");
  let useWorker = null;
  let closed = false;
  let latest = null;
  let fallback = null;
  let fallbackPromise = null;
  let lastFallbackAt = -Infinity;
  void client.ready.then((ok) => { useWorker = ok; if (!ok) client.close(); });

  function runFallback(small, lw, lh, now, anchors) {
    if (now - lastFallbackAt < HAIR_FALLBACK_INTERVAL_MS) return;
    lastFallbackAt = now;
    if (!fallback) {
      fallbackPromise ||= createVideoHairSegmenter().then((s) => { fallback = s; }).catch(() => { fallback = null; });
      return;
    }
    try {
      const mask = fallback.segment(small, now, small.width, small.height);
      if (mask) latest = { mask, width: small.width, height: small.height, anchors, lucyWidth: lw, lucyHeight: lh, at: now };
    } catch { /* keep the previous mask */ }
  }

  return {
    /** Ask for a fresh mask of `small` (downscaled Lucy frame) when idle; never blocks. */
    request(small, lw, lh, now, anchors) {
      if (closed || useWorker === null) return;
      if (!useWorker) {
        runFallback(small, lw, lh, now, anchors);
        return;
      }
      if (client.busy) return;
      createImageBitmap(small).then((bitmap) => {
        if (closed) {
          bitmap.close?.();
          return;
        }
        return client.send({ bitmap, ts: now }, [bitmap]).then((reply) => {
          if (reply.mask) {
            latest = { mask: reply.mask, width: reply.width, height: reply.height, anchors, lucyWidth: lw, lucyHeight: lh, at: now };
          }
        });
      }).catch(() => { /* keep the previous mask */ });
    },
    /**
     * Latest mask resampled (bilinear, 0..1) for `region` of the Lucy frame, shifted by how far
     * the head moved since the mask was taken.
     */
    regionMask(region, anchors, now, scale = 1) {
      if (!latest || now - latest.at > HAIR_MASK_MAX_AGE_MS) return null;
      const { mask, width, height, lucyWidth, lucyHeight } = latest;
      const dx = anchors[2].x - latest.anchors[2].x;
      const dy = anchors[2].y - latest.anchors[2].y;
      const sx = width / lucyWidth;
      const sy = height / lucyHeight;
      const ow = Math.ceil(region.width / scale);
      const oh = Math.ceil(region.height / scale);
      const out = new Float32Array(ow * oh);
      for (let y = 0; y < oh; y++) {
        const fy = (region.y + (y + 0.5) * scale - dy) * sy - 0.5;
        const y0 = Math.floor(fy);
        const wy = fy - y0;
        const ya = Math.min(height - 1, Math.max(0, y0));
        const yb = Math.min(height - 1, Math.max(0, y0 + 1));
        for (let x = 0; x < ow; x++) {
          const fx = (region.x + (x + 0.5) * scale - dx) * sx - 0.5;
          const x0 = Math.floor(fx);
          const wx = fx - x0;
          const xa = Math.min(width - 1, Math.max(0, x0));
          const xb = Math.min(width - 1, Math.max(0, x0 + 1));
          const top = mask[ya * width + xa] * (1 - wx) + mask[ya * width + xb] * wx;
          const bottom = mask[yb * width + xa] * (1 - wx) + mask[yb * width + xb] * wx;
          out[y * ow + x] = top * (1 - wy) + bottom * wy;
        }
      }
      return out;
    },
    get mode() { return useWorker === null ? "starting" : useWorker ? "worker" : "main-thread"; },
    close() {
      closed = true;
      latest = null;
      client.close();
      try { fallback?.close?.(); } catch { /* ignore */ }
      fallback = null;
    },
  };
}

function onVideoFrame(video, callback) {
  let handle = 0;
  let stopped = false;
  const useRvfc = typeof video.requestVideoFrameCallback === "function";
  const tick = (now) => {
    if (stopped) return;
    callback(typeof now === "number" ? now : performance.now());
    handle = useRvfc ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  };
  handle = useRvfc ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  return () => {
    stopped = true;
    if (useRvfc) video.cancelVideoFrameCallback?.(handle);
    else cancelAnimationFrame(handle);
  };
}

/** Pool of same-size canvases (full frames and face crops) to avoid per-frame allocations. */
function createCanvasPool(limit, readFrequently) {
  const pool = [];
  return {
    take(width, height) {
      const c = pool.pop() || document.createElement("canvas");
      if (c.width !== width || c.height !== height) {
        c.width = width;
        c.height = height;
      }
      return c;
    },
    give(c) {
      if (c && pool.length < limit) pool.push(c);
    },
    context(c) {
      return c.getContext("2d", readFrequently ? { willReadFrequently: true } : undefined);
    },
  };
}

/**
 * Lucy live with the user's own face, in sync.
 *
 * Lucy's frame is the picture (new hair, body, background, lighting). Lucy lags the webcam by
 * ~1 s and redraws the face, so pasting the *current* webcam face onto it made the face and
 * the hair move at different times. Here every webcam frame is kept for a couple of seconds
 * with its landmarks; for each Lucy frame the buffered webcam frame showing the *same moment*
 * is found by matching head position and expression, and its face (brows → jaw) is pasted
 * into Lucy's frame. Hair and face then move together, and the face is the user's own pixels.
 *
 * Landmarks and hair segmentation run in workers (one each); the main thread only grabs
 * frames and composites the face region.
 *
 * `sourceStream`  the exact stream sent to Lucy (same frame size as Lucy's output)
 * `styledVideo`   <video> playing Lucy's remote stream (mirrored by the SDK when `mirror`)
 * `canvas`        on-screen canvas; drawn in webcam orientation, CSS-mirrored when `mirror`
 * `__testFaceRestore = "skip"` / `__testLiveFaceLock = "skip"` (browser tests) disables it.
 */
export function startLiveFaceLock({ sourceStream, styledVideo, canvas, mirror = false, onStats } = {}) {
  const noop = { stop() {}, active: () => false, stats: () => null };
  if (!sourceStream || !styledVideo || !canvas) return noop;
  if (globalThis.__testFaceRestore === "skip" || globalThis.__testLiveFaceLock === "skip") return noop;

  const webcamVideo = document.createElement("video");
  webcamVideo.muted = true;
  webcamVideo.playsInline = true;
  webcamVideo.autoplay = true;
  webcamVideo.setAttribute("aria-hidden", "true");
  webcamVideo.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:0";
  document.body.appendChild(webcamVideo);
  webcamVideo.srcObject = sourceStream;
  void webcamVideo.play().catch(() => undefined);

  const frames = createCanvasPool(8, true);
  const crops = createCanvasPool(96, true);
  const patches = createCanvasPool(4, false);
  const webcamSmall = document.createElement("canvas");
  const webcamSmallCtx = webcamSmall.getContext("2d");
  const lucySmall = document.createElement("canvas");
  const lucySmallCtx = lucySmall.getContext("2d");
  const ctx = canvas.getContext("2d");

  function fitSmall(small, width, height) {
    const k = Math.min(1, DETECT_MAX_SIDE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * k));
    const h = Math.max(1, Math.round(height * k));
    if (small.width !== w || small.height !== h) {
      small.width = w;
      small.height = h;
    }
  }
  const timing = { detect: 0, lucyDetect: 0, composite: 0 };
  const ema = (key, ms) => { timing[key] = timing[key] ? timing[key] + (ms - timing[key]) * 0.2 : ms; };

  const entries = [];
  let nextEntryId = 1;
  let stopped = false;
  let tools = null;
  let painted = false;
  let lastPaintAt = 0;
  let latencyEstimate = NaN;
  let stopWebcam = () => {};
  let stopLucy = () => {};
  const stats = { latencyMs: 0, lucyFps: 0, compositeFps: 0, webcamFps: 0, toneSamples: 0, misses: 0, dropped: 0, lastError: "", timing: {}, mode: "" };
  let lucyFrames = 0;
  let compositeFrames = 0;
  let webcamFrames = 0;
  const statsTimer = setInterval(() => {
    if (stopped) return;
    stats.lucyFps = lucyFrames;
    stats.compositeFps = compositeFrames;
    stats.webcamFps = webcamFrames;
    stats.timing = Object.fromEntries(Object.entries(timing).map(([k, v]) => [k, Math.round(v)]));
    stats.mode = tools ? `${tools.webcamFaces.mode}/${tools.lucyFaces.mode}/${tools.lucyHair.mode}/${tools.composite.mode}` : "";
    lucyFrames = 0;
    compositeFrames = 0;
    webcamFrames = 0;
    onStats?.({ ...stats });
  }, 1000);

  function pruneEntries(now) {
    const forget = [];
    while (entries.length && now - entries[0].t > BUFFER_MS) {
      const entry = entries.shift();
      crops.give(entry.crop);
      if (entry.sent) forget.push(entry.id);
    }
    if (forget.length) tools?.composite.forget(forget);
  }

  function hide() {
    painted = false;
    canvas.hidden = true;
  }

  function closeTools() {
    for (const tool of [tools?.webcamFaces, tools?.lucyFaces, tools?.lucyHair, tools?.composite]) {
      try { tool?.close(); } catch { /* ignore */ }
    }
    tools = null;
  }

  /** Composite in a module worker when possible; otherwise on the main thread. */
  async function createCompositor() {
    const client = createCompositeWorkerClient();
    if (await client.ready) {
      return {
        mode: "worker",
        get busy() { return client.busy; },
        async render(job, transfer) {
          const reply = await client.send(job, transfer);
          return reply.rgba ? { rgba: reply.rgba, toneSamples: reply.toneSamples, timing: reply.timing } : null;
        },
        forget(ids) { client.post({ type: "forget", ids }); },
        close() { client.close(); },
      };
    }
    client.close();
    return {
      mode: "main-thread",
      busy: false,
      async render(job) {
        const rendered = compositeSyncedFace({ ...job, baseHair: job.hair });
        return rendered ? { rgba: rendered.rgba, toneSamples: rendered.tone.samples } : null;
      },
      forget() {},
      close() {},
    };
  }

  async function ensureTools() {
    if (!tools) {
      const [webcamFaces, lucyFaces, composite] = await Promise.all([
        createFaceDetectorAsync(),
        createFaceDetectorAsync(),
        createCompositor(),
      ]);
      tools = { webcamFaces, lucyFaces, composite, lucyHair: createHairMaskProvider() };
    }
    return tools;
  }

  /** Every webcam frame (when the detector is free): landmarks + a face crop, kept for matching. */
  function captureWebcam(now) {
    if (stopped || !tools || tools.webcamFaces.busy) return;
    if (webcamVideo.readyState < 2 || !webcamVideo.videoWidth) return;
    const vw = webcamVideo.videoWidth;
    const vh = webcamVideo.videoHeight;
    // Keep the full frame until the landmarks are back, then crop the face out of it.
    const full = frames.take(vw, vh);
    frames.context(full).drawImage(webcamVideo, 0, 0, vw, vh);
    fitSmall(webcamSmall, vw, vh);
    webcamSmallCtx.drawImage(full, 0, 0, webcamSmall.width, webcamSmall.height);
    webcamFrames += 1;
    const t0 = performance.now();
    tools.webcamFaces.detect(webcamSmall, now).then((faces) => {
      ema("detect", performance.now() - t0);
      if (stopped) return;
      if (faces.length !== 1) return;
      const landmarks = faces[0];
      const anchors = faceAnchorPoints(landmarks, vw, vh);
      const polygon = buildIdentityPolygon(landmarks, vw, vh);
      if (!anchors || !polygon) return;
      const align = faceAlignPoints(landmarks, vw, vh) || anchors;
      const span = Math.hypot(anchors[1].x - anchors[0].x, anchors[1].y - anchors[0].y);
      const region = polygonRegion(polygon, vw, vh, Math.round(span * CROP_MARGIN) + 4);
      if (!region) return;
      const cropWidth = Math.max(2, Math.round(region.width * CROP_SCALE));
      const cropHeight = Math.max(2, Math.round(region.height * CROP_SCALE));
      const crop = crops.take(cropWidth, cropHeight);
      crops.context(crop).drawImage(full, region.x, region.y, region.width, region.height, 0, 0, cropWidth, cropHeight);
      entries.push({
        id: nextEntryId++, t: now, width: vw, height: vh, landmarks, anchors, align, polygon,
        expr: expressionFeatures(landmarks), crop, region, cropWidth, cropHeight,
        cropScale: cropWidth / region.width, pixels: null, sent: false,
      });
      pruneEntries(now);
    }).catch((error) => {
      stats.lastError = String(error?.message || error);
    }).finally(() => frames.give(full));
  }

  /**
   * Every Lucy frame (when the detector is free): grab it, find its face, then composite.
   * Detection and compositing run in different workers, so one frame can be detected while
   * the previous one is still being composited.
   */
  function onLucyFrame(now) {
    if (stopped || !tools || tools.lucyFaces.busy) return;
    if (styledVideo.readyState < 2 || !styledVideo.videoWidth) return;
    const lw = styledVideo.videoWidth;
    const lh = styledVideo.videoHeight;
    const frame = frames.take(lw, lh);
    const fctx = frames.context(frame);
    // Lucy's output is mirrored by the SDK; bring it back to webcam orientation.
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    if (mirror) {
      fctx.translate(lw, 0);
      fctx.scale(-1, 1);
    }
    fctx.drawImage(styledVideo, 0, 0, lw, lh);
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fitSmall(lucySmall, lw, lh);
    lucySmallCtx.drawImage(frame, 0, 0, lucySmall.width, lucySmall.height);
    lucyFrames += 1;
    const t0 = performance.now();
    tools.lucyFaces.detect(lucySmall, now).then(async (faces) => {
      ema("lucyDetect", performance.now() - t0);
      if (stopped) return;
      await paintLucy(frame, fctx, faces, now);
    }).catch((error) => {
      stats.lastError = String(error?.message || error);
    }).finally(() => frames.give(frame));
  }

  /** Paste the matching webcam face into Lucy's frame and show it. */
  async function paintLucy(frame, fctx, faces, now) {
    const lw = frame.width;
    const lh = frame.height;
    if (canvas.width !== lw || canvas.height !== lh) {
      canvas.width = lw;
      canvas.height = lh;
    }
    const lucyAnchors = faces.length === 1 ? faceAnchorPoints(faces[0], lw, lh) : null;
    pruneEntries(now);
    const match = lucyAnchors
      ? pickSyncedFrame(entries, lucyAnchors, expressionFeatures(faces[0]), now, latencyEstimate, MIN_LUCY_LATENCY_MS)
      : null;
    let transform = null;
    if (match) {
      // Least-squares over eyes/nose/mouth/chin/jaw so the paste is sized like Lucy's face;
      // fall back to the four anchors when the point sets differ.
      const lucyAlign = faceAlignPoints(faces[0], lw, lh) || lucyAnchors;
      transform = match.entry.align.length === lucyAlign.length
        ? similarityFromCorrespondences(match.entry.align, lucyAlign)
        : null;
      transform ||= similarityFromCorrespondences(match.entry.anchors, lucyAnchors);
    }
    if (!transform) {
      stats.misses += 1;
      // Hold the last good composite briefly; after that show Lucy as-is rather than freezing.
      if (!painted || now - lastPaintAt > HOLD_MS) {
        ctx.drawImage(frame, 0, 0);
        canvas.hidden = false;
        painted = true;
      }
      return;
    }
    if (!match.ambiguous) {
      latencyEstimate = Number.isFinite(latencyEstimate)
        ? latencyEstimate + (match.latencyMs - latencyEstimate) * LATENCY_SMOOTHING
        : match.latencyMs;
    }
    const t2 = performance.now();
    const entry = match.entry;
    const polygon = transformPolygon(entry.polygon, transform);
    const span = Math.hypot(lucyAnchors[1].x - lucyAnchors[0].x, lucyAnchors[1].y - lucyAnchors[0].y);
    const feather = Math.max(2, Math.round(span * FEATHER_RATIO));
    // The feathered edge fades inward from the oval, so a small margin covers the paste.
    const region = polygonRegion(polygon, lw, lh, (feather >> 1) + 4);
    if (!region) {
      ctx.drawImage(frame, 0, 0);
      canvas.hidden = false;
      return;
    }
    let hairRegion = null;
    try {
      // Non-blocking: queue a fresh mask when the worker is idle, use the latest one now.
      tools.lucyHair.request(lucySmall, lw, lh, now, lucyAnchors);
      hairRegion = tools.lucyHair.regionMask(region, lucyAnchors, now, maskScaleFor(region.width * region.height));
    } catch {
      hairRegion = null;
    }
    const compositor = tools.composite;
    if (compositor.busy) {
      // The previous frame is still being composited; this one is skipped (the last composite
      // stays on screen) rather than queued, which would add delay.
      stats.dropped += 1;
      return;
    }
    const base = fctx.getImageData(region.x, region.y, region.width, region.height);
    const job = {
      base: base.data,
      region,
      hair: hairRegion,
      faceId: entry.id,
      face: null,
      faceX: entry.region.x,
      faceY: entry.region.y,
      faceWidth: entry.cropWidth,
      faceHeight: entry.cropHeight,
      faceScale: entry.cropScale,
      transform,
      polygon,
      // Never paste beyond Lucy's own face outline (she often draws it slimmer).
      clipPolygon: buildIdentityPolygon(faces[0], lw, lh),
      clipGrow: Math.round(span * CLIP_GROW_RATIO),
      featherRadius: feather,
      blendRadius: Math.round(span * BLEND_RATIO),
      blendStrength: BLEND_STRENGTH,
    };
    const transfer = [base.data.buffer];
    if (hairRegion) transfer.push(hairRegion.buffer);
    if (compositor.mode === "worker") {
      // Each webcam crop crosses to the worker once; afterwards it is referenced by id.
      if (!entry.sent) {
        job.face = crops.context(entry.crop).getImageData(0, 0, entry.cropWidth, entry.cropHeight).data;
        transfer.push(job.face.buffer);
        entry.sent = true;
      }
    } else {
      entry.pixels ||= crops.context(entry.crop).getImageData(0, 0, entry.cropWidth, entry.cropHeight).data;
      job.face = entry.pixels;
    }
    let rendered = null;
    try {
      rendered = await compositor.render(job, transfer);
    } catch (error) {
      stats.lastError = String(error?.message || error);
      entry.sent = false;
    }
    if (stopped) return;
    ctx.drawImage(frame, 0, 0);
    if (rendered) {
      const patch = patches.take(region.width, region.height);
      patches.context(patch).putImageData(new ImageData(rendered.rgba, region.width, region.height), 0, 0);
      ctx.drawImage(patch, region.x, region.y);
      patches.give(patch);
      stats.toneSamples = rendered.toneSamples;
      if (rendered.timing) ema("worker", rendered.timing.composite);
    }
    ema("composite", performance.now() - t2);
    canvas.hidden = false;
    painted = true;
    lastPaintAt = now;
    compositeFrames += 1;
    stats.latencyMs = Math.round(latencyEstimate || match.latencyMs);
  }

  (async () => {
    try {
      await ensureTools();
      if (stopped) {
        closeTools();
        return;
      }
      stopWebcam = onVideoFrame(webcamVideo, captureWebcam);
      stopLucy = onVideoFrame(styledVideo, onLucyFrame);
    } catch (error) {
      stats.lastError = String(error?.message || error);
      console.warn("live-face-lock", stats.lastError);
      hide();
    }
  })();

  const handle = {
    active: () => painted && !canvas.hidden,
    stats: () => ({ ...stats }),
    /** Internal frames for diagnostics (lab harness). */
    debug: () => ({ webcamVideo, entries: entries.length, latencyEstimate, mode: stats.mode }),
    stop() {
      stopped = true;
      clearInterval(statsTimer);
      stopWebcam();
      stopLucy();
      hide();
      webcamVideo.pause();
      webcamVideo.srcObject = null;
      webcamVideo.remove();
      closeTools();
      entries.length = 0;
      if (globalThis.__liveFaceLock === handle) globalThis.__liveFaceLock = null;
    },
  };
  globalThis.__liveFaceLock = handle;
  return handle;
}
