/**
 * Delay a MediaStream by buffering frames on a canvas so original and Lucy
 * panes can be time-aligned. delayMs is measured/updated by the caller.
 */
export function createDelayedStream(sourceStream, { delayMs = 0, fps = 30 } = {}) {
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  video.srcObject = sourceStream;
  video.play?.().catch(() => undefined);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const frames = [];
  let timer = null;
  let currentDelay = Math.max(0, delayMs);
  let stopped = false;

  function sizeFromVideo() {
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function tick() {
    if (stopped) return;
    if (video.readyState >= 2) {
      sizeFromVideo();
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        frames.push({
          t: performance.now(),
          data: ctx.getImageData(0, 0, canvas.width, canvas.height),
        });
      } catch {
        /* tainted / not ready */
      }
      const cutoff = performance.now() - currentDelay;
      while (frames.length > 2 && frames[0].t < cutoff - 1000 / fps) frames.shift();
      const play = [...frames].reverse().find((f) => f.t <= cutoff) || frames[0];
      if (play) ctx.putImageData(play.data, 0, 0);
    }
  }

  timer = setInterval(tick, Math.max(16, Math.round(1000 / fps)));
  const out = canvas.captureStream(fps);

  return {
    stream: out,
    setDelay(ms) { currentDelay = Math.max(0, ms); },
    getDelay() { return currentDelay; },
    stop() {
      stopped = true;
      clearInterval(timer);
      stopTracks(out);
      video.srcObject = null;
    },
  };
}

function stopTracks(stream) {
  for (const t of stream?.getTracks?.() || []) t.stop();
}

/**
 * Measure approximate latency between local camera and remote Lucy stream
 * by sampling average brightness changes — coarse heuristic for /lab sync.
 */
export async function estimateStreamLagMs(localVideo, remoteVideo, { samples = 8, intervalMs = 80 } = {}) {
  if (!localVideo || !remoteVideo) return 0;
  const sample = (video) => {
    if (!video.videoWidth) return 0;
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 32;
    const g = c.getContext("2d");
    g.drawImage(video, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
    return s / (d.length * 0.75);
  };
  const localSeries = [];
  const remoteSeries = [];
  for (let i = 0; i < samples; i++) {
    localSeries.push(sample(localVideo));
    remoteSeries.push(sample(remoteVideo));
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  // Cross-correlation peak → lag in samples
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = 0; lag < samples; lag++) {
    let score = 0;
    let n = 0;
    for (let i = 0; i + lag < samples; i++) {
      score += localSeries[i] * remoteSeries[i + lag];
      n += 1;
    }
    score /= Math.max(1, n);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return bestLag * intervalMs;
}
