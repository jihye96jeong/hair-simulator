/**
 * Face-region compositing off the main thread for the Lucy live compositor.
 * The main thread sends Lucy's region pixels, the matched webcam face crop (cached here by
 * id so each crop crosses once) and the geometry; the worker returns the RGBA patch.
 *
 *   { type: "init" }                       → { type: "ready" }
 *   { type: "forget", ids }                → (drops cached face crops)
 *   { id, base, region, hair, faceId, face?, faceX, faceY, faceWidth, faceHeight, faceScale,
 *     transform, polygon, clipPolygon, clipGrow, featherRadius, blendRadius, blendStrength }
 *                                          → { id, rgba, region, toneSamples, painted }
 */
import { compositeSyncedFace } from "./hairFaceLock.js";

const faces = new Map();
const MAX_FACES = 160;

self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === "init") {
    self.postMessage({ type: "ready" });
    return;
  }
  if (data.type === "forget") {
    for (const id of data.ids || []) faces.delete(id);
    return;
  }
  const {
    id, base, region, hair, faceId, face, faceX, faceY, faceWidth, faceHeight, faceScale = 1, transform, polygon,
    clipPolygon, clipGrow, featherRadius, blendRadius = 0, blendStrength = 1,
  } = data;
  try {
    const t0 = performance.now();
    if (face) {
      faces.set(faceId, face);
      if (faces.size > MAX_FACES) faces.delete(faces.keys().next().value);
    }
    const pixels = faces.get(faceId);
    if (!pixels) throw new Error("face crop missing");
    const rendered = compositeSyncedFace({
      base, region, baseHair: hair, face: pixels, faceX, faceY, faceWidth, faceHeight, faceScale,
      transform, polygon, clipPolygon, clipGrow, featherRadius, blendRadius, blendStrength,
    });
    const timing = { composite: performance.now() - t0 };
    if (!rendered) {
      self.postMessage({ id, rgba: null, region, timing });
      return;
    }
    self.postMessage(
      { id, rgba: rendered.rgba, region, toneSamples: rendered.tone.samples, painted: rendered.painted, timing },
      [rendered.rgba.buffer],
    );
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error) });
  }
};
